import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { expect } from "@playwright/test";
import sharp from "sharp";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.resolve(projectRoot, "..", "packaged-desktop-verification");
const baseline = JSON.parse(await readFile(process.env.DRAW_STUDIO_SMOKE_PREVIOUS_REPORT ?? path.join(artifacts, "packaged-desktop-verification.json"), "utf8"));
assert.equal(baseline.finished, true);
const executable = path.join(baseline.isolatedPackage, "Draw studio.exe");
const ffmpeg = path.join(baseline.isolatedPackage, "resources", "draw-studio", "tools", "ffmpeg.exe");
const framesDirectory = path.join(artifacts, "flicker-frames");
await mkdir(framesDirectory, { recursive: true });
const report = { profile: baseline.userData, executable, port: baseline.port, staticFrames: [], operations: [], pageErrors: [], finished: false };
let application;

function bluePixels(data) {
  let blue = 0;
  for (let index = 0; index < data.length; index += 3) {
    if (data[index + 2] > data[index] + 25 && data[index + 2] > data[index + 1] + 5) blue++;
  }
  return blue;
}

async function regionPixels(screenshot, bounds) {
  const { data } = await sharp(screenshot).extract({ left: Math.round(bounds.x), top: Math.round(bounds.y),
    width: Math.floor(bounds.width), height: Math.floor(bounds.height) }).resize(64, 64).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let white = 0, black = 0;
  for (let index = 0; index < data.length; index += 3) {
    if (data[index] > 245 && data[index + 1] > 245 && data[index + 2] > 245) white++;
    if (data[index] < 10 && data[index + 1] < 10 && data[index + 2] < 10) black++;
  }
  return { blue: bluePixels(data), white, black };
}

