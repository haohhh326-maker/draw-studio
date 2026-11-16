import { chromium, type BrowserContext, type Page } from "playwright";
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { serviceDataRoot } from "./service-data-root";

const DEEPSEEK_URL = "https://chat.deepseek.com/";
const COMPOSER = 'textarea[placeholder*="DeepSeek" i]';
const ASSISTANT_CONTENT = ".ds-assistant-message-main-content";
type ImportedCookie = Parameters<BrowserContext["addCookies"]>[0][number];
type ImportedStorage = { name: string; value: string };
type ImportedSession = { cookies: ImportedCookie[]; origins: { origin: string; localStorage: ImportedStorage[] }[] };

/** Import only this service's own session data from the native child WebView. */
export function validateDeepSeekSessionImport(value: unknown): ImportedSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeepSeekBrowserError("DeepSeek 登录状态无效。");
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.cookies) || source.cookies.length > 256 || !Array.isArray(source.origins) || source.origins.length > 1)
    throw new DeepSeekBrowserError("DeepSeek 登录状态无效。");
  const cookies = source.cookies.map((item): ImportedCookie => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new DeepSeekBrowserError("DeepSeek Cookie 无效。");
    const cookie = item as Record<string, unknown>;
    if (typeof cookie.name !== "string" || !cookie.name || cookie.name.length > 256 || /[\r\n\0]/.test(cookie.name) ||
      typeof cookie.value !== "string" || cookie.value.length > 8192 || /[\r\n\0]/.test(cookie.value) ||
      !["deepseek.com", ".deepseek.com", "chat.deepseek.com", ".chat.deepseek.com"].includes(String(cookie.domain)) ||
      typeof cookie.path !== "string" || !cookie.path.startsWith("/") || cookie.path.length > 1024 || /[\r\n\0]/.test(cookie.path) ||
      cookie.expires !== undefined && (typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires) || cookie.expires < -1 || cookie.expires > 4102444800) ||
      cookie.httpOnly !== undefined && typeof cookie.httpOnly !== "boolean" ||
      cookie.secure !== undefined && typeof cookie.secure !== "boolean" ||
      cookie.sameSite !== undefined && !["Strict", "Lax", "None"].includes(String(cookie.sameSite)))
      throw new DeepSeekBrowserError("DeepSeek Cookie 无效。");
    return { name: cookie.name, value: cookie.value, domain: cookie.domain as string, path: cookie.path,
      ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
      ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
      ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
      ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite as "Strict" | "Lax" | "None" }) };
  });
  const origins = source.origins.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new DeepSeekBrowserError("DeepSeek 本地登录数据无效。");
    const origin = item as Record<string, unknown>;
    if (origin.origin !== "https://chat.deepseek.com" || !Array.isArray(origin.localStorage) || origin.localStorage.length > 256)
      throw new DeepSeekBrowserError("DeepSeek 本地登录数据无效。");
    return { origin: "https://chat.deepseek.com", localStorage: origin.localStorage.map(entry => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.name !== "string" || entry.name.length > 1024 ||
        typeof entry.value !== "string" || entry.value.length > 100_000)
        throw new DeepSeekBrowserError("DeepSeek 本地登录数据无效。");
      return { name: entry.name, value: entry.value };
    }) };
  });
  return { cookies, origins };
}
export function filterDeepSeekSessionExport(state: Awaited<ReturnType<BrowserContext["storageState"]>>): ImportedSession {
  return validateDeepSeekSessionImport({
    cookies: state.cookies.filter(cookie => ["deepseek.com", ".deepseek.com", "chat.deepseek.com", ".chat.deepseek.com"].includes(cookie.domain)),
    origins: state.origins.filter(origin => origin.origin === "https://chat.deepseek.com").map(origin => ({
      origin: origin.origin, localStorage: origin.localStorage,
    })),
  });
}

