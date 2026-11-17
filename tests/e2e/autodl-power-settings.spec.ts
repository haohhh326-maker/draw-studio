import { expect, test, type Page } from "@playwright/test";
import type { AutoDLPowerStatus, AutoDLSettingsInput } from "../../src/autodl/types";

const endpoint = "https://AUTODL-UI-FIXTURE.example.test:443/comfy";
const normalizedEndpoint = new URL(endpoint).href.replace(/\/+$/, "");
const token = "isolated-autodl-ui-token";

async function openSettings(page: Page) {
  await page.route("**/api/muse/session", route => route.fulfill({ json: { status: "disconnected" } }));
  await page.route("**/api/runninghub/**", route => route.abort());
  await page.route(/https:\/\/(?:www\.)?runninghub\.(?:cn|ai)\/.*/, route => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("AutoDL 设置隔离测试");
  await page.getByRole("button", { name: "创建并打开", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "算力设置", exact: true });
  await settings.getByRole("tab", { name: "云端 ComfyUI", exact: true }).click();
  return { settings, power: settings.getByRole("region", { name: "AutoDL 自动开关机", exact: true }) };
}

async function savedBrowserData(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("clearframe-canvas", 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const request = database.transaction("records").objectStore("records").getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const connection = await new Promise<{ baseUrl: string; token: string; autodl?: { instanceUuid: string } }>((resolve, reject) => {
        const request = database.transaction("records").objectStore("records").get("connection");
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      return { connection, serialized: JSON.stringify([records, Object.entries(localStorage), Object.entries(sessionStorage)]) };
    } finally { database.close(); }
  });
}

test("AutoDL settings use the saved endpoint, enable in one save and keep the developer token out of browser storage", async ({ page }, testInfo) => {
  let status: AutoDLPowerStatus = { settings: { enabled: false, endpoint: "", instanceUuid: "", tokenConfigured: false },
    phase: "disabled", activeTasks: 0, pendingStop: false, message: "自动开关机未启用。" };
  const writes: AutoDLSettingsInput[] = [], commands: string[] = [];
  await page.route("**/__canvas/autodl/**", async route => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() === "POST") commands.push(command);
    if (command === "settings") {
      const input = route.request().postDataJSON() as AutoDLSettingsInput;
      writes.push(input);
      status = { ...status, settings: { enabled: input.enabled, endpoint: new URL(input.endpoint).href.replace(/\/+$/, ""), instanceUuid: input.instanceUuid,
        tokenConfigured: status.settings.tokenConfigured || !!input.apiToken }, phase: input.enabled ? "unknown" : "disabled", message: input.enabled ? "尚未检测实例状态。" : "自动开关机未启用。" };
    } else if (command === "check") status = { ...status, phase: "off", message: "配置校验通过，实例处于关机状态。" };
    else expect(command).toBe("status");
    await route.fulfill({ json: status });
  });
  const { settings, power } = await openSettings(page);
  const enable = power.getByRole("checkbox", { name: "启用 AutoDL 自动开关机", exact: true });
  await expect(enable).toBeEnabled();
  await settings.getByLabel("云端远程地址", { exact: true }).fill(endpoint);
  await expect(power.getByRole("button", { name: "保存设置", exact: true })).toBeDisabled();
  await expect(power).toContainText("请先保存上方远程连接");
  await settings.getByRole("button", { name: "保存到本机", exact: true }).click();
  await enable.check();
  await expect(power).toContainText("配置已修改，保存后生效。");
  await power.getByLabel("AutoDL 实例 ID", { exact: true }).fill("pro-isolated-instance");
  const password = power.getByLabel("AutoDL 开发者 Token", { exact: true });
  await expect(password).toHaveAttribute("type", "password");
  await expect(power.getByRole("link", { name: "获取开发者 Token", exact: true })).toHaveAttribute("href", "https://www.autodl.com/console/center/settings/token");
  await password.fill(token);
  await power.getByRole("button", { name: "保存并校验", exact: true }).click();
  await expect(power.getByRole("status", { name: "AutoDL 电源状态", exact: true })).toContainText("实例已关机");
  expect(commands).toEqual(["settings", "check"]);
  expect(writes).toEqual([{ enabled: true, endpoint, instanceUuid: "pro-isolated-instance", apiToken: token }]);
  await expect(password).toHaveValue("");
  await expect(password).toHaveAttribute("placeholder", "已保存，留空保留");
  await expect.poll(async () => (await savedBrowserData(page)).connection?.autodl).toEqual({ instanceUuid: "pro-isolated-instance" });
  expect((await savedBrowserData(page)).connection?.baseUrl).toBe(endpoint);
  expect(status.settings.endpoint).toBe(normalizedEndpoint);
  await expect(power).not.toContainText("AutoDL 配置尚未绑定当前远程连接");
  expect((await savedBrowserData(page)).serialized).not.toContain(token);
  expect(await page.content()).not.toContain(token);
  await power.screenshot({ path: testInfo.outputPath("autodl-power-settings.png") });
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "云端 ComfyUI", exact: true }).click();
  const reopened = page.getByRole("region", { name: "AutoDL 自动开关机", exact: true });
  await expect(reopened.getByRole("checkbox", { name: "启用 AutoDL 自动开关机", exact: true })).toBeChecked();
  await expect(reopened.getByLabel("AutoDL 开发者 Token", { exact: true })).toHaveValue("");
  await reopened.getByRole("button", { name: "保存并校验", exact: true }).click();
  await expect.poll(() => commands).toEqual(["settings", "check", "settings", "check"]);
  expect(writes[1]).toEqual({ enabled: true, endpoint, instanceUuid: "pro-isolated-instance" });
  expect((await savedBrowserData(page)).serialized).not.toContain(token);
  await reopened.getByRole("checkbox", { name: "启用 AutoDL 自动开关机", exact: true }).uncheck();
  await expect(reopened).toContainText("配置已修改，保存后生效。");
  await reopened.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(reopened.getByRole("status", { name: "AutoDL 电源状态", exact: true })).toContainText("未启用");
  await expect(reopened.getByRole("button", { name: "保存设置", exact: true })).toBeEnabled();
  expect(commands).toEqual(["settings", "check", "settings", "check", "settings"]);
  expect(writes[2]).toEqual({ enabled: false, endpoint, instanceUuid: "pro-isolated-instance" });
  await expect.poll(async () => (await savedBrowserData(page)).connection?.autodl).toBeUndefined();
  await expect(reopened.getByRole("alert")).toHaveCount(0);
});

