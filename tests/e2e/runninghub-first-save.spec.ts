import { expect, test, type Page } from "@playwright/test";
import { readAIFisherWorkflow } from "../../scripts/aifisher-workflow-reader";
import type { WorkflowDefinition } from "../../src/types";

const workflowId = "2115791287499706370";
const graph = {
  "1": { class_type: "LoadImage", inputs: { image: "sample.png" } },
  "2": { class_type: "CustomEdit", inputs: { image: ["1", 0], prompt: "author sample", seed: 123 } },
  "3": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "authored" } },
};

type DigestGate = { enabled: boolean; started: boolean; release: () => void };
type DigestGateWindow = Window & { runningHubSaveDigest: DigestGate };

async function openManager(page: Page, mode: "workflow" | "app") {
  await page.getByRole("button", { name: "远程连接", exact: true }).click();
  const switcher = page.getByRole("dialog", { name: "选择算力", exact: true });
  await switcher.getByRole("button", { name: mode === "workflow" ? "工作流" : "AI 应用", exact: true }).click();
  await switcher.getByRole("button", { name: mode === "workflow" ? "添加 / 管理远端工作流" : "添加 / 管理 AI 应用", exact: true }).click();
  return page.getByRole("dialog", { name: mode === "workflow" ? "RunningHub ComfyUI 工作流" : "管理 AI 应用", exact: true });
}

async function savedWorkflows(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const workflows = await new Promise<WorkflowDefinition[] | undefined>((resolve, reject) => {
      const request = db.transaction("records").objectStore("records").get("runninghub-workflows");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return workflows ?? [];
  });
}

const scenarios = [
  { mode: "workflow", closeWhileSaving: false },
  { mode: "workflow", closeWhileSaving: true },
  { mode: "app", closeWhileSaving: false },
  { mode: "app", closeWhileSaving: true },
] as const;

for (const { mode, closeWhileSaving } of scenarios) {
  test(`RunningHub ${mode} ${closeWhileSaving ? "finishes saving after the dialog closes" : "saves on the first click"} and survives reload without duplicates`, async ({ page }) => {
    if (closeWhileSaving) {
      await page.addInitScript(() => {
        const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
        let resumeDigest: () => void;
        const ready = new Promise<void>(resolve => { resumeDigest = resolve; });
        const gate: DigestGate = {
          enabled: false,
          started: false,
          release: () => { gate.enabled = false; resumeDigest(); },
        };
        (window as DigestGateWindow).runningHubSaveDigest = gate;
        crypto.subtle.digest = async (...args: Parameters<SubtleCrypto["digest"]>) => {
          if (gate.enabled) { gate.started = true; await ready; }
          return originalDigest(...args);
        };
      });
    }
    const name = mode === "workflow" ? "First-click workflow" : "First-click AI app";
    const reader = await readAIFisherWorkflow(mode === "workflow" ? {
      environment: "runninghub-workflow", source: graph, remoteId: workflowId,
    } : {
      environment: "runninghub-webapp", remoteId: workflowId,
      source: { appName: name, nodeInfoList: [
        { nodeId: "1", fieldName: "prompt", fieldType: "STRING", fieldValue: "sample prompt" },
        { nodeId: "2", fieldName: "prompt", fieldType: "STRING", fieldValue: "second prompt" },
      ] },
    });
    let reads = 0;
    const unexpectedCalls: string[] = [];
    await page.route("**/__canvas/workflow-reader", route => {
      const request = route.request().postDataJSON();
      expect(request.environment).toBe(mode === "workflow" ? "runninghub-workflow" : "runninghub-webapp");
      expect(request.remote.remoteId).toBe(workflowId);
      reads++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reader) });
    });
    await page.route("**/api/runninghub/**", route => {
      const path = new URL(route.request().url()).pathname;
      const metadataPath = mode === "workflow" ? "/api/runninghub/api/workflow/getDetail" : "/api/runninghub/api/webapp/detail";
      if (path !== metadataPath) unexpectedCalls.push(path);
      return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
    await page.route(/https:\/\/(?:www\.)?runninghub\.(?:cn|ai)\/.*/, route => {
      unexpectedCalls.push(route.request().url());
      return route.abort();
    });
    await page.goto("/");
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    await page.getByLabel("项目名称").fill("Isolated first-click save");
    await page.getByRole("button", { name: "创建并打开" }).click();
    const dialog = await openManager(page, mode);
    await dialog.getByLabel("RunningHub CN 国内站 API Key", { exact: true }).fill("isolated-first-click-key");
    await dialog.getByRole("button", { name: "保存到本机", exact: true }).click();
    await dialog.getByRole("textbox", { name: mode === "workflow" ? "ComfyUI 工作流链接或 ID" : "RunningHub AI 应用 ID 或分享链接", exact: true }).fill(workflowId);
    await dialog.getByRole("button", { name: mode === "workflow" ? "读取工作流" : "读取并添加 AI 应用", exact: true }).click();
    const save = dialog.getByRole("button", { name: mode === "workflow" ? "添加到画布列表" : "保存 AI 应用", exact: true });
    await expect(save).toBeEnabled();
    if (mode === "workflow") {
      await dialog.getByRole("textbox", { name: "画布显示名称", exact: true }).fill(name);
    } else {
      await expect(dialog.getByRole("combobox", { name: "输出类型 1", exact: true })).toHaveValue("file");
      await expect(dialog.getByRole("textbox", { name: "输出字段 1", exact: true })).toHaveValue("*");
    }
    expect(await savedWorkflows(page)).toEqual([]);

    const listSelector = mode === "workflow" ? ".rh-remote-list article" : ".rh-workflow-cards article";
    if (closeWhileSaving) {
      await page.evaluate(() => { (window as DigestGateWindow).runningHubSaveDigest.enabled = true; });
      await save.click();
      await page.waitForFunction(() => (window as DigestGateWindow).runningHubSaveDigest.started);
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(await savedWorkflows(page)).toEqual([]);
      await page.evaluate(() => { (window as DigestGateWindow).runningHubSaveDigest.release(); });
      await expect.poll(() => savedWorkflows(page)).toHaveLength(1);
    } else {
      await save.click();
      await expect(dialog.getByRole("status").filter({ hasText: mode === "workflow" ? "已添加远端工作流引用" : "已添加“" })).toHaveCount(1);
      await expect(dialog.locator(listSelector)).toHaveCount(1);
      await expect(dialog.locator(listSelector)).toContainText(name);
    }
    const persisted = await savedWorkflows(page);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ name, runninghub: { workflowId, kind: mode === "workflow" ? "workflow" : "app" } });
    if (mode === "app") expect(persisted[0].output).toMatchObject({ kind: "file", field: "*" });

    await page.reload();
    await expect(page.locator(".canvas-shell")).toBeVisible();
    const reopened = await openManager(page, mode);
    await expect(reopened.locator(listSelector)).toHaveCount(1);
    await expect(reopened.locator(listSelector)).toContainText(name);
    const reloaded = await savedWorkflows(page);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe(persisted[0].id);
    expect(reloaded[0].output).toEqual(persisted[0].output);
    expect(reads).toBe(1);
    expect(unexpectedCalls).toEqual([]);
  });
}
