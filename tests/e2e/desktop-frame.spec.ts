import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import type {} from "../../src/services/native-webview-bridge";

const url = process.env.DRAW_STUDIO_FRAME_URL || "http://127.0.0.1:1420/";
async function fixture(page: Page, mode: "web" | "host-without-titlebar" | "desktop") {
  await page.route("**/api/muse/session", route => route.fulfill({ json: { status: "disconnected", message: "offline fixture" } }));
  await page.route("**/api/runninghub/**", route => route.abort());
  await page.route(/https:\/\/(?:www\.)?runninghub\.(?:cn|ai)\/.*/, route => route.abort());
  await page.route("**/__canvas/workflow-library", route => route.fulfill({ json: { sourcePath: "fixture", loadedAt: 1, workflows: [], issues: [], scanned: 0 } }));
  await page.addInitScript(mode => {
    const current = window as Window & { frameCalls: { command: string; args: Record<string, unknown> }[] };
    current.frameCalls = [];
    if (mode !== "web") window.drawStudioHost = {
      ...(mode === "desktop" ? { customTitleBar: true } : {}),
      async invoke(command, args) {
        current.frameCalls.push({ command, args });
        return command === "export_service_webview_auth" ? { cookies: [], origins: [] } : {};
      },
    };
  }, mode);
  await page.goto(url);
  await expect(page.getByRole("button", { name: "新建项目", exact: true })).toBeVisible();
}
async function openProject(page: Page) {
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("标题栏布局检查");
  await page.getByRole("button", { name: "创建并打开", exact: true }).click();
  await expect(page.locator(".canvas-shell")).toBeVisible();
}
async function expectToolbarGapPassThrough(page: Page) {
  const point = await page.evaluate(() => {
    const left = document.querySelector(".project-section")!.getBoundingClientRect();
    const right = document.querySelector(".top-actions")!.getBoundingClientRect();
    const bar = document.querySelector(".topbar")!.getBoundingClientRect();
    return { x: (left.right + right.left) / 2, y: bar.top + bar.height / 2 };
  });
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".react-flow__pane")), point)).toBe(true);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect(page.getByRole("menu", { name: "添加到画布", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "添加到画布", exact: true })).toHaveCount(0);
  return point;
}
async function expectTabScrollMatchesGeometry(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const tabs = document.querySelector<HTMLElement>(".canvas-tabs")!;
    const previous = document.querySelector<HTMLButtonElement>('[aria-label="查看前面的画布"]')!;
    const next = document.querySelector<HTMLButtonElement>('[aria-label="查看后面的画布"]')!;
    return {
      previous: !previous.disabled === (tabs.scrollLeft > 1),
      next: !next.disabled === (tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1),
    };
  })).toEqual({ previous: true, next: true });
}

