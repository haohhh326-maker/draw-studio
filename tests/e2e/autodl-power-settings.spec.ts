import { expect, test, type Page } from "@playwright/test";
import type { AutoDLAccountSession, AutoDLPowerStatus, AutoDLSettingsInput } from "../../src/autodl/types";

const endpoint = "https://AUTODL-UI-FIXTURE.example.test:443/comfy";
const normalizedEndpoint = new URL(endpoint).href.replace(/\/+$/, "");
async function openSettings(page: Page) {
  await page.route("**/api/muse/session", route => route.fulfill({ json: { status: "disconnected" } }));
  await page.route("**/api/runninghub/**", route => route.abort());
  await page.route(/https:\/\/(?:www\.)?runninghub\.(?:cn|ai)\/.*/, route => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("AutoDL 官网登录隔离测试");
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
      const connection = await new Promise<{ baseUrl: string; autodl?: { instanceUuid: string } }>((resolve, reject) => {
        const request = database.transaction("records").objectStore("records").get("connection");
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      return { connection };
    } finally { database.close(); }
  });
}

test("opens the official login and validates a normalized binding after the session is ready", async ({ page }, testInfo) => {
  let status: AutoDLPowerStatus = { settings: { enabled: false, endpoint: "", instanceUuid: "", tokenConfigured: false },
    phase: "disabled", activeTasks: 0, pendingStop: false, message: "自动开关机未启用。" };
  let account: AutoDLAccountSession = { status: "disconnected", message: "请连接 AutoDL.Art。" };
  const writes: AutoDLSettingsInput[] = [], commands: string[] = [];
  const comfyProbes: string[] = [];
  await page.route("https://autodl-ui-fixture.example.test/**", route => { comfyProbes.push(route.request().url()); return route.abort(); });
  let confirmFirstCheck: (() => void) | undefined;
  let holdFirstCheck = true, failNextCheck = false;
  await page.route("**/__canvas/autodl/**", async route => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() === "POST") commands.push(command);
    if (command === "session") { await route.fulfill({ json: account }); return; }
    if (command === "open-account") {
      expect(route.request().postDataJSON()).toEqual({});
      account = { status: "login-required", message: "请在官网窗口登录。" };
      await route.fulfill({ json: account }); return;
    }
    if (command === "instances") {
      expect(account.status).toBe("connected");
      await route.fulfill({ json: { instances: [{ instanceUuid: "pro-isolated-instance", name: "ComfyUI 工作站", status: "shutdown" }] } }); return;
    }
    if (command === "settings") {
      const input = route.request().postDataJSON() as AutoDLSettingsInput;
      expect(Object.keys(input).sort()).toEqual(["enabled", "endpoint", "instanceUuid"]);
      writes.push(input);
      status = { ...status, settings: { ...input, endpoint: new URL(input.endpoint).href.replace(/\/+$/, ""), tokenConfigured: false },
        phase: input.enabled ? "unknown" : "disabled", message: input.enabled ? "尚未检测实例状态。" : "自动开关机未启用。" };
    } else if (command === "check") {
      if (holdFirstCheck) { holdFirstCheck = false; await new Promise<void>(resolve => { confirmFirstCheck = resolve; }); }
      if (failNextCheck) { failNextCheck = false; await route.fulfill({ status: 503, json: { error: "实例状态校验失败，请重试保存并校验。" } }); return; }
      status = { ...status, phase: "off", message: "配置校验通过，实例处于关机状态。" };
    } else expect(command).toBe("status");
    await route.fulfill({ json: status });
  });
  const { settings, power } = await openSettings(page);
  await expect(power.locator('input[type="password"]')).toHaveCount(0);
  await expect(power).not.toContainText("开发者 Token");
  await expect(power.getByRole("link", { name: "下载浏览器扩展", exact: true })).toHaveCount(0);
  const enable = power.getByRole("checkbox", { name: "启用 AutoDL 自动开关机", exact: true });
  await expect(enable).toBeEnabled();
  await settings.getByLabel("云端远程地址", { exact: true }).fill(endpoint);
  await expect(power.getByRole("button", { name: "保存设置", exact: true })).toBeDisabled();
  await expect(power).toContainText("请先保存上方远程连接");
  await settings.getByRole("button", { name: "保存到本机", exact: true }).click();
  await enable.check();
  await expect(power.getByRole("button", { name: "保存并校验", exact: true })).toBeDisabled();
  await power.getByRole("button", { name: "连接 AutoDL", exact: true }).click();
  await expect(power.getByRole("status", { name: "AutoDL 浏览器连接状态", exact: true })).toContainText("等待官网登录");
  await expect(power.getByRole("textbox")).toHaveCount(0);
  account = { status: "connected", message: "已连接 AutoDL.Art 账号。" };
  await expect(power.getByRole("status", { name: "AutoDL 浏览器连接状态", exact: true })).toContainText("已连接 AutoDL", { timeout: 10000 });
  const instances = power.getByRole("combobox", { name: "AutoDL 已有实例", exact: true });
  await expect(instances).toBeEnabled();
  await expect(instances.getByRole("option", { name: /ComfyUI 工作站/ })).toHaveCount(1);
  await instances.selectOption("pro-isolated-instance");
  await power.getByRole("button", { name: "保存并校验", exact: true }).click();
  await expect.poll(() => !!confirmFirstCheck).toBe(true);
  expect((await savedBrowserData(page)).connection?.autodl).toBeUndefined();
  confirmFirstCheck!();
  await expect(power.getByRole("status", { name: "AutoDL 电源状态", exact: true })).toContainText("实例已关机");
  await expect.poll(async () => (await savedBrowserData(page)).connection?.autodl).toEqual({ instanceUuid: "pro-isolated-instance" });
  expect(writes).toEqual([{ enabled: true, endpoint, instanceUuid: "pro-isolated-instance" }]);
  expect(status.settings.endpoint).toBe(normalizedEndpoint);
  expect((await savedBrowserData(page)).connection?.baseUrl).toBe(endpoint);
  await expect(power).not.toContainText("AutoDL 配置尚未绑定当前远程连接");
  await settings.getByRole("button", { name: "保存并检测", exact: true }).click();
  await expect(settings.locator(".compute-settings-message")).toHaveText("实例已关机，生成时自动启动。");
  await expect(settings.locator(".compute-settings-message")).not.toContainText("连接失败");
  expect(comfyProbes).toEqual([]);
  await power.screenshot({ path: testInfo.outputPath("autodl-power-settings.png") });
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "云端 ComfyUI", exact: true }).click();
  const reopened = page.getByRole("region", { name: "AutoDL 自动开关机", exact: true });
  await expect(reopened.getByRole("checkbox", { name: "启用 AutoDL 自动开关机", exact: true })).toBeChecked();
  await expect(reopened.getByRole("combobox", { name: "AutoDL 已有实例", exact: true })).toBeEnabled();
  expect(commands).toEqual(["open-account", "settings", "check", "check"]);
  await reopened.getByRole("checkbox", { name: "启用 AutoDL 自动开关机", exact: true }).uncheck();
  await reopened.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(reopened.getByRole("status", { name: "AutoDL 电源状态", exact: true })).toContainText("未启用");
  await expect.poll(async () => (await savedBrowserData(page)).connection?.autodl).toBeUndefined();
  expect(commands).toEqual(["open-account", "settings", "check", "check", "settings"]);
  await reopened.getByRole("checkbox", { name: "启用 AutoDL 自动开关机", exact: true }).check();
  failNextCheck = true;
  await reopened.getByRole("button", { name: "保存并校验", exact: true }).click();
  await expect(reopened.getByRole("alert")).toHaveText("实例状态校验失败，请重试保存并校验。");
  expect((await savedBrowserData(page)).connection?.autodl).toBeUndefined();
  await reopened.getByRole("button", { name: "保存并校验", exact: true }).click();
  await expect.poll(async () => (await savedBrowserData(page)).connection?.autodl).toEqual({ instanceUuid: "pro-isolated-instance" });
  await expect(reopened.getByRole("alert")).toHaveCount(0);
  expect(commands).toEqual(["open-account", "settings", "check", "check", "settings", "settings", "check", "settings", "check"]);
});