export type DeepSeekMessage = { role: "system" | "user" | "assistant"; content: string };
export type DeepSeekAttachment = { name: string; mimeType: "text/plain" | "text/markdown"; content: string };
export type WebOptimizationRequest = { prompt: string; attachments: DeepSeekAttachment[] };
export type DeepSeekSession = { status: "disconnected" | "login-required" | "connected"; message: string };
export type DeepSeekCompletion = {
  model: "deepseek-web";
  choices: [{ finish_reason: "stop"; message: { role: "assistant"; content: string } }];
};

export type DeepSeekViewInput =
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string };

export class DeepSeekBrowserError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const deepSeekDataRoot = () => path.join(serviceDataRoot(), "deepseek");

function isDeepSeekChat(url: string) {
  try { const parsed = new URL(url); return parsed.protocol === "https:" && parsed.hostname === "chat.deepseek.com"; }
  catch { return false; }
}

function isConversationUrl(url: string) {
  try { const parsed = new URL(url); return isDeepSeekChat(url) && /^\/a\/chat\/s\/[a-zA-Z0-9-]+$/.test(parsed.pathname); }
  catch { return false; }
}

export function sameDeepSeekConversation(left: string, right: string) {
  if (!isConversationUrl(left) || !isConversationUrl(right)) return false;
  return new URL(left).pathname === new URL(right).pathname;
}

type BrowserOperation = { page?: Page };

export function validateDeepSeekMessages(value: unknown): DeepSeekMessage[] {
  if (!Array.isArray(value) || !value.length || value.some(message =>
    !message || !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string"))
    throw new DeepSeekBrowserError("DeepSeek 优化消息无效。");
  const messages = value as DeepSeekMessage[];
  if (!messages.some(message => message.content.trim())) throw new DeepSeekBrowserError("需要输入待优化的提示词。");
  return messages;
}

/** The web chat has one composer, so preserve role boundaries in one visible message. */
export function deepSeekWebPrompt(messages: DeepSeekMessage[]): string {
  return messages.map(message => {
    const role = message.role === "system" ? "优化规则" : message.role === "assistant" ? "已有回复" : "待优化内容";
    return `【${role}】\n${message.content}`;
  }).join("\n\n");
}

export function validateWebOptimizationRequest(value: unknown): WebOptimizationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DeepSeekBrowserError("DeepSeek 优化请求无效。");
  const request = value as Partial<WebOptimizationRequest>;
  if (typeof request.prompt !== "string" || !request.prompt.trim())
    throw new DeepSeekBrowserError("需要输入待优化的提示词。");
  if (!Array.isArray(request.attachments) || request.attachments.some(file =>
    !file || typeof file.name !== "string" || !file.name.trim() ||
    path.basename(file.name) !== file.name ||
    !["text/plain", "text/markdown"].includes(file.mimeType) ||
    typeof file.content !== "string"))
    throw new DeepSeekBrowserError("DeepSeek 规则文件无效。");
  return request as WebOptimizationRequest;
}

function normalizeRequest(value: unknown): WebOptimizationRequest {
  return Array.isArray(value)
    ? { prompt: deepSeekWebPrompt(validateDeepSeekMessages(value)), attachments: [] }
    : validateWebOptimizationRequest(value);
}

/** The canvas may control only the existing DeepSeek page, with bounded input. */
export function validateDeepSeekViewInput(value: unknown): DeepSeekViewInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DeepSeekBrowserError("DeepSeek 画布输入无效。");
  const input = value as Record<string, unknown>;
  const coordinate = (number: unknown) => typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 8192;
  if (input.type === "click" && coordinate(input.x) && coordinate(input.y) &&
    (input.button === undefined || ["left", "right", "middle"].includes(String(input.button))))
    return input as DeepSeekViewInput;
  if (input.type === "wheel" && coordinate(input.x) && coordinate(input.y) &&
    typeof input.deltaX === "number" && Number.isFinite(input.deltaX) && Math.abs(input.deltaX) <= 8192 &&
    typeof input.deltaY === "number" && Number.isFinite(input.deltaY) && Math.abs(input.deltaY) <= 8192)
    return input as DeepSeekViewInput;
  if (input.type === "key" && typeof input.key === "string" && input.key.length > 0 && input.key.length <= 48 &&
    /^[A-Za-z0-9+\- ]+$/.test(input.key))
    return input as DeepSeekViewInput;
  if (input.type === "text" && typeof input.text === "string" && input.text.length > 0 && input.text.length <= 100_000)
    return input as DeepSeekViewInput;
  throw new DeepSeekBrowserError("DeepSeek 画布输入无效。");
}

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DeepSeekBrowserError("已取消本次 DeepSeek 提示词优化，原提示词未改动。", 499);
}