test("AutoDL shows shutdown as unconfirmed until a retry confirms the instance is off", async ({ page }) => {
  let status: AutoDLPowerStatus = { settings: { enabled: true, endpoint, instanceUuid: "pro-pending-stop-instance", tokenConfigured: true },
    phase: "error", activeTasks: 0, pendingStop: true, message: "关机请求尚未确认。", error: "关机请求失败。" };
  let retries = 0;
  const commands: string[] = [];
  await page.route("**/__canvas/autodl/**", async route => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() === "POST") commands.push(command);
    if (command === "retry-shutdown") {
      retries++;
      if (retries === 1) { await route.fulfill({ status: 503, json: { error: "关机尚未确认，请重试。" } }); return; }
      status = { ...status, phase: "off", pendingStop: false, error: undefined, message: "已确认实例关机。" };
    } else expect(command).toBe("status");
    await route.fulfill({ json: status });
  });
  const { power } = await openSettings(page);
  const state = power.getByRole("status", { name: "AutoDL 电源状态", exact: true });
  await expect(state).toContainText("关机尚未确认");
  const enable = power.getByRole("checkbox", { name: "启用 AutoDL 自动开关机", exact: true });
  await expect(enable).toBeDisabled();
  await expect(enable).toHaveAttribute("title", "请等待所有任务结束并确认关机后再更改。");
  await expect(state).not.toContainText("实例已关机");
  await expect(power).toContainText("AutoDL 配置尚未绑定当前远程连接");
  await power.getByRole("button", { name: "重试关机", exact: true }).click();
  await expect(power.getByRole("alert")).toHaveText("关机尚未确认，请重试。");
  await expect(state).toContainText("关机尚未确认");
  await power.getByRole("button", { name: "重试关机", exact: true }).click();
  await expect(state).toContainText("实例已关机");
  await expect(enable).toBeEnabled();
  await expect(power.getByRole("button", { name: "重试关机", exact: true })).toHaveCount(0);
  await expect(power.getByRole("alert")).toHaveCount(0);
  expect(commands).toEqual(["retry-shutdown", "retry-shutdown"]);
  expect((await savedBrowserData(page)).connection?.autodl).toBeUndefined();
});