test("keeps shutdown unconfirmed through a browser login expiry and allows login repair before a shutdown retry", async ({ page }) => {
  let status: AutoDLPowerStatus = { settings: { enabled: true, endpoint, instanceUuid: "pro-pending-stop-instance", tokenConfigured: false },
    phase: "error", activeTasks: 0, pendingStop: true, message: "关机请求尚未确认。", error: "关机请求失败。" };
  let account: AutoDLAccountSession = { status: "connected", message: "已连接浏览器账号。" };
  let retries = 0;
  const commands: string[] = [];
  await page.route("**/__canvas/autodl/**", async route => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() === "POST") commands.push(command);
    if (command === "session") { await route.fulfill({ json: account }); return; }
    if (command === "instances") { await route.fulfill({ json: { instances: [{ instanceUuid: "pro-pending-stop-instance", name: "待关机工作站", status: "running" }] } }); return; }
    if (command === "open-account") { await route.fulfill({ json: account }); return; }
    if (command === "retry-shutdown") {
      retries++;
      if (retries === 1) { await route.fulfill({ status: 503, json: { error: "关机尚未确认，请重试。" } }); return; }
      status = { ...status, phase: "off", pendingStop: false, error: undefined, message: "已确认实例关机。" };
    } else expect(command).toBe("status");
    await route.fulfill({ json: status });
  });
  const { power } = await openSettings(page);
  const state = power.getByRole("status", { name: "AutoDL 电源状态", exact: true });
  const browser = power.getByRole("status", { name: "AutoDL 浏览器连接状态", exact: true });
  const enable = power.getByRole("checkbox", { name: "启用 AutoDL 自动开关机", exact: true });
  const instances = power.getByRole("combobox", { name: "AutoDL 已有实例", exact: true });
  await expect(state).toContainText("关机尚未确认");
  await expect(enable).toBeDisabled(); await expect(instances).toBeDisabled();
  await expect(enable).toHaveAttribute("title", "请等待所有任务结束并确认关机后再更改。");
  await power.getByRole("button", { name: "重试关机", exact: true }).click();
  await expect(power.getByRole("alert")).toHaveText("关机尚未确认，请重试。");
  account = { status: "login-required", message: "AutoDL.Art 登录已失效，请在浏览器重新登录。" };
  await expect(browser).toContainText("登录已失效", { timeout: 10000 });
  await expect(state).not.toContainText("实例已关机");
  await expect(power.getByRole("button", { name: "保存并校验", exact: true })).toBeDisabled();
  await power.getByRole("button", { name: "连接 AutoDL", exact: true }).click();
  await expect.poll(() => commands.includes("open-account")).toBe(true);
  account = { status: "connected", message: "官网账号已重新连接。" };
  await expect(browser).toContainText("已连接 AutoDL", { timeout: 10000 });
  await power.getByRole("button", { name: "重试关机", exact: true }).click();
  await expect(state).toContainText("实例已关机");
  await expect(enable).toBeEnabled(); await expect(instances).toBeEnabled();
  await expect(power.getByRole("button", { name: "重试关机", exact: true })).toHaveCount(0);
  await expect(power.getByRole("alert")).toHaveCount(0);
  expect(commands).toEqual(["retry-shutdown", "open-account", "retry-shutdown"]);
  expect((await savedBrowserData(page)).connection?.autodl).toBeUndefined();
  status = { ...status, phase: "error", pendingStop: false, error: "官网拒绝开机，请确认账号权限。", message: "实例仍处于关机状态。" };
  await expect(power.getByRole("alert")).toHaveText("官网拒绝开机，请确认账号权限。", { timeout: 10000 });
  await expect(power.getByRole("button", { name: "重试关机", exact: true })).toHaveCount(0);
});

