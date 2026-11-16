import { expect, test } from "@playwright/test";
import { dropFileOnCanvas, openCanvasAddMenu } from "./helpers";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
  "base64",
);

type ReferenceImportGateWindow = Window & { referenceImportGate: { started: boolean; release: () => void } };

test("reference uploads and canvas drops enter the asset library only after an explicit library action", async ({ page }) => {
  const unexpectedCalls: string[] = [];
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/api/runninghub/**", route => {
    unexpectedCalls.push(route.request().url());
    return route.abort();
  });
  await page.route(/https:\/\/(?:www\.)?runninghub\.(?:cn|ai)\/.*/, route => {
    unexpectedCalls.push(route.request().url());
    return route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("Isolated reference library membership");
  await page.getByRole("button", { name: "创建并打开" }).click();

  await openCanvasAddMenu(page, { x: 490, y: 234 });
  await page.getByRole("menuitem", { name: "参考" }).click();
  const reference = page.locator(".react-flow__node").filter({ hasText: "参考 1" });
  await reference.getByLabel("上传素材").setInputFiles({ name: "reference-upload.png", mimeType: "image/png", buffer: png });
  await expect(reference.getByRole("img", { name: "reference-upload.png", exact: true })).toBeVisible();
  await dropFileOnCanvas(page, { name: "canvas-drop.png", mimeType: "image/png", buffer: png });
  const dropped = page.locator(".react-flow__node").filter({ has: page.getByRole("img", { name: "canvas-drop.png", exact: true }) });
  await expect(dropped).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);

  await page.getByRole("button", { name: "资产库", exact: true }).click();
  const library = page.getByRole("dialog", { name: "资产库", exact: true });
  const cards = library.locator(".asset-library-grid article");
  await expect(cards).toHaveCount(0);
  await expect(library.getByRole("heading", { name: "资产库还是空的", exact: true })).toBeVisible();
  await library.getByRole("button", { name: "关闭", exact: true }).click();

  await reference.click({ button: "right" });
  await reference.getByRole("menuitem", { name: "添加到资产库", exact: true }).click();
  const entry = page.getByRole("dialog", { name: "添加到资产库", exact: true });
  await entry.getByLabel("素材名称", { exact: true }).fill("Saved reference");
  await entry.getByRole("button", { name: "保存", exact: true }).click();
  await expect(entry).toHaveCount(0);
  await page.getByRole("button", { name: "资产库", exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("Saved reference.png");

  await library.getByLabel("选择素材文件", { exact: true }).setInputFiles({ name: "library-import.png", mimeType: "image/png", buffer: png });
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "library-import.png" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "canvas-drop.png" })).toHaveCount(0);
  await library.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);

  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(dropped).toBeVisible();
  await page.getByRole("button", { name: "资产库", exact: true }).click();
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "Saved reference.png" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "library-import.png" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "canvas-drop.png" })).toHaveCount(0);
  expect(unexpectedCalls).toEqual([]);
  expect(failures).toEqual([]);
});

test("a reference import finishing after a canvas switch stays on its original canvas and outside the library", async ({ page }) => {
  const unexpectedCalls: string[] = [];
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/api/runninghub/**", route => {
    unexpectedCalls.push(route.request().url());
    return route.abort();
  });
  await page.route(/https:\/\/(?:www\.)?runninghub\.(?:cn|ai)\/.*/, route => {
    unexpectedCalls.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript(() => {
    const originalCreateImageBitmap = window.createImageBitmap;
    let resumeBitmap: () => void;
    const ready = new Promise<void>(resolve => { resumeBitmap = resolve; });
    const gate = { started: false, release: () => resumeBitmap() };
    (window as ReferenceImportGateWindow).referenceImportGate = gate;
    Object.defineProperty(window, "createImageBitmap", {
      configurable: true,
      writable: true,
      value: async (source: ImageBitmapSource, ...args: unknown[]) => {
        if (source instanceof File && source.name === "switching-reference.png") {
          gate.started = true;
          await ready;
        }
        return Reflect.apply(originalCreateImageBitmap, window, [source, ...args]);
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("Isolated reference canvas switch");
  await page.getByRole("button", { name: "创建并打开" }).click();
  await dropFileOnCanvas(page, { name: "switching-reference.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(() => (window as ReferenceImportGateWindow).referenceImportGate.started);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);

  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  await expect(page.locator(".canvas-tab.active")).toContainText("画布 2");
  await page.evaluate(() => { (window as ReferenceImportGateWindow).referenceImportGate.release(); });
  await expect(page.getByRole("status").filter({ hasText: "参考素材已添加到原画布。" })).toHaveCount(1);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.getByRole("button", { name: "资产库", exact: true }).click();
  const library = page.getByRole("dialog", { name: "资产库", exact: true });
  await expect(library.locator(".asset-library-grid article")).toHaveCount(0);
  await expect(library.getByRole("heading", { name: "资产库还是空的", exact: true })).toBeVisible();
  await library.getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "画布 1", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(page.getByRole("img", { name: "switching-reference.png", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
  await page.reload();
  await expect(page.locator(".canvas-tab.active")).toContainText("画布 1");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(page.getByRole("img", { name: "switching-reference.png", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "画布 2", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.getByRole("button", { name: "资产库", exact: true }).click();
  await expect(library.locator(".asset-library-grid article")).toHaveCount(0);
  await expect(library.getByRole("heading", { name: "资产库还是空的", exact: true })).toBeVisible();
  expect(unexpectedCalls).toEqual([]);
  expect(failures).toEqual([]);
});
