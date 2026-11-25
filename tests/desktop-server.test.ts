import { once } from "node:events";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDesktopServer } from "../scripts/desktop-server";
import { AUTODL_EXTENSION_ORIGIN } from "../scripts/autodl-extension-broker";
import type { NativeProxySocket } from "../scripts/runninghub-native-proxy-plugin";

const servers: Awaited<ReturnType<typeof startDesktopServer>>[] = [], folders: string[] = [], clients: NativeProxySocket[] = [];
const WebSocket = createRequire(import.meta.url)("ws") as new (url: string, options: { origin?: string }) => NativeProxySocket;
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  for (const server of servers.splice(0)) await server.close();
  vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function fixture() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "canvas-desktop-server-")); folders.push(folder);
  const rootDir = path.join(folder, "workspace"), distDir = path.join(folder, "resources", "dist"), library = path.join(rootDir, "workflows");
  await mkdir(path.join(distDir, "assets"), { recursive: true });
  await mkdir(library, { recursive: true });
  await writeFile(path.join(distDir, "index.html"), '<!doctype html><title>Draw studio production fixture</title><script type="module" src="/assets/app-abcdefgh.js"></script>');
  await writeFile(path.join(distDir, "assets", "app-abcdefgh.js"), 'document.title = "production";');
  await writeFile(path.join(distDir, "media.mp4"), "0123456789");
  await writeFile(path.join(rootDir, "workflow-library.settings.json"), JSON.stringify({ sourcePath: library }));
  vi.stubEnv("DRAW_STUDIO_DATA_HOME", path.join(folder, "services"));
  vi.stubEnv("CANVAS_TRANSFER_ROOT", path.join(rootDir, "transfer"));
  const desktop = await startDesktopServer({ rootDir, distDir, port: 0, instanceId: "smoke-desktop-instance" }); servers.push(desktop);
  return { ...desktop, folder, rootDir, distDir };
}
function send(port: number, pathname: string, options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: unknown } = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: pathname, method: options.method ?? "GET", headers: options.headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", value => chunks.push(value));
      response.once("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString(), headers: response.headers }));
    });
    request.once("error", reject); request.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}
