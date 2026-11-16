import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CloudFileTransferService, remoteTransferPath, type NativeTransferConnection, type SourceIdentity } from "../scripts/cloud-file-transfer";
import { cloudFileTransferHandler, trustedTransferRequest } from "../scripts/cloud-file-transfer-plugin";

const roots: string[] = [], cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith("canvas-transfer-test-")) throw new Error("Refusing cleanup outside the fixture");
    await rm(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
const credentials = { host: "cloud.example.test", port: 2222, username: "root", password: "test-secret-never-logged", hostKey: "fixture-host-key" };
class NativeFixture implements NativeTransferConnection {
  hostKey = "fixture-host-key";
  fingerprint = "SHA256:fixture-fingerprint";
  home = "/home";
  directories = new Set(["/", "/home", "/target"]);
  files = new Map<string, Buffer>();
  uploads: { local: string; remote: string; expected?: SourceIdentity }[] = [];
  closed = false;
  hold = false;
  release?: () => void;
  beforeStat?: () => Promise<void>;
  async list(location: string) { return [...this.directories].filter(item => item !== location && path.posix.dirname(item) === location).map(item => ({ name: path.posix.basename(item), directory: true, size: 0 })); }
  async stat(location: string) { const before = this.beforeStat; this.beforeStat = undefined; await before?.(); if (this.directories.has(location)) return { directory: true, size: 0 }; if (this.files.has(location)) return { directory: false, size: this.files.get(location)!.length }; throw Object.assign(new Error("missing"), { code: "ENOENT" }); }
  async mkdir(location: string) { if (this.files.has(location)) throw Object.assign(new Error("exists"), { code: "EEXIST" }); this.directories.add(location); }
  async upload(local: string, remote: string, options: { signal?: AbortSignal; onProgress?: (bytes: number) => void; expectedIdentity?: SourceIdentity }) {
    this.uploads.push({ local, remote, expected: options.expectedIdentity });
    if (this.hold) await new Promise<void>((resolve, reject) => { this.release = resolve; if (options.signal?.aborted) { reject(options.signal.reason); return; } options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }); if (!options.signal) resolve(); });
    if (this.files.has(remote)) throw Object.assign(new Error("remote secret existing-file details"), { code: "FILE_EXISTS" });
    options.signal?.throwIfAborted(); const data = await readFile(local); options.onProgress?.(data.length); this.files.set(remote, data);
  }
  async close() { this.closed = true; }
  isClosed() { return this.closed; }
}
async function fixture(options: { now?: () => number; connection?: NativeFixture } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-transfer-test-")); roots.push(root);
  const localRoot = path.join(root, "local files"), native = options.connection ?? new NativeFixture();
  const connect = vi.fn(async () => native);
  const service = new CloudFileTransferService({ localRoot, connect, engineStatus: async () => ({ available: true, engine: "FileZilla native test fixture", version: "fixture" }), ...options });
  cleanup.push(() => service.close()); await service.status();
  return { root, localRoot, native, service, connect };
}
async function terminal(service: CloudFileTransferService, sessionId: string) { await vi.waitFor(async () => { expect((await service.jobs({ sessionId })).jobs.every(job => ["completed", "failed", "cancelled"].includes(job.status))).toBe(true); }); return (await service.jobs({ sessionId })).jobs; }
async function api(service: CloudFileTransferService) {
  const handle = cloudFileTransferHandler({ service });
  const server = http.createServer((request, response) => { void handle(request, response, () => { response.writeHead(404, { "content-type": "application/json" }); response.end("{}"); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as AddressInfo).port;
  const send = (route: string, body?: unknown, extra: http.OutgoingHttpHeaders = {}) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, method: body === undefined ? "GET" : "POST", path: "/__canvas/cloud-files" + route, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra } }, response => {
      let value = ""; response.setEncoding("utf8"); response.on("data", chunk => { value += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(value) }));
    }); request.on("error", reject); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return Object.assign(send, { port });
}

