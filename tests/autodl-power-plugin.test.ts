import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autoDLPowerHandler, autoDLPowerPlugin } from "../scripts/autodl-power-plugin";
import { createAutoDLPowerService, type AutoDLPowerService } from "../scripts/autodl-power-service";
import { AUTODL_EXTENSION_ORIGIN } from "../scripts/autodl-extension-broker";

const fixtures: { root: string; server: Server; service: AutoDLPowerService }[] = [];
const settings = { enabled: true, endpoint: "https://comfy.fixture.invalid", instanceUuid: "pro-fixture123", apiToken: "private-fixture-token" };
async function fixture() {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "canvas-autodl-plugin-"));
  let state = "shutdown";
  const platform = { status: vi.fn(async () => state), powerOn: vi.fn(async () => { state = "running"; }), powerOff: vi.fn(async () => { state = "shutdown"; }) };
  const service = createAutoDLPowerService(root, { platform, automaticTimer: false });
  const handler = autoDLPowerHandler(root, { service });
  const server = createServer((request, response) => { void handler(request, response, () => { response.statusCode = 404; response.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  fixtures.push({ root, server, service });
  async function send(route: string, method = route === "status" ? "GET" : "POST", value: unknown = {}, headers: Record<string, string> = {}) {
    const body = typeof value === "string" ? value : JSON.stringify(value);
    return new Promise<{ status: number; value: any; headers: any }>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path: "/__canvas/autodl/" + route, method,
        headers: { "Content-Type": "application/json", ...(method === "POST" ? { "Content-Length": Buffer.byteLength(body) } : {}), ...headers } }, response => {
        let content = ""; response.on("data", chunk => { content += chunk; }); response.once("end", () => resolve({ status: response.statusCode!, value: content ? JSON.parse(content) : undefined, headers: response.headers }));
      });
      request.once("error", reject); request.end(method === "POST" ? body : undefined);
    });
  }
  return { root, port, service, platform, handler, send };
}
afterEach(async () => {
  const parent = await realpath(os.tmpdir());
  for (const { root, server, service } of fixtures.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await service.close();
    if (path.dirname(await realpath(root)) !== parent || !path.basename(root).startsWith("canvas-autodl-plugin-")) throw new Error("Unrelated cleanup path");
    await rm(root, { recursive: true, force: true });
  }
});

