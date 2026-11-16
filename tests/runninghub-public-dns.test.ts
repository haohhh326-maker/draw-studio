import { afterEach, describe, expect, it, vi } from "vitest";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { clearRunningHubPublicDnsCache, isRunningHubFakeIp, isTrustedRunningHubResultHostname, resolveRunningHubPublicDns } from "../scripts/runninghub-public-dns";

const host = "rh-images-tos.xiaoyaoyou.com";
const cos = "rh-images-1252422369.cos.ap-beijing.myqcloud.com";
const a = (data = "183.240.8.132", name = host + ".") => ({ name, type: 1, TTL: 10, data });
const cname = (name: string, data: string) => ({ name, type: 5, TTL: 10, data });
const answer = (Answer: unknown[] = [a()], extra = {}) => ({ Status: 0, TC: false, Question: { name: host + ".", type: 1 }, Answer, ...extra });

type Call = {
  target: URL; options: https.RequestOptions; body: Buffer; outgoing: Writable;
  reply: (content?: unknown, statusCode?: number, headers?: Record<string, string>, finish?: boolean) => PassThrough;
};

function controlledFixture(onRequest?: (call: Call) => void) {
  const calls: Call[] = [];
  const transport = vi.fn((target: URL, options: https.RequestOptions, listener: (response: IncomingMessage) => void) => {
    const chunks: Buffer[] = [];
    const outgoing = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); }, final(callback) {
      const call: Call = { target, options, body: Buffer.concat(chunks), outgoing, reply(content = answer(), statusCode = 200, headers = { "content-type": "application/json" }, finish = true) {
        const response = Object.assign(new PassThrough(), { statusCode, headers });
        listener(response as unknown as IncomingMessage);
        if (!response.destroyed) {
          response.write(typeof content === "string" ? content : JSON.stringify(content));
          if (finish) response.end();
        }
        return response;
      } };
      calls.push(call);
      onRequest?.(call);
      callback();
    } });
    return outgoing;
  });
  return { calls, transport: transport as unknown as typeof https.request, spy: transport };
}

function fixture(content: unknown = answer(), statusCode = 200, headers: Record<string, string> = { "content-type": "application/json" }) {
  return controlledFixture(call => queueMicrotask(() => call.reply(content, statusCode, headers)));
}

afterEach(() => { vi.useRealTimers(); clearRunningHubPublicDnsCache(); });

