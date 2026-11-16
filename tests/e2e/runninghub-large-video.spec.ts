import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import type { Project } from "../../src/types";

const projectId = "isolated-runninghub-large-video";
const taskId = "accepted-large-video-task";
const nodeId = "large-video-target";
const MiB = 1024 * 1024;

async function videoServer(bytes: Buffer, interrupt: boolean) {
  const requests: { range?: string; ifRange?: string }[] = [];
  let releaseCheckpoint!: () => void;
  const checkpoint = new Promise<void>(resolve => { releaseCheckpoint = resolve; });
  let checkpointReached = false;
  let disconnected = false;
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Range, If-Range");
    response.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    const range = request.headers.range;
    requests.push({ range, ifRange: request.headers["if-range"] as string | undefined });
    const offset = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1]) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) {
      response.writeHead(416); response.end(); return;
    }
    response.writeHead(offset ? 206 : 200, {
      "Content-Type": "video/mp4", "Content-Length": bytes.length - offset,
      "Accept-Ranges": "bytes", ETag: '"isolated-large-video-v1"',
      ...(offset ? { "Content-Range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}),
    });
    void send(response, offset).catch(() => response.destroy());
  });
  async function send(response: ServerResponse, offset: number) {
    for (let cursor = offset; cursor < bytes.length; cursor += 256 * 1024) {
      if (response.destroyed) return;
      if (cursor === 8 * MiB && offset === 0 && !checkpointReached) {
        checkpointReached = true;
        await checkpoint;
        if (interrupt && !disconnected) { disconnected = true; response.destroy(); return; }
      }
      if (!response.write(bytes.subarray(cursor, Math.min(bytes.length, cursor + 256 * 1024))))
        await once(response, "drain");
      await new Promise(resolve => setTimeout(resolve, cursor < 8 * MiB ? 10 : 2));
    }
    response.end();
  }
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock media server did not start");
  return {
    url: `http://127.0.0.1:${address.port}/large.mp4`, requests,
    reachedCheckpoint: () => checkpointReached,
    releaseCheckpoint,
    async close() {
      releaseCheckpoint();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function seedAcceptedResult(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
  await page.evaluate(async ({ projectId, taskId, nodeId }) => {
    const now = Date.now();
    const workflow = {
      id: "large-video-workflow", name: "隔离大视频工作流", family: "视频工具", description: "",
      mode: "text-to-video", parameters: [], mapping: [], requiredInputs: [], optionalInputs: [], promptRequired: false,
      output: { nodeId: "2", field: "videos", kind: "video" },
      template: { "2": { class_type: "SaveVideo", inputs: {} } },
      runninghub: { workflowId: "2115115422654746625", baseUrl: "https://www.runninghub.cn", kind: "workflow" },
    };
    const connection = { name: "Isolated fixture", baseUrl: "https://www.runninghub.cn", token: "isolated-test-key",
      authHeader: "Authorization", authPrefix: "Bearer", timeoutMinutes: 1 };
    const project = {
      version: 2, id: projectId, name: "隔离大视频保存测试", activeCanvasId: "canvas", updatedAt: now,
      scenes: [{ id: "scene", name: "场景 01" }], assets: {}, history: [],
      canvases: [{ id: "canvas", name: "画布 1", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 }, edges: [],
        nodes: [{ id: nodeId, type: "media", position: { x: 570, y: 160 }, data: { kind: "video", title: "视频 1",
          generation: { computeProvider: "runninghub-workflow", workflowId: workflow.id, prompt: "原任务", negativePrompt: "", params: {}, taskId },
        } }],
      }],
      tasks: { [taskId]: {
        taskId, projectId, nodeId, nodeTitle: "视频 1", canvasId: "canvas", clientId: "isolated-client", requestId: "isolated-request",
        promptId: "already-accepted-remote-task", executorType: "runninghub", status: "interrupted", connection: { ...connection, token: "" },
        workflow, input: { prompt: "原任务", negativePrompt: "", params: {}, assets: [] }, outputs: [], createdAt: now, updatedAt: now,
        remoteOutputs: [{ filename: "large.mp4", subfolder: "", type: "output", url: "https://fixture.runninghub.cn/large.mp4" }],
        runningHubTiming: { remoteFinishedAt: now - 1000 },
      } },
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite"), records = tx.objectStore("records");
      records.put({ [projectId]: { project, workflows: [] } }, "project-library");
      records.put([workflow], "runninghub-workflows");
      records.put({ provider: "runninghub-workflow", runningHubConnection: connection }, "compute-preferences");
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
    sessionStorage.setItem("clearframe-open-project", projectId);
  }, { projectId, taskId, nodeId });
  // Startup recovery must resume the accepted task without submitting a new generation.
  await page.reload();
}

async function savedProject(page: Page) {
  return page.evaluate(async projectId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const library = await new Promise<Record<string, { project: Project }>>((resolve, reject) => {
        const request = db.transaction("records").objectStore("records").get("project-library");
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      return library[projectId].project;
    } finally { db.close(); }
  }, projectId);
}

async function storedVideo(page: Page, assetId: string) {
  return page.evaluate(async assetId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const blob = await new Promise<Blob>((resolve, reject) => {
      const request = db.transaction("assets").objectStore("assets").get(assetId);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close();
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    return { size: blob.size, type: blob.type, hash, storage: await navigator.storage.estimate() };
  }, assetId);
}

for (const scenario of [{ mib: 64, interrupt: false }, { mib: 128, interrupt: true }]) {
  test(`RunningHub ${scenario.mib} MiB video ${scenario.interrupt ? "resumes an interrupted download" : "saves beyond the upload size limit"} and survives reopening`, async ({ page }, testInfo) => {
    test.setTimeout(90000);
    const source = await readFile(new URL("../live/reference.mp4", import.meta.url));
    // An ISO BMFF free box keeps the sample playable while exercising actual large-file storage.
    const bytes = Buffer.alloc(scenario.mib * MiB, 0x5a);
    source.copy(bytes);
    bytes.writeUInt32BE(bytes.length - source.length, source.length);
    bytes.write("free", source.length + 4, "ascii");
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    const media = await videoServer(bytes, scenario.interrupt);
    const failures: string[] = [], unexpected: string[] = [];
    page.on("pageerror", error => failures.push(error.message));
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === "/api/runninghub-result") {
        await route.continue({ url: media.url });
        return;
      }
      if (/\/task\/openapi\/(?:create|ai-app\/run|cancel)|\/openapi\/v2\/run\//.test(path)) unexpected.push(request.method() + " " + path);
      await route.fulfill({ status: 503, json: { code: 503, msg: "isolated fixture" } });
    });
    await page.route(/https:\/\/(?:[^/]+\.)?runninghub\.(?:cn|ai)\/.*/, async route => {
      unexpected.push(route.request().url());
      await route.abort();
    });
    try {
      await seedAcceptedResult(page);
      const target = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
      const execution = target.getByRole("status", { name: "生成执行状态", exact: true });
      await expect.poll(media.reachedCheckpoint).toBe(true);
      await expect(execution).toContainText("保存结果");
      await expect(execution.locator(".node-execution-meta")).toContainText(new RegExp(`正在下载结果 [1-9]\\d*(?:\\.\\d+)? / ${scenario.mib}\\.0 MB`));
      expect((await savedProject(page)).tasks[taskId].status).toBe("saving");
      await expect(target.locator("video[data-asset-id]")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("large-video-downloading.png") });
      media.releaseCheckpoint();
      await expect.poll(async () => (await savedProject(page)).tasks[taskId].status, { timeout: 45000 }).toBe("completed");
      const project = await savedProject(page), task = project.tasks[taskId], assetId = task.outputs[0];
      expect(task.outputs).toHaveLength(1);
      expect(task.promptId).toBe("already-accepted-remote-task");
      expect(task.downloadedOutputs).toHaveLength(1);
      expect(project.history.find(item => item.id === taskId)?.outputs).toEqual([assetId]);
      expect(project.canvases[0].nodes.find(node => node.id === nodeId)?.data.assetId).toBe(assetId);
      expect(project.assets[assetId]).toMatchObject({ kind: "video", mime: "video/mp4", size: bytes.length, inLibrary: false });
      const stored = await storedVideo(page, assetId);
      expect(stored).toMatchObject({ size: bytes.length, type: "video/mp4", hash: expectedHash });
      expect(stored.storage.quota).toBeGreaterThan(bytes.length);
      const video = target.locator(`video[data-asset-id="${assetId}"]`);
      await expect(video).toBeVisible();
      await target.hover();
      await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
      await expect(execution).toHaveCount(0);
      await page.reload();
      const reopened = page.locator(`.react-flow__node[data-id="${nodeId}"] video[data-asset-id="${assetId}"]`);
      await expect(reopened).toBeVisible();
      await reopened.hover();
      await expect.poll(() => reopened.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
      expect((await savedProject(page)).tasks[taskId].status).toBe("completed");
      expect(await storedVideo(page, assetId)).toMatchObject({ size: bytes.length, type: "video/mp4", hash: expectedHash });
      expect(media.requests).toHaveLength(scenario.interrupt ? 2 : 1);
      if (scenario.interrupt) {
        expect(media.requests[1].ifRange).toBe('"isolated-large-video-v1"');
        const resumedAt = Number(/^bytes=(\d+)-$/.exec(media.requests[1].range ?? "")?.[1]);
        expect(resumedAt).toBeGreaterThan(0);
        expect(resumedAt).toBeLessThanOrEqual(8 * MiB);
      }
      expect(unexpected).toEqual([]);
      expect(failures).toEqual([]);
      const report = testInfo.outputPath("large-video-verification.json");
      await writeFile(report, JSON.stringify({ mib: scenario.mib, taskStatus: task.status, stored, requests: media.requests }, null, 2));
      await testInfo.attach("large-video-verification.json", { path: report, contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath("large-video-reopened.png") });
    } finally { await media.close(); }
  });
}
