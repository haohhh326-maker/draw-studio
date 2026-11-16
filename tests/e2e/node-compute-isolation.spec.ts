import { expect, test, type Page } from "@playwright/test";

const projectId = "node-compute-isolation-e2e";
const runtimeErrors = new WeakMap<Page, string[]>();

async function seed(page: Page) {
  // All account/API operations are intercepted; data lives in this test's fresh browser context.
  await page.route("**/api/**", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"isolated test fixture"}' }));
  await page.route(/https:\/\/(?:www\.)?runninghub\.(?:cn|ai)\/.*/, route => route.abort());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
  await page.evaluate(projectId => {
    const workflow = (kind: "image" | "video" | "audio", source: "workflow" | "app") => ({
      id: `${source}-${kind}`, name: `${source === "app" ? "应用" : "工作流"}-${kind}`, family: "隔离测试", description: "",
      mode: `text-to-${kind}`, requiredInputs: [], optionalInputs: [], promptRequired: false,
      parameters: [{ key: "seed", label: "种子", type: "number", default: 1 }], mapping: [{ semantic: "seed", nodeId: "1", field: "seed" }],
      output: { nodeId: "2", field: kind === "image" ? "images" : kind === "video" ? "videos" : "audio", kind },
      template: { "1": { class_type: "KSampler", inputs: { seed: 1 } }, "2": { class_type: "Save" + kind, inputs: { images: ["1", 0] } } },
      runninghub: { workflowId: `211511542265474662${kind === "image" ? "1" : kind === "video" ? "2" : "3"}`,
        baseUrl: "https://www.runninghub.cn", kind: source },
    });
    const node = (id: string, kind: "image" | "video" | "audio", source: "workflow" | "app", x: number) => ({
      id, type: "media", position: { x, y: 140 }, data: {
        kind: kind === "image" ? "image-generation" : kind, title: id,
        generation: { computeProvider: source === "app" ? "runninghub" : "runninghub-workflow",
          workflowId: `${source}-${kind}`, params: { seed: 33 }, prompt: `保留 ${id} 原始提示词`, negativePrompt: "", taskId: null },
      },
    });
    const canvas = (id: string, name: string, nodes: ReturnType<typeof node>[]) => ({
      id, name, sceneId: "scene", nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    });
    const project = { version: 2, id: projectId, name: "独立算力测试", activeCanvasId: "canvas-a", updatedAt: Date.now(),
      scenes: [{ id: "scene", name: "场景 01" }], assets: {}, tasks: {}, history: [],
      canvases: [canvas("canvas-a", "画布 1", [node("图像 A", "image", "workflow", 180), node("视频 B", "video", "app", 650), node("音频 C", "audio", "workflow", 1120)]),
        canvas("canvas-b", "画布 2", [node("图像 D", "image", "app", 650)])] };
    return new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("clearframe-canvas", 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction("records", "readwrite"), records = tx.objectStore("records");
        records.put({ [projectId]: { project, workflows: [] } }, "project-library");
        records.put(["image", "video", "audio"].flatMap(kind => [workflow(kind as "image", "workflow"), workflow(kind as "image", "app")]), "runninghub-workflows");
        records.put({ provider: "runninghub-workflow" }, "compute-preferences");
        tx.oncomplete = () => { db.close(); sessionStorage.setItem("clearframe-open-project", projectId); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, projectId);
  await page.reload();
  await expect(page.locator(".canvas-shell")).toBeVisible();
}

async function openNode(page: Page, id: string) {
  const close = page.getByRole("button", { name: "关闭生成面板", exact: true });
  if (await close.isVisible()) await close.click();
  await page.locator(`.react-flow__node[data-id="${id}"]`).click();
  await expect(page.locator(".generation-panel")).toBeVisible();
}
const switcher = (page: Page) => page.getByRole("dialog", { name: "选择算力", exact: true });
const nodeCloud = (page: Page) => page.getByRole("button", { name: "选择当前节点算力", exact: true });
async function chooseMode(page: Page, mode: "AI 应用" | "工作流") {
  await nodeCloud(page).click();
  await switcher(page).getByRole("group", { name: "RunningHub 工作站模式" }).getByRole("button", { name: mode, exact: true }).click();
  await switcher(page).getByRole("button", { name: "关闭算力选择" }).click();
}
async function chooseWorkflow(page: Page, name: string) {
  await page.locator(".generation-panel .workflow-button").click();
  const picker = page.locator(".directory-picker");
  await picker.locator(".workflow-management-select").filter({ hasText: name }).click();
  await expect(page.locator(".generation-panel .workflow-button")).toContainText(name);
}
async function savedGenerations(page: Page) {
  const save = page.getByRole("button", { name: "保存项目", exact: true });
  await save.click();
  await expect(save).toHaveAttribute("title", /已保存到本机/);
  return page.evaluate(async projectId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("clearframe-canvas", 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    const library = await new Promise<any>((resolve, reject) => {
      const read = db.transaction("records").objectStore("records").get("project-library"); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
    });
    db.close();
    return Object.fromEntries(library[projectId].project.canvases.flatMap((canvas: any) => canvas.nodes.map((node: any) => [node.id, node.data.generation])));
  }, projectId);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  await seed(page);
});
test.afterEach(async ({ page }) => expect(runtimeErrors.get(page)).toEqual([]));

test("image, video, audio and another canvas retain independent compute and workflows after reload", async ({ page }) => {
  await openNode(page, "图像 A");
  await expect(page.getByRole("button", { name: "生成帮助", exact: true })).toHaveCount(0);
  await nodeCloud(page).click();
  await expect(switcher(page).locator("header")).toContainText("图像 A");
  await switcher(page).getByRole("radio", { name: /Muse/ }).click();
  await expect(page.locator(".generation-panel .workflow-button")).toContainText("Muse");

  await openNode(page, "视频 B");
  await expect(page.locator(".generation-panel .workflow-button")).toContainText("应用-video");
  await chooseMode(page, "工作流");
  await chooseWorkflow(page, "工作流-video");

  await openNode(page, "音频 C");
  await expect(page.locator(".generation-panel .workflow-button")).toContainText("工作流-audio");
  await chooseMode(page, "AI 应用");
  await chooseWorkflow(page, "应用-audio");
  await expect(page.getByRole("button", { name: "远程连接", exact: true })).toHaveCount(0);
  await expect(page.locator(".generation-panel .workflow-button")).toContainText("应用-audio");

  await page.locator('.canvas-tab[data-canvas-id="canvas-b"] > button').first().click();
  await openNode(page, "图像 D");
  await expect(page.locator(".generation-panel .workflow-button")).toContainText("应用-image");
  const generations = await savedGenerations(page);
  expect(generations["图像 A"]).toMatchObject({ computeProvider: "muse", prompt: "保留 图像 A 原始提示词" });
  expect(generations["视频 B"]).toMatchObject({ computeProvider: "runninghub-workflow", workflowId: "workflow-video" });
  expect(generations["音频 C"]).toMatchObject({ computeProvider: "runninghub", workflowId: "app-audio" });
  expect(generations["图像 D"]).toMatchObject({ computeProvider: "runninghub", workflowId: "app-image", params: { seed: 33 } });
  await page.reload();
  await expect(page.locator(".canvas-shell")).toBeVisible();
  await openNode(page, "图像 D");
  await expect(page.locator(".generation-panel .workflow-button")).toContainText("应用-image");
  await page.locator('.canvas-tab[data-canvas-id="canvas-a"] > button').first().click();
  await openNode(page, "图像 A");
  await expect(page.locator(".generation-panel .workflow-button")).toContainText("Muse");
  await openNode(page, "音频 C");
  await expect(page.locator(".generation-panel .workflow-button")).toContainText("应用-audio");
});

test("one card remembers its workflow and parameters separately for each provider", async ({ page }) => {
  await openNode(page, "图像 A");
  await chooseMode(page, "AI 应用");
  await chooseWorkflow(page, "应用-image");
  const seed = page.locator(".generation-panel").getByRole("spinbutton", { name: "种子", exact: true });
  await seed.fill("17");
  await seed.blur();
  await chooseMode(page, "工作流");
  await expect(page.locator(".generation-panel .workflow-button")).toContainText("工作流-image");
  await expect(seed).toHaveValue("33");
  await chooseMode(page, "AI 应用");
  await expect(page.locator(".generation-panel .workflow-button")).toContainText("应用-image");
  await expect(seed).toHaveValue("17");
  const generations = await savedGenerations(page);
  expect(generations["图像 A"].providerSelections["runninghub-workflow"]).toMatchObject({ workflowId: "workflow-image", params: { seed: 33 } });
  expect(generations["视频 B"]).toMatchObject({ computeProvider: "runninghub", workflowId: "app-video", params: { seed: 33 } });
});

test("the cloud popover fits the viewport, closes with Escape and restores keyboard focus", async ({ page }) => {
  await openNode(page, "图像 A");
  await nodeCloud(page).click();
  await expect(switcher(page)).toHaveCount(1);
  await expect(nodeCloud(page)).toHaveAttribute("aria-expanded", "true");
  const bounds = await switcher(page).boundingBox(), viewport = page.viewportSize()!;
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
  await page.screenshot({ path: ".cache/node-compute-isolation/cloud-switcher.png" });
  await page.keyboard.press("Escape");
  await expect(switcher(page)).toHaveCount(0);
  await expect(nodeCloud(page)).toBeFocused();
  await expect(nodeCloud(page)).toHaveAttribute("aria-expanded", "false");
});

test("card settings and local workflow import follow the card instead of the saved default", async ({ page }) => {
  await openNode(page, "图像 A");
  await nodeCloud(page).click();
  await switcher(page).getByRole("radio", { name: /ComfyUI/ }).click();
  await nodeCloud(page).click();
  await switcher(page).getByRole("button", { name: "算力设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "算力设置", exact: true });
  await expect(settings.getByRole("tab", { name: "云端 ComfyUI", exact: true })).toHaveAttribute("aria-selected", "true");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".generation-panel .workflow-button").click();
  await page.locator(".directory-picker").getByRole("button", { name: "工作流设置", exact: true }).click();
  await page.getByRole("menuitem", { name: "添加工作流", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "添加工作流", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "RunningHub ComfyUI 工作流", exact: true })).toHaveCount(0);
});
