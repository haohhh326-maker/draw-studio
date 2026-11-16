import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { openNativeTransport } from "./filezilla-native-transport";
import type { NativeConnectionConfig, NativeTransferConnection, SourceIdentity } from "./cloud-file-transfer";

type Pending = {
  type: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  progress?: (bytes: number) => void;
};
type UploadOptions = { signal?: AbortSignal; onProgress?: (bytes: number) => void; expectedIdentity?: SourceIdentity; allowedRoot?: string };
const bridgeRelative = process.env.CANVAS_TRANSFER_ENGINE_BINARY || ".cache/native-filezilla-official/bridge/cloud-transfer-bridge";
const distro = process.env.CANVAS_TRANSFER_WSL_DISTRO || "Ubuntu-22.04";
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export class FileZillaNativeError extends Error {
  constructor(message: string, public code: string, public hostKey?: string, public fingerprint?: string, public operation?: string) { super(message); }
}
function unavailable() { return new FileZillaNativeError("FileZilla 原生传输组件尚未就绪。", "ENGINE_UNAVAILABLE"); }
function changed() { return new FileZillaNativeError("待上传的本地文件已经变化。", "SOURCE_CHANGED"); }
function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }

/** WSL receives a literal argument, never a shell command. */
export function nativeFilePath(value: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return value;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (!match || /[\x00-\x1f\x7f]/.test(value)) throw new FileZillaNativeError("本地文件路径不能传给原生传输组件。", "INVALID_LOCAL_PATH");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}
async function command() {
  const root = await realpath(process.cwd());
  const binary = await realpath(path.resolve(root, bridgeRelative)).catch(() => { throw unavailable(); });
  if (!(await stat(binary)).isFile()) throw unavailable();
  const libraries = path.resolve(root, process.env.CANVAS_TRANSFER_ENGINE_LIBRARIES || ".cache/native-filezilla-official/prefix/lib");
  return process.platform === "win32"
    ? { executable: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wsl.exe"), args: ["--distribution", distro, "--exec", "/usr/bin/env", `LD_LIBRARY_PATH=${nativeFilePath(libraries)}`, nativeFilePath(binary)] }
    : { executable: "/usr/bin/env", args: [`LD_LIBRARY_PATH=${libraries}`, binary] };
}

class NativeBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private buffer = "";
  private closed = false;
  isClosed() { return this.closed; }
  constructor(executable: string, args: string[], private readonly releaseTransport: () => void = () => {}) {
    this.child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => this.fail(unavailable()));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    // Native diagnostics are not returned to the UI or persisted, especially during authentication.
    this.child.stderr.resume();
    this.child.on("error", () => this.fail(unavailable()));
    this.child.on("close", () => this.fail(new FileZillaNativeError("原生文件传输连接已关闭。", "CONNECTION_CLOSED")));
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.releaseTransport();
    this.child.stdin.end();
    this.child.kill();
  }
  private receive(chunk: string) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > 16 * 1024 * 1024) { this.fail(new FileZillaNativeError("原生目录响应过大。", "INVALID_RESPONSE")); return; }
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let data: unknown;
      try { data = JSON.parse(line); } catch { this.fail(new FileZillaNativeError("原生传输组件返回了无效响应。", "INVALID_RESPONSE")); return; }
      if (!isRecord(data)) continue;
      if (data.event === "disconnected") { this.fail(new FileZillaNativeError("SFTP 连接已断开，请重新连接。", "CONNECTION_FAILED")); return; }
      if (typeof data.id !== "string") continue;
      const request = this.pending.get(data.id);
      if (!request) continue;
      if (data.event === "progress") {
        request.progress?.(number(data.bytes)); continue;
      }
      this.pending.delete(data.id);
      if (data.ok === true && isRecord(data.result)) request.resolve(data.result);
      else {
        const error = isRecord(data.error) ? data.error : {};
        // The HTTP layer translates these finite codes into user-facing messages.
        request.reject(new FileZillaNativeError("FileZilla 传输操作失败。", typeof error.code === "string" ? error.code : "TRANSFER_FAILED", typeof error.hostKey === "string" ? error.hostKey : undefined, typeof error.fingerprint === "string" ? error.fingerprint : undefined));
      }
    }
  }
  call(type: string, body: Record<string, unknown> = {}, options: { progress?: (bytes: number) => void; signal?: AbortSignal } = {}) {
    const id = String(++this.nextId);
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.closed) { reject(new FileZillaNativeError("原生文件传输连接已关闭。", "CONNECTION_CLOSED")); return; }
      if (options.signal?.aborted) { reject(new FileZillaNativeError("传输已取消。", "CANCELLED")); return; }
      this.pending.set(id, { type, resolve, reject, progress: options.progress });
      this.child.stdin.write(JSON.stringify({ id, type, ...body }) + "\n", error => { if (error) this.fail(unavailable()); });
    });
    const abort = () => { void this.call("cancel", { operationId: id }).promise.catch(() => { this.fail(new FileZillaNativeError("传输已取消。", "CANCELLED")); }); };
    options.signal?.addEventListener("abort", abort, { once: true });
    // finally itself would create an unobserved rejected promise; both branches clean up.
    void promise.then(() => options.signal?.removeEventListener("abort", abort), () => options.signal?.removeEventListener("abort", abort));
    return { id, promise };
  }
  async close() {
    if (this.closed) return;
    try { await this.call("close").promise; } catch { /* A real connection failure may already have closed this helper. */ }
    this.fail(new FileZillaNativeError("原生文件传输连接已关闭。", "CONNECTION_CLOSED"));
  }
  cancelConnect() { this.fail(new FileZillaNativeError("连接已取消。", "CANCELLED")); }
}

