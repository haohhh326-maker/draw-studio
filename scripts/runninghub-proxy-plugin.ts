import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LookupAddress } from "node:dns";
import type { Plugin } from "vite";
import { trustedCanvasRequest, trustedOrigins } from "./workflow-library-plugin";
import { isRunningHubFakeIp, isTrustedRunningHubResultHostname, resolveRunningHubPublicDns } from "./runninghub-public-dns";

const MAX_BODY = 32 * 1024 * 1024;
const UPLOAD_PATH = "/openapi/v2/media/upload/binary";
const API_PATHS = new Set([
  "/uc/openapi/accountStatus",
  "/task/openapi/create", "/task/openapi/outputs", "/task/openapi/status", "/task/openapi/cancel",
  "/task/openapi/ai-app/run", "/openapi/v2/query", "/openapi/v2/media/upload/binary",
]);
const PUBLIC_DETAIL_PATHS = new Map([["/api/workflow/getDetail", "workflowId"], ["/api/webapp/detail", "webappId"]]);
const APP_RUN_PATH = /^\/openapi\/v2\/run\/ai-app\/\d{1,32}$/;
export type RunningHubProxyOptions = {
  trustedOrigins?: string[];
  basePath?: string;
  /** Injectable transports keep proxy tests entirely offline. */
  transport?: typeof https.request;
  resolveHostname?: (hostname: string) => Promise<LookupAddress[]>;
  resolvePublicHostname?: (hostname: string, signal?: AbortSignal) => Promise<LookupAddress[]>;
};
/** Stream a signed result without forwarding credentials or adding a deadline. */
export async function streamRunningHubResult(request: IncomingMessage, response: ServerResponse, value: string, options: RunningHubProxyOptions = {}, visited: string[] = []) {
  if (!isTrustedRunningHubResultHostname(new URL(value).hostname)) throw new ProxyError(502, "RunningHub 结果下载跳转无效。");
  await streamResult(request, response, value, options, visited, true);
}
async function streamResult(request: IncomingMessage, response: ServerResponse, value: string, options: RunningHubProxyOptions, visited: string[] = [], officialOnly = false) {
  if (visited.length >= 3 || visited.includes(value)) throw new ProxyError(502, "RunningHub 结果下载跳转无效。");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.once("aborted", cancel); response.once("close", cancel);
  try {
    const { url, address } = await resultTarget(value,
      options.resolveHostname ?? (hostname => lookup(hostname, { all: true, verbatim: true })),
      options.resolvePublicHostname ?? ((hostname, signal) => resolveRunningHubPublicDns(hostname, { signal })), controller.signal);
    controller.signal.throwIfAborted();
    await forward(request, response, url, undefined, "result", options, address, async location => {
      const next = new URL(location, url);
      if (officialOnly && !isTrustedRunningHubResultHostname(next.hostname)) throw new ProxyError(502, "RunningHub 结果下载跳转无效。");
      await streamResult(request, response, next.href, options, [...visited, value], officialOnly);
    });
  } finally { request.off("aborted", cancel); response.off("close", cancel); }
}
class ProxyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function fail(response: ServerResponse, status: number, message: string) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...([408, 413].includes(status) ? { Connection: "close" } : {}) });
  response.end(JSON.stringify({ error: message }));
}
function officialBase(value: string | string[] | undefined) {
  if (typeof value !== "string" || !["https://www.runninghub.cn", "https://www.runninghub.ai"].includes(value))
    throw new ProxyError(400, "请选择 RunningHub 官方站点。");
  return value;
}
/** Only globally routable addresses may serve signed output downloads. */
export function publicRunningHubResultAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113 || address === "168.63.129.16");
  }
  if (family !== 6 || address.includes("%")) return false;
  const words = address.toLowerCase().split(":"), first = parseInt(words[0], 16), second = parseInt(words[1] || "0", 16);
  // IPv4-mapped/translated, local, multicast, 6to4 and reserved special ranges are excluded.
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && !(first === 0x3fff && second < 0x1000)
    && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}