describe("standalone production desktop server", () => {
  it("serves built HTML and immutable chunks, identifies its own instance and has no Vite runtime", async () => {
    const app = await fixture();
    const html = await send(app.port, "/");
    expect(html.status).toBe(200); expect(html.body).toContain("production fixture"); expect(html.body).not.toContain("/@vite/client");
    const js = await send(app.port, "/assets/app-abcdefgh.js");
    expect(js.status).toBe(200); expect(js.headers["content-type"]).toContain("javascript"); expect(js.headers["cache-control"]).toContain("immutable");
    const health = await send(app.port, "/__canvas/desktop-health");
    expect(JSON.parse(health.body)).toEqual({ ok: true, service: "draw-studio-desktop", instanceId: "smoke-desktop-instance", pid: process.pid });
    expect(app.server.requestTimeout).toBe(0); expect(app.server.headersTimeout).toBe(0); expect(app.server.timeout).toBe(0);
    expect(app.server.address()).toMatchObject({ address: "127.0.0.1" });
  });
  it("supports HEAD and exact media ranges without returning HTML for missing scripts or APIs", async () => {
    const app = await fixture();
    const head = await send(app.port, "/media.mp4", { method: "HEAD" });
    expect(head.status).toBe(200); expect(head.body).toBe(""); expect(head.headers["content-length"]).toBe("10");
    const range = await send(app.port, "/media.mp4", { headers: { Range: "bytes=2-5" } });
    expect(range.status).toBe(206); expect(range.body).toBe("2345"); expect(range.headers["content-range"]).toBe("bytes 2-5/10");
    expect((await send(app.port, "/media.mp4", { headers: { Range: "bytes=-3" } })).body).toBe("789");
    expect((await send(app.port, "/media.mp4", { headers: { Range: "bytes=50-" } })).status).toBe(416);
    expect((await send(app.port, "/missing.js", { headers: { Accept: "text/html" } })).status).toBe(404);
    expect((await send(app.port, "/api/missing", { headers: { Accept: "text/html" } })).status).toBe(404);
    expect((await send(app.port, "/project/example", { headers: { Accept: "text/html" } })).body).toContain("production fixture");
  });
  it("rejects foreign origins, rebinding hosts and attempts to read writable service files", async () => {
    const app = await fixture();
    expect((await send(app.port, "/", { headers: { Origin: "https://foreign.test" } })).status).toBe(403);
    expect((await send(app.port, "/", { headers: { Host: "foreign.test" } })).status).toBe(403);
    expect((await send(app.port, "/%2e%2e/%2e%2e/workspace/workflow-library.settings.json")).status).toBe(403);
    expect((await send(app.port, "/%00")).status).toBe(400);
    await symlink(app.rootDir, path.join(app.distDir, "outside"), process.platform === "win32" ? "junction" : "dir");
    expect((await send(app.port, "/outside/workflow-library.settings.json")).status).toBe(403);
  });
  it("allows the AutoDL browser extension on its pairing routes only", async () => {
    const app = await fixture();
    const headers = { Origin: AUTODL_EXTENSION_ORIGIN, "Content-Type": "application/json" };
    const pairing = "/__canvas/autodl/bridge/pair";
    const preflight = await send(app.port, pairing, { method: "OPTIONS", headers });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(AUTODL_EXTENSION_ORIGIN);
    expect((await send(app.port, pairing, { method: "POST", headers, body: { code: "12345678" } })).status).toBe(401);
    expect((await send(app.port, "/__canvas/autodl/pair-code", { method: "POST", headers, body: {} })).status).toBe(403);
    expect((await send(app.port, "/", { headers })).status).toBe(403);
  });
  it("registers the real library, AIFISHER reader, optimization, cloud and browser APIs", async () => {
    const app = await fixture(), headers = { "Content-Type": "application/json", Origin: app.url.slice(0, -1) };
    expect((await send(app.port, "/__canvas/workflow-library")).status).toBe(200);
    const reader = await send(app.port, "/__canvas/workflow-reader", { method: "POST", headers, body: { environment: "comfyui", source: { "1": { class_type: "SaveImage", inputs: { filename_prefix: "fixture" } } } } });
    expect(reader.status).toBe(200); expect(JSON.parse(reader.body).upstream.revision).toBe("bdcf3bec054594fcab591952a8c5acef858d6de4");
    const settings = await send(app.port, "/__canvas/prompt-optimization/settings", { method: "POST", headers, body: { modelId: "desktop-model-fixture" } });
    expect(settings.status).toBe(200);
    expect(await readFile(path.join(app.rootDir, "prompt-optimization.settings.json"), "utf8")).toContain("desktop-model-fixture");
    expect((await send(app.port, "/__canvas/cloud-files/local", { method: "POST", headers, body: { bucket: "cloud_upload", path: "" } })).status).toBe(200);
    expect((await send(app.port, "/api/muse/session", { method: "OPTIONS", headers })).status).toBe(204);
    expect((await send(app.port, "/__canvas/deepseek/session", { method: "OPTIONS", headers })).status).toBe(204);
    expect((await send(app.port, "/__canvas/video-playback")).status).toBe(415);
    expect((await send(app.port, "/api/runninghub/unsupported", { method: "POST", headers, body: {} })).status).toBe(400);
    expect((await send(app.port, "/api/runninghub-comfy/system_stats", { headers })).status).toBe(400);
  });
  it("retains native RunningHub WebSocket upgrades and closes accepted clients on shutdown", async () => {
    const app = await fixture();
    const client = new WebSocket(`ws://127.0.0.1:${app.port}/api/runninghub-comfy/ws?clientId=desktop-smoke`, { origin: app.url.slice(0, -1) });
    clients.push(client); client.on("error", () => undefined); await once(client, "open");
    const message = once(client, "message"), closed = once(client, "close");
    client.send(JSON.stringify({ type: "authenticate", endpoint: "https://untrusted.test", token: "fixture" }), { binary: false }, () => undefined);
    expect(JSON.parse((await message)[0].toString()).type).toBe("rh_native_error"); await closed;
    const second = new WebSocket(`ws://127.0.0.1:${app.port}/api/runninghub-comfy/ws?clientId=desktop-shutdown`, { origin: app.url.slice(0, -1) });
    clients.push(second); second.on("error", () => undefined); await once(second, "open");
    const shutdown = once(second, "close"); await app.close(); await shutdown;
    await expect(app.close()).resolves.toBeUndefined();
  });
  it("fails cleanly for a missing production entry or an occupied fixed port", async () => {
    const app = await fixture();
    await expect(startDesktopServer({ rootDir: app.rootDir, distDir: app.distDir, port: app.port, instanceId: "other" })).rejects.toMatchObject({ code: "EADDRINUSE" });
    await expect(startDesktopServer({ rootDir: app.rootDir, distDir: app.rootDir, port: 0, instanceId: "missing-entry" })).rejects.toMatchObject({ code: "ENOENT" });
  });
});
