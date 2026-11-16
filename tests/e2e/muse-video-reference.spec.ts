import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { expect, test, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import type { Project } from "../../src/types";
import { sniffMuseMedia } from "../../scripts/muse-browser-service";
import { MuseReferenceStore, type MuseReferenceUpload } from "../../scripts/muse-reference-store";
import { uploadMuseReferences } from "../../scripts/muse-upload";
import { openCanvasAddMenu } from "./helpers";

async function savedProject(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const library = await new Promise<Record<string, { project: Project }>>((resolve, reject) => {
      const request = db.transaction("records").objectStore("records").get("project-library");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return library[sessionStorage.getItem("clearframe-open-project")!].project;
  });
}

async function connect(page: Page, source: Locator, target: Locator) {
  const from = (await source.locator(".react-flow__handle-right").boundingBox())!;
  const to = (await target.locator(".react-flow__handle-left").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
}

async function expectVideoPoster(video: Locator) {
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate(async element => {
    const poster = (element as HTMLVideoElement).poster;
    if (!poster) return 0;
    const image = new Image(); image.src = poster; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    return [...pixels].filter((value, index) => index % 4 === 3 && value > 0).length;
  })).toBeGreaterThan(0);
  await expect.poll(async () => {
    const { data } = await sharp(await video.screenshot()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let bluePixels = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 2] > data[index] + 25 && data[index + 2] > data[index + 1] + 5) bluePixels++;
    }
    return bluePixels;
  }).toBeGreaterThan(2);
}

