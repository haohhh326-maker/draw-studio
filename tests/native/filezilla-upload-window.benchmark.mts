/**
 * Opt-in throughput experiment. The SSH server and all payloads stay on localhost.
 * Run from the project root with Node 24:
 *   E:\\node.exe tests/native/filezilla-upload-window.benchmark.mts
 * CANVAS_BENCH_BINARY selects another compiled bridge without changing production.
 * CANVAS_BENCH_MIB / CANVAS_BENCH_ACK_MS / CANVAS_BENCH_RUNS default to 8 / 60 / 3.
 * ACK delay is simulated network latency in this fixture, never a product timeout.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { openNativeTransport } from "../../scripts/filezilla-native-transport.ts";

const require = createRequire(import.meta.url);
const { Server, utils } = require(path.join(process.cwd(), ".cache/native-transfer-testdeps/node_modules/ssh2"));
const mib = Number(process.env.CANVAS_BENCH_MIB || 8);
const ackMs = Number(process.env.CANVAS_BENCH_ACK_MS || 60);
const runs = Number(process.env.CANVAS_BENCH_RUNS || 3);
assert(Number.isInteger(mib) && mib > 0 && mib <= 64);
assert(Number.isFinite(ackMs) && ackMs >= 0 && ackMs <= 1000);
assert(Number.isInteger(runs) && runs > 0 && runs <= 10);
const byteLength = mib * 1024 * 1024;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
const hostKey = createHash("sha256").update(utils.parseKey(privateKey).getPublicSSH()).digest("hex");
const password = randomBytes(20).toString("hex");
const username = "localhost-throughput-fixture";
const status = utils.sftp.STATUS_CODE;
const clients = new Set<any>();
type UploadState = { bytes: Buffer; written: number; pending: number; maxPending: number; writes: number; minChunk: number; maxChunk: number };
const uploads = new Map<string, UploadState>();
const attrs = (directory: boolean, size = 0) => ({ mode: directory ? 0o040755 : 0o100644, size,
  uid: 1000, gid: 1000, atime: 1_700_000_000, mtime: 1_700_000_000 });
const normalize = (value: string) => value === "." ? "/fixture" : path.posix.resolve("/fixture", value);
const server = new Server({ hostKeys: [privateKey] }, (client: any) => {
  clients.add(client); client.on("close", () => clients.delete(client)); client.on("error", () => undefined);
  client.on("authentication", (ctx: any) => {
    if (ctx.method === "password" && ctx.username === username && ctx.password === password) ctx.accept();
    else ctx.reject(["password"]);
  });
  client.on("ready", () => client.on("session", (accept: any) => {
    const session = accept();
    session.on("sftp", (acceptSftp: any) => {
      const sftp = acceptSftp();
      const handles = new Map<string, string>(); let nextHandle = 0;
      const sendStatus = (id: number, code: number) => { if (!sftp.destroyed) sftp.status(id, code); };
      const sendAttrs = (id: number, value: string) => {
        const location = normalize(value), upload = uploads.get(location);
        if (["/", "/fixture", "/target"].includes(location)) sftp.attrs(id, attrs(true));
        else if (upload) sftp.attrs(id, attrs(false, upload.written));
        else sendStatus(id, status.NO_SUCH_FILE);
      };
      sftp.on("REALPATH", (id: number, value: string) => {
        const location = normalize(value); sftp.name(id, [{ filename: location, longname: location, attrs: attrs(true) }]);
      });
      sftp.on("STAT", sendAttrs); sftp.on("LSTAT", sendAttrs);
      sftp.on("FSTAT", (id: number, raw: Buffer) => {
        const location = handles.get(raw.toString("hex"));
        if (location) sendAttrs(id, location); else sendStatus(id, status.FAILURE);
      });
      sftp.on("OPEN", (id: number, value: string, flags: number) => {
        const location = normalize(value);
        if (path.posix.dirname(location) !== "/target") { sendStatus(id, status.NO_SUCH_FILE); return; }
        if ((flags & 32) && uploads.has(location)) { sendStatus(id, status.FAILURE); return; }
        // Allocate once. No growing buffers or O(n²) copies distort this benchmark.
        uploads.set(location, { bytes: Buffer.alloc(byteLength), written: 0, pending: 0,
          maxPending: 0, writes: 0, minChunk: Infinity, maxChunk: 0 });
        const raw = Buffer.from(String(++nextHandle)); handles.set(raw.toString("hex"), location); sftp.handle(id, raw);
      });
      sftp.on("WRITE", (id: number, raw: Buffer, offset: number, data: Buffer) => {
        const location = handles.get(raw.toString("hex")), upload = location && uploads.get(location);
        if (!upload || !Number.isSafeInteger(offset) || offset < 0 || offset + data.length > byteLength) {
          sendStatus(id, status.FAILURE); return;
        }
        data.copy(upload.bytes, offset); upload.written = Math.max(upload.written, offset + data.length);
        upload.writes++; upload.pending++; upload.maxPending = Math.max(upload.maxPending, upload.pending);
        upload.minChunk = Math.min(upload.minChunk, data.length); upload.maxChunk = Math.max(upload.maxChunk, data.length);
        setTimeout(() => { upload.pending--; sendStatus(id, status.OK); }, ackMs);
      });
      sftp.on("CLOSE", (id: number, raw: Buffer) => { handles.delete(raw.toString("hex")); sendStatus(id, status.OK); });
      sftp.on("REMOVE", (id: number, value: string) => {
        if (uploads.delete(normalize(value))) sendStatus(id, status.OK); else sendStatus(id, status.NO_SUCH_FILE);
      });
      for (const operation of ["SETSTAT", "FSETSTAT"]) sftp.on(operation, (id: number) => sendStatus(id, status.OK));
      sftp.on("error", () => undefined);
    });
  }));
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address(); assert(address && typeof address !== "string");
const nativePath = (value: string) => process.platform !== "win32" ? value
  : `/mnt/${value[0].toLowerCase()}/${value.slice(3).replaceAll("\\", "/")}`;
const binary = await realpath(process.env.CANVAS_BENCH_BINARY || ".cache/native-cloud-transfer/build/cloud-transfer-bridge");
const binaryHash = createHash("sha256").update(await (await import("node:fs/promises")).readFile(binary)).digest("hex");
const transport = await openNativeTransport("127.0.0.1", address.port);
const child = process.platform === "win32"
  ? spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32/wsl.exe"),
    ["--distribution", process.env.CANVAS_TRANSFER_WSL_DISTRO || "Ubuntu-22.04", "--exec", nativePath(binary)],
    { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  : spawn(binary, [], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let nextRequest = 0, responseBuffer = "";
child.stderr.resume(); child.stdout.setEncoding("utf8");
const failPending = (error: Error) => { for (const item of pending.values()) item.reject(error); pending.clear(); };
child.on("error", failPending); child.on("close", code => failPending(new Error(`bridge exited: ${code}`)));
child.stdout.on("data", (chunk: string) => {
  responseBuffer += chunk;
  for (;;) {
    const end = responseBuffer.indexOf("\n"); if (end < 0) return;
    const line = responseBuffer.slice(0, end); responseBuffer = responseBuffer.slice(end + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.event === "progress") continue;
    if (message.event === "disconnected") { failPending(new Error("native disconnected")); continue; }
    const waiting = pending.get(message.id); if (!waiting) continue; pending.delete(message.id);
    if (message.ok) waiting.resolve(message.result); else waiting.reject(new Error(`native error: ${message.error?.code}`));
  }
});
const request = (type: string, body: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
  const id = String(++nextRequest); pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, type, ...body }) + "\n");
});
const localRoot = await realpath(await mkdtemp(path.join(process.cwd(), ".cache/native-window-benchmark-")));
const source = path.join(localRoot, "synthetic.bin");
const sourceBytes = randomBytes(byteLength);
const expectedHash = createHash("sha256").update(sourceBytes).digest("hex");
await writeFile(source, sourceBytes); const identity = await stat(source);
try {
  await request("connect", { host: transport.host, port: transport.port, username, password, hostKey });
  const results = [];
  for (let index = 0; index < runs; index++) {
    const remotePath = `/target/run-${index + 1}.bin`, started = performance.now();
    await request("upload", { localPath: nativePath(source), remotePath, allowedRoot: nativePath(localRoot),
      expectedIdentity: { size: identity.size, mtimeMs: identity.mtimeMs } });
    const elapsedMs = performance.now() - started;
    const received = uploads.get(remotePath)!;
    assert.equal(received.written, byteLength); assert.equal(received.pending, 0);
    const actualHash = createHash("sha256").update(received.bytes).digest("hex"); assert.equal(actualHash, expectedHash);
    const result = { run: index + 1, bytes: byteLength, ackDelayMs: ackMs, elapsedMs: Math.round(elapsedMs),
      mibPerSecond: Number((mib / (elapsedMs / 1000)).toFixed(3)),
      maxPendingWriteAcks: received.maxPending, writes: received.writes,
      minWriteBytes: received.minChunk, maxWriteBytes: received.maxChunk, sha256Verified: true };
    results.push(result); console.log(JSON.stringify(result)); uploads.delete(remotePath);
  }
  console.log(JSON.stringify({ binary, binarySha256: binaryHash, transport: process.platform === "win32"
    ? "Windows TCP + WSL native fzSSH" : "native fzSSH", bytes: byteLength, ackDelayMs: ackMs,
    medianMiBPerSecond: [...results].sort((a, b) => a.mibPerSecond - b.mibPerSecond)[Math.floor(results.length / 2)].mibPerSecond,
    results }, null, 2));
} finally {
  await request("close").catch(() => undefined); child.stdin.end(); child.kill(); transport.close();
  for (const client of clients) client.end();
  await new Promise<void>(resolve => server.close(() => resolve()));
  const cacheRoot = await realpath(path.join(process.cwd(), ".cache"));
  assert.equal(path.dirname(localRoot), cacheRoot); assert(path.basename(localRoot).startsWith("native-window-benchmark-"));
  await rm(localRoot, { recursive: true, force: true });
}
