import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { trustedCanvasRequest } from "./workflow-library-plugin";
import { createOptimizationService, OptimizationError } from "./prompt-optimization-service";
import { DeepSeekBrowserError, getDeepSeekBrowserService } from "./deepseek-browser-service";
import type { OptimizationTarget } from "../src/prompt-optimization/types";

const PREFIX = "/__canvas/prompt-optimization/";
function trustedOptimizationRequest(request: IncomingMessage) {
  if (trustedCanvasRequest(request)) return true;
  const host = request.headers.host ?? "";
  const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host);
  const localRemote = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
  return localHost && localRemote && ["tauri://localhost", "http://tauri.localhost"].includes(request.headers.origin ?? "");
}
async function body(request: IncomingMessage) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new OptimizationError("AI 优化请求只接受 JSON。", 415);
  if (Number(request.headers["content-length"] ?? 0) > 30 * 1024 * 1024) throw new OptimizationError("请求超过 30 MiB。", 413);
  const buffers: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 30 * 1024 * 1024) throw new OptimizationError("请求超过 30 MiB。", 413);
    buffers.push(Buffer.from(chunk));
  }
  try { const data = JSON.parse(Buffer.concat(buffers).toString("utf8")); if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(); return data; }
  catch { throw new OptimizationError("请求不是有效 JSON。"); }
}
export function promptOptimizationHandler(projectRoot: string) {
  const service = createOptimizationService(projectRoot);
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(PREFIX)) { next(); return; }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!trustedOptimizationRequest(request)) { response.statusCode = 403; response.end(JSON.stringify({ error: "AI 优化接口只允许本机画布访问。" })); return; }
    if (["tauri://localhost", "http://tauri.localhost"].includes(request.headers.origin ?? "")) {
      response.setHeader("Access-Control-Allow-Origin", request.headers.origin!);
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
    const route = url.pathname.slice(PREFIX.length);
    const allowed = ["models", "settings"].includes(route) ? ["GET", "POST"] : ["skills", "optimize"].includes(route) ? ["POST"] : [];
    if (!allowed.includes(request.method ?? "") || url.search) {
      response.statusCode = allowed.length ? 405 : 404; response.setHeader("Allow", allowed.join(", "));
      response.end(JSON.stringify({ error: "不支持此 AI 优化请求。" })); return;
    }
    const controller = new AbortController();
    const cancelled = () => { if (!response.writableEnded) controller.abort(); };
    request.once("aborted", cancelled); response.once("close", cancelled);
    try {
      const data = request.method === "POST" ? await body(request) : {};
      if (route === "optimize" && data.engine !== undefined && data.engine !== "deepseek-web")
        throw new OptimizationError("不支持此提示词优化引擎。", 400);
      const result = route === "settings" ? request.method === "GET" ? await service.getSettings() : await service.saveSettings(data) :
        route === "models" ? await service.models(data.connection, controller.signal) :
        route === "skills" ? await service.skills(data.target as OptimizationTarget | undefined, data.refresh === true) :
        await service.optimize(data.context, data.textOnly === true, controller.signal, data.connection,
          data.engine === "deepseek-web" ? (messages, signal) => getDeepSeekBrowserService(projectRoot).complete(messages, signal) : undefined);
      if (!controller.signal.aborted) response.end(JSON.stringify(result));
    } catch (error) {
      if (!controller.signal.aborted) {
        response.statusCode = error instanceof OptimizationError || error instanceof DeepSeekBrowserError ? error.status : 500;
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "AI 优化失败，原提示词未改动。",
          ...(error instanceof OptimizationError ? { code: error.code, textOnlyAllowed: error.textOnlyAllowed } : {}),
          ...(error instanceof DeepSeekBrowserError ? { code: error.status === 401 ? "DEEPSEEK_LOGIN_REQUIRED" : "DEEPSEEK_WEB_ERROR" } : {}) }));
      }
      request.resume();
    } finally { request.off("aborted", cancelled); response.off("close", cancelled); }
  };
}
/** Local Vite dev/preview backend; intentionally absent from the cloud server. */
export function promptOptimizationPlugin(projectRoot: string): Plugin {
  const handler = promptOptimizationHandler(projectRoot);
  return { name: "canvas-local-prompt-optimization",
    configureServer(server) { server.middlewares.use((req, res, next) => { void handler(req, res, next).catch(next); }); },
    configurePreviewServer(server) { server.middlewares.use((req, res, next) => { void handler(req, res, next).catch(next); }); } };
}
