import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { expect } from "@playwright/test";
import sharp from "sharp";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceExecutable = path.resolve(process.argv[2] ?? path.join(process.env.DRAW_STUDIO_SMOKE_REUSE_PACKAGE ?? path.join(projectRoot, "release", "win-unpacked"), "Draw studio.exe"));
const temporaryParent = await realpath(os.tmpdir());
const temporary = await mkdtemp(path.join(temporaryParent, "draw-packaged-smoke-"));
const isolatedPackage = process.env.DRAW_STUDIO_SMOKE_REUSE_PACKAGE
  ? path.resolve(process.env.DRAW_STUDIO_SMOKE_REUSE_PACKAGE) : path.join(temporary, "application");
if (process.env.DRAW_STUDIO_SMOKE_USER_DATA) assert(path.isAbsolute(process.env.DRAW_STUDIO_SMOKE_USER_DATA), "The verification profile must use an absolute path");
const userData = process.env.DRAW_STUDIO_SMOKE_USER_DATA ?? path.join(temporary, "user-data");
const artifactDirectory = path.resolve(projectRoot, "..", "packaged-desktop-verification");
const reportPath = process.env.DRAW_STUDIO_SMOKE_REPORT ?? path.join(artifactDirectory, "packaged-desktop-verification.json");
const report = { sourceExecutable, isolatedPackage, temporary, userData, launches: [], failures: [], finished: false };
let application;

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function localGet(page, pathname) { return page.request.get(new URL(pathname, page.url()).href); }

async function availablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function openReference(page, location, file) {
  await page.locator(".react-flow__pane").click({ button: "right", position: location });
  await page.getByRole("menuitem", { name: "参考" }).click();
  await page.locator(".react-flow__node").last().getByLabel("上传素材").setInputFiles(file);
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const library = await new Promise((resolve, reject) => {
        const request = database.transaction("records").objectStore("records").get("project-library");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const project = library[sessionStorage.getItem("clearframe-open-project")].project;
      const assets = [];
      for (const asset of Object.values(project.assets)) {
        const blob = await new Promise((resolve, reject) => {
          const request = database.transaction("assets").objectStore("assets").get(asset.id);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
        assets.push({ id: asset.id, name: asset.name, kind: asset.kind, mime: asset.mime,
          inLibrary: asset.inLibrary, size: blob.size,
          sha256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("") });
      }
      return { id: project.id, name: project.name, nodeIds: project.canvases.flatMap(canvas => canvas.nodes.map(node => node.id)), assets };
    } finally { database.close(); }
  });
}

async function checkVideo(page) {
  await page.bringToFront();
  await page.mouse.move(1200, 800);
  const video = page.locator(".react-flow__node video[data-asset-id]");
  await expect(video).toHaveCount(1);
  await expect(video).toHaveAttribute("poster", /^blob:/, { timeout: 30000 });
  const posterPixels = await video.evaluate(async element => {
    const bitmap = await createImageBitmap(await (await fetch(element.poster)).blob());
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext("2d"); context.drawImage(bitmap, 0, 0, 32, 32); bitmap.close();
    const pixels = context.getImageData(0, 0, 32, 32).data;
    let opaque = 0, blue = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3]) opaque++;
      if (pixels[index + 2] > pixels[index] + 25 && pixels[index + 2] > pixels[index + 1] + 5) blue++;
    }
    return { opaque, blue };
  });
  assert(posterPixels.opaque > 0, "The packaged video poster must contain opaque pixels");
  assert(posterPixels.blue > 10, "The stored poster must contain the blue reference cube");
  await expect.poll(async () => {
    const screenshot = await video.screenshot({ timeout: 8000 });
    await writeFile(path.join(artifactDirectory, "packaged-video-poster.png"), screenshot);
    const { data, info } = await sharp(screenshot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let blue = 0;
    for (let index = 0; index < data.length; index += 4) {
      const pixel = index / 4, x = pixel % info.width, y = Math.floor(pixel / info.width);
      // Exclude the central playback button from the rendered frame check.
      const playbackButton = x > info.width * .35 && x < info.width * .65 && y > info.height * .35 && y < info.height * .65;
      if (!playbackButton && data[index + 2] > data[index] + 25 && data[index + 2] > data[index + 1] + 5) blue++;
    }
    return blue;
  }, { timeout: 30000, message: "The packaged video poster must show the blue reference frame" }).toBeGreaterThan(100);
  await video.hover();
  let metadata;
  await expect.poll(async () => {
    metadata = await video.evaluate(element => ({ width: element.videoWidth, height: element.videoHeight, duration: element.duration }));
    return metadata.width > 0 && metadata.height > 0 && Number.isFinite(metadata.duration) && metadata.duration > 0;
  }, { timeout: 30000, message: "The packaged video must load dimensions and duration" }).toBe(true);
  await page.mouse.move(1200, 800);
  return metadata;
}

