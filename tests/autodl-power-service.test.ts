import { EventEmitter } from "node:events";
import type { request as HTTPSRequest } from "node:https";
import fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutoDLPlatform, createAutoDLPowerService, type AutoDLPlatform, type AutoDLPowerService } from "../scripts/autodl-power-service";

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
async function fixture(options: { root?: string; platform?: AutoDLPlatform; now?: () => number; automaticTimer?: boolean; retryMs?: number } = {}) {
  const root = options.root ?? await rootFixture();
  let power = "shutdown";
  const platform = {
    status: vi.fn(async (_credentials: { apiToken: string; instanceUuid: string }) => power),
    powerOn: vi.fn(async (_credentials: { apiToken: string; instanceUuid: string }) => { power = "running"; }),
    powerOff: vi.fn(async (_credentials: { apiToken: string; instanceUuid: string }) => { power = "shutdown"; }),
  };
  const service = createAutoDLPowerService(root, { platform: options.platform ?? platform, automaticTimer: false, ...options });
  services.push(service);
  await service.saveSettings(settings);
  return { root, service, platform, setPower: (value: string) => { power = value; } };
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

describe("AutoDL platform transport", () => {
  function transport(packets: unknown[] = [{ code: "Success", data: "running" }, { code: "Success", data: null }, { code: "Success", data: null }]) {
    const calls: { url: URL; options: any; body: string; timeout?: number }[] = [];
    const requester = ((url: URL, options: unknown, callback: (response: EventEmitter) => void) => {
      const request = new EventEmitter() as EventEmitter & { setTimeout: (timeout: number, fn: () => void) => void; end: (body: Buffer) => void; destroy: (error?: Error) => void };
      const call = { url, options, body: "", timeout: 0 }; calls.push(call);
      request.setTimeout = timeout => { call.timeout = timeout; };
      request.destroy = error => { request.emit("error", error); };
      request.end = body => {
        call.body = body.toString("utf8");
        queueMicrotask(() => {
          const response = new EventEmitter() as EventEmitter & { statusCode: number; destroy: (error: Error) => void };
          response.statusCode = 200; response.destroy = error => { response.emit("error", error); };
          callback(response);
          response.emit("data", Buffer.from(JSON.stringify(packets.shift()))); response.emit("end");
        });
      };
      return request;
    }) as unknown as typeof HTTPSRequest;
    return { calls, api: createAutoDLPlatform(requester) };
  }
  it("uses only the official host, raw Authorization and the documented GET JSON status body", async () => {
    const { api, calls } = transport();
    expect(await api.status(settings)).toBe("running");
    await api.powerOn(settings); await api.powerOff(settings);
    expect(calls.map(call => call.url.href)).toEqual(["status", "power_on", "power_off"].map(route => "https://www.autodl.art/api/v1/adl_dev/dev/instance/pro/" + route));
    expect(calls.map(call => call.options.method)).toEqual(["GET", "POST", "POST"]);
    expect(calls.map(call => JSON.parse(call.body))).toEqual([{ instance_uuid: settings.instanceUuid }, { instance_uuid: settings.instanceUuid, payload: "gpu" }, { instance_uuid: settings.instanceUuid }]);
    for (const call of calls) {
      expect(call.options.headers.Authorization).toBe(settings.apiToken);
      expect(call.options.headers["Content-Length"]).toBe(Buffer.byteLength(call.body));
    }
    expect(JSON.stringify(calls)).not.toContain("force");
    expect(calls.every(call => !call.url.pathname.endsWith("/release"))).toBe(true);
  });
  it("does not expose an echoed developer token from a rejected platform response", async () => {
    const { api } = transport([{ code: "Denied", msg: `invalid ${settings.apiToken}` }]);
    await expect(api.status(settings)).rejects.toThrow("invalid [已隐藏]");
  });
  it("requires the actual string status rather than treating a success packet as a power state", async () => {
    const { api } = transport([{ code: "Success", data: null }]);
    await expect(api.status(settings)).rejects.toThrow("状态无效");
  });
});

describe("durable AutoDL task leases", () => {
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
    expect(platform.powerOn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instanceUuid: binding.instanceUuid, apiToken: binding.apiToken }));
    expect((await service.heartbeat(current.leaseId)).phase).toBe("ready");
  });
  it("ignores an old token's ready response until the corrected token has queried the instance", async () => {
    const { service, platform } = await fixture(); const first = deferredValue<string>(), corrected = deferredValue<string>();
    let correctedReads = 0;
    platform.status.mockImplementation(async credentials => credentials.apiToken === settings.apiToken ? first.promise : ++correctedReads === 1 ? corrected.promise : "running");
    const lease = await service.acquire(input()); await until(() => platform.status.mock.calls.length === 1);
    await service.saveSettings({ ...settings, apiToken: "corrected-token" });
    first.resolve("running"); await until(() => correctedReads === 1);
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("starting");
    corrected.resolve("running"); await service.tick();
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("ready");
  });
  it("does not fail the current attempt when a boot sent with the old token is rejected late", async () => {
    const { service, platform, setPower } = await fixture(); const oldBoot = deferred();
    platform.powerOn.mockImplementation(async credentials => {
      if (credentials.apiToken === settings.apiToken) { await oldBoot.promise; throw new Error("old token rejected"); }
      setPower("running");
    });
    const lease = await service.acquire(input()); await until(() => platform.powerOn.mock.calls.length === 1);
    await service.saveSettings({ ...settings, apiToken: "corrected-token" }); oldBoot.resolve(); await service.tick();
    expect(platform.powerOn).toHaveBeenCalledTimes(2);
    expect(platform.powerOn.mock.calls[1][0].apiToken).toBe("corrected-token");
    expect((await service.heartbeat(lease.leaseId)).phase).toBe("ready"); expect(platform.powerOff).not.toHaveBeenCalled();
  });
  it("does not let an old-token shutdown confirmation clear the corrected operation's pending stop", async () => {
    const { service, platform } = await fixture();
    const lease = await service.acquire(input()); await service.tick();
    const oldStatus = deferredValue<string>(), correctedStatus = deferredValue<string>();
    let correctedReads = 0;
    platform.powerOff.mockResolvedValue(undefined);
    platform.status.mockImplementation(async credentials => credentials.apiToken === settings.apiToken ? oldStatus.promise : (++correctedReads, correctedStatus.promise));
    await service.release(lease.leaseId); await until(() => platform.powerOff.mock.calls.length === 1);
    await service.saveSettings({ ...settings, apiToken: "corrected-token" }); oldStatus.resolve("shutdown"); await until(() => correctedReads === 1);
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
    expect(JSON.parse(await readFile(stateFile(root), "utf8")).settings.apiToken).toBe(settings.apiToken);
    if (process.platform !== "win32") expect((await stat(stateFile(root))).mode & 0o777).toBe(0o600);
    await service.saveSettings({ ...settings, apiToken: "" });
    expect(JSON.parse(await readFile(stateFile(root), "utf8")).settings.apiToken).toBe(settings.apiToken);
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
    platform.powerOff.mockImplementation(async credentials => { expect(credentials.apiToken).toBe("replacement-token"); });
    await service.saveSettings({ ...settings, apiToken: "replacement-token" }); await service.tick();
    expect((await service.status()).pendingStop).toBe(true);
    expect(platform.powerOff.mock.calls.at(-1)?.[0]).toMatchObject({ apiToken: "replacement-token", instanceUuid: settings.instanceUuid });
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
