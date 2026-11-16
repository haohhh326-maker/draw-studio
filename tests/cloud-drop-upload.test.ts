import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CloudFileTransferService, type NativeTransferConnection } from "../scripts/cloud-file-transfer";
import { cloudFileTransferHandler, cloudFileTransferPlugin } from "../scripts/cloud-file-transfer-plugin";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-drop-test-")), canonicalRoot = await realpath(root);
  cleanup.push(async () => { if (path.dirname(canonicalRoot) !== await realpath(os.tmpdir()) || !path.basename(canonicalRoot).startsWith("canvas-drop-test-")) throw new Error("Invalid test cleanup path"); await rm(canonicalRoot, { recursive: true, force: true }); });
  const files = new Map<string, Buffer>(), uploads: string[] = [];
  const connection: NativeTransferConnection = {
    hostKey: "drop-fixture", fingerprint: "SHA256:drop-fixture", home: "/target", list: async () => [],
    stat: async target => ({ directory: target === "/target", size: files.get(target)?.length || 0 }), mkdir: async () => undefined,
    upload: async (local, remote, options) => { uploads.push(local); if (files.has(remote)) throw Object.assign(new Error("secret native output"), { code: "FILE_EXISTS" }); const data = await readFile(local); options.onProgress?.(data.length); files.set(remote, data); }, close: async () => undefined,
  };
  const service = new CloudFileTransferService({ localRoot: path.join(root, "local"), connect: async () => connection }); cleanup.push(() => service.close());
  const { sessionId } = await service.connect({ host: "cloud.example.test", username: "root", password: "not-persisted", hostKey: "drop-fixture" });
  return { root, service, sessionId, files, uploads, connection };
}
async function finished(service: CloudFileTransferService, sessionId: string) {
  await vi.waitFor(async () => { expect((await service.jobs({ sessionId })).jobs.every(job => ["completed", "failed", "cancelled"].includes(job.status))).toBe(true); });
  return (await service.jobs({ sessionId })).jobs;
}
async function endpoint(service: CloudFileTransferService) {
  const handler = cloudFileTransferHandler({ service }), server = http.createServer((request, response) => { void handler(request, response, () => { response.writeHead(404); response.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return (server.address() as AddressInfo).port;
}
function rawUpload(port: number, metadata: unknown, chunks: Buffer[], extra: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/__canvas/cloud-files/drop-upload", method: "POST", headers: { "content-type": "application/octet-stream", "x-canvas-drop-file": encodeURIComponent(JSON.stringify(metadata)), ...extra } }, response => {
      const data: Buffer[] = []; response.on("data", chunk => data.push(chunk)); response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(data).toString()) }));
    }); request.on("error", reject); for (const chunk of chunks) request.write(chunk); request.end();
  });
}

