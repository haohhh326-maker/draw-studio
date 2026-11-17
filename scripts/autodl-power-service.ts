import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import type { AutoDLAcquireRequest, AutoDLLease, AutoDLPowerPhase, AutoDLPowerStatus, AutoDLSettingsInput } from "../src/autodl/types";

export class AutoDLPowerError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
type Credentials = { apiToken: string; instanceUuid: string };
type Settings = Credentials & { enabled: boolean; endpoint: string };
export interface AutoDLPlatform {
  status(credentials: Credentials): Promise<string>;
  powerOn(credentials: Credentials): Promise<void>;
  powerOff(credentials: Credentials): Promise<void>;
}
type SavedLease = AutoDLLease & { endpoint: string; taskId: string; attemptId: string; expiresAt: number; recovered?: boolean };
type SavedState = { version: 1; settings: Settings; leases: SavedLease[]; pendingStop: boolean; phase: AutoDLPowerPhase;
  epoch?: number; powerOwned?: boolean; startRequestedAt?: number; waitStartedAt?: number; error?: string };
type PowerOperation = { settings: Settings; epoch: number };
export type AutoDLPowerServiceOptions = {
  platform?: AutoDLPlatform;
  now?: () => number;
  retryMs?: number;
  leaseTtlMs?: number;
  startupTimeoutMs?: number;
  automaticTimer?: boolean;
};
const initialState = (): SavedState => ({ version: 1, settings: { enabled: false, endpoint: "", instanceUuid: "", apiToken: "" }, leases: [], pendingStop: false, phase: "disabled" });
const active = (lease: SavedLease) => lease.phase === "starting" || lease.phase === "ready";
const offStates = new Set(["shutdown", "shutdown_by_starting_error", "shutdown_by_running_error", "migrate_failed"]);
const publicLease = ({ leaseId, instanceUuid, phase, error }: SavedLease): AutoDLLease => ({ leaseId, instanceUuid, phase, ...(error ? { error } : {}) });
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
  const apiToken = input.apiToken === undefined ? previous.apiToken : text(input.apiToken, "开发者 Token", 4096) || previous.apiToken;
  if (input.enabled && (!source || !instanceUuid || !apiToken)) throw new AutoDLPowerError("启用前请填写 ComfyUI 地址、应用实例 ID 和开发者 Token。");
  return { enabled: input.enabled, endpoint: source ? endpoint(source) : "", instanceUuid, apiToken };
}

