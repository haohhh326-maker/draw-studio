import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { AutoDLAccountSession, AutoDLInstanceSummary, AutoDLInstancesResult, AutoDLPairCode } from "../src/autodl/types";

export const AUTODL_EXTENSION_ID = "jbljcfjkacdepgllbhfokhjnmnjekbdl";
export const AUTODL_EXTENSION_ORIGIN = "chrome-extension://" + AUTODL_EXTENSION_ID;
export type AutoDLBridgeOperation = "list" | "status" | "power-on" | "power-off";
export type AutoDLBridgeCommand = { id: string; operation: AutoDLBridgeOperation; instanceUuid?: string; expiresAt: number };
const bridgePath = /^\/__canvas\/autodl\/bridge\/(pair|verify|disconnect|poll|result)$/;
export function isAutoDLBridgeRequest(request: IncomingMessage): boolean {
  return /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(request.headers.host ?? "") &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") &&
    request.headers.origin === AUTODL_EXTENSION_ORIGIN && ["POST", "OPTIONS"].includes(request.method ?? "") && bridgePath.test(request.url ?? "");
}
type AutoDLDiagnostics = { remoteCode?: unknown; httpStatus?: unknown; requestId?: unknown };

export class AutoDLBridgeError extends Error {
  readonly remoteCode?: string;
  readonly httpStatus?: number;
  readonly requestId?: string;
  constructor(message: string, public status = 503, public code = "BRIDGE_UNAVAILABLE", public dispatched?: boolean, public definitive = false,
    diagnostics: AutoDLDiagnostics = {}) {
    super(message);
    this.remoteCode = safeRemoteCode(diagnostics.remoteCode);
    this.httpStatus = safeHttpStatus(diagnostics.httpStatus);
    this.requestId = safeRequestId(diagnostics.requestId);
  }
}
const errorMessages = {
  LOGIN_REQUIRED: "AutoDL.Art 网页账号未登录或登录已过期，请在已配对的浏览器中重新登录。",
  NO_AUTODL_TAB: "请在已配对的浏览器中打开 AutoDL.Art 控制台页面。",
  NETWORK_ERROR: "浏览器暂时无法连接 AutoDL.Art，请检查网页网络。",
  CONTRACT_ERROR: "AutoDL.Art 返回的数据与当前接口不符，请更新浏览器扩展后重试。",
  INSTANCE_NOT_FOUND: "当前 AutoDL.Art 账号中找不到绑定的应用实例。",
  POWER_REJECTED: "AutoDL.Art 未接受开关机请求，请在控制台检查实例状态。",
  COMMAND_EXPIRED: "请求已过期，未执行开关机，请重试。",
  POWER_STATE_CONFLICT: "平台实例状态发生冲突，需要核对实际状态。",
  POWER_UNKNOWN: "平台未确认操作结果，需要核对并完成关机清理。",
  NO_GPU_CAPACITY: "当前算力规格暂无库存，请稍后重试或在官网调整规格。",
  ACCOUNT_PREREQUISITE: "AutoDL.Art 账号尚未满足操作条件，请在官网控制台处理后重试。",
  INSUFFICIENT_BALANCE: "AutoDL.Art 余额不足，请在官网确认余额后重试。",
  INSTANCE_EXPIRED: "AutoDL.Art 实例已到期，请在官网续费后重试。",
} as const;
type ErrorCode = keyof typeof errorMessages;

function safeRemoteCode(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,48}$/.test(value) ||
    /[A-Za-z0-9]{24,}|[a-f0-9]{16,}|^(?:sk-|gh[pousr]_|github_pat_|eyJ)/i.test(value)) return;
  return value;
}
function safeHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}
function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{32}$/i.test(value) ? value : undefined;
}

export function formatAutoDLDiagnostics(diagnostics: AutoDLDiagnostics): string {
  const remoteCode = safeRemoteCode(diagnostics.remoteCode);
  const httpStatus = safeHttpStatus(diagnostics.httpStatus);
  const requestId = safeRequestId(diagnostics.requestId);
  const details = [remoteCode && "平台码 " + remoteCode, httpStatus && "HTTP " + httpStatus, requestId && "请求 ID " + requestId].filter(Boolean);
  return details.length ? "（" + details.join("，") + "）" : "";
}