async function pause(signal?: AbortSignal) {
  aborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, 500);
    timer.unref?.();
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(new DeepSeekBrowserError("已取消本次 DeepSeek 提示词优化，原提示词未改动。", 499)); };
    function done() { signal?.removeEventListener("abort", onAbort); resolve(); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class DeepSeekBrowserService {
  private context?: BrowserContext;
  private launching?: Promise<BrowserContext>;
  private page?: Page;
  private threadUrl?: string;
  private ready: Promise<void>;
  private queued = Promise.resolve();
  private saving = Promise.resolve();
  private closing = false;
  private needsFreshChat = false;
  private completing = 0;
  private discardedPages = new WeakSet<Page>();

  constructor(readonly root = deepSeekDataRoot()) {
    this.ready = this.load();
  }

  private async load() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.root, "session.json"), "utf8"));
      if (isConversationUrl(saved.threadUrl)) this.threadUrl = saved.threadUrl;
    } catch { /* No previous chat is expected on first use. */ }
  }

  private async saveThread(url: string, signal?: AbortSignal) {
    if (!isConversationUrl(url) || url === this.threadUrl) return;
    const write = this.saving.then(async () => {
      aborted(signal);
      if (url === this.threadUrl) return;
      const destination = path.join(this.root, "session.json");
      const temporary = path.join(this.root, `session-${process.pid}-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, JSON.stringify({ threadUrl: url }), { mode: 0o600 });
        aborted(signal);
        await fs.rename(temporary, destination);
        aborted(signal);
        this.threadUrl = url;
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    });
    this.saving = write.catch(() => {});
    await write;
  }

  private discardPage(page?: Page) {
    if (!page || this.discardedPages.has(page)) return;
    this.discardedPages.add(page);
    if (this.page === page) this.page = undefined;
    // Closing the old page cancels its pending Playwright action. A later task
    // must not wait for, or reuse, an action that belonged to the cancelled one.
    void page.close({ runBeforeUnload: false }).catch(() => {});
  }

  private async launch(): Promise<BrowserContext> {
    if (this.launching) return this.launching;
    if (this.context?.browser?.()?.isConnected() !== false && this.context?.pages().some(page => !page.isClosed()))
      return this.context;
    this.closing = false;
    this.launching = (async () => {
      // Restart an interrupted background context with the same signed-in
      // profile. The canvas panel remains the only visible UI.
      const previous = this.context;
      this.context = undefined; this.page = undefined;
      await previous?.close().catch(() => {});
      await this.ready;
      const profile = path.join(this.root, "browser-profile");
      await fs.mkdir(profile, { recursive: true, mode: 0o700 });
      const options = { headless: true, chromiumSandbox: true,
        viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timeout: 0 };
      const executablePath = process.env.DRAW_STUDIO_BROWSER_EXECUTABLE?.trim();
      let context: BrowserContext;
      try {
        if (executablePath) context = await chromium.launchPersistentContext(profile, { ...options, executablePath });
        else {
          try { context = await chromium.launchPersistentContext(profile, { ...options, channel: process.platform === "win32" ? "msedge" : "chrome" }); }
          catch { context = await chromium.launchPersistentContext(profile, options); }
        }
      } catch { throw new DeepSeekBrowserError("无法启动 DeepSeek 后台连接，请关闭遗留的 DeepSeek 进程后重试。", 503); }
      context.setDefaultTimeout(0);
      context.setDefaultNavigationTimeout(0);
      context.on("close", () => { if (this.context === context) { this.context = undefined; this.page = undefined; } });
      this.context = context;
      return context;
    })();
    try { return await this.launching; } finally { this.launching = undefined; }
  }

  private async ensurePage(signal?: AbortSignal, operation?: BrowserOperation): Promise<Page> {
    const context = await this.launch();
    aborted(signal);
    if (this.page && !this.page.isClosed() && !this.discardedPages.has(this.page) && isDeepSeekChat(this.page.url())) {
      if (operation) operation.page = this.page;
      return this.page;
    }
    const usable = (candidate: Page) => !candidate.isClosed() && !this.discardedPages.has(candidate);
    const page = context.pages().find(candidate => usable(candidate) && isDeepSeekChat(candidate.url()))
      ?? context.pages().find(candidate => usable(candidate) && candidate.url() === "about:blank")
      ?? context.pages().find(usable);
    if (!page) throw new DeepSeekBrowserError("DeepSeek 后台连接已关闭，请重新连接。", 503);
    aborted(signal);
    this.page = page;
    if (operation) operation.page = page;
    page.on("close", () => { if (this.page === page) this.page = undefined; });
    // OAuth must remain open in the same window until login completes.
    if (page.url() === "about:blank") await page.goto(this.threadUrl ?? DEEPSEEK_URL, { waitUntil: "commit" });
    aborted(signal);
    return page;
  }

  async session(): Promise<DeepSeekSession> {
    await this.ready;
    const page = this.page && !this.page.isClosed() ? this.page
      : this.context?.pages().find(candidate => !candidate.isClosed() && !this.discardedPages.has(candidate) && isDeepSeekChat(candidate.url()));
    if (!page) return { status: "disconnected", message: "DeepSeek 后台尚未连接。" };
    if (!isDeepSeekChat(page.url())) return { status: "login-required", message: "DeepSeek 账号需要重新验证。" };
    try {
      const state = await page.evaluate(selector => {
        const visible = (element: Element) => {
          const bounds = element.getBoundingClientRect();
          const css = getComputedStyle(element);
          return bounds.width > 0 && bounds.height > 0 && css.visibility !== "hidden" && css.display !== "none";
        };
        const composer = [...document.querySelectorAll(selector)].some(visible);
        const login = [...document.querySelectorAll('button, a, [role="button"]')].some(element =>
          visible(element) && /^(登录|登入|注册|log in|login|sign in|sign up)$/i.test(
            (element.getAttribute("aria-label") || element.textContent || "").trim()));
        return { composer, login };
      }, COMPOSER);
      return state.composer && !state.login
        ? { status: "connected", message: "DeepSeek 网页已就绪。" }
        : { status: "login-required", message: "DeepSeek 账号需要重新登录。" };
    } catch { return { status: "login-required", message: "DeepSeek 网页正在加载，请稍后检查连接。" }; }
  }

  async open(): Promise<DeepSeekSession> {
    await this.ensurePage();
    return this.session();
  }

  async importSession(value: unknown): Promise<DeepSeekSession> {
    const snapshot = validateDeepSeekSessionImport(value);
    await this.ready;
    if (this.completing) throw new DeepSeekBrowserError("DeepSeek 正在优化提示词，请完成后同步登录状态。", 409);
    const context = await this.launch();
    if (snapshot.cookies.length) await context.addCookies(snapshot.cookies);
    const page = await this.ensurePage();
    if (!isDeepSeekChat(page.url())) await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded", timeout: 0 });
    const storage = snapshot.origins[0]?.localStorage ?? [];
    if (storage.length) await page.evaluate(entries => {
      for (const entry of entries) localStorage.setItem(entry.name, entry.value);
    }, storage);
    if (snapshot.cookies.length || storage.length) await page.reload({ waitUntil: "domcontentloaded", timeout: 0 });
    return this.session();
  }

  async exportSession(): Promise<ImportedSession> {
    await this.ready;
    if (!this.context) {
      const profile = path.join(this.root, "browser-profile");
      if (!await fs.stat(profile).then(info => info.isDirectory(), () => false)) return { cookies: [], origins: [] };
    }
    const context = await this.launch();
    let temporary: Page | undefined;
    try {
      // Read persisted localStorage without navigating the active optimization page.
      if (!context.pages().some(page => !page.isClosed() && isDeepSeekChat(page.url()))) {
        temporary = await context.newPage();
        await temporary.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded", timeout: 0 });
      }
      return filterDeepSeekSessionExport(await context.storageState());
    } finally { await temporary?.close().catch(() => {}); }
  }

  /** Follow a login popup from the existing chat page, then return when it closes. */
  private async activeViewPage(): Promise<Page> {
    const chat = await this.ensurePage();
    const pages = this.context?.pages() ?? [];
    for (const candidate of [...pages].reverse()) {
      if (candidate.isClosed() || this.discardedPages.has(candidate) || candidate === chat) continue;
      let opener = await candidate.opener().catch(() => null);
      const seen = new Set<Page>();
      while (opener && !seen.has(opener)) {
        if (opener === chat) return candidate;
        seen.add(opener);
        opener = await opener.opener().catch(() => null);
      }
    }
    return chat;
  }

  /** Render the signed-in page inside the canvas without creating another OS window. */
  async viewFrame(requestedSize: unknown = {}): Promise<Buffer> {
    if (!requestedSize || typeof requestedSize !== "object" || Array.isArray(requestedSize))
      throw new DeepSeekBrowserError("DeepSeek 画面尺寸无效。", 400);
    const requested = requestedSize as Record<string, unknown>;
    if (Object.keys(requested).some(key => key !== "width" && key !== "height") ||
      (requested.width === undefined) !== (requested.height === undefined))
      throw new DeepSeekBrowserError("DeepSeek 画面尺寸无效。", 400);
    const sized = requested.width !== undefined;
    if (sized && (typeof requested.width !== "number" || typeof requested.height !== "number" ||
      !Number.isInteger(requested.width) || !Number.isInteger(requested.height) ||
      (requested.width as number) < 320 || (requested.width as number) > 3840 ||
      (requested.height as number) < 240 || (requested.height as number) > 2160))
      throw new DeepSeekBrowserError("DeepSeek 画面尺寸无效。", 400);
    const page = await this.activeViewPage();
    if (sized) {
      const size = { width: requested.width as number, height: requested.height as number };
      const current = page.viewportSize();
      if (!current || current.width !== size.width || current.height !== size.height)
        await page.setViewportSize(size);
    }
    return page.screenshot({ type: "jpeg", quality: 90, scale: "css", animations: "disabled", timeout: 0 });
  }

  async viewInput(value: unknown): Promise<void> {
    const input = validateDeepSeekViewInput(value);
    const page = await this.activeViewPage();
    if (input.type === "click") await page.mouse.click(input.x, input.y, { button: input.button ?? "left" });
    else if (input.type === "wheel") {
      await page.mouse.move(input.x, input.y);
      await page.mouse.wheel(input.deltaX, input.deltaY);
    } else if (input.type === "key") await page.keyboard.press(input.key);
    else await page.keyboard.insertText(input.text);
  }

  /** Stream a canvas-selected attachment into the original chat's file input. */
  async viewUpload(name: string, mimeType: string, stream: Readable): Promise<void> {
    if (!name || name.length > 255 || name === "." || name === ".." ||
      path.win32.basename(name) !== name || path.posix.basename(name) !== name ||
      /[<>:"/\\|?*\x00-\x1f]/.test(name))
      throw new DeepSeekBrowserError("DeepSeek 附件文件名无效。");
    if (!mimeType || mimeType.length > 255 || /[\r\n]/.test(mimeType))
      throw new DeepSeekBrowserError("DeepSeek 附件类型无效。");
    const page = await this.activeViewPage();
    if (!isDeepSeekChat(page.url()))
      throw new DeepSeekBrowserError("请先完成 DeepSeek 登录，再上传附件。", 409);
    const fileInput = page.locator('input[type="file"][multiple]').first();
    if (!await fileInput.count())
      throw new DeepSeekBrowserError("DeepSeek 页面没有附件上传入口。", 502);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "drawstudio-deepseek-upload-"));
    try {
      const filePath = path.join(temporary, name);
      await pipeline(stream, createWriteStream(filePath, { flags: "wx", mode: 0o600 }));
      await fileInput.setInputFiles(filePath);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }

  async complete(value: unknown, signal?: AbortSignal): Promise<DeepSeekCompletion> {
    const request = normalizeRequest(value);
    this.completing++;
    const previous = this.queued;
    let release!: () => void;
    this.queued = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      aborted(signal);
      const operation: BrowserOperation = {};
      if (!signal) return await this.run(request, signal, operation);
      let onAbort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          this.needsFreshChat = true;
          this.discardPage(operation.page);
          reject(new DeepSeekBrowserError("已取消本次 DeepSeek 提示词优化，原提示词未改动。", 499));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        aborted(signal);
        return await Promise.race([this.run(request, signal, operation), cancelled]);
      } finally { signal.removeEventListener("abort", onAbort); }
    }
    finally { release(); this.completing--; }
  }

  private async run(request: WebOptimizationRequest, signal?: AbortSignal, operation?: BrowserOperation): Promise<DeepSeekCompletion> {
    const page = await this.ensurePage(signal, operation);
    if (!isDeepSeekChat(page.url())) {
      throw new DeepSeekBrowserError("DeepSeek 账号需要重新登录。", 401);
    }
    if (this.needsFreshChat || (!this.threadUrl && page.url() !== DEEPSEEK_URL)) {
      await page.goto(DEEPSEEK_URL, { waitUntil: "domcontentloaded" });
      aborted(signal);
      this.needsFreshChat = false;
    } else if (this.threadUrl && !sameDeepSeekConversation(page.url(), this.threadUrl)) {
      await page.goto(this.threadUrl, { waitUntil: "domcontentloaded" });
    }
    aborted(signal);
    const session = await this.session();
    aborted(signal);
    if (session.status !== "connected") {
      throw new DeepSeekBrowserError("DeepSeek 登录状态失效，后台无法优化；原提示词未改动。", 401);
    }
    aborted(signal);
    const composer = page.locator(COMPOSER).filter({ visible: true }).first();
    const draft = await composer.inputValue();
    aborted(signal);
    if (draft.trim())
      throw new DeepSeekBrowserError("DeepSeek 输入框中有尚未发送的草稿，请先处理该草稿后重试。", 409);
    const composerIdle = await page.evaluate(selector => {
      const input = document.querySelector<HTMLTextAreaElement>(selector);
      const button = input?.parentElement?.parentElement?.parentElement?.querySelector<HTMLElement>('div[role="button"].ds-button--primary');
      return !!button?.classList.contains("ds-button--disabled") && !button?.querySelector(".ds-loading");
    }, COMPOSER);
    aborted(signal);
    if (!composerIdle) throw new DeepSeekBrowserError("DeepSeek 当前仍在生成上一条回复，请等待完成后重试。", 409);
    const baseline = await page.locator(ASSISTANT_CONTENT).count();
    const baselineText = baseline ? (await page.locator(ASSISTANT_CONTENT).last().innerText()).trim() : "";
    aborted(signal);
    const prompt = request.prompt;
    let submitted = false;
    let filled = false;
    let attachmentStarted = false;
    try {
      if (request.attachments.length) {
        const existingAttachments = await page.evaluate(selector => {
          const composer = document.querySelector<HTMLTextAreaElement>(selector);
          const input = composer?.parentElement?.parentElement?.querySelector<HTMLInputElement>('input[type="file"]');
          // DeepSeek may retain an unsent file in the native input. The adjacent
          // preview container is checked structurally; its CSS class is hashed.
          return !!input?.files?.length || !!composer?.nextElementSibling?.children.length;
        }, COMPOSER);
        aborted(signal);
        if (existingAttachments)
          throw new DeepSeekBrowserError("DeepSeek 输入框中已有附件，请先处理该草稿后重试。", 409);
        const fileInput = page.locator('input[type="file"][multiple]').first();
        if (!await fileInput.count())
          throw new DeepSeekBrowserError("DeepSeek 页面没有文件上传入口，请检查网页。", 502);
        attachmentStarted = true;
        await fileInput.setInputFiles(request.attachments.map(file => ({
          name: file.name,
          mimeType: file.mimeType,
          buffer: Buffer.from(file.content, "utf8"),
        })));
        aborted(signal);
        let lastUploadState = "";
        while (!this.closing) {
          const status = await page.evaluate(({ selector, names }) => {
            const composer = document.querySelector<HTMLTextAreaElement>(selector);
            // Uploaded file cards are siblings of the text entry in current
            // DeepSeek builds. Search the whole composer wrapper, not the
            // textarea's adjacent (often empty) div or a hashed CSS class.
            const area = composer?.parentElement?.parentElement?.parentElement?.parentElement;
            const alerts = [...document.querySelectorAll<HTMLElement>('[role="alert"]')]
              .filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })
              .map(element => element.innerText.trim()).filter(Boolean);
            if (!area) return { ready: false, found: 0, busy: false, missingArea: true, error: alerts.join("；") };
            const labels = [area.innerText, ...[...area.querySelectorAll<HTMLElement>("[title], [aria-label], [data-tooltip]")]
              .flatMap(element => [element.title, element.getAttribute("aria-label"), element.getAttribute("data-tooltip")])]
              .filter(Boolean).join("\n");
            const errorText = /(?:上传|解析|文件).{0,20}(?:失败|错误|不支持|过大|超出)/.exec(labels)?.[0] ?? "";
            const busy = !!area.querySelector('[aria-busy="true"], [role="progressbar"], .ds-loading, .ds-spinner') ||
              /上传中|解析中|处理中/.test(labels);
            const found = names.filter(name => labels.includes(name)).length;
            return { ready: found === names.length && !busy, found, busy,
              missingArea: false, error: alerts.join("；") || errorText };
          }, { selector: COMPOSER, names: request.attachments.map(file => file.name) });
          aborted(signal);
          const uploadState = `${status.found}/${request.attachments.length}:${status.busy ? "busy" : "idle"}:${status.missingArea ? "missing" : "present"}`;
          if (uploadState !== lastUploadState) {
            console.info(`[DeepSeek] 附件处理状态 ${uploadState}`);
            lastUploadState = uploadState;
          }
          if (status.error) throw new DeepSeekBrowserError(`DeepSeek 文件上传失败：${status.error}`, 502);
          if (status.missingArea) throw new DeepSeekBrowserError("DeepSeek 附件区域已变化，请检查网页。", 502);
          if (status.ready) break;
          await pause(signal);
        }
        if (this.closing) throw new DeepSeekBrowserError("DeepSeek 窗口已关闭，原提示词未改动。", 503);
      }
      await composer.fill(prompt);
      filled = true;
      aborted(signal);
      await composer.press("Enter");
      aborted(signal);
      const valueAfterSend = await composer.inputValue();
      aborted(signal);
      if (valueAfterSend.trim()) throw new DeepSeekBrowserError("DeepSeek 未确认发送，本次没有覆盖原提示词。", 502);
      submitted = true;
      console.info("[DeepSeek] 请求已提交，等待回复");
      let activeThread = isConversationUrl(page.url()) ? page.url() : undefined;
      let lastReplyState = "";

      while (!this.closing) {
        aborted(signal);
        if (page.isClosed()) throw new DeepSeekBrowserError("DeepSeek 窗口已关闭，原提示词未改动。", 503);
        if (!isDeepSeekChat(page.url())) throw new DeepSeekBrowserError("DeepSeek 页面已离开聊天界面，原提示词未改动。", 503);
        const observed = await page.evaluate(({ contentSelector, composerSelector }) => {
          const contents = [...document.querySelectorAll<HTMLElement>(contentSelector)];
          const composer = document.querySelector<HTMLTextAreaElement>(composerSelector);
          const parent = composer?.parentElement?.parentElement?.parentElement;
          const button = parent?.querySelector<HTMLElement>('div[role="button"].ds-button--primary');
          const idle = !!button?.classList.contains("ds-button--disabled") && !button?.querySelector(".ds-loading");
          const alerts = [...document.querySelectorAll<HTMLElement>('[role="alert"]')].filter(element => {
            const bounds = element.getBoundingClientRect();
            return bounds.width > 0 && bounds.height > 0;
          }).map(element => element.innerText.trim()).filter(Boolean);
          return { count: contents.length, text: contents.at(-1)?.innerText ?? "", idle,
            missingButton: !button, alerts, url: location.href };
        }, { contentSelector: ASSISTANT_CONTENT, composerSelector: COMPOSER });
        aborted(signal);
        const replyState = `${observed.count - baseline}:${observed.text.trim().length ? "text" : "empty"}:${observed.idle ? "idle" : "busy"}:${observed.missingButton ? "no-button" : "button"}`;
        if (replyState !== lastReplyState) {
          console.info(`[DeepSeek] 回复状态 ${replyState}`);
          lastReplyState = replyState;
        }
        if (activeThread && !sameDeepSeekConversation(observed.url, activeThread))
          throw new DeepSeekBrowserError("DeepSeek 页面切换了聊天，本次没有采用其他聊天的回复。", 409);
        if (!activeThread && isConversationUrl(observed.url)) activeThread = observed.url;
        if (observed.alerts.length) throw new DeepSeekBrowserError(`DeepSeek 页面提示：${observed.alerts.join("；")}`, 502);
        if (observed.missingButton) throw new DeepSeekBrowserError("DeepSeek 页面发送控件已变化，请检查网页。", 502);
        // DeepSeek can virtualize older chat messages when the new reply arrives.
        // The total number of mounted assistant nodes may stay unchanged or fall.
        const freshReply = observed.count > baseline || observed.text.trim() !== baselineText;
        if (freshReply && observed.text.trim() && observed.idle) {
          await this.saveThread(observed.url, signal);
          aborted(signal);
          return { model: "deepseek-web", choices: [{ finish_reason: "stop", message: { role: "assistant", content: observed.text.trim() } }] };
        }
        await pause(signal);
      }
      throw new DeepSeekBrowserError("DeepSeek 窗口已关闭，原提示词未改动。", 503);
    } catch (error) {
      // Once a message was sent, a late reply must never be mistaken for the
      // next optimization request after cancellation, navigation, or failure.
      if (submitted && !signal?.aborted) this.needsFreshChat = true;
      else if (attachmentStarted && !signal?.aborted) {
        // A failed upload can leave chips in the composer. Never carry those
        // files into the next optimization request.
        this.needsFreshChat = true;
        this.discardPage(page);
      } else if (filled && !signal?.aborted && !page.isClosed()) {
        try { if (await composer.inputValue() === prompt) await composer.fill(""); }
        catch { /* Leave the page untouched if the composer changed. */ }
      }
      throw error;
    }
  }

  async close() {
    this.closing = true;
    const context = this.context ?? await this.launching?.catch(() => undefined);
    await context?.close();
  }
}

let singleton: DeepSeekBrowserService | undefined;
export function getDeepSeekBrowserService(_projectRoot?: string) {
  return singleton ??= new DeepSeekBrowserService();
}