describe("browser file drops use the existing cloud transfer queue", () => {
  it("streams a file larger than JSON requests, preserves its Unicode filename and cleans its temporary copy", async () => {
    const { service, sessionId, files, uploads } = await fixture(), port = await endpoint(service);
    const first = Buffer.alloc(1024 * 1024, 17), second = Buffer.alloc(1024 * 1024, 219), last = Buffer.from("last bytes");
    const result = await rawUpload(port, { sessionId, remotePath: "/target", name: "模型 甲.safetensors", size: first.length + second.length + last.length }, [first, second, last]);
    expect(result.status).toBe(200);
    expect(await finished(service, sessionId)).toMatchObject([{ id: result.body.jobId, status: "completed", files: 1, totalFiles: 1, bytes: first.length + second.length + last.length }]);
    expect(files.get("/target/模型 甲.safetensors")?.equals(Buffer.concat([first, second, last]))).toBe(true);
    expect(JSON.stringify(await service.jobs({ sessionId }))).not.toContain("canvas-cloud-drop-");
    await vi.waitFor(async () => { await expect(access(uploads[0])).rejects.toMatchObject({ code: "ENOENT" }); });
  });
  it("exposes receive progress while streaming and lets the user cancel it without any deadline", async () => {
    const { service, sessionId, files } = await fixture(), source = new PassThrough();
    const pending = service.droppedUpload({ sessionId, remotePath: "/target", name: "slow.bin", size: 2 * 1024 * 1024 }, source).catch(reason => reason);
    source.write(Buffer.alloc(1024 * 1024));
    let jobId = "";
    await vi.waitFor(async () => { const [job] = (await service.jobs({ sessionId })).jobs; expect(job).toMatchObject({ status: "receiving", bytes: 1024 * 1024 }); expect(job).not.toHaveProperty("bytesPerSecond"); jobId = job.id; });
    await expect(service.disconnect({ sessionId })).rejects.toMatchObject({ code: "UPLOAD_ACTIVE" });
    await service.cancel({ sessionId, jobId }); expect(await pending).toMatchObject({ code: "CANCELLED" });
    expect(source.destroyed).toBe(true); expect((await service.jobs({ sessionId })).jobs[0].status).toBe("cancelled"); expect(files.size).toBe(0);
  });
  it("rejects incomplete and oversized streams and never queues a partial file", async () => {
    const { service, sessionId, files } = await fixture(), port = await endpoint(service);
    for (const size of [1, 3]) {
      await expect(service.droppedUpload({ sessionId, remotePath: "/target", name: "partial.bin", size }, (async function* () { yield Buffer.from("ab"); })())).rejects.toMatchObject({ code: "FILE_SIZE_MISMATCH" });
    }
    expect(files.size).toBe(0); expect((await service.jobs({ sessionId })).jobs.every(job => job.status === "failed")).toBe(true);
    expect(await rawUpload(port, { sessionId, remotePath: "/target", name: "oversize.bin", size: 1 }, [Buffer.from("ab")])).toMatchObject({ status: 400, body: { code: "FILE_SIZE_MISMATCH" } });
  });
  it("uploads empty files and preserves existing remote files", async () => {
    const { service, sessionId, files } = await fixture();
    await service.droppedUpload({ sessionId, remotePath: "/target", name: "empty.txt", size: 0 }, (async function* () {})());
    expect((await finished(service, sessionId))[0].status).toBe("completed"); expect(files.get("/target/empty.txt")).toEqual(Buffer.alloc(0));
    await service.droppedUpload({ sessionId, remotePath: "/target", name: "empty.txt", size: 1 }, (async function* () { yield Buffer.from("x"); })());
    expect((await finished(service, sessionId))[1]).toMatchObject({ status: "failed", error: "云端已存在同名文件，未覆盖原文件。" }); expect(files.get("/target/empty.txt")?.length).toBe(0);
  });
  it("removes queued temporary files when cancelled or when the local service closes", async () => {
    const { service, sessionId, connection } = await fixture(), before = new Set(await readdir(os.tmpdir()));
    connection.upload = async (_local, _remote, options) => { await new Promise<void>((_resolve, reject) => { options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }); if (options.signal?.aborted) reject(options.signal.reason); }); };
    const stream = () => (async function* () { yield Buffer.from("x"); })();
    await service.droppedUpload({ sessionId, remotePath: "/target", name: "active.bin", size: 1 }, stream());
    const second = await service.droppedUpload({ sessionId, remotePath: "/target", name: "queued.bin", size: 1 }, stream());
    expect((await service.jobs({ sessionId })).jobs[1].status).toBe("queued");
    await service.cancel({ sessionId, jobId: second.jobId });
    const third = await service.droppedUpload({ sessionId, remotePath: "/target", name: "queued-two.bin", size: 1 }, stream());
    expect((await service.jobs({ sessionId })).jobs.find(job => job.id === third.jobId)?.status).toBe("queued");
    await service.close();
    await vi.waitFor(async () => { expect((await readdir(os.tmpdir())).filter(name => !before.has(name) && name.startsWith("canvas-cloud-drop-"))).toEqual([]); });
  });
  it("rejects path traversal, invalid sizes and destinations before reading the browser stream", async () => {
    const { service, sessionId } = await fixture(), read = vi.fn();
    const source = (async function* () { read(); yield Buffer.from("x"); });
    for (const value of [{ name: "../escape.bin", size: 1 }, { name: "x", size: -1 }, { name: "x", size: 1.5 }, { name: "x", size: 1, remotePath: "/not-directory" }]) {
      await expect(service.droppedUpload({ sessionId, remotePath: "/target", ...value }, source())).rejects.toBeInstanceOf(Error);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("requires the same localhost origin and strict metadata/content type as the other transfer routes", async () => {
    const { service, sessionId, files } = await fixture(), port = await endpoint(service), meta = { sessionId, remotePath: "/target", name: "safe.bin", size: 1 };
    expect((await rawUpload(port, meta, [Buffer.from("x")], { origin: "https://foreign.example" })).status).toBe(403);
    expect((await rawUpload(port, { ...meta, localPath: "C:/secrets" }, [Buffer.from("x")])).status).toBe(400);
    expect((await rawUpload(port, meta, [Buffer.from("x")], { "content-type": "application/json" })).status).toBe(415);
    expect(files.size).toBe(0);
  });
  it("removes Node's default incoming-file deadline in development and preview servers", async () => {
    const { service } = await fixture(), plugin = cloudFileTransferPlugin(undefined, { service });
    for (const hook of [plugin.configureServer, plugin.configurePreviewServer]) {
      const server = { httpServer: { requestTimeout: 300_000, once: vi.fn() }, middlewares: { use: vi.fn() } };
      if (typeof hook !== "function") throw new Error("Missing server hook");
      await hook.call({} as never, server as never); expect(server.httpServer.requestTimeout).toBe(0);
    }
  });
});
