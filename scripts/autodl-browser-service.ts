import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { runAutoDLCommand, type AutoDLWebsiteFailureCode, type AutoDLWebsiteOperation, type AutoDLWebsiteResult } from "../browser-extensions/autodl/autodl-page.js";
import type { AutoDLAccountSession, AutoDLInstancesResult } from "../src/autodl/types";
import { AutoDLBridgeError, formatAutoDLDiagnostics } from "./autodl-extension-broker";

const origin = "https://www.autodl.art";
const deploymentUrl = origin + "/app/deploy";
const loginRequired = "请在独立打开的 AutoDL.Art 官网窗口登录，然后回到画布。";
const disconnected = "请点击「连接 AutoDL」，在独立官网窗口登录。";
type Credentials = { instanceUuid: string };
type BrowserSession = { context: BrowserContext; visible: boolean; loginPage?: Page };

const failureMessages: Record<AutoDLWebsiteFailureCode, string> = {
  NO_AUTODL_TAB: "AutoDL.Art 控制台页面尚未就绪，请在独立官网窗口确认登录状态。",
  CONTRACT_ERROR: "AutoDL.Art 返回了无法识别的结果，请确认官网实例状态。",
  LOGIN_REQUIRED: loginRequired,
  NETWORK_ERROR: "本机浏览器暂时无法连接 AutoDL.Art，请检查网络。",
  POWER_UNKNOWN: "AutoDL.Art 未确认开关机结果。",
  ACCOUNT_PREREQUISITE: "AutoDL.Art 账号尚未满足操作条件，请在官网处理。",
  INSUFFICIENT_BALANCE: "AutoDL.Art 账户可用余额不足以开机。请在官网钱包充值后重新生成。",
  INSTANCE_EXPIRED: "AutoDL.Art 实例已到期。请在官网续费或转为按量计费后重新生成。",
  NO_GPU_CAPACITY: "当前算力规格暂无库存，请稍后重试。",
  POWER_STATE_CONFLICT: "AutoDL.Art 实例状态已变化，需要核对实际状态。",
  POWER_REJECTED: "AutoDL.Art 未接受开关机请求，请在官网核对实例状态。",
  COMMAND_EXPIRED: "开关机请求已过期，请重试。",
  INSTANCE_NOT_FOUND: "当前 AutoDL.Art 账号下没有找到该实例。",
};
const definitiveFailures = new Set<AutoDLWebsiteFailureCode>([
  "LOGIN_REQUIRED", "NO_AUTODL_TAB", "INSTANCE_NOT_FOUND", "POWER_REJECTED",
  "ACCOUNT_PREREQUISITE", "COMMAND_EXPIRED", "NO_GPU_CAPACITY", "INSUFFICIENT_BALANCE", "INSTANCE_EXPIRED",
]);

function isDeploymentPage(page: Page): boolean {
  try {
    const url = new URL(page.url());
    return !page.isClosed() && url.origin === origin && url.pathname.replace(/\/$/, "") === "/app/deploy";
  } catch { return false; }
}

function exactPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function commandError(operation: AutoDLWebsiteOperation, reply: Extract<AutoDLWebsiteResult, { ok: false }>) {
  const code = Object.hasOwn(failureMessages, reply.errorCode) ? reply.errorCode : "CONTRACT_ERROR";
  const action = operation === "power-on" ? "启动 AutoDL 失败：" : operation === "power-off" ? "关闭 AutoDL 失败：" : "";
  const status = code === "LOGIN_REQUIRED" ? 401 : code === "INSTANCE_NOT_FOUND" ? 404 : 502;
  const dispatched = (operation === "power-on" || operation === "power-off")
    && code !== "LOGIN_REQUIRED" && code !== "NO_AUTODL_TAB" && code !== "COMMAND_EXPIRED";
  const error = new AutoDLBridgeError(action + failureMessages[code], status, code, dispatched, definitiveFailures.has(code), reply);
  const diagnostics = formatAutoDLDiagnostics(error);
  if (diagnostics) error.message = error.message.replace(/。$/, "") + diagnostics + "。";
  return error;
}

async function bounded<T>(work: Promise<T>, timeout: number, error: AutoDLBridgeError): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(error), timeout);
      timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** The browser owns the local sign-in state; only sanitized instance results cross into the service. */
export class AutoDLBrowserService {
  private operations: Promise<void> = Promise.resolve();
  private active?: BrowserSession;
  private cachedList?: { value: AutoDLInstancesResult; until: number };
  private listing?: Promise<AutoDLInstancesResult>;
  private closed = false;
  private closing?: Promise<void>;
  private readonly profile: string;
  constructor(private readonly root: string) {
    this.profile = path.join(root, ".cache", "autodl-power", "browser-profile");
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operations.then(work);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }

