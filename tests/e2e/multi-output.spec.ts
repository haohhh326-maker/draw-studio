import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { openCanvasAddMenu } from "./helpers";

test("HD history preview and all saved outputs remain selectable after reopening the canvas", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("多输出回归");
  await page.getByRole("button", { name: "创建并打开" }).click();
  await openCanvasAddMenu(page, { x: 490, y: 234 });
  await page.getByRole("menuitem", { name: "视频" }).click();
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  const ordinary = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#334455" } }).png().toBuffer();
  const hd = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#bbdd33" } }).png().toBuffer();
  await page.evaluate(async ({ ordinary, hd }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const library: any = await new Promise((resolve, reject) => {
      const request = database.transaction("records").objectStore("records").get("project-library");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const project = library[sessionStorage.getItem("clearframe-open-project")!].project;
    const canvas = project.canvases[0], node = canvas.nodes[0], now = Date.now();
    const workflow = {
      id: "multi-output-ui", name: "多输出验证", family: "Tests", description: "", mode: "text-to-image",
      parameters: [], mapping: [], requiredInputs: [], optionalInputs: [],
      output: { nodeId: "normal", field: "images", kind: "image" },
      additionalOutputs: [{ nodeId: "hd", field: "images", kind: "image" }],
    };
    const assets = [
      { id: "normal-result", name: "normal.png", width: 64, height: 64, size: ordinary.length },
      { id: "hd-result", name: "hd.png", width: 256, height: 256, size: hd.length },
    ].map(asset => ({ ...asset, kind: "image", mime: "image/png", createdAt: now }));
    project.assets = Object.fromEntries(assets.map(asset => [asset.id, asset]));
    node.data = { title: "图像回归", kind: "image-generation", assetId: assets[0].id,
      generation: { workflowId: workflow.id, prompt: "测试", negativePrompt: "", params: {}, taskId: "multi-result-task" } };
    project.tasks = { "multi-result-task": {
      taskId: "multi-result-task", projectId: project.id, requestId: "request", clientId: "client", promptId: "accepted",
      executorType: "runninghub", canvasId: canvas.id, nodeId: node.id, nodeTitle: node.data.title, status: "completed",
      connection: { name: "Fixture", baseUrl: "https://www.runninghub.cn", token: "", authHeader: "", authPrefix: "", timeoutMinutes: 0 },
      workflow, input: { prompt: "测试", negativePrompt: "", params: {}, assets: [] }, outputs: assets.map(asset => asset.id), createdAt: now, updatedAt: now,
    } };
    project.history = [{ id: "multi-result-task", canvasId: canvas.id, nodeId: node.id, nodeTitle: node.data.title,
      workflowId: workflow.id, prompt: "测试", negativePrompt: "", params: {}, inputs: [], outputs: assets.map(asset => asset.id), promptId: "accepted", createdAt: now }];
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["records", "assets"], "readwrite");
      transaction.objectStore("records").put(library, "project-library");
      transaction.objectStore("assets").put(new Blob([Uint8Array.from(ordinary)], { type: "image/png" }), assets[0].id);
      transaction.objectStore("assets").put(new Blob([Uint8Array.from(hd)], { type: "image/png" }), assets[1].id);
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { ordinary: [...ordinary], hd: [...hd] });
  await page.reload();
  await page.getByRole("button", { name: "历史", exact: true }).click();
  const history = page.getByRole("dialog", { name: "生成历史" });
  const selector = history.getByRole("combobox", { name: "图像回归的生成结果" });
  await expect(selector).toHaveValue("hd-result");
  await expect(history.locator('img[alt="hd.png"]')).toBeVisible();
  await expect(selector.locator("option")).toHaveCount(2);
  await selector.selectOption("normal-result");
  await expect(history.locator('img[alt="normal.png"]')).toBeVisible();
  await selector.selectOption("hd-result");
  await history.getByRole("button", { name: "恢复版本", exact: true }).click();
  await expect(page.locator('.react-flow__node img[alt="hd.png"]')).toBeVisible();
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  await page.reload();
  await expect(page.locator('.react-flow__node img[alt="hd.png"]')).toBeVisible();
  expect(failures).toEqual([]);
});
