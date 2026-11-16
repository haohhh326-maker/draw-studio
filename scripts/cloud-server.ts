import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { createReadStream, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { workflowLibraryHandler, trustedOrigins, trustedCanvasRequest } from "./workflow-library-plugin";
import { runningHubProxyHandler } from "./runninghub-proxy-plugin";
import { attachRunningHubNativeWebSocket, runningHubNativeProxyHandler, type RunningHubNativeProxyOptions } from "./runninghub-native-proxy-plugin";

export type CloudCanvasOptions = { rootDir: string; distDir: string; libraryDir: string; basePath?: string; allowedOrigins?: string[]; autodlOrigins?: boolean;
  /** Offline transports for native-proxy integration tests; routing and origin policy remain server-owned. */
  nativeRunningHub?: Pick<RunningHubNativeProxyOptions, "transport" | "createWebSocket">;
};
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".mp4": "video/mp4", ".webm": "video/webm" };
const hops = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
export function canvasBasePath(value = "/") {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(value)) throw new Error("CANVAS_BASE_PATH 必须是 / 或以 / 结尾的普通路径，例如 /canvas/。");
  return value;
}
/** Opt-in image portability: only a local gateway's literal AutoDL Host can add its own HTTPS origins. */
export function canvasRequestOrigins(request: IncomingMessage, configured: string[], autodlOrigins = false): string[] {
  const host = request.headers.host ?? "";
  if (!autodlOrigins || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") ||
      !/^uu?\d+-[a-f0-9]{12}\.[a-z0-9-]+\.seetacloud\.com(?::8443)?$/.test(host)) return configured;
  const sameHost = host.endsWith(":8443") ? ["https://" + host] : ["https://" + host, "https://" + host + ":8443"];
  return [...new Set([...configured, ...sameHost])];
}
function error(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ error: message }));
}
function within(root: string, file: string) { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); }
export function safeComfyPath(value: string, basePath = "/canvas/"): boolean {
  let decoded = value.split("?")[0];
  for (let pass = 0; /%[a-f0-9]{2}/i.test(decoded); pass++) {
    if (pass >= 8) return false;
    try { decoded = decodeURIComponent(decoded); } catch { return false; }
  }
  if (decoded.includes("\0")) return false;
  const normalized = path.posix.normalize(decoded.replaceAll("\\", "/"));
  const prefixes = new Set(["/canvas", basePath.slice(0, -1)].filter(Boolean));
  return ![...prefixes].some(prefix => normalized === prefix || normalized.startsWith(prefix + "/"));
}
function proxyHeaders(headers: http.IncomingHttpHeaders) {
  const blocked = new Set([...hops, ...(headers.connection ?? "").split(",").map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())));
}
/** Fixed localhost target: request paths can never select a different upstream. */
function proxyComfy(request: IncomingMessage, response: ServerResponse, upstreamPath: string) {
  const upstream = http.request({ hostname: "127.0.0.1", port: 6006, method: request.method, path: upstreamPath,
    headers: { ...proxyHeaders(request.headers), host: "127.0.0.1:6006" } }, result => {
    response.writeHead(result.statusCode ?? 502, proxyHeaders(result.headers));
    result.on("error", () => response.destroy()); result.pipe(response);
  });
  upstream.setTimeout(120000, () => upstream.destroy(new Error("ComfyUI proxy timeout")));
  upstream.on("error", () => { if (!response.headersSent) error(response, 502, "无法连接本机 ComfyUI 6006 服务。"); else response.destroy(); });
  request.on("aborted", () => upstream.destroy()); request.on("error", () => upstream.destroy()); response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
  request.pipe(upstream);
}

