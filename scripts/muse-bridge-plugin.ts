import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MuseBrowserService, MuseBridgeError } from "./muse-browser-service";
import { MuseReferenceStoreError } from "./muse-reference-store";

export function museRequestAllowed(req: Pick<IncomingMessage, "headers">) {
  const host = req.headers.host ?? "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  const desktop = origin === "http://tauri.localhost" || origin === "tauri://localhost";
  if (req.headers["sec-fetch-site"] === "cross-site" && !desktop) return false;
  return !origin || origin === `http://${host}` || origin === `https://${host}` || desktop;
}
/** Account screenshots and remote input require a real canvas browser on loopback. */
export function museViewRequestAllowed(req: Pick<IncomingMessage, "headers" | "socket">) {
  const address = req.socket.remoteAddress ?? "";
  if (!/^(?:127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/.test(address)) return false;
  return Boolean(req.headers.origin) && museRequestAllowed(req);
}
/** Same-origin GET omits Origin in Chromium; require a header guarded by cross-origin preflight. */
export function museSessionExportAllowed(req: Pick<IncomingMessage, "headers" | "socket">) {
  if (museViewRequestAllowed(req)) return true;
  const address = req.socket.remoteAddress ?? "";
  return /^(?:127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/.test(address) &&
    !req.headers.origin && req.headers["sec-fetch-site"] === "same-origin" &&
    req.headers["x-canvas-session"] === "1" && museRequestAllowed(req);
}
async function readBody(req: IncomingMessage, maxBytes = Infinity) {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new MuseBridgeError("请求需要 JSON 数据。", 415);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > maxBytes) throw new MuseBridgeError("Muse 画布窗口请求过大。", 413);
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); } catch { throw new MuseBridgeError("请求数据无效。"); }
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(value));
}
export function museBridgePlugin(_root: string): Plugin {
  let service: MuseBrowserService | undefined;
  const getService = () => service ??= new MuseBrowserService();
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/muse/")) return next();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const viewRoute = url.pathname.startsWith("/api/muse/view/") ||
      url.pathname === "/api/muse/session/import" || url.pathname === "/api/muse/session/export";
    const exportRoute = url.pathname === "/api/muse/session/export";
    if (!(exportRoute ? museSessionExportAllowed(req) : viewRoute ? museViewRequestAllowed(req) : museRequestAllowed(req))) { json(res, 403, { error: "Muse 连接只允许本机画布访问。" }); return; }
    if (req.headers.origin) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin); res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Muse-Name, X-Canvas-Session");
    }
    if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
    void (async () => {
      const route = url.pathname.slice("/api/muse".length);
      const api = getService();
      const upload = route.match(/^\/jobs\/([a-zA-Z0-9_-]{8,100})\/references$/);
      if (req.method === "POST" && upload) {
        let name = "reference";
        try { name = decodeURIComponent(String(req.headers["x-muse-name"] ?? name)); } catch { throw new MuseBridgeError("素材名称编码无效。"); }
        return json(res, 201, await api.references.save(upload[1], req, name, String(req.headers["content-type"] ?? "")));
      }
      if (req.method === "GET" && route === "/session") return json(res, 200, await api.session());
      if (req.method === "GET" && route === "/session/export") return json(res, 200, await api.exportSession());
      if (req.method === "POST" && route === "/session/import")
        return json(res, 200, await api.importSession(await readBody(req, 1024 * 1024)));
      if (req.method === "POST" && route === "/view/frame") {
        const size = await readBody(req, 1024);
        const frame = await api.viewerFrame(size);
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Content-Length", frame.bytes.length);
        res.setHeader("X-View-Width", frame.width);
        res.setHeader("X-View-Height", frame.height);
        res.end(frame.bytes);
        return;
      }
      if (req.method === "POST" && route === "/view/input") return json(res, 200, await api.viewerInput(await readBody(req, 128 * 1024)));
      if (req.method === "POST" && route === "/view/upload") {
        let name = "attachment";
        try { name = decodeURIComponent(String(req.headers["x-muse-name"] ?? name)); }
        catch { throw new MuseBridgeError("Muse 附件名称编码无效。"); }
        name = path.basename(name).slice(0, 255) || "attachment";
        const temporaryId = `muse-view-${randomUUID()}`;
        let result: { ok: true };
        try {
          const saved = await api.references.save(temporaryId, req, name, String(req.headers["content-type"] ?? ""));
          const file = await api.references.resolve(temporaryId, saved.uploadId);
          result = await api.viewerUpload({ ...file, name });
        } finally { await api.references.cleanup(temporaryId); }
        return json(res, 200, result);
      }
      if (req.method === "POST" && ["/session/login", "/session/disconnect"].includes(route)) {
        await readBody(req);
        return json(res, 200, route.endsWith("login") ? await api.login() : await api.disconnect());
      }
      if (req.method === "POST" && route === "/jobs") return json(res, 202, await api.create(await readBody(req)));
      const match = route.match(/^\/jobs\/([a-zA-Z0-9_-]{8,100})(?:\/(resume|cancel|media)(?:\/([a-zA-Z0-9_-]{8,100}))?)?$/);
      if (!match) throw new MuseBridgeError("Muse 接口不存在。", 404);
      if (req.method === "GET" && !match[2]) return json(res, 200, await api.get(match[1]));
      if (req.method === "POST" && match[2] === "resume") { await readBody(req); return json(res, 200, await api.resume(match[1])); }
      if (req.method === "POST" && match[2] === "cancel") { await readBody(req); return json(res, 200, await api.cancel(match[1])); }
      if (req.method === "GET" && match[2] === "media" && match[3]) {
        const media = await api.media(match[1], match[3]);
        const stat = await fs.stat(media.path);
        res.setHeader("Content-Type", media.mime); res.setHeader("Content-Length", stat.size);
        res.setHeader("Content-Disposition", `attachment; filename="${media.name}"`);
        const stream = createReadStream(media.path); stream.on("error", () => res.destroy()); stream.pipe(res); return;
      }
      throw new MuseBridgeError("Muse 接口不支持此操作。", 405);
    })().catch(error => {
      if (!res.headersSent) json(res, error instanceof MuseBridgeError || error instanceof MuseReferenceStoreError ? error.status : 500,
        { error: error instanceof MuseBridgeError || error instanceof MuseReferenceStoreError ? error.message : "Muse 本机服务操作未完成，请在画布中的 Muse 聊天窗口检查当前页面后重试。" });
      else res.destroy();
    });
  };
  return {
    name: "draw-studio-muse-account",
    configureServer(server) { server.middlewares.use(middleware); server.httpServer?.on("close", () => { void service?.close(); }); },
    configurePreviewServer(server) { server.middlewares.use(middleware); server.httpServer?.on("close", () => { void service?.close(); }); },
  };
}