function commandErrorMessage(operation: AutoDLBridgeOperation, code: ErrorCode, diagnostics: AutoDLDiagnostics): string {
  const action = operation === "power-on" ? "启动 AutoDL 失败：" : operation === "power-off" ? "关闭 AutoDL 失败：" : "";
  return action + errorMessages[code].replace(/。$/, "") + formatAutoDLDiagnostics(diagnostics) + "。";
}
type Job = { command: AutoDLBridgeCommand; delivered: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Waiter = { key: string; resolve: (value: AutoDLBridgeCommand | { idle: true }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void };
export type AutoDLExtensionBrokerOptions = { now?: () => number; pollMs?: number; commandMs?: number; onlineMs?: number; pairTtlMs?: number };
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new AutoDLBridgeError("浏览器扩展请求格式无效。", 400, "CONTRACT_ERROR");
}
function instanceUuid(value: unknown): string {
  if (typeof value !== "string" || !/^pro-[A-Za-z0-9_-]{1,150}$/.test(value)) throw new AutoDLBridgeError("应用实例 ID 无效。", 400, "CONTRACT_ERROR");
  return value;
}
function platformState(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,79}$/.test(value)) throw new AutoDLBridgeError("扩展返回的实例状态无效。", 502, "CONTRACT_ERROR");
  return value;
}
function summary(value: unknown): AutoDLInstanceSummary {
  exact(value, ["instanceUuid", "name", "status"]);
  if (typeof value.name !== "string" || value.name.length > 240 || /[\x00-\x1f\x7f]/.test(value.name)) throw new AutoDLBridgeError("扩展返回的实例名称无效。", 502, "CONTRACT_ERROR");
  return { instanceUuid: instanceUuid(value.instanceUuid), name: value.name, status: platformState(value.status) };
}
function resultValue(operation: AutoDLBridgeOperation, value: unknown): unknown {
  if (operation === "list") {
    exact(value, ["instances"]);
    if (!Array.isArray(value.instances) || value.instances.length > 5000) throw new AutoDLBridgeError("扩展返回的实例列表无效。", 502, "CONTRACT_ERROR");
    const instances = value.instances.map(summary);
    if (new Set(instances.map(item => item.instanceUuid)).size !== instances.length) throw new AutoDLBridgeError("扩展实例列表出现重复 ID。", 502, "CONTRACT_ERROR");
    return { instances };
  }
  if (operation === "status") { exact(value, ["status"]); return { status: platformState(value.status) }; }
  exact(value, ["accepted"]);
  if (value.accepted !== true) throw new AutoDLBridgeError("扩展未确认官网接受操作。", 502, "CONTRACT_ERROR");
  return { accepted: true };
}

