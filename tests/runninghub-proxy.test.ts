import { afterEach, describe, expect, it, vi } from "vitest";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type net from "node:net";
import { PassThrough, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { publicRunningHubResultAddress, runningHubProxyHandler, runningHubProxyPlugin, type RunningHubProxyOptions } from "../scripts/runninghub-proxy-plugin";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
type TransportCall = { target: URL; options: https.RequestOptions; body: Buffer };
function transportFixture(status = 200, content = '{"code":0,"data":{}}', headers: http.IncomingHttpHeaders = { "content-type": "application/json" }) {
  const calls: TransportCall[] = [];
  const transport = vi.fn((target: URL, options: https.RequestOptions, listener: (response: IncomingMessage) => void) => {
    const chunks: Buffer[] = [];
    const outgoing = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); }, final(callback) {
      calls.push({ target, options, body: Buffer.concat(chunks) });
      queueMicrotask(() => { const response = Object.assign(new PassThrough(), { statusCode: status, headers }); listener(response as unknown as IncomingMessage); response.end(content); });
      callback();
    } });
    Object.assign(outgoing, { setTimeout: () => outgoing });
    return outgoing;
  });
  return { calls, transport: transport as unknown as typeof https.request, spy: transport };
}
async function fixture(options: RunningHubProxyOptions = {}) {
  const handler = runningHubProxyHandler(options);
  const server = http.createServer((request, response) => { void handler(request, response, () => { response.statusCode = 404; response.end("outside"); }); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}
function request(port: number, pathname: string, headers: http.OutgoingHttpHeaders = {}, method = "POST", body: string | Buffer = "{}") {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const outgoing = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.once("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    }); outgoing.once("error", reject); outgoing.end(method === "GET" ? undefined : body);
  });
}
const apiHeaders = { "x-runninghub-base-url": "https://www.runninghub.cn", authorization: "Bearer test-key", "content-type": "application/json" };
const resultPath = (url: string) => "/api/runninghub-result?url=" + encodeURIComponent(url);

describe("RunningHub same-origin proxy", () => {
  it.each([["/api/workflow/getDetail", "workflowId"], ["/api/webapp/detail", "webappId"]])("reads public published card metadata via %s without forwarding any account secrets", async (path, field) => {
    const fake = transportFixture(), port = await fixture({ transport: fake.transport });
    const body = JSON.stringify({ [field]: "2104519856463900674" });
    const response = await request(port, "/api/runninghub" + path, { ...apiHeaders, cookie: "private=cookie", referer: "https://private.example/" }, "POST", body);
    expect(response.status).toBe(200); expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].target.toString()).toBe("https://www.runninghub.cn" + path);
    expect(fake.calls[0].options.method).toBe("POST"); expect(fake.calls[0].body.toString()).toBe(body);
    expect(fake.calls[0].options.headers).toEqual({ accept: "application/json", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  });
  it("rejects extra public-detail body fields, numeric IDs, query credentials and foreign origins before forwarding", async () => {
    const fake = transportFixture(), port = await fixture({ transport: fake.transport });
    for (const body of ['{"workflowId":123}', '{"workflowId":"123","apiKey":"private-key"}', '{"workflowId":"123","url":"https://foreign.example"}', '{"webappId":"123"}', "[]", "{}", "not-json"]) expect((await request(port, "/api/runninghub/api/workflow/getDetail", apiHeaders, "POST", body)).status).toBe(400);
    expect((await request(port, "/api/runninghub/api/workflow/getDetail?workflowId=123", apiHeaders)).status).toBe(400);
    expect((await request(port, "/api/runninghub/api/workflow/getDetail", { ...apiHeaders, origin: "https://foreign.example" }, "POST", '{"workflowId":"123"}')).status).toBe(403);
    expect(fake.spy).not.toHaveBeenCalled();
  });
  it.each(["/uc/openapi/accountStatus", "/task/openapi/create", "/task/openapi/outputs", "/task/openapi/status", "/task/openapi/cancel", "/task/openapi/ai-app/run", "/openapi/v2/query", "/openapi/v2/run/ai-app/1234567890123456789", "/openapi/v2/media/upload/binary"])("forwards only the official POST endpoint %s with unchanged body/auth", async path => {
    const fake = transportFixture(), port = await fixture({ transport: fake.transport });
    const body = '{"apiKey":"test-key","workflowId":"123"}';
    const response = await request(port, "/api/runninghub" + path, { ...apiHeaders, cookie: "private=do-not-forward", referer: "https://private.example/" }, "POST", body);
    expect(response.status).toBe(200); expect(JSON.parse(response.body).code).toBe(0);
    expect(fake.calls).toHaveLength(1); expect(fake.calls[0].target.toString()).toBe("https://www.runninghub.cn" + path);
    expect(fake.calls[0].body.toString()).toBe(body);
    expect(fake.calls[0].options.headers).toEqual({ authorization: "Bearer test-key", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), accept: "application/json" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("supports the international site and an explicit canvas base path", async () => {
    const fake = transportFixture(), port = await fixture({ transport: fake.transport, basePath: "/canvas/" });
    expect((await request(port, "/canvas/api/runninghub/uc/openapi/accountStatus", { ...apiHeaders, "x-runninghub-base-url": "https://www.runninghub.ai" })).status).toBe(200);
    expect(fake.calls[0].target.origin).toBe("https://www.runninghub.ai");
    expect((await request(port, "/api/runninghub/uc/openapi/accountStatus", apiHeaders)).status).toBe(404);
    const plugin = runningHubProxyPlugin(); expect(plugin.configureServer).toBeTypeOf("function"); expect(plugin.configurePreviewServer).toBeTypeOf("function");
  });
  it("rejects cross-origin requests, arbitrary targets, paths, query strings and methods before upstream traffic", async () => {
    const fake = transportFixture(), port = await fixture({ transport: fake.transport });
    expect((await request(port, "/api/runninghub/uc/openapi/accountStatus", { ...apiHeaders, origin: "https://foreign.example" })).status).toBe(403);
    for (const base of ["http://www.runninghub.cn", "https://www.runninghub.cn.evil.example", "https://www.runninghub.cn@evil.example", "https://www.runninghub.cn/", "https://www.runninghub.cn:444", "http://127.0.0.1"]) expect((await request(port, "/api/runninghub/uc/openapi/accountStatus", { ...apiHeaders, "x-runninghub-base-url": base })).status).toBe(400);
    for (const path of ["/api/runninghub/arbitrary", "/api/runninghub/task/openapi/create?url=https://evil.example", "/api/runninghub/task/openapi/../openapi/create", "/api/runninghub/task%2fopenapi%2fcreate"]) expect((await request(port, path, apiHeaders)).status).toBe(400);
    expect((await request(port, "/api/runninghub/task/openapi/create", apiHeaders, "GET")).status).toBe(405);
    expect(fake.spy).not.toHaveBeenCalled();
  });
  it("permits an explicitly configured public origin but requires POST Origin to match", async () => {
    const fake = transportFixture(), origin = "https://canvas.example:8443", port = await fixture({ transport: fake.transport, trustedOrigins: [origin] });
    expect((await request(port, "/api/runninghub/uc/openapi/accountStatus", { ...apiHeaders, host: "canvas.example", origin })).status).toBe(200);
    expect((await request(port, "/api/runninghub/uc/openapi/accountStatus", { ...apiHeaders, host: "canvas.example" })).status).toBe(403);
    expect(fake.calls).toHaveLength(1);
  });
  it("keeps declared and chunked task JSON above 32 MiB from reaching a paid endpoint", async () => {
    const fake = transportFixture(), port = await fixture({ transport: fake.transport });
    expect((await request(port, "/api/runninghub/task/openapi/create", { ...apiHeaders, "content-length": String(32 * 1024 * 1024 + 1) }, "POST", "")).status).toBe(413);
    expect((await request(port, "/api/runninghub/task/openapi/ai-app/run", { ...apiHeaders, "transfer-encoding": "chunked" }, "POST", Buffer.alloc(32 * 1024 * 1024 + 1))).status).toBe(413);
    expect(fake.spy).not.toHaveBeenCalled();
  });
  it.each([true, false])("streams a >32 MiB multipart upload unchanged before reading its end (known length: %s)", async knownLength => {
    const prefix = Buffer.from('--media-fixture\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n');
    const suffix = Buffer.from('\r\n--media-fixture--\r\n');
    const fileSize = 35_188_339, size = prefix.length + fileSize + suffix.length;
    const actual = createHash("sha256"), expected = createHash("sha256");
    let received = 0, first!: () => void, upstreamOptions: https.RequestOptions | undefined;
    const firstChunk = new Promise<void>(resolve => { first = resolve; });
    const deadline = vi.fn();
    const transport = vi.fn((target: URL, options: https.RequestOptions, listener: (response: IncomingMessage) => void) => {
      expect(target.href).toBe("https://www.runninghub.cn/openapi/v2/media/upload/binary");
      upstreamOptions = options;
      return Object.assign(new Writable({
        write(chunk, _encoding, callback) { received += chunk.length; actual.update(chunk); first(); callback(); },
        final(callback) {
          queueMicrotask(() => {
            const result = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "application/json" } });
            listener(result as unknown as IncomingMessage); result.end('{"code":0,"data":{"fileName":"uploaded.png"}}');
          }); callback();
        },
      }), { setTimeout: deadline });
    });
    const port = await fixture({ transport: transport as unknown as typeof https.request });
    let outgoing!: http.ClientRequest;
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      outgoing = http.request({ hostname: "127.0.0.1", port, path: "/api/runninghub/openapi/v2/media/upload/binary", method: "POST",
        headers: { ...apiHeaders, "content-type": "multipart/form-data; boundary=media-fixture", cookie: "private=cookie",
          ...(knownLength ? { "content-length": String(size) } : { "transfer-encoding": "chunked" }) } }, result => {
        let body = ""; result.on("data", chunk => { body += chunk; }); result.once("error", reject);
        result.once("end", () => resolve({ status: result.statusCode!, body }));
      }); outgoing.once("error", reject);
    });
    outgoing.write(prefix); expected.update(prefix);
    await firstChunk;
    expect(outgoing.writableEnded).toBe(false);
    expect(received).toBe(prefix.length);
    const chunk = Buffer.alloc(256 * 1024, 0x5a);
    for (let remaining = fileSize; remaining > 0;) {
      const part = chunk.subarray(0, Math.min(remaining, chunk.length));
      expected.update(part); remaining -= part.length;
      if (!outgoing.write(part)) await once(outgoing, "drain");
    }
    expected.update(suffix); outgoing.end(suffix);
    expect(await response).toEqual({ status: 200, body: '{"code":0,"data":{"fileName":"uploaded.png"}}' });
    expect(received).toBe(size); expect(actual.digest("hex")).toBe(expected.digest("hex"));
    expect(upstreamOptions!.headers).toEqual({ authorization: "Bearer test-key", accept: "application/json", "content-type": "multipart/form-data; boundary=media-fixture",
      ...(knownLength ? { "content-length": String(size) } : { "transfer-encoding": "chunked" }) });
    expect(transport).toHaveBeenCalledOnce(); expect(deadline).not.toHaveBeenCalled();
  });
  it("pauses the incoming upload while its upstream writable applies backpressure", async () => {
    let incoming!: IncomingMessage, release!: () => void, first!: () => void;
    const firstChunk = new Promise<void>(resolve => { first = resolve; });
    let writes = 0;
    const transport = ((_target: URL, _options: https.RequestOptions, listener: (response: IncomingMessage) => void) => Object.assign(new Writable({ highWaterMark: 1,
      write(_chunk, _encoding, callback) { if (++writes === 1) { release = callback; first(); } else callback(); },
      final(callback) { queueMicrotask(() => { const result = Object.assign(new PassThrough(), { statusCode: 200, headers: {} }); listener(result as unknown as IncomingMessage); result.end("ok"); }); callback(); },
    }), { setTimeout: vi.fn() })) as unknown as typeof https.request;
    const handler = runningHubProxyHandler({ transport });
    const server = http.createServer((req, res) => { incoming = req; void handler(req, res, () => res.end()); });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const pending = request((server.address() as net.AddressInfo).port, "/api/runninghub/openapi/v2/media/upload/binary", { ...apiHeaders, "transfer-encoding": "chunked" }, "POST", Buffer.alloc(2 * 1024 * 1024));
    await firstChunk;
    expect(incoming.isPaused()).toBe(true); expect(incoming.readableEnded).toBe(false); expect(writes).toBe(1);
    release(); expect((await pending).status).toBe(200);
  });
  it("destroys the in-flight upload when the browser cancels without retrying or adding a deadline", async () => {
    let upstream!: Writable, first!: () => void, closed!: () => void;
    const firstChunk = new Promise<void>(resolve => { first = resolve; });
    const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
    const deadline = vi.fn();
    const transport = vi.fn(() => {
      upstream = new Writable({ write(_chunk, _encoding, callback) { first(); callback(); } });
      upstream.once("close", closed); return Object.assign(upstream, { setTimeout: deadline });
    });
    const port = await fixture({ transport: transport as unknown as typeof https.request });
    const outgoing = http.request({ hostname: "127.0.0.1", port, path: "/api/runninghub/openapi/v2/media/upload/binary", method: "POST", headers: { ...apiHeaders, "transfer-encoding": "chunked" } });
    outgoing.on("error", () => {}); outgoing.write("first-part");
    await firstChunk; outgoing.destroy(); await upstreamClosed;
    expect(upstream.destroyed).toBe(true); expect(transport).toHaveBeenCalledOnce(); expect(deadline).not.toHaveBeenCalled();
  });
  it.each([413, 415, 500])("returns a clear upload HTTP %i even when the platform rejects the first chunk before the body ends", async status => {
    let upstream!: Writable, result!: PassThrough;
    const deadline = vi.fn();
    const transport = vi.fn((_target: URL, _options: https.RequestOptions, listener: (response: IncomingMessage) => void) => {
      upstream = new Writable({ write(_chunk, _encoding, callback) {
        queueMicrotask(() => {
          result = Object.assign(new PassThrough(), { statusCode: status, headers: { location: "https://private.example/secret" } });
          listener(result as unknown as IncomingMessage); // An error body that never ends must not block the error response.
        }); callback();
      } });
      return Object.assign(upstream, { setTimeout: deadline });
    });
    const port = await fixture({ transport: transport as unknown as typeof https.request });
    let outgoing!: http.ClientRequest;
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      outgoing = http.request({ hostname: "127.0.0.1", port, path: "/api/runninghub/openapi/v2/media/upload/binary", method: "POST",
        headers: { ...apiHeaders, "content-length": String(40 * 1024 * 1024) } }, incoming => {
        let body = ""; incoming.on("data", chunk => { body += chunk; }); incoming.once("error", reject);
        incoming.once("end", () => resolve({ status: incoming.statusCode!, body }));
      }); outgoing.once("error", reject); outgoing.write("first-part");
    });
    expect(outgoing.writableEnded).toBe(false); outgoing.destroy();
    expect(response.status).toBe(status < 500 ? status : 502); expect(response.body).toContain(`HTTP ${status}`);
    if (status === 413) expect(response.body).toContain("素材文件过大");
    expect(response.body).not.toMatch(/secret|private|无法连接/);
    expect(upstream.destroyed).toBe(true); expect(result.destroyed).toBe(true);
    expect(transport).toHaveBeenCalledOnce(); expect(deadline).not.toHaveBeenCalled();
  });
  it("flushes an early 413 from a real upstream socket instead of resetting the browser connection", async () => {
    const upstreamServer = http.createServer((incoming, response) => {
      incoming.once("data", () => { response.writeHead(413, { "content-type": "text/plain" }); response.write("private platform error"); });
    });
    servers.push(upstreamServer); await new Promise<void>(resolve => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstreamServer.address() as net.AddressInfo).port;
    const transport = vi.fn((_target: URL, options: https.RequestOptions, listener: (response: IncomingMessage) => void) =>
      http.request({ hostname: "127.0.0.1", port: upstreamPort, path: "/upload", method: options.method, headers: options.headers }, listener));
    const port = await fixture({ transport: transport as unknown as typeof https.request });
    let outgoing!: http.ClientRequest;
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      outgoing = http.request({ hostname: "127.0.0.1", port, path: "/api/runninghub/openapi/v2/media/upload/binary", method: "POST",
        headers: { ...apiHeaders, "transfer-encoding": "chunked" } }, response => {
        let body = ""; response.on("data", chunk => { body += chunk; }); response.once("error", reject);
        response.once("end", () => resolve({ status: response.statusCode!, body }));
      }); outgoing.once("error", reject); outgoing.write("first-part");
    });
    expect(outgoing.writableEnded).toBe(false); outgoing.destroy();
    expect(result.status).toBe(413); expect(result.body).toContain("素材文件过大");
    expect(result.body).not.toContain("private"); expect(transport).toHaveBeenCalledOnce();
  });
  it("returns a generic error instead of upstream failure bodies or redirects", async () => {
    for (const status of [302, 500]) {
      const fake = transportFixture(status, "private apiKey=secret-key", { location: "http://127.0.0.1/metadata" }), port = await fixture({ transport: fake.transport });
      const response = await request(port, "/api/runninghub/uc/openapi/accountStatus", apiHeaders);
      expect(response.status).toBe(502); expect(response.body).not.toContain("secret-key"); expect(response.headers.location).toBeUndefined(); expect(fake.calls).toHaveLength(1);
    }
  });
  it.each([401, 403, 404, 410])("preserves official API HTTP %i with a generic body, so auth failures cannot masquerade as missing workflows", async status => {
    const fake = transportFixture(status, "private apiKey=secret-key", { location: "https://private.example/secret-key" }), port = await fixture({ transport: fake.transport });
    const response = await request(port, "/api/runninghub/uc/openapi/accountStatus", apiHeaders);
    expect(response.status).toBe(status); expect(response.body).not.toContain("secret-key"); expect(response.headers.location).toBeUndefined(); expect(fake.calls).toHaveLength(1);
  });
  it.each(["/api/openapi/getJsonApiFormat", "/api/webapp/apiCallDemo"])("keeps retired schema-reader endpoint %s closed without upstream traffic", async path => {
    const fake = transportFixture(), port = await fixture({ transport: fake.transport });
    for (const [method, query, body] of [["POST", "", '{"workflowId":"123","webappId":"123","apiKey":"private-key"}'], ["GET", "?apiKey=private-key&webappId=123", ""], ["POST", "", "not-json"]]) {
      const response = await request(port, "/api/runninghub" + path + query, { ...apiHeaders, cookie: "private=cookie" }, method, body);
      expect(response.status).toBe(404); expect(response.body).toContain("AIFISHER");
      expect(response.body).not.toMatch(/private-key|cookie|test-key/);
    }
    expect(fake.spy).not.toHaveBeenCalled();
  });
  it("keeps retired readers closed on the international site under a canvas base path", async () => {
    const fake = transportFixture(), port = await fixture({ transport: fake.transport, basePath: "/canvas" });
    for (const path of ["/api/openapi/getJsonApiFormat", "/api/webapp/apiCallDemo"]) {
      const response = await request(port, "/canvas/api/runninghub" + path, { ...apiHeaders, "x-runninghub-base-url": "https://www.runninghub.ai" }, "POST", '{"webappId":"123"}');
      expect(response.status).toBe(404);
    }
    expect(fake.spy).not.toHaveBeenCalled();
  });
  it.each(["", "123/", "abc", "123abc", "-1", "1.5", "1e3", "123456789012345678901234567890123", "%31%32%33", "123/other"])("rejects nonexact dynamic app endpoint ID %s", async id => {
    const fake = transportFixture(), port = await fixture({ transport: fake.transport });
    expect((await request(port, "/api/runninghub/openapi/v2/run/ai-app/" + id, apiHeaders)).status).toBe(400); expect(fake.spy).not.toHaveBeenCalled();
  });
  it("downloads a public signed HTTPS result without forwarding caller secrets and pins its checked DNS address", async () => {
    const fake = transportFixture(200, "video bytes", { "content-type": "video/mp4" });
    const resolveHostname = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const port = await fixture({ transport: fake.transport, resolveHostname });
    const target = "https://cdn.example/result.mp4?signature=private-output-signature";
    const response = await request(port, resultPath(target), { authorization: "Bearer do-not-forward", cookie: "secret=private", referer: "https://private.example/", "x-runninghub-base-url": "https://www.runninghub.cn" }, "GET");
    expect(response.status).toBe(200); expect(response.body).toBe("video bytes"); expect(response.headers["content-type"]).toBe("video/mp4");
    expect(resolveHostname).toHaveBeenCalledExactlyOnceWith("cdn.example");
    expect(fake.calls[0].target.toString()).toBe(target); expect(fake.calls[0].options.headers).toEqual({}); expect(fake.calls[0].options.family).toBe(4);
    const checked = vi.fn(); fake.calls[0].options.lookup!("cdn.example", {}, checked);
    expect(checked).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });
  it("resolves an official result host behind fake-IP DNS and pins only its checked public address", async () => {
    const fake = transportFixture(200, "original image bytes", { "content-type": "image/png" });
    const hostname = "rh-images-tos.xiaoyaoyou.com";
    const resolvePublicHostname = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const port = await fixture({ transport: fake.transport,
      resolveHostname: async () => [{ address: "198.18.0.43", family: 4 }], resolvePublicHostname });
    const target = "https://" + hostname + "/output/original.png?signature=private-signature%2F%2B";
    const response = await request(port, resultPath(target), { authorization: "Bearer private-key", cookie: "private=cookie" }, "GET");
    expect(response.status).toBe(200); expect(response.body).toBe("original image bytes");
    expect(resolvePublicHostname).toHaveBeenCalledExactlyOnceWith(hostname, expect.any(AbortSignal));
    expect(fake.calls[0].target.toString()).toBe(target);
    expect(fake.calls[0].options.headers).toEqual({}); expect(fake.calls[0].options.family).toBe(4);
    const lookup = vi.fn(); fake.calls[0].options.lookup!(hostname, {}, lookup);
    expect(lookup).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    const allAddresses = vi.fn(); fake.calls[0].options.lookup!(hostname, { all: true }, allAddresses);
    expect(allAddresses).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });
  it.each(["cdn.example", "rh-images-tos.xiaoyaoyou.com.evil.example", "rh-images-tos.xiaoyaoyou.com."])("does not use the official DNS fallback for unlisted host %s", async hostname => {
    const fake = transportFixture(), resolvePublicHostname = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const port = await fixture({ transport: fake.transport,
      resolveHostname: async () => [{ address: "198.18.0.43", family: 4 }], resolvePublicHostname });
    expect((await request(port, resultPath("https://" + hostname + "/result.png"), {}, "GET")).status).toBe(400);
    expect(resolvePublicHostname).not.toHaveBeenCalled(); expect(fake.spy).not.toHaveBeenCalled();
  });
  it.each(["127.0.0.1", "10.0.0.1", "198.18.0.43", "2001:db8::1"])("still rejects unsafe public DNS fallback answer %s", async address => {
    const fake = transportFixture();
    const port = await fixture({ transport: fake.transport,
      resolveHostname: async () => [{ address: "198.18.0.43", family: 4 }],
      resolvePublicHostname: async () => [{ address: "93.184.216.34", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }] });
    expect((await request(port, resultPath("https://rh-images-tos.xiaoyaoyou.com/result.png"), {}, "GET")).status).toBe(400);
    expect(fake.spy).not.toHaveBeenCalled();
  });
  it("does not treat a mixed public/private system DNS result as fake-IP mode", async () => {
    const fake = transportFixture(), resolvePublicHostname = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const port = await fixture({ transport: fake.transport,
      resolveHostname: async () => [{ address: "198.18.0.43", family: 4 }, { address: "127.0.0.1", family: 4 }], resolvePublicHostname });
    expect((await request(port, resultPath("https://rh-images-tos.xiaoyaoyou.com/result.png"), {}, "GET")).status).toBe(400);
    expect(resolvePublicHostname).not.toHaveBeenCalled(); expect(fake.spy).not.toHaveBeenCalled();
  });
  it("keeps DNS fallback failures bounded and does not expose storage signatures or error text", async () => {
    const fake = transportFixture();
    const port = await fixture({ transport: fake.transport,
      resolveHostname: async () => [{ address: "198.18.0.43", family: 4 }],
      resolvePublicHostname: async () => { throw new Error("private-key signed-url"); } });
    const response = await request(port, resultPath("https://rh-images-tos.xiaoyaoyou.com/result.png?signature=secret"), {}, "GET");
    expect(response.status).toBe(502); expect(response.body).toContain("官方结果域名解析暂时失败");
    expect(response.body).not.toMatch(/private-key|signed-url|signature|secret/); expect(fake.spy).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 410])("keeps result download upstream HTTP %i failures generic without forwarding API credentials", async status => {
    const fake = transportFixture(status, "private apiKey=secret-key", { location: "https://private.example/secret-key" }), port = await fixture({ transport: fake.transport, resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }] });
    const response = await request(port, resultPath("https://cdn.example/result.png"), apiHeaders, "GET");
    expect(response.status).toBe(502); expect(response.body).not.toContain("secret-key"); expect(response.headers.location).toBeUndefined(); expect(fake.calls[0].options.headers).toEqual({}); expect(fake.calls).toHaveLength(1);
  });
  it("rejects all DNS answers if even one resolves into private or loopback space", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1"]) {
      const fake = transportFixture(), port = await fixture({ transport: fake.transport, resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }] });
      expect((await request(port, resultPath("https://cdn.example/result.png"), {}, "GET")).status).toBe(400); expect(fake.spy).not.toHaveBeenCalled();
    }
  });
  it("rejects literal local addresses, credentials, non-HTTPS URLs, alternative ports and extra query targets", async () => {
    const fake = transportFixture(), resolveHostname = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]), port = await fixture({ transport: fake.transport, resolveHostname });
    for (const target of ["http://cdn.example/result", "https://127.0.0.1/result", "https://2130706433/result", "https://[::1]/result", "https://[::ffff:127.0.0.1]/result", "https://cdn.example:8443/result", "https://user:pass@cdn.example/result", "https://metadata.internal/result", "https://localhost/result", "https://cdn.example/result#secret"]) expect((await request(port, resultPath(target), {}, "GET")).status).toBe(400);
    expect((await request(port, resultPath("https://cdn.example/result") + "&target=https://evil.example", {}, "GET")).status).toBe(400);
    expect((await request(port, resultPath("https://cdn.example/result") + "&url=https://evil.example", {}, "GET")).status).toBe(400);
    expect((await request(port, resultPath("https://cdn.example/result"), {}, "POST")).status).toBe(405);
    expect(fake.spy).not.toHaveBeenCalled();
  });
  it("streams result bytes to the browser before the video has finished arriving", async () => {
    let finish: (() => void) | undefined;
    const transport = ((_: URL, _options: https.RequestOptions, listener: (response: IncomingMessage) => void) => {
      const outgoing = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) {
        queueMicrotask(() => {
          const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "video/mp4" } });
          listener(response as unknown as IncomingMessage); response.write("first-part"); finish = () => response.end("last-part");
        }); callback();
      } }); return Object.assign(outgoing, { setTimeout: () => outgoing });
    }) as unknown as typeof https.request;
    const port = await fixture({ transport, resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }] });
    let ended = false;
    await new Promise<void>((resolve, reject) => {
      const outgoing = http.get({ hostname: "127.0.0.1", port, path: resultPath("https://cdn.example/video.mp4") }, response => {
        let content = ""; response.on("data", chunk => {
          content += chunk.toString(); if (content === "first-part") { expect(ended).toBe(false); expect(finish).toBeTypeOf("function"); finish!(); }
        }); response.on("end", () => { ended = true; expect(content).toBe("first-partlast-part"); resolve(); });
      }); outgoing.once("error", reject);
    });
  });
  it("closes a failed upstream result immediately even if its error body never ends, without setting a download deadline", async () => {
    let outgoing: Writable, incoming: PassThrough;
    const setTimeout = vi.fn();
    const transport = ((_target: URL, _options: https.RequestOptions, listener: (response: IncomingMessage) => void) => {
      outgoing = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) {
        queueMicrotask(() => {
          incoming = Object.assign(new PassThrough(), { statusCode: 502, headers: {} });
          listener(incoming as unknown as IncomingMessage);
        }); callback();
      } });
      return Object.assign(outgoing, { setTimeout });
    }) as unknown as typeof https.request;
    const port = await fixture({ transport, resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }] });
    const response = await request(port, resultPath("https://cdn.example/video.mp4?signature=private"), {}, "GET");
    expect(response.status).toBe(502); expect(response.body).not.toContain("private");
    expect(outgoing!.destroyed).toBe(true); expect(incoming!.destroyed).toBe(true);
    expect(incoming!.listenerCount("error")).toBeGreaterThan(0);
    expect(setTimeout).not.toHaveBeenCalled();
  });
  it("cancels public DNS work when the browser disconnects, without starting an output download", async () => {
    let started!: () => void, cancelled!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const cancel = new Promise<void>(resolve => { cancelled = resolve; });
    const fake = transportFixture();
    const port = await fixture({ transport: fake.transport,
      resolveHostname: async () => [{ address: "198.18.0.43", family: 4 }],
      resolvePublicHostname: (_hostname, signal) => new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => { cancelled(); reject(signal!.reason); }, { once: true }); started();
      }),
    });
    const outgoing = http.get({ hostname: "127.0.0.1", port, path: resultPath("https://rh-images-tos.xiaoyaoyou.com/video.mp4") });
    outgoing.on("error", () => {});
    await start; outgoing.destroy(); await cancel;
    expect(fake.spy).not.toHaveBeenCalled();
  });
});

describe("public result address screening", () => {
  it.each(["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.1.2.3", "169.254.1.2", "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.0.0.1", "192.0.2.1", "198.18.1.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "168.63.129.16", "::", "::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "fc00::1", "fe80::1", "ff00::1", "2001:db8::1", "2002:7f00:1::", "2001::1", "3fff::1"])("rejects nonpublic or translated address %s", address => expect(publicRunningHubResultAddress(address)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111"])("accepts globally routed address %s", address => expect(publicRunningHubResultAddress(address)).toBe(true));
});
