import fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutoDLPlatform, createAutoDLPowerService, type AutoDLPlatform, type AutoDLPowerService } from "../scripts/autodl-power-service";
import { AutoDLBridgeError } from "../scripts/autodl-extension-broker";

const roots: string[] = [], services: AutoDLPowerService[] = [];
const settings = { enabled: true, endpoint: "https://comfy.fixture.invalid/comfy", instanceUuid: "pro-fixture123", apiToken: "fixture-private-developer-token" };
const input = (taskId = "task-one", attemptId = "attempt-one") => ({ endpoint: settings.endpoint, instanceUuid: settings.instanceUuid, taskId, attemptId });
const stateFile = (root: string) => path.join(root, ".cache/autodl-power/state.json");
async function rootFixture() { const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "canvas-autodl-power-")); roots.push(root); return root; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function deferredValue<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  for (let index = 0; index < 500 && !check(); index++) await new Promise<void>(resolve => setTimeout(resolve, 2));
  expect(check()).toBe(true);
}
async function fixture(options: { root?: string; platform?: AutoDLPlatform; now?: () => number; automaticTimer?: boolean; retryMs?: number; bootSettleMs?: number } = {}) {
  const root = options.root ?? await rootFixture();
  let power = "shutdown";
  let revision = 0;
  const platform = {
    status: vi.fn(async (_credentials: { apiToken: string; instanceUuid: string }) => power),
    powerOn: vi.fn(async (_credentials: { apiToken: string; instanceUuid: string }) => { power = "running"; }),
    powerOff: vi.fn(async (_credentials: { apiToken: string; instanceUuid: string }) => { power = "shutdown"; }),
    revision: () => revision,
  };
  const service = createAutoDLPowerService(root, { platform: options.platform ?? platform, automaticTimer: false, bootSettleMs: 0, ...options });
  services.push(service);
  await service.saveSettings(settings);
  return { root, service, platform, setPower: (value: string) => { power = value; }, changePairing: () => { revision++; } };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.close().catch(() => {});
  const temporary = await realpath(os.tmpdir());
  for (const root of roots.splice(0)) {
    if (path.dirname(await realpath(root)) !== temporary || !path.basename(root).startsWith("canvas-autodl-power-")) throw new Error("Unrelated cleanup path");
    await rm(root, { recursive: true, force: true });
  }
});

describe("AutoDL extension platform adapter", () => {
  it("passes only the allowlisted command and exact UUID, never a developer or website credential", async () => {
    const broker = { call: vi.fn(async () => ({ status: "running" })), revision: () => 2 };
    const api = createAutoDLPlatform(broker);
    expect(await api.status(settings)).toBe("running"); await api.powerOn(settings); await api.powerOff(settings);
    expect(broker.call.mock.calls).toEqual([["status", settings.instanceUuid], ["power-on", settings.instanceUuid], ["power-off", settings.instanceUuid]]);
    expect(JSON.stringify(broker.call.mock.calls)).not.toContain(settings.apiToken); expect(api.revision?.()).toBe(2);
  });
});

