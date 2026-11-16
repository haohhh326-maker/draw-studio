import { afterEach, describe, expect, it, vi } from "vitest";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCanvasServer, type CloudCanvasOptions } from "../scripts/cloud-server";
import { runningHubNativeProxyPlugin, type NativeProxySocket } from "../scripts/runninghub-native-proxy-plugin";
import viteConfig from "../vite.config";

const servers: http.Server[] = [], roots: string[] = [], clients: NativeProxySocket[] = [];
const WebSocket = createRequire(import.meta.url)("ws") as new (url: string, options: { origin: string; headers?: Record<string, string> }) => NativeProxySocket;
const endpoint = "https://www.runninghub.cn/proxy-plus", key = "private-native-key";
const headers = { authorization: "Bearer " + key, "x-runninghub-native-endpoint": endpoint, "content-type": "application/json" };
const publicOrigin = "https://canvas.example.test:8443";
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith("canvas-native-server-test-")) throw new Error("Refusing cleanup outside the fixture");
    await rm(root, { recursive: true, force: true });
  }
});
class UpstreamSocket extends EventEmitter implements NativeProxySocket {
  readyState = 0;
  bufferedAmount = 0;
  pause() {}
  resume() {}
  send(_data: string | Buffer | ArrayBuffer | Buffer[], _options: { binary: boolean }, callback: (error?: Error) => void) { queueMicrotask(callback); }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  open() { this.readyState = 1; this.emit("open"); }
}
function transports() {
  const calls: { target: URL; method: string | undefined; body: string }[] = [], targets: URL[] = [], sockets: UpstreamSocket[] = [];
  const transport = vi.fn((target: URL, options: https.RequestOptions, listener: (incoming: IncomingMessage) => void) => {
    const chunks: Buffer[] = [];
    return new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); }, final(callback) {
      calls.push({ target, method: options.method, body: Buffer.concat(chunks).toString() });
      queueMicrotask(() => { const incoming = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "application/json" } }); listener(incoming as unknown as IncomingMessage); incoming.end('{"native":true}'); }); callback();
    } });
  });
  const createWebSocket = vi.fn((target: URL) => { targets.push(target); const socket = new UpstreamSocket(); sockets.push(socket); queueMicrotask(() => socket.open()); return socket; });
  return { calls, targets, sockets, nativeRunningHub: { transport: transport as unknown as typeof https.request, createWebSocket } };
}
async function listen(server: http.Server) { servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return (server.address() as AddressInfo).port; }
async function fixture(options: Omit<CloudCanvasOptions, "rootDir" | "distDir" | "libraryDir" | "nativeRunningHub"> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-native-server-test-")); roots.push(root);
  const dist = path.join(root, "dist"), library = path.join(root, "library"); await mkdir(dist); await mkdir(library); await writeFile(path.join(dist, "index.html"), "<html>canvas static page</html>");
  const fake = transports(), port = await listen(createCanvasServer({ rootDir: root, distDir: dist, libraryDir: library, basePath: "/canvas/", ...options, nativeRunningHub: fake.nativeRunningHub }));
  return { ...fake, port };
}
function request(port: number, pathname: string, method = "GET", extra: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers: { ...headers, ...extra } }, response => {
      let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; }); response.once("end", () => resolve({ status: response.statusCode!, body }));
    }); outgoing.once("error", reject); outgoing.end(method === "POST" ? "{}" : undefined);
  });
}
async function connect(port: number, pathname: string, origin = "http://127.0.0.1:" + port, host?: string) {
  const client = new WebSocket("ws://127.0.0.1:" + port + pathname, { origin, ...(host ? { headers: { host } } : {}) }); clients.push(client); client.on("error", () => {}); await once(client, "open"); return client;
}
async function authenticate(client: NativeProxySocket) {
  const message = once(client, "message"); client.send(JSON.stringify({ type: "authenticate", endpoint, token: key }), { binary: false }, () => {});
  expect(JSON.parse((await message)[0].toString())).toEqual({ type: "rh_native_ready" });
}

