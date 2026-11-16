import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createCloudTransferPasswordStore, type CloudTransferPasswordStore } from "./cloud-transfer-passwords";

export type CloudFileBucketId = "comfyui_nodes" | "loras" | "cloud_upload";
export type NativeConnectionConfig = { host: string; port: number; username: string; password?: string; privateKey?: string; passphrase?: string; hostKey?: string };
export type NativeConnectOptions = { signal?: AbortSignal };
export type SourceIdentity = { dev: number; ino: number; size: number; mtimeMs: number };
export interface NativeTransferConnection {
  hostKey: string; fingerprint: string; home: string;
  list(path: string): Promise<Array<{ name: string; directory: boolean; size: number; symlink?: boolean; modified?: number }>>;
  stat(path: string): Promise<{ directory: boolean; size: number }>;
  mkdir(path: string): Promise<void>;
  upload(localPath: string, remotePath: string, options: { signal?: AbortSignal; onProgress?: (bytes: number) => void; expectedIdentity?: SourceIdentity; allowedRoot?: string }): Promise<void>;
  isClosed?(): boolean;
  close(): Promise<void>;
}
type EngineStatus = { available: boolean; engine: string; version: string };
export type CloudFileTransferOptions = { localRoot?: string; connect?: (config: NativeConnectionConfig, options?: NativeConnectOptions) => Promise<NativeTransferConnection>; engineStatus?: () => Promise<EngineStatus>; now?: () => number; passwordStore?: CloudTransferPasswordStore };
type Entry = { name: string; path: string; directory: boolean; size: number; symlink?: boolean; modified?: number };
type Manifest = { relative: string; local: string; allowedRoot: string; directory: boolean; identity: SourceIdentity };
type JobStatus = "receiving" | "queued" | "uploading" | "cancelling" | "completed" | "failed" | "cancelled";
type Job = { id: string; status: JobStatus; bytes: number; totalBytes: number; files: number; totalFiles: number; createdAt: number; startedAt?: number; finishedAt?: number; error?: string; manifest: Manifest[]; remotePath: string; abort: AbortController; temporaryRoot?: string };
type Session = { id: string; connection: NativeTransferConnection; jobs: Job[]; working: boolean; closed: boolean };
const definitions: { id: CloudFileBucketId; label: string }[] = [{ id: "comfyui_nodes", label: "ComfyUI 节点" }, { id: "loras", label: "LoRA 模型" }, { id: "cloud_upload", label: "云端上传" }];
const controls = /[\x00-\x1f\x7f]/;
const active = (job: Job) => ["receiving", "queued", "uploading", "cancelling"].includes(job.status);
export class CloudFileTransferError extends Error {
  constructor(message: string, public status = 400, public code = "INVALID_REQUEST", public hostKey?: string, public fingerprint?: string, public causeCode?: string) { super(message); }
}
function invalid(message: string): never { throw new CloudFileTransferError(message); }
function inside(root: string, location: string) { const relative = path.relative(root, location); return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); }
function bucketId(value: unknown): CloudFileBucketId { if (!definitions.some(item => item.id === value)) invalid("请选择有效的本地文件分类。"); return value as CloudFileBucketId; }
function relativePath(value: unknown, empty = true) {
  if (typeof value !== "string" || value.length > 4096 || controls.test(value) || value.includes("\\") || value.includes(":") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.split("/").some(part => part === ".." || part === ".") || (!empty && !value)) invalid("本地路径必须位于所选文件夹内。");
  return value.replace(/\/+$/, "");
}
export function remoteTransferPath(value: unknown) { if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096 || controls.test(value) || value.includes("\\")) invalid("请填写有效的云端绝对目录，例如 /root/ComfyUI/models/loras。"); return path.posix.normalize(value); }
function filename(value: string) { if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || controls.test(value)) invalid("文件名包含不支持的字符。"); return value; }
function identity(value: { dev: number; ino: number; size: number; mtimeMs: number }): SourceIdentity { return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs }; }
function sameIdentity(a: SourceIdentity, b: SourceIdentity) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs; }
function connectionAddress(value: Record<string, unknown>) {
  if (typeof value.host !== "string" || !value.host || value.host.length > 253 || controls.test(value.host)) invalid("云端 SSH 主机无效。");
  const host = value.host.replace(/^\[|\]$/g, "");
  if (!isIP(host) && !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) invalid("请填写 SSH 主机名或 IP，不包含网页协议、端口和路径。");
  const port = value.port ?? 22;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) invalid("SSH 端口必须在 1 到 65535 之间。");
  if (typeof value.username !== "string" || !value.username || value.username.length > 256 || controls.test(value.username)) invalid("SSH 用户名无效。");
  return { host, port, username: value.username };
}
function connectionConfig(value: Record<string, unknown>): NativeConnectionConfig {
  const address = connectionAddress(value);
  for (const key of ["password", "privateKey", "passphrase", "hostKey"] as const) if (value[key] !== undefined && (typeof value[key] !== "string" || (value[key] as string).length > (key === "privateKey" ? 1024 * 1024 : 8192))) invalid("SSH 身份验证字段无效。");
  if (!value.password && !value.privateKey) invalid("请填写 SSH 密码或提供 SSH 私钥。");
  return { ...address, ...(value.password ? { password: value.password as string } : {}), ...(value.privateKey ? { privateKey: value.privateKey as string } : {}), ...(value.passphrase ? { passphrase: value.passphrase as string } : {}), ...(value.hostKey ? { hostKey: value.hostKey as string } : {}) };
}
/** Native errors must not expose raw engine output, command text or credentials. */
export function safeTransferError(reason: unknown, operation = "文件传输") {
  if (reason instanceof CloudFileTransferError) return reason;
  const value = reason && typeof reason === "object" ? reason as Record<string, unknown> : {};
  const code = typeof value.code === "string" ? value.code : "";
  if (["HOST_KEY_REQUIRED", "HOST_KEY_MISMATCH"].includes(code) && typeof value.hostKey === "string" && typeof value.fingerprint === "string") return new CloudFileTransferError(code === "HOST_KEY_MISMATCH" ? "SSH 主机指纹发生变化，请重新核对。" : "请先核对并确认 SSH 主机指纹。", 409, code, value.hostKey, value.fingerprint);
  if (["ENGINE_UNAVAILABLE", "FILEZILLA_ENGINE_UNAVAILABLE"].includes(code)) return new CloudFileTransferError("FileZilla 原生传输引擎尚未就绪，请检查本地服务。", 503, "ENGINE_UNAVAILABLE");
  if (["AUTH_FAILED", "AUTHENTICATION_FAILED"].includes(code)) return new CloudFileTransferError("SSH 身份验证失败，请检查用户名、密码或私钥。", 401, "AUTH_FAILED");
  if (["FILE_EXISTS", "EEXIST"].includes(code)) return new CloudFileTransferError("云端已存在同名文件，未覆盖原文件。", 409, "FILE_EXISTS");
  if (["SOURCE_CHANGED", "LOCAL_FILE_CHANGED"].includes(code)) return new CloudFileTransferError("本地文件已变化，请刷新目录后重新上传。", 409, "SOURCE_CHANGED");
  if (code === "NOT_FOUND") return new CloudFileTransferError("云端目录或文件不存在，请检查目标路径。", 404, code);
  if (code === "PERMISSION_DENIED") return new CloudFileTransferError("当前 SSH 账号没有访问该云端目录或文件的权限，请选择可访问的目录。", 403, code);
  if (code === "NOT_DIRECTORY") return new CloudFileTransferError("云端目标不是文件夹，请选择其他目录。", 409, code);
  if (code === "TIMEOUT") return new CloudFileTransferError(`${operation}超时，请刷新重试；若仍失败，请重新连接。`, 504, code);
  if (["CONNECTION_FAILED", "CONNECTION_CLOSED", "NOT_CONNECTED"].includes(code)) return new CloudFileTransferError("文件传输连接已断开，请重新连接。", 409, code);
  if (code === "INVALID_REMOTE_ENTRY") return new CloudFileTransferError("云端目录包含暂不支持的文件名，或条目过多，请尝试直接打开所需子目录。", 422, code);
  if (["INVALID_REMOTE_RESPONSE", "INVALID_RESPONSE"].includes(code)) return new CloudFileTransferError("传输服务返回的文件数据无法解析，请重新连接后重试。", 502, code);
  if (code === "BUSY") return new CloudFileTransferError("待处理的文件操作较多，请稍候再试。", 429, code);
  if (code === "LOCAL_FILE_INVALID") return new CloudFileTransferError("无法安全读取所选本地文件，请刷新本地目录后重新选择。", 409, code);
  if (code === "REMOTE_OPERATION_FAILED") return new CloudFileTransferError("云端服务器未完成文件操作，请检查目标目录是否可访问。", 502, code);
  if (code === "UPLOAD_FAILED") return new CloudFileTransferError("云端文件写入失败，请检查网络与目标目录权限。", 502, code);
  if (code === "ENOSPC") return new CloudFileTransferError("本机临时磁盘空间不足，无法接收拖入的文件。", 507, "LOCAL_DISK_FULL");
  return new CloudFileTransferError(`${operation}失败，请检查连接、目录权限和文件状态。`, 502, "TRANSFER_FAILED");
}
async function defaultConnect(config: NativeConnectionConfig, options?: NativeConnectOptions): Promise<NativeTransferConnection> {
  let bridge: typeof import("./filezilla-native");
  try { bridge = await import("./filezilla-native"); } catch { throw new CloudFileTransferError("FileZilla 原生传输引擎尚未就绪，请检查本地服务。", 503, "ENGINE_UNAVAILABLE"); }
  return bridge.FileZillaNativeConnection.connect(config, options);
}
async function defaultEngineStatus(): Promise<EngineStatus> { const { nativeTransferStatus } = await import("./filezilla-native"); return nativeTransferStatus(); }