/** Commands contain no website credential. Only the paired official-page extension executes them. */
export class AutoDLExtensionBroker {
  private loaded?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private key?: string;
  private code?: { value: string; expiresAt: number; remaining: number };
  private lastPoll?: number;
  private jobs = new Map<string, Job>();
  private waiter?: Waiter;
  private polling = false;
  private waking = false;
  private closed = false;
  private generation = 0;
  private cachedList?: { result: AutoDLInstancesResult; until: number };
  private listing?: Promise<AutoDLInstancesResult>;
  private readonly now: () => number;
  private readonly directory: string;
  constructor(root: string, private readonly options: AutoDLExtensionBrokerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.directory = path.join(root, ".cache", "autodl-power");
  }
  revision() { return this.generation; }
  private async ready() {
    if (this.closed) throw new AutoDLBridgeError("浏览器扩展桥已关闭。");
    if (!this.loaded) this.loaded = (async () => {
      let saved: unknown;
      try { saved = JSON.parse(await fs.readFile(path.join(this.directory, "bridge.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new AutoDLBridgeError("本机扩展配对记录无法读取，请重新配对。", 500); }
      if (!object(saved) || saved.version !== 1 || saved.extensionId !== AUTODL_EXTENSION_ID || typeof saved.bridgeKey !== "string" || !/^[a-f0-9]{64}$/.test(saved.bridgeKey))
        throw new AutoDLBridgeError("本机扩展配对记录无效，请保留原记录后重试。", 500);
      this.key = saved.bridgeKey;
    })();
    await this.loaded;
  }
  private lock<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(action, action); this.writes = pending.then(() => undefined, () => undefined); return pending;
  }
  private async persist(name: string, value: unknown) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, name + "." + randomUUID() + ".tmp");
    try { await fs.writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" }); await fs.rename(temporary, path.join(this.directory, name)); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  private authorized(value: unknown): value is string {
    return typeof value === "string" && !!this.key && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(this.key));
  }
  private requireKey(value: unknown): asserts value is string { if (!this.authorized(value)) throw new AutoDLBridgeError("扩展尚未配对或配对已改变。", 401, "PAIR_REQUIRED"); }
  private online() { return !!this.key && this.lastPoll !== undefined && this.now() - this.lastPoll <= (this.options.onlineMs ?? 45_000); }
  hasOnlinePeer() { return this.online(); }
  async verify(value: unknown): Promise<{ ok: true }> {
    await this.ready(); exact(value, ["bridgeKey"]); this.requireKey(value.bridgeKey);
    return { ok: true };
  }
  async disconnect(value: unknown): Promise<{ ok: true }> {
    await this.ready(); exact(value, ["bridgeKey"]);
    return this.lock(async () => {
      this.requireKey(value.bridgeKey);
      await fs.rm(path.join(this.directory, "bridge.json"), { force: true });
      this.key = undefined; this.code = undefined; this.lastPoll = undefined; this.generation++; this.cachedList = undefined;
      const disconnected = new AutoDLBridgeError("浏览器已断开此画布。", 401, "PAIR_REQUIRED");
      for (const job of this.jobs.values()) { clearTimeout(job.timer); job.reject(disconnected); }
      this.jobs.clear(); this.finishWaiter(disconnected);
      return { ok: true };
    });
  }
  async pairCode(): Promise<AutoDLPairCode> {
    await this.ready();
    this.code = { value: randomBytes(4).toString("hex").toUpperCase(), expiresAt: this.now() + (this.options.pairTtlMs ?? 300_000), remaining: 5 };
    return { code: this.code.value, expiresAt: this.code.expiresAt };
  }
  async pair(value: unknown): Promise<{ bridgeKey: string }> {
    await this.ready(); exact(value, ["code"]);
    return this.lock(async () => {
      const code = typeof value.code === "string" ? value.code.trim().toUpperCase() : "";
      if (!this.code || this.code.expiresAt <= this.now() || this.code.remaining-- <= 0 || !/^[A-F0-9]{8}$/.test(code) || !timingSafeEqual(Buffer.from(code), Buffer.from(this.code.value)))
        throw new AutoDLBridgeError("配对码无效或已过期，请在本机画布重新获取。", 401, "PAIR_REQUIRED");
      const key = randomBytes(32).toString("hex");
      await this.persist("bridge.json", { version: 1, extensionId: AUTODL_EXTENSION_ID, bridgeKey: key });
      this.key = key; this.code = undefined; this.lastPoll = undefined; this.generation++; this.cachedList = undefined;
      for (const job of this.jobs.values()) { clearTimeout(job.timer); job.reject(new AutoDLBridgeError("浏览器扩展已重新配对，请重试原任务查询。")); }
      this.jobs.clear(); this.finishWaiter(new AutoDLBridgeError("浏览器扩展已重新配对。", 401, "PAIR_REQUIRED"));
      return { bridgeKey: key };
    });
  }
  private finishWaiter(error?: Error) {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = undefined; clearTimeout(waiter.timer); waiter.cleanup();
    if (error) waiter.reject(error); else waiter.resolve({ idle: true });
  }
  private async deliver(key: string): Promise<AutoDLBridgeCommand | undefined> {
    return this.lock(async () => {
      this.requireKey(key);
      const job = [...this.jobs.values()].find(item => !item.delivered);
      if (!job) return;
      if (job.command.expiresAt <= this.now()) return;
      if (job.command.operation === "power-on" || job.command.operation === "power-off")
        await this.persist("last-command.json", { ...job.command, state: "offered", offeredAt: this.now() });
      if (this.jobs.get(job.command.id) !== job || job.command.expiresAt <= this.now()) return;
      // Even a lost HTTP response must not cause an automatic mutation replay.
      job.delivered = true;
      return { ...job.command };
    });
  }
  private wake() {
    const waiter = this.waiter;
    if (!waiter || this.waking) return;
    this.waking = true;
    void this.deliver(waiter.key).then(command => {
      if (!command || this.waiter !== waiter) return;
      this.waiter = undefined; clearTimeout(waiter.timer); waiter.cleanup(); waiter.resolve(command);
    }).catch(error => this.finishWaiter(error)).finally(() => {
      this.waking = false;
      if (this.waiter && [...this.jobs.values()].some(job => !job.delivered)) this.wake();
    });
  }
  async poll(value: unknown, signal?: AbortSignal): Promise<AutoDLBridgeCommand | { idle: true }> {
    await this.ready(); exact(value, ["bridgeKey"]); this.requireKey(value.bridgeKey);
    if (this.polling) throw new AutoDLBridgeError("扩展已有正在等待的轮询。", 409);
    this.polling = true;
    try {
    this.lastPoll = this.now();
    const key = value.bridgeKey, command = await this.deliver(key);
    if (command) return command;
    return await new Promise((resolve, reject) => {
      const abort = () => this.finishWaiter(new AutoDLBridgeError("扩展轮询已中断。", 499));
      const timer = setTimeout(() => this.finishWaiter(), this.options.pollMs ?? 25_000); timer.unref();
      this.waiter = { key, resolve, reject, timer, cleanup: () => signal?.removeEventListener("abort", abort) };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else this.wake();
    });
    } finally { this.polling = false; }
  }
  async result(value: unknown): Promise<{ ok: true }> {
    await this.ready(); exact(value, ["bridgeKey", "id", "ok", "value", "errorCode", "remoteCode", "httpStatus", "requestId"]); this.requireKey(value.bridgeKey);
    if (typeof value.id !== "string" || typeof value.ok !== "boolean") throw new AutoDLBridgeError("扩展结果格式无效。", 400, "CONTRACT_ERROR");
    const job = this.jobs.get(value.id);
    if (!job || !job.delivered) throw new AutoDLBridgeError("扩展命令不存在、已超时或尚未投递。", 409, "STALE_COMMAND");
    let result: unknown, error: AutoDLBridgeError | undefined;
    try {
      if (value.ok) {
        if (value.errorCode !== undefined || value.remoteCode !== undefined || value.httpStatus !== undefined || value.requestId !== undefined)
          throw new AutoDLBridgeError("扩展结果不能同时成功和失败。", 400, "CONTRACT_ERROR");
        result = resultValue(job.command.operation, value.value);
      }
      else {
        if (value.value !== undefined || typeof value.errorCode !== "string" || !Object.hasOwn(errorMessages, value.errorCode)) throw new AutoDLBridgeError("扩展错误代码无效。", 400, "CONTRACT_ERROR");
        const code = value.errorCode as ErrorCode;
        const diagnostics = { remoteCode: value.remoteCode, httpStatus: value.httpStatus, requestId: value.requestId };
        error = new AutoDLBridgeError(commandErrorMessage(job.command.operation, code, diagnostics), code === "LOGIN_REQUIRED" ? 401 : code === "INSTANCE_NOT_FOUND" ? 404 : 502,
          code, code !== "COMMAND_EXPIRED" && code !== "NO_AUTODL_TAB",
          ["LOGIN_REQUIRED", "NO_AUTODL_TAB", "INSTANCE_NOT_FOUND", "POWER_REJECTED", "ACCOUNT_PREREQUISITE", "COMMAND_EXPIRED", "NO_GPU_CAPACITY",
            "INSUFFICIENT_BALANCE", "INSTANCE_EXPIRED"].includes(code), diagnostics);
      }
    } catch (failure) {
      this.jobs.delete(job.command.id); clearTimeout(job.timer); job.reject(failure as Error); throw failure;
    }
    if (job.command.operation === "power-on" || job.command.operation === "power-off")
      await this.lock(() => this.persist("last-command.json", { ...job.command, state: error ? error.definitive ? "rejected" : "unknown" : "answered", answeredAt: this.now(),
        ...(error ? { errorCode: error.code, remoteCode: error.remoteCode, httpStatus: error.httpStatus, requestId: error.requestId } : {}) }));
    if (this.jobs.get(job.command.id) !== job) throw new AutoDLBridgeError("扩展命令已超时，不接受迟到结果。", 409, "STALE_COMMAND");
    this.jobs.delete(job.command.id); clearTimeout(job.timer);
    if (error) job.reject(error); else job.resolve(result);
    return { ok: true };
  }
  async call(operation: AutoDLBridgeOperation, instance?: string): Promise<unknown> {
    await this.ready();
    if (!["list", "status", "power-on", "power-off"].includes(operation)) throw new AutoDLBridgeError("不支持此扩展操作。", 400);
    if (operation !== "list") instanceUuid(instance);
    if (!this.online()) {
      const message = this.key ? "AutoDL 浏览器扩展暂未连接。请启动已配对的 Edge 并确认扩展已启用，再点生成。"
        : "AutoDL 尚未配对。请在算力设置 → 云端 ComfyUI 中连接已登录的 Edge 浏览器，再点生成。";
      throw new AutoDLBridgeError(message, 503, "BRIDGE_UNAVAILABLE", false);
    }
    return new Promise((resolve, reject) => {
      const command: AutoDLBridgeCommand = { id: randomUUID(), operation, ...(operation === "list" ? {} : { instanceUuid: instance! }), expiresAt: this.now() + (this.options.commandMs ?? 45_000) };
      const timer = setTimeout(() => {
        const dispatched = this.jobs.get(command.id)?.delivered === true;
        this.jobs.delete(command.id); reject(new AutoDLBridgeError("浏览器扩展未及时确认操作；提交状态不明，不会自动重放开机命令。", 504, "COMMAND_TIMEOUT", dispatched));
      }, this.options.commandMs ?? 45_000); timer.unref();
      this.jobs.set(command.id, { command, delivered: false, resolve, reject, timer });
      this.wake();
    });
  }
  async instances(): Promise<AutoDLInstancesResult> {
    await this.ready();
    if (!this.online()) throw new AutoDLBridgeError("AutoDL 浏览器扩展未连接，请先配对并打开官网控制台。", 503);
    if (this.cachedList && this.cachedList.until > this.now()) return structuredClone(this.cachedList.result);
    if (!this.listing) {
      const generation = this.generation;
      this.listing = this.call("list").then(value => {
        const result = value as AutoDLInstancesResult;
        if (generation === this.generation) this.cachedList = { result, until: this.now() + 3_000 };
        return structuredClone(result);
      }).finally(() => { this.listing = undefined; });
    }
    return this.listing;
  }
  async session(): Promise<AutoDLAccountSession> {
    await this.ready();
    if (!this.online()) return { status: "disconnected", message: this.key ? "浏览器扩展暂未连接，请打开已配对的浏览器。" : "尚未配对 AutoDL.Art 浏览器扩展。" };
    try { await this.instances(); return { status: "connected", message: "已连接浏览器中的 AutoDL.Art 官网账号。" }; }
    catch (error) {
      const code = error instanceof AutoDLBridgeError ? error.code : "CONTRACT_ERROR";
      return { status: code === "LOGIN_REQUIRED" ? "login-required" : code === "NO_AUTODL_TAB" ? "disconnected" : "error", message: error instanceof AutoDLBridgeError ? error.message : errorMessages.CONTRACT_ERROR };
    }
  }
  async close() {
    this.closed = true; this.finishWaiter(new AutoDLBridgeError("本机扩展服务已关闭。"));
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.reject(new AutoDLBridgeError("本机服务已关闭，不会重放未确认的开机命令。")); }
    this.jobs.clear(); await this.writes;
  }
}