async function launch(port) {
  const executablePath = path.join(isolatedPackage, path.basename(sourceExecutable));
  const env = { ...process.env, DRAW_STUDIO_USER_DATA: userData, DRAW_STUDIO_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath, env, timeout: 120000 });
  application = app;
  // These partitions belong to this fresh temporary profile. Cancel external
  // navigation before creating either native service view.
  await app.evaluate(async ({ app, session }) => {
    await app.whenReady();
    for (const partition of [undefined, "persist:draw-studio-muse", "persist:draw-studio-deepseek"]) {
      const target = partition ? session.fromPartition(partition) : session.defaultSession;
      target.webRequest.onBeforeRequest((details, callback) => {
        const address = new URL(details.url);
        const external = ["http:", "https:", "ws:", "wss:"].includes(address.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname);
        callback({ cancel: external });
      });
    }
  });
  const page = await app.firstWindow({ timeout: 120000 });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.waitForURL(`http://127.0.0.1:${port}/`, { timeout: 120000 });
  const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, userData: app.getPath("userData"), version: app.getVersion() }));
  runtime.entryBundle = await page.locator('script[type="module"][src]').getAttribute("src");
  assert.match(runtime.entryBundle, /^\/assets\/index-[^/]+\.js$/);
  assert.equal(runtime.packaged, true);
  assert.equal(path.resolve(runtime.userData).toLowerCase(), path.resolve(userData).toLowerCase());
  await page.route("**/api/muse/session", route => route.fulfill({ json: { status: "disconnected" } }));
  await page.route("**/__canvas/deepseek/session", route => route.fulfill({ json: { status: "disconnected" } }));
  return { app, page, runtime, pageErrors, env, executablePath };
}

