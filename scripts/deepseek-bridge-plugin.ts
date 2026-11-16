import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { DeepSeekBrowserError, getDeepSeekBrowserService } from "./deepseek-browser-service";

const PREFIX = "/__canvas/deepseek/";

export function deepSeekRequestAllowed(request: Pick<IncomingMessage, "headers" | "socket">) {
  const host = request.headers.host ?? "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return false;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) return false;
  const origin = request.headers.origin;
  const desktop = origin === "tauri://localhost" || origin === "http://tauri.localhost";
  if (request.headers["sec-fetch-site"] === "cross-site" && !desktop) return false;
  return !origin || origin === `http://${host}` || origin === `https://${host}` || desktop;
}

/** Remote chat pixels and controls require an explicit canvas origin. */
export function deepSeekViewRequestAllowed(request: Pick<IncomingMessage, "headers" | "socket">) {
  return typeof request.headers.origin === "string" && deepSeekRequestAllowed(request);
}

/** Same-origin GET omits Origin in Chromium; require a canvas-only request header instead. */
export function deepSeekSessionExportAllowed(request: Pick<IncomingMessage, "headers" | "socket">) {
  return deepSeekViewRequestAllowed(request) ||
    !request.headers.origin && request.headers["sec-fetch-site"] === "same-origin" &&
    request.headers["x-canvas-session"] === "1" && deepSeekRequestAllowed(request);
}

async function readJson(request: IncomingMessage, maxBytes = Number.POSITIVE_INFINITY) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(String(request.headers["content-type"] ?? "")))
    throw new DeepSeekBrowserError("DeepSeek 请求需要 JSON 数据。", 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new DeepSeekBrowserError("DeepSeek 画布输入过大。", 413);
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new DeepSeekBrowserError("DeepSeek 请求数据无效。"); }
}

function respond(response: ServerResponse, status: number, data: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(data));
}

export function deepSeekBridgePlugin(projectRoot: string): Plugin {
  const service = getDeepSeekBrowserService(projectRoot);
  const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(PREFIX)) return next();
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const route = url.pathname.slice(PREFIX.length);
    if (!(route === "session/export" ? deepSeekSessionExportAllowed(request)
      : route.startsWith("view/") || route === "session/import" ? deepSeekViewRequestAllowed(request) : deepSeekRequestAllowed(request)))
      return respond(response, 403, { error: "DeepSeek 连接只允许本机画布访问。" });
    if (request.headers.origin) {
      response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-DeepSeek-Name, X-Canvas-Session");
    }
    if (url.search) return respond(response, 404, { error: "DeepSeek 接口不存在。" });
    const allowed = route === "session" || route === "session/export" ? ["GET"]
      : ["open", "complete", "session/import", "view/frame", "view/input", "view/upload"].includes(route) ? ["POST"] : [];
    if (request.method === "OPTIONS" && allowed.length) { response.statusCode = 204; response.end(); return; }
    if (!allowed.includes(request.method ?? "")) {
      response.setHeader("Allow", allowed.join(", "));
      return respond(response, allowed.length ? 405 : 404, { error: "不支持此 DeepSeek 请求。" });
    }
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    request.once("aborted", cancel);
    response.once("close", cancel);
    void (async () => {
      if (route === "session/export") {
        const result = await service.exportSession();
        if (!controller.signal.aborted) respond(response, 200, result);
        return;
      }
      if (route === "session/import") {
        const result = await service.importSession(await readJson(request, 1024 * 1024));
        if (!controller.signal.aborted) respond(response, 200, result);
        return;
      }
      if (route === "view/frame") {
        const body = await readJson(request, 1024);
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new DeepSeekBrowserError("DeepSeek 画面请求无效。");
        const image = await service.viewFrame(body);
        if (!controller.signal.aborted) {
          response.statusCode = 200;
          response.setHeader("Content-Type", "image/jpeg");
          response.setHeader("Content-Length", image.length);
          response.end(image);
        }
        return;
      }
      if (route === "view/input") {
        await service.viewInput(await readJson(request, 256 * 1024));
        if (!controller.signal.aborted) respond(response, 200, { ok: true });
        return;
      }
      if (route === "view/upload") {
        const encoded = request.headers["x-deepseek-name"];
        if (typeof encoded !== "string") throw new DeepSeekBrowserError("DeepSeek 附件文件名无效。");
        let name: string;
        try { name = decodeURIComponent(encoded); }
        catch { throw new DeepSeekBrowserError("DeepSeek 附件文件名无效。"); }
        await service.viewUpload(name, String(request.headers["content-type"] ?? ""), request);
        if (!controller.signal.aborted) respond(response, 200, { ok: true });
        return;
      }
      const result = route === "session" ? await service.session()
        : route === "open" ? (await readJson(request), await service.open())
        : await (async () => {
          const body = await readJson(request);
          // The new request keeps rule files out of the visible chat bubble.
          // Accept the legacy messages shape while older canvas builds reload.
          return service.complete(body.request ?? (typeof body.prompt === "string" ? body : body.messages), controller.signal);
        })();
      if (!controller.signal.aborted) respond(response, 200, result);
    })().catch(error => {
      if (!controller.signal.aborted && !response.headersSent) {
        respond(response, error instanceof DeepSeekBrowserError ? error.status : 500,
          { error: error instanceof Error ? error.message : "DeepSeek 提示词优化失败，原提示词未改动。" });
      }
    }).finally(() => {
      request.off("aborted", cancel);
      response.off("close", cancel);
    });
  };
  return {
    name: "canvas-local-deepseek-web",
    configureServer(server) { server.middlewares.use(middleware); server.httpServer?.on("close", () => { void service.close(); }); },
    configurePreviewServer(server) { server.middlewares.use(middleware); server.httpServer?.on("close", () => { void service.close(); }); },
  };
}