function recordWindow(handle, output) {
  const process = spawn(ffmpeg, ["-hide_banner", "-y", "-f", "gdigrab", "-framerate", "30", "-draw_mouse", "0", "-i", "hwnd=0x" + handle,
    "-vf", "scale=1280:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", output],
  { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let log = "";
  process.stderr.on("data", bytes => { log = (log + bytes.toString()).slice(-6000); });
  const done = new Promise(resolve => {
    process.once("error", error => resolve({ error: String(error), log }));
    process.once("exit", (code, signal) => resolve({ code, signal, log }));
  });
  return { process, done };
}

async function analyzeRecording(file) {
  const process = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "scale=160:90", "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = []; let errors = "";
  process.stdout.on("data", bytes => chunks.push(bytes)); process.stderr.on("data", bytes => { errors += bytes; });
  const code = await new Promise((resolve, reject) => { process.once("error", reject); process.once("exit", resolve); });
  assert.equal(code, 0, errors);
  const bytes = Buffer.concat(chunks), stride = 160 * 90 * 3, frames = [];
  for (let offset = 0; offset + stride <= bytes.length; offset += stride) {
    const frame = bytes.subarray(offset, offset + stride);
    let white = 0, black = 0;
    for (let index = 0; index < frame.length; index += 3) {
      if (frame[index] > 245 && frame[index + 1] > 245 && frame[index + 2] > 245) white++;
      if (frame[index] < 10 && frame[index + 1] < 10 && frame[index + 2] < 10) black++;
    }
    frames.push({ index: frames.length, blue: bluePixels(frame), white, black });
  }
  const medianBlue = frames.map(frame => frame.blue).sort((a, b) => a - b)[Math.floor(frames.length / 2)];
  const flashCandidates = frames.filter(frame => medianBlue > 20 && frame.blue < medianBlue * .08 && (frame.white > 14400 * .9 || frame.black > 14400 * .9));
  return { frameCount: frames.length, medianBlue, flashCandidates };
}

try {
  const env = { ...process.env, DRAW_STUDIO_USER_DATA: baseline.userData, DRAW_STUDIO_PORT: String(baseline.port) };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: executable, env, timeout: 120000 });
  await application.evaluate(async ({ app, session }) => {
    await app.whenReady();
    for (const partition of [undefined, "persist:draw-studio-muse", "persist:draw-studio-deepseek"]) {
      const target = partition ? session.fromPartition(partition) : session.defaultSession;
      target.webRequest.onBeforeRequest((details, callback) => {
        const address = new URL(details.url);
        callback({ cancel: ["http:", "https:", "ws:", "wss:"].includes(address.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname) });
      });
    }
  });
  const page = await application.firstWindow({ timeout: 120000 });
  page.on("pageerror", error => report.pageErrors.push(error.message));
  await page.waitForURL(`http://127.0.0.1:${baseline.port}/`);
  await page.route("**/api/muse/session", route => route.fulfill({ json: { status: "disconnected" } }));
  await page.route("**/__canvas/deepseek/session", route => route.fulfill({ json: { status: "disconnected" } }));
  await page.locator(".project-card").click();
  await expect(page.locator(".canvas-shell")).toBeVisible();
  const video = page.locator(".react-flow__node video[data-asset-id]");
  const image = page.getByRole("img", { name: "packaged-reference.png", exact: true });
  await expect(video).toHaveAttribute("poster", /^blob:/);
  await page.mouse.move(20, 150);
  const videoBounds = await video.boundingBox(), imageBounds = await image.boundingBox();
  assert(videoBounds && imageBounds);
  report.initial = await application.evaluate(({ app, BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    main.show(); main.focus();
    const counters = { mainWindowId: main.id, browserWindowCreated: 0, didStartLoading: 0, didFinishLoad: 0,
      renderProcessGone: [], gpuProcessCrashed: [], gpuChildProcessGone: [], resize: 0, maximize: 0, unmaximize: 0, minimize: 0, restore: 0 };
    globalThis.drawFlickerCounters = counters;
    app.on("browser-window-created", () => counters.browserWindowCreated++);
    main.webContents.on("did-start-loading", () => counters.didStartLoading++);
    main.webContents.on("did-finish-load", () => counters.didFinishLoad++);
    main.webContents.on("render-process-gone", (_event, details) => counters.renderProcessGone.push(details));
    app.on("gpu-process-crashed", (_event, killed) => counters.gpuProcessCrashed.push({ killed }));
    app.on("child-process-gone", (_event, details) => { if (details.type === "GPU") counters.gpuChildProcessGone.push(details); });
    for (const event of ["resize", "maximize", "unmaximize", "minimize", "restore"]) main.on(event, () => counters[event]++);
    const handle = main.getNativeWindowHandle();
    return { mainWindowId: main.id, bounds: main.getBounds(), title: main.getTitle(), version: app.getVersion(), pid: process.pid,
      handle: handle.length === 8 ? handle.readBigUInt64LE().toString(16) : handle.readUInt32LE().toString(16) };
  });
  assert.equal(report.initial.title, "Draw studio");
  const recordingPath = path.join(artifacts, "packaged-flicker-window.mp4");
  const recording = recordWindow(report.initial.handle, recordingPath);
  const started = Date.now();
  console.log("Capturing the stable packaged canvas for twenty seconds");
  while (Date.now() - started < 20000) {
    const screenshot = await page.screenshot({ scale: "css" });
    const index = report.staticFrames.length;
    await writeFile(path.join(framesDirectory, `static-${String(index).padStart(3, "0")}.png`), screenshot);
    report.staticFrames.push({ index, elapsedMs: Date.now() - started,
      video: await regionPixels(screenshot, videoBounds), image: await regionPixels(screenshot, imageBounds) });
  }
  recording.process.stdin?.write("q");
  report.recording = { path: recordingPath, ...await recording.done };
  if (report.recording.code === 0) report.recording.analysis = await analyzeRecording(recordingPath);
  report.staticFlashCandidates = report.staticFrames.filter(frame => frame.video.blue < 10 && frame.image.blue < 10);

  async function captureOperation(name, operation) {
    await operation();
    await page.screenshot({ path: path.join(framesDirectory, name + ".png"), scale: "css" });
    report.operations.push({ name, counters: await application.evaluate(() => globalThis.drawFlickerCounters) });
  }
  await captureOperation("canvas-pan", async () => {
    const pane = await page.locator(".react-flow__pane").boundingBox();
    await page.mouse.move(pane.x + pane.width - 100, pane.y + pane.height - 160);
    await page.mouse.down(); await page.mouse.move(pane.x + pane.width - 170, pane.y + pane.height - 210, { steps: 20 }); await page.mouse.up();
  });
  await captureOperation("canvas-zoom", async () => {
    await page.locator(".react-flow__controls-zoomin").click();
    await page.locator(".react-flow__controls-zoomout").click();
    await page.locator(".react-flow__controls-fitview").click();
  });
  for (let cycle = 0; cycle < 3; cycle++) {
    await captureOperation("update-panel-" + cycle, async () => {
      await page.getByRole("button", { name: "软件更新", exact: true }).click();
      await page.getByRole("dialog", { name: "软件更新", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
    });
    await captureOperation("asset-panel-" + cycle, async () => {
      await page.getByRole("button", { name: "资产库", exact: true }).click();
      await page.getByRole("dialog", { name: "资产库", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
    });
  }
  for (const service of ["Muse", "DeepSeek", "Muse"]) {
    await captureOperation("native-panel-" + service.toLowerCase() + "-" + report.operations.length, async () => {
      await page.getByRole("button", { name: "网页服务", exact: true }).click();
      await page.getByRole("menuitem", { name: service, exact: true }).click();
      const panel = page.getByRole("dialog", { name: service + " 原聊天窗口", exact: true });
      await expect(panel.getByLabel("网页视图已打开", { exact: true })).toBeVisible();
      await panel.getByRole("button", { name: "关闭聊天窗口", exact: true }).click();
    });
  }
  await captureOperation("video-playing", async () => {
    await video.hover();
    await expect.poll(() => video.evaluate(element => !element.paused && element.currentTime > 0), { timeout: 30000 }).toBe(true);
    report.videoPlayback = await video.evaluate(element => ({ width: element.videoWidth, height: element.videoHeight, currentTime: element.currentTime, duration: element.duration, paused: element.paused }));
  });
  await page.mouse.move(20, 150);
  await captureOperation("window-resized", () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 740 })));
  await captureOperation("window-maximized", async () => {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
  });
  await captureOperation("window-restored", async () => {
    await application.evaluate(({ BrowserWindow }, bounds) => { const main = BrowserWindow.getAllWindows()[0]; main.unmaximize(); main.setBounds(bounds); }, report.initial.bounds);
  });
  await captureOperation("window-minimized-and-restored", async () => {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
    await application.evaluate(({ BrowserWindow }) => { const main = BrowserWindow.getAllWindows()[0]; main.restore(); main.focus(); });
  });
  report.events = await application.evaluate(({ BrowserWindow }) => ({ ...globalThis.drawFlickerCounters,
    finalWindowIds: BrowserWindow.getAllWindows().map(window => window.id) }));
  assert.equal(report.events.didStartLoading, 0);
  assert.equal(report.events.browserWindowCreated, 0);
  assert.deepEqual(report.events.renderProcessGone, []);
  assert.deepEqual(report.events.gpuProcessCrashed, []);
  assert.deepEqual(report.events.gpuChildProcessGone, []);
  assert.deepEqual(report.events.finalWindowIds, [report.initial.mainWindowId]);
  assert.deepEqual(report.staticFlashCandidates, []);
  if (report.recording.analysis) assert.deepEqual(report.recording.analysis.flashCandidates, []);
  assert.deepEqual(report.pageErrors, []);
  report.finished = true;
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error);
  console.error(error); process.exitCode = 1;
} finally {
  if (application) await application.close().catch(() => {});
  await writeFile(path.join(artifacts, "packaged-flicker-verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("Flicker verification report", path.join(artifacts, "packaged-flicker-verification.json"));
}