async function closeNormally(app, port) {
  const closed = app.waitForEvent("close", { timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  application = undefined;
  await expect.poll(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/__canvas/desktop-health`)).ok; }
    catch { return false; }
  }, { timeout: 30000 }).toBe(false);
}

async function checkNativeView(app, page, service) {
  await page.getByRole("button", { name: "网页服务", exact: true }).click();
  await page.getByRole("menuitem", { name: service, exact: true }).click();
  const panel = page.getByRole("dialog", { name: service + " 原聊天窗口", exact: true });
  await expect(panel.getByLabel("网页视图已打开", { exact: true })).toBeVisible();
  const view = await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    const attached = main.contentView.children.filter(child => child.webContents && child.webContents.id !== main.webContents.id);
    return attached.map(child => ({ id: child.webContents.id, bounds: child.getBounds(),
      sandbox: child.webContents.getLastWebPreferences().sandbox,
      contextIsolation: child.webContents.getLastWebPreferences().contextIsolation,
      nodeIntegration: child.webContents.getLastWebPreferences().nodeIntegration,
      storagePath: child.webContents.session.getStoragePath() }));
  });
  assert.equal(view.length, 1);
  assert(view[0].bounds.width > 0 && view[0].bounds.height > 0);
  assert.equal(view[0].sandbox, true);
  assert.equal(view[0].contextIsolation, true);
  assert.equal(view[0].nodeIntegration, false);
  assert(path.resolve(view[0].storagePath).toLowerCase().startsWith(path.resolve(userData).toLowerCase() + path.sep));
  await panel.getByRole("button", { name: "关闭聊天窗口", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    return main.contentView.children.filter(child => child.webContents && child.webContents.id !== main.webContents.id).length;
  })).toBe(0);
  return view[0];
}

try {
  assert.equal(process.platform, "win32", "This smoke test targets the Windows packaged executable");
  await stat(sourceExecutable);
  assert(!path.resolve(temporary).toLowerCase().startsWith(projectRoot.toLowerCase() + path.sep));
  if (process.env.DRAW_STUDIO_SMOKE_REUSE_PACKAGE) {
    const prepared = await realpath(isolatedPackage);
    assert(prepared.toLowerCase() !== projectRoot.toLowerCase() && !prepared.toLowerCase().startsWith(projectRoot.toLowerCase() + path.sep), "A standalone verification package must be outside the repository");
    assert((await stat(path.join(prepared, "resources", "draw-studio", "node_modules", "playwright", "package.json"))).isFile());
    console.log("Reusing an isolated application copy", prepared);
  } else {
    console.log("Copying the Windows application to an isolated directory", temporary);
    await cp(path.dirname(sourceExecutable), isolatedPackage, { recursive: true });
  }
  report.bundleSha256 = digest(await readFile(path.join(isolatedPackage, "resources", "app.asar")));
  report.serverSha256 = digest(await readFile(path.join(isolatedPackage, "resources", "draw-studio", "desktop-server.cjs")));
  await mkdir(artifactDirectory, { recursive: true });
  const previous = process.env.DRAW_STUDIO_SMOKE_PREVIOUS_REPORT
    ? JSON.parse(await readFile(process.env.DRAW_STUDIO_SMOKE_PREVIOUS_REPORT, "utf8")) : undefined;
  if (previous) assert(previous.finished && previous.projectSnapshot, "The prior installation verification must contain a completed project snapshot");
  const port = previous?.port ?? await availablePort(); report.port = port;
  const image = await sharp({ create: { width: 128, height: 96, channels: 3, background: "#3366cc" } }).png().toBuffer();
  const mp4 = await readFile(path.join(projectRoot, "tests", "live", "reference.mp4"));
  const expectedHashes = { "packaged-reference.png": digest(image), "packaged-reference.mp4": digest(mp4) };
  let expectedProject = previous?.projectSnapshot;
  let projectName = expectedProject?.name ?? "Packaged runtime references";
  const localMarker = path.join(userData, "workspace", "workflows", "cloud_upload", "smoke-local-content.txt");
  const home = await launch(port);
  await expect(home.page.getByRole("heading", { name: "最近项目", exact: true })).toBeVisible();
  await expect(home.page.locator(".project-card")).toHaveCount(previous ? 1 : 0);
  await home.page.screenshot({ path: path.join(artifactDirectory, "packaged-home.png") });
  assert.deepEqual(home.pageErrors, []);
  await closeNormally(home.app, port);
  for (let cycle = 0; cycle <= 3; cycle++) {
    console.log("Launching isolated packaged application", cycle + 1);
    const { app, page, runtime, pageErrors, env, executablePath } = await launch(port);
    const health = await (await localGet(page, "/__canvas/desktop-health")).json();
    assert.equal(health.service, "draw-studio-desktop");
    const workflowResponse = await localGet(page, "/__canvas/workflow-library");
    assert.equal(workflowResponse.status(), 200);
    const library = await workflowResponse.json();
    assert(library.workflows.length > 0 && library.scanned > 0);
    const encryptedReady = library.workflows.filter(workflow => workflow.original?.executionStatus === "encrypted" && workflow.template && !workflow.library?.executionIssue).length;
    report.lastLibrary = { count: library.workflows.length, scanned: library.scanned, issues: library.issues.length, encryptedReady,
      encrypted: library.workflows.filter(workflow => workflow.original?.executionStatus === "encrypted").length,
      templates: library.workflows.filter(workflow => workflow.template).length,
      issueMessages: library.issues.slice(0, 8).map(issue => issue.message) };
    if (encryptedReady !== 69) console.error("Packaged library did not match the original execution baseline", report.lastLibrary);
    const libraryMatchesSource = encryptedReady === 69 && library.workflows.length === 79 && library.scanned === 79 && library.issues.length === 7;
    if (!libraryMatchesSource && cycle === 0) report.failures.push("The packaged workflow library did not match the original 79 entries, 79 scanned, 7 issues and 69 executable encrypted workflows.");
    assert.equal(path.resolve(library.sourcePath).toLowerCase(), path.join(userData, "workspace", "workflows", "library").toLowerCase());
    if (cycle === 0 && !previous) {
      await expect(page.getByRole("heading", { name: "最近项目", exact: true })).toBeVisible();
      await expect(page.locator(".project-card")).toHaveCount(0);
      report.emptyHomeExitPreserved = true;
      await page.getByRole("button", { name: "新建项目", exact: true }).click();
      await page.getByLabel("项目名称", { exact: true }).fill(projectName);
      await page.getByRole("button", { name: "创建并打开", exact: true }).click();
      await openReference(page, { x: 300, y: 170 }, { name: "packaged-reference.png", mimeType: "image/png", buffer: image });
      await expect(page.getByRole("img", { name: "packaged-reference.png", exact: true })).toBeVisible();
      await openReference(page, { x: 800, y: 340 }, { name: "packaged-reference.mp4", mimeType: "video/mp4", buffer: mp4 });
    } else {
      await expect(page.getByRole("button", { name: "打开项目：" + projectName, exact: true })).toBeVisible();
      await expect(page.locator(".project-card")).toHaveCount(1);
      if (cycle === 3) report.existingHomeExitPreserved = true;
      await page.getByRole("button", { name: "打开项目：" + projectName, exact: true }).click();
      assert.equal(await readFile(localMarker, "utf8"), "Keep this local content across application launches.\n");
    }
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    const videoMetadata = await checkVideo(page);
    await page.getByRole("button", { name: "保存项目", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
    const saved = await snapshot(page);
    assert.equal(saved.name, projectName);
    assert.equal(saved.assets.length, 2);
    for (const asset of saved.assets) {
      assert.equal(asset.sha256, expectedHashes[asset.name]);
      assert.equal(asset.inLibrary, false);
    }
    if (expectedProject) {
      assert.equal(saved.id, expectedProject.id);
      assert.deepEqual(saved.nodeIds, expectedProject.nodeIds);
      assert.deepEqual(saved.assets, expectedProject.assets);
    }
    expectedProject = saved;
    await page.getByRole("button", { name: "软件更新", exact: true }).click();
    const update = page.getByRole("dialog", { name: "软件更新", exact: true });
    await expect(update.getByText(runtime.version, { exact: true })).toBeVisible();
    await expect(update.getByRole("button", { name: /选择.*安装包/ })).toHaveCount(0);
    await expect(update.getByRole("button", { name: "检查更新", exact: true })).toBeVisible();
    await expect.poll(async () => page.evaluate(async () => {
      const status = await window.drawStudioHost.invoke("get_software_update_status", {});
      return status.configured;
    })).toBe(true);
    if (cycle === 0) await page.screenshot({ path: path.join(artifactDirectory, "packaged-software-update.png") });
    await update.getByRole("button", { name: "关闭", exact: true }).click();
    const entry = { cycle, runtime, origin: new URL(page.url()).origin, health,
      workflowCount: library.workflows.length, scanned: library.scanned, workflowIssueCount: library.issues.length, encryptedReady,
      projectId: saved.id, projectName: saved.name, nodeIds: saved.nodeIds, assets: saved.assets, videoMetadata };
    if (cycle === 0) {
      entry.menu = await app.evaluate(({ Menu, BrowserWindow }) => ({ applicationMenuNull: Menu.getApplicationMenu() === null,
        menuBarVisible: BrowserWindow.getAllWindows()[0].isMenuBarVisible() }));
      await page.keyboard.press("Alt");
      entry.menu.visibleAfterAlt = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible());
      if (!entry.menu.applicationMenuNull || entry.menu.menuBarVisible || entry.menu.visibleAfterAlt) report.failures.push("The default application menu remains available.");
      await page.keyboard.press("Escape");
      const folders = await readdir(path.join(userData, "workspace", "workflows"), { withFileTypes: true });
      entry.seedDirectories = folders.filter(item => item.isDirectory()).map(item => item.name).sort();
      for (const name of ["cloud_upload", "comfyui_nodes", "input", "library", "loras", "mac", "mcp", "prompt", "skills", "stage-production", "text-node-presets"]) assert(entry.seedDirectories.includes(name), "Missing seeded directory " + name);
      await writeFile(localMarker, "Keep this local content across application launches.\n");
      const transferResponse = await localGet(page, "/__canvas/cloud-files/status");
      const transfer = await transferResponse.json();
      entry.cloudTransfer = { httpStatus: transferResponse.status(), available: transfer.available, engine: transfer.engine,
        version: transfer.version, transport: transfer.transport, buckets: transfer.buckets?.map(bucket => bucket.id) };
      if (!transfer.available) console.error("The packaged cloud transfer engine is unavailable", entry.cloudTransfer);
      entry.nativeViews = { muse: await checkNativeView(app, page, "Muse"), deepseek: await checkNativeView(app, page, "DeepSeek") };
      const museAgain = await checkNativeView(app, page, "Muse");
      assert.equal(museAgain.id, entry.nativeViews.muse.id);
      const duplicate = spawn(executablePath, [], { env, windowsHide: true, stdio: "ignore" });
      const exit = await new Promise((resolve, reject) => { duplicate.once("exit", (code, signal) => resolve({ code, signal })); duplicate.once("error", reject); });
      assert.equal(exit.code, 0);
      const sameHealth = await (await localGet(page, "/__canvas/desktop-health")).json();
      assert.equal(sameHealth.instanceId, health.instanceId);
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
      entry.duplicateInstance = exit;
    }
    await page.screenshot({ path: path.join(artifactDirectory, `packaged-canvas-launch-${cycle + 1}.png`) });
    assert.deepEqual(pageErrors, []);
    report.launches.push(entry);
    if (cycle < 3) {
      projectName = "Packaged close checkpoint " + (cycle + 1);
      await page.getByLabel("项目名称", { exact: true }).fill(projectName);
      if (cycle === 2) {
        await page.getByRole("button", { name: "返回项目列表", exact: true }).click();
        await expect(page.getByRole("heading", { name: "最近项目", exact: true })).toBeVisible();
      }
    }
    await closeNormally(app, port);
    console.log("Verified packaged launch and full exit", cycle + 1);
  }
  report.finished = report.failures.length === 0;
  report.projectSnapshot = expectedProject;
  report.restartCount = 3;
  if (!report.finished) process.exitCode = 1;
  console.log("Verified the empty-home exit and reference persistence across three restarts, native views and software updates");
} catch (error) {
  report.failures.push(error instanceof Error ? error.stack : String(error));
  console.error(error);
  try { report.serverLog = await readFile(path.join(userData, "logs", "server.log"), "utf8"); } catch {}
  process.exitCode = 1;
} finally {
  if (application) await application.close().catch(() => {});
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log("Verification report", reportPath);
  console.log("Isolated application and profile retained", temporary);
}