async function resultTarget(value: string, resolveHostname: (hostname: string) => Promise<LookupAddress[]>, resolvePublicHostname: (hostname: string, signal?: AbortSignal) => Promise<LookupAddress[]>, signal?: AbortSignal) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProxyError(400, "结果下载地址无效。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443")
    throw new ProxyError(400, "结果下载仅支持公开 HTTPS 地址。");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname || /(?:^|\.)(?:localhost|local|internal)$/i.test(hostname)) throw new ProxyError(400, "结果下载地址不允许访问本地网络。");
  const family = isIP(hostname);
  let addresses: LookupAddress[] = family ? [{ address: hostname, family }] : await resolveHostname(hostname);
  signal?.throwIfAborted();
  // TUN proxies may replace public CDN answers with 198.18/15 placeholders.
  // Resolve only known RH result hosts through a fixed trusted DNS endpoint;
  // the placeholder itself never reaches the download transport.
  if (!family && isTrustedRunningHubResultHostname(hostname) && addresses.length && addresses.every(item => isRunningHubFakeIp(item.address))) {
    try { addresses = await resolvePublicHostname(hostname, signal); }
    catch (reason) { if (signal?.aborted) throw reason; throw new ProxyError(502, "RunningHub 官方结果域名解析暂时失败，请稍后恢复原任务。"); }
  }
  if (!addresses.length || addresses.some(item => !publicRunningHubResultAddress(item.address) || isIP(item.address) !== item.family))
    throw new ProxyError(400, "结果下载地址不允许访问本地或保留网络。");
  return { url, address: addresses[0] };
}
async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const length = request.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new ProxyError(413, "RunningHub 上传内容超过 32 MB。");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const cleanup = () => { clearTimeout(timer); request.off("data", data); request.off("end", end); request.off("error", failed); request.off("aborted", aborted); };
    const failed = (reason: Error) => { cleanup(); reject(reason); };
    const aborted = () => failed(new ProxyError(400, "RunningHub 请求已中断。"));
    const data = (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      received += chunk.length;
      if (received > MAX_BODY) { failed(new ProxyError(413, "RunningHub 上传内容超过 32 MB。")); request.resume(); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const timer = setTimeout(() => { failed(new ProxyError(408, "RunningHub 请求接收超时。")); request.resume(); }, 60000);
    timer.unref();
    request.on("data", data); request.once("end", end); request.once("error", failed); request.once("aborted", aborted);
    if (request.aborted || request.destroyed) aborted();
  });
}
type ForwardMode = "api-post" | "public-post" | "upload" | "result";
function safeIfRange(value: string | string[] | undefined): value is string {
  return typeof value === "string" && (/^"[\x21\x23-\x7e]*"$/.test(value)
    || /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) && Number.isFinite(Date.parse(value)));
}
function forward(request: IncomingMessage, response: ServerResponse, target: URL, body: Buffer | undefined, mode: ForwardMode, options: RunningHubProxyOptions, address?: LookupAddress, followResultRedirect?: (location: string) => Promise<void>): Promise<void> {
  return new Promise(resolve => {
    let followingRedirect = false;
    const headers: Record<string, string> = {};
    if (mode !== "result") {
      if (mode !== "public-post" && typeof request.headers.authorization === "string") headers.authorization = request.headers.authorization;
      headers.accept = "application/json";
      if (mode === "api-post" || mode === "public-post" || mode === "upload") {
        if (typeof request.headers["content-type"] === "string") headers["content-type"] = request.headers["content-type"];
        if (mode === "upload") {
          const length = request.headers["content-length"];
          if (typeof length === "string" && /^\d+$/.test(length) && Number.isSafeInteger(Number(length))) headers["content-length"] = length;
          else headers["transfer-encoding"] = "chunked";
        } else headers["content-length"] = String(body?.length ?? 0);
      }
    }
    // Signed result downloads receive no API credentials, cookies, referrer or caller headers.
    if (mode === "result" && typeof request.headers.range === "string" && /^bytes=(?:\d+-\d*|-\d+)$/.test(request.headers.range)) {
      headers.range = request.headers.range;
      if (safeIfRange(request.headers["if-range"])) headers["if-range"] = request.headers["if-range"];
    }
    const transport = options.transport ?? https.request;
    const stopUpload = () => {
      if (mode !== "upload") return;
      // An upstream rejection can arrive before the browser finishes sending.
      // Detach/drain its body, rather than destroying the browser connection and
      // losing the useful HTTP error response in a network-reset error.
      request.unpipe(upstream);
      if (!request.destroyed && !request.readableEnded) request.resume();
    };
    const upstream = transport(target, { method: mode !== "result" ? "POST" : "GET", headers, ...(address ? {
      family: address.family,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
    } : {}) }, result => {
      stopUpload();
      const interrupted = () => {
        if (followingRedirect) return;
        if (!response.writableEnded) response.destroy();
        result.destroy(); upstream.destroy(); resolve();
      };
      result.on("error", interrupted);
      result.once("aborted", interrupted);
      result.once("close", () => { if (!result.readableEnded) interrupted(); });
      const status = result.statusCode ?? 502;
      if (followResultRedirect && [301, 302, 303, 307, 308].includes(status) && result.headers.location) {
        followingRedirect = true;
        // The redirect body is irrelevant and may never end; only the checked
        // next hop owns the browser response from this point onward.
        result.destroy(); upstream.destroy();
        void followResultRedirect(result.headers.location).then(resolve, () => { fail(response, 502, "RunningHub 结果下载跳转无效。"); resolve(); });
        return;
      }
      if (status < 200 || status >= 300) {
        // Redirects and upstream failure bodies may expose credentials or private URLs.
        const safeStatus = mode === "upload" && status >= 400 && status < 500 ? status
          : mode !== "result" && [401, 403, 404, 410].includes(status) ? status : 502;
        const message = mode === "result" ? `RunningHub 结果下载失败（上游 HTTP ${status}）。`
          : mode === "upload" ? status === 413 ? "RunningHub 拒绝上传：素材文件过大（上游 HTTP 413），请减小文件后重试。"
            : `RunningHub 素材上传失败（上游 HTTP ${status}）。`
          : "RunningHub 服务暂时无法完成此请求。";
        fail(response, safeStatus, message);
        result.destroy(); upstream.destroy(); resolve(); return;
      }
      const outputHeaders: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
      for (const name of ["content-type", "content-length", "content-encoding", "content-range", "accept-ranges", ...(mode === "result" ? ["etag", "last-modified"] : [])]) {
        const value = result.headers[name];
        if (typeof value === "string") outputHeaders[name] = value;
      }
      response.writeHead(status, outputHeaders);
      result.once("end", () => { if (mode === "upload") upstream.destroy(); resolve(); });
      result.pipe(response);
    });
    const abort = () => { stopUpload(); upstream.destroy(); };
    if (mode !== "result" && mode !== "upload") upstream.setTimeout(300000, () => upstream.destroy(new Error("RunningHub proxy timeout")));
    upstream.once("error", () => { stopUpload(); fail(response, 502, mode === "upload" ? "RunningHub 素材上传连接中断，请检查网络后重试。" : "RunningHub 服务暂时无法连接。"); resolve(); });
    request.once("aborted", abort); request.once("error", abort);
    response.once("close", () => { if (mode === "upload" || !response.writableEnded) abort(); });
    upstream.once("close", () => { request.off("aborted", abort); request.off("error", abort); if (!followingRedirect) resolve(); });
    if (mode === "upload") {
      // pipe applies writable backpressure and preserves multipart boundaries;
      // uploads never pass through the bounded JSON Buffer or its timer.
      if (request.aborted || request.destroyed || response.destroyed) abort();
      else request.pipe(upstream);
    } else if ((mode === "api-post" || mode === "public-post") && body) upstream.end(body); else upstream.end();
  });
}

