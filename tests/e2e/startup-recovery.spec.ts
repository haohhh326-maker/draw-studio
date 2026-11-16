import { expect, test } from "@playwright/test";
import { openCanvasAddMenu } from "./helpers";

test("a failed lazy activity bundle exposes recovery and reloads the saved project", async ({ page }) => {
  const blockedAssets: string[] = [];
  const activityBundle = /\/assets\/Activity-[^/]+\.js(?:\?|$)/;
  await page.route(activityBundle, route => {
    blockedAssets.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 503, contentType: "text/javascript", body: "" });
  });
  await page.route("**/api/runninghub/**", route => route.abort());
  await page.route(/https:\/\/(?:www\.)?runninghub\.(?:cn|ai)\/.*/, route => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称").fill("Recoverable lazy activity");
  await page.getByRole("button", { name: "创建并打开" }).click();
  await openCanvasAddMenu(page, { x: 490, y: 234 });
  await page.getByRole("menuitem", { name: "文本" }).click();
  await page.getByLabel("文本内容", { exact: true }).fill("Unsaved note survives module recovery");
  await page.getByRole("button", { name: "历史", exact: true }).click();
  const recovery = page.getByRole("alert");
  await expect(recovery).toContainText("画布暂时无法显示");
  const retry = recovery.getByRole("button", { name: "重新加载", exact: true });
  await expect(retry).toBeVisible();
  expect(blockedAssets.length).toBeGreaterThan(0);
  expect([...new Set(blockedAssets)]).toHaveLength(1);
  await page.unroute(activityBundle);
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), retry.click()]);
  await expect(page.locator(".canvas-shell")).toBeVisible();
  await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue("Recoverable lazy activity");
  await expect(page.getByLabel("文本内容", { exact: true })).toHaveValue("Unsaved note survives module recovery");
  await page.getByRole("button", { name: "历史", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "生成历史", exact: true })).toBeVisible();
});

for (const { name, bundle } of [
  { name: "entry", bundle: /\/assets\/index-[^/]+\.js(?:\?|$)/ },
  { name: "shared canvas", bundle: /\/assets\/canvas-[^/]+\.js(?:\?|$)/ },
]) {
  test(`a failed ${name} bundle leaves a recovery control that can load the application`, async ({ page }) => {
    const blockedAssets: string[] = [];
    await page.route(bundle, route => {
      blockedAssets.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 503, contentType: "text/javascript", body: "" });
    });
    await page.route("**/api/runninghub/**", route => route.abort());
    await page.route(/https:\/\/(?:www\.)?runninghub\.(?:cn|ai)\/.*/, route => route.abort());
    await page.goto("/");
    await expect(page.getByRole("status")).toHaveText("页面资源加载失败，请重新加载。");
    const retry = page.getByRole("button", { name: "重新加载", exact: true });
    await expect(retry).toBeVisible();
    expect(blockedAssets.length).toBeGreaterThan(0);
    expect([...new Set(blockedAssets)]).toHaveLength(1);
    await page.unroute(bundle);
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), retry.click()]);
    await expect(page.getByRole("heading", { name: "最近项目", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "新建项目", exact: true })).toBeVisible();
  });
}
