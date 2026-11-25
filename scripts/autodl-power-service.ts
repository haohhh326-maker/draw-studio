import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AutoDLAcquireRequest, AutoDLLease, AutoDLPowerPhase, AutoDLPowerStatus, AutoDLSettingsInput } from "../src/autodl/types";
import { AutoDLExtensionBroker, AutoDLBridgeError, formatAutoDLDiagnostics } from "./autodl-extension-broker";
import { AutoDLBrowserService } from "./autodl-browser-service";

export class AutoDLPowerError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
type Credentials = { apiToken: string; instanceUuid: string };
type Settings = Credentials & { enabled: boolean; endpoint: string };
export interface AutoDLPlatform {
  status(credentials: Credentials): Promise<string>;
  checkStartup?(credentials: Credentials): Promise<string>;
  powerOn(credentials: Credentials): Promise<void>;
  powerOff(credentials: Credentials): Promise<void>;
  revision?(): number;
}
type SavedLease = AutoDLLease & { endpoint: string; taskId: string; attemptId: string; expiresAt: number; recovered?: boolean; message?: string };
type SavedState = { version: 1; settings: Settings; leases: SavedLease[]; pendingStop: boolean; phase: AutoDLPowerPhase;
  epoch?: number; powerOwned?: boolean; startRequestedAt?: number; waitStartedAt?: number; bootUncertainUntil?: number; bootObserved?: boolean; error?: string;
  bootVerification?: string; capacityRetryAt?: number; capacityRetryCount?: number };
type PowerOperation = { settings: Settings; epoch: number; accountRevision: number };
export type AutoDLPowerServiceOptions = {
  platform?: AutoDLPlatform;
  now?: () => number;
  retryMs?: number;
  leaseTtlMs?: number;
  startupTimeoutMs?: number;
  automaticTimer?: boolean;
  broker?: AutoDLExtensionBroker;
  browserAccount?: boolean;
  bootSettleMs?: number;
};
const initialState = (): SavedState => ({ version: 1, settings: { enabled: false, endpoint: "", instanceUuid: "", apiToken: "" }, leases: [], pendingStop: false, phase: "disabled" });
const active = (lease: SavedLease) => lease.phase === "starting" || lease.phase === "ready";
const bootableOffStates = new Set(["shutdown", "shutdown_by_starting_error", "shutdown_by_running_error"]);
const offStates = new Set([...bootableOffStates, "migrate_failed"]);
const isStartupBlocker = (error: unknown): error is AutoDLBridgeError =>
  error instanceof AutoDLBridgeError && (error.code === "INSUFFICIENT_BALANCE" || error.code === "INSTANCE_EXPIRED");
