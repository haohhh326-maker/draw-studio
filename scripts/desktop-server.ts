import { createReadStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Plugin, PreviewServer, PreviewServerHook } from "vite";
import { aifisherWorkflowReaderPlugin } from "./aifisher-workflow-reader-plugin";
import { cloudFileTransferPlugin } from "./cloud-file-transfer-plugin";
import { deepSeekBridgePlugin } from "./deepseek-bridge-plugin";
import { autoDLPowerPlugin } from "./autodl-power-plugin";
import { museBridgePlugin } from "./muse-bridge-plugin";
import { promptOptimizationPlugin } from "./prompt-optimization-plugin";
import { runningHubNativeProxyPlugin } from "./runninghub-native-proxy-plugin";
import { runningHubProxyPlugin } from "./runninghub-proxy-plugin";
import { videoPlaybackPlugin } from "./video-playback-plugin";
import { trustedCanvasRequest, workflowLibraryPlugin } from "./workflow-library-plugin";

type Middleware = (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void;
export interface DesktopServerOptions {
  /** Writable workspace containing local settings, workflow folders and caches. */
  rootDir: string;
  /** Read-only built frontend, outside the writable workspace. */
  distDir: string;
  port?: number;
  instanceId: string;
}

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".zip": "application/zip",
};
function respond(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}
function contained(root: string, filename: string) {
  const relative = path.relative(root, filename);
  return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep);
}
function byteRange(value: string, length: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !length || !match[1] && !match[2]) return;
  const first = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]));
  const last = match[1] && match[2] ? Math.min(Number(match[2]), length - 1) : length - 1;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || first > last || first >= length) return;
  return { first, last };
}
function staticFiles(distDir: string): Middleware {
  return (request, response, next) => { void (async () => {
    const rawPath = (request.url ?? "/").split("?")[0];
    let pathname: string;
    try { pathname = decodeURIComponent(rawPath); }
    catch { respond(response, 400, { error: "页面资源地址无效。" }); return; }
    if (!pathname.startsWith("/") || pathname.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(pathname)) {
      respond(response, 400, { error: "页面资源地址无效。" }); return;
    }
    if (pathname.startsWith("/__canvas/") || pathname.startsWith("/api/")) { next(); return; }
    if (!["GET", "HEAD"].includes(request.method ?? "")) {
      response.setHeader("Allow", "GET, HEAD"); respond(response, 405, { error: "页面资源只支持读取。" }); return;
    }
    let filename = path.resolve(distDir, "." + pathname);
    if (!contained(distDir, filename)) { respond(response, 403, { error: "页面资源地址超出应用目录。" }); return; }
    let details;
    try {
      details = await stat(filename);
      if (details.isDirectory()) { filename = path.join(filename, "index.html"); details = await stat(filename); }
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (path.extname(pathname) || !request.headers.accept?.includes("text/html")) { next(); return; }
      filename = path.join(distDir, "index.html"); details = await stat(filename);
    }
    if (!details.isFile()) { next(); return; }
    filename = await realpath(filename);
    if (!contained(distDir, filename)) { respond(response, 403, { error: "页面资源地址超出应用目录。" }); return; }
    response.setHeader("Content-Type", mimeTypes[path.extname(filename).toLowerCase()] ?? "application/octet-stream");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", pathname.startsWith("/assets/") && /-[\w-]{8,}\.[\w.]+$/.test(pathname) ? "public, max-age=31536000, immutable" : "no-cache");
    let range;
    if (request.headers.range) {
      range = byteRange(request.headers.range, details.size);
      if (!range) { response.statusCode = 416; response.setHeader("Content-Range", `bytes */${details.size}`); response.end(); return; }
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${range.first}-${range.last}/${details.size}`);
    }
    response.setHeader("Content-Length", range ? range.last - range.first + 1 : details.size);
    if (request.method === "HEAD") { response.end(); return; }
    await pipeline(createReadStream(filename, range ? { start: range.first, end: range.last } : undefined), response);
  })().catch(next); };
}

/** Registers the existing local API plugins without loading Vite or its dev server. */
export async function startDesktopServer(options: DesktopServerOptions) {
  // This process reads workflow archives as opaque files. Its code and runtime
  // dependencies are ordinary files outside Electron's application archive.
  if (process.versions.electron) Reflect.set(process, "noAsar", true);
  if (!options.instanceId || !Number.isInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65535)
    throw new Error("桌面本机服务启动配置无效。");
  await mkdir(options.rootDir, { recursive: true });
  const rootDir = await realpath(options.rootDir), distDir = await realpath(options.distDir);
  if (!(await stat(path.join(distDir, "index.html"))).isFile()) throw new Error("桌面应用页面文件不完整。");
  const stack: Middleware[] = [];
  const server = createServer((request, response) => {
    if (!trustedCanvasRequest(request)) { respond(response, 403, { error: "桌面服务只允许本机画布同源访问。" }); return; }
    let index = 0;
    const next = (error?: unknown) => {
      if (error) { respond(response, 500, { error: "本机服务未能完成此操作，请重试。" }); return; }
      const handler = stack[index++];
      if (!handler) { respond(response, 404, { error: "应用资源或接口不存在。" }); return; }
      try { handler(request, response, next); } catch (reason) { next(reason); }
    };
    next();
  });
  // Existing cloud uploads and browser jobs have no local request deadline.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  const sockets = new Set<Socket>();
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    for (const socket of sockets) socket.destroy();
  });
  const middlewares = { use(handler: Middleware) { stack.push(handler); return middlewares; } };
  const context = { config: { base: "/" }, httpServer: server, middlewares, close } as unknown as PreviewServer;
  const plugins: Plugin[] = [museBridgePlugin(rootDir), deepSeekBridgePlugin(rootDir), autoDLPowerPlugin(rootDir, { browserAccount: true }), videoPlaybackPlugin(),
    aifisherWorkflowReaderPlugin(rootDir), workflowLibraryPlugin(rootDir), promptOptimizationPlugin(rootDir),
    runningHubProxyPlugin(), runningHubNativeProxyPlugin(), cloudFileTransferPlugin(rootDir)];
  const afterStatic: (() => void)[] = [];
  try {
    stack.push((request, response, next) => {
      if ((request.url ?? "").split("?")[0] !== "/__canvas/desktop-health") { next(); return; }
      if (!["GET", "HEAD"].includes(request.method ?? "")) {
        response.setHeader("Allow", "GET, HEAD"); respond(response, 405, { error: "健康检查只支持读取。" }); return;
      }
      respond(response, 200, { ok: true, service: "draw-studio-desktop", instanceId: options.instanceId, pid: process.pid });
    });
    for (const plugin of plugins) {
      const hook = plugin.configurePreviewServer;
      if (!hook) continue;
      const handler = typeof hook === "function" ? hook : hook.handler;
      const after = await handler.call({} as ThisParameterType<PreviewServerHook>, context);
      if (after) afterStatic.push(after);
    }
    stack.push(staticFiles(distDir));
    for (const after of afterStatic) after();
    server.on("upgrade", (request, socket) => {
      if ((request.url ?? "").split("?")[0] !== "/api/runninghub-comfy/ws")
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off("listening", ready); reject(error); };
      const ready = () => { server.off("error", failed); resolve(); };
      server.once("error", failed); server.once("listening", ready);
      server.listen(options.port ?? 0, "127.0.0.1");
    });
  } catch (error) {
    if (server.listening) await close();
    else server.emit("close");
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `http://127.0.0.1:${port}/`, close };
}

async function runDesktopServer() {
  const rootDir = process.env.CANVAS_ROOT, distDir = process.env.CANVAS_DIST, instanceId = process.env.CANVAS_INSTANCE_ID;
  if (!rootDir || !distDir || !instanceId) throw new Error("桌面服务缺少运行目录或实例标识。");
  const desktop = await startDesktopServer({ rootDir, distDir, instanceId, port: Number(process.env.CANVAS_PORT ?? 14320) });
  const stop = () => { void desktop.close().then(() => {
    if (process.connected) process.disconnect();
  }).catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); }); };
  process.once("disconnect", stop);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.on("message", message => { if (message && typeof message === "object" && "type" in message && message.type === "draw-studio-server-stop") stop(); });
  if (process.send && !process.connected) { stop(); return; }
  if (process.send) process.send({ type: "draw-studio-server-ready", instanceId, pid: process.pid, url: desktop.url, port: desktop.port });
}

// esbuild emits this entry as CJS for Electron's bundled Node runtime.
if (typeof require !== "undefined" && require.main === module) {
  void runDesktopServer().catch(() => {
    if (process.send) process.send({ type: "draw-studio-server-error", instanceId: process.env.CANVAS_INSTANCE_ID, error: "Draw studio 本机服务未能启动。" });
    process.exitCode = 1;
  });
}