for (const mode of ["web", "desktop"] as const) {
  for (const width of [1000, 1600]) {
    test(`${mode} keeps long names and multiple canvas actions usable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await fixture(page, mode);
      await openProject(page);
      const projectName = "长项目名称与服装动作分镜".repeat(16);
      const canvasName = "长画布名称与分镜内容".repeat(16);
      await page.getByLabel("项目名称", { exact: true }).fill(projectName);
      await page.locator(".react-flow__pane").click({ position: { x: 500, y: 300 } });
      await expect(page.getByLabel("项目名称", { exact: true })).toHaveAttribute("title", projectName);
      const tabs = page.getByRole("navigation", { name: "画布标签", exact: true });
      const add = page.getByRole("button", { name: "新建画布", exact: true });
      for (let index = 2; index <= 10; index++) {
        await add.click();
        await expect(tabs.locator(".canvas-tab.active .canvas-tab-label")).toHaveText(`画布 ${index}`);
      }
      await expect(tabs.locator(".canvas-tab")).toHaveCount(10);
      await expect(tabs.locator(".canvas-tab-add")).toHaveCount(0);

      const active = tabs.locator(".canvas-tab.active");
      const originalName = await active.locator(".canvas-tab-label").textContent();
      await active.locator("button").first().dblclick();
      const rename = page.getByRole("dialog", { name: "重命名画布", exact: true });
      await expect(rename).toBeVisible();
      await rename.getByLabel("画布名称", { exact: true }).fill("取消的画布名称");
      await page.keyboard.press("Escape");
      await expect(rename).toHaveCount(0);
      await expect(active.locator(".canvas-tab-label")).toHaveText(originalName!);

      await active.locator("button").first().dblclick();
      await rename.getByLabel("画布名称", { exact: true }).fill(canvasName);
      await rename.getByRole("button", { name: "保存", exact: true }).click();
      await expect(rename).toHaveCount(0);
      const label = active.locator(".canvas-tab-label");
      await expect(label).toHaveText(canvasName);
      await expect(label).toHaveAttribute("title", canvasName);
      expect(await label.evaluate(element => ({ ellipsis: getComputedStyle(element).textOverflow,
        clipped: element.scrollWidth > element.clientWidth }))).toEqual({ ellipsis: "ellipsis", clipped: true });
      await expectTabScrollMatchesGeometry(page);
      await expect.poll(() => active.locator(".tab-close").evaluate(element => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === element;
      })).toBe(true);

      const layout = await page.evaluate(() => {
        const project = document.querySelector(".project-section")!.getBoundingClientRect();
        const actions = document.querySelector(".top-actions")!.getBoundingClientRect();
        const add = document.querySelector(".canvas-tab-add")!.getBoundingClientRect();
        return { projectRight: project.right, actionsLeft: actions.left, actionsRight: actions.right,
          addRight: add.right, addLeft: add.left, titleWidth: document.querySelector(".project-title")!.getBoundingClientRect().width,
          icons: [...document.querySelectorAll(".top-actions .icon-button")].map(element => {
            const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height };
          }) };
      });
      expect(layout.projectRight).toBeLessThanOrEqual(layout.actionsLeft);
      expect(layout.actionsRight).toBeLessThanOrEqual(width);
      expect(layout.addLeft).toBeGreaterThanOrEqual(0);
      expect(layout.addRight).toBeLessThanOrEqual(layout.actionsLeft);
      expect(layout.titleWidth).toBeLessThanOrEqual(160);
      expect(layout.icons).toHaveLength(7);
      if (width === 1000) expect(layout.icons).toEqual(Array.from({ length: 7 }, () => ({ width: 30, height: 30 })));

      const previous = page.getByRole("button", { name: "查看前面的画布", exact: true });
      await expect(previous).toBeEnabled();
      const before = await tabs.evaluate(element => element.scrollLeft);
      await previous.click();
      await expect.poll(() => tabs.evaluate(element => element.scrollLeft)).toBeLessThan(before);
      await expectTabScrollMatchesGeometry(page);
      await expect(page.getByRole("button", { name: "查看后面的画布", exact: true })).toBeEnabled();
      await add.click();
      await expect(tabs.locator(".canvas-tab")).toHaveCount(11);
      await expect(tabs.locator(".canvas-tab.active .canvas-tab-label")).toHaveText("画布 11");
      await tabs.locator(".canvas-tab.active .tab-close").click();
      await expect(tabs.locator(".canvas-tab")).toHaveCount(10);
      await page.getByRole("button", { name: "网页服务", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "Muse", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "网页服务", exact: true }).click();
      await page.getByRole("button", { name: "保存项目", exact: true }).click();
      await expect(page.getByRole("button", { name: "保存项目", exact: true })).toHaveAttribute("title", /已保存到本机/);
      await page.reload();
      await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue(projectName);
      await expect(tabs.locator(".canvas-tab")).toHaveCount(10);
      await expect(tabs.locator(".canvas-tab-label").filter({ hasText: canvasName })).toHaveAttribute("title", canvasName);
    });
  }
}
for (const mode of ["web", "host-without-titlebar", "desktop"] as const) {
  test(`${mode} reserves the caption only for the explicit desktop marker`, async ({ page }) => {
    await fixture(page, mode);
    const captionHeight = mode === "desktop" ? 36 : 0;
    await expect(page.locator(".desktop-titlebar")).toHaveCount(mode === "desktop" ? 1 : 0);
    expect((await page.locator(".project-home").boundingBox())!.y).toBe(captionHeight);
    await openProject(page);
    const bounds = await page.evaluate(() => {
      const caption = document.querySelector(".desktop-titlebar");
      const bar = document.querySelector(".topbar")!, canvas = document.querySelector(".canvas-shell")!;
      const surfaceProbe = document.createElement("span");
      surfaceProbe.style.backgroundColor = "var(--surface)";
      document.body.append(surfaceProbe);
      const surfaceColor = getComputedStyle(surfaceProbe).backgroundColor;
      surfaceProbe.remove();
      return { captionHeight: caption?.getBoundingClientRect().height ?? 0,
        captionColor: caption ? getComputedStyle(caption).backgroundColor : undefined,
        surfaceColor,
        topbarColor: getComputedStyle(bar).backgroundColor,
        topbarPointerEvents: getComputedStyle(bar).pointerEvents,
        canvasColor: getComputedStyle(canvas).backgroundColor,
        top: bar.getBoundingClientRect().top, canvasTop: canvas.getBoundingClientRect().top,
        canvasBottom: canvas.getBoundingClientRect().bottom, viewport: window.innerHeight,
        transform: getComputedStyle(document.querySelector(".desktop-frame-content") ?? document.body).transform };
    });
    expect(bounds.captionHeight).toBe(captionHeight);
    expect(bounds.top).toBe(captionHeight);
    expect(bounds.canvasTop).toBe(mode === "desktop" ? captionHeight : 64);
    expect(bounds.canvasBottom).toBe(bounds.viewport);
    expect(bounds.transform).toBe("none");
    if (mode === "desktop") {
      expect(bounds.captionColor).toBe(bounds.surfaceColor);
      expect(bounds.canvasColor).toBe("rgb(0, 0, 0)");
      expect(bounds.topbarColor).toBe("rgba(0, 0, 0, 0)");
      expect(bounds.topbarPointerEvents).toBe("none");
      await expect.poll(() => page.locator(".desktop-titlebar img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expect(page.locator(".desktop-titlebar button")).toHaveCount(0);
    }
    const actions = (await page.locator(".top-actions").boundingBox())!;
    expect(actions.y).toBeGreaterThanOrEqual(captionHeight);
    expect(actions.y + actions.height).toBeLessThanOrEqual(captionHeight + 64);
    if (mode === "desktop") {
      expect(actions.y).toBeGreaterThan(bounds.canvasTop);
      await expectToolbarGapPassThrough(page);
    }
    await page.getByRole("button", { name: "网页服务", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Muse", exact: true })).toBeVisible();
  });
}
test("desktop portals and native webpage bounds remain below the caption on resize", async ({ page }, testInfo) => {
  await fixture(page, "desktop"); await openProject(page);
  await page.setViewportSize({ width: 1100, height: 720 });
  const gap = await expectToolbarGapPassThrough(page);
  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 400, y: 260 } });
  await page.getByRole("menuitem", { name: /^图像/ }).click();
  await page.locator(".react-flow__node").click();
  await page.getByRole("button", { name: "选择当前节点算力", exact: true }).click();
  const compute = page.getByRole("dialog", { name: "选择算力", exact: true }); await expect(compute).toBeVisible();
  const placement = await compute.evaluate(element => ({ y: element.getBoundingClientRect().top,
    cssTop: parseFloat(getComputedStyle(element).top), bottom: element.getBoundingClientRect().bottom,
    canvasTop: document.querySelector(".canvas-shell")!.getBoundingClientRect().top, viewport: window.innerHeight }));
  expect(placement.y).toBeCloseTo(placement.cssTop); expect(placement.y).toBeGreaterThanOrEqual(placement.canvasTop);
  expect(placement.bottom).toBeLessThanOrEqual(placement.viewport);
  await page.keyboard.press("Escape"); await expect(compute).toHaveCount(0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator(".modal-backdrop")).toBeVisible();
  const backdrop = (await page.locator(".modal-backdrop").boundingBox())!;
  expect(backdrop.y).toBe(36); expect(backdrop.height).toBe(684);
  expect(await page.evaluate(() => Boolean(document.elementFromPoint(500, 18)?.closest(".desktop-titlebar")))).toBe(true);
  await page.locator(".modal").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "网页服务", exact: true }).click();
  await page.getByRole("menuitem", { name: "Muse", exact: true }).click();
  await expect(page.locator(".canvas-service-panel")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as Window & { frameCalls: { command: string; args: Record<string, unknown> }[] }).frameCalls
    .filter(call => ["show_service_webview", "set_service_webview_bounds"].includes(call.command)).at(-1)?.args.y)).toBeGreaterThanOrEqual(100);
  const panel = page.locator(".canvas-service-panel");
  const header = (await panel.locator(".canvas-service-panel-header").boundingBox())!;
  const originalTop = (await panel.boundingBox())!.y;
  await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + header.width / 2, 0, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await panel.boundingBox())!.y).toBeLessThan(originalTop);
  const toolbarBottom = await page.locator(".topbar").evaluate(element => element.getBoundingClientRect().bottom);
  expect((await panel.boundingBox())!.y).toBeGreaterThanOrEqual(toolbarBottom + 8);
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect.poll(async () => (await panel.boundingBox())!.y).toBeGreaterThanOrEqual(toolbarBottom + 8);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.screenshot({ path: testInfo.outputPath("desktop-service-panel-placement.png") });
  await page.getByRole("button", { name: "关闭聊天窗口", exact: true }).click();
  await expect(page.locator(".canvas-service-panel")).toHaveCount(0);
  const screenshot = await page.screenshot({ path: testInfo.outputPath("desktop-theme-caption.png") });
  const { data, info } = await sharp(screenshot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (18 * info.width + 500) * 4;
  expect([...data.subarray(pixel, pixel + 4)]).toEqual([38, 40, 42, 255]);
  let gridPixels = 0;
  for (let y = 36; y < 100; y++) {
    for (let x = Math.floor(gap.x - 50); x < Math.floor(gap.x + 50); x++) {
      const offset = (y * info.width + x) * 4;
      if (data[offset] > 10 && data[offset] < 100 && data[offset + 1] > 10 && data[offset + 1] < 100 && data[offset + 2] > 10 && data[offset + 2] < 100) gridPixels++;
    }
  }
  expect(gridPixels).toBeGreaterThan(0);
  await testInfo.attach("desktop-theme-caption", { body: screenshot, contentType: "image/png" });
});

test("native Muse hides before canvas rename and modal shortcuts leave background nodes intact", async ({ page }) => {
  await fixture(page, "desktop");
  await openProject(page);
  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 400, y: 260 } });
  await page.getByRole("menuitem", { name: /^参考/ }).click();
  const node = page.locator(".react-flow__node");
  await expect(node).toHaveCount(1);
  await expect(node).toHaveClass(/selected/);
  const nodeId = await node.getAttribute("data-id");
  await page.keyboard.press("Control+c");
  await expect(page.getByText("已复制 1 个节点。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "网页服务", exact: true }).click();
  await page.getByRole("menuitem", { name: "Muse", exact: true }).click();
  await expect(page.locator(".canvas-service-panel")).toBeVisible();
  const hideCount = () => page.evaluate(() => (window as Window & { frameCalls: { command: string }[] }).frameCalls
    .filter(call => call.command === "hide_service_webview").length);
  const previousHides = await hideCount();
  await page.locator(".canvas-tab.active > button").first().dblclick();
  const rename = page.getByRole("dialog", { name: "重命名画布", exact: true });
  await expect(rename).toBeVisible();
  await expect(page.locator(".canvas-service-panel")).toHaveCount(0);
  await expect.poll(hideCount).toBeGreaterThan(previousHides);
  await expect(node).toHaveClass(/selected/);
  const save = rename.getByRole("button", { name: "保存", exact: true });
  await save.focus();
  await page.keyboard.press("Delete");
  await expect(node).toHaveCount(1);
  for (let index = 0; index < 5; index++) await page.keyboard.press("Control+z");
  await expect(node).toHaveCount(1);
  const prevented = await save.evaluate(element => {
    const data = new DataTransfer();
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(node).toHaveCount(1);
  await expect(node).toHaveAttribute("data-id", nodeId!);
  await rename.getByLabel("画布名称", { exact: true }).fill("聊天窗口后的重命名");
  await save.click();
  await expect(rename).toHaveCount(0);
  await expect(page.locator(".canvas-tab.active .canvas-tab-label")).toHaveText("聊天窗口后的重命名");
  await expect(node).toHaveCount(1);
  await page.locator(".canvas-tab.active > button").first().dblclick();
  await expect(rename).toBeVisible();
  await rename.getByRole("button", { name: "取消", exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(node).toHaveClass(/selected/);
  await page.keyboard.press("Delete");
  await expect(node).toHaveCount(0);
});

test("native resized service panels keep their close control inside a narrower viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await fixture(page, "desktop");
  await openProject(page);
  await page.getByRole("button", { name: "网页服务", exact: true }).click();
  await page.getByRole("menuitem", { name: "Muse", exact: true }).click();
  const panel = page.locator(".canvas-service-panel");
  await expect(panel).toBeVisible();
  await panel.evaluate(element => { (element as HTMLElement).style.width = "1400px"; });
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(1400);
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1000);
  const close = page.getByRole("button", { name: "关闭聊天窗口", exact: true });
  const bounds = (await close.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1000);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(700);
  await close.click();
  await expect(panel).toHaveCount(0);
});
