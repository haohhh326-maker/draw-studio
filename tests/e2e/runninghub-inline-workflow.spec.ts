import { expect, test } from "@playwright/test";
import { readAIFisherWorkflow } from "../../scripts/aifisher-workflow-reader";

test("RunningHub workflow settings read and add a remote reference through the inline row", async ({ page }) => {
  const workflowId = "2115791287499706370";
  const graph = {
    "1": { class_type: "LoadImage", inputs: { image: "sample.png" } },
    "2": { class_type: "CustomEdit", inputs: { image: ["1", 0], prompt: "author sample", seed: 123 } },
    "3": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "authored" } },
  };
  const sourceRequests: string[] = [];
  const reader = await readAIFisherWorkflow({ environment: "runninghub-workflow", remote: {
    baseUrl: "https://www.runninghub.cn", remoteId: workflowId, apiKey: "isolated-inline-key",
  } }, { fetcher: async (input, init) => {
    const url = new URL(String(input));
    sourceRequests.push(url.pathname);
    if (url.pathname === "/api/openapi/getJsonApiFormat")
      return Response.json({ code: 810, msg: "WORKFLOW_NOT_SAVED_OR_NOT_RUNNING" });
    expect(url.pathname).toBe("/api/workflow/export");
    expect(new Headers(init?.headers).get("accept")).toBe("*/*");
    return Response.json(graph);
  } });
  expect(sourceRequests).toEqual(["/api/openapi/getJsonApiFormat", "/api/workflow/export"]);
  expect(reader.runninghubSource?.workflowReadSource).toBe("official-api-export");
  let reads = 0;
  const unexpectedCalls: string[] = [];
  await page.route("**/__canvas/workflow-reader", async route => {
    const request = route.request().postDataJSON();
    expect(request.environment).toBe("runninghub-workflow");
    expect(request.remote.remoteId).toBe(workflowId);
    expect(request.remote.baseUrl).toBe("https://www.runninghub.cn");
    reads++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reader) });
  });
  await page.route("**/api/runninghub/**", route => {
    if (!route.request().url().endsWith("/api/workflow/getDetail")) unexpectedCalls.push(route.request().url());
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  await page.route(/https:\/\/(?:www\.)?runninghub\.(?:cn|ai)\/.*/, route => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("工作流内嵌添加验证");
  await page.getByRole("button", { name: "创建并打开" }).click();
  await page.getByRole("button", { name: "远程连接", exact: true }).click();
  await page.getByRole("dialog", { name: "选择算力", exact: true }).getByRole("button", { name: "算力设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "算力设置", exact: true });
  await settings.getByRole("tab", { name: "RunningHub 工作流", exact: true }).click();
  const editor = settings.locator(".rh-remote-inline");
  await expect(settings.locator(".runninghub-settings > .rh-account-settings + .rh-remote-inline")).toHaveCount(1);
  const sites = editor.getByRole("group", { name: "RunningHub 工作流站点", exact: true });
  await expect(sites.getByRole("button", { name: "CN", exact: true })).toHaveAttribute("aria-pressed", "true");
  await sites.getByRole("button", { name: "AI", exact: true }).click();
  await expect(sites.getByRole("button", { name: "AI", exact: true })).toHaveAttribute("aria-pressed", "true");
  await sites.getByRole("button", { name: "CN", exact: true }).click();
  await settings.getByLabel("RunningHub CN 国内站 API Key", { exact: true }).fill("isolated-inline-key");
  await settings.getByRole("button", { name: "保存到本机", exact: true }).click();
  await editor.getByRole("textbox", { name: "RunningHub 工作流 ID 或分享链接", exact: true }).fill("https://www.runninghub.cn/workflow/" + workflowId);
  await editor.getByRole("button", { name: "读取并添加工作流", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("已添加远端工作流引用");
  await expect(editor.locator(".rh-remote-list article")).toHaveCount(1);
  await expect(editor.locator(".rh-remote-list article")).toContainText(workflowId);
  expect(reads).toBe(1);
  expect(unexpectedCalls).toEqual([]);
  const saved = await page.evaluate(async workflowId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const workflows = await new Promise<any[]>((resolve, reject) => {
      const request = db.transaction("records").objectStore("records").get("runninghub-workflows");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const workflow = workflows.find(item => item.runninghub?.workflowId === workflowId);
    return { kind: workflow.runninghub.kind, billingMode: workflow.runninghub.billingMode, includeWorkflowJson: workflow.runninghub.includeWorkflowJson,
      directory: workflow.directory ?? null, library: workflow.library ?? null, template: workflow.template };
  }, workflowId);
  expect(saved).toEqual({ kind: "workflow", billingMode: "consumer", includeWorkflowJson: false, directory: null, library: null, template: graph });
});