export class CloudFileTransferService {
  readonly localRoot: string;
  private readonly factory: NonNullable<CloudFileTransferOptions["connect"]>;
  private readonly engineStatus: NonNullable<CloudFileTransferOptions["engineStatus"]>;
  private readonly now: () => number;
  private readonly passwordStore: CloudTransferPasswordStore;
  private readonly sessions = new Map<string, Session>();
  private readonly expiredSessions = new Map<string, CloudFileTransferError>();
  private pendingConnections = 0;
  private closed = false;
  constructor(options: CloudFileTransferOptions = {}) {
    this.localRoot = path.resolve(options.localRoot ?? process.env.CANVAS_TRANSFER_ROOT ?? "E:\\123\\DFCine\\DFCine0.26\\workflows");
    this.factory = options.connect ?? defaultConnect; this.engineStatus = options.engineStatus ?? defaultEngineStatus; this.now = options.now ?? Date.now;
    this.passwordStore = options.passwordStore ?? createCloudTransferPasswordStore();
  }
  private async folder(value: unknown) {
    const id = bucketId(value); await mkdir(this.localRoot, { recursive: true }); const root = await realpath(this.localRoot), target = path.join(root, id);
    await mkdir(target, { recursive: true }); const canonical = await realpath(target);
    if (!inside(root, canonical) || !(await stat(canonical)).isDirectory()) invalid("本地传输文件夹不能链接到配置目录之外。");
    return canonical;
  }
  private async localItem(root: string, relative: string) {
    const target = path.resolve(root, ...relative.split("/")); if (!inside(root, target)) invalid("本地路径超出所选文件夹。");
    const details = await lstat(target), canonical = await realpath(target);
    if (details.isSymbolicLink() || !inside(root, canonical)) invalid("不支持上传符号链接或指向目录外的文件。");
    return { canonical, details };
  }
  async status() {
    const buckets = await Promise.all(definitions.map(async item => ({ ...item, path: await this.folder(item.id) })));
    let engine: EngineStatus;
    try { engine = await this.engineStatus(); } catch { engine = { available: false, engine: "FileZilla", version: "" }; }
    return { localRoot: this.localRoot, buckets, transport: "sftp", ...engine };
  }
  async local(value: { bucket: unknown; path?: unknown }) {
    const root = await this.folder(value.bucket), relative = relativePath(value.path ?? ""), { details, canonical } = await this.localItem(root, relative);
    if (!details.isDirectory()) invalid("本地路径不是文件夹。");
    const entries: Entry[] = [];
    for (const item of await readdir(canonical, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const child = relative ? relative + "/" + item.name : item.name;
      try { const source = await this.localItem(root, child); if (!source.details.isDirectory() && !source.details.isFile()) continue; entries.push({ name: item.name, path: child, directory: source.details.isDirectory(), size: source.details.size, modified: source.details.mtimeMs }); }
      catch (reason) { if (!(reason instanceof CloudFileTransferError)) throw reason; }
    }
    entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return { path: relative, parent: relative ? path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative) : null, entries };
  }
  async passwordStatus(value: Record<string, unknown>) {
    const address = connectionAddress(value);
    try { return { saved: await this.passwordStore.has(address) }; }
    catch { throw new CloudFileTransferError("无法读取本机保存的密码状态，请重新输入密码。", 500, "PASSWORD_STORE_FAILED"); }
  }
  async forgetPassword(value: Record<string, unknown>) {
    const address = connectionAddress(value);
    try { await this.passwordStore.forget(address); return { forgotten: true }; }
    catch { throw new CloudFileTransferError("无法清除本机保存的密码，请重试。", 500, "PASSWORD_STORE_FAILED"); }
  }
  async connect(value: Record<string, unknown>, options: NativeConnectOptions = {}) {
    if (this.closed) throw new CloudFileTransferError("文件传输服务已关闭。", 503, "SERVICE_CLOSED");
    if (options.signal?.aborted) throw new CloudFileTransferError("连接已取消。", 499, "CANCELLED");
    if (["rememberPassword", "useSavedPassword"].some(key => value[key] !== undefined && typeof value[key] !== "boolean")) invalid("保存密码选项无效。");
    const address = connectionAddress(value);
    let savedPassword: string | undefined;
    if (value.useSavedPassword && !value.password && !value.privateKey) {
      try { savedPassword = await this.passwordStore.read(address); }
      catch { throw new CloudFileTransferError("无法解密本机保存的密码，请重新输入并保存。", 500, "PASSWORD_STORE_FAILED"); }
      if (!savedPassword) throw new CloudFileTransferError("该连接没有已保存的密码，请填写 SSH 密码。", 400, "PASSWORD_NOT_SAVED");
    }
    const config = connectionConfig({ ...value, ...(savedPassword ? { password: savedPassword } : {}) });
    if (this.sessions.size + this.pendingConnections >= 8) throw new CloudFileTransferError("文件传输连接过多，请先断开不用的连接。", 429, "SESSION_LIMIT");
    this.pendingConnections++;
    try {
      const connection = await this.factory(config, options);
      if (options.signal?.aborted) { await connection.close().catch(() => undefined); throw new CloudFileTransferError("连接已取消。", 499, "CANCELLED"); }
      if (this.closed) { await connection.close().catch(() => undefined); throw new CloudFileTransferError("文件传输服务已关闭。", 503, "SERVICE_CLOSED"); }
      if (!connection.hostKey || !connection.fingerprint) { await connection.close().catch(() => undefined); throw new CloudFileTransferError("传输引擎未返回 SSH 主机指纹。", 502, "INVALID_ENGINE_RESPONSE"); }
      if (!config.hostKey || config.hostKey !== connection.hostKey) {
        await connection.close().catch(() => undefined);
        throw new CloudFileTransferError(config.hostKey ? "SSH 主机指纹发生变化，请重新核对。" : "请先核对并确认 SSH 主机指纹。", 409, config.hostKey ? "HOST_KEY_MISMATCH" : "HOST_KEY_REQUIRED", connection.hostKey, connection.fingerprint);
      }
      let home: string;
      try { home = remoteTransferPath(connection.home || "/"); } catch { await connection.close().catch(() => undefined); throw new CloudFileTransferError("传输引擎返回的初始目录无效。", 502, "INVALID_ENGINE_RESPONSE"); }
      let passwordSaved = !!savedPassword, passwordWarning: string | undefined;
      if (value.rememberPassword && config.password && !config.privateKey) {
        try { await this.passwordStore.save(address, config.password); passwordSaved = true; }
        catch { passwordWarning = "SFTP 已连接，但密码未能保存到本机；请重新输入密码后再次保存。"; }
      }
      if (options.signal?.aborted || this.closed) { await connection.close().catch(() => undefined); throw new CloudFileTransferError("连接已取消。", 499, "CANCELLED"); }
      const id = randomUUID(); this.sessions.set(id, { id, connection, jobs: [], working: false, closed: false });
      return { sessionId: id, hostKey: connection.hostKey, fingerprint: connection.fingerprint, path: home, passwordSaved, ...(passwordWarning ? { passwordWarning } : {}) };
    } catch (reason) { if (options.signal?.aborted) throw new CloudFileTransferError("连接已取消。", 499, "CANCELLED"); throw safeTransferError(reason, "SSH 连接"); }
    finally { this.pendingConnections--; }
  }
  private session(value: unknown) {
    const session = typeof value === "string" ? this.sessions.get(value) : undefined;
    if (!session || session.closed) {
      const expired = typeof value === "string" ? this.expiredSessions.get(value) : undefined;
      if (expired) throw expired;
      throw new CloudFileTransferError("文件传输连接已失效，请重新连接。", 409, "SESSION_EXPIRED");
    }
    if (session.connection.isClosed?.()) throw this.sessionFailure(session, { code: "CONNECTION_CLOSED" }, "文件传输");
    return session;
  }
  private sessionFailure(session: Session, reason: unknown, operation: string) {
    const source = reason && typeof reason === "object" ? reason as { code?: unknown } : {};
    const code = typeof source.code === "string" ? source.code : "";
    const lost = session.connection.isClosed?.() === true || ["CONNECTION_CLOSED", "CONNECTION_FAILED", "NOT_CONNECTED"].includes(code);
    if (!lost) return safeTransferError(reason, operation);
    // Keep the first actionable loss reason for requests already in flight and
    // queue polling. Only finite public codes and controlled text are retained.
    const existing = this.expiredSessions.get(session.id);
    if (existing) return existing;
    const causeCode = ["TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_FAILED", "NOT_CONNECTED", "CANCELLED"].includes(code) ? code : "CONNECTION_CLOSED";
    const error = new CloudFileTransferError(causeCode === "TIMEOUT" ? `${operation}超时，文件传输连接已关闭，请重新连接。` : "文件传输连接已断开，请重新连接。", causeCode === "TIMEOUT" ? 504 : 409, "SESSION_EXPIRED", undefined, undefined, causeCode);
    session.closed = true; this.sessions.delete(session.id);
    this.expiredSessions.set(session.id, error);
    while (this.expiredSessions.size > 64) this.expiredSessions.delete(this.expiredSessions.keys().next().value!);
    for (const job of session.jobs) if (active(job)) {
      const queued = job.status === "queued"; job.abort.abort();
      if (queued) { job.status = "cancelled"; job.finishedAt = this.now(); job.manifest = []; void this.cleanupTemporary(job); }
    }
    void session.connection.close().catch(() => undefined);
    return error;
  }
  async remote(value: { sessionId: unknown; path: unknown }) {
    const session = this.session(value.sessionId), target = remoteTransferPath(value.path);
    try {
      if (!(await session.connection.stat(target)).directory) invalid("云端目标不是目录。");
      const entries = (await session.connection.list(target)).filter(item => item.name !== "." && item.name !== "..").map(item => ({ ...item, name: filename(item.name), path: path.posix.join(target, item.name) }));
      if (session.connection.isClosed?.()) throw this.sessionFailure(session, { code: "CONNECTION_CLOSED" }, "读取云端目录");
      entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
      return { path: target, parent: target === "/" ? null : path.posix.dirname(target), entries };
    } catch (reason) { throw this.sessionFailure(session, reason, "读取云端目录"); }
  }
  private async manifest(root: string, selected: string[]) {
    const result: Manifest[] = [];
    const walk = async (relative: string, uploadRelative: string, depth: number): Promise<void> => {
      if (depth > 64 || result.length >= 100_000) invalid("文件夹层级或文件数量过多，请分批上传。");
      const { canonical, details } = await this.localItem(root, relative);
      if (!details.isFile() && !details.isDirectory()) invalid("只能上传普通文件和文件夹。");
      result.push({ relative: uploadRelative, local: canonical, allowedRoot: root, directory: details.isDirectory(), identity: identity(details) });
      if (details.isDirectory()) for (const entry of await readdir(canonical)) await walk(relative + "/" + filename(entry), uploadRelative + "/" + entry, depth + 1);
    };
    for (const item of selected) await walk(item, filename(path.posix.basename(item)), 0);
    return result;
  }
  private async cleanupTemporary(job: Job) {
    const root = job.temporaryRoot; if (!root) return;
    // These two fixed, non-recursive removals can never remove user folders.
    if (path.dirname(root) !== await realpath(os.tmpdir()) || !path.basename(root).startsWith("canvas-cloud-drop-")) return;
    await unlink(path.join(root, "upload.bin")).catch(() => undefined);
    await rmdir(root).catch(() => undefined); job.temporaryRoot = undefined;
  }
  async droppedUpload(value: { sessionId: unknown; remotePath: unknown; name: unknown; size: unknown }, source: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
    const session = this.session(value.sessionId), remotePath = remoteTransferPath(value.remotePath);
    if (typeof value.name !== "string" || value.name.length > 255) invalid("拖入文件的名称无效。");
    const name = filename(value.name); remoteTransferPath(path.posix.join(remotePath, name));
    if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0) invalid("拖入文件的大小无效。");
    if (session.jobs.filter(active).length >= 20) throw new CloudFileTransferError("上传队列已满，请等待现有任务完成。", 429, "QUEUE_LIMIT");
    signal?.throwIfAborted();
    try { if (!(await session.connection.stat(remotePath)).directory) invalid("云端上传目标不是目录。"); } catch (reason) { throw this.sessionFailure(session, reason, "检查云端目录"); }
    this.session(session.id); signal?.throwIfAborted();
    if (session.jobs.filter(active).length >= 20) throw new CloudFileTransferError("上传队列已满，请等待现有任务完成。", 429, "QUEUE_LIMIT");
    const job: Job = { id: randomUUID(), status: "receiving", bytes: 0, totalBytes: value.size, files: 0, totalFiles: 1, createdAt: this.now(), manifest: [], remotePath, abort: new AbortController() };
    session.jobs = session.jobs.filter((item, index, all) => active(item) || index >= all.length - 49); session.jobs.push(job);
    const cancel = () => job.abort.abort(); signal?.addEventListener("abort", cancel, { once: true });
    try {
      job.abort.signal.throwIfAborted();
      const temporaryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), "canvas-cloud-drop-")); job.temporaryRoot = temporaryRoot;
      const local = path.join(temporaryRoot, "upload.bin"), handle = await open(local, "wx", 0o600);
      const counter = new Transform({ transform(chunk: Buffer, _encoding, done) {
        const next = job.bytes + chunk.length;
        if (!Number.isSafeInteger(next) || next > job.totalBytes) { done(new CloudFileTransferError("拖入文件的数据超出声明大小，已停止接收。", 400, "FILE_SIZE_MISMATCH")); return; }
        job.bytes = next; done(null, chunk);
      } });
      try { await pipeline(source, counter, handle.createWriteStream(), { signal: job.abort.signal }); }
      finally { await handle.close().catch(() => undefined); }
      if (job.bytes !== job.totalBytes) throw new CloudFileTransferError("拖入文件未完整传到本机，请重新拖入。", 400, "FILE_SIZE_MISMATCH");
      job.abort.signal.throwIfAborted(); this.session(session.id);
      const details = await lstat(local);
      job.manifest = [{ relative: name, local, allowedRoot: temporaryRoot, directory: false, identity: identity(details) }];
      job.bytes = 0; job.status = "queued"; void this.pump(session);
      return { jobId: job.id };
    } catch (reason) {
      const cancelled = job.abort.signal.aborted || signal?.aborted;
      job.status = cancelled ? "cancelled" : "failed"; job.finishedAt = this.now(); job.manifest = [];
      const error = cancelled ? new CloudFileTransferError("拖入文件接收已取消。", 499, "CANCELLED") : safeTransferError(reason, "接收拖入文件");
      if (!cancelled) job.error = error.message; await this.cleanupTemporary(job); throw error;
    } finally { signal?.removeEventListener("abort", cancel); }
  }
  async upload(value: { sessionId: unknown; bucket: unknown; paths: unknown; remotePath: unknown }) {
    const session = this.session(value.sessionId), remotePath = remoteTransferPath(value.remotePath), root = await this.folder(value.bucket);
    if (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 1000) invalid("请选择 1 至 1000 个本地文件或文件夹。");
    const sorted = [...new Set(value.paths.map(item => relativePath(item, false)))].sort();
    const selected = sorted.filter(item => !sorted.some(parent => parent !== item && item.startsWith(parent + "/")));
    if (session.jobs.filter(active).length >= 20) throw new CloudFileTransferError("上传队列已满，请等待现有任务完成。", 429, "QUEUE_LIMIT");
    const manifest = await this.manifest(root, selected);
    if (new Set(manifest.map(item => item.relative)).size !== manifest.length) invalid("所选文件夹包含同名上传目标，请分批上传。");
    try { if (!(await session.connection.stat(remotePath)).directory) invalid("云端上传目标不是目录。"); } catch (reason) { throw this.sessionFailure(session, reason, "检查云端目录"); }
    if (session.connection.isClosed?.()) throw this.sessionFailure(session, { code: "CONNECTION_CLOSED" }, "检查云端目录");
    const totalBytes = manifest.filter(item => !item.directory).reduce((total, item) => total + item.identity.size, 0);
    if (!Number.isSafeInteger(totalBytes)) invalid("上传文件总大小超出支持范围，请分批上传。");
    if (session.closed) throw new CloudFileTransferError("文件传输连接已失效，请重新连接。", 409, "SESSION_EXPIRED");
    if (session.jobs.filter(active).length >= 20) throw new CloudFileTransferError("上传队列已满，请等待现有任务完成。", 429, "QUEUE_LIMIT");
    const job: Job = { id: randomUUID(), status: "queued", bytes: 0, totalBytes, files: 0, totalFiles: manifest.filter(item => !item.directory).length, createdAt: this.now(), manifest, remotePath, abort: new AbortController() };
    session.jobs = session.jobs.filter((item, index, all) => active(item) || index >= all.length - 49); session.jobs.push(job); void this.pump(session);
    return { jobId: job.id };
  }
  private async ensureDirectory(session: Session, target: string) {
    try { if ((await session.connection.stat(target)).directory) return; throw new CloudFileTransferError("云端同名目标不是文件夹。", 409, "FILE_EXISTS"); }
    catch (reason) {
      if (reason instanceof CloudFileTransferError) throw reason;
      try { await session.connection.mkdir(target); }
      catch { if (!(await session.connection.stat(target)).directory) throw new CloudFileTransferError("无法创建云端目标文件夹。", 502); }
    }
  }
  private async pump(session: Session) {
    if (session.working || session.closed) return; session.working = true;
    try {
      while (!session.closed) {
        const job = session.jobs.find(item => item.status === "queued");
        if (!job) break;
        job.status = "uploading"; job.startedAt = this.now(); let completedBytes = 0;
        try {
          for (const item of job.manifest) {
            job.abort.signal.throwIfAborted();
            const target = path.posix.join(job.remotePath, item.relative);
            if (item.directory) { await this.ensureDirectory(session, target); continue; }
            const canonical = await realpath(item.local), details = await lstat(item.local);
            if (canonical !== item.local || details.isSymbolicLink() || !details.isFile() || !sameIdentity(item.identity, identity(details))) throw new CloudFileTransferError("本地文件已变化，请刷新目录后重新上传。", 409, "SOURCE_CHANGED");
            const handle = await open(item.local, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            try {
              if (!sameIdentity(item.identity, identity(await handle.stat()))) throw new CloudFileTransferError("本地文件已变化，请重新上传。", 409, "SOURCE_CHANGED");
              await session.connection.upload(item.local, target, { signal: job.abort.signal, expectedIdentity: item.identity, allowedRoot: item.allowedRoot, onProgress: value => { if (Number.isFinite(value)) job.bytes = Math.max(job.bytes, completedBytes + Math.min(item.identity.size, Math.max(0, value))); } });
            } finally { await handle.close(); }
            completedBytes += item.identity.size; job.bytes = completedBytes; job.files++;
          }
          // An engine commit that already succeeded wins over a late cancel.
          // Cancellation is still checked before starting every remaining item.
          job.status = "completed";
        } catch (reason) { const cancelled = job.abort.signal.aborted; const error = this.sessionFailure(session, reason, "上传文件"); job.status = cancelled ? "cancelled" : "failed"; if (job.status === "failed") job.error = error.message; }
        finally { job.finishedAt = this.now(); job.manifest = []; await this.cleanupTemporary(job); }
      }
    } finally { session.working = false; }
  }
  async jobs(value: { sessionId: unknown }) {
    const now = this.now();
    return { jobs: this.session(value.sessionId).jobs.map(({ manifest: _manifest, remotePath: _remotePath, abort: _abort, temporaryRoot: _temporaryRoot, ...job }) => {
      if (job.startedAt === undefined || job.status === "queued" || job.status === "receiving") return job;
      // Use the engine's transfer progress and time spent actively uploading.
      // FileZilla reports submitted bytes; completion still waits for its final result.
      // Completed jobs use their finish time so later queue polling cannot lower
      // the reported average. These timestamps never impose a transfer deadline.
      const elapsed = Math.min(now, job.finishedAt ?? now) - job.startedAt;
      const average = elapsed > 0 ? Math.max(0, job.bytes) * 1000 / elapsed : 0;
      return { ...job, bytesPerSecond: Number.isFinite(average) && average >= 0 ? average : 0 };
    }) };
  }
  async cancel(value: { sessionId: unknown; jobId: unknown }) {
    const session = this.session(value.sessionId), job = session.jobs.find(item => item.id === value.jobId);
    if (!job) throw new CloudFileTransferError("上传任务不存在。", 404, "JOB_NOT_FOUND");
    if (active(job)) { const queued = job.status === "queued"; job.abort.abort(); job.status = queued ? "cancelled" : "cancelling"; if (queued) { job.finishedAt = this.now(); job.manifest = []; await this.cleanupTemporary(job); } }
    return { cancelled: true };
  }
  async disconnect(value: { sessionId: unknown }) {
    const session = this.session(value.sessionId);
    if (session.jobs.some(active)) throw new CloudFileTransferError("请先取消或等待上传完成后再断开。", 409, "UPLOAD_ACTIVE");
    session.closed = true; this.sessions.delete(session.id); await session.connection.close().catch(() => undefined); return { disconnected: true };
  }
  async close() {
    if (this.closed) return; this.closed = true;
    const sessions = [...this.sessions.values()], cleanups: Promise<void>[] = []; this.sessions.clear(); this.expiredSessions.clear();
    for (const session of sessions) {
      session.closed = true;
      for (const job of session.jobs) if (active(job)) {
        const queued = job.status === "queued"; job.abort.abort();
        if (queued) { job.status = "cancelled"; job.finishedAt = this.now(); job.manifest = []; cleanups.push(this.cleanupTemporary(job)); }
      }
    }
    await Promise.allSettled([...sessions.map(session => session.connection.close()), ...cleanups]);
  }
}