/** These are the documented application-instance APIs, never the instance-release API. */
export function createAutoDLPlatform(requester: typeof httpsRequest = httpsRequest): AutoDLPlatform {
  async function call(operation: "status" | "power_on" | "power_off", credentials: Credentials): Promise<unknown> {
    const body = Buffer.from(JSON.stringify({ instance_uuid: credentials.instanceUuid, ...(operation === "power_on" ? { payload: "gpu" } : {}) }));
    return new Promise((resolve, reject) => {
      const request = requester(new URL("https://www.autodl.art/api/v1/adl_dev/dev/instance/pro/" + operation), {
        method: operation === "status" ? "GET" : "POST",
        headers: { Authorization: credentials.apiToken, Accept: "application/json", "Content-Type": "application/json", "Content-Length": body.length },
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", chunk => {
          size += chunk.length;
          if (size > 1024 * 1024) { response.destroy(new AutoDLPowerError("AutoDL 状态响应过大。", 502)); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.once("error", reject);
        response.once("end", () => {
          let packet: unknown;
          try { packet = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { reject(new AutoDLPowerError("AutoDL 没有返回有效的状态数据。", 502)); return; }
          if (response.statusCode !== 200 || !record(packet) || packet.code !== "Success") {
            const message = record(packet) && typeof packet.msg === "string" && packet.msg ? packet.msg : "AutoDL 请求未成功，请检查开发者 Token 和应用实例 ID。";
            reject(new AutoDLPowerError(message.replaceAll(credentials.apiToken, "[已隐藏]"), 502)); return;
          }
          resolve(packet.data);
        });
      });
      request.once("error", reject);
      request.setTimeout(30_000, () => request.destroy(new AutoDLPowerError("AutoDL 状态请求超时。", 502)));
      // Node's HTTPS transport supports the official status endpoint's GET JSON body.
      request.end(body);
    });
  }
  return {
    async status(credentials) {
      const result = await call("status", credentials);
      if (typeof result !== "string" || !result.trim()) throw new AutoDLPowerError("AutoDL 实例状态无效。", 502);
      return result;
    },
    async powerOn(credentials) { await call("power_on", credentials); },
    async powerOff(credentials) { await call("power_off", credentials); },
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
  constructor(root: string, private readonly options: AutoDLPowerServiceOptions = {}) {
    this.platform = options.platform ?? createAutoDLPlatform();
    this.now = options.now ?? Date.now;
    this.retryMs = options.retryMs ?? 2_000;
    this.leaseTtlMs = options.leaseTtlMs ?? 180_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 600_000;
    this.file = path.join(root, ".cache", "autodl-power", "state.json");
  }
  safeError(error: unknown, requestToken?: string): AutoDLPowerError {
    let message = error instanceof Error ? error.message : "AutoDL 电源管理未能完成此操作。";
    for (const token of new Set([this.state.settings.apiToken, requestToken]))
      if (token) for (const value of new Set([token, encodeURIComponent(token)])) message = message.replaceAll(value, "[已隐藏]");
    return new AutoDLPowerError(message.slice(0, 500), error instanceof AutoDLPowerError ? error.status : 500);
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
    if (!settings.apiToken || !settings.instanceUuid || !settings.endpoint) throw new AutoDLPowerError("请先保存 AutoDL 开关机设置。");
  }
  private operation(): PowerOperation { return { settings: { ...this.state.settings }, epoch: this.state.epoch ?? 0 }; }
  private isCurrent(operation: PowerOperation): boolean {
    return operation.epoch === (this.state.epoch ?? 0) && sameBinding(this.state.settings, operation.settings) && operation.settings.apiToken === this.state.settings.apiToken;
  }
  async status(): Promise<AutoDLPowerStatus> {
    await this.initialize();
    const state = this.state, count = state.leases.filter(active).length;
    const phase = state.pendingStop ? "stopping" : state.settings.enabled || count ? state.phase : "disabled";
    const error = this.transientError ?? state.error;
    const message = state.pendingStop ? "正在关闭 AutoDL 实例，等待平台确认关机。" : count && state.leases.some(lease => active(lease) && lease.recovered)
      ? "等待恢复应用中断前的任务；过期租约将进入关机清理。" : phase === "ready" ? "AutoDL 实例已开机。"
      : phase === "starting" ? "正在启动 AutoDL 实例。" : phase === "off" ? "AutoDL 实例已关机。" : phase === "disabled" ? "未启用 AutoDL 自动开关机。"
        : phase === "unknown" ? "尚未查询 AutoDL 实例状态。" : "AutoDL 电源管理需要处理。";
    return { settings: { enabled: state.settings.enabled, endpoint: state.settings.endpoint, instanceUuid: state.settings.instanceUuid, tokenConfigured: !!state.settings.apiToken },
      phase, activeTasks: count, pendingStop: state.pendingStop, message, ...(error ? { error: this.safeError(new Error(error)).message } : {}) };
  }
  async saveSettings(input: AutoDLSettingsInput): Promise<AutoDLPowerStatus> {
    await this.initialize();
    await this.lock(async () => {
      const next = settingsInput(input, this.state.settings), previous = this.state.settings;
      if ((this.state.pendingStop || this.state.leases.some(active)) && (next.endpoint !== previous.endpoint || next.instanceUuid !== previous.instanceUuid))
        throw new AutoDLPowerError("有任务或待确认关机时不能更换 AutoDL 实例绑定。", 409);
      if ((this.state.pendingStop || this.state.leases.some(active)) && previous.enabled && !next.enabled)
        throw new AutoDLPowerError("请等待全部任务结束并确认实例关机后，再关闭自动开关机。", 409);
      await this.update(state => {
        if (!sameBinding(previous, next) || next.apiToken !== previous.apiToken || next.enabled !== previous.enabled) bumpEpoch(state);
        state.settings = next; if (!state.leases.some(active) && !state.pendingStop) {
        state.phase = next.enabled ? "unknown" : "disabled"; state.error = undefined; state.powerOwned = false; state.startRequestedAt = undefined; state.waitStartedAt = undefined;
      } });
    });
    if (this.state.pendingStop) { await this.start(); void this.kick(); }
    return this.status();
  }
  async check(): Promise<AutoDLPowerStatus> {
    await this.initialize();
    const operation = this.operation(), settings = operation.settings;
    this.requireConfigured(settings);
    let observed: string;
    try { observed = await this.platform.status(settings); }
    catch (error) { throw this.safeError(error, settings.apiToken); }
    await this.lock(async () => {
      if (!this.isCurrent(operation)) return;
      await this.update(state => {
        if (!state.pendingStop && !state.leases.some(active)) state.phase = offStates.has(observed) ? "off" : observed === "running" ? "ready" : "starting";
        if (!state.pendingStop) state.error = undefined;
      });
    });
    return this.status();
  }
  async acquire(input: AutoDLAcquireRequest): Promise<AutoDLLease> {
    await this.start();
    const normalized = acquireInput(input), { endpoint: source, instanceUuid, taskId, attemptId } = normalized;
    const lease = await this.lock(async () => {
      const settings = this.state.settings;
      this.requireConfigured();
      if (!settings.enabled || settings.endpoint !== source || settings.instanceUuid !== instanceUuid) throw new AutoDLPowerError("AutoDL 任务与保存的实例绑定不匹配。", 409);
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
        if (!hadActiveLease) { bumpEpoch(state); if (!state.pendingStop) state.waitStartedAt = this.now(); }
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
        state.leases.find(item => item.leaseId === lease.leaseId)!.phase = "released";
        if (!state.leases.some(active)) {
          bumpEpoch(state);
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
      for (const lease of state.leases) if (active(lease) && lease.expiresAt <= this.now()) { lease.phase = "failed"; lease.error = "任务心跳中断，租约已结束。"; }
      if (!state.leases.some(active)) {
        bumpEpoch(state);
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
      if (observed !== undefined && offStates.has(observed)) {
        state.pendingStop = false; state.phase = "off"; state.powerOwned = false; state.startRequestedAt = undefined; state.waitStartedAt = undefined; state.error = undefined;
      }
      else { state.pendingStop = true; state.phase = "stopping"; state.error = error; }
      });
      return true;
    });
    if (!accepted || observed !== undefined && offStates.has(observed) && this.state.leases.some(lease => active(lease) && !lease.recovered)) this.requested = true;
  }
  private async step() {
    if (this.state.pendingStop) { await this.stopOnce(); return; }
    const operation = await this.lock(async () => {
      const leases = this.state.leases.filter(lease => active(lease) && !lease.recovered);
      if (this.state.pendingStop || !leases.length || this.state.phase === "ready" && leases.every(lease => lease.phase === "ready")) return;
      if (this.state.waitStartedAt === undefined) await this.update(state => { state.waitStartedAt = this.now(); });
      return this.operation();
    });
    if (!operation) { if (this.state.pendingStop) this.requested = true; return; }
    const credentials = operation.settings;
    let powerOnAttempted = false;
    try {
      if (this.state.waitStartedAt !== undefined && this.now() - this.state.waitStartedAt >= this.startupTimeoutMs)
        throw new AutoDLPowerError("AutoDL 开机长时间未就绪，已安排关机清理。", 502);
      let observed = await this.platform.status(credentials);
      if (!this.isCurrent(operation) || this.state.pendingStop || !this.state.leases.some(lease => active(lease) && !lease.recovered)) { this.requested = true; return; }
      if (offStates.has(observed) && this.state.startRequestedAt === undefined) {
        const allowed = await this.lock(async () => {
          // Recheck after every earlier checkpoint has committed. A released task
          // must never leave a boot command behind the release's durable write.
          if (!this.isCurrent(operation) || this.state.pendingStop || !this.state.leases.some(lease => active(lease) && !lease.recovered)) return false;
          await this.update(state => { state.phase = "starting"; state.startRequestedAt = this.now(); state.powerOwned = true; });
          return true;
        });
        if (!allowed) { this.requested = true; return; }
        if (this.state.pendingStop) { this.requested = true; return; }
        powerOnAttempted = true;
        await this.platform.powerOn(credentials);
        observed = await this.platform.status(credentials);
      }
      if (!this.isCurrent(operation) || this.state.pendingStop) { this.requested = true; return; }
      if (offStates.has(observed) && observed !== "shutdown" && this.state.startRequestedAt !== undefined)
        throw new AutoDLPowerError("AutoDL 开机失败，平台状态：" + observed, 502);
      if (observed === "running") {
        const accepted = await this.lock(async () => {
          if (!this.isCurrent(operation) || this.state.pendingStop || !this.state.leases.some(lease => active(lease) && !lease.recovered)) return false;
          await this.update(state => {
            state.phase = "ready"; state.powerOwned = true; state.waitStartedAt = undefined; state.error = undefined;
            for (const lease of state.leases) if (active(lease) && !lease.recovered) lease.phase = "ready";
          });
          return true;
        });
        if (!accepted) this.requested = true;
      }
    } catch (reason) {
      const error = this.safeError(reason, credentials.apiToken).message;
      const accepted = await this.lock(async () => {
        if (!this.isCurrent(operation)) {
          // A corrected token may retry a rejected boot, but an old response
          // cannot fail or ready the new operation's leases.
          if (powerOnAttempted && sameBinding(this.state.settings, credentials) && this.state.settings.apiToken !== credentials.apiToken && !this.state.pendingStop)
            await this.update(state => { state.startRequestedAt = undefined; });
          return false;
        }
        await this.update(state => {
          for (const lease of state.leases) if (active(lease) && !lease.recovered) { lease.phase = "failed"; lease.error = error; }
          state.error = error;
          if (!state.leases.some(active) && state.powerOwned) { state.pendingStop = true; state.phase = "stopping"; }
          else if (!state.pendingStop) { state.phase = "error"; state.waitStartedAt = undefined; }
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
    if (!this.initialized) return;
    await this.initialized;
    await this.working;
    // Closing a local server must not interrupt a generation that still owns a lease.
    if (this.state.pendingStop) await this.stopOnce();
  }
}

export const createAutoDLPowerService = (root: string, options?: AutoDLPowerServiceOptions) => new AutoDLPowerService(root, options);
