import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { CloudFileTransferError, CloudFileTransferService, safeTransferError, type CloudFileTransferOptions } from "./cloud-file-transfer";
import { trustedCanvasRequest } from "./workflow-library-plugin";
const endpoint = "/__canvas/cloud-files";
const maximumBody = 1536 * 1024;
export type CloudFileTransferHandlerOptions = CloudFileTransferOptions & { service?: CloudFileTransferService; basePath?: string };
export function trustedTransferRequest(request: IncomingMessage) { return /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(request.headers.host ?? "") && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") && trustedCanvasRequest(request); }
function respond(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(body)); }
async function readBody(request: IncomingMessage) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new CloudFileTransferError("文件传输仅接受 JSON 请求。", 415);
  const length = request.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > maximumBody)) throw new CloudFileTransferError("文件传输请求过大。", 413);
  const source = await new Promise<Buffer>((resolve, reject) => {
    let received = 0; const chunks: Buffer[] = [];
    const cleanup = () => { request.off("data", data); request.off("end", end); request.off("error", failed); request.off("aborted", aborted); };
    const failed = () => { cleanup(); reject(new CloudFileTransferError("文件传输请求已中断。", 400, "REQUEST_ABORTED")); };
    const aborted = () => failed();
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const data = (value: Buffer) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); received += chunk.length;
      if (received > maximumBody) { cleanup(); request.once("error", () => undefined); request.resume(); reject(new CloudFileTransferError("文件传输请求过大。", 413)); return; }
      chunks.push(chunk);
    };
    request.on("data", data); request.once("end", end); request.once("error", failed); request.once("aborted", aborted);
  });
  let value: unknown; try { value = JSON.parse(source.toString("utf8")); } catch { throw new CloudFileTransferError("文件传输请求不是有效 JSON。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CloudFileTransferError("文件传输请求格式无效。"); return value as Record<string, unknown>;
}
const fields: Record<string, string[]> = { "/status": [], "/local": ["bucket", "path"], "/connect": ["host", "port", "username", "password", "privateKey", "passphrase", "hostKey", "rememberPassword", "useSavedPassword"], "/password-status": ["host", "port", "username"], "/forget-password": ["host", "port", "username"], "/remote": ["sessionId", "path"], "/upload": ["sessionId", "bucket", "paths", "remotePath"], "/jobs": ["sessionId"], "/cancel": ["sessionId", "jobId"], "/disconnect": ["sessionId"] };
export function cloudFileTransferHandler(options: CloudFileTransferHandlerOptions = {}) {
  const service = options.service ?? new CloudFileTransferService(options), prefix = options.basePath?.replace(/\/$/, "") ?? "";
  const handle = async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const url = new URL(request.url ?? "/", "http://localhost"), base = prefix + endpoint;
    if (url.pathname !== base && !url.pathname.startsWith(base + "/")) { next(); return; }
    if (!trustedTransferRequest(request)) { respond(response, 403, { error: "云端文件传输仅允许本机画布同源访问。", code: "LOCAL_ONLY" }); return; }
    const route = url.pathname.slice(base.length);
    if (route !== "/drop-upload" && !Object.hasOwn(fields, route)) { respond(response, 404, { error: "文件传输接口不存在。" }); return; }
    if (url.search || /[\x00-\x1f\x7f]/.test(request.url ?? "") || request.method !== (route === "/status" ? "GET" : "POST")) { respond(response, 405, { error: "文件传输仅支持固定接口与请求方式。" }); return; }
    try {
      if (route === "/status") { respond(response, 200, await service.status()); return; }
      if (route === "/drop-upload") {
        if (request.headers["content-type"] !== "application/octet-stream") throw new CloudFileTransferError("拖入文件仅接受二进制流。", 415);
        const encoded = request.headers["x-canvas-drop-file"];
        if (typeof encoded !== "string" || encoded.length > 16_384) throw new CloudFileTransferError("拖入文件的信息无效。");
        let value: unknown;
        try { value = JSON.parse(decodeURIComponent(encoded)); } catch { throw new CloudFileTransferError("拖入文件的信息无法解析。"); }
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["sessionId", "remotePath", "name", "size"].includes(key))) throw new CloudFileTransferError("拖入文件的信息格式无效。");
        const controller = new AbortController(), abandoned = () => controller.abort();
        request.once("aborted", abandoned);
        try {
          if (request.aborted) abandoned();
          const result = await service.droppedUpload(value as Parameters<CloudFileTransferService["droppedUpload"]>[0], request, controller.signal);
          if (!response.destroyed) respond(response, 200, result);
        } finally { request.off("aborted", abandoned); }
        return;
      }
      const body = await readBody(request); if (Object.keys(body).some(key => !fields[route].includes(key))) throw new CloudFileTransferError("文件传输请求包含未知字段。");
      let result: unknown;
      switch (route) {
        case "/local": result = await service.local(body as Parameters<CloudFileTransferService["local"]>[0]); break;
        case "/password-status": result = await service.passwordStatus(body); break;
        case "/forget-password": result = await service.forgetPassword(body); break;
        case "/connect": {
          const controller = new AbortController(); let sessionId: string | undefined;
          const abandoned = () => {
            if (response.writableEnded) return;
            controller.abort();
            if (sessionId) void service.disconnect({ sessionId }).catch(() => undefined);
          };
          response.once("close", abandoned); request.once("aborted", abandoned);
          try {
            const connected = await service.connect(body, { signal: controller.signal }); sessionId = connected.sessionId;
            if (request.aborted || response.destroyed) { abandoned(); await service.disconnect({ sessionId }).catch(() => undefined); return; }
            respond(response, 200, connected); return;
          } finally { request.off("aborted", abandoned); if (response.writableEnded || response.destroyed) response.off("close", abandoned); }
        }
        case "/remote": result = await service.remote(body as Parameters<CloudFileTransferService["remote"]>[0]); break;
        case "/upload": result = await service.upload(body as Parameters<CloudFileTransferService["upload"]>[0]); break;
        case "/jobs": result = await service.jobs(body as Parameters<CloudFileTransferService["jobs"]>[0]); break;
        case "/cancel": result = await service.cancel(body as Parameters<CloudFileTransferService["cancel"]>[0]); break;
        case "/disconnect": result = await service.disconnect(body as Parameters<CloudFileTransferService["disconnect"]>[0]); break;
      }
      if (!response.destroyed) respond(response, 200, result);
    } catch (reason) { if (!request.readableEnded && !request.destroyed) request.resume(); const error = safeTransferError(reason); if (!response.headersSent && !response.destroyed) respond(response, error.status, { error: error.message, code: error.code, ...(error.causeCode ? { causeCode: error.causeCode } : {}), ...(error.hostKey ? { hostKey: error.hostKey, fingerprint: error.fingerprint } : {}) }); }
  };
  return Object.assign(handle, { close: () => service.close() });
}
export function cloudFileTransferPlugin(_projectRoot?: string, options: CloudFileTransferHandlerOptions = {}): Plugin {
  const handle = cloudFileTransferHandler(options);
  return {
    name: "canvas-local-cloud-file-transfer",
    configureServer(server) {
      // Large model files must not inherit Node's fixed request-body deadline.
      if (server.httpServer && "requestTimeout" in server.httpServer) server.httpServer.requestTimeout = 0;
      server.middlewares.use((request, response, next) => { void handle(request, response, next).catch(next); });
      server.httpServer?.once("close", () => { void handle.close(); });
    },
    configurePreviewServer(server) {
      if ("requestTimeout" in server.httpServer) server.httpServer.requestTimeout = 0;
      server.middlewares.use((request, response, next) => { void handle(request, response, next).catch(next); });
      server.httpServer.once("close", () => { void handle.close(); });
    },
  };
}
