import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { Project } from "../../src/types";
import { openCanvasAddMenu } from "./helpers";

async function savedResult(page: Page, taskId: string, nodeId: string) {
  return page.evaluate(async ({ taskId, nodeId }) => {
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
    const project = library[sessionStorage.getItem("clearframe-open-project")!].project;
    const task = project.tasks[taskId];
    const node = project.canvases.flatMap(canvas => canvas.nodes).find(node => node.id === nodeId)!;
    const asset = project.assets[node.data.assetId!];
    const blob = await new Promise<Blob>((resolve, reject) => {
      const request = db.transaction("assets").objectStore("assets").get(asset.id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return {
      taskId: task.taskId, status: task.status, executorType: task.executorType, taskNodeId: task.nodeId,
      nodeId: node.id, assetId: asset.id, nodeTaskId: node.data.generation?.taskId,
      outputs: task.outputs, historyOutputs: project.history.find(entry => entry.id === taskId)?.outputs,
      kind: asset.kind, mime: asset.mime, size: asset.size, inLibrary: asset.inLibrary,
      blobSize: blob.size, blobType: blob.type,
      hash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
    };
  }, { taskId, nodeId });
}

test("Muse video progresses through the bridge and writes a persistent MP4 to its original node", async ({ page }, testInfo) => {
  const mp4 = await readFile(new URL("../live/reference.mp4", import.meta.url));
  const failures: string[] = [];
  const unexpectedCalls: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  let taskId = "";
  let phase = "submitting";
  let creates = 0;
  let polls = 0;
  let mediaRequests = 0;
  let releaseMedia!: () => void;
  const mediaReady = new Promise<void>(resolve => { releaseMedia = resolve; });
  const output = () => ({ id: "mock-video-output", name: "mock-muse-result.mp4", mime: "video/mp4", url: `/api/muse/jobs/${taskId}/media/mock-video-output` });
  await page.route("**/api/muse/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/muse/session" && request.method() === "GET") {
      await route.fulfill({ json: { status: "connected", message: "Isolated Muse fixture" } });
      return;
    }
    if (path === "/api/muse/jobs" && request.method() === "POST") {
      const input = request.postDataJSON();
      expect(input).toMatchObject({ kind: "video", prompt: "A quiet sea at sunrise", references: [] });
      taskId = input.id;
      creates++;
      await route.fulfill({ json: { id: taskId, status: phase, message: "Confirming the fixture job" } });
      return;
    }
    if (path === `/api/muse/jobs/${taskId}` && request.method() === "GET") {
      polls++;
      await route.fulfill({ json: { id: taskId, status: phase, conversationUrl: "https://muse.ai/thread/isolated-writeback",
        message: "Isolated fixture job", ...(phase === "completed" ? { outputs: [output()] } : {}) } });
      return;
    }
    if (path === output().url && request.method() === "GET") {
      mediaRequests++;
      await mediaReady;
      await route.fulfill({ status: 200, contentType: "video/mp4", body: mp4 });
      return;
    }
    unexpectedCalls.push(request.method() + " " + path);
    await route.abort();
  });
  await page.route(/https:\/\/(?:[^/]+\.)?muse\.ai\/.*/, route => {
    unexpectedCalls.push(route.request().url());
    return route.abort();
  });
  await page.route("**/api/runninghub/**", route => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("Isolated Muse result writeback");
  await page.getByRole("button", { name: "创建并打开" }).click();
  await openCanvasAddMenu(page, { x: 490, y: 234 });
  await page.getByRole("menuitem", { name: "视频" }).click();
  const target = page.locator(".react-flow__node").filter({ hasText: "视频 1" });
  const nodeId = (await target.getAttribute("data-id"))!;
  await target.click();
  await page.getByRole("button", { name: "选择当前节点算力", exact: true }).click();
  await page.getByRole("dialog", { name: "选择算力", exact: true }).getByRole("radio", { name: /Muse/ }).click();
  const panel = page.getByRole("region", { name: "视频 1生成面板", exact: true });
  await expect(panel.locator(".workflow-button")).toContainText("Muse 视频");
  await panel.getByRole("textbox", { name: "提示词", exact: true }).fill("A quiet sea at sunrise");
  await panel.getByRole("button", { name: "生成", exact: true }).click();
  const execution = target.getByRole("status", { name: "生成执行状态", exact: true });
  await expect(execution).toContainText("提交任务");
  await expect.poll(() => creates).toBe(1);
  phase = "generating";
  await expect(execution).toContainText("执行中");
  await expect(execution).not.toContainText("提交任务");
  phase = "completed";
  await expect(execution).toContainText("保存结果");
  await expect.poll(() => mediaRequests).toBe(1);
  await expect(target.locator("video")).toHaveCount(0);
  releaseMedia();
  await expect(page.getByRole("status").filter({ hasText: "Muse 生成完成，结果已保存到原节点。" })).toHaveCount(1);
  await expect(execution).toHaveCount(0);
  const video = target.locator("video[data-asset-id]");
  await expect(video).toBeVisible();
  const assetId = (await video.getAttribute("data-asset-id"))!;
  await target.hover();
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
  const persisted = await savedResult(page, taskId, nodeId);
  expect(persisted).toMatchObject({ taskId, status: "completed", executorType: "muse", taskNodeId: nodeId,
    nodeId, assetId, nodeTaskId: taskId, outputs: [assetId], historyOutputs: [assetId], kind: "video", mime: "video/mp4",
    size: mp4.length, blobSize: mp4.length, blobType: "video/mp4", inLibrary: false, hash: createHash("sha256").update(mp4).digest("hex") });
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  await page.reload();
  const reopened = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  const reopenedVideo = reopened.locator(`video[data-asset-id="${assetId}"]`);
  await expect(reopenedVideo).toBeVisible();
  await reopenedVideo.hover();
  await expect.poll(() => reopenedVideo.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => reopenedVideo.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
  expect(await savedResult(page, taskId, nodeId)).toEqual(persisted);
  expect(creates).toBe(1);
  expect(polls).toBeGreaterThanOrEqual(2);
  expect(mediaRequests).toBe(1);
  expect(unexpectedCalls).toEqual([]);
  expect(failures).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("muse-result-writeback.png") });
});