test("preselects the unique official endpoint instance after login without changing explicit choices or enabling power automatically", async ({ page }) => {
  const officialEndpoint = "https://u1000000-112233aabbcc.westd.seetacloud.com:8443";
  const matchingUuid = "pro-112233aabbcc", otherUuid = "pro-deadbeefabcdef";
  let status: AutoDLPowerStatus = { settings: { enabled: false, endpoint: officialEndpoint, instanceUuid: "", tokenConfigured: false },
    phase: "disabled", activeTasks: 0, pendingStop: false, message: "自动开关机未启用。" };
  let account: AutoDLAccountSession = { status: "disconnected", message: "请连接 AutoDL.Art。" };
  const commands: string[] = [];
  await page.route("**/__canvas/autodl/**", async route => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() === "POST") commands.push(command);
    if (command === "session") { await route.fulfill({ json: account }); return; }
    if (command === "open-account") {
      account = { status: "login-required", message: "请在官网窗口登录。" };
      await route.fulfill({ json: account }); return;
    }
    if (command === "instances") { await route.fulfill({ json: { instances: [
      { instanceUuid: otherUuid, name: "其他工作站", status: "shutdown" },
      { instanceUuid: matchingUuid, name: "当前连接工作站", status: "shutdown" },
    ] } }); return; }
    if (command === "settings") {
      const input = route.request().postDataJSON() as AutoDLSettingsInput;
      status = { ...status, settings: { ...input, tokenConfigured: false }, phase: input.enabled ? "unknown" : "disabled" };
    } else if (command === "check") status = { ...status, phase: "off", message: "只读校验通过。" };
    else expect(command).toBe("status");
    await route.fulfill({ json: status });
  });
  const { settings, power } = await openSettings(page);
  const enable = power.getByRole("checkbox", { name: "启用 AutoDL 自动开关机", exact: true });
  await expect(enable).toBeEnabled();
  await settings.getByLabel("云端远程地址", { exact: true }).fill(officialEndpoint);
  await settings.getByRole("button", { name: "保存到本机", exact: true }).click();
  await power.getByRole("button", { name: "连接 AutoDL", exact: true }).click();
  await expect(power.getByRole("status", { name: "AutoDL 浏览器连接状态", exact: true })).toContainText("等待官网登录");
  account = { status: "connected", message: "已登录 AutoDL.Art。" };
  const instances = power.getByRole("combobox", { name: "AutoDL 已有实例", exact: true });
  await expect(instances).toHaveValue(matchingUuid, { timeout: 10000 });
  await expect(enable).not.toBeChecked();
  await expect(power).toContainText("需要自动开关机时，勾选“启用”并点击“保存并校验”");
  expect(commands).toEqual(["open-account"]);
  expect((await savedBrowserData(page)).connection?.autodl).toBeUndefined();
  await enable.check();
  await power.getByRole("button", { name: "保存并校验", exact: true }).click();
  await expect.poll(async () => (await savedBrowserData(page)).connection?.autodl).toEqual({ instanceUuid: matchingUuid });
  expect(commands).toEqual(["open-account", "settings", "check"]);

  await instances.selectOption(otherUuid);
  await power.getByRole("button", { name: "刷新实例", exact: true }).click();
  await expect(instances).toBeEnabled();
  await expect(instances).toHaveValue(otherUuid);
  await expect(power).toContainText("已保留你选择的实例");
  await instances.selectOption("");
  await power.getByRole("button", { name: "刷新实例", exact: true }).click();
  await expect(instances).toBeEnabled();
  await expect(instances).toHaveValue("");
  await enable.uncheck();
  await power.getByRole("button", { name: "刷新实例", exact: true }).click();
  await expect(power.getByRole("button", { name: "刷新实例", exact: true })).toBeEnabled();
  await expect(enable).not.toBeChecked();
  await expect(instances).toHaveValue("");
  expect(commands).toEqual(["open-account", "settings", "check"]);
});

