import https from "node:https";
import { isIP } from "node:net";
import type { LookupAddress } from "node:dns";
import type { ClientRequest, IncomingMessage } from "node:http";

const RESULT_HOSTS = new Set([
  "rh-images.xiaoyaoyou.com",
  "rh-images-tos.xiaoyaoyou.com",
  "rh-images-1252422369.cos.ap-beijing.myqcloud.com",
]);
const RESOLVER_HOST = "dns.alidns.com";
const RESOLVER_ADDRESSES = ["223.5.5.5", "223.6.6.6"] as const;
const MAX_RESPONSE = 64 * 1024;
const MAX_CACHE_SECONDS = 60;
type CachedAnswer = { addresses: LookupAddress[]; expiresAt: number };
let caches = new WeakMap<typeof https.request, Map<string, CachedAnswer>>();

/** Clear successful DNS entries, including isolated injected-transport caches. */
export function clearRunningHubPublicDnsCache() { caches = new WeakMap(); }

export type RunningHubPublicDnsOptions = {
  /** Injectable HTTPS transport keeps DNS tests offline. The endpoint is fixed. */
  transport?: typeof https.request;
  signal?: AbortSignal;
};

export function isRunningHubFakeIp(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 198 && (b === 18 || b === 19);
}

export function isTrustedRunningHubResultHostname(hostname: string): boolean {
  return RESULT_HOSTS.has(hostname.toLowerCase());
}

function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113 || address === "168.63.129.16");
}

function dnsName(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const name = value.toLowerCase().replace(/\.$/, "");
  if (name.length > 253 || !name.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return;
  return name;
}

function parseAnswers(content: Buffer, hostname: string): { addresses: LookupAddress[]; ttlSeconds: number } {
  const data: unknown = JSON.parse(content.toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
  const record = data as Record<string, unknown>;
  if (record.Status !== 0 || record.TC === true) throw new Error();
  const questions = Array.isArray(record.Question) ? record.Question : [record.Question];
  if (questions.length !== 1 || !questions[0] || typeof questions[0] !== "object"
    || questions[0].type !== 1 || dnsName(questions[0].name) !== hostname) throw new Error();
  if (!Array.isArray(record.Answer) || !record.Answer.length || record.Answer.length > 128) throw new Error();
  const aliases = new Map<string, string>();
  const answers: { name: string; address: string }[] = [];
  let ttlSeconds = MAX_CACHE_SECONDS;
  for (const answer of record.Answer) {
    if (!answer || typeof answer !== "object") throw new Error();
    const name = dnsName(answer.name);
    if (!name) throw new Error();
    // Missing/invalid TTLs remain usable for this request but are never cached.
    ttlSeconds = Math.min(ttlSeconds, typeof answer.TTL === "number" && Number.isFinite(answer.TTL) && answer.TTL >= 0 ? answer.TTL : 0);
    if (answer.type === 5) {
      const target = dnsName(answer.data);
      if (!target || aliases.has(name)) throw new Error();
      aliases.set(name, target);
    } else if (answer.type === 1 && typeof answer.data === "string" && publicIpv4(answer.data)) {
      answers.push({ name, address: answer.data });
    } else {
      // Reject the whole answer, including mixed public/private records.
      throw new Error();
    }
  }
  const visited = new Set<string>();
  let current = hostname;
  while (aliases.has(current)) {
    if (visited.has(current) || visited.size >= 16) throw new Error();
    visited.add(current);
    current = aliases.get(current)!;
  }
  if (visited.has(current) || visited.size !== aliases.size || !answers.length
    || answers.some(answer => answer.name !== current)) throw new Error();
  return { addresses: [...new Set(answers.map(answer => answer.address))].map(address => ({ address, family: 4 })), ttlSeconds };
}

/**
 * Resolve only the confirmed RunningHub result hosts after local fake-IP detection.
 * This request receives a hostname only, never a signed output URL or credentials.
 * Both resolver bootstrap and later result downloads must pin the selected IP;
 * the caller retains the original result hostname for HTTPS/SNI verification.
 */
export async function resolveRunningHubPublicDns(hostname: string, options: RunningHubPublicDnsOptions = {}): Promise<LookupAddress[]> {
  if (!isTrustedRunningHubResultHostname(hostname)) throw new Error("RunningHub 公共 DNS 不支持此结果域名。");
  options.signal?.throwIfAborted();
  const name = hostname.toLowerCase();
  const transport = options.transport ?? https.request;
  let cache = caches.get(transport);
  if (!cache) { cache = new Map(); caches.set(transport, cache); }
  const cached = cache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.addresses.map(address => ({ ...address }));
  cache.delete(name);
  const target = new URL("https://" + RESOLVER_HOST + "/resolve");
  target.searchParams.set("name", name);
  target.searchParams.set("type", "A");
  const requests = new AbortController();
  const cancel = () => requests.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    // Race complete, validated DNS answers, not just successful HTTP headers.
    // Each invocation owns its requests; cancelling it cannot affect a sibling.
    const result = await Promise.any(RESOLVER_ADDRESSES.map(address => queryResolver(target, name, address, transport, requests.signal)));
    options.signal?.throwIfAborted();
    if (result.ttlSeconds > 0) cache.set(name, {
      addresses: result.addresses.map(address => ({ ...address })),
      expiresAt: Date.now() + result.ttlSeconds * 1000,
    });
    return result.addresses.map(address => ({ ...address }));
  } catch {
    options.signal?.throwIfAborted();
    throw new Error("RunningHub 公共 DNS 未返回有效公网地址。");
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    requests.abort();
  }
}

function queryResolver(target: URL, name: string, address: string, transport: typeof https.request, signal: AbortSignal): Promise<ReturnType<typeof parseAnswers>> {
  return new Promise((resolve, reject) => {
    let outgoing: ClientRequest | undefined, incoming: IncomingMessage | undefined, settled = false;
    const fail = () => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", cancel);
      reject(signal.aborted ? signal.reason : new Error("RunningHub 公共 DNS 未返回有效公网地址。"));
      outgoing?.destroy(); incoming?.destroy();
    };
    const cancel = () => fail();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    try {
      outgoing = transport(target, {
        method: "GET", agent: false, family: 4, servername: RESOLVER_HOST,
        headers: { accept: "application/dns-json" },
        lookup: (_hostname, lookupOptions, callback) => {
          // Node may request all addresses even when exactly one is pinned.
          if (lookupOptions.all) callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
        },
      }, response => {
        incoming = response;
        if (settled) { response.destroy(); return; }
        const length = response.headers["content-length"], contentType = response.headers["content-type"];
        if (response.statusCode !== 200 || typeof contentType !== "string"
          || !/^application\/(?:dns-)?json(?:\s*;|$)/i.test(contentType)
          || length !== undefined && (typeof length !== "string" || !/^\d+$/.test(length) || Number(length) > MAX_RESPONSE)) {
          fail(); return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (value: Buffer | string) => {
          if (settled) return;
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          received += chunk.length;
          if (received > MAX_RESPONSE) { fail(); return; }
          chunks.push(chunk);
        });
        response.once("error", fail); response.once("aborted", fail);
        response.once("end", () => {
          if (settled) return;
          try {
            const answer = parseAnswers(Buffer.concat(chunks), name);
            settled = true; signal.removeEventListener("abort", cancel); resolve(answer);
          } catch { fail(); }
        });
      });
      outgoing.once("error", fail);
      if (settled) outgoing.destroy();
      else outgoing.end();
    } catch { fail(); }
  });
}
