import { chromium, type BrowserContext, type Page } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { MuseJob, MuseJobRequest, MuseSession } from "../src/muse/client";
import { classifyMusePage, isMusePageUrl, museComposerSelector } from "./muse-session-state";
import { museReferenceKind } from "../src/muse/media";
import { readMuseTurnMedia } from "./muse-turn-media";
import { uploadMuseReferences, MuseUploadError, museUploadError, museUploadPending } from "./muse-upload";
import { MuseReferenceStore } from "./muse-reference-store";
import { readMuseDeliveryState } from "./muse-delivery-state";
import { readMuseSendReadiness } from "./muse-send-readiness";
import { prepareMuseTurnAnchor, type MuseTurnAnchor } from "./muse-turn-anchor";
import { attachMusePageSignals, type MusePageSignals } from "./muse-page-signals";
import { readMuseActivity } from "./muse-activity-state";
import { serviceDataRoot } from "./service-data-root";

// Muse DOM selectors were checked against muse2api (MIT), revision
// 5b8bba9561fdbe6402fbc08012d144699760afd0. See docs/muse-integration.md.
const MUSE = "https://muse.ai";
type SavedJob = MuseJob & { kind: "image" | "video"; hash: string; submitted: boolean; deliveryConfirmed?: boolean; observation?: { state: string; diagnostic: NonNullable<Awaited<ReturnType<typeof readMuseDeliveryState>>["diagnostic"]> }; baseline: string[]; turnMarker?: string; turnAnchor?: MuseTurnAnchor; createdAt: number };
export class MuseBridgeError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export const museDataRoot = () => path.join(serviceDataRoot(), "muse");
const delay = () => new Promise<void>(resolve => { const timer = setTimeout(resolve, 1500); timer.unref?.(); });
const safeId = /^[a-zA-Z0-9_-]{8,100}$/;
const ratios = new Set(["auto", "1:1", "16:9", "9:16", "4:3", "3:4"]);
type ImportedCookie = Parameters<BrowserContext["addCookies"]>[0][number];
type ImportedStorage = { name: string; value: string };
type ImportedSession = { cookies: ImportedCookie[]; origins: { origin: string; localStorage: ImportedStorage[] }[] };