const bootVerificationMessage = "正在核对 AutoDL 开机状态，等待平台更新。";
const publicLease = ({ leaseId, instanceUuid, phase, error, message }: SavedLease): AutoDLLease => ({ leaseId, instanceUuid, phase, ...(error ? { error } : {}), ...(message ? { message } : {}) });
const clearCapacityRetry = (state: SavedState) => { state.capacityRetryAt = undefined; state.capacityRetryCount = undefined; for (const lease of state.leases) lease.message = undefined; };
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, name: string, maximum = 2048): string {
  if (typeof value !== "string" || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw new AutoDLPowerError(name + "格式无效。");
  return value.trim();
}
function endpoint(value: unknown): string {
  const source = text(value, "ComfyUI 地址");
  let address: URL;
  try { address = new URL(source); } catch { throw new AutoDLPowerError("请填写有效的 ComfyUI 地址。"); }
  if (!["http:", "https:"].includes(address.protocol) || address.username || address.password || address.search || address.hash)
    throw new AutoDLPowerError("ComfyUI 地址不能包含密钥、查询参数或片段。");
  return address.href.replace(/\/+$/, "");
}
function identifier(value: unknown, name: string): string {
  const result = text(value, name, 160);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new AutoDLPowerError(name + "格式无效。");
  return result;
}
function acquireInput(input: unknown): AutoDLAcquireRequest {
  if (!record(input) || Object.keys(input).some(key => !["endpoint", "instanceUuid", "taskId", "attemptId"].includes(key))) throw new AutoDLPowerError("AutoDL 任务租约格式无效。");
  return { endpoint: endpoint(input.endpoint), instanceUuid: identifier(input.instanceUuid, "应用实例 ID"),
    taskId: identifier(input.taskId, "任务 ID"), attemptId: identifier(input.attemptId, "执行 ID") };
}
const sameBinding = (settings: Settings, input: Pick<AutoDLAcquireRequest, "endpoint" | "instanceUuid">) => settings.endpoint === input.endpoint && settings.instanceUuid === input.instanceUuid;
const sameAttempt = (lease: SavedLease, input: AutoDLAcquireRequest) => lease.endpoint === input.endpoint && lease.instanceUuid === input.instanceUuid && lease.taskId === input.taskId && lease.attemptId === input.attemptId;
const bumpEpoch = (state: SavedState) => { state.epoch = (state.epoch ?? 0) + 1; };
function settingsInput(input: unknown, previous: Settings): Settings {
  if (!record(input) || typeof input.enabled !== "boolean" || Object.keys(input).some(key => !["enabled", "endpoint", "instanceUuid", "apiToken"].includes(key)))
    throw new AutoDLPowerError("AutoDL 设置格式无效。");
  const instanceUuid = text(input.instanceUuid, "应用实例 ID", 160);
  if (instanceUuid && !/^pro-[A-Za-z0-9_-]+$/.test(instanceUuid)) throw new AutoDLPowerError("请填写 AutoDL.Art 应用实例 ID。");
  const source = text(input.endpoint, "ComfyUI 地址");
  if (input.apiToken !== undefined) text(input.apiToken, "旧版凭据", 4096);
  if (input.enabled && (!source || !instanceUuid)) throw new AutoDLPowerError("启用前请填写 ComfyUI 地址和应用实例 ID，并连接 AutoDL.Art 账号。");
  const normalized = source ? endpoint(source) : "";
  const address = normalized ? new URL(normalized) : undefined;
  const official = address?.hostname.endsWith(".seetacloud.com") ? address.hostname.split(".")[0].match(/^u\d+-([a-f0-9]+)$/) : undefined;
  if (official && instanceUuid && instanceUuid !== "pro-" + official[1]) throw new AutoDLPowerError("AutoDL 官方服务地址与应用实例 ID 不一致，请选择对应实例。");
  return { enabled: input.enabled, endpoint: normalized, instanceUuid, apiToken: "" };
}

/** The extension uses the user's existing official page; website credentials never enter this process. */
export function createAutoDLPlatform(broker: Pick<AutoDLExtensionBroker, "call" | "revision">): AutoDLPlatform {
  return {
    async status(credentials) {
      const result = await broker.call("status", credentials.instanceUuid) as { status: string };
      return result.status;
    },
    async powerOn(credentials) { await broker.call("power-on", credentials.instanceUuid); },
    async powerOff(credentials) { await broker.call("power-off", credentials.instanceUuid); },
    revision: () => broker.revision(),
  };
}

export class AutoDLPowerService {
  private state = initialState();
  private initialized?: Promise<void>;
  private activated = false;
  private writes: Promise<unknown> = Promise.resolve();
  private working?: Promise<void>;
  private requested = false;
  private disposed = false;
  private timer?: ReturnType<typeof setInterval>;
  private transientError?: string;
  private readonly platform: AutoDLPlatform;
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly leaseTtlMs: number;
  private readonly startupTimeoutMs: number;
  private readonly file: string;
  private readonly broker: AutoDLExtensionBroker;
  private readonly browser?: AutoDLBrowserService;
  private readonly legacyTokens = new Set<string>();
  constructor(root: string, private readonly options: AutoDLPowerServiceOptions = {}) {
    this.broker = options.broker ?? new AutoDLExtensionBroker(root);
    this.browser = options.browserAccount ? new AutoDLBrowserService(root) : undefined;
    this.platform = options.platform ?? this.browser ?? createAutoDLPlatform(this.broker);
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs ?? 2_000;
    this.leaseTtlMs = options.leaseTtlMs ?? 180_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 600_000;
    this.file = path.join(root, ".cache", "autodl-power", "state.json");
  }
  safeError(error: unknown, requestToken?: string): AutoDLPowerError {
    let message = error instanceof Error ? error.message : "AutoDL 电源管理未能完成此操作。";
    for (const token of new Set([...this.legacyTokens, this.state.settings.apiToken, requestToken]))
      if (token) for (const value of new Set([token, encodeURIComponent(token)])) message = message.replaceAll(value, "[已隐藏]");
    return new AutoDLPowerError(message.slice(0, 500), error instanceof AutoDLPowerError || error instanceof AutoDLBridgeError ? error.status : 500);
  }
  private initialize(): Promise<void> {
    if (this.disposed) return Promise.reject(new AutoDLPowerError("AutoDL 本机服务已关闭。", 503));
    if (!this.initialized) this.initialized = this.load();
    return this.initialized;
  }
  async start(): Promise<void> {
    await this.initialize();
    if (this.activated || this.disposed) return;
    this.activated = true;
    if (this.options.automaticTimer !== false) {
      this.timer = setInterval(() => { void this.tick().catch(error => { this.transientError = this.safeError(error).message; }); }, this.retryMs);
      this.timer.unref();
    }
    void this.kick();
  }
  private async load() {
    let parsed: unknown;
    try { parsed = JSON.parse(await fs.readFile(this.file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new AutoDLPowerError("本机 AutoDL 状态文件无法读取，请保留原文件后重试。", 500);
    }
    if (!record(parsed) || parsed.version !== 1 || !record(parsed.settings) || !Array.isArray(parsed.leases) || typeof parsed.pendingStop !== "boolean")
      throw new AutoDLPowerError("本机 AutoDL 状态文件格式无效，请保留原文件。", 500);
    const stored = parsed as unknown as SavedState;
    if (stored.bootVerification !== undefined && (typeof stored.bootVerification !== "string" || stored.bootVerification.length > 100))
      throw new AutoDLPowerError("本机 AutoDL 开机核对记录无效，请保留原文件。", 500);
    if (stored.capacityRetryAt !== undefined && (!Number.isSafeInteger(stored.capacityRetryAt) || stored.capacityRetryAt < 0) ||
      stored.capacityRetryCount !== undefined && (!Number.isInteger(stored.capacityRetryCount) || stored.capacityRetryCount < 0 || stored.capacityRetryCount > 2))
      throw new AutoDLPowerError("本机 AutoDL 库存重试记录无效，请保留原文件。", 500);
    if (typeof stored.settings.apiToken === "string" && stored.settings.apiToken) this.legacyTokens.add(stored.settings.apiToken);
    const settings = settingsInput(stored.settings, initialState().settings);
    const known = new Set<string>();
    for (const lease of stored.leases) {
      if (!record(lease) || typeof lease.leaseId !== "string" || known.has(lease.leaseId) || !["starting", "ready", "released", "failed"].includes(lease.phase)
        || !Number.isFinite(lease.expiresAt) || typeof lease.taskId !== "string" || typeof lease.attemptId !== "string"
        || typeof lease.instanceUuid !== "string" || typeof lease.endpoint !== "string" || active(lease) && !sameBinding(settings, lease))
        throw new AutoDLPowerError("本机 AutoDL 租约记录无效，请保留原文件。", 500);
      known.add(lease.leaseId);
      if (active(lease)) { lease.recovered = true; lease.phase = "starting"; }
    }
    this.state = { ...stored, settings, powerOwned: stored.powerOwned === true || stored.startRequestedAt !== undefined,
      phase: stored.pendingStop ? "stopping" : stored.leases.some(active) ? "error" : settings.enabled ? "unknown" : "disabled" };
    if (this.state.powerOwned && !this.state.leases.some(active)) { this.state.pendingStop = true; this.state.phase = "stopping"; }
    if (stored.leases.some(active)) this.state.error = "检测到应用中断前的任务，正在等待恢复心跳；不会立即关闭仍可能运行的实例。";
    if (stored.settings.apiToken) await this.lock(() => this.update(() => {}));
    await this.expireLeases();
  }
  private lock<T>(action: () => Promise<T>): Promise<T> {
    const request = this.writes.then(action, action);
    this.writes = request.then(() => undefined, () => undefined);
    return request;
  }
  private async update(change: (state: SavedState) => void) {
    const next = structuredClone(this.state);
    change(next);
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `state-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.file);
      this.state = next;
      this.transientError = undefined;
    } finally { await fs.rm(temporary, { force: true }); }
  }
  private requireConfigured(settings = this.state.settings) {
    if (!settings.instanceUuid || !settings.endpoint) throw new AutoDLPowerError("请先保存 AutoDL 开关机设置并连接 AutoDL.Art 账号。");
  }
  private operation(): PowerOperation { return { settings: { ...this.state.settings }, epoch: this.state.epoch ?? 0, accountRevision: this.platform.revision?.() ?? 0 }; }
  private isCurrent(operation: PowerOperation): boolean {
    return operation.epoch === (this.state.epoch ?? 0) && sameBinding(this.state.settings, operation.settings) && operation.accountRevision === (this.platform.revision?.() ?? 0);
  }
  async status(): Promise<AutoDLPowerStatus> {
    await this.initialize();
    const state = this.state, count = state.leases.filter(active).length;
    const phase = state.pendingStop ? "stopping" : state.settings.enabled || count ? state.phase : "disabled";
    const error = this.transientError ?? state.error;
    const message = state.pendingStop ? "正在关闭 AutoDL 实例，等待平台确认关机。" : count && state.leases.some(lease => active(lease) && lease.recovered)
      ? "等待恢复应用中断前的任务；过期租约将进入关机清理。" : phase === "ready" ? "AutoDL 实例已开机。"
      : phase === "starting" ? state.leases.find(lease => active(lease) && lease.message)?.message ?? "正在启动 AutoDL 实例。" : phase === "off" ? "AutoDL 实例已关机。" : phase === "disabled" ? "未启用 AutoDL 自动开关机。"
        : phase === "unknown" ? "尚未查询 AutoDL 实例状态。" : "AutoDL 电源管理需要处理。";
    return { settings: { enabled: state.settings.enabled, endpoint: state.settings.endpoint, instanceUuid: state.settings.instanceUuid, tokenConfigured: false },
      phase, activeTasks: count, pendingStop: state.pendingStop, message, ...(error ? { error: this.safeError(new Error(error)).message } : {}) };
  }
  async saveSettings(input: AutoDLSettingsInput): Promise<AutoDLPowerStatus> {
    await this.initialize();
    const legacy = input as unknown as Record<string, unknown>;
    if (record(legacy) && typeof legacy.apiToken === "string" && legacy.apiToken) this.legacyTokens.add(legacy.apiToken);
    await this.lock(async () => {
      const next = settingsInput(input, this.state.settings), previous = this.state.settings;
      if ((this.state.pendingStop || this.state.leases.some(active)) && (next.endpoint !== previous.endpoint || next.instanceUuid !== previous.instanceUuid))
        throw new AutoDLPowerError("有任务或待确认关机时不能更换 AutoDL 实例绑定。", 409);
      if ((this.state.pendingStop || this.state.leases.some(active)) && previous.enabled && !next.enabled)
        throw new AutoDLPowerError("请等待全部任务结束并确认实例关机后，再关闭自动开关机。", 409);
      await this.update(state => {
        if (!sameBinding(previous, next) || next.apiToken !== previous.apiToken || next.enabled !== previous.enabled) bumpEpoch(state);
        state.settings = next; if (!state.leases.some(active) && !state.pendingStop) {
        state.phase = next.enabled ? "unknown" : "disabled"; state.error = undefined; state.powerOwned = false; state.startRequestedAt = undefined; state.waitStartedAt = undefined; state.bootUncertainUntil = undefined; state.bootObserved = undefined; state.bootVerification = undefined; clearCapacityRetry(state);
      } });
    });
    if (this.state.pendingStop) { await this.start(); void this.kick(); }
    return this.status();
  }
  get usesIndependentBrowser() { return Boolean(this.browser); }
  session() { return this.browser?.session() ?? this.broker.session(); }
  instances() { return this.browser?.instances() ?? this.broker.instances(); }
  async openAccount() {
    const browser = this.browser;
    if (!browser) throw new AutoDLPowerError("此版本未启用 AutoDL 官网窗口。", 404);
    await this.initialize();
    return this.lock(async () => {
      if (this.state.leases.some(lease => active(lease) && !lease.recovered))
        throw new AutoDLPowerError("当前有 AutoDL 任务运行，请等待任务结束后再打开登录窗口。", 409);
      return browser.openAccount();
    });
  }
  pairCode() { return this.broker.pairCode(); }
  private bridgeInUse() { return this.state.pendingStop || this.state.powerOwned || this.state.leases.some(active); }
  async bridgePair(value: unknown) {
    await this.initialize();
    return this.lock(async () => {
      if (this.bridgeInUse() && this.broker.hasOnlinePeer())
        throw new AutoDLPowerError("当前浏览器正在为任务管理 AutoDL，请在任务结束并确认关机后再更换。", 409);
      return this.broker.pair(value);
    });
  }
  bridgeVerify(value: unknown) { return this.broker.verify(value); }
  async bridgeDisconnect(value: unknown) {
    await this.initialize();
    return this.lock(async () => {
      if (this.bridgeInUse()) throw new AutoDLPowerError("当前画布有未结束的 AutoDL 任务或待确认关机。", 409);
      return this.broker.disconnect(value);
    });
  }
  bridgePoll(value: unknown, signal?: AbortSignal) { return this.broker.poll(value, signal); }
  bridgeResult(value: unknown) { return this.broker.result(value); }
  async check(): Promise<AutoDLPowerStatus> {
    await this.initialize();
    const operation = this.operation(), settings = operation.settings;
    this.requireConfigured(settings);
    let observed: string;
    try { observed = await this.platform.status(settings); }
    catch (error) { throw this.safeError(error, settings.apiToken); }
    let startupMessage: string | undefined;
    if (bootableOffStates.has(observed) && this.platform.checkStartup) {
      try {
        observed = await this.platform.checkStartup(settings);
        if (bootableOffStates.has(observed)) startupMessage = "AutoDL 实例已关机，开机预检通过。";
      }
      catch (error) {
        startupMessage = isStartupBlocker(error) ? this.safeError(error, settings.apiToken).message
          : "AutoDL 实例已关机，暂时无法核对开机条件。";
      }
    }
    await this.lock(async () => {
      if (!this.isCurrent(operation)) return;
      await this.update(state => {
        if (!state.pendingStop && !state.leases.some(active)) state.phase = offStates.has(observed) ? "off" : observed === "running" ? "ready" : "starting";
        if (!state.pendingStop) state.error = undefined;
      });
    });
    const status = await this.status();
    return startupMessage && this.isCurrent(operation) && status.phase === "off"
      ? { ...status, message: startupMessage }
      : status;
  }
  async acquire(input: AutoDLAcquireRequest): Promise<AutoDLLease> {
    await this.start();
    const normalized = acquireInput(input), { endpoint: source, instanceUuid, taskId, attemptId } = normalized;
    const lease = await this.lock(async () => {
      const settings = this.state.settings;
      this.requireConfigured();
      if (!settings.enabled) throw new AutoDLPowerError("请在算力设置 → 云端 ComfyUI 中启用 AutoDL 自动开关机并保存。", 409);
      if (settings.endpoint !== source || settings.instanceUuid !== instanceUuid)
        throw new AutoDLPowerError("AutoDL 任务与保存的实例绑定不匹配，请在算力设置中校验当前连接。", 409);
      const existing = this.state.leases.find(item => sameAttempt(item, normalized));
      if (existing && !active(existing)) return publicLease(existing);
      let id = existing?.leaseId;
      await this.update(state => {
        const hadActiveLease = state.leases.some(active);
        const reuseReady = hadActiveLease && state.powerOwned && state.phase === "ready" && !state.pendingStop;
        // A resumed attempt replaces only the abandoned attempt for the same task.
        for (const previous of state.leases) if (sameBinding(state.settings, previous) && previous.taskId === taskId && previous.attemptId !== attemptId && active(previous)) {
          if (!previous.recovered) throw new AutoDLPowerError("此任务已有正在执行的 AutoDL 租约。", 409);
          previous.phase = "released";
        }
        if (id) {
          const current = state.leases.find(item => item.leaseId === id)!;
          current.recovered = false; current.expiresAt = this.now() + this.leaseTtlMs;
          current.phase = reuseReady ? "ready" : "starting";
        } else {
          id = randomUUID();
          state.leases.push({ leaseId: id, instanceUuid, endpoint: source, taskId, attemptId, expiresAt: this.now() + this.leaseTtlMs,
            phase: reuseReady ? "ready" : "starting" });
        }
        if (!hadActiveLease) { bumpEpoch(state); clearCapacityRetry(state); if (!state.pendingStop) state.waitStartedAt = this.now(); }
        else if (state.capacityRetryAt !== undefined) state.leases.find(item => item.leaseId === id)!.message = state.leases.find(item => item.message)?.message;
        else if (state.bootVerification !== undefined) state.leases.find(item => item.leaseId === id)!.message = bootVerificationMessage;
        if (!state.pendingStop && !reuseReady) state.phase = "starting";
        if (state.waitStartedAt === undefined && state.phase !== "ready") state.waitStartedAt = this.now();
        state.error = undefined;
      });
      return publicLease(this.state.leases.find(item => item.leaseId === id)!);
    });
    void this.kick();
    return lease;
  }
  async heartbeat(leaseId: string): Promise<AutoDLLease> {
    await this.start();
    identifier(leaseId, "租约 ID");
    const result = await this.lock(async () => {
      const lease = this.state.leases.find(item => item.leaseId === leaseId);
      if (!lease) throw new AutoDLPowerError("AutoDL 租约不存在或已清理。", 404);
      if (!active(lease)) return publicLease(lease);
      if (lease.expiresAt <= this.now()) {
        await this.expireInLock();
        void this.kick();
      } else await this.update(state => {
        const current = state.leases.find(item => item.leaseId === leaseId)!;
        current.expiresAt = this.now() + this.leaseTtlMs;
        current.recovered = false;
      });
      return publicLease(this.state.leases.find(item => item.leaseId === leaseId)!);
    });
    void this.kick();
    return result;
  }
  async release(input: string | AutoDLAcquireRequest): Promise<AutoDLPowerStatus> {
    await this.start();
    const leaseId = typeof input === "string" ? identifier(input, "租约 ID") : undefined;
    const attempt = leaseId === undefined ? acquireInput(input) : undefined;
    await this.lock(async () => {
      if (attempt && !sameBinding(this.state.settings, attempt)) throw new AutoDLPowerError("AutoDL 清理请求与保存的实例绑定不匹配。", 409);
      const lease = this.state.leases.find(item => attempt ? sameAttempt(item, attempt) : item.leaseId === leaseId);
      if (lease && !active(lease) || !lease && !attempt) return;
      await this.update(state => {
        if (!lease) {
          state.leases.push({ ...attempt!, leaseId: randomUUID(), phase: "released", expiresAt: this.now() });
          return;
        }
        const released = state.leases.find(item => item.leaseId === lease.leaseId)!; released.phase = "released"; released.message = undefined;
        if (!state.leases.some(active)) {
          bumpEpoch(state); clearCapacityRetry(state);
          if (state.powerOwned) { state.pendingStop = true; state.phase = "stopping"; }
          else if (!state.pendingStop) { state.phase = "unknown"; state.waitStartedAt = undefined; }
        }
      });
    });
    void this.kick();
    return this.status();
  }
  async retryShutdown(): Promise<AutoDLPowerStatus> {
    await this.start();
    if (this.state.pendingStop) await this.kick();
    return this.status();
  }
  private async expireInLock() {
    if (!this.state.leases.some(lease => active(lease) && lease.expiresAt <= this.now())) return;
    await this.update(state => {
      for (const lease of state.leases) if (active(lease) && lease.expiresAt <= this.now()) { lease.phase = "failed"; lease.error = "任务心跳中断，租约已结束。"; lease.message = undefined; }
      if (!state.leases.some(active)) {
        bumpEpoch(state); clearCapacityRetry(state);
        if (state.powerOwned) { state.pendingStop = true; state.phase = "stopping"; }
        else if (!state.pendingStop) { state.phase = "error"; state.waitStartedAt = undefined; }
      }
    });
  }
  private expireLeases() { return this.lock(() => this.expireInLock()); }
  async tick(): Promise<void> { await this.start(); await this.expireLeases(); await this.kick(); }
  private kick(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.requested = true;
    if (this.working) return this.working;
    const work = (async () => {
      try {
        await this.start();
        while (this.requested && !this.disposed) { this.requested = false; await this.step(); }
      } catch (error) { this.transientError = this.safeError(error).message; }
      finally { this.working = undefined; }
    })();
    this.working = work;
    return work;
  }
  private async stopOnce() {
    const operation = this.operation(), credentials = operation.settings;
    if (!this.state.pendingStop) return;
    let error: string | undefined;
    try { await this.platform.powerOff(credentials); } catch (reason) { error = this.safeError(reason, credentials.apiToken).message; }
    let observed: string | undefined;
    try { observed = await this.platform.status(credentials); } catch (reason) { error = this.safeError(reason, credentials.apiToken).message; }
    const accepted = await this.lock(async () => {
      if (!this.isCurrent(operation) || !this.state.pendingStop) return false;
      await this.update(state => {
      if (observed === "starting" || observed === "running" || observed !== undefined && offStates.has(observed) && observed !== "shutdown") {
        state.bootObserved = true; state.bootUncertainUntil = undefined;
      }
      const bootSettled = state.bootObserved || state.bootUncertainUntil === undefined || state.bootUncertainUntil <= this.now();
      if (observed !== undefined && offStates.has(observed) && bootSettled) {
        state.pendingStop = false; state.phase = "off"; state.powerOwned = false; state.startRequestedAt = undefined; state.waitStartedAt = undefined;
        state.bootUncertainUntil = undefined; state.bootObserved = undefined; state.bootVerification = undefined; state.error = undefined; clearCapacityRetry(state);
      }
      else { state.pendingStop = true; state.phase = "stopping"; state.error = error; }
      });
      return true;
    });
    if (!accepted || !this.state.pendingStop && observed !== undefined && offStates.has(observed) && this.state.leases.some(lease => active(lease) && !lease.recovered)) this.requested = true;
  }
  private async step() {
    if (this.state.pendingStop) { await this.stopOnce(); return; }
    const operation = await this.lock(async () => {
      const leases = this.state.leases.filter(lease => active(lease) && !lease.recovered);
      if (this.state.pendingStop || !leases.length || this.state.phase === "ready" && leases.every(lease => lease.phase === "ready")) return;
      if (this.state.capacityRetryAt !== undefined && this.state.capacityRetryAt > this.now()) return;
      if (this.state.waitStartedAt === undefined) await this.update(state => { state.waitStartedAt = this.now(); });
      return this.operation();
    });
    if (!operation) { if (this.state.pendingStop) this.requested = true; return; }
    const credentials = operation.settings;
    let powerOnAttempted = false;
    let powerOnAccepted = false;
    let capacityOffConfirmed = false;
    let bootConfirmedOff = false;
    let bootVerification = this.state.bootVerification;
    try {
      const startupDeadline = (this.state.waitStartedAt ?? this.now()) + this.startupTimeoutMs;
      if (bootVerification === undefined && this.now() >= startupDeadline)
        throw new AutoDLPowerError("AutoDL 开机长时间未就绪，已安排关机清理。", 502);
      let observed: string | undefined;
      let statusRequestedAt = this.now();
      try { observed = await this.platform.status(credentials); }
      catch (reason) { if (bootVerification === undefined) throw reason; }
      if (!this.isCurrent(operation) || this.state.pendingStop || !this.state.leases.some(lease => active(lease) && !lease.recovered)) { this.requested = true; return; }
      if (observed !== undefined && offStates.has(observed) && this.state.startRequestedAt === undefined && this.platform.checkStartup) {
        try { observed = await this.platform.checkStartup(credentials); }
        catch (reason) {
          bootConfirmedOff = isStartupBlocker(reason);
          throw reason;
        }
      }
      if (observed !== undefined && offStates.has(observed) && this.state.startRequestedAt === undefined) {
        const allowed = await this.lock(async () => {
          // Recheck after every earlier checkpoint has committed. A released task
          // must never leave a boot command behind the release's durable write.
          if (!this.isCurrent(operation) || this.state.pendingStop || !this.state.leases.some(lease => active(lease) && !lease.recovered)) return false;
          await this.update(state => {
            state.phase = "starting"; state.startRequestedAt = this.now(); state.powerOwned = true;
            state.bootObserved = false; state.bootUncertainUntil = this.now() + (this.options.bootSettleMs ?? 60_000); state.bootVerification = undefined;
            state.capacityRetryAt = undefined; for (const lease of state.leases) if (active(lease)) lease.message = undefined;
          });
          return true;
        });
        if (!allowed) { this.requested = true; return; }
        if (this.state.pendingStop) { this.requested = true; return; }
        powerOnAttempted = true;
        try {
          await this.platform.powerOn(credentials);
          powerOnAccepted = true;
          observed = await this.platform.status(credentials);
        } catch (reason) {
          if (powerOnAccepted || !(reason instanceof AutoDLBridgeError)) throw reason;
          const uncertain = reason.dispatched === true && !reason.definitive && ["POWER_UNKNOWN", "POWER_STATE_CONFLICT"].includes(reason.code);
          if (!uncertain && reason.code !== "NO_GPU_CAPACITY") throw reason;
          let actual: string | undefined;
          statusRequestedAt = this.now();
          try { actual = await this.platform.status(credentials); } catch { /* A failed read cannot confirm a power transition. */ }
          if (actual === "starting" || actual === "running") { powerOnAccepted = true; observed = actual; }
          else if (uncertain) {
            observed = actual;
            const details = formatAutoDLDiagnostics(reason);
            bootVerification = details ? this.safeError(new Error(details), credentials.apiToken).message : "";
          } else { capacityOffConfirmed = actual !== undefined && offStates.has(actual); throw reason; }
        }
      }
      if (!this.isCurrent(operation) || this.state.pendingStop) { this.requested = true; return; }
      if (bootVerification !== undefined && observed !== "starting" && observed !== "running") {
        const deadline = Math.min(startupDeadline, this.state.bootUncertainUntil ?? startupDeadline);
        const expired = statusRequestedAt >= deadline;
        if (expired && observed !== undefined && offStates.has(observed)) {
          bootConfirmedOff = true;
          const actual = observed === "shutdown" ? "平台仍显示关机" : "平台状态为 " + observed;
          throw new AutoDLPowerError("AutoDL 未能开机，" + actual + bootVerification + "。请在官网查看开机条件后重试。", 502);
        }
        if (expired) throw new AutoDLPowerError("AutoDL 开机核对超时，尚未确认实例状态" + bootVerification + "。已安排关机清理。", 502);
        if (this.state.bootVerification !== bootVerification) await this.lock(async () => {
          if (!this.isCurrent(operation) || this.state.pendingStop) return;
          await this.update(state => {
            state.bootVerification = bootVerification;
            for (const lease of state.leases) if (active(lease) && !lease.recovered) lease.message = bootVerificationMessage;
          });
        });
        // A read that began before the deadline can still report a pre-deadline snapshot.
        if (this.now() >= deadline) this.requested = true;
        return;
      }
      if (observed === "starting" || observed === "running") await this.lock(async () => {
        if (this.isCurrent(operation)) await this.update(state => {
          state.bootObserved = true; state.bootUncertainUntil = undefined;
          if (state.bootVerification !== undefined) {
            state.bootVerification = undefined;
            for (const lease of state.leases) if (active(lease)) lease.message = undefined;
          }
        });
      });
      if (observed !== undefined && offStates.has(observed) && observed !== "shutdown" && this.state.startRequestedAt !== undefined)
        throw new AutoDLPowerError("AutoDL 开机失败，平台状态：" + observed, 502);
      if (observed === "running") {
        const accepted = await this.lock(async () => {
          if (!this.isCurrent(operation) || this.state.pendingStop || !this.state.leases.some(lease => active(lease) && !lease.recovered)) return false;
          await this.update(state => {
            state.phase = "ready"; state.powerOwned = true; state.waitStartedAt = undefined; state.error = undefined; clearCapacityRetry(state);
            for (const lease of state.leases) if (active(lease) && !lease.recovered) lease.phase = "ready";
          });
          return true;
        });
        if (!accepted) this.requested = true;
      }
    } catch (reason) {
      let error = this.safeError(reason, credentials.apiToken).message;
      const accepted = await this.lock(async () => {
        if (!this.isCurrent(operation)) {
          // A corrected token may retry a rejected boot, but an old response
          // cannot fail or ready the new operation's leases.
          return false;
        }
        await this.update(state => {
          if (capacityOffConfirmed && powerOnAttempted && !powerOnAccepted && reason instanceof AutoDLBridgeError && reason.code === "NO_GPU_CAPACITY" &&
            !state.pendingStop && state.leases.some(lease => active(lease) && !lease.recovered) && (state.capacityRetryCount ?? 0) < 2) {
            state.capacityRetryCount = (state.capacityRetryCount ?? 0) + 1; state.capacityRetryAt = this.now() + 30_000;
            state.phase = "starting"; state.powerOwned = false; state.startRequestedAt = undefined; state.bootUncertainUntil = undefined; state.bootObserved = undefined; state.error = undefined;
            for (const lease of state.leases) if (active(lease) && !lease.recovered) {
              lease.phase = "starting"; lease.error = undefined; lease.message = `AutoDL 当前算力规格暂无库存，30 秒后重试（${state.capacityRetryCount}/2），可取消任务。`;
            }
            return;
          }
          if (reason instanceof AutoDLBridgeError && reason.code === "NO_GPU_CAPACITY" && (state.capacityRetryCount ?? 0) >= 2)
            error += " 已完成 2 次重试，请稍后重新生成或在官网调整规格。";
          clearCapacityRetry(state);
          for (const lease of state.leases) if (active(lease) && !lease.recovered) { lease.phase = "failed"; lease.error = error; }
          state.error = error;
          state.bootVerification = undefined;
          if (bootConfirmedOff || powerOnAttempted && !powerOnAccepted && reason instanceof AutoDLBridgeError && (reason.dispatched === false || reason.definitive)) {
            state.powerOwned = false; state.startRequestedAt = undefined; state.bootUncertainUntil = undefined; state.bootObserved = undefined;
          }
          if (!state.leases.some(active) && state.powerOwned) { state.pendingStop = true; state.phase = "stopping"; }
          else if (!state.pendingStop) { state.phase = bootConfirmedOff ? "off" : "error"; state.waitStartedAt = undefined; }
        });
        return true;
      });
      if (!accepted || this.state.pendingStop) this.requested = true;
    }
  }
  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    try {
      if (!this.initialized) return;
      await this.initialized;
      await this.working;
      // Closing a local server must not interrupt a generation that still owns a lease.
      if (this.state.pendingStop) await this.stopOnce();
    } finally {
      await Promise.all([this.browser?.close(), this.broker.close()]);
    }
  }
}

export const createAutoDLPowerService = (root: string, options?: AutoDLPowerServiceOptions) => new AutoDLPowerService(root, options);