describe("embedded native cloud transfer service", () => {
  it("creates the three fixed folders and lists their relative paths without a connection", async () => {
    const { service, localRoot, connect } = await fixture();
    expect(await service.status()).toMatchObject({ localRoot, available: true, transport: "sftp", buckets: [ { id: "comfyui_nodes" }, { id: "loras" }, { id: "cloud_upload" } ] });
    await mkdir(path.join(localRoot, "cloud_upload", "first")); await writeFile(path.join(localRoot, "cloud_upload", "first", "input.txt"), "abc");
    expect(await service.local({ bucket: "cloud_upload", path: "first" })).toMatchObject({ path: "first", parent: "", entries: [{ name: "input.txt", path: "first/input.txt", directory: false, size: 3 }] });
    expect((await service.local({ bucket: "cloud_upload" })).parent).toBeNull(); expect(connect).not.toHaveBeenCalled();
  });
  it("preserves recursive directory basenames and uploads to an arbitrary chosen destination", async () => {
    const { service, localRoot, native } = await fixture(), { sessionId } = await service.connect(credentials);
    await mkdir(path.join(localRoot, "comfyui_nodes", "My Node", "nested"), { recursive: true });
    await writeFile(path.join(localRoot, "comfyui_nodes", "My Node", "__init__.py"), "node"); await writeFile(path.join(localRoot, "comfyui_nodes", "My Node", "nested", "data.txt"), "five!");
    await service.upload({ sessionId, bucket: "comfyui_nodes", paths: ["My Node", "My Node/nested/data.txt"], remotePath: "/target" });
    const [job] = await terminal(service, sessionId);
    expect(job).toMatchObject({ status: "completed", files: 2, totalFiles: 2, bytes: 9, totalBytes: 9 });
    expect([...native.directories]).toContain("/target/My Node/nested"); expect(native.files.get("/target/My Node/__init__.py")?.toString()).toBe("node");
    expect(native.uploads.every(item => item.expected?.size && item.expected.ino !== undefined)).toBe(true);
    expect(JSON.stringify(await service.jobs({ sessionId }))).not.toContain(localRoot); expect(JSON.stringify(job)).not.toContain(credentials.password);
  });
  it("processes tasks added while another upload is still running and cancels queued or active work", async () => {
    const { service, localRoot, native } = await fixture(), { sessionId } = await service.connect(credentials);
    await writeFile(path.join(localRoot, "cloud_upload", "first.txt"), "first"); await writeFile(path.join(localRoot, "cloud_upload", "second.txt"), "second"); native.hold = true;
    const first = await service.upload({ sessionId, bucket: "cloud_upload", paths: ["first.txt"], remotePath: "/target" });
    await vi.waitFor(() => expect(native.uploads).toHaveLength(1));
    const second = await service.upload({ sessionId, bucket: "cloud_upload", paths: ["second.txt"], remotePath: "/target" });
    await expect(service.disconnect({ sessionId })).rejects.toMatchObject({ code: "UPLOAD_ACTIVE" });
    await service.cancel({ sessionId, jobId: second.jobId }); await service.cancel({ sessionId, jobId: first.jobId });
    expect((await terminal(service, sessionId)).map(job => job.status)).toEqual(["cancelled", "cancelled"]); expect(native.uploads).toHaveLength(1);
    native.hold = false; await service.upload({ sessionId, bucket: "cloud_upload", paths: ["second.txt"], remotePath: "/target" });
    expect((await terminal(service, sessionId)).at(-1)?.status).toBe("completed");
    await service.disconnect({ sessionId }); expect(native.closed).toBe(true);
  });
  it("measures engine upload progress without queue time and freezes the completed average", async () => {
    let now = 1000;
    const { service, localRoot, native } = await fixture({ now: () => now }), { sessionId } = await service.connect(credentials);
    await writeFile(path.join(localRoot, "cloud_upload", "first.bin"), Buffer.alloc(2048));
    await writeFile(path.join(localRoot, "cloud_upload", "second.bin"), Buffer.alloc(2048));
    const transfers: { progress: (bytes: number) => void; finish: () => void }[] = [];
    native.upload = async (_local, _remote, options) => {
      await new Promise<void>((resolve, reject) => {
        transfers.push({ progress: value => options.onProgress?.(value), finish: resolve });
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    };
    await service.upload({ sessionId, bucket: "cloud_upload", paths: ["first.bin"], remotePath: "/target" });
    await vi.waitFor(() => expect(transfers).toHaveLength(1));
    now = 2000;
    const second = await service.upload({ sessionId, bucket: "cloud_upload", paths: ["second.bin"], remotePath: "/target" });
    expect((await service.jobs({ sessionId })).jobs[0]).toMatchObject({ bytes: 0, bytesPerSecond: 0 });
    expect((await service.jobs({ sessionId })).jobs[1]).not.toHaveProperty("bytesPerSecond");
    now = 62_000; transfers[0].finish();
    await vi.waitFor(() => expect(transfers).toHaveLength(2));
    transfers[1].progress(1024); now = 64_000;
    expect((await service.jobs({ sessionId })).jobs.find(job => job.id === second.jobId))
      .toMatchObject({ status: "uploading", createdAt: 2000, startedAt: 62_000, bytes: 1024, bytesPerSecond: 512 });
    now = 66_000; transfers[1].finish();
    expect((await terminal(service, sessionId))[1]).toMatchObject({ status: "completed", finishedAt: 66_000, bytes: 2048, bytesPerSecond: 512 });
    now = 3600_000;
    expect((await service.jobs({ sessionId })).jobs[1]).toMatchObject({ bytesPerSecond: 512 });
  });
  it("keeps a successfully committed final file completed when cancellation arrives during commit", async () => {
    const { service, localRoot, native } = await fixture(), { sessionId } = await service.connect(credentials);
    await writeFile(path.join(localRoot, "cloud_upload", "committed.txt"), "committed");
    let committing: (() => void) | undefined, finish: (() => void) | undefined;
    const atCommit = new Promise<void>(resolve => { committing = resolve; });
    native.upload = async (_local, remote, options) => {
      options.onProgress?.(9); committing!();
      await new Promise<void>(resolve => { finish = resolve; });
      native.files.set(remote, Buffer.from("committed"));
    };
    const { jobId } = await service.upload({ sessionId, bucket: "cloud_upload", paths: ["committed.txt"], remotePath: "/target" });
    await atCommit; await service.cancel({ sessionId, jobId }); finish!();
    expect((await terminal(service, sessionId))[0]).toMatchObject({ status: "completed", files: 1, bytes: 9 });
    expect(native.files.get("/target/committed.txt")?.toString()).toBe("committed");
  });
  it("reports finite nonnegative speeds when elapsed time is zero or the clock moves backward", async () => {
    let now = 0;
    const { service, localRoot, native } = await fixture({ now: () => now }), { sessionId } = await service.connect(credentials);
    await writeFile(path.join(localRoot, "cloud_upload", "clock.bin"), Buffer.alloc(1024));
    let progress: ((value: number) => void) | undefined;
    native.upload = async (_local, _remote, options) => {
      progress = value => options.onProgress?.(value);
      await new Promise<void>((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
    };
    const { jobId } = await service.upload({ sessionId, bucket: "cloud_upload", paths: ["clock.bin"], remotePath: "/target" });
    await vi.waitFor(() => expect(progress).toBeDefined());
    expect((await service.jobs({ sessionId })).jobs[0]).toHaveProperty("startedAt", 0);
    progress!(512);
    for (const next of [0, -1000, Number.NaN, Number.POSITIVE_INFINITY]) {
      now = next;
      expect((await service.jobs({ sessionId })).jobs[0]).toMatchObject({ bytesPerSecond: 0 });
    }
    now = 1000; await service.cancel({ sessionId, jobId });
    await terminal(service, sessionId);
  });
  it("reports no-overwrite failures without replacing remote data or leaking native errors", async () => {
    const { service, localRoot, native } = await fixture(), { sessionId } = await service.connect(credentials);
    await writeFile(path.join(localRoot, "loras", "model.safetensors"), "new"); native.files.set("/target/model.safetensors", Buffer.from("existing"));
    await service.upload({ sessionId, bucket: "loras", paths: ["model.safetensors"], remotePath: "/target" });
    expect((await terminal(service, sessionId))[0]).toMatchObject({ status: "failed", error: "云端已存在同名文件，未覆盖原文件。" }); expect(native.files.get("/target/model.safetensors")?.toString()).toBe("existing");
  });
  it("drains a second task added after the worker has already started", async () => {
    const { service, localRoot, native } = await fixture(), { sessionId } = await service.connect(credentials);
    await writeFile(path.join(localRoot, "cloud_upload", "first.txt"), "first"); await writeFile(path.join(localRoot, "cloud_upload", "second.txt"), "second"); native.hold = true;
    await service.upload({ sessionId, bucket: "cloud_upload", paths: ["first.txt"], remotePath: "/target" }); await vi.waitFor(() => expect(native.uploads).toHaveLength(1));
    await service.upload({ sessionId, bucket: "cloud_upload", paths: ["second.txt"], remotePath: "/target" });
    native.hold = false; native.release?.();
    expect((await terminal(service, sessionId)).map(job => job.status)).toEqual(["completed", "completed"]); expect(native.files.get("/target/second.txt")?.toString()).toBe("second");
  });
  it("rejects traversal, escaping links, and local sources changed after manifest creation", async () => {
    const { service, root, localRoot, native } = await fixture(), { sessionId } = await service.connect(credentials);
    const outside = path.join(root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "secret.txt"), "not-uploaded");
    await symlink(outside, path.join(localRoot, "cloud_upload", "link"), process.platform === "win32" ? "junction" : "dir");
    expect((await service.local({ bucket: "cloud_upload" })).entries).toEqual([]);
    for (const target of ["../outside/secret.txt", "link", "C:/Windows", "/absolute"]) await expect(service.upload({ sessionId, bucket: "cloud_upload", paths: [target], remotePath: "/target" })).rejects.toThrow();
    const file = path.join(localRoot, "cloud_upload", "changed.txt"); await writeFile(file, "original");
    native.beforeStat = async () => { await writeFile(file, "new longer data"); };
    await service.upload({ sessionId, bucket: "cloud_upload", paths: ["changed.txt"], remotePath: "/target" });
    expect((await terminal(service, sessionId))[0]).toMatchObject({ status: "failed", error: "本地文件已变化，请刷新目录后重新上传。" }); expect(native.uploads).toHaveLength(0);
  });
  it("does not follow a fixed bucket junction outside the user-configured root", async () => {
    const { root, localRoot, service } = await fixture(); const outside = path.join(root, "outside"); await mkdir(outside); await rm(path.join(localRoot, "loras"), { recursive: true });
    await symlink(outside, path.join(localRoot, "loras"), process.platform === "win32" ? "junction" : "dir");
    await expect(service.status()).rejects.toThrow("之外");
  });
  it("keeps idle sessions connected regardless of elapsed local time", async () => {
    let now = 0; const { service, native } = await fixture({ now: () => now }), { sessionId } = await service.connect(credentials);
    now = 36_500 * 24 * 60 * 60 * 1000;
    expect(await service.jobs({ sessionId })).toEqual({ jobs: [] }); expect((await service.remote({ sessionId, path: "/target" })).path).toBe("/target"); expect(native.closed).toBe(false);
  });
  it("lets the user cancel a pending connection without exhausting connection slots", async () => {
    const { localRoot, native } = await fixture();
    const service = new CloudFileTransferService({ localRoot, connect: async (_config, options) => {
      if (!options?.signal) return native;
      return await new Promise<NativeFixture>((_, reject) => options.signal!.addEventListener("abort", () => reject(new Error(credentials.password)), { once: true }));
    } }); cleanup.push(() => service.close());
    for (let attempt = 0; attempt < 10; attempt++) {
      const controller = new AbortController(), connecting = service.connect(credentials, { signal: controller.signal }); controller.abort();
      await expect(connecting).rejects.toMatchObject({ code: "CANCELLED" });
    }
    const { sessionId } = await service.connect(credentials); expect(await service.jobs({ sessionId })).toEqual({ jobs: [] });
  });
  it("closes a connection that finishes after the user already cancelled it", async () => {
    const { localRoot, native } = await fixture(); let finish: (value: NativeFixture) => void = () => undefined;
    const service = new CloudFileTransferService({ localRoot, connect: async () => await new Promise<NativeFixture>(resolve => { finish = resolve; }) }); cleanup.push(() => service.close());
    const controller = new AbortController(), connecting = service.connect(credentials, { signal: controller.signal }); controller.abort(); finish(native);
    await expect(connecting).rejects.toMatchObject({ code: "CANCELLED" }); expect(native.closed).toBe(true);
  });
  it("keeps actionable native directory error codes without raw output or dropping the authenticated session", async () => {
    const { service, native } = await fixture(), { sessionId } = await service.connect(credentials);
    for (const [code, status, snippet] of [
      ["NOT_FOUND", 404, "不存在"], ["PERMISSION_DENIED", 403, "没有访问"], ["TIMEOUT", 504, "超时"],
      ["INVALID_REMOTE_RESPONSE", 502, "无法解析"], ["INVALID_REMOTE_ENTRY", 422, "文件名"], ["REMOTE_OPERATION_FAILED", 502, "可访问"],
    ] as const) {
      native.beforeStat = async () => { throw Object.assign(new Error("native private output " + credentials.password), { code }); };
      const error = await service.remote({ sessionId, path: "/target" }).then(() => undefined, reason => reason);
      expect(error).toMatchObject({ code, status }); expect(error.message).toContain(snippet); expect(error.message).not.toContain(credentials.password);
    }
    expect((await service.remote({ sessionId, path: "/target" })).path).toBe("/target"); expect(native.closed).toBe(false);
  });
  it("preserves remote symlink metadata without probing unrelated link targets", async () => {
    const { service, native } = await fixture(), { sessionId } = await service.connect(credentials), query = vi.spyOn(native, "stat");
    vi.spyOn(native, "list").mockImplementation(async () => [{ name: "slow-mounted-models", directory: false, size: 0, symlink: true }]);
    expect(await service.remote({ sessionId, path: "/target" })).toMatchObject({ path: "/target", entries: [{ name: "slow-mounted-models", path: "/target/slow-mounted-models", directory: false, symlink: true }] });
    expect(query.mock.calls).toEqual([["/target"]]); expect(native.closed).toBe(false);
  });
  it("drops a dead native session and makes subsequent queue polling restore the connection form", async () => {
    const { service, native } = await fixture(), { sessionId } = await service.connect(credentials);
    native.beforeStat = async () => { native.closed = true; throw Object.assign(new Error(credentials.password), { code: "CONNECTION_CLOSED" }); };
    await expect(service.remote({ sessionId, path: "/target" })).rejects.toMatchObject({ code: "SESSION_EXPIRED", causeCode: "CONNECTION_CLOSED" });
    await expect(service.jobs({ sessionId })).rejects.toMatchObject({ code: "SESSION_EXPIRED", causeCode: "CONNECTION_CLOSED" });
    await expect(service.upload({ sessionId, bucket: "cloud_upload", paths: ["file.txt"], remotePath: "/target" })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });
  it("detects a native process that exited between requests, including queue-only requests", async () => {
    const { service, native } = await fixture(), { sessionId } = await service.connect(credentials); native.closed = true;
    await expect(service.jobs({ sessionId })).rejects.toMatchObject({ code: "SESSION_EXPIRED", causeCode: "CONNECTION_CLOSED" });
  });
  it("does not report a successful listing if a wrapper swallowed a fatal child error", async () => {
    const { service, native } = await fixture(), { sessionId } = await service.connect(credentials);
    vi.spyOn(native, "list").mockImplementation(async () => { native.closed = true; return []; });
    await expect(service.remote({ sessionId, path: "/target" })).rejects.toMatchObject({ code: "SESSION_EXPIRED", causeCode: "CONNECTION_CLOSED" });
    await expect(service.jobs({ sessionId })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });
  it("preserves the first fatal timeout cause for later polling while keeping nonfatal timeouts usable", async () => {
    let now = 0; const { service, native } = await fixture({ now: () => now }), { sessionId } = await service.connect(credentials);
    native.beforeStat = async () => { throw Object.assign(new Error(credentials.password), { code: "TIMEOUT" }); };
    await expect(service.remote({ sessionId, path: "/target" })).rejects.toMatchObject({ code: "TIMEOUT", status: 504 });
    expect((await service.remote({ sessionId, path: "/target" })).path).toBe("/target");
    native.beforeStat = async () => { native.closed = true; throw Object.assign(new Error(credentials.password), { code: "TIMEOUT" }); };
    await expect(service.remote({ sessionId, path: "/target" })).rejects.toMatchObject({ code: "SESSION_EXPIRED", causeCode: "TIMEOUT", status: 504, message: "读取云端目录超时，文件传输连接已关闭，请重新连接。" });
    now = 36_500 * 24 * 60 * 60 * 1000;
    await expect(service.jobs({ sessionId })).rejects.toMatchObject({ code: "SESSION_EXPIRED", causeCode: "TIMEOUT", message: "读取云端目录超时，文件传输连接已关闭，请重新连接。" });
  });
  it("expires a session when its worker loses the native connection during upload", async () => {
    const { service, native, localRoot } = await fixture(), { sessionId } = await service.connect(credentials); await writeFile(path.join(localRoot, "cloud_upload", "lost.txt"), "fixture");
    vi.spyOn(native, "upload").mockImplementation(async () => { native.closed = true; throw Object.assign(new Error(credentials.password), { code: "CONNECTION_FAILED" }); });
    await service.upload({ sessionId, bucket: "cloud_upload", paths: ["lost.txt"], remotePath: "/target" });
    await vi.waitFor(async () => { await expect(service.jobs({ sessionId })).rejects.toMatchObject({ code: "SESSION_EXPIRED", causeCode: "CONNECTION_FAILED" }); });
  });
  it("requires the native engine and passes first/changed host fingerprints through safely", async () => {
    const { localRoot } = await fixture();
    const service = new CloudFileTransferService({ localRoot, connect: async () => { throw Object.assign(new Error(credentials.password), { code: "ENGINE_UNAVAILABLE" }); }, engineStatus: async () => ({ available: false, engine: "FileZilla", version: "" }) }); cleanup.push(() => service.close());
    await expect(service.connect(credentials)).rejects.toMatchObject({ status: 503, code: "ENGINE_UNAVAILABLE" }); expect((await service.status()).available).toBe(false);
    for (const code of ["HOST_KEY_REQUIRED", "HOST_KEY_MISMATCH"]) {
      const challenge = new CloudFileTransferService({ localRoot, connect: async () => { throw Object.assign(new Error(credentials.password), { code, hostKey: "key", fingerprint: "SHA256:public" }); } }); cleanup.push(() => challenge.close());
      await expect(challenge.connect(credentials)).rejects.toMatchObject({ status: 409, code, hostKey: "key", fingerprint: "SHA256:public" });
    }
  });
  it("never accepts an unconfirmed or changed fingerprint even if a transport returns success", async () => {
    for (const hostKey of [undefined, "different-trusted-key"]) {
      const { service, native } = await fixture();
      await expect(service.connect({ ...credentials, hostKey })).rejects.toMatchObject({ status: 409, code: hostKey ? "HOST_KEY_MISMATCH" : "HOST_KEY_REQUIRED", hostKey: "fixture-host-key", fingerprint: "SHA256:fixture-fingerprint" });
      expect(native.closed).toBe(true);
    }
  });
  it("keeps local APIs same-origin/loopback, rejects unknown fields and old launch endpoints, and redacts secrets", async () => {
    const { service, connect } = await fixture(), request = await api(service), logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    expect((await request("/status")).status).toBe(200); expect((await request("/status", undefined, { origin: "https://foreign.example" })).status).toBe(403);
    expect((await request("/status", undefined, { host: "canvas.example", origin: "https://canvas.example" })).status).toBe(403); expect((await request("/status?path=anything")).status).toBe(405);
    expect((await request("/connect", { ...credentials, executable: "cmd.exe" })).status).toBe(400); expect((await request("/launch", credentials)).status).toBe(404); expect((await request("/open", {})).status).toBe(404); expect(connect).not.toHaveBeenCalled();
    expect((await request("/connect", credentials, { "content-type": "text/plain" })).status).toBe(415); expect((await request("/connect", { ...credentials, privateKey: "a".repeat(1600 * 1024) })).status).toBe(413);
    const connected = await request("/connect", credentials); expect(connected.status).toBe(200); const sessionId = connected.body.sessionId;
    const result = await request("/jobs", { sessionId }); expect(JSON.stringify(result)).not.toContain(credentials.password); expect(JSON.stringify(await request("/disconnect", { sessionId }))).not.toContain(credentials.password);
    connect.mockRejectedValueOnce(new Error("native command failed with " + credentials.password)); const failure = await request("/connect", credentials); expect(failure.status).toBe(502); expect(JSON.stringify(failure)).not.toContain(credentials.password);
    expect(logs.flatMap(item => item.mock.calls).flat().join(" ")).not.toContain(credentials.password); expect(trustedTransferRequest({ headers: { host: "localhost:1420" }, socket: { remoteAddress: "192.0.2.1" } } as http.IncomingMessage)).toBe(false);
    expect(() => remoteTransferPath("/remote\npath")).toThrow(); expect(() => remoteTransferPath("relative")).toThrow();
  });
  it("returns SESSION_EXPIRED with the original fatal timeout cause through HTTP", async () => {
    const { service, native } = await fixture(), request = await api(service), connected = await request("/connect", credentials), sessionId = connected.body.sessionId;
    native.beforeStat = async () => { native.closed = true; throw Object.assign(new Error(credentials.password), { code: "TIMEOUT" }); };
    const failure = await request("/remote", { sessionId, path: "/target" });
    expect(failure).toMatchObject({ status: 504, body: { code: "SESSION_EXPIRED", causeCode: "TIMEOUT", error: "读取云端目录超时，文件传输连接已关闭，请重新连接。" } });
    expect(await request("/jobs", { sessionId })).toEqual(failure); expect(JSON.stringify(failure)).not.toContain(credentials.password);
  });
  it("aborts the native connection attempt when its HTTP client cancels or closes the panel", async () => {
    const { localRoot } = await fixture(); let signal: AbortSignal | undefined;
    const service = new CloudFileTransferService({ localRoot, connect: async (_config, options) => {
      signal = options?.signal; return await new Promise<NativeFixture>((_, reject) => signal?.addEventListener("abort", () => reject(new Error(credentials.password)), { once: true }));
    } }); cleanup.push(() => service.close()); const endpoint = await api(service);
    const request = http.request({ hostname: "127.0.0.1", port: endpoint.port, path: "/__canvas/cloud-files/connect", method: "POST", headers: { "content-type": "application/json" } });
    request.on("error", () => undefined); request.end(JSON.stringify(credentials));
    await vi.waitFor(() => expect(signal).toBeDefined()); request.destroy(); await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });
});