  private async profileExists(): Promise<boolean> {
    try { return (await fs.stat(this.profile)).isDirectory(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new AutoDLBridgeError("无法读取本机 AutoDL.Art 专用浏览器目录。");
    }
  }

  private async profilePath() {
    const canonicalRoot = await fs.realpath(this.root);
    const expected = path.join(canonicalRoot, ".cache", "autodl-power", "browser-profile");
    // An alias of the workspace itself is safe; links inside the workspace
    // must not redirect this browser to the user's ordinary browser profile.
    for (const directory of [path.dirname(path.dirname(expected)), path.dirname(expected), expected]) {
      await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (!exactPath(await fs.realpath(directory), directory) || !(await fs.stat(directory)).isDirectory())
        throw new AutoDLBridgeError("AutoDL.Art 专用浏览器目录必须位于本机画布的缓存目录内。");
    }
    return expected;
  }

  private async launch(visible: boolean): Promise<BrowserSession> {
    if (this.closed) throw new AutoDLBridgeError("AutoDL.Art 本机浏览器服务已关闭。", 503, "BRIDGE_UNAVAILABLE", false);
    const previous = this.active;
    if (previous && (!visible || previous.visible) && previous.context.browser()?.isConnected() !== false) return previous;
    if (!visible && !await this.profileExists())
      throw new AutoDLBridgeError(disconnected, 503, "BRIDGE_UNAVAILABLE", false);
    this.active = undefined;
    await previous?.context.close().catch(() => {});
    let profile: string;
    try { profile = await this.profilePath(); }
    catch (error) {
      if (error instanceof AutoDLBridgeError) throw error;
      throw new AutoDLBridgeError("无法准备 AutoDL.Art 专用浏览器目录。", 503, "BRIDGE_UNAVAILABLE", false);
    }
    const options = { headless: !visible, chromiumSandbox: true, viewport: visible ? null : { width: 1280, height: 800 }, timeout: 10_000 };
    const executablePath = process.env.DRAW_STUDIO_BROWSER_EXECUTABLE?.trim();
    let context: BrowserContext;
    try {
      if (executablePath) context = await chromium.launchPersistentContext(profile, { ...options, executablePath });
      else {
        try { context = await chromium.launchPersistentContext(profile, { ...options, channel: process.platform === "win32" ? "msedge" : "chrome" }); }
        catch { context = await chromium.launchPersistentContext(profile, options); }
      }
    } catch {
      throw new AutoDLBridgeError("无法启动 AutoDL.Art 专用浏览器，请确认本机浏览器可用后重试。", 503, "BRIDGE_UNAVAILABLE", false);
    }
    if (this.closed) {
      await context.close().catch(() => {});
      throw new AutoDLBridgeError("AutoDL.Art 本机浏览器服务已关闭。", 503, "BRIDGE_UNAVAILABLE", false);
    }
    const session = { context, visible };
    this.active = session;
    context.on("close", () => {
      if (this.active === session) {
        this.active = undefined;
        this.cachedList = undefined;
      }
    });
    return session;
  }

  private async navigate(page: Page) {
    try { await page.goto(deploymentUrl, { waitUntil: "domcontentloaded", timeout: 12_000 }); }
    catch {
      if (!isDeploymentPage(page))
        throw new AutoDLBridgeError("无法打开 AutoDL.Art 官网，请检查网络后重试。", 503, "NETWORK_ERROR", false);
    }
  }

  async openAccount(): Promise<AutoDLAccountSession> {
    return this.enqueue(async () => {
      const session = await this.launch(true);
      this.cachedList = undefined;
      const pages = session.context.pages().filter(page => !page.isClosed());
      // A sign-in dialog can be in a separate tab. Do not replace a navigation
      // or close its context merely because the user clicks the button again.
      const previousLogin = session.loginPage?.isClosed() ? undefined : session.loginPage;
      const signInPopup = previousLogin && [...pages].reverse().find(page =>
        page !== previousLogin && page.url().startsWith("https:") && !isDeploymentPage(page));
      const page = signInPopup ?? previousLogin ?? pages.find(isDeploymentPage)
        ?? pages.find(candidate => candidate.url() === "about:blank") ?? await session.context.newPage();
      session.loginPage = page;
      if ((!previousLogin || page.url() === "about:blank") && !isDeploymentPage(page)) await this.navigate(page);
      try { await page.bringToFront(); }
      catch { throw new AutoDLBridgeError("AutoDL.Art 官网窗口已关闭，请重新连接。", 503, "BRIDGE_UNAVAILABLE", false); }
      return { status: "login-required", message: "AutoDL.Art 官网窗口已打开，登录后画布会自动确认连接。" };
    });
  }

  private async deploymentPage(session: BrowserSession): Promise<Page> {
    const pages = session.context.pages().filter(page => !page.isClosed());
    const deployment = pages.find(isDeploymentPage);
    if (deployment) return deployment;
    // Some sign-in methods return to the official homepage. Check only whether
    // an official page has a session, and never inspect or replace its sign-in form.
    let page: Page;
    if (session.visible) {
      const official = pages.find(candidate => {
        try { return new URL(candidate.url()).origin === origin && !/(?:^|\/)(?:login|signin|oauth)(?:\/|$)/i.test(new URL(candidate.url()).pathname); }
        catch { return false; }
      });
      const signedIn = official && await official.evaluate(() => location.origin === "https://www.autodl.art" && !!localStorage.getItem("token")).catch(() => false);
      if (!signedIn) throw new AutoDLBridgeError(loginRequired, 401, "LOGIN_REQUIRED", false, true);
      page = await session.context.newPage();
    } else {
      page = pages.find(candidate => candidate.url() === "about:blank") ?? pages[0] ?? await session.context.newPage();
    }
    await this.navigate(page);
    if (isDeploymentPage(page)) return page;
    throw new AutoDLBridgeError(loginRequired, 401, "LOGIN_REQUIRED", false, true);
  }

  private call(operation: AutoDLWebsiteOperation, instanceUuid: string | null = null) {
    return this.enqueue(async () => {
      const session = await this.launch(false);
      let page: Page;
      try { page = await this.deploymentPage(session); }
      catch (error) {
        if (error instanceof AutoDLBridgeError) throw error;
        throw new AutoDLBridgeError("AutoDL.Art 控制台暂不可用，请检查独立官网窗口。", 503, "NO_AUTODL_TAB", false);
      }
      const mutation = operation === "power-on" || operation === "power-off";
      let reply: AutoDLWebsiteResult;
      try {
        // evaluate() accepts one argument for a function. The shared website
        // command is self-contained and currently accepts three arguments.
        const expression = "(" + runAutoDLCommand.toString() + ")(" + JSON.stringify(operation) + ","
          + JSON.stringify(instanceUuid) + "," + (Date.now() + 45_000) + ")";
        reply = await bounded(page.evaluate<AutoDLWebsiteResult>(expression), 28_000,
          new AutoDLBridgeError("等待 AutoDL.Art 控制台响应超时。", 504, mutation ? "POWER_UNKNOWN" : "NETWORK_ERROR", mutation));
      } catch (error) {
        if (error instanceof AutoDLBridgeError) throw error;
        throw new AutoDLBridgeError(mutation ? "开关机请求结果尚未确认，请等待核对实例状态。" : "暂时无法读取 AutoDL.Art 实例状态。",
          502, mutation ? "POWER_UNKNOWN" : "NETWORK_ERROR", mutation);
      }
      if (!reply || typeof reply.ok !== "boolean")
        throw new AutoDLBridgeError(failureMessages.CONTRACT_ERROR, 502, "CONTRACT_ERROR", mutation);
      if (!reply.ok) throw commandError(operation, reply);
      return reply.value;
    });
  }

  async session(): Promise<AutoDLAccountSession> {
    try {
      if (!this.active && !await this.profileExists()) return { status: "disconnected", message: disconnected };
      await this.instances();
      return { status: "connected", message: "AutoDL.Art 官网账号已连接。" };
    } catch (error) {
      if (error instanceof AutoDLBridgeError) {
        const status = error.code === "LOGIN_REQUIRED" || error.code === "NO_AUTODL_TAB" ? "login-required" : error.code === "BRIDGE_UNAVAILABLE" ? "disconnected" : "error";
        return { status, message: error.message };
      }
      return { status: "error", message: "无法确认 AutoDL.Art 官网登录状态，请重新连接。" };
    }
  }

  async instances(): Promise<AutoDLInstancesResult> {
    if (this.cachedList && this.cachedList.until > Date.now()) return structuredClone(this.cachedList.value);
    if (!this.listing) {
      this.listing = this.call("list").then(result => {
        if (!result || !("instances" in result) || !Array.isArray(result.instances))
          throw new AutoDLBridgeError(failureMessages.CONTRACT_ERROR, 502, "CONTRACT_ERROR", false);
        this.cachedList = { value: result, until: Date.now() + 3_000 };
        return result;
      }).finally(() => { this.listing = undefined; });
    }
    return structuredClone(await this.listing);
  }

  async status(credentials: Credentials): Promise<string> {
    const value = await this.call("status", credentials.instanceUuid);
    if (value && "status" in value && typeof value.status === "string") return value.status;
    throw new AutoDLBridgeError(failureMessages.CONTRACT_ERROR, 502, "CONTRACT_ERROR", false);
  }

  async checkStartup(credentials: Credentials): Promise<string> {
    const value = await this.call("preflight", credentials.instanceUuid);
    if (value && "status" in value && typeof value.status === "string") return value.status;
    throw new AutoDLBridgeError(failureMessages.CONTRACT_ERROR, 502, "CONTRACT_ERROR", false);
  }

  async powerOn(credentials: Credentials): Promise<void> { await this.mutate("power-on", credentials); }
  async powerOff(credentials: Credentials): Promise<void> { await this.mutate("power-off", credentials); }
  private async mutate(operation: "power-on" | "power-off", credentials: Credentials): Promise<void> {
    const value = await this.call(operation, credentials.instanceUuid);
    if (!value || !("accepted" in value) || value.accepted !== true)
      throw new AutoDLBridgeError(failureMessages.POWER_UNKNOWN, 502, "POWER_UNKNOWN", true);
    this.cachedList = undefined;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.enqueue(async () => {
      const current = this.active;
      this.active = undefined;
      this.cachedList = undefined;
      await current?.context.close().catch(() => {});
    });
    return this.closing;
  }
}