test("Muse uploads connected image and video references in order with a visible video poster and writes the result back", async ({ page, browser }, testInfo) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "draw-muse-video-reference-e2e-"));
  const store = new MuseReferenceStore(temporary, sniffMuseMedia);
  const pickerContext = await browser.newContext();
  const failures: string[] = [], unexpectedCalls: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#3366cc" } }).png().toBuffer();
  const mp4 = await readFile(new URL("../live/reference.mp4", import.meta.url));
  const originals = [
    { name: "context-image.png", mime: "image/png", bytes: image },
    { name: "motion-reference.mp4", mime: "video/mp4", bytes: mp4 },
  ];
  const uploads: MuseReferenceUpload[] = [];
  let taskId = "", creates = 0, phase = "generating", mediaRequests = 0;
  try {
    await pickerContext.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><form><textarea></textarea><input id="picker" type="file" accept="image/*,video/*" multiple><div id="attachments"></div></form>' }));
    const picker = await pickerContext.newPage();
    await picker.goto("https://muse-picker-fixture.test/");
    await picker.evaluate(() => {
      document.querySelector<HTMLInputElement>("#picker")!.addEventListener("change", event => {
        for (const file of [...(event.target as HTMLInputElement).files!]) {
          const button = document.createElement("button"); button.type = "button";
          button.setAttribute("aria-label", "Remove attachment"); button.textContent = file.name;
          document.querySelector("#attachments")!.append(button);
        }
      });
    });
    await page.route("**/api/muse/**", async route => {
      const request = route.request(), address = new URL(request.url()).pathname;
      if (address === "/api/muse/session" && request.method() === "GET") {
        await route.fulfill({ json: { status: "connected" } }); return;
      }
      const reference = /^\/api\/muse\/jobs\/([^/]+)\/references$/.exec(address);
      if (reference && request.method() === "POST") {
        taskId = reference[1];
        const original = originals[uploads.length], bytes = request.postDataBuffer()!;
        expect(request.headers()["content-type"]).toBe(original.mime);
        expect(decodeURIComponent(request.headers()["x-muse-name"])).toBe(original.name);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(createHash("sha256").update(original.bytes).digest("hex"));
        const uploaded = await store.save(taskId, Readable.from([bytes]) as unknown as IncomingMessage, original.name, original.mime);
        uploads.push(uploaded);
        await route.fulfill({ json: uploaded }); return;
      }
      if (address === "/api/muse/jobs" && request.method() === "POST") {
        const input = request.postDataJSON();
        expect(input).toMatchObject({ id: taskId, kind: "video", prompt: "Continue the motion from these references", references: uploads });
        expect(uploads.map(upload => upload.mime)).toEqual(["image/png", "video/mp4"]);
        const files = await Promise.all(input.references.map((reference: MuseReferenceUpload) => store.resolve(taskId, reference.uploadId)));
        await uploadMuseReferences(picker, files, () => false);
        creates++;
        await route.fulfill({ json: { id: taskId, status: phase } }); return;
      }
      if (address === `/api/muse/jobs/${taskId}` && request.method() === "GET") {
        await route.fulfill({ json: { id: taskId, status: phase, ...(phase === "completed" ? { outputs: [{ id: "video-output", name: "muse-reference-result.mp4", mime: "video/mp4", url: `/api/muse/jobs/${taskId}/media/video-output` }] } : {}) } }); return;
      }
      if (address === `/api/muse/jobs/${taskId}/media/video-output`) {
        mediaRequests++;
        await route.fulfill({ contentType: "video/mp4", body: mp4 }); return;
      }
      unexpectedCalls.push(request.method() + " " + address); await route.abort();
    });
    await page.route(/https:\/\/(?:[^/]+\.)?muse\.ai\/.*/, route => { unexpectedCalls.push(route.request().url()); return route.abort(); });
    await page.route("**/api/runninghub/**", route => route.abort());
    await page.goto("/");
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    await page.getByLabel("项目名称").fill("Isolated Muse video references");
    await page.getByRole("button", { name: "创建并打开" }).click();
    await page.getByRole("button", { name: "远程连接", exact: true }).click();
    await page.getByRole("dialog", { name: "选择算力", exact: true }).getByRole("radio", { name: /Muse/ }).click();
    for (const [index, original] of originals.entries()) {
      await openCanvasAddMenu(page, { x: 200, y: index ? 570 : 150 });
      await page.getByRole("menuitem", { name: "参考" }).click();
      await page.locator(".react-flow__node").filter({ hasText: "参考 " + (index + 1) }).getByLabel("上传素材").setInputFiles({ name: original.name, mimeType: index ? "application/octet-stream" : original.mime, buffer: original.bytes });
    }
    await openCanvasAddMenu(page, { x: 850, y: 300 });
    await page.getByRole("menuitem", { name: "视频" }).click();
    const target = page.locator(".react-flow__node").filter({ hasText: "视频 1" });
    const targetId = (await target.getAttribute("data-id"))!;
    await connect(page, page.locator(".react-flow__node").filter({ hasText: "参考 1" }), target);
    await connect(page, page.locator(".react-flow__node").filter({ hasText: "参考 2" }), target);
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await target.click();
    const panel = page.getByRole("region", { name: "视频 1生成面板", exact: true });
    const thumbnail = panel.locator(".media-input-icon video[data-asset-id]");
    await expect(panel.locator(".media-input-icon img")).toHaveAttribute("alt", originals[0].name);
    await expectVideoPoster(thumbnail);
    const videoAssetId = (await thumbnail.getAttribute("data-asset-id"))!;
    await page.getByRole("button", { name: "保存项目", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
    expect((await savedProject(page)).assets[videoAssetId]).toMatchObject({ kind: "video", mime: "video/mp4", name: originals[1].name, inLibrary: false });
    const transparent = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer();
    await page.evaluate(async ({ assetId, bytes }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("clearframe-canvas", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("assets", "readwrite");
        transaction.objectStore("assets").put(new Blob([Uint8Array.from(bytes)], { type: "image/webp" }), "thumb-" + assetId);
        transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
      }); db.close();
    }, { assetId: videoAssetId, bytes: [...transparent] });
    await page.reload();
    await page.locator(`.react-flow__node[data-id="${targetId}"]`).click();
    await expectVideoPoster(thumbnail);
    await panel.getByRole("textbox", { name: "提示词", exact: true }).fill("Continue the motion from these references");
    await panel.getByRole("button", { name: "生成", exact: true }).click();
    await expect.poll(() => creates).toBe(1);
    await expect(page.locator(`.react-flow__node[data-id="${targetId}"] .node-execution`)).toContainText("执行中");
    const received = await picker.evaluate(async () => Promise.all([...(document.querySelector<HTMLInputElement>("#picker")!.files ?? [])].map(async file => ({
      name: file.name, mime: file.type, size: file.size,
      hash: [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, "0")).join(""),
    }))));
    expect(received).toEqual(uploads.map((upload, index) => ({ name: upload.name, mime: originals[index].mime, size: originals[index].bytes.length, hash: createHash("sha256").update(originals[index].bytes).digest("hex") })));
    phase = "completed";
    await expect(page.getByRole("status").filter({ hasText: "Muse 生成完成，结果已保存到原节点。" })).toHaveCount(1);
    const project = await savedProject(page), task = project.tasks[taskId];
    expect(task.status).toBe("completed");
    expect(task.input.assets.map(input => ({ semantic: input.semantic, kind: input.asset.kind, name: input.asset.name }))).toEqual([
      { semantic: "referenceImages", kind: "image", name: originals[0].name },
      { semantic: "referenceVideos", kind: "video", name: originals[1].name },
    ]);
    expect(project.assets[videoAssetId].inLibrary).toBe(false);
    expect(project.canvases.flatMap(canvas => canvas.nodes).find(node => node.id === targetId)?.data.assetId).toBe(task.outputs[0]);
    expect(project.assets[task.outputs[0]]).toMatchObject({ kind: "video", mime: "video/mp4", size: mp4.length, inLibrary: false });
    expect(creates).toBe(1); expect(mediaRequests).toBe(1);
    expect(unexpectedCalls).toEqual([]); expect(failures).toEqual([]);
    const screenshot = testInfo.outputPath("muse-video-reference.png");
    await page.screenshot({ path: screenshot });
    if (testInfo.repeatEachIndex === 0) await copyFile(screenshot, path.resolve(process.cwd(), "..", "muse-video-reference-verified.png"));
  } finally {
    await pickerContext.close();
    if (taskId) await store.cleanup(taskId);
    const resolved = await realpath(temporary);
    if (path.dirname(resolved).toLowerCase() === (await realpath(os.tmpdir())).toLowerCase() && path.basename(resolved).startsWith("draw-muse-video-reference-e2e-")) await rm(resolved, { recursive: true, force: true });
  }
});
