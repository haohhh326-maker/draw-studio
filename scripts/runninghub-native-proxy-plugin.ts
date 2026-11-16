import https from "node:https";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { Transform, type Duplex } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { trustedCanvasRequest, trustedOrigins } from "./workflow-library-plugin";
import { streamRunningHubResult, type RunningHubProxyOptions } from "./runninghub-proxy-plugin";
import { isTrustedRunningHubResultHostname } from "./runninghub-public-dns";

const LOCAL_PATH = "/api/runninghub-comfy";
const ENDPOINTS = new Set(["https://www.runninghub.cn/proxy", "https://www.runninghub.cn/proxy-plus"]);
const MAX_DIAGNOSTIC_BYTES = 8 * 1024 * 1024;
const MAX_SOCKET_BYTES = 64 * 1024 * 1024;
type SocketData = string | Buffer | ArrayBuffer | Buffer[];
/** A small public transport surface keeps tests offline without requiring @types/ws. */
export interface NativeProxySocket extends EventEmitter {
  readyState: number;
  bufferedAmount: number;
  send(data: SocketData, options: { binary: boolean }, callback: (error?: Error) => void): void;
  pause(): void;
  resume(): void;
  terminate(): void;
}
interface NativeSocketServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: NativeProxySocket) => void): void;
  close(): void;
}
const ws = createRequire(import.meta.url)("ws") as {
  WebSocket: new (url: URL, options: { followRedirects: false; perMessageDeflate: false; maxPayload: number }) => NativeProxySocket;
  WebSocketServer: new (options: { noServer: true; perMessageDeflate: false; maxPayload: number }) => NativeSocketServer;
};
export type RunningHubNativeProxyOptions = {
  trustedOrigins?: string[];
  basePath?: string;
  /** Allows the cloud server's existing opt-in gateway-origin resolver. */
  requestOrigins?: (request: IncomingMessage) => string[];
  transport?: typeof https.request;
  resolveHostname?: RunningHubProxyOptions["resolveHostname"];
  resolvePublicHostname?: RunningHubProxyOptions["resolvePublicHostname"];
  createWebSocket?: (url: URL) => NativeProxySocket;
};
class NativeProxyError extends Error {
  constructor(readonly status: number, message: string, readonly allow?: string) { super(message); }
}
function localPath(options: RunningHubNativeProxyOptions) {
  const prefix = (options.basePath ?? "").replace(/\/+$/, "");
  if (prefix && !/^\/(?:[A-Za-z0-9_-]+\/?)+$/.test(prefix)) throw new Error("RunningHub 原生代理路径无效。");
  return prefix + LOCAL_PATH;
}
function fail(response: ServerResponse, status: number, message: string, allow?: string) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...(allow ? { Allow: allow } : {}) });
  response.end(JSON.stringify({ error: message }));
}
function endpoint(value: unknown): string {
  if (typeof value !== "string" || !ENDPOINTS.has(value)) throw new NativeProxyError(400, "请选择 RunningHub 中国站原生接口。");
  return value;
}
function token(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{1,512}$/.test(value)) throw new NativeProxyError(401, "RunningHub API Key 无效。");
  return value;
}
function authorization(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) throw new NativeProxyError(401, "请填写 RunningHub API Key。");
  return token(value.slice(7));
}
function requestUrl(request: IncomingMessage, local: string): URL | undefined {
  const raw = request.url ?? "/";
  let url: URL;
  try { url = new URL(raw, "http://localhost"); }
  catch { if (raw.startsWith(local)) throw new NativeProxyError(400, "RunningHub 原生请求路径无效。"); return; }
  if (!(url.pathname === local || url.pathname.startsWith(local + "/") || raw.startsWith(local + "/"))) return;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes("#") || raw.split("?")[0] !== url.pathname)
    throw new NativeProxyError(400, "RunningHub 原生请求路径无效。");
  return url;
}
function safeSegment(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 256 && !/[\/\\%\x00-\x1f\x7f]/.test(decoded) && decoded !== "." && decoded !== "..";
  } catch { return false; }
}
function queryKeys(url: URL, allowed: string[]) {
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !allowed.includes(key))) throw new NativeProxyError(400, "RunningHub 原生请求参数无效。");
}
function route(url: URL, local: string, method: string): string {
  const path = url.pathname.slice(local.length);
  let methods: string[] = [];
  if (["/system_stats", "/object_info"].includes(path) || path.startsWith("/object_info/") && safeSegment(path.slice(13))) methods = ["GET"];
  else if (["/queue", "/prompt", "/history"].includes(path)) methods = ["GET", "POST"];
  else if (/^\/history\/[A-Za-z0-9_-]{1,128}$/.test(path)) methods = ["GET"];
  else if (/^\/task-outputs\/\d{1,32}$/.test(path)) methods = ["GET"];
  else if (["/upload/image", "/upload/mask", "/interrupt", "/free", "/account"].includes(path) || /^\/api\/jobs\/[A-Za-z0-9_-]{1,128}\/cancel$/.test(path)) methods = ["POST"];
  else if (path === "/view") methods = ["GET"];
  if (!methods.length) throw new NativeProxyError(404, "RunningHub 原生代理不支持此路径。");
  if (!methods.includes(method)) throw new NativeProxyError(405, "RunningHub 原生接口请求方法无效。", methods.join(", "));
  queryKeys(url, path === "/view" ? ["filename", "subfolder", "type", "preview", "channel"] : path === "/history" && method === "GET" ? ["max_items", "offset"] : []);
  if (path === "/view") {
    const filename = url.searchParams.get("filename"), subfolder = url.searchParams.get("subfolder") ?? "";
    if (!filename || filename.length > 1024 || /[\/\\\x00-\x1f\x7f]/.test(filename) || [".", ".."].includes(filename) || subfolder.length > 2048 || /[\\\x00-\x1f\x7f]/.test(subfolder) || subfolder.split("/").some(part => part === "." || part === "..") || subfolder.startsWith("/"))
      throw new NativeProxyError(400, "RunningHub 文件参数无效。");
    const type = url.searchParams.get("type"), channel = url.searchParams.get("channel"), preview = url.searchParams.get("preview");
    if (type !== null && !["input", "output", "temp"].includes(type) || channel !== null && !["rgb", "rgba", "a"].includes(channel) || preview !== null && !/^[A-Za-z0-9;,._-]{1,64}$/.test(preview))
      throw new NativeProxyError(400, "RunningHub 文件参数无效。");
  } else if ([...url.searchParams.values()].some(value => !/^\d{1,9}$/.test(value))) throw new NativeProxyError(400, "RunningHub 历史参数无效。");
  return path;
}
function redact(value: string, key: string, target: URL, error = false): string {
  let safe = value.split(target.href).join("[redacted]").split(key).join("[redacted]");
  if (error) safe = safe.replace(/(?:https?|wss?):\/\/[^\s<>"'\\]+/gi, "[redacted]");
  return safe;
}
/** Retain potential partial matches so a credential split across chunks cannot leak. */
function redactor(key: string, target: URL) {
  const needles = [target.href, key].sort((a, b) => b.length - a.length), retained = Math.max(...needles.map(value => value.length)) - 1;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const consume = (final: boolean) => {
    const boundary = final ? pending.length : Math.max(0, pending.length - retained);
    let cursor = 0, output = "";
    while (cursor < boundary) {
      let index = -1, matched = "";
      for (const needle of needles) {
        const found = pending.indexOf(needle, cursor);
        if (found >= 0 && (index < 0 || found < index)) { index = found; matched = needle; }
      }
      if (index < 0 || index >= boundary) { output += pending.slice(cursor, boundary); cursor = boundary; break; }
      output += pending.slice(cursor, index) + "[redacted]"; cursor = index + matched.length;
    }
    pending = pending.slice(cursor);
    return output;
  };
  return new Transform({ transform(chunk: Buffer, _encoding, callback) { pending += decoder.write(chunk); callback(null, consume(false)); }, flush(callback) { pending += decoder.end(); callback(null, consume(true)); } });
}
function responseHeaders(result: IncomingMessage, streamingFile: boolean, key: string): Record<string, string> {
  const headers: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  const contentType = result.headers["content-type"];
  // Do not copy arbitrary upstream headers: Location and custom diagnostics can contain the key-bearing URL.
  const mime = typeof contentType === "string" && !contentType.includes(key) ? /^([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+)(?:\s*;|$)/.exec(contentType)?.[1] : undefined;
  headers["Content-Type"] = mime ? mime + (/^(?:application\/json|text\/)/.test(mime) ? "; charset=utf-8" : "") : streamingFile ? "application/octet-stream" : "application/json; charset=utf-8";
  if (streamingFile) {
    const length = result.headers["content-length"], range = result.headers["content-range"];
    if (typeof length === "string" && /^\d+$/.test(length)) headers["Content-Length"] = length;
    if (typeof range === "string" && /^bytes (?:\d+-\d+|\*)\/(?:\d+|\*)$/.test(range)) headers["Content-Range"] = range;
    if (result.headers["accept-ranges"] === "bytes") headers["Accept-Ranges"] = "bytes";
  }
  return headers;
}
function forward(request: IncomingMessage, response: ServerResponse, target: URL, key: string, path: string, options: RunningHubNativeProxyOptions, redirects: string[] = []): Promise<void> {
  return new Promise(resolve => {
    let upstream: ClientRequest | undefined, incoming: IncomingMessage | undefined, finished = false;
    const transforms: Transform[] = [];
    const finish = () => {
      if (finished) return; finished = true;
      request.off("aborted", abort); request.off("error", abort); response.off("close", closed); response.off("finish", finish);
      resolve();
    };
    const destroyUpstream = () => { request.unpipe(upstream); upstream?.destroy(); incoming?.destroy(); for (const transform of transforms) transform.destroy(); };
    const abort = () => { destroyUpstream(); response.destroy(); finish(); };
    const closed = () => { if (!response.writableEnded) destroyUpstream(); finish(); };
    const failed = () => { fail(response, 502, "RunningHub 原生服务暂时无法连接。"); destroyUpstream(); request.resume(); finish(); };
    request.once("aborted", abort); request.once("error", abort); response.once("close", closed); response.once("finish", finish);
    const accountBody = path === "/account" ? Buffer.from(JSON.stringify({ apikey: key }))
      : path.startsWith("/task-outputs/") ? Buffer.from(JSON.stringify({ apiKey: key, taskId: path.slice(14) })) : undefined;
    const headers: Record<string, string> = { accept: "application/json, */*", "accept-encoding": "identity" };
    if (accountBody) { headers["content-type"] = "application/json"; headers["content-length"] = String(accountBody.length); }
    else if (request.method === "POST") {
      const type = request.headers["content-type"], length = request.headers["content-length"];
      if (typeof type === "string") headers["content-type"] = type;
      if (typeof length === "string" && /^\d+$/.test(length)) headers["content-length"] = length;
    }
    if (path === "/view" && typeof request.headers.range === "string" && /^bytes=\d*-\d*$/.test(request.headers.range)) headers.range = request.headers.range;
    try {
      upstream = (options.transport ?? https.request)(target, { method: accountBody ? "POST" : request.method, headers }, result => {
        incoming = result;
        if (finished || response.destroyed) { result.destroy(); return; }
        result.once("error", failed); result.once("aborted", failed);
        const status = result.statusCode ?? 502, error = status >= 300;
        if (path === "/view" && request.method === "GET" && [301, 302, 303, 307, 308].includes(status)) {
          // Native /view returns the signed CDN location. It must never receive
          // the native key, cookies, or the original key-bearing request URL.
          try {
            const destination = new URL(result.headers.location ?? "", target);
            if (redirects.length >= 3 || destination.href === target.href || redirects.includes(destination.href)) throw new Error("Result redirect loop");
            const officialView = destination.origin === "https://www.runninghub.cn" && destination.pathname === "/view"
              && !destination.username && !destination.password && !destination.hash;
            if (officialView) {
              // Native results first redirect to a signed same-site /view URL.
              // Keep its token on this exact endpoint, never in browser/CDN headers.
              queryKeys(destination, ["filename", "subfolder", "type", "preview", "channel", "Rh-Identify", "token"]);
              const checked = new URL(destination);
              checked.searchParams.delete("Rh-Identify"); checked.searchParams.delete("token");
              route(checked, "", "GET");
              result.removeListener("aborted", failed); result.removeListener("error", failed); result.resume();
              void forward(request, response, destination, key, path, options, [...redirects, target.href]).then(finish, failed);
              return;
            }
            let decoded = destination.href;
            for (let i = 0; i < 3; i++) { try { decoded = decodeURIComponent(decoded); } catch { break; } }
            if (!isTrustedRunningHubResultHostname(destination.hostname) || decoded.includes(key)) throw new Error("Invalid result redirect");
            result.removeListener("aborted", failed); result.removeListener("error", failed); result.resume();
            void streamRunningHubResult(request, response, destination.href, options).then(finish, failed);
          } catch { failed(); }
          return;
        }
        const streamingFile = path === "/view" && !error && !/^(?:application\/(?:[\w.+-]*\+)?json|text\/)/i.test(result.headers["content-type"] ?? "");
        let source: NodeJS.ReadableStream = result;
        const encoding = result.headers["content-encoding"];
        if (encoding && encoding !== "identity") {
          const decoder = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : undefined;
          if (!decoder) { failed(); return; }
          transforms.push(decoder); decoder.once("error", failed); source = source.pipe(decoder);
        }
        const outputHeaders = responseHeaders(result, streamingFile && (!encoding || encoding === "identity"), key);
        if (error) {
          const chunks: Buffer[] = []; let received = 0;
          source.on("data", (chunk: Buffer) => { received += chunk.length; if (received > MAX_DIAGNOSTIC_BYTES) { fail(response, status, "RunningHub 原生服务返回的诊断信息过大。"); destroyUpstream(); finish(); } else chunks.push(Buffer.from(chunk)); });
          source.once("end", () => {
            if (finished) return;
            const content = Buffer.concat(chunks).toString("utf8");
            // Redacting string values after parsing preserves node_errors and valid JSON escaping.
            let safe: string;
            try { safe = JSON.stringify(JSON.parse(content), (_name, value: unknown) => typeof value === "string" ? redact(value, key, target, true) : value); }
            catch { safe = JSON.stringify({ error: redact(content, key, target, true) || "RunningHub 原生服务请求失败。" }); }
            response.writeHead(status, { ...outputHeaders, "Content-Type": "application/json; charset=utf-8" }); response.end(redact(safe, key, target));
          });
        } else {
          response.writeHead(status, outputHeaders);
          if (streamingFile) source.pipe(response);
          else { const filtered = redactor(key, target); transforms.push(filtered); filtered.once("error", failed); source.pipe(filtered).pipe(response); }
        }
      });
      upstream.once("error", failed);
      if (request.aborted || response.destroyed) { abort(); return; }
      if (accountBody) { request.resume(); upstream.end(accountBody); }
      else if (request.method === "POST") request.pipe(upstream);
      else { request.resume(); upstream.end(); }
    } catch { failed(); }
  });
}
export function runningHubNativeProxyHandler(options: RunningHubNativeProxyOptions = {}) {
  const local = localPath(options), origins = trustedOrigins(options.trustedOrigins);
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    try {
      const url = requestUrl(request, local);
      if (!url) { next(); return; }
      if (!trustedCanvasRequest(request, options.requestOrigins ? trustedOrigins(options.requestOrigins(request)) : origins)) throw new NativeProxyError(403, "RunningHub 原生代理仅允许画布同源访问。");
      const path = route(url, local, request.method ?? "GET"), base = endpoint(request.headers["x-runninghub-native-endpoint"]), key = authorization(request);
      const target = new URL(path === "/account" ? "https://www.runninghub.cn/uc/openapi/accountStatus"
        : path.startsWith("/task-outputs/") ? "https://www.runninghub.cn/task/openapi/outputs"
        : base + "/" + encodeURIComponent(key) + path + url.search);
      await forward(request, response, target, key, path, options);
    } catch (error) { fail(response, error instanceof NativeProxyError ? error.status : 502, error instanceof NativeProxyError ? error.message : "RunningHub 原生服务请求失败。", error instanceof NativeProxyError ? error.allow : undefined); request.resume(); }
  };
}
function dataBuffer(data: SocketData): Buffer { return typeof data === "string" ? Buffer.from(data) : Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data); }
/** No authentication or upstream URL is placed in a browser URL, protocol or close reason. */
export function attachRunningHubNativeWebSocket(server: EventEmitter, options: RunningHubNativeProxyOptions = {}): () => void {
  const local = localPath(options), origins = trustedOrigins(options.trustedOrigins);
  const wss = new ws.WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_SOCKET_BYTES });
  const sessions = new Set<() => void>();
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL | undefined;
    try {
      url = requestUrl(request, local);
      if (!url) return;
      if (url.pathname !== local + "/ws" || request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket") throw new NativeProxyError(400, "invalid");
      const allowed = options.requestOrigins ? trustedOrigins(options.requestOrigins(request)) : origins;
      if (typeof request.headers.origin !== "string" || !trustedCanvasRequest(request, allowed)) throw new NativeProxyError(403, "invalid");
      queryKeys(url, ["clientId"]);
      if (!/^[A-Za-z0-9._~-]{1,128}$/.test(url.searchParams.get("clientId") ?? "")) throw new NativeProxyError(400, "invalid");
    } catch (error) { socket.end(`HTTP/1.1 ${error instanceof NativeProxyError && error.status === 403 ? "403 Forbidden" : "400 Bad Request"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    const clientId = url.searchParams.get("clientId")!;
    wss.handleUpgrade(request, socket, head, client => {
      let state: "authenticate" | "connecting" | "ready" | "closed" = "authenticate", upstream: NativeProxySocket | undefined, key = "", target: URL | undefined;
      const cleanup = () => {
        state = "closed"; sessions.delete(cleanup);
        if (upstream && upstream.readyState !== 3) upstream.terminate();
        if (client.readyState !== 3) client.terminate();
      };
      const failed = () => {
        if (state === "closed") return;
        state = "closed"; upstream?.terminate();
        if (client.readyState !== 1) { cleanup(); return; }
        try { client.send(JSON.stringify({ type: "rh_native_error", message: "RunningHub 原生连接失败，请检查接口与 API Key。" }), { binary: false }, cleanup); }
        catch { cleanup(); }
      };
      sessions.add(cleanup);
      const relay = (from: NativeProxySocket, to: NativeProxySocket, data: SocketData, binary: boolean, sanitize: boolean) => {
        if (state !== "ready" || to.readyState !== 1) { failed(); return; }
        const output = !binary && sanitize ? redact(dataBuffer(data).toString("utf8"), key, target!, true) : data;
        if (to.bufferedAmount + dataBuffer(output).length > MAX_SOCKET_BYTES) { failed(); return; }
        from.pause();
        try { to.send(output, { binary }, error => { if (error) failed(); else if (state === "ready") from.resume(); }); }
        catch { failed(); }
      };
      client.on("error", cleanup); client.on("close", cleanup);
      client.on("message", (data: SocketData, binary: boolean) => {
        if (state === "closed") return;
        if (state === "ready") { relay(client, upstream!, data, binary, false); return; }
        if (state !== "authenticate" || binary || dataBuffer(data).length > 8192) { failed(); return; }
        try {
          const auth = JSON.parse(dataBuffer(data).toString("utf8")) as Record<string, unknown>;
          if (!auth || auth.type !== "authenticate" || Object.keys(auth).some(name => !["type", "endpoint", "token"].includes(name))) throw new Error("invalid");
          key = token(auth.token); const base = endpoint(auth.endpoint);
          target = new URL(base.replace("https:", "wss:") + "/" + encodeURIComponent(key) + "/ws"); target.searchParams.set("clientId", clientId);
          state = "connecting";
          upstream = options.createWebSocket ? options.createWebSocket(target) : new ws.WebSocket(target, { followRedirects: false, perMessageDeflate: false, maxPayload: MAX_SOCKET_BYTES });
          upstream.on("error", failed); upstream.on("close", failed);
          upstream.on("unexpected-response", (_request: unknown, result: IncomingMessage) => { result.destroy(); failed(); });
          upstream.on("open", () => {
            if (state !== "connecting" || client.readyState !== 1) { cleanup(); return; }
            state = "ready";
            try { client.send(JSON.stringify({ type: "rh_native_ready" }), { binary: false }, error => { if (error) failed(); }); }
            catch { failed(); }
          });
          upstream.on("message", (value: SocketData, isBinary: boolean) => { if (state !== "closed") relay(upstream!, client, value, isBinary, true); });
        } catch { failed(); }
      });
    });
  };
  server.on("upgrade", upgrade);
  const dispose = () => { server.off("upgrade", upgrade); server.off("close", dispose); for (const close of [...sessions]) close(); wss.close(); };
  server.once("close", dispose);
  return dispose;
}
export function runningHubNativeProxyPlugin(options: RunningHubNativeProxyOptions = {}): Plugin {
  return {
    name: "canvas-runninghub-native-proxy",
    configureServer(server) {
      const configured = { ...options, basePath: options.basePath ?? server.config.base }, handle = runningHubNativeProxyHandler(configured);
      server.middlewares.use((request, response, next) => { void handle(request, response, next).catch(next); });
      if (server.httpServer) attachRunningHubNativeWebSocket(server.httpServer, configured);
    },
    configurePreviewServer(server) {
      const configured = { ...options, basePath: options.basePath ?? server.config.base }, handle = runningHubNativeProxyHandler(configured);
      server.middlewares.use((request, response, next) => { void handle(request, response, next).catch(next); });
      attachRunningHubNativeWebSocket(server.httpServer, configured);
    },
  };
}
