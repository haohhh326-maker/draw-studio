import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { expect } from "@playwright/test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.resolve(projectRoot, "..", "packaged-desktop-verification");
const baseline = JSON.parse(await readFile(process.env.DRAW_STUDIO_SMOKE_PREVIOUS_REPORT ?? path.join(artifacts, "packaged-desktop-verification.json"), "utf8"));
const report = { cases: [], pageErrors: [], finished: false };
let application, page, originalName, originalBounds, originalTabs;
const addedTabs = [];

async function geometry() {
  return page.evaluate(() => {
    const box = selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const nav = document.querySelector(".canvas-tabs");
    const add = document.querySelector(".canvas-tab-add"), addRect = add.getBoundingClientRect();
    return { width: innerWidth, caption: box(".desktop-titlebar"), canvas: box(".canvas-shell"), background: box(".react-flow__background"),
      left: box(".project-section"), right: box(".top-actions"), add: box(".canvas-tab-add"),
      addHit: add.contains(document.elementFromPoint(addRect.left + addRect.width / 2, addRect.top + addRect.height / 2)),
      scrollLeft: nav.scrollLeft, scrollWidth: nav.scrollWidth, navWidth: nav.clientWidth,
      buttons: [...document.querySelectorAll(".top-actions .icon-button")].filter(button => button.getClientRects().length).map(button => ({ label: button.getAttribute("aria-label"), width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
      closeWidths: [...document.querySelectorAll(".canvas-tab .tab-close")].map(button => button.getBoundingClientRect().width) };
  });
}

async function checkLayout(name) {
  const state = await geometry(); report.cases.push({ name, ...state });
  assert(Math.abs(state.canvas.top - state.caption.bottom) < 1);
  assert(Math.abs(state.background.top - state.caption.bottom) < 1);
  assert(state.left.right < state.right.left);
  assert(state.right.right <= state.width && state.left.left >= 0);
  assert(state.addHit && state.add.right <= state.left.right);
  assert(state.closeWidths.every(width => Math.abs(width - 24) < 1));
  if (state.width <= 1200) assert(state.buttons.every(button => Math.abs(button.width - 30) < 1 && Math.abs(button.height - 30) < 1));
  await page.screenshot({ path: path.join(artifacts, `topbar-${name}.png`), scale: "css" });
}

async function showMuse() {
  await page.getByRole("button", { name: "网页服务", exact: true }).click();
  await page.getByRole("menuitem", { name: "Muse", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Muse 原聊天窗口", exact: true });
  await expect(panel.getByLabel("网页视图已打开", { exact: true })).toBeVisible();
  return panel;
}

try {
  const env = { ...process.env, DRAW_STUDIO_USER_DATA: baseline.userData, DRAW_STUDIO_PORT: String(baseline.port) };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: path.join(baseline.isolatedPackage, "Draw studio.exe"), env, timeout: 120000 });
  await application.evaluate(async ({ app, session }) => {
    await app.whenReady();
    for (const partition of [undefined, "persist:draw-studio-muse", "persist:draw-studio-deepseek"]) {
      const target = partition ? session.fromPartition(partition) : session.defaultSession;
      target.webRequest.onBeforeRequest((details, callback) => {
        const address = new URL(details.url);
        callback({ cancel: ["http:", "https:", "ws:", "wss:"].includes(address.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname) });
      });
    }
  });
  page = await application.firstWindow({ timeout: 120000 });
  page.on("pageerror", error => report.pageErrors.push(error.message));
  await page.waitForURL(`http://127.0.0.1:${baseline.port}/`);
  await page.route("**/api/muse/session", route => route.fulfill({ json: { status: "disconnected" } }));
  await page.locator(".project-card").click();
  await expect(page.locator(".canvas-shell")).toBeVisible();
  originalName = await page.getByLabel("项目名称", { exact: true }).inputValue();
  originalBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  originalTabs = await page.locator(".canvas-tab").evaluateAll(elements => elements.map(element => element.getAttribute("data-canvas-id")));
  report.frontend = await page.locator('script[type="module"][src]').getAttribute("src");

  const sourceId = await page.locator(".react-flow__node").first().getAttribute("data-id");
  const sourceNode = page.locator(`.react-flow__node[data-id="${sourceId}"]`);
  const nodeBefore = await sourceNode.boundingBox();
  await sourceNode.hover(); await page.mouse.down(); await page.mouse.move(nodeBefore.x + nodeBefore.width / 2 + 50, nodeBefore.y + nodeBefore.height / 2 + 20, { steps: 10 }); await page.mouse.up();
  const moved = await sourceNode.getAttribute("style");
  await showMuse();
  await page.locator(".canvas-tab.active > button").first().dblclick();
  const rename = page.getByRole("dialog", { name: "重命名画布", exact: true });
  await expect(rename).toBeVisible();
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    return main.contentView.children.filter(child => child.webContents && child.webContents.id !== main.webContents.id).length;
  })).toBe(0);
  await rename.getByRole("button", { name: "保存", exact: true }).focus();
  await page.keyboard.press("Delete"); await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.keyboard.press("Control+z"); await expect(sourceNode).toHaveAttribute("style", moved);
  await page.keyboard.press("Escape"); await expect(rename).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => Math.abs((await sourceNode.boundingBox()).x - nodeBefore.x)).toBeLessThan(2);
  await sourceNode.click();
  await page.keyboard.press("Delete");
  await expect(sourceNode).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(sourceNode).toHaveCount(1);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  report.renameModalGuards = true;

  const longName = "A deliberately long project name used only for native toolbar verification ".repeat(3);
  await page.getByLabel("项目名称", { exact: true }).fill(longName);
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveAttribute("title", longName);
  for (let index = 0; index < 7; index++) {
    await page.getByRole("button", { name: "新建画布", exact: true }).click();
    const active = page.locator(".canvas-tab.active");
    addedTabs.push(await active.getAttribute("data-canvas-id"));
    await active.locator("button").first().dblclick();
    await rename.getByLabel("画布名称", { exact: true }).fill("A long canvas label with descriptive content for native scrolling " + (index + 1));
    await rename.getByRole("button", { name: "保存", exact: true }).click();
    await expect(active.locator(".canvas-tab-label")).toHaveCSS("text-overflow", "ellipsis");
  }
  for (const width of [1600, 1000]) {
    await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width, height: 780 }), width);
    const contentWidth = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds().width);
    await expect.poll(async () => Math.abs(await page.evaluate(() => innerWidth) - contentWidth)).toBeLessThan(2);
    await checkLayout(String(width));
    const nav = page.locator(".canvas-tabs");
    await expect.poll(() => nav.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    const beforeScroll = await nav.evaluate(element => element.scrollLeft);
    await page.getByRole("button", { name: "查看前面的画布", exact: true }).click();
    await expect.poll(() => nav.evaluate(element => element.scrollLeft)).toBeLessThan(beforeScroll);
    await page.getByRole("button", { name: "查看后面的画布", exact: true }).click();
    await page.getByRole("button", { name: "网页服务", exact: true }).click();
    await expect(page.getByRole("menu", { name: "网页服务", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "网页服务", exact: true }).click();
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
  await checkLayout("maximized");
  await application.evaluate(({ BrowserWindow }) => { const main = BrowserWindow.getAllWindows()[0]; main.unmaximize(); main.setBounds({ x: 0, y: 0, width: 1600, height: 780 }); });
  const panel = await showMuse();
  const panelBefore = await panel.boundingBox();
  await page.mouse.move(panelBefore.x + panelBefore.width - 1, panelBefore.y + panelBefore.height - 1);
  await page.mouse.down(); await page.mouse.move(panelBefore.x + panelBefore.width - 200, panelBefore.y + panelBefore.height - 100, { steps: 10 }); await page.mouse.up();
  report.manualPanelWidth = await panel.evaluate(element => element.style.width);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1000, height: 760 }));
  await expect.poll(async () => {
    const close = await panel.getByRole("button", { name: "关闭聊天窗口", exact: true }).boundingBox();
    return close.x + close.width <= await page.evaluate(() => innerWidth);
  }).toBe(true);
  const panelNow = await panel.boundingBox(), topbar = await page.locator(".topbar").boundingBox();
  assert(panelNow.y >= topbar.y + topbar.height);
  await panel.getByRole("button", { name: "关闭聊天窗口", exact: true }).click();
  const state = await geometry();
  const x = (state.left.right + state.right.left) / 2, y = state.caption.bottom + 25;
  const canvasHit = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".react-flow"), { x, y });
  assert(canvasHit, "Empty toolbar space must pass pointer input to the canvas");
  const transform = await page.locator(".react-flow__viewport").getAttribute("style");
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + 35, { steps: 10 }); await page.mouse.up();
  await expect(page.locator(".react-flow__viewport")).not.toHaveAttribute("style", transform);
  report.emptyHeaderPanning = true;
  assert.deepEqual(report.pageErrors, []);
  report.finished = true;
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error); console.error(error); process.exitCode = 1;
} finally {
  if (page && originalName !== undefined) {
    try {
      const modal = page.getByRole("dialog", { name: "重命名画布", exact: true });
      if (await modal.count()) await page.keyboard.press("Escape");
      for (const id of [...addedTabs].reverse()) {
        const tab = page.locator(`.canvas-tab[data-canvas-id="${id}"]`);
        await tab.locator(".tab-close").scrollIntoViewIfNeeded(); await tab.locator(".tab-close").click();
      }
      await page.getByLabel("项目名称", { exact: true }).fill(originalName);
      await page.getByRole("button", { name: "保存项目", exact: true }).click();
      report.restoredTabs = await page.locator(".canvas-tab").evaluateAll(elements => elements.map(element => element.getAttribute("data-canvas-id")));
      assert.deepEqual(report.restoredTabs, originalTabs);
      if (originalBounds) await application.evaluate(({ BrowserWindow }, bounds) => { const main = BrowserWindow.getAllWindows()[0]; main.unmaximize(); main.setBounds(bounds); }, originalBounds);
    } catch (error) { report.cleanupFailure = String(error); process.exitCode = 1; report.finished = false; }
  }
  if (application) await application.close().catch(() => {});
  await writeFile(path.join(artifacts, "packaged-topbar-verification.json"), JSON.stringify(report, null, 2) + "\n");
}