export function createCanvasServer(options: CloudCanvasOptions) {
  const base = canvasBasePath(options.basePath), prefix = base.slice(0, -1);
  const origins = trustedOrigins(options.allowedOrigins), dist = realpathSync(options.distDir);
  const libraryOptions = { sourcePath: options.libraryDir, basePath: base === "/" ? "" : prefix };
  const library = workflowLibraryHandler(options.rootDir, { ...libraryOptions, trustedOrigins: origins });
  const nativeOptions: RunningHubNativeProxyOptions = { ...options.nativeRunningHub, trustedOrigins: origins, basePath: base,
    requestOrigins: request => canvasRequestOrigins(request, origins, options.autodlOrigins) };
  const nativeRunningHub = runningHubNativeProxyHandler(nativeOptions), nativePath = prefix + "/api/runninghub-comfy";
  const nativeRequestPath = (value: string) => value === nativePath || value.startsWith(nativePath + "/");
  const server = http.createServer((request, response) => {
    void (async () => {
      const requestOrigins = canvasRequestOrigins(request, origins, options.autodlOrigins);
      if (!trustedCanvasRequest(request, requestOrigins)) { error(response, 403, "此画布入口不接受当前来源。"); return; }
      // Let the native handler reject raw traversal before URL normalization can turn it into a static route.
      if (nativeRequestPath((request.url ?? "/").split("?")[0])) { await nativeRunningHub(request, response, () => error(response, 404, "路径不存在。")); return; }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (base !== "/" && (url.pathname === "/" || url.pathname === prefix)) { response.writeHead(302, { Location: base }); response.end(); return; }
      if (!url.pathname.startsWith(base)) { error(response, 404, "路径不存在。"); return; }
      const relative = url.pathname.slice(prefix.length);
      if (nativeRequestPath(url.pathname)) { await nativeRunningHub(request, response, () => error(response, 404, "路径不存在。")); return; }
      if (relative === "/api/runninghub-result" || relative.startsWith("/api/runninghub/")) {
        await runningHubProxyHandler({ trustedOrigins: requestOrigins, basePath: base })(request, response, () => error(response, 404, "路径不存在。")); return;
      }
        if (["/__canvas/workflow-library", "/__canvas/workflow-library/import", "/__canvas/workflow-library/resolve", "/__canvas/workflow-library/delete", "/__canvas/workflow-library/source"].includes(relative)) {
        const handle = requestOrigins === origins ? library : workflowLibraryHandler(options.rootDir, { ...libraryOptions, trustedOrigins: requestOrigins });
        await handle(request, response, () => error(response, 404, "路径不存在。")); return;
      }
      if (relative === "/comfy" || relative.startsWith("/comfy/")) {
        const upstreamPath = (relative.slice(6) || "/") + url.search;
        if (!safeComfyPath(upstreamPath, base)) { error(response, 403, "ComfyUI 代理不能返回画布入口。"); return; }
        proxyComfy(request, response, upstreamPath); return;
      }
      if (!["GET", "HEAD"].includes(request.method ?? "GET")) { error(response, 405, "静态资源只接受 GET/HEAD。"); return; }
      let decoded: string;
      try { decoded = decodeURIComponent(relative); } catch { error(response, 400, "路径编码无效。"); return; }
      if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes("..")) { error(response, 400, "路径无效。"); return; }
      let file = path.resolve(dist, "." + decoded);
      if (!within(dist, file)) { error(response, 403, "路径超出资源目录。"); return; }
      try { if (!(await stat(file)).isFile()) file = path.join(dist, "index.html"); }
      catch { if (path.extname(decoded)) { error(response, 404, "资源不存在。"); return; } file = path.join(dist, "index.html"); }
      file = await realpath(file);
      if (!within(dist, file)) { error(response, 403, "资源链接超出目录。"); return; }
      response.writeHead(200, { "Content-Type": mime[path.extname(file).toLowerCase()] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": path.basename(file) === "index.html" ? "no-cache" : "public, max-age=3600" });
      if (request.method === "HEAD") response.end(); else { const stream = createReadStream(file); stream.on("error", () => response.destroy()); stream.pipe(response); }
    })().catch(() => { if (!response.headersSent) error(response, 500, "画布服务读取失败。"); else response.destroy(); });
  });
  server.on("upgrade", (request, socket, head) => {
    if (nativeRequestPath((request.url ?? "/").split("?")[0])) return;
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://localhost"); }
    catch { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    if (nativeRequestPath(url.pathname)) return;
    const relative = url.pathname.startsWith(base) ? url.pathname.slice(prefix.length) : "";
    const requestOrigins = canvasRequestOrigins(request, origins, options.autodlOrigins);
    if (!trustedCanvasRequest(request, requestOrigins) || request.method !== "GET" || !relative.startsWith("/comfy/") || !safeComfyPath(relative.slice(6) + url.search, base) || request.headers.upgrade?.toLowerCase() !== "websocket") { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    const upstream = net.connect({ host: "127.0.0.1", port: 6006 });
    const close = () => { socket.destroy(); upstream.destroy(); };
    socket.on("error", close); upstream.on("error", () => { socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); upstream.destroy(); });
    socket.on("close", () => upstream.destroy()); upstream.on("close", () => socket.destroy());
    upstream.on("connect", () => {
      const headers = { ...request.headers, host: "127.0.0.1:6006" };
      upstream.write("GET " + relative.slice(6) + url.search + " HTTP/1.1\r\n" + Object.entries(headers).flatMap(([name, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(item => name + ": " + item + "\r\n")).join("") + "\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  attachRunningHubNativeWebSocket(server, nativeOptions);
  return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = path.resolve(process.env.CANVAS_ROOT ?? process.cwd());
  const port = Number(process.env.CANVAS_PORT ?? "6008");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CANVAS_PORT 无效。");
  const server = createCanvasServer({ rootDir: root, distDir: path.resolve(process.env.CANVAS_DIST ?? path.join(root, "dist")), libraryDir: path.resolve(process.env.CANVAS_WORKFLOW_LIBRARY ?? path.join(root, "workflows", "library")), basePath: process.env.CANVAS_BASE_PATH ?? "/", allowedOrigins: (process.env.CANVAS_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean), autodlOrigins: process.env.CANVAS_AUTODL_ORIGINS === "true" });
  server.on("error", error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, process.env.CANVAS_LISTEN ?? "127.0.0.1", () => console.log("Canvas listening on port " + port + " at " + (process.env.CANVAS_BASE_PATH ?? "/")));
}
