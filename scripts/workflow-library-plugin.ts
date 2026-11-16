import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { readWorkflowLibrary } from "./workflow-library-reader";
import { deleteWorkflowLibraryFolder } from "./workflow-library-delete";
import { writeWorkflowLibraryImport, resolveWorkflowLibraryImport, readWorkflowLibraryImportSource, WorkflowImportError, type WorkflowImportRequest } from "./workflow-library-writer";

const ENDPOINT = "/__canvas/workflow-library";
const IMPORT_ENDPOINT = ENDPOINT + "/import";
const RESOLVE_ENDPOINT = ENDPOINT + "/resolve";
const DELETE_ENDPOINT = ENDPOINT + "/delete";
const SOURCE_ENDPOINT = ENDPOINT + "/source";
const MAX_IMPORT_BODY = 64 * 1024 * 1024;
export type WorkflowLibraryOptions = { trustedOrigins?: string[]; sourcePath?: string; basePath?: string };
export function trustedOrigins(values: string[] = []): string[] {
  return [...new Set(values.map(value => {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/" || parsed.origin !== value)
      throw new Error("可信来源必须为精确的 HTTP/HTTPS origin，不能包含路径或凭据。");
    return value;
  }))];
}
/** Public origins are opt-in; the desktop default remains loopback only. */
export function trustedCanvasRequest(request: IncomingMessage, origins: string[] = []): boolean {
  const host = request.headers.host ?? "";
  const local = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host);
  const localRemote = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
  const origin = request.headers.origin;
  if (local && localRemote) return origin === undefined || origin === "http://" + host || origins.includes(origin);
  // Some TLS gateways omit the public port when forwarding Host. Only the
  // literal hostname without a port may match; an explicitly different port
  // remains invalid, and a supplied Origin must still match the full origin.
  const bareHost = !host.includes(":") || /^\[[a-f0-9:.]+\]$/i.test(host);
  const matching = origins.filter(value => {
    const configured = new URL(value);
    return configured.host === host || (bareHost && configured.hostname === host);
  });
  if (!matching.length) return false;
  return origin === undefined ? ["GET", "HEAD"].includes(request.method ?? "GET") : matching.includes(origin);
}

async function configuredRoot(projectRoot: string) {
  const settings = JSON.parse(await readFile(path.join(projectRoot,"workflow-library.settings.json"),"utf8")) as {sourcePath?:unknown};
  if (typeof settings.sourcePath !== "string" || !settings.sourcePath.trim()) throw new Error("本地工作流库路径未配置。");
  return settings.sourcePath;
}
async function importBody(request: IncomingMessage): Promise<WorkflowImportRequest> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new WorkflowImportError("导入仅接受 application/json。", 415);
  const length = request.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_IMPORT_BODY)) throw new WorkflowImportError("工作流导入请求超过 64 MB。", 413);
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const cleanup = () => { request.off("data", data); request.off("end", end); request.off("error", failed); request.off("aborted", aborted); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const aborted = () => failed(new WorkflowImportError("工作流上传已中断。"));
    const data = (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_IMPORT_BODY) { cleanup(); request.resume(); reject(new WorkflowImportError("工作流导入请求超过 64 MB。", 413)); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    request.on("data", data); request.once("end", end); request.once("error", failed); request.once("aborted", aborted);
  });
  try { return JSON.parse(body.toString("utf8").replace(/^\uFEFF/, "")) as WorkflowImportRequest; }
  catch { throw new WorkflowImportError("导入内容不是有效 JSON。"); }
}

export function workflowLibraryHandler(projectRoot: string, options: WorkflowLibraryOptions = {}) {
  const origins = trustedOrigins(options.trustedOrigins);
  const prefix = options.basePath?.replace(/\/$/, "") ?? "";
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const url = new URL(request.url ?? "/","http://localhost");
    if (![prefix + ENDPOINT, prefix + IMPORT_ENDPOINT, prefix + RESOLVE_ENDPOINT, prefix + DELETE_ENDPOINT, prefix + SOURCE_ENDPOINT].includes(url.pathname)) { next(); return; }
    response.setHeader("Content-Type","application/json; charset=utf-8");
    response.setHeader("Cache-Control","no-store");
    response.setHeader("X-Content-Type-Options","nosniff");
    if (!trustedCanvasRequest(request, origins)) {
      response.statusCode = 403; response.end(JSON.stringify({error:"本地工作流库仅允许本机同源访问。"})); return;
    }
    const importing = url.pathname === prefix + IMPORT_ENDPOINT;
    const resolving = url.pathname === prefix + RESOLVE_ENDPOINT;
    const deleting = url.pathname === prefix + DELETE_ENDPOINT;
    const readingSource = url.pathname === prefix + SOURCE_ENDPOINT;
    const method = importing || resolving || deleting || readingSource ? "POST" : "GET";
    if (request.method !== method || url.search) {
      response.statusCode = 405; response.setHeader("Allow",method); response.end(JSON.stringify({error: method === "POST" ? "只支持固定目录的 POST 操作。" : "只支持固定目录的 GET 读取。"})); return;
    }
    try {
      const root = options.sourcePath ?? await configuredRoot(projectRoot);
      if (readingSource) {
        const body: unknown = await importBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "workflowId") || typeof (body as Record<string, unknown>).workflowId !== "string")
          throw new WorkflowImportError("来源读取只接受工作流 ID。");
        response.end(JSON.stringify(await readWorkflowLibraryImportSource(root, (body as { workflowId: string }).workflowId)));
      } else response.end(JSON.stringify(importing ? await writeWorkflowLibraryImport(root, await importBody(request)) : resolving ? await resolveWorkflowLibraryImport(root, await importBody(request)) : deleting ? await deleteWorkflowLibraryFolder(root, await importBody(request)) : await readWorkflowLibrary(root)));
    } catch (error) {
      response.statusCode = error instanceof WorkflowImportError ? error.status : 500;
      if (response.statusCode === 413) response.setHeader("Connection", "close");
      response.end(JSON.stringify({error:error instanceof Error ? error.message : "工作流库访问失败。",...(error instanceof WorkflowImportError && error.existing ? {existing:error.existing} : {})}));
      request.resume();
    }
  };
}
export function workflowLibraryPlugin(projectRoot: string, options: WorkflowLibraryOptions = {}): Plugin {
  const handle = workflowLibraryHandler(projectRoot, options);
  return {
    name:"canvas-local-workflow-library",
    configureServer(server) { server.middlewares.use((request,response,next) => { void handle(request,response,next).catch(next); }); },
    configurePreviewServer(server) { server.middlewares.use((request,response,next) => { void handle(request,response,next).catch(next); }); },
  };
}
