import { expect, test, type Page } from "@playwright/test";

const projectId = "e2e-runninghub-ui-isolated";
const projectName = "RunningHub 菜单测试";
const workflowName = "E2E 远端工作流";
const appName = "E2E AI 应用";

async function seedIsolatedRunningHubCatalog(page: Page) {
  // The page has its own browser context. Never read or modify a user project.
  // Published-card requests are intercepted so these UI tests cannot contact RH.
  await page.route("**/api/runninghub/**", route => route.fulfill({
    status: 503, contentType: "application/json", body: '{"code":503,"msg":"offline test fixture"}',
  }));
  await page.route(/https:\/\/(?:www\.)?runninghub\.(?:cn|ai)\/.*/, route => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
  await page.evaluate(({ projectId, projectName, workflowName, appName }) => {
    const imageWorkflow = (id: string, name: string, kind: "workflow" | "app") => ({
      id, name, description: "", family: "图像工具", mode: "text-to-image",
      requiredInputs: [], optionalInputs: [], promptRequired: false,
      parameters: [], mapping: [], output: { nodeId: "2", field: "images", kind: "image" },
      template: { "2": { class_type: "SaveImage", inputs: {} } },
      runninghub: { workflowId: kind === "workflow" ? "2115115422654746625" : "2097920992202022914",
        baseUrl: "https://www.runninghub.cn", kind },
    });
    const remoteWorkflow = imageWorkflow("e2e-rh-workflow", workflowName, "workflow");
    const app = imageWorkflow("e2e-rh-app", appName, "app");
    const project = {
      version: 2, id: projectId, name: projectName, activeCanvasId: "canvas",
      scenes: [{ id: "scene", name: "场景 01" }], updatedAt: Date.now(),
      assets: {}, tasks: {}, history: [],
      canvases: [{ id: "canvas", name: "画布 1", sceneId: "scene",
        viewport: { x: 0, y: 0, zoom: 1 }, edges: [],
        nodes: [{ id: "target", type: "media", position: { x: 650, y: 180 },
          data: { kind: "image-generation", title: "图像 1", generation: {
            computeProvider: "runninghub-workflow", workflowId: remoteWorkflow.id,
            prompt: "", negativePrompt: "", params: {}, taskId: null,
          } } }],
      }],
    };
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("records", "readwrite");
        const records = tx.objectStore("records");
        records.put({ [projectId]: { project, workflows: [] } }, "project-library");
        records.put([remoteWorkflow, app], "runninghub-workflows");
        records.put({ provider: "runninghub-workflow" }, "compute-preferences");
        tx.oncomplete = () => { db.close(); sessionStorage.setItem("clearframe-open-project", projectId); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, { projectId, projectName, workflowName, appName });
  await page.reload();
  await expect(page.locator(".canvas-shell")).toBeVisible();
  await page.locator('.react-flow__node[data-id="target"]').click();
  await expect(page.locator(".generation-panel")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await seedIsolatedRunningHubCatalog(page);
});

test("RunningHub custom mode menu supports pointer and keyboard and persists ultra", async ({ page }) => {
  const mode = page.getByRole("combobox", { name: "运行模式", exact: true });
  const options = page.getByRole("listbox", { name: "运行模式", exact: true });
  await expect(mode).toHaveText("Standard");
  await mode.click();
  await expect(options.getByRole("option")).toHaveText(["Standard", "Plus", "6000D"]);
  await options.getByRole("option", { name: "Plus", exact: true }).click();
  await expect(mode).toHaveText("Plus");

  await mode.press("End");
  await expect(options).toBeVisible();
  await options.press("Enter");
  await expect(mode).toHaveText("6000D");
  await mode.click();
  await options.press("Escape");
  await expect(options).toHaveCount(0);
  await expect(mode).toHaveText("6000D");

  await mode.click();
  await page.getByRole("button", { name: "选择当前节点算力", exact: true }).click();
  await expect(options).toHaveCount(0);
  await page.getByRole("button", { name: "关闭算力选择", exact: true }).click();
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  const raw = await page.evaluate(async projectId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const library = await new Promise<Record<string, { project: { canvases: { nodes: { id: string; data: { generation: { runningHubInstanceType?: string } } }[] }[] } }>>((resolve, reject) => {
      const request = db.transaction("records").objectStore("records").get("project-library");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return library[projectId].project.canvases[0].nodes.find(node => node.id === "target")?.data.generation.runningHubInstanceType;
  }, projectId);
  expect(raw).toBe("ultra");

  await page.getByRole("button", { name: "返回项目列表", exact: true }).click();
  await page.getByRole("button", { name: `打开项目：${projectName}` }).click();
  await page.locator('.react-flow__node[data-id="target"]').click();
  await expect(page.getByRole("combobox", { name: "运行模式", exact: true })).toHaveText("6000D");
});

test("RunningHub workflow and AI app catalogs stay separate when switching compute", async ({ page }) => {
  const picker = page.locator(".directory-picker");
  const chooseWorkflow = page.locator(".generation-panel .workflow-button");
  await chooseWorkflow.click();
  await expect(picker).toBeVisible();
  await expect(picker.locator(".directory-workflow")).toHaveCount(1);
  await expect(picker.locator(".directory-workflow")).toContainText(workflowName);
  await expect(picker).not.toContainText(appName);
  await picker.getByRole("button", { name: "关闭选择器" }).click();

  await page.getByRole("button", { name: "选择当前节点算力", exact: true }).click();
  const switcher = page.getByRole("dialog", { name: "选择算力", exact: true });
  const workstation = switcher.getByRole("radio", { name: /RunningHub 工作站/ });
  const modes = switcher.getByRole("group", { name: "RunningHub 工作站模式", exact: true });
  await expect(workstation).toHaveCount(1);
  await expect(switcher.getByRole("radio")).toHaveCount(3);
  await expect(modes.getByRole("button", { name: "工作流", exact: true })).toHaveAttribute("aria-pressed", "true");
  await modes.getByRole("button", { name: "AI 应用", exact: true }).click();
  await expect(switcher).toBeVisible();
  await expect(modes.getByRole("button", { name: "AI 应用", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(workstation).toContainText("1 个 AI 应用");
  await switcher.getByRole("button", { name: "关闭算力选择", exact: true }).click();
  await expect(switcher).toHaveCount(0);
  await chooseWorkflow.click();
  await expect(picker).toBeVisible();
  await expect(picker.locator(".directory-workflow")).toHaveCount(1);
  await expect(picker.locator(".directory-workflow")).toContainText(appName);
  await expect(picker).not.toContainText(workflowName);
  await picker.getByRole("button", { name: "关闭选择器" }).click();

  await page.getByRole("button", { name: "选择当前节点算力", exact: true }).click();
  await modes.getByRole("button", { name: "工作流", exact: true }).click();
  await expect(workstation).toContainText("1 个远端工作流");
  await workstation.click();
  await expect(switcher).toHaveCount(0);
  await chooseWorkflow.click();
  await expect(picker.locator(".directory-workflow")).toHaveCount(1);
  await expect(picker.locator(".directory-workflow")).toContainText(workflowName);
  await expect(picker).not.toContainText(appName);
  await picker.getByRole("button", { name: "关闭选择器" }).click();
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  await page.reload();
  await page.locator('.react-flow__node[data-id="target"]').click();
  await page.getByRole("button", { name: "选择当前节点算力", exact: true }).click();
  await expect(modes.getByRole("button", { name: "工作流", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(workstation).toHaveAttribute("aria-checked", "true");
});

test("RunningHub workstation exposes mode-specific management and compact account settings", async ({ page }) => {
  await page.getByRole("button", { name: "选择当前节点算力", exact: true }).click();
  const switcher = page.getByRole("dialog", { name: "选择算力", exact: true });
  const modes = switcher.getByRole("group", { name: "RunningHub 工作站模式", exact: true });
  await expect(switcher).toBeVisible();
  const modeBounds = await modes.boundingBox();
  const statusBounds = await switcher.locator(".compute-runninghub-status .compute-status").boundingBox();
  expect(modeBounds).not.toBeNull();
  expect(statusBounds).not.toBeNull();
  expect(modeBounds!.y + modeBounds!.height).toBeLessThanOrEqual(statusBounds!.y);
  await switcher.getByRole("button", { name: "添加 / 管理远端工作流", exact: true }).click();
  const workflowManager = page.getByRole("dialog", { name: "RunningHub ComfyUI 工作流", exact: true });
  await expect(workflowManager).toBeVisible();
  await expect(workflowManager).toContainText(workflowName);
  await expect(workflowManager.locator(".rh-account-billing")).toHaveCount(0);
  await workflowManager.getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "选择当前节点算力", exact: true }).click();
  await modes.getByRole("button", { name: "AI 应用", exact: true }).click();
  await expect(switcher.getByRole("button", { name: "添加 / 管理远端工作流", exact: true })).toHaveCount(0);
  await switcher.getByRole("button", { name: "添加 / 管理 AI 应用", exact: true }).click();
  const appManager = page.getByRole("dialog", { name: "管理 AI 应用", exact: true });
  await expect(appManager).toBeVisible();
  await expect(appManager).toContainText(appName);
  await appManager.getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "选择当前节点算力", exact: true }).click();
  await switcher.getByRole("button", { name: "算力设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "算力设置", exact: true });
  await settings.getByRole("tab", { name: "RunningHub 工作流", exact: true }).click();
  await expect(settings.locator('input[aria-label="RunningHub CN 国内站 API Key"]')).toBeVisible();
  await expect(settings.locator(".rh-account-billing, .compute-native-billing")).toHaveCount(0);
  await expect(settings).not.toContainText("此处填写提交任务的账号 Key");
  await expect(settings.getByRole("button", { name: "添加 / 管理远端工作流", exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "保存并验证", exact: true })).toBeVisible();
});
