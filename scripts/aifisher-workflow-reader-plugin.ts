import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { trustedCanvasRequest, trustedOrigins } from "./workflow-library-plugin";
import { AIFisherWorkflowReaderError, readAIFisherWorkflow, type AIFisherWorkflowReaderRequest } from "./aifisher-workflow-reader";

export const AIFISHER_WORKFLOW_READER_ENDPOINT = "/__canvas/workflow-reader";
const MAX_BODY = 96 * 1024 * 1024;
export interface AIFisherWorkflowReaderOptions { trustedOrigins?: string[]; basePath?: string; fetcher?: typeof fetch }

async function readBody(request: IncomingMessage): Promise<AIFisherWorkflowReaderRequest> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new AIFisherWorkflowReaderError("工作流读取仅接受 application/json。", "AIFISHER_READER_CONTENT_TYPE", 415);
  const declared = request.headers["content-length"];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) throw new AIFisherWorkflowReaderError("工作流读取请求超过大小限制。", "AIFISHER_READER_BODY_LIMIT", 413);
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.length;
    if (received > MAX_BODY) throw new AIFisherWorkflowReaderError("工作流读取请求超过大小限制。", "AIFISHER_READER_BODY_LIMIT", 413);
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "")) as AIFisherWorkflowReaderRequest; }
  catch { throw new AIFisherWorkflowReaderError("工作流读取请求不是有效 JSON。", "AIFISHER_READER_JSON"); }
}

export function aifisherWorkflowReaderHandler(projectRoot: string, options: AIFisherWorkflowReaderOptions = {}) {
  const origins = trustedOrigins(options.trustedOrigins);
  const endpoint = (options.basePath?.replace(/\/$/, "") ?? "") + AIFISHER_WORKFLOW_READER_ENDPOINT;
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== endpoint) { next(); return; }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!trustedCanvasRequest(request, origins)) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: "工作流读取仅允许同源画布访问。", code: "AIFISHER_READER_ORIGIN" }));
      return;
    }
    if (request.method !== "POST" || url.search) {
      response.statusCode = 405;
      response.setHeader("Allow", "POST");
      response.end(JSON.stringify({ error: "只支持固定地址的 POST 读取。", code: "AIFISHER_READER_METHOD" }));
      return;
    }
    const controller = new AbortController();
    const disconnected = () => { if (!response.writableEnded) controller.abort(new Error("画布已取消工作流读取。")); };
    request.once("aborted", disconnected); response.once("close", disconnected);
    let input: AIFisherWorkflowReaderRequest | undefined;
    try {
      input = await readBody(request);
      response.end(JSON.stringify(await readAIFisherWorkflow(input, { projectRoot, fetcher: options.fetcher, signal: controller.signal })));
    }
    catch (error) {
      if (response.destroyed) return;
      const known = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string";
      const status = known && "status" in error ? Number(error.status) : 400;
      response.statusCode = status >= 400 && status < 600 ? status : 400;
      let message = known && error instanceof Error ? error.message : "工作流读取失败，请检查来源 JSON。";
      const key = typeof input?.remote?.apiKey === "string" ? input.remote.apiKey.trim() : "";
      if (key) for (const value of new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])) if (value) message = message.split(value).join("[已隐藏密钥]");
      response.end(JSON.stringify({ error: message, code: known ? error.code : "AIFISHER_READER_ERROR" }));
      request.resume();
    }
    finally { request.off("aborted", disconnected); response.off("close", disconnected); }
  };
}

export function aifisherWorkflowReaderPlugin(projectRoot: string, options: AIFisherWorkflowReaderOptions = {}): Plugin {
  const handler = aifisherWorkflowReaderHandler(projectRoot, options);
  return {
    name: "canvas-aifisher-workflow-reader",
    configureServer(server) { server.middlewares.use((request, response, next) => { void handler(request, response, next).catch(next); }); },
    configurePreviewServer(server) { server.middlewares.use((request, response, next) => { void handler(request, response, next).catch(next); }); },
  };
}