describe("durable AutoDL task leases", () => {
  it("reports the wallet preflight refusal and starts a new attempt once funds are available", async () => {
    const message = "AutoDL.Art 账户可用余额不足以开机。";
    const checkStartup = vi.fn(async () => "shutdown")
      .mockRejectedValue(new AutoDLBridgeError(message, 502, "INSUFFICIENT_BALANCE", false, true));
    const platform = {
      status: vi.fn(async () => "shutdown"),
      checkStartup,
      powerOn: vi.fn(async () => { platform.status.mockResolvedValue("running"); }),
      powerOff: vi.fn(async () => {}),
    };
    const { service } = await fixture({ platform });
    expect(await service.check()).toMatchObject({ phase: "off", message, pendingStop: false });
    const blocked = await service.acquire(input());
    await service.tick();
    expect(await service.heartbeat(blocked.leaseId)).toMatchObject({ phase: "failed", error: message });
    expect(await service.status()).toMatchObject({ phase: "off", activeTasks: 0, pendingStop: false });
    expect(platform.powerOn).not.toHaveBeenCalled();
    expect(platform.powerOff).not.toHaveBeenCalled();

    checkStartup.mockReset().mockResolvedValue("shutdown");
    expect(await service.check()).toMatchObject({ phase: "off", message: expect.stringContaining("开机预检通过") });
    expect(platform.powerOn).not.toHaveBeenCalled();
    const retried = await service.acquire(input("task-one", "attempt-two"));
    await service.tick();
    expect(await service.heartbeat(retried.leaseId)).toMatchObject({ phase: "ready" });
    expect(platform.powerOn).toHaveBeenCalledOnce();
  });
  it("uses the newer instance state from preflight to avoid sending a redundant boot request", async () => {
    const platform = {
      status: vi.fn(async () => "shutdown"),
      checkStartup: vi.fn(async () => "running"),
      powerOn: vi.fn(async () => {}),
      powerOff: vi.fn(async () => {}),
    };
    const { service } = await fixture({ platform });
    const lease = await service.acquire(input());
    await service.tick();
    expect(await service.heartbeat(lease.leaseId)).toMatchObject({ phase: "ready" });
    expect(platform.checkStartup).toHaveBeenCalledWith({ ...settings, apiToken: "" });
    expect(platform.powerOn).not.toHaveBeenCalled();
  });
  it("does not clear uncertain startup cleanup after only one early shutdown observation", async () => {
    let now = 1000;
    const { service, platform, setPower } = await fixture({ now: () => now, bootSettleMs: 60_000 });
    platform.powerOn.mockRejectedValue(new AutoDLBridgeError("Lost delivered command", 504, "COMMAND_TIMEOUT", true));
    const lease = await service.acquire(input()); await service.tick();
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("failed"); expect((await service.status()).pendingStop).toBe(true);
    platform.powerOff.mockResolvedValue(undefined); now += 10_000; setPower("starting"); await service.tick();
    expect((await service.status()).pendingStop).toBe(true);
    setPower("shutdown"); await service.tick(); expect((await service.status()).pendingStop).toBe(false);
    expect(platform.powerOn).toHaveBeenCalledTimes(1); expect(platform.powerOff.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  it("bounds uncertain-start observation without delaying the first power-off request", async () => {
    let now = 1000;
    const { service, platform } = await fixture({ now: () => now, bootSettleMs: 60_000 });
    platform.powerOn.mockRejectedValue(new AutoDLBridgeError("Lost delivered command", 504, "COMMAND_TIMEOUT", true));
    await service.acquire(input()); await service.tick(); expect(platform.powerOff).toHaveBeenCalledTimes(1);
    now += 59_999; await service.tick(); expect((await service.status()).pendingStop).toBe(true);
    now += 2; await service.tick(); expect((await service.status()).pendingStop).toBe(false);
    expect(platform.powerOn).toHaveBeenCalledTimes(1);
  });
  it.each([
    new AutoDLBridgeError("Not delivered", 504, "COMMAND_TIMEOUT", false),
    new AutoDLBridgeError("Explicit rejection", 502, "POWER_REJECTED", true, true),
    new AutoDLBridgeError("Expired before submission", 502, "COMMAND_EXPIRED", false, true),
  ])("does not retain a boot obligation for an operation known to have no power effect %#", async failure => {
    const { service, platform } = await fixture({ bootSettleMs: 60_000 }); platform.powerOn.mockRejectedValue(failure);
    const lease = await service.acquire(input()); await service.tick();
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("failed"); expect((await service.status()).pendingStop).toBe(false); expect(platform.powerOff).not.toHaveBeenCalled();
  });
  it.each(["starting", "running"])("reconciles a rejected state-conflict against real %s without replaying power-on", async actual => {
    const { service, platform, setPower } = await fixture({ bootSettleMs: 60_000 });
    platform.powerOn.mockImplementation(async () => { setPower(actual); throw new AutoDLBridgeError("State changed", 502, "POWER_STATE_CONFLICT", true); });
    const lease = await service.acquire(input()); await service.tick();
    expect((await service.heartbeat(lease.leaseId)).phase).toBe(actual === "running" ? "ready" : "starting");
    setPower("running"); await service.tick(); expect((await service.heartbeat(lease.leaseId)).phase).toBe("ready");
    expect(platform.powerOn).toHaveBeenCalledTimes(1); expect(platform.powerOff).not.toHaveBeenCalled();
    await service.release(lease.leaseId); await service.tick(); expect(platform.powerOff).toHaveBeenCalledTimes(1);
  });
  it.each([["POWER_UNKNOWN", "shutdown"], ["POWER_STATE_CONFLICT", "shutdown_by_starting_error"]])("waits for reported startup after %s while %s is stale", async (code, staleStatus) => {
    let now = 1000;
    const { service, platform, setPower } = await fixture({ now: () => now, bootSettleMs: 60_000 });
    setPower(staleStatus);
    platform.powerOn.mockRejectedValue(new AutoDLBridgeError("Unconfirmed platform result", 502, code, true));
    const first = await service.acquire(input()); await service.tick();
    const second = await service.acquire(input("task-two", "attempt-two"));
    expect(second).toMatchObject({ phase: "starting", message: expect.stringContaining("正在核对 AutoDL 开机状态") });
    expect(await service.heartbeat(first.leaseId)).toMatchObject({ phase: "starting", message: second.message });
    expect(await service.status()).toMatchObject({ phase: "starting", activeTasks: 2, pendingStop: false });
    now += 10_000; setPower("starting"); await service.tick();
    expect(await service.heartbeat(first.leaseId)).toMatchObject({ phase: "starting" });
    expect(await service.heartbeat(first.leaseId)).not.toHaveProperty("message");
    now += 10_000; setPower("running"); await service.tick();
    expect(await service.heartbeat(first.leaseId)).toMatchObject({ phase: "ready" });
    expect(await service.heartbeat(second.leaseId)).toMatchObject({ phase: "ready" });
    expect(platform.powerOn).toHaveBeenCalledTimes(1); expect(platform.powerOff).not.toHaveBeenCalled();
  });
  it("records a confirmed shutdown after the reconciliation window without sending power-off", async () => {
    let now = 1000;
    const { service, platform, root } = await fixture({ now: () => now, bootSettleMs: 60_000 });
    platform.powerOn.mockRejectedValue(new AutoDLBridgeError("Unconfirmed platform result", 502, "POWER_UNKNOWN", true, false, { remoteCode: "BadRequest", httpStatus: 200 }));
    const lease = await service.acquire(input()); await service.tick();
    now += 59_000; await service.tick();
    expect(await service.heartbeat(lease.leaseId)).toMatchObject({ phase: "starting" });
    now += 1_000; await service.tick();
    expect(await service.heartbeat(lease.leaseId)).toMatchObject({ phase: "failed", error: expect.stringContaining("平台仍显示关机（平台码 BadRequest，HTTP 200）") });
    expect(await service.status()).toMatchObject({ phase: "off", pendingStop: false, activeTasks: 0 });
    expect(JSON.parse(await readFile(stateFile(root), "utf8"))).not.toHaveProperty("bootVerification");
    expect(platform.powerOn).toHaveBeenCalledTimes(1); expect(platform.powerOff).not.toHaveBeenCalled();
  });
  it("resumes an interrupted startup verification without sending another power-on", async () => {
    let now = 1000;
    const first = await fixture({ now: () => now, bootSettleMs: 60_000 });
    first.platform.powerOn.mockRejectedValue(new AutoDLBridgeError("Unconfirmed platform result", 502, "POWER_UNKNOWN", true));
    await first.service.acquire(input()); await first.service.tick(); await first.service.close();
    const restored = createAutoDLPowerService(first.root, { platform: first.platform, now: () => now, automaticTimer: false }); services.push(restored);
    await restored.tick();
    const lease = await restored.acquire(input()); await restored.tick();
    expect(lease).toMatchObject({ phase: "starting", message: expect.stringContaining("正在核对 AutoDL 开机状态") });
    now += 10_000; first.setPower("running"); await restored.tick();
    expect(await restored.heartbeat(lease.leaseId)).toMatchObject({ phase: "ready" });
    expect(first.platform.powerOn).toHaveBeenCalledTimes(1); expect(first.platform.powerOff).not.toHaveBeenCalled();
  });
  it("refreshes an off snapshot requested before the deadline if its response arrives after it", async () => {
    let now = 1000;
    const { service, platform, setPower } = await fixture({ now: () => now, bootSettleMs: 60_000 });
    platform.powerOn.mockRejectedValue(new AutoDLBridgeError("Unconfirmed platform result", 502, "POWER_UNKNOWN", true));
    const lease = await service.acquire(input()); await service.tick();
    now += 59_999;
    platform.status.mockImplementationOnce(async () => { now += 2; setPower("running"); return "shutdown"; });
    await service.tick();
    expect(await service.heartbeat(lease.leaseId)).toMatchObject({ phase: "ready" });
    expect(platform.powerOn).toHaveBeenCalledTimes(1); expect(platform.powerOff).not.toHaveBeenCalled();
  });
  it("keeps a cleanup obligation when startup status remains unreadable through the reconciliation deadline", async () => {
    let now = 1000;
    const { service, platform } = await fixture({ now: () => now, bootSettleMs: 60_000 });
    platform.status.mockResolvedValueOnce("shutdown");
    platform.status.mockRejectedValue(new Error("Status unavailable"));
    platform.powerOn.mockRejectedValue(new AutoDLBridgeError("Unconfirmed platform result", 502, "POWER_UNKNOWN", true));
    const lease = await service.acquire(input()); await service.tick();
    expect(await service.heartbeat(lease.leaseId)).toMatchObject({ phase: "starting" });
    expect(platform.powerOff).not.toHaveBeenCalled();
    now += 60_000; await service.tick();
    expect(await service.heartbeat(lease.leaseId)).toMatchObject({ phase: "failed", error: expect.stringContaining("开机核对超时") });
    expect(await service.status()).toMatchObject({ phase: "stopping", pendingStop: true, activeTasks: 0 });
    expect(platform.powerOn).toHaveBeenCalledTimes(1); expect(platform.powerOff).toHaveBeenCalled();
  });
  it("waits 30 seconds between at most two confirmed-capacity retries, sharing the attempt with concurrent leases", async () => {
    let now = 1000;
    const { service, platform, setPower, root } = await fixture({ now: () => now });
    platform.powerOn.mockImplementation(async () => {
      if (platform.powerOn.mock.calls.length <= 2) throw new AutoDLBridgeError("No inventory", 502, "NO_GPU_CAPACITY", true, true);
      setPower("running");
    });
    const first = await service.acquire(input()); await service.tick();
    expect(await service.heartbeat(first.leaseId)).toMatchObject({ phase: "starting", message: expect.stringContaining("暂无库存") });
    const second = await service.acquire(input("task-two", "attempt-two"));
    expect(second).toMatchObject({ phase: "starting", message: expect.stringContaining("暂无库存") });
    expect(JSON.parse(await readFile(stateFile(root), "utf8"))).toMatchObject({ capacityRetryCount: 1, capacityRetryAt: 31_000, powerOwned: false });
    now += 29_999; await service.tick(); expect(platform.powerOn).toHaveBeenCalledTimes(1);
    now++; await service.tick(); expect(platform.powerOn).toHaveBeenCalledTimes(2);
    now += 30_000; await service.tick(); expect(platform.powerOn).toHaveBeenCalledTimes(3);
    expect(await service.heartbeat(first.leaseId)).toMatchObject({ phase: "ready" }); expect(await service.heartbeat(second.leaseId)).toMatchObject({ phase: "ready" });
    expect(await service.heartbeat(first.leaseId)).not.toHaveProperty("message");
    await service.release(first.leaseId); await service.tick(); expect(platform.powerOff).not.toHaveBeenCalled();
    await service.release(second.leaseId); await service.tick(); expect(platform.powerOff).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(stateFile(root), "utf8"))).not.toHaveProperty("capacityRetryAt");
  });
  it("ends the current leases after three explicit inventory rejections without later background startup", async () => {
    let now = 1000;
    const { service, platform } = await fixture({ now: () => now });
    platform.powerOn.mockRejectedValue(new AutoDLBridgeError("No inventory", 502, "NO_GPU_CAPACITY", true, true));
    const lease = await service.acquire(input()); await service.tick();
    now += 30_000; await service.tick(); now += 30_000; await service.tick();
    expect(await service.heartbeat(lease.leaseId)).toMatchObject({ phase: "failed", error: expect.stringContaining("已完成 2 次重试") });
    now += 30_000; await service.tick(); expect(platform.powerOn).toHaveBeenCalledTimes(3);
    expect(await service.status()).toMatchObject({ activeTasks: 0, pendingStop: false }); expect(platform.powerOff).not.toHaveBeenCalled();
  });
  it.each(["shutting_down", "query-failed"])("does not schedule capacity retries without a confirmed off state: %s", async actual => {
    let now = 1000;
    const { service, platform } = await fixture({ now: () => now });
    platform.status.mockImplementationOnce(async () => "shutdown");
    platform.status.mockImplementation(async () => { if (actual === "query-failed") throw new Error("Status unavailable"); return actual; });
    platform.powerOn.mockRejectedValue(new AutoDLBridgeError("No inventory", 502, "NO_GPU_CAPACITY", true, true));
    const lease = await service.acquire(input()); await service.tick(); now += 60_000; await service.tick();
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("failed"); expect(platform.powerOn).toHaveBeenCalledTimes(1);
  });
  it("cancels a capacity wait even when the due retry has a read-only status query in flight", async () => {
    let now = 1000;
    const { service, platform } = await fixture({ now: () => now });
    platform.powerOn.mockRejectedValue(new AutoDLBridgeError("No inventory", 502, "NO_GPU_CAPACITY", true, true));
    const lease = await service.acquire(input()); await service.tick();
    const delayed = deferredValue<string>(); platform.status.mockImplementationOnce(async () => delayed.promise);
    now += 30_000; const retry = service.tick(); await until(() => platform.status.mock.calls.length === 3);
    await service.release(lease.leaseId); delayed.resolve("shutdown"); await retry; now += 60_000; await service.tick();
    expect(platform.powerOn).toHaveBeenCalledTimes(1); expect(platform.powerOff).not.toHaveBeenCalled();
    expect(await service.status()).toMatchObject({ activeTasks: 0, pendingStop: false });
  });
  it("restores the capacity retry deadline only after the interrupted task explicitly resumes", async () => {
    let now = 1000;
    const first = await fixture({ now: () => now });
    first.platform.powerOn.mockRejectedValueOnce(new AutoDLBridgeError("No inventory", 502, "NO_GPU_CAPACITY", true, true));
    await first.service.acquire(input()); await first.service.tick(); await first.service.close();
    const restored = createAutoDLPowerService(first.root, { platform: first.platform, now: () => now, automaticTimer: false }); services.push(restored);
    await restored.tick(); expect(first.platform.powerOn).toHaveBeenCalledTimes(1);
    const lease = await restored.acquire(input()); await restored.tick(); expect(lease).toMatchObject({ phase: "starting", message: expect.stringContaining("暂无库存") });
    expect(first.platform.powerOn).toHaveBeenCalledTimes(1);
    now += 30_000; await restored.tick(); expect(first.platform.powerOn).toHaveBeenCalledTimes(2);
    expect((await restored.heartbeat(lease.leaseId)).phase).toBe("ready");
  });
  it("rejects a mismatched instance ID encoded in a recognizable official AutoDL endpoint", async () => {
    const { service, platform } = await fixture();
    await expect(service.saveSettings({ enabled: true, endpoint: "https://u123-abc123.westd.seetacloud.com:8443/comfy", instanceUuid: "pro-different" })).rejects.toThrow("不一致");
    await service.saveSettings({ enabled: true, endpoint: "https://u123-abc123.westd.seetacloud.com:8443/comfy", instanceUuid: "pro-abc123" });
    expect(platform.status).not.toHaveBeenCalled();
  });
  it("scrubs a legacy developer credential on load without using it for any platform request", async () => {
    const first = await fixture(); await first.service.close();
    const saved = JSON.parse(await readFile(stateFile(first.root), "utf8")); saved.settings.apiToken = settings.apiToken;
    await writeFile(stateFile(first.root), JSON.stringify(saved));
    const restored = createAutoDLPowerService(first.root, { platform: first.platform, automaticTimer: false }); services.push(restored);
    expect((await restored.status()).settings.tokenConfigured).toBe(false);
    expect(JSON.parse(await readFile(stateFile(first.root), "utf8")).settings.apiToken).toBe(""); expect(first.platform.status).not.toHaveBeenCalled();
  });
  it("rechecks the lease inside the boot checkpoint after an earlier release write commits", async () => {
    const { service, platform, root } = await fixture();
    const observed = deferredValue<string>(), commit = deferred();
    platform.status.mockImplementationOnce(async () => observed.promise);
    const lease = await service.acquire(input()); await until(() => platform.status.mock.calls.length === 1);
    const rename = fs.rename.bind(fs);
    let checkpointBlocked = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      const next = JSON.parse(await readFile(String(source), "utf8"));
      if (!checkpointBlocked && String(target) === stateFile(root) && next.leases.some((item: any) => item.leaseId === lease.leaseId && item.phase === "released") && !next.powerOwned) {
        checkpointBlocked = true; await commit.promise;
      }
      return rename(source, target);
    });
    const releasing = service.release(lease.leaseId); await until(() => checkpointBlocked);
    observed.resolve("shutdown");
    for (let index = 0; index < 20; index++) await Promise.resolve();
    commit.resolve(); await releasing; await service.tick();
    expect(platform.powerOn).not.toHaveBeenCalled(); expect(platform.powerOff).not.toHaveBeenCalled();
    expect(await service.status()).toMatchObject({ activeTasks: 0, pendingStop: false, phase: "unknown" });
  });
  it.each(["running", "error"])("ignores the old instance's late %s result after its task ends and the binding changes", async outcome => {
    const { service, platform, setPower } = await fixture();
    const first = deferredValue<string>(), replacement = deferredValue<string>();
    let secondReads = 0;
    platform.status.mockImplementation(async credentials => {
      if (credentials.instanceUuid === settings.instanceUuid) {
        const result = await first.promise;
        if (outcome === "error") throw new Error("old platform failure");
        return result;
      }
      if (secondReads++ === 0) return replacement.promise;
      return "running";
    });
    platform.powerOn.mockImplementation(async () => { setPower("running"); });
    const old = await service.acquire(input()); await until(() => platform.status.mock.calls.length === 1);
    await service.release(old.leaseId);
    const binding = { ...settings, endpoint: "https://replacement.fixture.invalid/comfy", instanceUuid: "pro-replacement", apiToken: "replacement-token" };
    await service.saveSettings(binding);
    const current = await service.acquire({ ...input("task-two", "attempt-two"), endpoint: binding.endpoint, instanceUuid: binding.instanceUuid });
    first.resolve("running"); await until(() => secondReads === 1);
    expect((await service.heartbeat(current.leaseId)).phase).toBe("starting");
    expect(platform.powerOn).not.toHaveBeenCalled();
    replacement.resolve("shutdown"); await service.tick();
    expect(platform.powerOn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceUuid: binding.instanceUuid, apiToken: "" }));
    expect((await service.heartbeat(current.leaseId)).phase).toBe("ready");
  });
  it("ignores a previous pairing's ready response until the current pairing has queried the instance", async () => {
    const { service, platform, changePairing } = await fixture(); const first = deferredValue<string>(), corrected = deferredValue<string>();
    let correctedReads = 0;
    platform.status.mockImplementationOnce(async () => first.promise);
    platform.status.mockImplementation(async () => ++correctedReads === 1 ? corrected.promise : "running");
    const lease = await service.acquire(input()); await until(() => platform.status.mock.calls.length === 1);
    changePairing();
    first.resolve("running"); await until(() => correctedReads === 1);
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("starting");
    corrected.resolve("running"); await service.tick();
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("ready");
  });
  it("does not let an old pairing's shutdown confirmation clear the new operation's pending stop", async () => {
    const { service, platform, changePairing } = await fixture();
    const lease = await service.acquire(input()); await service.tick();
    const oldStatus = deferredValue<string>(), correctedStatus = deferredValue<string>();
    let correctedReads = 0;
    platform.powerOff.mockResolvedValue(undefined);
    platform.status.mockImplementationOnce(async () => oldStatus.promise);
    platform.status.mockImplementation(async () => { correctedReads++; return correctedStatus.promise; });
    await service.release(lease.leaseId); await until(() => platform.powerOff.mock.calls.length === 1);
    changePairing(); oldStatus.resolve("shutdown"); await until(() => correctedReads === 1);
    expect((await service.status()).pendingStop).toBe(true);
    correctedStatus.resolve("shutdown"); await service.tick(); expect((await service.status()).pendingStop).toBe(false);
  });
  it("does not reuse an idle read-only running check when the first task arrives after shutdown", async () => {
    const { service, platform, setPower } = await fixture(); setPower("running");
    expect((await service.check()).phase).toBe("ready"); setPower("shutdown");
    const lease = await service.acquire(input()); expect(lease.phase).toBe("starting"); await service.tick();
    expect(platform.powerOn).toHaveBeenCalledTimes(1); expect(platform.status.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("ready");
  });
  it("persists attempt cleanup before a late acquire and retains its tombstone across token changes and restart", async () => {
    const first = await fixture();
    await first.service.release(input());
    expect(JSON.parse(await readFile(stateFile(first.root), "utf8")).leases[0]).toMatchObject({ ...input(), phase: "released" });
    await first.service.saveSettings({ ...settings, apiToken: "corrected-token" });
    expect((await first.service.acquire(input())).phase).toBe("released");
    await first.service.close();
    const restored = createAutoDLPowerService(first.root, { platform: first.platform, automaticTimer: false }); services.push(restored);
    expect((await restored.acquire(input())).phase).toBe("released"); await restored.tick();
    expect(first.platform.status).not.toHaveBeenCalled(); expect(first.platform.powerOn).not.toHaveBeenCalled(); expect(first.platform.powerOff).not.toHaveBeenCalled();
  });
  it("cleans a created lease by attempt when the acquire response was lost, without stopping another task", async () => {
    const { service, platform } = await fixture();
    const first = await service.acquire(input()), second = await service.acquire(input("task-two", "attempt-two")); await service.tick();
    await service.release(input()); await service.tick();
    expect((await service.heartbeat(first.leaseId)).phase).toBe("released"); expect(platform.powerOff).not.toHaveBeenCalled();
    await service.release(input("task-two", "attempt-two")); await service.tick();
    expect((await service.heartbeat(second.leaseId)).phase).toBe("released"); expect(platform.powerOff).toHaveBeenCalledTimes(1);
  });
  it("keeps attempt tombstones scoped to their original binding through a later rebind", async () => {
    const { service, platform } = await fixture(); await service.release(input());
    const other = { ...settings, endpoint: "https://other.fixture.invalid", instanceUuid: "pro-other" };
    await service.saveSettings(other);
    const otherInput = { ...input(), endpoint: other.endpoint, instanceUuid: other.instanceUuid };
    const lease = await service.acquire(otherInput); await service.tick();
    await expect(service.release(input())).rejects.toThrow("不匹配");
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("ready"); expect(platform.powerOff).not.toHaveBeenCalled();
    await service.release(otherInput); await service.tick();
    await service.saveSettings(settings); expect((await service.acquire(input())).phase).toBe("released"); await service.tick();
    expect(platform.powerOn).toHaveBeenCalledTimes(1);
  });
  it("keeps status and check read-only and keeps credentials out of all public DTOs", async () => {
    const { service, root, platform } = await fixture();
    const status = await service.status();
    expect(status.phase).toBe("unknown"); expect(status.message).not.toContain("已关机");
    expect(platform.status).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain(settings.apiToken);
    await service.check();
    expect(platform.status).toHaveBeenCalledTimes(1); expect(platform.powerOn).not.toHaveBeenCalled(); expect(platform.powerOff).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(stateFile(root), "utf8")).settings.apiToken).toBe("");
    if (process.platform !== "win32") expect((await stat(stateFile(root))).mode & 0o777).toBe(0o600);
    await service.saveSettings({ ...settings, apiToken: "" });
    expect(JSON.parse(await readFile(stateFile(root), "utf8")).settings.apiToken).toBe("");
  });
  it("returns unknown after reloading an idle configuration until the platform has actually been checked", async () => {
    const first = await fixture(); await first.service.check(); expect((await first.service.status()).phase).toBe("off"); await first.service.close();
    const recovered = createAutoDLPowerService(first.root, { platform: first.platform, automaticTimer: false }); services.push(recovered);
    expect((await recovered.status()).phase).toBe("unknown"); expect(first.platform.status).toHaveBeenCalledTimes(1);
    await recovered.check(); expect((await recovered.status()).phase).toBe("off");
  });
  it("allows correction of a rejected UUID when no boot was requested and no running instance was adopted", async () => {
    const { service, platform } = await fixture();
    platform.status.mockRejectedValue(new Error("instance not found"));
    const lease = await service.acquire(input()); await service.tick();
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("failed");
    expect(await service.status()).toMatchObject({ phase: "error", activeTasks: 0, pendingStop: false });
    expect(platform.powerOn).not.toHaveBeenCalled(); expect(platform.powerOff).not.toHaveBeenCalled();
    await service.saveSettings({ ...settings, instanceUuid: "pro-corrected" });
    expect((await service.status()).settings.instanceUuid).toBe("pro-corrected");
  });
  it("redacts the original request's token when settings change before that request fails", async () => {
    const { service, platform } = await fixture(); const gate = deferred();
    platform.status.mockImplementation(async () => { await gate.promise; throw new Error(`old request ${settings.apiToken}`); });
    const checking = service.check();
    await until(() => platform.status.mock.calls.length === 1);
    await service.saveSettings({ ...settings, apiToken: "new-private-token" }); gate.resolve();
    await expect(checking).rejects.toThrow("old request [已隐藏]");
  });
  it.each(["shutdown", "shutdown_by_starting_error", "shutdown_by_running_error", "migrate_failed"])("recognizes documented off state %s through a read-only check", async power => {
    const { service, platform, setPower } = await fixture(); setPower(power);
    expect((await service.check()).phase).toBe("off"); expect(platform.powerOn).not.toHaveBeenCalled(); expect(platform.powerOff).not.toHaveBeenCalled();
  });
  it.each(["shutdown_by_starting_error", "shutdown_by_running_error", "migrate_failed"])("confirms shutdown even when the platform ends in %s", async power => {
    const { service, platform, setPower } = await fixture();
    const lease = await service.acquire(input()); await service.tick();
    platform.powerOff.mockImplementation(async () => { setPower(power); });
    await service.release(lease.leaseId); await service.tick();
    expect(await service.status()).toMatchObject({ phase: "off", pendingStop: false });
  });
  it.each(["starting", "shutting_down"])("bounds waiting for an existing external %s state without claiming ownership of an unconfirmed instance", async power => {
    let now = 1000;
    const { service, platform, setPower } = await fixture({ now: () => now }); setPower(power);
    const lease = await service.acquire(input()); await service.tick();
    for (let index = 0; index < 5; index++) { now += 100_000; await service.heartbeat(lease.leaseId); await service.tick(); }
    now += 100_001; await service.heartbeat(lease.leaseId); await service.tick();
    expect((await service.heartbeat(lease.leaseId))).toMatchObject({ phase: "failed", error: expect.stringContaining("长时间未就绪") });
    expect(await service.status()).toMatchObject({ phase: "error", activeTasks: 0, pendingStop: false });
    expect(platform.powerOn).not.toHaveBeenCalled(); expect(platform.powerOff).not.toHaveBeenCalled();
    await service.saveSettings({ ...settings, instanceUuid: "pro-corrected" });
  });
  it("immediately cleans a startup error state after an accepted boot rather than waiting forever", async () => {
    const { service, platform, setPower } = await fixture();
    platform.powerOn.mockImplementation(async () => { setPower("shutdown_by_starting_error"); });
    platform.powerOff.mockResolvedValue(undefined);
    const lease = await service.acquire(input()); await service.tick();
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("failed");
    expect(platform.powerOn).toHaveBeenCalledTimes(1); expect(platform.powerOff).toHaveBeenCalledTimes(1);
    expect(await service.status()).toMatchObject({ phase: "off", pendingStop: false });
  });
  it("persists the task lease before issuing power_on and waits for running before ready", async () => {
    const { service, platform, root, setPower } = await fixture();
    platform.powerOn.mockImplementation(async () => {
      expect(JSON.parse(await readFile(stateFile(root), "utf8")).leases[0].taskId).toBe("task-one");
      setPower("starting");
    });
    const lease = await service.acquire(input());
    expect(lease.phase).toBe("starting"); await service.tick();
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("starting");
    setPower("running"); await service.tick();
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("ready");
    expect(platform.powerOn).toHaveBeenCalledTimes(1);
  });
  it("shares one boot across concurrent cards and immediately stops only after the final release", async () => {
    const { service, platform } = await fixture();
    const [first, second] = await Promise.all([service.acquire(input()), service.acquire(input("task-two", "attempt-two"))]);
    await service.tick(); expect(platform.powerOn).toHaveBeenCalledTimes(1);
    expect((await service.status()).activeTasks).toBe(2);
    expect((await service.acquire(input())).leaseId).toBe(first.leaseId);
    await expect(service.acquire(input("task-one", "new-attempt"))).rejects.toThrow("已有正在执行");
    await service.release(first.leaseId); await service.tick(); expect(platform.powerOff).not.toHaveBeenCalled();
    await service.release(second.leaseId); await until(() => platform.powerOff.mock.calls.length === 1); await service.tick();
    expect(await service.status()).toMatchObject({ phase: "off", activeTasks: 0, pendingStop: false });
    await service.release(second.leaseId); await service.tick(); expect(platform.powerOff).toHaveBeenCalledTimes(1);
  });
  it("closes a late successful boot after the last task cancels during startup", async () => {
    const { service, platform, setPower } = await fixture();
    const gate = deferred();
    platform.powerOn.mockImplementation(async () => { await gate.promise; setPower("running"); });
    const lease = await service.acquire(input()); await until(() => platform.powerOn.mock.calls.length === 1);
    await service.release(lease.leaseId); expect((await service.status()).pendingStop).toBe(true);
    gate.resolve(); await service.tick();
    expect(platform.powerOff).toHaveBeenCalledTimes(1); expect((await service.status()).phase).toBe("off");
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("released");
  });
  it("finishes an in-flight shutdown before starting a newly acquired task", async () => {
    const { service, platform, setPower } = await fixture();
    const first = await service.acquire(input()); await service.tick();
    const gate = deferred();
    platform.powerOff.mockImplementation(async () => { await gate.promise; setPower("shutdown"); });
    await service.release(first.leaseId); await until(() => platform.powerOff.mock.calls.length === 1);
    const second = await service.acquire(input("task-two", "attempt-two"));
    expect(second.phase).toBe("starting"); expect(platform.powerOn).toHaveBeenCalledTimes(1);
    gate.resolve(); await service.tick();
    expect(platform.powerOn).toHaveBeenCalledTimes(2); expect((await service.heartbeat(second.leaseId)).phase).toBe("ready");
  });
  it("retains durable pendingStop until status confirms shutdown and retries after failure", async () => {
    const { service, platform, root, setPower } = await fixture();
    const lease = await service.acquire(input()); await service.tick();
    platform.powerOff.mockImplementation(async () => { throw new Error(`offline ${settings.apiToken}`); });
    await service.release(lease.leaseId); await service.tick();
    expect(await service.status()).toMatchObject({ phase: "stopping", pendingStop: true, error: "offline [已隐藏]" });
    expect(JSON.parse(await readFile(stateFile(root), "utf8")).pendingStop).toBe(true);
    platform.powerOff.mockResolvedValue(undefined);
    await service.retryShutdown(); expect((await service.status()).pendingStop).toBe(true);
    setPower("shutdown"); await service.retryShutdown();
    expect(await service.status()).toMatchObject({ phase: "off", pendingStop: false });
  });
  it("automatically retries pending shutdowns without a frontend request", async () => {
    const { service, platform, setPower } = await fixture({ automaticTimer: true, retryMs: 20 });
    const lease = await service.acquire(input()); await service.tick();
    platform.powerOff.mockResolvedValue(undefined);
    await service.release(lease.leaseId); await until(() => platform.powerOff.mock.calls.length >= 2);
    expect((await service.status()).pendingStop).toBe(true);
    setPower("shutdown"); await until(() => platform.powerOff.mock.calls.length >= 3); await service.tick();
    expect((await service.status()).pendingStop).toBe(false);
  });
  it("persists an uncertain boot failure, fails its lease and still attempts power_off", async () => {
    const { service, platform, setPower } = await fixture();
    platform.powerOn.mockImplementation(async () => { setPower("running"); throw new Error(`lost response ${settings.apiToken}`); });
    const lease = await service.acquire(input()); await service.tick();
    expect((await service.heartbeat(lease.leaseId))).toMatchObject({ phase: "failed", error: "lost response [已隐藏]" });
    expect(platform.powerOff).toHaveBeenCalledTimes(1); expect((await service.status()).pendingStop).toBe(false);
  });
  it("keeps another card alive when one task lease expires", async () => {
    let now = 1000;
    const { service, platform } = await fixture({ now: () => now });
    const first = await service.acquire(input()); const second = await service.acquire(input("task-two", "attempt-two")); await service.tick();
    now += 120_000; await service.heartbeat(second.leaseId); now += 60_001; await service.tick();
    expect((await service.heartbeat(first.leaseId)).phase).toBe("failed"); expect((await service.status()).activeTasks).toBe(1); expect(platform.powerOff).not.toHaveBeenCalled();
    now += 120_000; await service.tick(); expect(platform.powerOff).toHaveBeenCalledTimes(1);
  });
  it("prevents rebind or disable while leases or pending shutdown exist but still permits same-instance token repair", async () => {
    const { service, platform, setPower } = await fixture();
    const lease = await service.acquire(input()); await service.tick();
    await expect(service.saveSettings({ ...settings, instanceUuid: "pro-other" })).rejects.toThrow("不能更换");
    await expect(service.acquire({ ...input(), endpoint: "https://unrelated.invalid" })).rejects.toThrow("不匹配");
    await expect(service.saveSettings({ ...settings, enabled: false })).rejects.toMatchObject({ status: 409 });
    expect((await service.status()).settings.enabled).toBe(true);
    const next = await service.acquire(input("task-new", "attempt-new")); await service.tick();
    await service.release(lease.leaseId); await service.tick(); expect(platform.powerOff).not.toHaveBeenCalled();
    platform.powerOff.mockRejectedValue(new Error("token expired"));
    await service.release(next.leaseId); await service.tick();
    await expect(service.saveSettings({ ...settings, enabled: false })).rejects.toMatchObject({ status: 409 });
    platform.powerOff.mockImplementation(async credentials => { expect(credentials.apiToken).toBe(""); });
    await service.saveSettings({ ...settings, apiToken: "replacement-token" }); await service.tick();
    expect((await service.status()).pendingStop).toBe(true);
    expect(platform.powerOff.mock.calls.at(-1)?.[0]).toMatchObject({ apiToken: "", instanceUuid: settings.instanceUuid });
    setPower("shutdown"); await service.retryShutdown();
    await service.saveSettings({ ...settings, enabled: false }); expect((await service.status()).settings.enabled).toBe(false);
  });
  it("does not shut down an active generation on normal service disposal", async () => {
    const { service, platform } = await fixture();
    await service.acquire(input()); await service.tick(); await service.close();
    expect(platform.powerOff).not.toHaveBeenCalled();
  });
  it("preserves live recovered leases for takeover and ignores a stale attempt's release", async () => {
    const first = await fixture(); const old = await first.service.acquire(input()); await first.service.tick(); await first.service.close();
    const resumed = createAutoDLPowerService(first.root, { platform: first.platform, automaticTimer: false }); services.push(resumed);
    expect(await resumed.status()).toMatchObject({ activeTasks: 1, pendingStop: false });
    await resumed.start(); await resumed.tick(); expect(first.platform.powerOff).not.toHaveBeenCalled();
    const lease = await resumed.acquire(input("task-one", "resumed-attempt")); await resumed.tick();
    expect(lease.leaseId).not.toBe(old.leaseId); expect((await resumed.heartbeat(lease.leaseId)).phase).toBe("ready");
    await resumed.release(old.leaseId); await resumed.tick(); expect(first.platform.powerOff).not.toHaveBeenCalled();
    await resumed.release(lease.leaseId); await resumed.tick(); expect(first.platform.powerOff).toHaveBeenCalledTimes(1);
  });
  it("cleans expired recovered leases but does not let a status GET itself send power commands", async () => {
    let now = 1000;
    const first = await fixture({ now: () => now }); await first.service.acquire(input()); await first.service.tick(); await first.service.close();
    now += 180_001;
    const recovered = createAutoDLPowerService(first.root, { platform: first.platform, now: () => now, automaticTimer: false }); services.push(recovered);
    expect(await recovered.status()).toMatchObject({ activeTasks: 0, pendingStop: true }); expect(first.platform.powerOff).not.toHaveBeenCalled();
    await recovered.start(); await recovered.tick(); expect(first.platform.powerOff).toHaveBeenCalledTimes(1);
  });
  it("recovers a persisted pendingStop with a newly created manager", async () => {
    const first = await fixture(); const lease = await first.service.acquire(input()); await first.service.tick();
    first.platform.powerOff.mockRejectedValue(new Error("network unavailable")); await first.service.release(lease.leaseId); await first.service.tick(); await first.service.close();
    first.platform.powerOff.mockImplementation(async () => { first.setPower("shutdown"); });
    const recovered = createAutoDLPowerService(first.root, { platform: first.platform, automaticTimer: false }); services.push(recovered);
    await recovered.start(); await recovered.tick(); expect(await recovered.status()).toMatchObject({ pendingStop: false, phase: "off" });
  });
  it("isolates independent storage roots and never imports another workspace's credentials", async () => {
    const first = await fixture();
    const other = createAutoDLPowerService(await rootFixture(), { platform: first.platform, automaticTimer: false }); services.push(other);
    expect(await other.status()).toMatchObject({ settings: { enabled: false, tokenConfigured: false, instanceUuid: "" }, activeTasks: 0 });
    expect(first.platform.status).not.toHaveBeenCalled();
  });
  it("preserves a malformed durable file without making any platform request", async () => {
    const root = await rootFixture(); await mkdir(path.dirname(stateFile(root)), { recursive: true }); await writeFile(stateFile(root), "broken ledger");
    const platform = { status: vi.fn(), powerOn: vi.fn(), powerOff: vi.fn() };
    const service = createAutoDLPowerService(root, { platform, automaticTimer: false }); services.push(service);
    await expect(service.acquire(input())).rejects.toThrow("状态文件无法读取");
    expect(await readFile(stateFile(root), "utf8")).toBe("broken ledger"); expect(platform.powerOn).not.toHaveBeenCalled(); expect(platform.powerOff).not.toHaveBeenCalled();
  });
});