test("shows an official window launch error and leaves the connection button available", async ({ page }) => {
  const commands: string[] = [];
  await page.route("**/__canvas/autodl/**", async route => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() === "POST") commands.push(command);
    if (command === "open-account") { await route.fulfill({ status: 503, json: { error: "无法打开 AutoDL.Art 官网窗口。" } }); return; }
    if (command === "session") { await route.fulfill({ json: { status: "disconnected", message: "尚未连接浏览器。" } }); return; }
    expect(command).toBe("status");
    await route.fulfill({ json: { settings: { enabled: false, endpoint: "", instanceUuid: "", tokenConfigured: false }, phase: "disabled", activeTasks: 0, pendingStop: false, message: "未启用。" } });
  });
  const { power } = await openSettings(page);
  await expect(power.getByRole("button", { name: "连接 AutoDL", exact: true })).toBeEnabled();
  await power.getByRole("button", { name: "连接 AutoDL", exact: true }).click();
  await expect(power.getByRole("alert", { name: "AutoDL 官网连接错误", exact: true })).toContainText("无法打开 AutoDL.Art 官网窗口。", { timeout: 5000 });
  await expect(power.getByRole("button", { name: "连接 AutoDL", exact: true })).toBeEnabled();
  await expect(power.getByRole("textbox")).toHaveCount(0);
  expect(commands).toEqual(["open-account"]);
});

test("ordinary ComfyUI connection detection still checks engine endpoints and reports invalid responses", async ({ page }) => {
  const probes: string[] = [], commands: string[] = [];
  await page.route("**/__canvas/autodl/**", async route => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() === "POST") commands.push(command);
    if (command === "session") { await route.fulfill({ json: { status: "disconnected", message: "未连接。" } }); return; }
    expect(command).toBe("status");
    await route.fulfill({ json: { settings: { enabled: false, endpoint: "", instanceUuid: "", tokenConfigured: false }, phase: "disabled", activeTasks: 0, pendingStop: false, message: "未启用。" } });
  });
  await page.route("https://ordinary-comfy-ui.example.test/**", route => { probes.push(new URL(route.request().url()).pathname); return route.fulfill({ json: {} }); });
  const { settings } = await openSettings(page);
  await settings.getByLabel("云端远程地址", { exact: true }).fill("https://ordinary-comfy-ui.example.test");
  await settings.getByRole("button", { name: "保存并检测", exact: true }).click();
  await expect(settings.locator(".compute-settings-message")).toContainText("连接失败");
  expect(probes.sort()).toEqual(["/queue", "/system_stats"]);
  expect(commands).toEqual([]);
});