describe("local AutoDL power routes", () => {
  it("keeps GET status read-only and returns no secret, including after settings save", async () => {
    const app = await fixture();
    expect((await app.send("status")).value).toMatchObject({ phase: "disabled", activeTasks: 0 });
    const saved = await app.send("settings", "POST", settings); expect(saved.status).toBe(200); expect(JSON.stringify(saved.value)).not.toContain(settings.apiToken);
    const status = await app.send("status"); expect(status.headers["cache-control"]).toBe("no-store"); expect(status.value.settings.tokenConfigured).toBe(false);
    expect(app.platform.status).not.toHaveBeenCalled(); expect(app.platform.powerOn).not.toHaveBeenCalled(); expect(app.platform.powerOff).not.toHaveBeenCalled();
  });
  it("checks credentials without power commands and handles the complete lease route contract", async () => {
    const app = await fixture(); await app.send("settings", "POST", settings);
    expect((await app.send("check")).status).toBe(200); expect(app.platform.status).toHaveBeenCalledTimes(1); expect(app.platform.powerOn).not.toHaveBeenCalled();
    const acquired = await app.send("acquire", "POST", { endpoint: settings.endpoint, instanceUuid: settings.instanceUuid, taskId: "task-one", attemptId: "attempt-one" });
    expect(acquired.status).toBe(200); await app.service.tick();
    const leaseId = acquired.value.leaseId;
    expect((await app.send("heartbeat", "POST", { leaseId })).value.phase).toBe("ready");
    expect((await app.send("release", "POST", { leaseId })).status).toBe(200); await app.service.tick();
    expect((await app.send("retry-shutdown")).value).toMatchObject({ phase: "off", pendingStop: false });
    expect(app.platform.powerOff).toHaveBeenCalledTimes(1);
  });
  it("accepts lost-response cleanup by attempt and prevents a later matching acquire from booting", async () => {
    const app = await fixture(); await app.send("settings", "POST", settings);
    const attempt = { endpoint: settings.endpoint, instanceUuid: settings.instanceUuid, taskId: "task-one", attemptId: "attempt-one" };
    expect((await app.send("release", "POST", attempt)).status).toBe(200);
    const acquired = await app.send("acquire", "POST", attempt); expect(acquired.value.phase).toBe("released"); await app.service.tick();
    expect(app.platform.powerOn).not.toHaveBeenCalled(); expect(app.platform.powerOff).not.toHaveBeenCalled();
    expect((await app.send("release", "POST", { ...attempt, leaseId: acquired.value.leaseId })).status).toBe(400);
    expect((await app.send("release", "POST", { ...attempt, instanceUuid: "pro-other" })).status).toBe(409);
  });
  it("rejects disabling live lease accounting and keeps a second card inside the same lease lifecycle", async () => {
    const app = await fixture(); await app.send("settings", "POST", settings);
    const first = await app.send("acquire", "POST", { endpoint: settings.endpoint, instanceUuid: settings.instanceUuid, taskId: "task-one", attemptId: "attempt-one" }); await app.service.tick();
    expect((await app.send("settings", "POST", { ...settings, enabled: false })).status).toBe(409);
    expect((await app.send("status")).value.settings.enabled).toBe(true);
    const second = await app.send("acquire", "POST", { endpoint: settings.endpoint, instanceUuid: settings.instanceUuid, taskId: "task-two", attemptId: "attempt-two" }); await app.service.tick();
    await app.send("release", "POST", { leaseId: first.value.leaseId }); await app.service.tick(); expect(app.platform.powerOff).not.toHaveBeenCalled();
    expect((await app.send("heartbeat", "POST", { leaseId: second.value.leaseId })).value.phase).toBe("ready");
    app.platform.powerOff.mockResolvedValue(undefined);
    await app.send("release", "POST", { leaseId: second.value.leaseId }); await app.service.tick();
    expect((await app.send("settings", "POST", { ...settings, enabled: false })).status).toBe(409);
  });
  it("rejects crossed origins, misleading hosts and remote host bindings before service work", async () => {
    const app = await fixture();
    for (const headers of [{ Origin: "https://evil.invalid" }, { Host: "127.0.0.1.evil.invalid" }, { Host: "example.invalid" }, { Origin: `http://127.0.0.1:${app.port + 1}` }])
      expect((await app.send("settings", "POST", settings, headers)).status).toBe(403);
    expect((await app.send("status")).value.settings.tokenConfigured).toBe(false);
    expect(app.platform.status).not.toHaveBeenCalled();
  });
  it("rejects unknown routes, methods, query strings, JSON fields and unsupported force controls", async () => {
    const app = await fixture();
    expect((await app.send("power-off")).status).toBe(404);
    expect((await app.send("status", "POST")).status).toBe(405);
    expect((await app.send("status?token=forbidden", "GET")).status).toBe(405);
    expect((await app.send("settings", "POST", { ...settings, force: true })).status).toBe(400);
    expect((await app.send("release", "POST", { leaseId: "lease-one", instanceUuid: "pro-other", force: true })).status).toBe(400);
    expect((await app.send("acquire", "POST", { endpoint: settings.endpoint })).status).toBe(400);
    expect(app.platform.powerOn).not.toHaveBeenCalled(); expect(app.platform.powerOff).not.toHaveBeenCalled();
  });
  it("passes only the new safe diagnostic fields through the authenticated bridge result route", async () => {
    const app = await fixture(), headers = { Origin: AUTODL_EXTENSION_ORIGIN };
    const result = { bridgeKey: "0".repeat(64), id: "fixture", ok: false, errorCode: "NO_GPU_CAPACITY", remoteCode: "InternalError", httpStatus: 200 };
    // The schema must accept diagnostic keys, then reject the unauthenticated key.
    expect((await app.send("bridge/result", "POST", result, headers)).status).toBe(401);
    expect((await app.send("bridge/result", "POST", { ...result, responseBody: "must-not-be-relayed" }, headers)).status).toBe(400);
    expect(app.platform.powerOn).not.toHaveBeenCalled(); expect(app.platform.powerOff).not.toHaveBeenCalled();
  });
  it("rejects invalid content types, broken JSON and oversized metadata", async () => {
    const app = await fixture();
    expect((await app.send("settings", "POST", settings, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await app.send("settings", "POST", "{")).status).toBe(400);
    expect((await app.send("settings", "POST", [])).status).toBe(400);
    expect((await app.send("settings", "POST", { data: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect(app.platform.status).not.toHaveBeenCalled();
  });
  it("redacts platform errors rather than returning the developer token", async () => {
    const app = await fixture(); await app.send("settings", "POST", settings);
    app.platform.status.mockRejectedValue(new Error(`private platform error ${settings.apiToken}`));
    const result = await app.send("check"); expect(result.status).toBe(500); expect(result.value.error).toContain("[已隐藏]"); expect(JSON.stringify(result.value)).not.toContain(settings.apiToken);
  });
  it("exposes disposal and does not power off still-active tasks when the server closes", async () => {
    const app = await fixture(); await app.send("settings", "POST", settings);
    await app.send("acquire", "POST", { endpoint: settings.endpoint, instanceUuid: settings.instanceUuid, taskId: "task-one", attemptId: "attempt-one" }); await app.service.tick();
    await app.handler.dispose(); expect(app.platform.powerOff).not.toHaveBeenCalled();
  });
  it("registers the injected root-scoped handler without eagerly starting it during a production build", async () => {
    const app = await fixture(); const start = vi.spyOn(app.service, "start");
    const plugin = autoDLPowerPlugin(app.root, { service: app.service });
    expect(plugin.name).toBe("canvas-local-autodl-power"); expect(start).not.toHaveBeenCalled();
  });
});
