import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AutoDLExtensionBroker, AUTODL_EXTENSION_ORIGIN, isAutoDLBridgeRequest, type AutoDLBridgeCommand, type AutoDLExtensionBrokerOptions } from "../scripts/autodl-extension-broker";

const roots: string[] = [], brokers: AutoDLExtensionBroker[] = [];
const uuid = "pro-fixture";
async function fixture(options: AutoDLExtensionBrokerOptions = {}, existing?: string) {
  const root = existing ?? await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "canvas-autodl-broker-"));
  if (!existing) roots.push(root);
  const broker = new AutoDLExtensionBroker(root, { pollMs: 15, commandMs: 500, ...options }); brokers.push(broker);
  return { root, broker };
}
async function pair(broker: AutoDLExtensionBroker) { const { code } = await broker.pairCode(); return (await broker.pair({ code })).bridgeKey; }
const command = (value: AutoDLBridgeCommand | { idle: true }) => { if (!("id" in value)) throw new Error("Expected bridge command"); return value; };
async function idle(broker: AutoDLExtensionBroker, bridgeKey: string) { expect(await broker.poll({ bridgeKey })).toEqual({ idle: true }); }
afterEach(async () => {
  for (const broker of brokers.splice(0)) await broker.close();
  const temporary = await fs.realpath(os.tmpdir());
  for (const root of roots.splice(0)) {
    if (path.dirname(await fs.realpath(root)) !== temporary || !path.basename(root).startsWith("canvas-autodl-broker-")) throw new Error("Unrelated fixture cleanup");
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("AutoDL extension authorization", () => {
  it("permits only exact fixed-extension loopback bridge POST/preflight requests", () => {
    const valid = { url: "/__canvas/autodl/bridge/poll", method: "POST", headers: { origin: AUTODL_EXTENSION_ORIGIN, host: "127.0.0.1:1420" }, socket: { remoteAddress: "127.0.0.1" } } as any;
    expect(isAutoDLBridgeRequest(valid)).toBe(true); expect(isAutoDLBridgeRequest({ ...valid, method: "OPTIONS" })).toBe(true);
    for (const request of [
      { ...valid, method: "GET" }, { ...valid, url: valid.url + "?x=1" }, { ...valid, url: "/__canvas/autodl/pair-code" },
      { ...valid, headers: { ...valid.headers, origin: "https://www.autodl.art" } },
      { ...valid, headers: { ...valid.headers, origin: AUTODL_EXTENSION_ORIGIN + ".evil" } },
      { ...valid, headers: { ...valid.headers, host: "127.0.0.1.evil.invalid:1420" } },
      { ...valid, socket: { remoteAddress: "203.0.113.10" } },
    ]) expect(isAutoDLBridgeRequest(request)).toBe(false);
  });
  it("creates an expiring one-time code and persists only the random bridge key in a private file", async () => {
    let now = 1000; const { root, broker } = await fixture({ now: () => now });
    expect(await broker.session()).toMatchObject({ status: "disconnected" });
    const first = await broker.pairCode(); expect(first.code).toMatch(/^[A-F0-9]{8}$/); expect(first.expiresAt).toBe(now + 300_000);
    now += 300_001; await expect(broker.pair({ code: first.code })).rejects.toMatchObject({ status: 401 });
    const next = await broker.pairCode(), paired = await broker.pair({ code: next.code.toLowerCase() }); expect(paired.bridgeKey).toMatch(/^[a-f0-9]{64}$/);
    await expect(broker.pair({ code: next.code })).rejects.toMatchObject({ status: 401 });
    const file = path.join(root, ".cache/autodl-power/bridge.json");
    expect((await fs.readFile(file, "utf8"))).not.toContain(next.code);
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await broker.close(); const restored = (await fixture({}, root)).broker; await idle(restored, paired.bridgeKey);
  });
  it("limits failed pairing attempts and never accepts another root's key", async () => {
    const first = await fixture(), second = await fixture(); const code = await first.broker.pairCode();
    const wrong = code.code === "00000000" ? "11111111" : "00000000";
    for (let index = 0; index < 5; index++) await expect(first.broker.pair({ code: wrong })).rejects.toMatchObject({ status: 401 });
    await expect(first.broker.pair({ code: code.code })).rejects.toMatchObject({ status: 401 });
    const key = await pair(first.broker); await expect(second.broker.poll({ bridgeKey: key })).rejects.toMatchObject({ status: 401 });
  });
  it("replaces the sole pairing and invalidates the earlier key", async () => {
    const { broker } = await fixture(); const first = await pair(broker), second = await pair(broker);
    expect(second).not.toBe(first); await expect(broker.poll({ bridgeKey: first })).rejects.toMatchObject({ status: 401 }); await idle(broker, second);
  });
});

describe("fixed-operation bridge transactions", () => {
  it("keeps a pending poll waiting until a fixed UUID command is queued and validates its response", async () => {
    const { broker } = await fixture(); const bridgeKey = await pair(broker);
    const polling = broker.poll({ bridgeKey }), response = broker.call("status", uuid);
    const task = command(await polling); expect(task).toMatchObject({ operation: "status", instanceUuid: uuid }); expect(task.expiresAt).toBeGreaterThan(Date.now());
    await broker.result({ bridgeKey, id: task.id, ok: true, value: { status: "running" } }); expect(await response).toEqual({ status: "running" });
    await expect(broker.result({ bridgeKey, id: task.id, ok: true, value: { status: "running" } })).rejects.toMatchObject({ status: 409 });
  });
  it("never repeats a delivered power-on after a lost reply, timeout or process restart", async () => {
    const { root, broker } = await fixture({ commandMs: 70 }); const bridgeKey = await pair(broker);
    const polling = broker.poll({ bridgeKey }), response = broker.call("power-on", uuid);
    const timeout = expect(response).rejects.toMatchObject({ code: "COMMAND_TIMEOUT", dispatched: true });
    const task = command(await polling); expect(task.operation).toBe("power-on"); await idle(broker, bridgeKey); await timeout;
    await expect(broker.result({ bridgeKey, id: task.id, ok: true, value: { accepted: true } })).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse(await fs.readFile(path.join(root, ".cache/autodl-power/last-command.json"), "utf8"))).toMatchObject({ id: task.id, state: "offered" });
    await broker.close(); const restored = (await fixture({}, root)).broker; await idle(restored, bridgeKey);
  });
  it("distinguishes an expired command that was never dispatched", async () => {
    const { broker } = await fixture({ commandMs: 40 }); const bridgeKey = await pair(broker); await idle(broker, bridgeKey);
    await expect(broker.call("power-on", uuid)).rejects.toMatchObject({ code: "COMMAND_TIMEOUT", dispatched: false });
    await idle(broker, bridgeKey);
  });
  it("requires exact safe result fields rather than accepting website credentials or raw objects", async () => {
    const { broker } = await fixture(); const bridgeKey = await pair(broker);
    const polling = broker.poll({ bridgeKey }), response = broker.call("list");
    const rejected = expect(response).rejects.toMatchObject({ code: "CONTRACT_ERROR" }); const task = command(await polling);
    await expect(broker.result({ bridgeKey, id: task.id, ok: true, value: { instances: [{ instanceUuid: uuid, name: "Fixture", status: "running", root_password: "must-not-leave-website" }] } })).rejects.toMatchObject({ code: "CONTRACT_ERROR" });
    await rejected;
  });
  it("rejects unknown operations and arbitrary instance targets before dispatch", async () => {
    const { broker } = await fixture(); await expect(broker.call("force" as any, uuid)).rejects.toMatchObject({ status: 400 });
    await expect(broker.call("power-on", "https://attacker.invalid")).rejects.toMatchObject({ status: 400 });
  });
  it("serializes polls and cleans up an abandoned long poll", async () => {
    const { broker } = await fixture(); const bridgeKey = await pair(broker), abort = new AbortController();
    const waiting = broker.poll({ bridgeKey }, abort.signal), stopped = expect(waiting).rejects.toMatchObject({ status: 499 });
    await expect(broker.poll({ bridgeKey })).rejects.toMatchObject({ status: 409 }); abort.abort(); await stopped; await idle(broker, bridgeKey);
  });
  it("reports connected only after a successful website read and shares the short UI cache", async () => {
    let now = 1000; const { broker } = await fixture({ now: () => now }); const bridgeKey = await pair(broker);
    const polling = broker.poll({ bridgeKey }), session = broker.session(), listing = broker.instances();
    const task = command(await polling); expect(task.operation).toBe("list");
    const value = { instances: [{ instanceUuid: uuid, name: "Fixture", status: "shutdown" }] };
    await broker.result({ bridgeKey, id: task.id, ok: true, value }); expect(await session).toMatchObject({ status: "connected" }); expect(await listing).toEqual(value);
    expect(await broker.instances()).toEqual(value); await idle(broker, bridgeKey);
    now += 3001;
    const nextPoll = broker.poll({ bridgeKey }), expired = broker.session(); const next = command(await nextPoll);
    await broker.result({ bridgeKey, id: next.id, ok: false, errorCode: "LOGIN_REQUIRED" }); expect(await expired).toMatchObject({ status: "login-required" });
    now += 45_001; expect(await broker.session()).toMatchObject({ status: "disconnected" });
  });
  it("accepts only controlled error codes and does not relay raw website error messages", async () => {
    const { broker } = await fixture(); const bridgeKey = await pair(broker);
    const polling = broker.poll({ bridgeKey }), response = broker.call("power-on", uuid);
    const rejected = expect(response).rejects.toMatchObject({ code: "POWER_REJECTED", definitive: true }); const task = command(await polling);
    await broker.result({ bridgeKey, id: task.id, ok: false, errorCode: "POWER_REJECTED" }); await rejected;
  });
  it.each([
    ["COMMAND_EXPIRED", false, true, "rejected", "请求已过期"],
    ["POWER_STATE_CONFLICT", true, false, "unknown", "平台实例状态发生冲突"],
    ["POWER_UNKNOWN", true, false, "unknown", "平台未确认操作结果"],
    ["NO_GPU_CAPACITY", true, true, "rejected", "当前算力规格暂无库存"],
    ["INSUFFICIENT_BALANCE", true, true, "rejected", "AutoDL.Art 余额不足"],
    ["INSTANCE_EXPIRED", true, true, "rejected", "AutoDL.Art 实例已到期"],
  ])("records the safe %s diagnostic and any platform request ID", async (code, dispatched, definitive, state, detail) => {
    const { broker, root } = await fixture(); const bridgeKey = await pair(broker);
    const polling = broker.poll({ bridgeKey }), response = broker.call("power-on", uuid);
    const requestId = "b8b164cef57aa469889781675bb1e4d7";
    const rejected = response.catch(error => error);
    const task = command(await polling);
    await broker.result({ bridgeKey, id: task.id, ok: false, errorCode: code, remoteCode: "InternalError", httpStatus: 200, requestId });
    const error = await rejected;
    expect(error).toMatchObject({ code, dispatched, definitive, remoteCode: "InternalError", httpStatus: 200, requestId });
    expect(error.message).toContain(detail);
    expect(error.message).toContain("（平台码 InternalError，HTTP 200，请求 ID " + requestId + "）");
    const saved = await fs.readFile(path.join(root, ".cache/autodl-power/last-command.json"), "utf8");
    expect(JSON.parse(saved)).toMatchObject({ operation: "power-on", state, errorCode: code, remoteCode: "InternalError", httpStatus: 200, requestId });
    expect(saved).not.toContain(bridgeKey);
  });
  it.each([
    ["sk-fixture-sensitive", 600], ["a7B9c3D5e7F9g1H3i5J7k9L1m3N5", "200"], ["deadbeefdeadbeef", 99], ["business code with spaces", null],
  ])("discards unsafe platform diagnostics instead of echoing or persisting them %#", async (remoteCode, httpStatus) => {
    const { broker, root } = await fixture(); const bridgeKey = await pair(broker);
    const polling = broker.poll({ bridgeKey }), response = broker.call("power-off", uuid);
    const rejected = response.catch(error => error); const task = command(await polling);
    await broker.result({ bridgeKey, id: task.id, ok: false, errorCode: "POWER_UNKNOWN", remoteCode, httpStatus, requestId: bridgeKey });
    const error = await rejected;
    expect(error).toMatchObject({ code: "POWER_UNKNOWN", definitive: false, remoteCode: undefined, httpStatus: undefined, requestId: undefined });
    expect(error.message).toContain("关闭 AutoDL"); expect(error.message).not.toContain(String(remoteCode));
    expect(error.message).not.toContain(bridgeKey);
    const saved = await fs.readFile(path.join(root, ".cache/autodl-power/last-command.json"), "utf8");
    expect(saved).not.toContain(String(remoteCode)); expect(JSON.parse(saved)).not.toHaveProperty("httpStatus");
    expect(saved).not.toContain(bridgeKey); expect(JSON.parse(saved)).not.toHaveProperty("requestId");
  });
  it.each([{ remoteCode: "InternalError" }, { requestId: "b8b164cef57aa469889781675bb1e4d7" }])("does not accept error diagnostics on a successful result %j", async diagnostics => {
    const { broker } = await fixture(); const bridgeKey = await pair(broker);
    const polling = broker.poll({ bridgeKey }), response = broker.call("power-on", uuid);
    const rejected = expect(response).rejects.toMatchObject({ code: "CONTRACT_ERROR" }); const task = command(await polling);
    await expect(broker.result({ bridgeKey, id: task.id, ok: true, value: { accepted: true }, ...diagnostics })).rejects.toMatchObject({ code: "CONTRACT_ERROR" });
    await rejected;
  });
});
