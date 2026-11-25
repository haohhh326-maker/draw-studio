import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type { AutoDLAcquireRequest, AutoDLSettingsInput } from "../src/autodl/types";
import { AutoDLPowerError, createAutoDLPowerService, type AutoDLPowerService, type AutoDLPowerServiceOptions } from "./autodl-power-service";
import { trustedCanvasRequest } from "./workflow-library-plugin";
import { AUTODL_EXTENSION_ORIGIN, isAutoDLBridgeRequest } from "./autodl-extension-broker";
export { isAutoDLBridgeRequest } from "./autodl-extension-broker";

const prefix = "/__canvas/autodl/";
const fields: Record<string, string[]> = {
  status: [], settings: ["enabled", "endpoint", "instanceUuid", "apiToken"], check: [],
  acquire: ["endpoint", "instanceUuid", "taskId", "attemptId"], heartbeat: ["leaseId"], release: ["leaseId", "endpoint", "instanceUuid", "taskId", "attemptId"], "retry-shutdown": [],
  session: [], instances: [], "open-account": [], "pair-code": [], "bridge/pair": ["code"], "bridge/verify": ["bridgeKey"],
  "bridge/disconnect": ["bridgeKey"], "bridge/poll": ["bridgeKey"], "bridge/result": ["bridgeKey", "id", "ok", "value", "errorCode", "remoteCode", "httpStatus", "requestId"],
};
export type AutoDLPowerHandlerOptions = AutoDLPowerServiceOptions & { service?: AutoDLPowerService };
function respond(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new AutoDLPowerError("AutoDL 请求只接受 JSON。", 415);
  const length = request.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > 1024 * 1024)) throw new AutoDLPowerError("AutoDL 请求过大。", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new AutoDLPowerError("AutoDL 请求过大。", 413);
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AutoDLPowerError("AutoDL 请求不是有效 JSON。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AutoDLPowerError("AutoDL 请求格式无效。");
  return value as Record<string, unknown>;
}
export function autoDLPowerHandler(root: string, options: AutoDLPowerHandlerOptions = {}) {
  const service = options.service ?? createAutoDLPowerService(root, options);
  const handler = async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const raw = request.url ?? "/";
    const url = new URL(raw, "http://localhost");
    if (!url.pathname.startsWith(prefix)) { next(); return; }
    const local = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(request.headers.host ?? "") &&
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
    const route = url.pathname.slice(prefix.length);
    if (service.usesIndependentBrowser && (route === "pair-code" || route.startsWith("bridge/"))) {
      respond(response, 404, { error: "请使用画布的「连接 AutoDL」打开独立官网窗口。" }); return;
    }
    if (route.startsWith("bridge/")) {
      if (!isAutoDLBridgeRequest(request)) { respond(response, 403, { error: "仅已授权的本机 AutoDL 浏览器扩展可以访问桥接口。" }); return; }
      response.setHeader("Access-Control-Allow-Origin", AUTODL_EXTENSION_ORIGIN); response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS"); response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
    } else if (!local || !trustedCanvasRequest(request)) { respond(response, 403, { error: "AutoDL 接口只允许本机画布同源访问。" }); return; }
    if (!Object.hasOwn(fields, route)) { respond(response, 404, { error: "AutoDL 接口不存在。" }); return; }
    const method = ["status", "session", "instances"].includes(route) ? "GET" : "POST";
    if (request.method !== method || url.search || !raw.startsWith("/") || raw.startsWith("//") || /[\x00-\x1f\x7f]/.test(raw)) {
      response.setHeader("Allow", method); respond(response, 405, { error: "AutoDL 仅支持固定接口与请求方式。" }); return;
    }
    const abort = new AbortController();
    const abandoned = () => { if (!response.writableEnded) abort.abort(); };
    if (route === "bridge/poll") { request.once("aborted", abandoned); response.once("close", abandoned); }
    try {
      const data = method === "POST" ? await body(request) : {};
      if (Object.keys(data).some(key => !fields[route].includes(key))) throw new AutoDLPowerError("AutoDL 请求包含未知字段。");
      let result: unknown;
      switch (route) {
        case "status": result = await service.status(); break;
        case "session": result = await service.session(); break;
        case "instances": result = await service.instances(); break;
        case "open-account": result = await service.openAccount(); break;
        case "pair-code": result = await service.pairCode(); break;
        case "bridge/pair": result = await service.bridgePair(data); break;
        case "bridge/verify": result = await service.bridgeVerify(data); break;
        case "bridge/disconnect": result = await service.bridgeDisconnect(data); break;
        case "bridge/poll": result = await service.bridgePoll(data, abort.signal); break;
        case "bridge/result": result = await service.bridgeResult(data); break;
        case "settings": result = await service.saveSettings(data as AutoDLSettingsInput); break;
        case "check": result = await service.check(); break;
        case "acquire": result = await service.acquire(data as AutoDLAcquireRequest); break;
        case "heartbeat": result = await service.heartbeat(data.leaseId as string); break;
        case "release":
          if ("leaseId" in data) {
            if (Object.keys(data).length !== 1) throw new AutoDLPowerError("AutoDL 清理请求不能混合租约 ID 和任务标识。");
            result = await service.release(data.leaseId as string);
          } else result = await service.release(data as AutoDLAcquireRequest);
          break;
        case "retry-shutdown": result = await service.retryShutdown(); break;
      }
      respond(response, 200, result);
    } catch (reason) {
      if (!request.readableEnded && !request.destroyed) request.resume();
      const error = service.safeError(reason);
      respond(response, error.status, { error: error.message });
    } finally { request.off("aborted", abandoned); response.off("close", abandoned); }
  };
  return Object.assign(handler, { start: () => service.start(), close: () => service.close(), dispose: () => service.close() });
}
export function autoDLPowerPlugin(root: string, options: AutoDLPowerHandlerOptions = {}): Plugin {
  const handler = autoDLPowerHandler(root, options);
  const stopped = () => { void handler.close().catch(() => {}); };
  return { name: "canvas-local-autodl-power",
    configureServer(server) {
      server.middlewares.use((request, response, next) => { void handler(request, response, next).catch(next); });
      void handler.start().catch(() => {});
      server.httpServer?.once("close", stopped);
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => { void handler(request, response, next).catch(next); });
      void handler.start().catch(() => {});
      server.httpServer.once("close", stopped);
    },
  };
}
