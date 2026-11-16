import { afterEach, describe, expect, it, vi } from "vitest";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { attachRunningHubNativeWebSocket, runningHubNativeProxyHandler, runningHubNativeProxyPlugin, type NativeProxySocket, type RunningHubNativeProxyOptions } from "../scripts/runninghub-native-proxy-plugin";

const servers: http.Server[] = [], disposers: (() => void)[] = [], clients: NativeProxySocket[] = [];
const WebSocket = createRequire(import.meta.url)("ws") as new (url: string, options: { origin?: string; headers?: Record<string, string> }) => NativeProxySocket;
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  for (const dispose of disposers.splice(0)) dispose();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
const headers = { authorization: "Bearer private-native-key", "x-runninghub-native-endpoint": "https://www.runninghub.cn/proxy", "content-type": "application/json" };
const prefix = "/api/runninghub-comfy";
const auth = { type: "authenticate", endpoint: "https://www.runninghub.cn/proxy-plus", token: "private-native-key" };
type Call = { target: URL; options: https.RequestOptions; body: Buffer };
function fakeTransport(status = 200, content: string | Buffer = '{"ok":true}', responseHeaders: http.IncomingHttpHeaders = { "content-type": "application/json" }) {
  const calls: Call[] = [], requests: Writable[] = [];
  const transport = vi.fn((target: URL, options: https.RequestOptions, listener: (response: IncomingMessage) => void) => {
    const chunks: Buffer[] = [];
    const outgoing = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); }, final(callback) {
      calls.push({ target, options, body: Buffer.concat(chunks) });
      queueMicrotask(() => { const incoming = Object.assign(new PassThrough(), { statusCode: status, headers: responseHeaders }); listener(incoming as unknown as IncomingMessage); incoming.end(content); });
      callback();
    } });
    requests.push(outgoing); return outgoing;
  });
  return { calls, requests, spy: transport, transport: transport as unknown as typeof https.request };
}
async function fixture(options: RunningHubNativeProxyOptions = {}, sockets = false) {
  const handle = runningHubNativeProxyHandler(options);
  const server = http.createServer((request, response) => { void handle(request, response, () => { response.statusCode = 404; response.end("outside"); }); });
  servers.push(server);
  if (sockets) disposers.push(attachRunningHubNativeWebSocket(server, options));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
function request(port: number, path: string, method = "GET", requestHeaders: http.OutgoingHttpHeaders = headers, body: string | Buffer = "{}") {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const outgoing = http.request({ hostname: "127.0.0.1", port, path, method, headers: requestHeaders }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.once("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    }); outgoing.once("error", reject); outgoing.end(method === "GET" ? undefined : body);
  });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class UpstreamSocket extends EventEmitter implements NativeProxySocket {
  readyState = 0;
  bufferedAmount = 0;
  sent: { data: string | Buffer | ArrayBuffer | Buffer[]; binary: boolean }[] = [];
  pause = vi.fn();
  resume = vi.fn();
  holdWrites = false;
  callbacks: ((error?: Error) => void)[] = [];
  send(data: string | Buffer | ArrayBuffer | Buffer[], options: { binary: boolean }, callback: (error?: Error) => void) {
    this.sent.push({ data, binary: options.binary });
    if (this.holdWrites) this.callbacks.push(callback); else queueMicrotask(() => callback());
  }
  terminate = vi.fn(() => { if (this.readyState === 3) return; this.readyState = 3; this.emit("close", 1006, Buffer.from("private-native-key")); });
  open() { this.readyState = 1; this.emit("open"); }
}
async function socketFixture(extra: RunningHubNativeProxyOptions = {}) {
  const upstream = new UpstreamSocket(), created = deferred<URL>();
  const createWebSocket = vi.fn((url: URL) => { created.resolve(url); return upstream; });
  const port = await fixture({ createWebSocket, ...extra }, true);
  const connect = async (query = "?clientId=canvas-client-123", origin: string | undefined = "http://127.0.0.1:" + port) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}${extra.basePath?.replace(/\/$/, "") ?? ""}${prefix}/ws${query}`, { origin });
    clients.push(client); client.on("error", () => {}); await once(client, "open"); return client;
  };
  return { upstream, created, createWebSocket, port, connect };
}
function send(client: NativeProxySocket, value: unknown) { client.send(JSON.stringify(value), { binary: false }, () => {}); }
async function authenticate(context: Awaited<ReturnType<typeof socketFixture>>) {
  const client = await context.connect(), ready = once(client, "message");
  send(client, auth); await context.created.promise;
  context.upstream.open(); expect(JSON.parse((await ready)[0].toString())).toEqual({ type: "rh_native_ready" });
  return client;
}

describe("RunningHub native HTTP proxy", () => {
  it("queries the original numeric task outputs using a server-side key without a prompt submission", async () => {
    const fake = fakeTransport(200, '{"code":0,"data":[]}'), port = await fixture({ transport: fake.transport });
    expect((await request(port, prefix + "/task-outputs/2114862033085362177")).status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].target.href).toBe("https://www.runninghub.cn/task/openapi/outputs");
    expect(fake.calls[0].options.method).toBe("POST");
    expect(JSON.parse(fake.calls[0].body.toString())).toEqual({ apiKey: "private-native-key", taskId: "2114862033085362177" });
  });
  it.each([
    ["GET", "/system_stats"], ["GET", "/object_info"], ["GET", "/object_info/CLIP%20Loader"],
    ["GET", "/queue"], ["POST", "/queue"], ["GET", "/prompt"], ["POST", "/prompt"],
    ["GET", "/history?max_items=20&offset=0"], ["POST", "/history"], ["GET", "/history/prompt-123"],
    ["POST", "/upload/image"], ["POST", "/upload/mask"], ["POST", "/interrupt"], ["POST", "/free"], ["POST", "/api/jobs/prompt-123/cancel"],
  ])("preserves %s %s and body without forwarding browser secrets", async (method, path) => {
    const fake = fakeTransport(), port = await fixture({ transport: fake.transport });
    const response = await request(port, prefix + path, method, { ...headers, cookie: "private-cookie", referer: "https://private.example", "x-unknown": "private-header" }, '{"prompt":{"1":{"class_type":"SaveImage"}}}');
    expect(response.status).toBe(200); expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(fake.calls[0].target.href).toBe("https://www.runninghub.cn/proxy/private-native-key" + path);
    expect(fake.calls[0].options.method).toBe(method);
    expect(fake.calls[0].options.headers).not.toHaveProperty("authorization"); expect(fake.calls[0].options.headers).not.toHaveProperty("cookie"); expect(fake.calls[0].options.headers).not.toHaveProperty("referer");
    expect(fake.calls[0].body.toString()).toBe(method === "GET" ? "" : '{"prompt":{"1":{"class_type":"SaveImage"}}}');
    expect(fake.calls[0].options).not.toHaveProperty("timeout");
  });
  it("supports proxy-plus under a configured canvas path and leaves other services alone", async () => {
    const fake = fakeTransport(), port = await fixture({ transport: fake.transport, basePath: "/canvas/" });
    expect((await request(port, "/canvas" + prefix + "/system_stats", "GET", { ...headers, "x-runninghub-native-endpoint": "https://www.runninghub.cn/proxy-plus" })).status).toBe(200);
    expect(fake.calls[0].target.href).toBe("https://www.runninghub.cn/proxy-plus/private-native-key/system_stats");
    expect((await request(port, "/api/runninghub/task/openapi/create", "POST")).body).toBe("outside");
  });
  it("maps account to the official API body and keeps diagnostic account fields", async () => {
    const fake = fakeTransport(200, '{"code":0,"data":{"apiType":"NORMAL","remainCoins":"5"}}'), port = await fixture({ transport: fake.transport });
    const response = await request(port, prefix + "/account", "POST", headers, '{"apiKey":"injected-other-key"}');
    expect(fake.calls[0].target.href).toBe("https://www.runninghub.cn/uc/openapi/accountStatus");
    expect(JSON.parse(fake.calls[0].body.toString())).toEqual({ apikey: "private-native-key" });
    expect(JSON.parse(response.body)).toEqual({ code: 0, data: { apiType: "NORMAL", remainCoins: "5" } });
  });
  it.each(["http://www.runninghub.cn/proxy", "https://www.runninghub.ai/proxy", "https://www.runninghub.cn/proxy/private-native-key", "https://www.runninghub.cn/proxy/", "https://www.runninghub.cn/proxy?key=x", "https://www.runninghub.cn:443/proxy", "https://evil.example/proxy", "https://www.runninghub.cn.evil.example/proxy", "https://user:pass@www.runninghub.cn/proxy"])("rejects endpoint %s before any upstream call", async endpoint => {
    const fake = fakeTransport(), port = await fixture({ transport: fake.transport });
    expect((await request(port, prefix + "/prompt", "POST", { ...headers, "x-runninghub-native-endpoint": endpoint })).status).toBe(400); expect(fake.spy).not.toHaveBeenCalled();
  });
  it.each(["/prompt?apiKey=secret", "/history?max_items=5&max_items=6", "/object_info/../prompt", "/object_info/%2e%2e", "/object_info/%252e%252e", "/object_info/%2fqueue", "/object_info/x/queue", "/view?filename=../secret", "/view?filename=a.png&subfolder=../secret", "/view?filename=a.png&type=system", "/api/jobs/a/b/cancel", "/prompt#secret", "/prompt/", "/queue?url=https://evil.example", "/other"])("does not forward disallowed path %s", async path => {
    const fake = fakeTransport(), port = await fixture({ transport: fake.transport });
    expect((await request(port, prefix + path)).status).toBeGreaterThanOrEqual(400); expect(fake.spy).not.toHaveBeenCalled();
  });
  it("rejects foreign origins, methods and malformed authorization before opening a transport", async () => {
    const fake = fakeTransport(), port = await fixture({ transport: fake.transport });
    expect((await request(port, prefix + "/prompt", "POST", { ...headers, origin: "https://foreign.example" })).status).toBe(403);
    const response = await request(port, prefix + "/system_stats", "POST"); expect(response.status).toBe(405); expect(response.headers.allow).toBe("GET");
    for (const authorization of ["", "Basic private-native-key", "Bearer bad/key", "Bearer bad?key", "Bearer bad key"]) expect((await request(port, prefix + "/prompt", "POST", { ...headers, authorization })).status).toBe(401);
    expect(fake.spy).not.toHaveBeenCalled();
  });
  it("uses the existing exact trusted-origin rules and gateway resolver", async () => {
    const fake = fakeTransport(), origin = "https://canvas.example:8443", port = await fixture({ transport: fake.transport, requestOrigins: () => [origin] });
    expect((await request(port, prefix + "/prompt", "POST", { ...headers, host: "canvas.example", origin })).status).toBe(200);
    expect((await request(port, prefix + "/prompt", "POST", { ...headers, host: "canvas.example", origin: "https://canvas.example" })).status).toBe(403);
    expect(fake.calls).toHaveLength(1);
  });
  it.each([400, 401, 403, 422, 500])("preserves HTTP %i and node_errors while stripping credentials and URLs", async status => {
    const diagnostic = { error: { message: 'Node failed at https://www.runninghub.cn/proxy/private-native-key/prompt with "quoted" data' }, node_errors: { "12": { errors: [{ type: "value_not_in_list", details: "private-native-key is invalid" }], dependent_outputs: ["8"] } } };
    const fake = fakeTransport(status, JSON.stringify(diagnostic), { "content-type": "application/json", location: "https://www.runninghub.cn/proxy/private-native-key/prompt", "x-debug-url": "private-native-key" }), port = await fixture({ transport: fake.transport });
    const response = await request(port, prefix + "/prompt", "POST"), parsed = JSON.parse(response.body);
    expect(response.status).toBe(status); expect(parsed.node_errors["12"].errors[0].type).toBe("value_not_in_list"); expect(parsed.node_errors["12"].dependent_outputs).toEqual(["8"]);
    expect(response.body).not.toMatch(/private-native-key|https:|runninghub\.cn/); expect(JSON.stringify(response.headers)).not.toMatch(/private-native-key|runninghub\.cn/);
  });
  it("does not follow redirects or surface a text error URL", async () => {
    const fake = fakeTransport(302, "Redirect https://www.runninghub.cn/proxy/private-native-key/prompt", { location: "https://evil.example/private-native-key", "content-type": "text/plain" }), port = await fixture({ transport: fake.transport });
    const response = await request(port, prefix + "/system_stats"); expect(response.status).toBe(302); expect(response.headers.location).toBeUndefined(); expect(response.body).not.toMatch(/https|private-native-key/); expect(fake.calls).toHaveLength(1);
  });
  it("streams an official signed /view redirect without forwarding credentials and pins public DNS", async () => {
    const first = fakeTransport(302, "", { location: "https://rh-images.xiaoyaoyou.com/output/result.mp4?signature=temporary" });
    const second = fakeTransport(206, "video bytes", { "content-type": "video/mp4", "content-range": "bytes 0-10/100", "accept-ranges": "bytes" });
    const transport = vi.fn((...args: Parameters<typeof https.request>) => (args[0] as URL).hostname === "www.runninghub.cn" ? (first.transport as Function)(...args) : (second.transport as Function)(...args)) as unknown as typeof https.request;
    const port = await fixture({ transport, resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }] });
    const response = await request(port, prefix + "/view?filename=result.mp4", "GET", { ...headers, cookie: "private-cookie", range: "bytes=0-10" });
    expect(response.status).toBe(206); expect(response.body).toBe("video bytes"); expect(response.headers["content-range"]).toBe("bytes 0-10/100");
    expect(second.calls[0].options.headers).toEqual({ range: "bytes=0-10" });
    expect(second.calls[0].options.lookup).toBeTypeOf("function");
    expect(JSON.stringify(second.calls[0])).not.toMatch(/private-native-key|private-cookie|proxy\//);
  });
  it("follows the native signed same-site view hop before the CDN without exposing either token", async () => {
    const first = fakeTransport(302, "", { location: "/view?filename=result.mp4&type=output&Rh-Identify=fixture&token=signed-view-token" });
    const second = fakeTransport(302, "", { location: "https://rh-images.xiaoyaoyou.com/result.mp4?signature=temporary" });
    const third = fakeTransport(200, "video bytes", { "content-type": "video/mp4" });
    const steps = [first, second, third]; let i = 0;
    const transport = ((...args: Parameters<typeof https.request>) => (steps[i++].transport as Function)(...args)) as unknown as typeof https.request;
    const port = await fixture({ transport, resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }] });
    const response = await request(port, prefix + "/view?filename=result.mp4", "GET", { ...headers, cookie: "private-cookie" });
    expect(response.status).toBe(200); expect(response.body).toBe("video bytes"); expect(i).toBe(3);
    expect(second.calls[0].target.origin).toBe("https://www.runninghub.cn"); expect(second.calls[0].target.pathname).toBe("/view");
    expect(JSON.stringify(second.calls[0].options.headers)).not.toMatch(/private-cookie|private-native-key/);
    expect(JSON.stringify(third.calls[0])).not.toMatch(/private-cookie|private-native-key|signed-view-token/);
    expect(response.headers.location).toBeUndefined();
  });
  it("validates and follows a redirect between confirmed official CDNs", async () => {
    const steps = [
      fakeTransport(302, "", { location: "https://rh-images.xiaoyaoyou.com/result.mp4" }),
      fakeTransport(302, "", { location: "https://rh-images-tos.xiaoyaoyou.com/result.mp4?signature=next" }),
      fakeTransport(200, "video bytes", { "content-type": "video/mp4" }),
    ]; let i = 0;
    const transport = ((...args: Parameters<typeof https.request>) => (steps[i++].transport as Function)(...args)) as unknown as typeof https.request;
    const dns = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    const port = await fixture({ transport, resolveHostname: dns });
    const response = await request(port, prefix + "/view?filename=result.mp4");
    expect(response.status).toBe(200); expect(response.body).toBe("video bytes"); expect(dns).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(steps[2].calls[0])).not.toContain("private-native-key");
  });
  it.each(["https://evil.example/result.mp4", "http://rh-images-tos.xiaoyaoyou.com/result.mp4", "https://rh-images.xiaoyaoyou.com/result.mp4"])("rejects unsafe or looping secondary CDN redirects: %s", async location => {
    const steps = [fakeTransport(302, "", { location: "https://rh-images.xiaoyaoyou.com/result.mp4" }), fakeTransport(302, "", { location })]; let i = 0;
    const transport = ((...args: Parameters<typeof https.request>) => (steps[i++].transport as Function)(...args)) as unknown as typeof https.request;
    const port = await fixture({ transport, resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }] });
    expect((await request(port, prefix + "/view?filename=result.mp4")).status).toBe(502); expect(i).toBe(2);
  });
  it.each(["/view?filename=result.mp4&token=signed", "/view?filename=../secret", "/prompt?filename=result.mp4", "https://user:pass@www.runninghub.cn/view?filename=result.mp4"])("rejects signed-view loops or unsafe routes: %s", async location => {
    const fake = fakeTransport(302, "", { location }), port = await fixture({ transport: fake.transport });
    const response = await request(port, prefix + "/view?filename=result.mp4");
    expect(response.status).toBe(502); expect(fake.calls.length).toBeLessThanOrEqual(2);
    expect(response.headers.location).toBeUndefined();
  });
  it.each([
    "https://evil.example/result.mp4", "http://rh-images.xiaoyaoyou.com/result.mp4",
    "https://rh-images.xiaoyaoyou.com/result.mp4?key=private-native-key",
    "https://rh-images.xiaoyaoyou.com/result.mp4?key=private%252Dnative%252Dkey",
    "https://user:pass@rh-images.xiaoyaoyou.com/result.mp4",
  ])("rejects unsafe result redirect %s", async location => {
    const fake = fakeTransport(302, "", { location }), port = await fixture({ transport: fake.transport, resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }] });
    const response = await request(port, prefix + "/view?filename=result.mp4");
    expect(response.status).toBe(502); expect(fake.calls).toHaveLength(1); expect(response.headers.location).toBeUndefined();
  });
  it("rejects private CDN resolutions before following /view", async () => {
    const fake = fakeTransport(302, "", { location: "https://rh-images.xiaoyaoyou.com/result.mp4" }), port = await fixture({ transport: fake.transport, resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }] });
    expect((await request(port, prefix + "/view?filename=result.mp4")).status).toBe(502); expect(fake.calls).toHaveLength(1);
  });
  it("redacts a credential split across success response chunks and preserves JSON", async () => {
    const transport = ((_target: URL, _options: https.RequestOptions, listener: (response: IncomingMessage) => void) => new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) {
      queueMicrotask(() => { const incoming = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "application/json" } }); listener(incoming as unknown as IncomingMessage); for (const part of ['{"key":"pri', "vate-nat", 'ive-key","ok":true}']) incoming.write(part); incoming.end(); }); callback();
    } })) as unknown as typeof https.request;
    const port = await fixture({ transport }); expect(JSON.parse((await request(port, prefix + "/queue")).body)).toEqual({ key: "[redacted]", ok: true });
  });
  it("decodes compressed diagnostics before redaction", async () => {
    const fake = fakeTransport(400, gzipSync('{"node_errors":{"12":{"message":"private-native-key"}}}'), { "content-type": "application/json", "content-encoding": "gzip" }), port = await fixture({ transport: fake.transport });
    const response = await request(port, prefix + "/prompt", "POST"); expect(JSON.parse(response.body).node_errors["12"].message).toBe("[redacted]"); expect(response.headers["content-encoding"]).toBeUndefined();
  });
  it("streams multipart uploads before the browser finishes sending", async () => {
    const firstChunk = deferred<string>(), payload: Buffer[] = [];
    const transport = ((_target: URL, _options: https.RequestOptions, listener: (response: IncomingMessage) => void) => new Writable({ write(chunk, _encoding, callback) { payload.push(Buffer.from(chunk)); firstChunk.resolve(chunk.toString()); callback(); }, final(callback) {
      queueMicrotask(() => { const incoming = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "application/json" } }); listener(incoming as unknown as IncomingMessage); incoming.end('{"name":"image.png","type":"input"}'); }); callback();
    } })) as unknown as typeof https.request;
    const port = await fixture({ transport });
    const done = deferred<void>(), outgoing = http.request({ hostname: "127.0.0.1", port, path: prefix + "/upload/image", method: "POST", headers: { ...headers, "content-type": "multipart/form-data; boundary=test" } }, response => { response.resume(); response.once("end", () => done.resolve()); });
    outgoing.write("first-part"); expect(await firstChunk.promise).toBe("first-part"); outgoing.end("last-part"); await done.promise; expect(Buffer.concat(payload).toString()).toBe("first-partlast-part");
  });
  it("streams original file bytes with backpressure and preserves range metadata", async () => {
    let incoming!: PassThrough;
    const transport = ((_target: URL, _options: https.RequestOptions, listener: (response: IncomingMessage) => void) => new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) {
      queueMicrotask(() => { incoming = Object.assign(new PassThrough(), { statusCode: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-18/19", "accept-ranges": "bytes" } }); listener(incoming as unknown as IncomingMessage); incoming.write("private-native-key"); }); callback();
    } })) as unknown as typeof https.request;
    const port = await fixture({ transport });
    await new Promise<void>((resolve, reject) => {
      const outgoing = http.get({ hostname: "127.0.0.1", port, path: prefix + "/view?filename=video.mp4&type=output", headers }, response => {
        expect(response.statusCode).toBe(206); expect(response.headers["content-range"]).toBe("bytes 0-18/19"); let data = "";
        response.on("data", chunk => { data += chunk; if (data === "private-native-key") incoming.end("!"); }); response.once("end", () => { expect(data).toBe("private-native-key!"); resolve(); });
      }); outgoing.once("error", reject);
    });
  });
  it("destroys both upstream streams when the browser cancels a download", async () => {
    const stopped = deferred<void>(); let incoming!: PassThrough, upstream!: Writable;
    const transport = ((_target: URL, _options: https.RequestOptions, listener: (response: IncomingMessage) => void) => {
      upstream = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) {
        queueMicrotask(() => { incoming = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "image/png" } }); incoming.once("close", () => stopped.resolve()); listener(incoming as unknown as IncomingMessage); incoming.write("first"); }); callback();
      } }); return upstream;
    }) as unknown as typeof https.request;
    const port = await fixture({ transport });
    const outgoing = http.get({ hostname: "127.0.0.1", port, path: prefix + "/view?filename=image.png", headers }, response => response.once("data", () => outgoing.destroy())); outgoing.on("error", () => {});
    await stopped.promise; expect(incoming.destroyed).toBe(true); expect(upstream.destroyed).toBe(true);
  });
  it("hides synchronous and asynchronous upstream transport error details", async () => {
    for (const sync of [true, false]) {
      const transport = (() => { if (sync) throw new Error("private-native-key at https://private.example"); const outgoing = new PassThrough(); queueMicrotask(() => outgoing.destroy(new Error("private-native-key at https://private.example"))); return outgoing; }) as unknown as typeof https.request;
      const port = await fixture({ transport }); const response = await request(port, prefix + "/system_stats"); expect(response.status).toBe(502); expect(response.body).not.toMatch(/private-native-key|https|private\.example/);
    }
  });
});

describe("RunningHub native WebSocket proxy", () => {
  it("opens no upstream until the first authentication frame and announces readiness only after upstream open", async () => {
    const context = await socketFixture(), client = await context.connect();
    expect(context.createWebSocket).not.toHaveBeenCalled();
    const messages: string[] = []; client.on("message", value => messages.push(value.toString()));
    send(client, auth); const target = await context.created.promise;
    expect(target.href).toBe("wss://www.runninghub.cn/proxy-plus/private-native-key/ws?clientId=canvas-client-123"); expect(messages).toEqual([]);
    const ready = once(client, "message"); context.upstream.open(); expect(JSON.parse((await ready)[0].toString())).toEqual({ type: "rh_native_ready" });
  });
  it.each([
    { type: "authenticate", endpoint: "https://evil.example/proxy", token: "private-native-key" },
    { type: "authenticate", endpoint: "https://www.runninghub.cn/proxy/private-native-key", token: "private-native-key" },
    { type: "authenticate", endpoint: "https://www.runninghub.ai/proxy", token: "private-native-key" },
    { type: "authenticate", endpoint: "https://www.runninghub.cn/proxy", token: "bad/key" },
    { type: "prompt", endpoint: "https://www.runninghub.cn/proxy", token: "private-native-key" },
    { type: "authenticate", endpoint: "https://www.runninghub.cn/proxy", token: "private-native-key", url: "https://evil.example" },
  ])("rejects invalid first authentication frame without connecting", async value => {
    const context = await socketFixture(), client = await context.connect(), message = once(client, "message"), closed = once(client, "close");
    send(client, value); const text = (await message)[0].toString(); expect(JSON.parse(text).type).toBe("rh_native_error"); expect(text).not.toMatch(/private-native-key|https|evil\.example/); await closed; expect(context.createWebSocket).not.toHaveBeenCalled();
  });
  it.each(["?clientId=client&token=private-native-key", "?clientId=client&clientId=other", "?clientId=../secret", "", "?clientId=client&endpoint=https://evil.example"])("rejects unsafe browser upgrade query %s before upgrade", async query => {
    const context = await socketFixture(); await expect(context.connect(query)).rejects.toThrow(/400/); expect(context.createWebSocket).not.toHaveBeenCalled();
  });
  it("rejects foreign and missing Origin before upgrading", async () => {
    const context = await socketFixture(); await expect(context.connect("?clientId=client", "https://foreign.example")).rejects.toThrow(/403/);
    const client = new WebSocket(`ws://127.0.0.1:${context.port}${prefix}/ws?clientId=client`, {}); clients.push(client); client.on("error", () => {}); await expect(once(client, "open")).rejects.toThrow(/403/); expect(context.createWebSocket).not.toHaveBeenCalled();
  });
  it("forwards text and original preview bytes, masks diagnostic keys, and backpressures outbound writes", async () => {
    const context = await socketFixture(), client = await authenticate(context);
    const progress = once(client, "message"); context.upstream.emit("message", Buffer.from('{"type":"progress","data":{"value":1,"max":10}}'), false);
    expect(JSON.parse((await progress)[0].toString()).data.value).toBe(1); expect(context.upstream.pause).toHaveBeenCalled();
    const previewBytes = Buffer.from([0, 0, 0, 1, 0xff, 0xd8, 1, 2]), preview = once(client, "message"); context.upstream.emit("message", previewBytes, true);
    const [bytes, binary] = await preview; expect(bytes).toEqual(previewBytes); expect(binary).toBe(true);
    const diagnostic = once(client, "message"); context.upstream.emit("message", Buffer.from('{"type":"execution_error","data":{"message":"https://www.runninghub.cn/proxy/private-native-key/prompt failed"}}'), false);
    const text = (await diagnostic)[0].toString(); expect(JSON.parse(text).type).toBe("execution_error"); expect(text).not.toMatch(/private-native-key|https:/);
    const forwarded = deferred<void>(); const originalSend = context.upstream.send.bind(context.upstream); context.upstream.send = (data, options, callback) => { originalSend(data, options, callback); forwarded.resolve(); };
    send(client, { type: "ping", data: "client-message" }); await forwarded.promise;
    expect(context.upstream.sent.at(-1)?.binary).toBe(false); expect(JSON.parse(context.upstream.sent.at(-1)!.data.toString()).data).toBe("client-message");
  });
  it("terminates the upstream when the browser closes while connecting", async () => {
    const context = await socketFixture(), client = await context.connect(); send(client, auth); await context.created.promise;
    const closed = once(context.upstream, "close"); client.terminate(); await closed; expect(context.upstream.terminate).toHaveBeenCalled();
    // Connecting transports can still report their cancellation asynchronously.
    expect(() => context.upstream.emit("error", new Error("private-native-key"))).not.toThrow();
  });
  it("rejects extra messages during connection and cleans up without a deadline", async () => {
    const context = await socketFixture(), client = await context.connect(); send(client, auth); await context.created.promise;
    const message = once(client, "message"), closed = once(client, "close"); send(client, { type: "prompt" });
    expect(JSON.parse((await message)[0].toString()).type).toBe("rh_native_error"); await closed; expect(context.upstream.readyState).toBe(3);
  });
  it("contains upstream errors and never forwards close reasons", async () => {
    const context = await socketFixture(), client = await authenticate(context), message = once(client, "message"), closed = once(client, "close");
    context.upstream.emit("error", new Error("wss://www.runninghub.cn/proxy/private-native-key/ws"));
    const text = (await message)[0].toString(); expect(JSON.parse(text).type).toBe("rh_native_error"); expect(text).not.toMatch(/private-native-key|wss:/); const [, reason] = await closed; expect(reason.toString()).toBe(""); expect(context.upstream.terminate).toHaveBeenCalled();
  });
  it("rejects excessive pending output instead of growing the send queue", async () => {
    const context = await socketFixture(), client = await authenticate(context), message = once(client, "message"); context.upstream.bufferedAmount = 64 * 1024 * 1024;
    send(client, { type: "ping" }); expect(JSON.parse((await message)[0].toString()).type).toBe("rh_native_error"); expect(context.upstream.sent).toHaveLength(0); expect(context.upstream.readyState).toBe(3);
  });
  it("disposing closes pending sessions and detaches the server listener", async () => {
    const context = await socketFixture(), client = await context.connect(); send(client, auth); await context.created.promise; const closed = once(client, "close");
    disposers.at(-1)!(); await closed; expect(context.upstream.readyState).toBe(3); expect(servers.at(-1)!.listenerCount("upgrade")).toBe(0);
  });
  it("registers both development and preview hooks", () => {
    const plugin = runningHubNativeProxyPlugin(); expect(plugin.name).toBe("canvas-runninghub-native-proxy"); expect(plugin.configureServer).toBeTypeOf("function"); expect(plugin.configurePreviewServer).toBeTypeOf("function");
  });
});