describe("native proxy cloud-server integration", () => {
  it.each(["/", "/canvas/", "/nested/canvas/"])("routes native HTTP and WS under base %s using only injected transports", async basePath => {
    const context = await fixture({ basePath }), local = basePath + "api/runninghub-comfy";
    expect(await request(context.port, local + "/system_stats")).toEqual({ status: 200, body: '{"native":true}' });
    expect(await request(context.port, local + "/prompt", "POST")).toEqual({ status: 200, body: '{"native":true}' });
    expect(context.calls.map(call => call.target.href)).toEqual([endpoint + "/" + key + "/system_stats", endpoint + "/" + key + "/prompt"]);
    const client = await connect(context.port, local + "/ws?clientId=cloud-client"); expect(context.targets).toEqual([]); await authenticate(client);
    expect(context.targets[0].href).toBe("wss://www.runninghub.cn/proxy-plus/" + key + "/ws?clientId=cloud-client");
    expect((await request(context.port, basePath)).body).toContain("canvas static page");
    if (basePath !== "/") expect((await request(context.port, "/api/runninghub-comfy/system_stats")).status).toBe(404);
  });
  it("routes the native account check with the verified lowercase apikey body", async () => {
    const context = await fixture(); expect((await request(context.port, "/canvas/api/runninghub-comfy/account", "POST")).status).toBe(200);
    expect(context.calls[0].target.href).toBe("https://www.runninghub.cn/uc/openapi/accountStatus"); expect(JSON.parse(context.calls[0].body)).toEqual({ apikey: key });
  });
  it("uses configured public origins for HTTP and native WS without conflicting with local Comfy upgrades", async () => {
    const context = await fixture({ allowedOrigins: [publicOrigin] }), local = "/canvas/api/runninghub-comfy";
    expect((await request(context.port, local + "/system_stats", "GET", { host: "canvas.example.test", origin: publicOrigin })).status).toBe(200);
    const client = await connect(context.port, local + "/ws?clientId=public-client", publicOrigin, "canvas.example.test"); await authenticate(client);
    expect(context.targets).toHaveLength(1);
    expect((await request(context.port, local + "/system_stats", "GET", { host: "canvas.example.test", origin: "https://foreign.example" })).status).toBe(403);
    await expect(connect(context.port, local + "/ws?clientId=foreign-client", "https://foreign.example", "canvas.example.test")).rejects.toThrow(/403/);
    expect(context.calls).toHaveLength(1); expect(context.targets).toHaveLength(1);
  });
  it("resolves opt-in AutoDL origins per request for both native HTTP and WS", async () => {
    const context = await fixture({ autodlOrigins: true }), host = "u2048-012345abcdef.westd.seetacloud.com", origin = "https://" + host + ":8443", local = "/canvas/api/runninghub-comfy";
    expect((await request(context.port, local + "/system_stats", "GET", { host, origin })).status).toBe(200);
    const client = await connect(context.port, local + "/ws?clientId=autodl-client", origin, host); await authenticate(client);
    expect(context.targets).toHaveLength(1);
    const foreign = "https://u4096-fedcba987654.westd.seetacloud.com:8443";
    expect((await request(context.port, local + "/system_stats", "GET", { host, origin: foreign })).status).toBe(403);
    await expect(connect(context.port, local + "/ws?clientId=foreign-client", foreign, host)).rejects.toThrow(/403/);
    expect(context.calls).toHaveLength(1); expect(context.targets).toHaveLength(1);
  });
  it("does not let native invalid routes fall through to the canvas or Comfy upgrade handler", async () => {
    const context = await fixture(), local = "/canvas/api/runninghub-comfy";
    for (const tail of ["/../private", "/object_info/%2e%2e", "/prompt?apiKey=secret", "/other"])
      expect((await request(context.port, local + tail)).status).toBeGreaterThanOrEqual(400);
    await expect(connect(context.port, local + "/prompt?clientId=wrong-route")).rejects.toThrow(/400/);
    await expect(connect(context.port, local + "/ws?clientId=client&token=secret")).rejects.toThrow(/400/);
    expect(context.calls).toEqual([]); expect(context.targets).toEqual([]);
  });
});

describe("native Vite registrations", () => {
  it("registers the native proxy in the application config", () => {
    const plugins = (viteConfig as { plugins: unknown[] }).plugins.flat(Infinity) as { name?: string }[];
    expect(plugins.filter(plugin => plugin.name === "canvas-runninghub-native-proxy")).toHaveLength(1);
  });
  it.each(["configureServer", "configurePreviewServer"] as const)("serves HTTP and WS from the resolved Vite base in %s", async hookName => {
    const fake = transports(), plugin = runningHubNativeProxyPlugin(fake.nativeRunningHub);
    let middleware!: (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
    const server = http.createServer((request, response) => middleware(request, response, () => { response.statusCode = 404; response.end(); }));
    const hook = plugin[hookName] as (server: unknown) => void;
    hook({ config: { base: "/preview/" }, httpServer: server, middlewares: { use(handle: typeof middleware) { middleware = handle; } } });
    const port = await listen(server);
    expect((await request(port, "/preview/api/runninghub-comfy/system_stats")).status).toBe(200);
    expect((await request(port, "/api/runninghub-comfy/system_stats")).status).toBe(404);
    const client = await connect(port, "/preview/api/runninghub-comfy/ws?clientId=vite-client"); await authenticate(client);
    expect(fake.calls).toHaveLength(1); expect(fake.targets).toHaveLength(1);
  });
});