describe("RunningHub fake-IP public DNS fallback", () => {
  it.each(["198.18.0.0", "198.18.0.43", "198.19.255.255"])("recognizes only the benchmark fake-IP range: %s", address => expect(isRunningHubFakeIp(address)).toBe(true));
  it.each(["198.17.255.255", "198.20.0.0", "127.0.0.1", "10.0.0.1", "198.018.0.1", "::ffff:198.18.0.43", "not-an-address"])("does not classify other addresses as fake-IP: %s", address => expect(isRunningHubFakeIp(address)).toBe(false));
  it("accepts only the exact confirmed official result hosts", () => {
    expect(isTrustedRunningHubResultHostname(host)).toBe(true); expect(isTrustedRunningHubResultHostname(cos.toUpperCase())).toBe(true);
    expect(isTrustedRunningHubResultHostname("rh-images.xiaoyaoyou.com")).toBe(true);
    for (const candidate of ["xiaoyaoyou.com", "nested." + host, host + ".evil.example", host + ".", "https://" + host, host + "/?secret=value", "127.0.0.1"]) expect(isTrustedRunningHubResultHostname(candidate)).toBe(false);
  });
  it("refuses unsupported hostnames before any DNS transport, including URL/secret inputs", async () => {
    const fake = fixture();
    for (const candidate of ["https://" + host + "/signed-file?secret=private", host + "?key=private", "foreign.example"]) await expect(resolveRunningHubPublicDns(candidate, fake)).rejects.toThrow(/不支持/);
    expect(fake.spy).not.toHaveBeenCalled();
  });
  it("pins AliDNS bootstrap, preserves TLS hostname, and sends only hostname/type without caller credentials", async () => {
    const fake = fixture(answer([a(), a("183.240.8.146"), a()]));
    expect(await resolveRunningHubPublicDns(host, fake)).toEqual([{ address: "183.240.8.132", family: 4 }, { address: "183.240.8.146", family: 4 }]);
    expect(fake.calls).toHaveLength(2);
    for (const [index, call] of fake.calls.entries()) {
      expect(call.target.origin).toBe("https://dns.alidns.com"); expect(call.target.pathname).toBe("/resolve");
      expect([...call.target.searchParams]).toEqual([["name", host], ["type", "A"]]);
      expect(call.body.length).toBe(0); expect(call.options.headers).toEqual({ accept: "application/dns-json" });
      expect(call.options.servername).toBe("dns.alidns.com"); expect(call.options.agent).toBe(false); expect(call.options.rejectUnauthorized).not.toBe(false); expect(call.options.checkServerIdentity).toBeUndefined();
      const single = vi.fn(), all = vi.fn(), address = ["223.5.5.5", "223.6.6.6"][index];
      call.options.lookup!("dns.alidns.com", {}, single); call.options.lookup!("dns.alidns.com", { all: true }, all);
      expect(single).toHaveBeenCalledWith(null, address, 4); expect(all).toHaveBeenCalledWith(null, [{ address, family: 4 }]);
    }
  });
  it("reads an actual CNAME chain and supports AliDNS Question object or one-item array", async () => {
    const chain = [cname(host + ".", "cdn.volcgslb.com."), cname("cdn.volcgslb.com.", "edge.volcgtm.com."), a("183.240.8.132", "edge.volcgtm.com.")];
    expect(await resolveRunningHubPublicDns(host, fixture(answer(chain, { Question: [{ name: host + ".", type: 1 }] })))).toEqual([{ address: "183.240.8.132", family: 4 }]);
    expect(await resolveRunningHubPublicDns(cos, fixture(answer([a("120.221.169.150", cos + ".")], { Question: { name: cos + ".", type: 1 } })))).toEqual([{ address: "120.221.169.150", family: 4 }]);
  });
  it.each(["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1", "192.0.0.1", "192.0.2.1", "198.18.0.43", "198.19.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "168.63.129.16", "::1", "::ffff:8.8.8.8", "bad-address"])("rejects the entire mixed answer if any A record is nonpublic: %s", async address => {
    await expect(resolveRunningHubPublicDns(host, fixture(answer([a(), a(address)])))).rejects.toThrow(/有效公网/);
  });
  it.each([
    answer([], { Status: 3 }), answer([], { TC: true }), answer([a()], { Question: { name: "other.example.", type: 1 } }),
    answer([a()], { Question: { name: host + ".", type: 28 } }), answer([a()], { Question: [] }), answer([]),
    answer([a("183.240.8.132", "unrelated.example.")]), answer([a(), { name: host, type: 28, data: "2001:4860:4860::8888" }]),
    answer([cname(host, "edge.example."), cname("edge.example.", host), a()]),
    answer([cname("unrelated.example", "edge.example"), a()]), answer([cname(host, "edge.example"), a()]),
    answer([cname(host, "edge.example"), cname(host, "other.example"), a("183.240.8.132", "edge.example")]),
    answer(Array.from({ length: 129 }, () => a())), "not-json", [],
  ])("rejects truncated, mismatched, malformed or unrelated DNS data", async content => {
    await expect(resolveRunningHubPublicDns(host, fixture(content))).rejects.toThrow(/有效公网/);
  });
  it("rejects redirects, upstream errors, unexpected content types and oversized declared or streamed bodies", async () => {
    for (const status of [301, 302, 404, 500]) {
      const fake = fixture("private-response", status, { "content-type": "application/json", location: "https://private.example" });
      await expect(resolveRunningHubPublicDns(host, fake)).rejects.toThrow(/有效公网/); expect(fake.calls).toHaveLength(2);
    }
    await expect(resolveRunningHubPublicDns(host, fixture(answer(), 200, { "content-type": "text/html" }))).rejects.toThrow(/有效公网/);
    await expect(resolveRunningHubPublicDns(host, fixture(answer(), 200, { "content-type": "application/json", "content-length": "65537" }))).rejects.toThrow(/有效公网/);
    await expect(resolveRunningHubPublicDns(host, fixture(" ".repeat(65537)))).rejects.toThrow(/有效公网/);
  });
  it.each([0, 1])("accepts the first complete valid response and cancels the other request (winner %s)", async winner => {
    const fake = controlledFixture();
    const pending = resolveRunningHubPublicDns(host, fake);
    expect(fake.calls).toHaveLength(2);
    const loser = fake.calls[1 - winner];
    const partialResponse = loser.reply("{", 200, undefined, false);
    fake.calls[winner].reply(answer([a("183.240.8.146")]));
    await expect(pending).resolves.toEqual([{ address: "183.240.8.146", family: 4 }]);
    expect(loser.outgoing.destroyed).toBe(true);
    expect(partialResponse.destroyed).toBe(true);
  });
  it("waits for a valid peer after the faster response fails whole-answer validation", async () => {
    const fake = controlledFixture();
    const pending = resolveRunningHubPublicDns(host, fake);
    fake.calls[0].reply(answer([a(), a("127.0.0.1")]));
    fake.calls[1].reply();
    await expect(pending).resolves.toEqual([{ address: "183.240.8.132", family: 4 }]);
  });
  it("does not schedule a timeout and cancels both pending requests only when its caller aborts", async () => {
    vi.useFakeTimers();
    const fake = controlledFixture(), controller = new AbortController();
    let settled = false;
    const pending = resolveRunningHubPublicDns(host, { ...fake, signal: controller.signal });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(settled).toBe(false);
    const reason = new Error("caller cancelled"), rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(fake.calls.every(call => call.outgoing.destroyed)).toBe(true);
  });
  it("rejects an already-aborted caller before transport or even a successful cache hit", async () => {
    const fake = fixture(), controller = new AbortController();
    controller.abort();
    await expect(resolveRunningHubPublicDns(host, { ...fake, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.spy).not.toHaveBeenCalled();
    await resolveRunningHubPublicDns(host, fake);
    await expect(resolveRunningHubPublicDns(host, { ...fake, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.spy).toHaveBeenCalledTimes(2);
  });
  it("keeps simultaneous callers independent so cancelling one cannot cancel another", async () => {
    const fake = controlledFixture(), controller = new AbortController();
    const first = resolveRunningHubPublicDns(host, { ...fake, signal: controller.signal });
    const second = resolveRunningHubPublicDns(host, fake);
    expect(fake.calls).toHaveLength(4);
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(fake.calls.slice(0, 2).every(call => call.outgoing.destroyed)).toBe(true);
    expect(fake.calls.slice(2).every(call => !call.outgoing.destroyed)).toBe(true);
    fake.calls[3].reply();
    await expect(second).resolves.toEqual([{ address: "183.240.8.132", family: 4 }]);
    expect(fake.calls[2].outgoing.destroyed).toBe(true);
  });
  it.each([
    { aliasTtl: 3, addressTtl: 10, expiresAfter: 3000 },
    { aliasTtl: 10, addressTtl: 2, expiresAfter: 2000 },
    { aliasTtl: 300, addressTtl: 200, expiresAfter: 60000 },
  ])("caches only until the shortest record TTL or 60 seconds: %j", async ({ aliasTtl, addressTtl, expiresAfter }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    const fake = fixture(answer([{ ...cname(host, "edge.example"), TTL: aliasTtl }, { ...a("183.240.8.132", "edge.example"), TTL: addressTtl }]));
    const first = await resolveRunningHubPublicDns(host, fake);
    first[0].address = "127.0.0.1";
    first.push({ address: "10.0.0.1", family: 4 });
    vi.setSystemTime(1000 + expiresAfter - 1);
    expect(await resolveRunningHubPublicDns(host.toUpperCase(), fake)).toEqual([{ address: "183.240.8.132", family: 4 }]);
    expect(fake.spy).toHaveBeenCalledTimes(2);
    vi.setSystemTime(1000 + expiresAfter);
    await resolveRunningHubPublicDns(host, fake);
    expect(fake.spy).toHaveBeenCalledTimes(4);
  });
  it.each([0, -1, undefined, "60", null])("uses but does not cache answers with invalid or zero TTL: %s", async TTL => {
    const fake = fixture(answer([{ ...a(), TTL }]));
    await resolveRunningHubPublicDns(host, fake);
    await resolveRunningHubPublicDns(host, fake);
    expect(fake.spy).toHaveBeenCalledTimes(4);
  });
  it("does not cache failed queries, allowing the next invocation to recover", async () => {
    const fake = controlledFixture();
    const first = resolveRunningHubPublicDns(host, fake), rejected = expect(first).rejects.toThrow(/有效公网/);
    fake.calls[0].reply("private-error", 500);
    fake.calls[1].reply(answer([a("127.0.0.1")]));
    await rejected;
    const recovered = resolveRunningHubPublicDns(host, fake);
    expect(fake.calls).toHaveLength(4);
    fake.calls[2].reply();
    await expect(recovered).resolves.toEqual([{ address: "183.240.8.132", family: 4 }]);
  });
  it("isolates injected transports from each other and supports clearing successful cache entries", async () => {
    const first = fixture(), second = fixture(answer([a("183.240.8.146")]));
    await resolveRunningHubPublicDns(host, first);
    expect(await resolveRunningHubPublicDns(host, second)).toEqual([{ address: "183.240.8.146", family: 4 }]);
    expect(second.spy).toHaveBeenCalledTimes(2);
    clearRunningHubPublicDnsCache();
    await resolveRunningHubPublicDns(host, first);
    expect(first.spy).toHaveBeenCalledTimes(4);
  });
});