/** Accept only Muse credentials from the local native WebView, never an arbitrary browser profile. */
export function validateMuseSessionImport(value: unknown): ImportedSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MuseBridgeError("Muse 登录状态无效。");
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.cookies) || source.cookies.length > 256 || !Array.isArray(source.origins) || source.origins.length > 1)
    throw new MuseBridgeError("Muse 登录状态无效。");
  const cookies = source.cookies.map((item): ImportedCookie => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new MuseBridgeError("Muse Cookie 无效。");
    const cookie = item as Record<string, unknown>;
    if (typeof cookie.name !== "string" || !cookie.name || cookie.name.length > 256 || /[\r\n\0]/.test(cookie.name) ||
      typeof cookie.value !== "string" || cookie.value.length > 8192 || /[\r\n\0]/.test(cookie.value) ||
      cookie.domain !== "muse.ai" && cookie.domain !== ".muse.ai" ||
      typeof cookie.path !== "string" || !cookie.path.startsWith("/") || cookie.path.length > 1024 || /[\r\n\0]/.test(cookie.path) ||
      cookie.expires !== undefined && (typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires) || cookie.expires < -1 || cookie.expires > 4102444800) ||
      cookie.httpOnly !== undefined && typeof cookie.httpOnly !== "boolean" ||
      cookie.secure !== undefined && typeof cookie.secure !== "boolean" ||
      cookie.sameSite !== undefined && !["Strict", "Lax", "None"].includes(String(cookie.sameSite)))
      throw new MuseBridgeError("Muse Cookie 无效。");
    return { name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
      ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
      ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
      ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite as "Strict" | "Lax" | "None" }) };
  });
  const origins = source.origins.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new MuseBridgeError("Muse 本地登录数据无效。");
    const origin = item as Record<string, unknown>;
    if (origin.origin !== MUSE || !Array.isArray(origin.localStorage) || origin.localStorage.length > 256)
      throw new MuseBridgeError("Muse 本地登录数据无效。");
    return { origin: MUSE, localStorage: origin.localStorage.map(entry => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.name !== "string" || entry.name.length > 1024 ||
        typeof entry.value !== "string" || entry.value.length > 100_000)
        throw new MuseBridgeError("Muse 本地登录数据无效。");
      return { name: entry.name, value: entry.value };
    }) };
  });
  return { cookies, origins };
}
export function filterMuseSessionExport(state: Awaited<ReturnType<BrowserContext["storageState"]>>): ImportedSession {
  return validateMuseSessionImport({
    cookies: state.cookies.filter(cookie => cookie.domain === "muse.ai" || cookie.domain === ".muse.ai"),
    origins: state.origins.filter(origin => origin.origin === MUSE).map(origin => ({
      origin: origin.origin, localStorage: origin.localStorage,
    })),
  });
}
export function validateMuseRequest(value: unknown): MuseJobRequest {
  const r = value as MuseJobRequest;
  if (!r || !safeId.test(r.id) || !["image", "video"].includes(r.kind) || typeof r.prompt !== "string" || !r.prompt.trim() || !ratios.has(r.aspectRatio) || !Array.isArray(r.references))
    throw new MuseBridgeError("Muse 请求无效：请检查提示词、生成类型、比例和参考素材。");
  const references = r.references.map((ref, i) => {
    if (!ref || typeof ref.mime !== "string" || !museReferenceKind(ref.mime))
      throw new MuseBridgeError("参考素材需要有效的图片、视频或音频。");
    if (ref.uploadId) {
      if (!safeId.test(ref.uploadId) || ref.dataBase64 !== undefined) throw new MuseBridgeError("参考素材上传编号无效。");
      return { uploadId: ref.uploadId, name: typeof ref.name === "string" ? path.basename(ref.name) : `reference-${i + 1}`, mime: ref.mime };
    }
    if (typeof ref.dataBase64 !== "string") throw new MuseBridgeError("参考素材尚未上传。");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ref.dataBase64)) throw new MuseBridgeError("参考素材编码无效。");
    const bytes = Buffer.from(ref.dataBase64, "base64");
    const actual = sniffMuseMedia(bytes, ref.mime);
    if (!actual || museReferenceKind(actual.mime) !== museReferenceKind(ref.mime))
      throw new MuseBridgeError("参考素材内容与图片、视频或音频类型不符，请重新导入原始素材。");
    return { name: `reference-${i + 1}.${actual.ext}`, mime: actual.mime, dataBase64: bytes.toString("base64") };
  });
  return { id: r.id, kind: r.kind, prompt: r.prompt, aspectRatio: r.aspectRatio, references };
}
export function sniffMuseMedia(bytes: Buffer, declaredMime = ""): { mime: string; ext: string } | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime: "image/png", ext: "png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: "image/jpeg", ext: "jpg" };
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return { mime: "image/gif", ext: "gif" };
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE") return { mime: "audio/wav", ext: "wav" };
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "AVI ") return { mime: "video/x-msvideo", ext: "avi" };
  if (bytes.subarray(0, 4).toString() === "fLaC") return { mime: "audio/flac", ext: "flac" };
  if (bytes.subarray(0, 3).toString() === "ID3" || bytes.length > 3 && bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0)
    return { mime: "audio/mpeg", ext: "mp3" };
  if (bytes.length > 6 && bytes[0] === 255 && (bytes[1] & 0xf6) === 0xf0) return { mime: "audio/aac", ext: "aac" };
  if (bytes.subarray(0, 4).toString() === "FORM" && /^(AIFF|AIFC)$/.test(bytes.subarray(8, 12).toString())) return { mime: "audio/aiff", ext: "aiff" };
  if (bytes.subarray(0, 4).toString() === "OggS") {
    if (bytes.includes(Buffer.from("theora"))) return { mime: "video/ogg", ext: "ogv" };
    if (bytes.includes(Buffer.from("OpusHead")) || bytes.includes(Buffer.from("vorbis")) || bytes.includes(Buffer.from("FLAC")))
      return { mime: "audio/ogg", ext: "ogg" };
  }
  if (bytes.subarray(4, 8).toString() === "ftyp") {
    const brand = bytes.subarray(8, 12).toString();
    if (["M4A ", "M4B ", "F4A "].includes(brand)) return { mime: "audio/mp4", ext: "m4a" };
    if (["avif", "avis"].includes(brand)) return { mime: "image/avif", ext: "avif" };
    if (["heic", "heix", "mif1", "msf1"].includes(brand)) return { mime: "image/heic", ext: "heic" };
    if (["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "qt  ", "dash"].includes(brand)) {
      // ISO BMFF can contain audio only. Honor the declared audio category only
      // when the container has an audio handler and no video handler.
      if (declaredMime.startsWith("audio/") && bytes.includes(Buffer.from("soun")) && !bytes.includes(Buffer.from("vide"))) return { mime: "audio/mp4", ext: "m4a" };
      return brand === "qt  " ? { mime: "video/quicktime", ext: "mov" } : { mime: "video/mp4", ext: "mp4" };
    }
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163])) && bytes.subarray(0, 4096).includes(Buffer.from("webm"))) {
    const header = bytes.subarray(0, 65536);
    const audioOnly = declaredMime.startsWith("audio/") && /A_OPUS|A_VORBIS/.test(header.toString("latin1")) && !/V_VP8|V_VP9|V_AV1/.test(header.toString("latin1"));
    return { mime: audioOnly ? "audio/webm" : "video/webm", ext: "webm" };
  }
}
export function museConversationUrl(value: string): string | undefined {
  try { const url = new URL(value); return isMusePageUrl(value) && (url.pathname === "/" && !url.search && !url.hash || /^\/thread\/[a-zA-Z0-9_-]+$/.test(url.pathname) && !url.pathname.endsWith("/new")) ? MUSE + url.pathname : undefined; } catch { return undefined; }
}
export function museMediaUrl(value: string): boolean {
  if (value.startsWith("blob:https://muse.ai/")) return true;
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && ["muse.ai", "meta.ai", "fbcdn.net", "fbsbx.com", "cdninstagram.com"].some(domain => u.hostname === domain || u.hostname.endsWith("." + domain)); } catch { return false; }
}
export function museGenerationPrompt(request: MuseJobRequest, _legacyMarker?: string) {
  return request.prompt;
}
type Media = { src: string; kind: "image" | "video"; width: number; height: number };
/** Only assistant attachments, never composer previews, user uploads or video posters. */
export const readMuseMedia = readMuseTurnMedia;
export class MuseBrowserService {
  private context?: BrowserContext;
  private launching?: Promise<BrowserContext>;
  private loginPage?: Page;
  private workPage?: Page;
  private viewerFocusedPage?: Page;
  private jobs = new Map<string, SavedJob>();
  private pending = new Map<string, MuseJobRequest | undefined>();
  private cancellations = new Map<string, AbortController>();
  private activePages = new Map<string, Page>();
  private stoppedPages = new WeakSet<Page>();
  private mutatingPages = new WeakSet<Page>();
  private observedPages = new WeakSet<Page>();
  private reconnectEnabled = false;
  private lastConversationUrl = MUSE + "/";
  private openingPage?: { context: BrowserContext; promise: Promise<Page> };
  private navigatingPages = new WeakSet<Page>();
  private running = false;
  private closing = false;
  private ready: Promise<void>;
  private writes = Promise.resolve();
  readonly references: MuseReferenceStore;
  constructor(public readonly root = museDataRoot()) {
    this.references = new MuseReferenceStore(path.join(root, "references"), sniffMuseMedia);
    this.ready = this.load();
  }
  private async load() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    let hasBrowserPreference = false;
    try {
      const state = JSON.parse(await fs.readFile(path.join(this.root, "browser-session.json"), "utf8"));
      hasBrowserPreference = true;
      this.reconnectEnabled = state.reconnect === true;
      this.lastConversationUrl = museConversationUrl(state.url) ?? MUSE + "/";
    } catch { /* An absent browser preference does not invalidate task records. */ }
    let data: SavedJob[];
    try { data = JSON.parse(await fs.readFile(path.join(this.root, "jobs.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Muse 本机任务记录无法读取，请保留记录并检查磁盘。"); }
    for (const job of data) if (safeId.test(job.id)) {
      if (!["completed", "failed", "cancelled"].includes(job.status)) {
        job.status = job.submitted ? "interrupted" : "failed";
        job.recovery = job.submitted ? "reconnect" : undefined;
        job.error = job.submitted
          ? job.conversationUrl ? "本机服务已重启，请恢复查询原 Muse 会话。" : "原任务尚无已确认的 Muse 会话记录，无法自动恢复；不会重新提交。"
          : "本机服务在提交前停止，此任务未发送。";
      }
      this.jobs.set(job.id, job);
    }
    // Existing installations already have a dedicated signed-in profile. Keep
    // that connection preference when upgrading; an explicit disconnect wins.
    if (!hasBrowserPreference && data.some(job => job.submitted)) {
      this.reconnectEnabled = await fs.stat(path.join(this.root, "browser-profile")).then(info => info.isDirectory(), () => false);
      if (this.reconnectEnabled) await this.persistBrowserState();
    }
  }
  private persist() {
    const snapshot = JSON.stringify([...this.jobs.values()]);
    const write = this.writes.catch(() => {}).then(async () => {
      const tmp = path.join(this.root, `jobs-${process.pid}.tmp`);
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, path.join(this.root, "jobs.json"));
    });
    this.writes = write;
    return write;
  }
  private publicJob(job: SavedJob): MuseJob {
    const { id, status, message, conversationUrl, outputs, error, recovery } = job;
    return { id, status, message, conversationUrl, outputs, error, recovery };
  }
  private persistBrowserState() {
    const snapshot = JSON.stringify({ reconnect: this.reconnectEnabled, url: this.lastConversationUrl });
    const write = this.writes.catch(() => {}).then(async () => {
      const tmp = path.join(this.root, `browser-session-${process.pid}.tmp`);
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, path.join(this.root, "browser-session.json"));
    });
    this.writes = write;
    return write;
  }
  private observePage(page: Page) {
    if (this.observedPages.has(page)) return;
    this.observedPages.add(page);
    const remember = () => {
      const url = museConversationUrl(page.url());
      if (url && url !== this.lastConversationUrl) {
        this.lastConversationUrl = url;
        void this.persistBrowserState().catch(() => {});
      }
    };
    page.on("framenavigated", remember);
    page.on("close", () => {
      if (this.loginPage === page) this.loginPage = undefined;
      if (this.workPage === page) this.workPage = undefined;
      if (this.viewerFocusedPage === page) this.viewerFocusedPage = undefined;
    });
    remember();
  }
  private async ensurePage(context: BrowserContext): Promise<Page> {
    if (this.openingPage?.context === context) return this.openingPage.promise;
    const opening = { context, promise: (async () => {
      const usable = (page: Page) => !this.stoppedPages.has(page) && !page.isClosed();
      const page = context.pages().find(p => usable(p) && isMusePageUrl(p.url()))
        ?? context.pages().find(p => usable(p) && p.url() === "about:blank")
        ?? context.pages().find(usable);
      if (!page) throw new MuseBridgeError("Muse 后台连接已关闭，请重新连接。", 503);
      this.observePage(page);
      this.loginPage = page;
      // Keep an in-progress authentication navigation intact until it returns to Muse.
      if (page.url() === "about:blank" && !this.navigatingPages.has(page)) {
        this.navigatingPages.add(page);
        void page.goto(this.lastConversationUrl, { waitUntil: "commit" }).catch(() => {}).finally(() => this.navigatingPages.delete(page));
      }
      return page;
    })() };
    this.openingPage = opening;
    try { return await opening.promise; } finally { if (this.openingPage === opening) this.openingPage = undefined; }
  }
  private async launch() {
    if (this.launching) return this.launching;
    if (this.context?.browser?.()?.isConnected() !== false && this.context?.pages().some(page => !page.isClosed()))
      return this.context;
    this.closing = false;
    this.launching = (async () => {
      // A cancelled or disconnected task may have closed its page. Restart the
      // background context with the same profile so no visible window appears.
      const previous = this.context;
      this.context = undefined; this.loginPage = undefined; this.workPage = undefined; this.viewerFocusedPage = undefined;
      await previous?.close().catch(() => {});
      const profile = path.join(this.root, "browser-profile");
      await fs.mkdir(profile, { recursive: true, mode: 0o700 });
      // Preserve the signed-in profile while the service runs without opening
      // another operating-system window outside the canvas.
      const options = { headless: true, chromiumSandbox: true, acceptDownloads: true,
        viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timeout: 0 };
      const executablePath = process.env.DRAW_STUDIO_BROWSER_EXECUTABLE?.trim();
      let context: BrowserContext;
      try {
        if (executablePath) context = await chromium.launchPersistentContext(profile, { ...options, executablePath });
        else {
          try { context = await chromium.launchPersistentContext(profile, { ...options, channel: process.platform === "win32" ? "msedge" : "chrome" }); }
          catch { context = await chromium.launchPersistentContext(profile, options); }
        }
      } catch { throw new MuseBridgeError("无法启动 Muse 后台连接，请关闭遗留的 Muse 进程后重试。", 503); }
      context.setDefaultTimeout(0);
      context.setDefaultNavigationTimeout(0);
      // OAuth commonly opens a second tab. Keep the canvas viewer on that tab
      // until it closes, while generation continues to share this context.
      context.on("page", page => { this.observePage(page); this.viewerFocusedPage = page; });
      context.on("close", () => { if (this.context === context) { this.context = undefined; this.loginPage = undefined; this.workPage = undefined; this.viewerFocusedPage = undefined; } });
      this.context = context;
      return context;
    })();
    try { return await this.launching; } finally { this.launching = undefined; }
  }
  async session(): Promise<MuseSession> {
    await this.ready;
    if (this.reconnectEnabled && !this.closing && (!this.context || !this.context.pages().some(p => !p.isClosed() && !this.stoppedPages.has(p) && p.url() !== "about:blank"))) {
      try {
        const context = await this.launch();
        if (this.reconnectEnabled && !this.closing) await this.ensurePage(context);
      }
      catch { return { status: "disconnected", message: "Muse 后台连接暂不可用，请点击连接重试；登录资料与原任务已保留。" }; }
    }
    // OAuth may finish in another tab while the original login tab stays open.
    const pages = this.context?.pages().filter(page => !this.stoppedPages.has(page) && !page.isClosed() && isMusePageUrl(page.url())).reverse() ?? [];
    if (!pages.length) return this.context
      ? { status: "checking", message: "正在检查 Muse 后台登录状态…" }
      : { status: "disconnected", message: "Muse 后台尚未连接。" };
    const states = await Promise.all(pages.map(async page => ({ page, state: await this.pageSession(page) })));
    const ready = states.find(item => item.state.status === "connected" && !item.page.isClosed() && !this.stoppedPages.has(item.page) && this.context?.pages().includes(item.page));
    if (ready) { this.loginPage = ready.page; return ready.state; }
    return (states.find(item => item.state.status === "checking") ?? states.find(item => item.state.status === "waiting-list") ?? states[0]).state;
  }
  private async pageSession(page: Page): Promise<MuseSession> {
    if (page.isClosed()) return { status: "disconnected", message: "Muse 后台连接已关闭，可重新连接并恢复查询。" };
    try {
      if (!isMusePageUrl(page.url())) return { status: "login-required", message: "Muse 账号需要重新验证。" };
      const state = await page.evaluate(selector => {
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && css.display !== "none" && css.visibility !== "hidden" && !element.closest('[hidden], [inert], [aria-hidden="true"]');
        };
        const composer = [...document.querySelectorAll(selector)].some(element => visible(element) && element.getAttribute("aria-disabled") !== "true");
        const controls = [...document.querySelectorAll('button, a, [role="button"]')].filter(visible);
        const login = controls.some(element => /^(登录|登入|注册|log in|login|sign in|sign up|log in or sign up|continue with (google|facebook|instagram)|使用.*登录)(?: Muse)?$/i.test((element.getAttribute("aria-label") || element.textContent || "").trim()));
        const workspace = controls.some(element => /^(新对话|新建对话|新聊天|new chat|new conversation)$/i.test((element.getAttribute("aria-label") || element.textContent || "").trim())) || [...document.querySelectorAll('nav a[href*="/thread/"]')].some(visible);
        const restriction = /waitlist|waiting list|等候名单|等候名單|尚未在|not available in your/i;
        const restricted = [...document.querySelectorAll('[role="dialog"], [role="alert"]')].some(element => visible(element) && restriction.test(element.textContent ?? "")) || !composer && restriction.test(document.body?.innerText ?? "");
        return { url: location.href, composer, login, workspace, restricted, loading: document.readyState === "loading" };
      }, museComposerSelector);
      return classifyMusePage(state);
    } catch { return page.isClosed()
      ? { status: "disconnected", message: "Muse 后台连接已关闭，正在等待重连原任务。" }
      : { status: "checking", message: "Muse 页面正在加载，正在同步登录状态…" }; }
  }
  async login() {
    await this.ready;
    this.reconnectEnabled = true;
    await this.persistBrowserState();
    const context = await this.launch();
    await this.ensurePage(context);
    await this.session();
    if (!this.loginPage || this.loginPage.isClosed()) await this.ensurePage(context);
    return this.session();
  }
  async importSession(value: unknown): Promise<MuseSession> {
    const snapshot = validateMuseSessionImport(value);
    await this.ready;
    if (this.running || this.pending.size || this.activePages.size)
      throw new MuseBridgeError("Muse 正在处理画布任务，请完成后同步登录状态。", 409);
    this.reconnectEnabled = true;
    await this.persistBrowserState();
    const context = await this.launch();
    if (snapshot.cookies.length) await context.addCookies(snapshot.cookies);
    const page = await this.ensurePage(context);
    if (!isMusePageUrl(page.url())) await page.goto(MUSE, { waitUntil: "domcontentloaded", timeout: 0 });
    const storage = snapshot.origins[0]?.localStorage ?? [];
    if (storage.length) await page.evaluate(entries => {
      for (const entry of entries) localStorage.setItem(entry.name, entry.value);
    }, storage);
    if (snapshot.cookies.length || storage.length) await page.reload({ waitUntil: "domcontentloaded", timeout: 0 });
    return this.session();
  }
  async exportSession(): Promise<ImportedSession> {
    await this.ready;
    if (!this.context && !this.reconnectEnabled) return { cookies: [], origins: [] };
    const context = await this.launch();
    let temporary: Page | undefined;
    try {
      // storageState can omit persisted localStorage until an origin is visited.
      // Use a separate hidden page rather than navigating an active task page.
      if (!context.pages().some(page => !page.isClosed() && isMusePageUrl(page.url()))) {
        temporary = await context.newPage();
        await temporary.goto(MUSE, { waitUntil: "domcontentloaded", timeout: 0 });
      }
      return filterMuseSessionExport(await context.storageState());
    } finally { await temporary?.close().catch(() => {}); }
  }
  /** The canvas mirrors this same headless page; no second browser session is opened. */
  private async viewerPage(): Promise<Page> {
    await this.ready;
    if (!this.reconnectEnabled) {
      this.reconnectEnabled = true;
      await this.persistBrowserState();
    }
    const context = await this.launch();
    const usable = (page?: Page): page is Page => Boolean(page && !page.isClosed() && !this.stoppedPages.has(page) && context.pages().includes(page));
    if (usable(this.viewerFocusedPage)) return this.viewerFocusedPage;
    const candidate = [this.loginPage, this.workPage, ...context.pages().filter(page => isMusePageUrl(page.url())).reverse()]
      .find(page => usable(page));
    const page = candidate ?? await this.ensurePage(context);
    this.observePage(page);
    this.viewerFocusedPage = page;
    return page;
  }
  async viewerFrame(requestedSize: unknown = {}): Promise<{ bytes: Buffer; width: number; height: number }> {
    if (!requestedSize || typeof requestedSize !== "object" || Array.isArray(requestedSize))
      throw new MuseBridgeError("Muse 画面尺寸无效。", 400);
    const requested = requestedSize as Record<string, unknown>;
    if (Object.keys(requested).some(key => key !== "width" && key !== "height") ||
      (requested.width === undefined) !== (requested.height === undefined))
      throw new MuseBridgeError("Muse 画面尺寸无效。", 400);
    const sized = requested.width !== undefined;
    if (sized && (typeof requested.width !== "number" || typeof requested.height !== "number" ||
      !Number.isInteger(requested.width) || !Number.isInteger(requested.height) ||
      (requested.width as number) < 320 || (requested.width as number) > 3840 ||
      (requested.height as number) < 240 || (requested.height as number) > 2160))
      throw new MuseBridgeError("Muse 画面尺寸无效。", 400);
    const page = await this.viewerPage();
    if (sized) {
      const size = { width: requested.width as number, height: requested.height as number };
      const current = page.viewportSize();
      if (!current || current.width !== size.width || current.height !== size.height)
        await page.setViewportSize(size);
    }
    const [{ width, height }, bytes] = await Promise.all([
      page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
      page.screenshot({ type: "jpeg", quality: 90, scale: "css" }),
    ]);
    return { bytes, width, height };
  }
  async viewerInput(value: unknown): Promise<{ ok: true }> {
    const input = value as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new MuseBridgeError("Muse 画布窗口输入无效。", 400);
    const type = input.type;
    if (!["click", "wheel", "key", "text"].includes(String(type))) throw new MuseBridgeError("Muse 画布窗口操作无效。", 400);
    const page = await this.viewerPage();
    if (this.mutatingPages.has(page)) throw new MuseBridgeError("Muse 正在接收画布任务，请等待发送完成再操作聊天。", 409);
    const number = (field: string) => {
      const value = input[field];
      if (typeof value !== "number" || !Number.isFinite(value)) throw new MuseBridgeError(`Muse 画布窗口 ${field} 无效。`, 400);
      return value;
    };
    if (type === "click" || type === "wheel") {
      const x = number("x"), y = number("y");
      const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      if (x < 0 || y < 0 || x >= size.width || y >= size.height) throw new MuseBridgeError("Muse 画布窗口坐标无效。", 400);
      await page.mouse.move(x, y);
      if (type === "click") {
        const button = input.button ?? "left";
        if (button !== "left" && button !== "right" && button !== "middle") throw new MuseBridgeError("Muse 画布窗口鼠标按键无效。", 400);
        await page.mouse.click(x, y, { button });
      } else {
        const deltaX = input.deltaX === undefined ? 0 : number("deltaX");
        const deltaY = number("deltaY");
        if (Math.abs(deltaX) > 10000 || Math.abs(deltaY) > 10000) throw new MuseBridgeError("Muse 画布窗口滚动距离无效。", 400);
        await page.mouse.wheel(deltaX, deltaY);
      }
    } else if (type === "key") {
      if (typeof input.key !== "string" || !/^(?:Enter|Backspace|Tab|Escape|Delete|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Space|Shift\+(?:Enter|Tab|Arrow(?:Up|Down|Left|Right))|(?:Control|Meta|ControlOrMeta)\+(?:A|C|V|X|Z|Y))$/.test(input.key))
        throw new MuseBridgeError("Muse 画布窗口按键无效。", 400);
      await page.keyboard.press(input.key);
    } else {
      if (typeof input.text !== "string" || input.text.length > 65536) throw new MuseBridgeError("Muse 画布窗口文字无效。", 400);
      await page.keyboard.insertText(input.text);
    }
    return { ok: true };
  }
  async viewerUpload(file: { path: string; name: string; mime: string }): Promise<{ ok: true }> {
    const page = await this.viewerPage();
    if (this.mutatingPages.has(page)) throw new MuseBridgeError("Muse 正在接收画布任务，请等待发送完成再上传。", 409);
    try { await uploadMuseReferences(page, [file], () => page.isClosed(), { append: true }); }
    catch (error) {
      if (error instanceof MuseUploadError) throw new MuseBridgeError(error.message, 422);
      throw error;
    }
    return { ok: true };
  }
  async disconnect() {
    await this.ready;
    if (this.running || this.pending.size) throw new MuseBridgeError("Muse 仍有任务运行，请等待结果；断开后台连接会中断本机观察。", 409);
    this.reconnectEnabled = false;
    await this.persistBrowserState();
    const context = this.context ?? await this.launching?.catch(() => undefined);
    await context?.close();
    return this.session();
  }
  async get(id: string) {
    await this.ready;
    const job = this.jobs.get(id);
    if (!job) throw new MuseBridgeError("本机未找到原 Muse 任务，未重新提交。请在 Muse 中核对生成历史。", 404);
    return this.publicJob(job);
  }
  async create(value: unknown) {
    await this.ready;
    const request = validateMuseRequest(value);
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const old = this.jobs.get(request.id);
    if (old) { if (old.status !== "cancelled" && old.hash !== hash) throw new MuseBridgeError("相同任务编号的输入发生变化，未重复提交。", 409); return this.publicJob(old); }
    for (const ref of request.references) if (ref.uploadId) {
      const stored = await this.references.resolve(request.id, ref.uploadId);
      if (stored.mime !== ref.mime) throw new MuseBridgeError("参考素材类型与已上传文件不一致。");
    }
    const session = await this.session();
    const stopped = this.jobs.get(request.id);
    if (stopped && this.isCancelled(stopped)) return this.publicJob(stopped);
    if (session.status !== "connected") throw new MuseBridgeError("Muse 账号未登录或会话已过期；请点击画布左侧的 Muse 图标，在画布窗口中登录后重试。", 401);
    const concurrent = this.jobs.get(request.id);
    if (concurrent) { if (concurrent.status !== "cancelled" && concurrent.hash !== hash) throw new MuseBridgeError("相同任务编号的输入发生变化，未重复提交。", 409); return this.publicJob(concurrent); }
    // Reserve the ID synchronously before any await: concurrent POSTs coalesce.
    const job: SavedJob = { id: request.id, kind: request.kind, status: "queued", hash, submitted: false, baseline: [], createdAt: Date.now() };
    this.jobs.set(job.id, job);
    try { await this.persist(); } catch {
      if (this.isCancelled(job)) return this.publicJob(job);
      job.status = "failed"; job.error = "本机任务记录写入失败，尚未向 Muse 提交。请检查磁盘后新建任务。";
      throw new MuseBridgeError(job.error, 503);
    }
    if (this.isCancelled(job)) return this.publicJob(job);
    this.pending.set(job.id, request);
    void this.drain();
    return this.publicJob(job);
  }
  async resume(id: string) {
    await this.ready;
    const job = this.jobs.get(id);
    if (!job) throw new MuseBridgeError("原 Muse 任务不存在，未重新生成。", 404);
    if (job.status !== "interrupted") return this.publicJob(job);
    if (!job.submitted) throw new MuseBridgeError("此任务尚未发送到 Muse，请重新生成。", 409);
    this.reconnectEnabled = true;
    await this.persistBrowserState();
    const context = await this.launch();
    if (this.isCancelled(job)) return this.publicJob(job);
    if (!context.pages().some(page => !page.isClosed() && !this.stoppedPages.has(page) && isMusePageUrl(page.url())))
      await this.ensurePage(context);
    if (!job.conversationUrl && !await this.findMarkedPage(job))
      throw new MuseBridgeError("没有可确认的原 Muse 会话地址，后台也未找到原消息；不会自动重发。", 409);
    if (job.status !== "interrupted") return this.publicJob(job);
    job.status = "queued"; job.error = undefined; job.recovery = undefined;
    try { await this.persist(); } catch {
      if (this.isCancelled(job)) return this.publicJob(job);
      job.status = "interrupted"; job.error = "原任务记录暂时无法保存，请检查磁盘后恢复查询。";
      throw new MuseBridgeError(job.error, 503);
    }
    if (this.isCancelled(job)) return this.publicJob(job);
    this.pending.set(id, undefined); void this.drain();
    return this.publicJob(job);
  }
  private isCancelled(job: SavedJob) { return job.status === "cancelled" || this.cancellations.get(job.id)?.signal.aborted === true; }
  private markCancelled(job: SavedJob) {
    job.status = "cancelled";
    job.message = job.submitted
      ? "已停止本机跟踪；Muse 已接收的任务可能继续，可在原网页查看。"
      : "已从本机队列移除，未发送到 Muse。";
    job.error = undefined;
    job.recovery = undefined;
  }
  private assertActive(job: SavedJob) {
    if (this.isCancelled(job)) { this.markCancelled(job); throw new MuseBridgeError("任务已停止。"); }
  }
  /** Cancel interrupts waits, without a deadline or a second send attempt. */
  private async jobStep<T>(job: SavedJob, action: () => Promise<T>): Promise<T> {
    this.assertActive(job);
    let control = this.cancellations.get(job.id);
    if (!control) { control = new AbortController(); this.cancellations.set(job.id, control); }
    const signal = control.signal;
    let onAbort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new MuseBridgeError("任务已停止。"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const result = await Promise.race([action(), cancelled]);
      this.assertActive(job);
      return result;
    } finally { signal.removeEventListener("abort", onAbort); }
  }
  private async mutatePage<T>(job: SavedJob, page: Page, action: () => Promise<T>): Promise<T> {
    this.mutatingPages.add(page);
    try { return await this.jobStep(job, action); }
    finally { this.mutatingPages.delete(page); }
  }
  async cancel(id: string) {
    await this.ready;
    if (!safeId.test(id)) throw new MuseBridgeError("Muse 任务编号无效。");
    let job = this.jobs.get(id);
    if (job && ["completed", "failed"].includes(job.status)) return this.publicJob(job);
    // A stop can arrive before uploads/create. The durable tombstone wins that race.
    if (!job) {
      job = { id, status: "cancelled", kind: "image", hash: "", submitted: false, baseline: [], createdAt: Date.now() };
      this.jobs.set(id, job);
    }
    this.markCancelled(job);
    this.pending.delete(id);
    this.cancellations.get(id)?.abort();
    const page = this.activePages.get(id);
    if (page && this.mutatingPages.has(page)) {
      // Only unfinished upload/fill/send operations need a page close to prevent
      // a late send. Observation/download cancellation must leave the chat open.
      this.stoppedPages.add(page);
      if (this.workPage === page) this.workPage = undefined;
      if (this.loginPage === page) this.loginPage = undefined;
      // Close the active app page immediately to interrupt any delayed
      // fill/upload/send. The next request restores the same persistent profile.
      void page.close({ runBeforeUnload: false }).catch(() => {});
    }
    await this.persist();
    return this.publicJob(job);
  }
  private async findMarkedPage(job: SavedJob): Promise<Page | undefined> {
    const reference = job.turnAnchor ?? job.turnMarker;
    if (!reference) return;
    const matches: Page[] = [];
    for (const page of this.context?.pages() ?? []) {
      if (this.stoppedPages.has(page) || page.isClosed() || !isMusePageUrl(page.url())) continue;
      let delivery;
      try { delivery = await readMuseDeliveryState(page, reference); }
      catch { continue; } // An unrelated tab may be navigating or closing.
      if (delivery.state === "ambiguous") return;
      if (delivery.state !== "missing") matches.push(page);
    }
    return matches.length === 1 ? matches[0] : undefined;
  }
  private async drain() {
    if (this.running || this.closing) return;
    this.running = true;
    try {
      while (this.pending.size && !this.closing) {
        const [id, request] = this.pending.entries().next().value!;
        this.pending.delete(id);
        const job = this.jobs.get(id)!;
        if (this.isCancelled(job)) continue;
        try { await this.run(job, request); }
        catch (error) {
          if (this.isCancelled(job)) continue;
          job.status = job.submitted ? "interrupted" : "failed";
          const page = this.activePages.get(id);
          job.recovery = job.submitted ? (!this.context || page?.isClosed() ? "reconnect" : "manual") : undefined;
          job.error = error instanceof MuseBridgeError || error instanceof MuseUploadError ? error.message : "Muse 页面连接或结果读取中断，请在画布中恢复查询。";
          await this.persist().catch(() => {});
        } finally {
          if (this.isCancelled(job)) { this.markCancelled(job); await this.persist().catch(() => {}); }
          this.activePages.delete(id); this.cancellations.delete(id);
        }
      }
    } finally { this.running = false; }
  }
  private async run(job: SavedJob, request?: MuseJobRequest) {
    this.assertActive(job);
    job.recovery = undefined;
    job.status = "loading"; job.message = request ? "正在检查 Muse 网页，尚未发送生成请求" : "正在打开原 Muse 聊天，恢复查询";
    await this.jobStep(job, () => this.persist());
    const context = await this.jobStep(job, () => this.launch());
    // Keep one browser page and its conversation across successful generations.
    // Only recreate a page if the user explicitly closed every Muse page.
    let chosenPage = !request ? await this.jobStep(job, () => this.findMarkedPage(job)) : undefined;
    if (!request && !job.conversationUrl && !chosenPage)
      throw new MuseBridgeError("当前窗口未找到原 Muse 消息，请打开原聊天后恢复查询；不会自动重发。");
    chosenPage ??= this.workPage && !this.workPage.isClosed() && !this.stoppedPages.has(this.workPage) ? this.workPage : undefined;
    if (request && chosenPage && (await this.jobStep(job, () => this.pageSession(chosenPage!))).status !== "connected" && this.loginPage && !this.loginPage.isClosed() && (await this.jobStep(job, () => this.pageSession(this.loginPage!))).status === "connected")
      chosenPage = this.loginPage;
    chosenPage ??= this.loginPage && !this.loginPage.isClosed() && !this.stoppedPages.has(this.loginPage) && isMusePageUrl(this.loginPage.url()) ? this.loginPage : undefined;
    chosenPage ??= context.pages().find(candidate => !this.stoppedPages.has(candidate) && !candidate.isClosed() && isMusePageUrl(candidate.url()));
    chosenPage ??= context.pages().find(candidate => !this.stoppedPages.has(candidate) && !candidate.isClosed() && candidate.url() === "about:blank");
    chosenPage ??= context.pages().find(candidate => !this.stoppedPages.has(candidate) && !candidate.isClosed());
    if (!chosenPage) throw new MuseBridgeError("Muse 后台页面已关闭，请重新连接后继续；原任务不会自动重发。", 503);
    const page = chosenPage;
    this.observePage(page);
    this.workPage = page;
    this.activePages.set(job.id, page);
    const captureConversation = () => this.captureConversation(page, job);
    const onNavigation = () => { void captureConversation().catch(() => {}); };
    page.on("framenavigated", onNavigation);
    const signals = await attachMusePageSignals(page);
    try {
      this.assertActive(job);
      if (page.url() !== "about:blank" && !isMusePageUrl(page.url()))
        throw new MuseBridgeError("Muse 登录状态失效，当前任务尚未提交。", 401);
      if (!request && job.conversationUrl === MUSE + "/") await captureConversation();
      if (!request && job.conversationUrl && museConversationUrl(page.url()) !== job.conversationUrl)
        await this.jobStep(job, () => page.goto(job.conversationUrl!, { waitUntil: "domcontentloaded" }));
      else if (page.url() === "about:blank") await this.jobStep(job, () => page.goto(MUSE, { waitUntil: "domcontentloaded" }));
      let session = await this.jobStep(job, () => this.pageSession(page));
      while (session.status === "checking" && !page.isClosed() && !this.closing) {
        const message = session.message ?? "正在等待 Muse 网页就绪，尚未发送";
        if (job.message !== message) { job.message = message; await this.jobStep(job, () => this.persist()); }
        await this.jobStep(job, () => delay()); session = await this.jobStep(job, () => this.pageSession(page));
      }
      if (session.status !== "connected") throw new MuseBridgeError(session.message ?? "Muse 账号未连接。");
      if (request) {
        await this.jobStep(job, () => this.waitForSendReadiness(page, job));
        const composer = page.locator(museComposerSelector).filter({ visible: true }).first();
        if (!await this.jobStep(job, () => composer.count())) throw new MuseBridgeError("未识别到 Muse 输入框，尚未发送。请检查账号状态后重试。");
        const draft = await this.jobStep(job, () => composer.evaluate(element => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? element.value : element.textContent ?? ""));
        if (draft.trim()) throw new MuseBridgeError("Muse 原会话中有未发送的内容，请先确认或清空草稿，再从画布生成。");
        const stopSelector = '[data-testid="hatch-composer-stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]';
        if (await this.jobStep(job, () => page.locator(stopSelector).filter({ visible: true }).count()))
          throw new MuseBridgeError("Muse 当前聊天仍在生成，请等待它完成后再从画布提交。");
        if (request.references.length) {
          job.status = "uploading"; job.message = "正在上传参考图片、视频或音频"; await this.jobStep(job, () => this.persist());
          const files = await this.jobStep(job, () => Promise.all(request.references.map(async ref => ref.uploadId
            ? await this.references.resolve(job.id, ref.uploadId) : ref)));
          await this.mutatePage(job, page, () => uploadMuseReferences(page, files, () => this.closing || this.isCancelled(job)));
        } else await this.mutatePage(job, page, () => uploadMuseReferences(page, [], () => this.closing || this.isCancelled(job)));
        await this.jobStep(job, () => this.revealLatestMessages(page));
        job.turnAnchor = await this.jobStep(job, () => prepareMuseTurnAnchor(page, request.prompt));
        await this.mutatePage(job, page, () => composer.fill(museGenerationPrompt(request)));
        const send = page.getByRole("button", { name: /^(发送|send)( message|消息)?$/i }).first();
        if (!await this.jobStep(job, () => send.count())) throw new MuseBridgeError("未识别到 Muse 发送按钮，尚未提交生成。请检查账号状态后重试。");
        job.message = "正在等待 Muse 上传完成及发送按钮就绪，尚未发送"; await this.jobStep(job, () => this.persist());
        while (true) {
          if (page.isClosed() || this.closing) throw new MuseBridgeError("Muse 连接已关闭，尚未提交生成。");
          const error = await this.jobStep(job, () => museUploadError(page)); if (error) throw new MuseUploadError(error);
          const session = await this.jobStep(job, () => this.pageSession(page));
          if (["login-required", "waiting-list", "disconnected"].includes(session.status))
            throw new MuseBridgeError(session.message ?? "Muse 连接已改变，尚未提交生成。");
          const readiness = await this.jobStep(job, () => readMuseSendReadiness(page));
          if (readiness.ready && await this.jobStep(job, () => send.isEnabled()) && !await this.jobStep(job, () => museUploadPending(page))) break;
          const message = readiness.message || "正在等待 Muse 上传完成及发送按钮就绪，尚未发送";
          if (job.message !== message) { job.message = message; await this.jobStep(job, () => this.persist()); }
          await this.jobStep(job, () => delay());
        }
        await this.jobStep(job, () => captureConversation());
        // Durable uncertain boundary BEFORE the only send click. Never click twice.
        job.submitted = true; job.status = "submitting"; job.message = "正在确认 Muse 已接收任务"; await this.jobStep(job, () => this.persist());
        await this.mutatePage(job, page, () => send.click());
        await this.jobStep(job, () => captureConversation());
      }
      // Resumes only observe the original turn; an optimistic bubble is not a
      // server acknowledgement, including for jobs created by the older bridge.
      if ((job.turnAnchor || job.turnMarker) && !job.deliveryConfirmed)
        await this.jobStep(job, () => this.waitForAcceptance(page, job, signals));
      job.status = "generating"; job.message = "等待 Muse 返回实际生成结果"; await this.jobStep(job, () => this.persist());
      let signature = "", stableSince = 0, wasBusy = true;
      while (!this.closing) {
        const revision = signals.revision();
        if (page.isClosed()) throw new MuseBridgeError("Muse 窗口已关闭，请重新打开后恢复原任务。");
        await this.jobStep(job, () => captureConversation());
        if (job.turnAnchor || job.turnMarker) this.checkDeliveryFailure(await this.jobStep(job, () => readMuseDeliveryState(page, (job.turnAnchor ?? job.turnMarker)!)));
        const state = await this.jobStep(job, () => this.pageSession(page));
        if (state.status === "checking") { await this.jobStep(job, () => signals.wait(revision)); continue; }
        if (state.status === "waiting-list" || state.status === "login-required") throw new MuseBridgeError(state.message ?? "请重新登录 Muse。");
        await this.jobStep(job, () => this.revealLatestMessages(page));
        if (job.conversationUrl && museConversationUrl(page.url()) !== job.conversationUrl)
          throw new MuseBridgeError("Muse 已离开原聊天，请恢复查询原任务。");
        const reference = job.turnAnchor ?? job.turnMarker;
        const media = (await this.jobStep(job, () => readMuseMedia(page, reference))).filter(m => m.kind === job.kind && (reference || !job.baseline.includes(m.src)) && m.width > 0 && m.height > 0);
        const activity = await this.jobStep(job, () => readMuseActivity(page));
        const activityMessage = activity?.working ? `Muse ${activity.message ?? "正在工作"}` : "等待 Muse 返回实际生成结果";
        if (job.message !== activityMessage) { job.message = activityMessage; await this.jobStep(job, () => this.persist()); }
        const stop = await this.jobStep(job, () => page.locator('[data-testid="hatch-composer-stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]').filter({ visible: true }).count());
        const next = media.map(m => m.src).join("\n");
        // Real page/network events can arrive in a burst. Preserve the original
        // media-settling interval instead of counting each event as another poll.
        const busy = Boolean(stop || activity?.working);
        if (!next || next !== signature || busy || wasBusy) stableSince = Date.now();
        wasBusy = busy;
        signature = next;
        if (media.length && Date.now() - stableSince >= 3000 && !stop && !activity?.working) {
          job.status = "saving"; job.message = "Muse 已返回结果，正在保存原始媒体"; await this.jobStep(job, () => this.persist());
          await this.jobStep(job, () => this.download(page, job, media));
          job.status = "completed"; job.message = "结果已保存在本机"; job.error = undefined; await this.jobStep(job, () => this.persist());
          return;
        }
        const rejection = await this.jobStep(job, () => page.locator('[role="alert"]').allTextContents());
        if (rejection.some(text => /quota|limit reached|额度|已达上限|生成失败|generation failed/i.test(text))) throw new MuseBridgeError("Muse 提示额度不足或生成失败，请在原会话查看详情。");
        await this.jobStep(job, () => signals.wait(revision));
      }
      throw new MuseBridgeError("本机观察已停止，可恢复查询原 Muse 任务。");
    } finally {
      await signals.dispose();
      this.mutatingPages.delete(page);
      page.off("framenavigated", onNavigation);
      if (request) await this.references.cleanup(job.id).catch(() => {});
    }
  }
  private async captureConversation(page: Page, job: SavedJob) {
    this.assertActive(job);
    const url = museConversationUrl(page.url());
    if (!url || job.conversationUrl === url) return;
    if (job.conversationUrl && job.conversationUrl !== MUSE + "/") return;
    let delivery: Awaited<ReturnType<typeof readMuseDeliveryState>> | undefined;
    if (job.submitted && (job.turnAnchor || job.turnMarker)) {
      delivery = await this.jobStep(job, () => readMuseDeliveryState(page, (job.turnAnchor ?? job.turnMarker)!));
      if (["missing", "ambiguous"].includes(delivery.state) || museConversationUrl(page.url()) !== url) return delivery;
    }
    job.conversationUrl = url;
    await this.jobStep(job, () => this.persist());
    return delivery;
  }
  private async revealLatestMessages(page: Page) {
    await page.evaluate(() => {
      const transcript = document.querySelector('[data-scrolltracepolicy="hatch.chat.scroll"]');
      const candidates = transcript ? [transcript] : [...document.querySelectorAll("main div")];
      for (const element of candidates) {
        const style = getComputedStyle(element);
        if (/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 100)
          element.scrollTop = element.scrollHeight;
      }
    });
  }
  private async waitForSendReadiness(page: Page, job: SavedJob) {
    while (!this.closing && !page.isClosed()) {
      const session = await this.jobStep(job, () => this.pageSession(page));
      if (["login-required", "waiting-list", "disconnected"].includes(session.status))
        throw new MuseBridgeError(session.message ?? "Muse 连接已改变，尚未提交生成。");
      const readiness = await this.jobStep(job, () => readMuseSendReadiness(page));
      if (readiness.ready) return;
      const message = readiness.message || "正在等待 Muse 连接就绪，尚未发送";
      if (job.message !== message) { job.message = message; await this.jobStep(job, () => this.persist()); }
      await this.jobStep(job, () => delay());
    }
    throw new MuseBridgeError("Muse 连接已关闭，尚未提交生成。");
  }
  private checkDeliveryFailure(delivery: Awaited<ReturnType<typeof readMuseDeliveryState>>) {
    if (delivery.state === "unconfirmed" && !/^(?:message\s+)?(?:still sending|仍在发送|仍在發送)[.。…\s]*$/i.test(delivery.message ?? ""))
      throw new MuseBridgeError("Muse 网页显示“未确认送达”，尚不能确认任务已被接收。请在原消息处检查连接或送达状态，再恢复查询；画布不会自动重发。");
    if (delivery.state === "failed")
      throw new MuseBridgeError("Muse 网页报告消息发送失败。请在原消息处处理后恢复查询；画布已保留原任务，不会自动重发。");
    if (delivery.state === "ambiguous")
      throw new MuseBridgeError("原 Muse 消息的任务标记重复，无法确认对应回复。请在原聊天核对，未自动重发。");
  }
  private async waitForAcceptance(page: Page, job: SavedJob, signals: MusePageSignals) {
    job.status = "submitting"; job.message = "正在确认 Muse 消息送达，尚未确认开始生成"; await this.jobStep(job, () => this.persist());
    while (!this.closing) {
      const revision = signals.revision();
      if (page.isClosed()) throw new MuseBridgeError("Muse 连接已关闭，发送结果尚未确认；已保留原任务，不会自动重发。");
      await this.jobStep(job, () => this.revealLatestMessages(page));
      const capturedDelivery = await this.jobStep(job, () => this.captureConversation(page, job));
      if (!isMusePageUrl(page.url()) || job.conversationUrl && museConversationUrl(page.url()) !== job.conversationUrl)
        throw new MuseBridgeError("Muse 已离开原聊天，消息送达尚未确认。请回到原聊天后恢复查询，不会自动重发。");
      const session = await this.jobStep(job, () => this.pageSession(page));
      if (["login-required", "waiting-list", "disconnected"].includes(session.status))
        throw new MuseBridgeError(session.message ?? "Muse 连接已改变，请重新连接后恢复查询原消息。");
      const error = await this.jobStep(job, () => museUploadError(page)); if (error) throw new MuseUploadError(error);
      const delivery = capturedDelivery ?? await this.jobStep(job, () => readMuseDeliveryState(page, (job.turnAnchor ?? job.turnMarker)!));
      if (delivery.diagnostic) {
        const observation = { state: delivery.state, diagnostic: delivery.diagnostic };
        if (JSON.stringify(job.observation) !== JSON.stringify(observation)) {
          job.observation = observation; await this.jobStep(job, () => this.persist());
        }
      }
      this.checkDeliveryFailure(delivery);
      if (delivery.state === "accepted") { job.deliveryConfirmed = true; await this.jobStep(job, () => this.persist()); return; }
      const activity = await this.jobStep(job, () => readMuseActivity(page));
      const diagnostic = delivery.diagnostic;
      const latestTurnMatched = diagnostic?.candidateHashMatches && diagnostic.prefixMatches
        && diagnostic.targetIndex === diagnostic.userCount - 1;
      // The avatar belongs to the conversation. Associate it only after this
      // submission's full prompt and context identify the latest user turn.
      if (delivery.state === "pending" && latestTurnMatched && activity?.working) {
        job.deliveryConfirmed = true; job.message = `Muse ${activity.message ?? "正在工作"}`;
        await this.jobStep(job, () => this.persist()); return;
      }
      if (activity?.working) {
        const message = `Muse ${activity.message ?? "正在工作"}，正在关联原消息`;
        if (job.message !== message) { job.message = message; await this.jobStep(job, () => this.persist()); }
      }
      await this.jobStep(job, () => signals.wait(revision));
    }
    throw new MuseBridgeError("本机跟踪已停止，发送结果尚未确认；已保留原任务，不会自动重发。");
  }
  private async download(page: Page, job: SavedJob, media: Media[]) {
    const directory = path.join(this.root, "media", job.id);
    await this.jobStep(job, () => fs.mkdir(directory, { recursive: true, mode: 0o700 }));
    const outputs: NonNullable<MuseJob["outputs"]> = [];
    for (const selected of media) {
      if (!museMediaUrl(selected.src)) throw new MuseBridgeError("Muse 结果来自未识别的媒体地址，已保留原任务，请核对原结果。");
      let bytes: Buffer;
      if (selected.src.startsWith("blob:")) {
        const encoded = await this.jobStep(job, () => page.evaluate(async src => {
          const response = await fetch(src);
          if (!response.ok) throw new Error("Media fetch failed");
          const blob = await response.blob();
          return await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
        }, selected.src));
        bytes = Buffer.from(encoded, "base64");
      } else {
        let address = selected.src;
        for (let redirects = 0; ; redirects++) {
          const response = await this.jobStep(job, () => page.context().request.get(address, { timeout: 0, maxRedirects: 0 }));
          try {
            if ([301, 302, 303, 307, 308].includes(response.status()) && redirects < 5 && response.headers().location) {
              const next = new URL(response.headers().location, address).href;
              if (!museMediaUrl(next) || next.startsWith("blob:")) throw new MuseBridgeError("Muse 下载跳转到了未识别的地址，原任务已保留。");
              address = next; continue;
            }
            if (!response.ok()) throw new MuseBridgeError("Muse 结果下载暂未成功，请恢复原任务，画布不会重新生成。");
            bytes = await this.jobStep(job, () => response.body()); break;
          } finally { await response.dispose(); }
        }
      }
      const format = sniffMuseMedia(bytes);
      if (!format || !format.mime.startsWith(selected.kind + "/")) throw new MuseBridgeError("Muse 结果不是有效的目标媒体，未将附件、网页或封面当作生成结果。");
      const id = createHash("sha256").update(bytes).digest("hex");
      const name = `muse-${job.id.slice(0, 8)}-${outputs.length + 1}.${format.ext}`;
      await this.jobStep(job, () => fs.writeFile(path.join(directory, id), bytes, { mode: 0o600 }));
      outputs.push({ id, name, mime: format.mime, url: `/api/muse/jobs/${job.id}/media/${id}` });
      job.outputs = [...outputs]; await this.jobStep(job, () => this.persist());
    }
  }
  async media(id: string, outputId: string) {
    const job = await this.get(id);
    const output = job.outputs?.find(item => item.id === outputId);
    if (!safeId.test(id) || !safeId.test(outputId) || !output) throw new MuseBridgeError("Muse 结果不存在。", 404);
    return { ...output, path: path.join(this.root, "media", id, outputId) };
  }
  async close() {
    this.closing = true;
    const context = this.context ?? await this.launching?.catch(() => undefined);
    await context?.close(); await this.writes.catch(() => {});
  }
}

