import { afterEach, describe, expect, it, vi } from "vitest";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type net from "node:net";
import { PassThrough, Writable } from "node:stream";
import { runningHubProxyHandler, type RunningHubProxyOptions } from "../scripts/runninghub-proxy-plugin";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
async function fixture(options: RunningHubProxyOptions) {
  const handler = runningHubProxyHandler(options);
  const server = http.createServer((request, response) => { void handler(request, response, () => response.end()); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}
const target = "https://rh-images-tos.xiaoyaoyou.com/video.mp4";
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
type Reply = { status?: number; headers?: http.IncomingHttpHeaders; body?: string; leaveOpen?: boolean };
function transportFixture(replies: Reply[]) {
  const calls: { target: URL; options: https.RequestOptions; result: PassThrough }[] = [];
  const deadline = vi.fn();
  const transport = ((url: URL, options: https.RequestOptions, listener: (response: IncomingMessage) => void) => {
    const outgoing = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) {
      queueMicrotask(() => {
        const reply = replies[calls.length] ?? { status: 500 };
        const result = Object.assign(new PassThrough(), { statusCode: reply.status ?? 200, headers: reply.headers ?? {} });
        calls.push({ target: url, options, result }); listener(result as unknown as IncomingMessage);
        if (!reply.leaveOpen) result.end(reply.body ?? "video bytes");
      }); callback();
    } });
    return Object.assign(outgoing, { setTimeout: deadline });
  }) as unknown as typeof https.request;
  return { calls, deadline, transport };
}
async function download(port: number, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const outgoing = http.get({ hostname: "127.0.0.1", port, path: "/api/runninghub-result?url=" + encodeURIComponent(target), headers }, result => {
      let body = ""; result.on("data", chunk => { body += chunk; }); result.once("error", reject);
      result.once("end", () => resolve({ status: result.statusCode!, headers: result.headers, body }));
    }); outgoing.once("error", reject);
  });
}