export function runningHubProxyHandler(options: RunningHubProxyOptions = {}) {
  const origins = trustedOrigins(options.trustedOrigins);
  const prefix = (options.basePath ?? "").replace(/\/+$/, "");
  if (prefix && !/^\/(?:[A-Za-z0-9_-]+\/?)+$/.test(prefix)) throw new Error("RunningHub 代理路径无效。");
  const api = prefix + "/api/runninghub", download = prefix + "/api/runninghub-result";
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const raw = request.url ?? "/";
    let url: URL;
    try { url = new URL(raw, "http://localhost"); } catch { next(); return; }
    if (!(url.pathname === api || url.pathname.startsWith(api + "/") || url.pathname === download)) { next(); return; }
    if (!trustedCanvasRequest(request, origins)) { fail(response, 403, "RunningHub 代理仅允许画布同源访问。"); return; }
    try {
      if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.split("?")[0] !== url.pathname)
        throw new ProxyError(400, "RunningHub 请求路径无效。");
      if (url.pathname === download) {
        if (request.method !== "GET") { response.setHeader("Allow", "GET"); throw new ProxyError(405, "结果下载只接受 GET。"); }
        if (url.searchParams.getAll("url").length !== 1 || [...url.searchParams.keys()].some(key => key !== "url")) throw new ProxyError(400, "结果下载仅接受一个结果地址。");
        await streamResult(request, response, url.searchParams.get("url")!, options);
        return;
      }
      const apiPath = url.pathname.slice(api.length);
      if (["/api/openapi/getJsonApiFormat", "/api/webapp/apiCallDemo"].includes(apiPath))
        throw new ProxyError(404, "旧工作流读取入口已移除，请使用 AIFISHER 工作流读取。");
      if (request.method !== "POST") { response.setHeader("Allow", "POST"); throw new ProxyError(405, "RunningHub 接口只接受 POST。"); }
      if ((!API_PATHS.has(apiPath) && !PUBLIC_DETAIL_PATHS.has(apiPath) && !APP_RUN_PATH.test(apiPath)) || raw.includes("?")) throw new ProxyError(400, "不支持此 RunningHub 接口。");
      const base = officialBase(request.headers["x-runninghub-base-url"]);
      if (apiPath === UPLOAD_PATH) {
        await forward(request, response, new URL(apiPath, base), undefined, "upload", options);
        return;
      }
      const body = await requestBody(request);
      const detailIdField = PUBLIC_DETAIL_PATHS.get(apiPath);
      if (detailIdField) {
        let data: unknown;
        try { data = JSON.parse(body.toString("utf8")); } catch { throw new ProxyError(400, "工作流详情读取参数必须是 JSON。"); }
        if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, detailIdField)) throw new ProxyError(400, "工作流详情仅接受对应 ID。");
        const id = (data as Record<string, unknown>)[detailIdField];
        if (typeof id !== "string" || !/^\d{1,32}$/.test(id)) throw new ProxyError(400, "工作流详情 ID 必须是数字字符串。");
        await forward(request, response, new URL(apiPath, base), Buffer.from(JSON.stringify({ [detailIdField]: id })), "public-post", options);
        return;
      }
      await forward(request, response, new URL(apiPath, base), body, "api-post", options);
    } catch (reason) {
      fail(response, reason instanceof ProxyError ? reason.status : 502, reason instanceof ProxyError ? reason.message : "RunningHub 服务暂时无法连接。");
      request.resume();
    }
  };
}

export function runningHubProxyPlugin(options: RunningHubProxyOptions = {}): Plugin {
  const handle = runningHubProxyHandler(options);
  return {
    name: "canvas-runninghub-proxy",
    configureServer(server) { server.middlewares.use((request, response, next) => { void handle(request, response, next).catch(next); }); },
    configurePreviewServer(server) { server.middlewares.use((request, response, next) => { void handle(request, response, next).catch(next); }); },
  };
}