export async function nativeTransferStatus(): Promise<{ available: boolean; engine: string; version: string }> {
  try {
    const native = await command();
    return await new Promise(resolve => {
      const processHandle = spawn(native.executable, [...native.args, "--version"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      processHandle.stdout.setEncoding("utf8"); processHandle.stdout.on("data", chunk => { if (output.length < 4096) output += String(chunk); });
      processHandle.once("error", () => { resolve({ available: false, engine: "FileZilla 官方引擎", version: "" }); });
      processHandle.once("close", code => {
        let data: unknown; try { data = JSON.parse(output.trim()); } catch { data = null; }
        const version = isRecord(data) && typeof data.filezilla === "string" ? data.filezilla : "";
        resolve({ available: code === 0 && !!version, engine: "FileZilla 官方引擎", version });
      });
    });
  } catch { return { available: false, engine: "FileZilla 官方引擎", version: "" }; }
}

export class FileZillaNativeConnection implements NativeTransferConnection {
  private constructor(private readonly bridge: NativeBridge, public readonly hostKey: string, public readonly fingerprint: string, public readonly home: string) {}
  isClosed() { return this.bridge.isClosed(); }
  static async connect(config: NativeConnectionConfig, options: { signal?: AbortSignal } = {}) {
    const launch = await command();
    if (options.signal?.aborted) throw new FileZillaNativeError("连接已取消。", "CANCELLED");
    // Windows owns the network socket; the unmodified FileZilla Client engine
    // performs SSH/SFTP and upload scheduling over a private loopback stream.
    const transport = await openNativeTransport(config.host, config.port);
    if (options.signal?.aborted) { transport.close(); throw new FileZillaNativeError("连接已取消。", "CANCELLED"); }
    let bridge: NativeBridge;
    try { bridge = new NativeBridge(launch.executable, launch.args, () => transport.close()); }
    catch { transport.close(); throw unavailable(); }
    const abort = () => bridge.cancelConnect();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await bridge.call("connect", { ...config, host: transport.host, port: transport.port }).promise;
      if (typeof result.hostKey !== "string" || !/^[a-f0-9]{64}$/i.test(result.hostKey) || typeof result.fingerprint !== "string" || typeof result.home !== "string" || !result.home.startsWith("/")) throw new FileZillaNativeError("原生连接响应不完整。", "INVALID_RESPONSE");
      return new FileZillaNativeConnection(bridge, result.hostKey, result.fingerprint, result.home);
    } catch (error) { await bridge.close(); throw error; }
    finally { options.signal?.removeEventListener("abort", abort); }
  }
  async list(remotePath: string) {
    const result = await this.bridge.call("list", { path: remotePath }).promise;
    if (!Array.isArray(result.entries)) throw new FileZillaNativeError("原生目录响应不完整。", "INVALID_RESPONSE");
    const entries: Array<{ name: string; directory: boolean; symlink?: boolean; size: number; modified?: number }> = [];
    for (const value of result.entries) {
      if (!isRecord(value) || typeof value.name !== "string" || typeof value.directory !== "boolean") throw new FileZillaNativeError("原生目录条目无效。", "INVALID_RESPONSE");
      // A cloud link can target a suspended FUSE mount. Listing must not stat
      // every target: resolve links only when the user chooses to open one.
      entries.push({ name: value.name, directory: value.directory, ...(value.symlink === true ? { symlink: true } : {}), size: number(value.size), ...(typeof value.modified === "number" ? { modified: value.modified } : {}) });
    }
    return entries;
  }
  async stat(remotePath: string) {
    const result = await this.bridge.call("stat", { path: remotePath }).promise;
    if (typeof result.directory !== "boolean") throw new FileZillaNativeError("原生文件响应无效。", "INVALID_RESPONSE");
    return { directory: result.directory, size: number(result.size) };
  }
  async mkdir(remotePath: string) { await this.bridge.call("mkdir", { path: remotePath }).promise; }
  async upload(localPath: string, remotePath: string, options: UploadOptions) {
    if (!options.allowedRoot) throw new FileZillaNativeError("上传缺少受限本地目录。", "INVALID_LOCAL_PATH");
    const canonical = await realpath(localPath), allowedRoot = await realpath(options.allowedRoot);
    const relative = path.relative(allowedRoot, canonical);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw changed();
    const handle = await open(canonical, "r");
    try {
      const current = await handle.stat(), expected = options.expectedIdentity;
      if (!current.isFile() || expected && (current.dev !== expected.dev || current.ino !== expected.ino || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs)) throw changed();
      await this.bridge.call("upload", { localPath: nativeFilePath(canonical), remotePath, allowedRoot: nativeFilePath(allowedRoot), expectedIdentity: { size: current.size, mtimeMs: current.mtimeMs } }, { signal: options.signal, progress: options.onProgress }).promise;
    } finally { await handle.close(); }
  }
  async close() { await this.bridge.close(); }
}