describe("RunningHub result redirects and resumable streaming", () => {
  it("follows a CDN redirect without waiting for its body and revalidates/pins each hop", async () => {
    const next = "https://rh-images.xiaoyaoyou.com/final.mp4?signature=fixture";
    const fake = transportFixture([{ status: 302, headers: { location: next }, leaveOpen: true }, { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 8-18/19", "content-length": "11", etag: '"original"', "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT" } }]);
    const resolveHostname = vi.fn(publicDns), port = await fixture({ transport: fake.transport, resolveHostname });
    const result = await download(port, { range: "bytes=8-", "if-range": '"original"', authorization: "Bearer private", cookie: "private=value" });
    expect(result.status).toBe(206); expect(result.body).toBe("video bytes");
    expect(result.headers.etag).toBe('"original"'); expect(result.headers["last-modified"]).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(resolveHostname.mock.calls.map(call => call[0])).toEqual(["rh-images-tos.xiaoyaoyou.com", "rh-images.xiaoyaoyou.com"]);
    expect(fake.calls.map(call => call.target.href)).toEqual([target, next]);
    for (const call of fake.calls) {
      expect(call.options.headers).toEqual({ range: "bytes=8-", "if-range": '"original"' });
      const checked = vi.fn(); call.options.lookup!(call.target.hostname, {}, checked);
      expect(checked).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    }
    expect(fake.calls[0].result.destroyed).toBe(true); expect(fake.deadline).not.toHaveBeenCalled();
  });
  it("follows a third-party public HTTPS CDN redirect after checking and pinning its address", async () => {
    const next = "https://cdn.example/final.mp4?signature=fixture";
    const fake = transportFixture([{ status: 302, headers: { location: next }, leaveOpen: true }, { headers: { "content-type": "video/mp4" } }]);
    const resolveHostname = vi.fn(async (_hostname: string) => publicDns());
    const port = await fixture({ transport: fake.transport, resolveHostname });
    const result = await download(port, { authorization: "Bearer private", cookie: "private=value" });
    expect(result.status).toBe(200); expect(result.body).toBe("video bytes");
    expect(resolveHostname.mock.calls.map(call => call[0])).toEqual(["rh-images-tos.xiaoyaoyou.com", "cdn.example"]);
    expect(fake.calls.map(call => call.target.href)).toEqual([target, next]);
    expect(fake.calls[1].options.headers).toEqual({});
    const checked = vi.fn(); fake.calls[1].options.lookup!("cdn.example", {}, checked);
    expect(checked).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });
  it.each(["http://rh-images.xiaoyaoyou.com/video.mp4", "https://user:secret@rh-images.xiaoyaoyou.com/video.mp4", "https://127.0.0.1/private", target])("rejects an unsafe or looping redirect %s without leaking its URL", async location => {
    const fake = transportFixture([{ status: 302, headers: { location }, leaveOpen: true }]);
    const port = await fixture({ transport: fake.transport, resolveHostname: publicDns });
    const result = await download(port); expect(result.status).toBe(502); expect(fake.calls).toHaveLength(1);
    expect(result.body).not.toMatch(/secret|untrusted|https?:/);
  });
  it("rejects a second-hop private DNS answer before the transport runs", async () => {
    const fake = transportFixture([{ status: 302, headers: { location: "https://rh-images.xiaoyaoyou.com/video.mp4" } }]);
    const resolveHostname = vi.fn(async (hostname: string) => [{ address: hostname === "rh-images.xiaoyaoyou.com" ? "127.0.0.1" : "93.184.216.34", family: 4 }]);
    const port = await fixture({ transport: fake.transport, resolveHostname });
    expect((await download(port)).status).toBe(502); expect(resolveHostname).toHaveBeenCalledTimes(2); expect(fake.calls).toHaveLength(1);
  });
  it("limits redirect chains and never adds a result timeout", async () => {
    const fake = transportFixture([1, 2, 3].map(n => ({ status: 302, headers: { location: `/hop-${n}` }, leaveOpen: true })));
    const port = await fixture({ transport: fake.transport, resolveHostname: publicDns });
    expect((await download(port)).status).toBe(502); expect(fake.calls).toHaveLength(3); expect(fake.deadline).not.toHaveBeenCalled();
  });
  it.each(['"strong-etag"', "Wed, 21 Oct 2015 07:28:00 GMT"])("preserves a safe If-Range validator %s", async validator => {
    const fake = transportFixture([{}]), port = await fixture({ transport: fake.transport, resolveHostname: publicDns });
    expect((await download(port, { range: "bytes=8-", "if-range": validator })).status).toBe(200);
    expect(fake.calls[0].options.headers).toEqual({ range: "bytes=8-", "if-range": validator });
  });
  it.each([{ range: "bytes=8-", "if-range": 'W/"weak"' }, { range: "bytes=8-", "if-range": "unquoted" }, { range: "bytes=-", "if-range": '"strong"' }, { "if-range": '"strong"' }])("drops unsafe or unpaired resume headers: %j", async headers => {
    const fake = transportFixture([{}]), port = await fixture({ transport: fake.transport, resolveHostname: publicDns });
    await download(port, headers);
    expect(fake.calls[0].options.headers).toEqual(headers.range === "bytes=8-" ? { range: "bytes=8-" } : {});
  });
  it.each(["aborted", "close", "error"])("closes the downstream body after upstream %s so the client can resume", async event => {
    const fake = transportFixture([{ headers: { "content-type": "video/mp4", "content-length": "100" }, leaveOpen: true }]);
    const port = await fixture({ transport: fake.transport, resolveHostname: publicDns });
    const pending = new Promise<void>((resolve, reject) => {
      const outgoing = http.get({ hostname: "127.0.0.1", port, path: "/api/runninghub-result?url=" + encodeURIComponent(target) }, incoming => {
        incoming.once("data", () => {
          const result = fake.calls[0].result;
          if (event === "close") result.destroy();
          else result.emit(event, ...(event === "error" ? [new Error("fixture disconnect")] : []));
        });
        incoming.on("error", () => {}); incoming.once("aborted", resolve);
        incoming.once("end", () => reject(new Error("Truncated body must not look complete")));
      }); outgoing.once("error", reject);
    });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    fake.calls[0].result.write("first-part");
    await pending; expect(fake.calls[0].result.destroyed).toBe(true); expect(fake.deadline).not.toHaveBeenCalled();
  });
});
