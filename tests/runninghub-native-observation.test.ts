import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection, TaskState } from "../src/types";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
import { ComfyUIClient, type History } from "../src/comfyui/client";

const connection: Connection = { name: "Native fixture", baseUrl: "https://www.runninghub.cn/proxy", token: "fixture-observation-key", authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 0 };
const finished: History = { status: { status_str: "success" }, outputs: { "92": { images: [{ filename: "result.mp4", type: "output" }] } } };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

class Socket {
  static instances: Socket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  messages: string[] = [];
  constructor(readonly url: URL) { Socket.instances.push(this); }
  send(value: string) { this.messages.push(value); }
  close() { this.closed = true; this.onclose?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  ready() { this.onopen?.(); this.message({ type: "rh_native_ready" }); }
  static last() { return Socket.instances.at(-1)!; }
}

async function connected() {
  const client = new ComfyUIClient(connection);
  const pending = client.connect(); Socket.last().ready(); await pending;
  return client;
}

beforeEach(() => {
  vi.useFakeTimers(); Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Real requests are forbidden in observation tests"); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("RunningHub native observation after realtime disconnect", () => {
  it("keeps polling and retains real progress while a single reconnect is pending", async () => {
    const client = await connected();
    Socket.last().message({ type: "progress", data: { prompt_id: "task", node: "92", value: 6, max: 10 } });
    Socket.last().close();
    const history = vi.spyOn(client, "getHistory").mockResolvedValue({});
    const queue = vi.spyOn(client, "getQueue").mockResolvedValue({ queue_running: [[0, "task"]], queue_pending: [] });
    const states: Partial<TaskState>[] = [];
    const observed = client.waitForCompletion("task", state => states.push(state), new AbortController().signal);
    await tick();
    expect(Socket.instances).toHaveLength(2);
    expect(states.at(-1)).toMatchObject({ status: "generating", execution: { nodeId: "92", value: 6, max: 10 } });
    expect(states.at(-1)).not.toHaveProperty("progress");
    await vi.advanceTimersByTimeAsync(3000);
    expect(history).toHaveBeenCalledTimes(3); expect(queue).toHaveBeenCalledTimes(3);
    expect(Socket.instances).toHaveLength(2);
    const reconnect = Socket.last();
    history.mockResolvedValue({ task: finished });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await observed).toEqual(finished);
    expect(reconnect.closed).toBe(true); expect(reconnect.onmessage).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores events after reconnect and checks history immediately on execution_success", async () => {
    const client = await connected(); Socket.last().close();
    const history = vi.spyOn(client, "getHistory").mockResolvedValue({});
    vi.spyOn(client, "getQueue").mockResolvedValue({ queue_running: [[0, "task"]], queue_pending: [] });
    const states: Partial<TaskState>[] = [];
    const observed = client.waitForCompletion("task", state => states.push(state), new AbortController().signal);
    await tick();
    const reconnect = Socket.last(); reconnect.ready(); await tick();
    expect(states.at(-1)).toMatchObject({ details: undefined });
    reconnect.message({ type: "progress", data: { prompt_id: "task", node: "92", value: 7, max: 10 } });
    expect(states.at(-1)).toMatchObject({ progress: 70, execution: { nodeId: "92", value: 7, max: 10 } });
    expect(history).toHaveBeenCalledTimes(1);
    history.mockResolvedValue({ task: finished });
    reconnect.message({ type: "execution_success", data: { prompt_id: "task" } });
    expect(await observed).toEqual(finished);
    expect(history).toHaveBeenCalledTimes(2);
    expect(reconnect.closed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let another task's success wake this task's history query", async () => {
    const client = await connected();
    const history = vi.spyOn(client, "getHistory").mockResolvedValue({});
    const controller = new AbortController();
    const observed = client.waitForCompletion("task", () => {}, controller.signal);
    const rejected = expect(observed).rejects.toMatchObject({ name: "AbortError" });
    await tick();
    Socket.last().message({ type: "execution_success", data: { prompt_id: "different-task" } });
    await tick(); expect(history).toHaveBeenCalledTimes(1);
    controller.abort(); await rejected; client.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed reconnect on the next poll rather than spinning or starting parallel connections", async () => {
    const client = await connected(); Socket.last().close();
    vi.spyOn(client, "getHistory").mockResolvedValue({});
    vi.spyOn(client, "getQueue").mockResolvedValue({ queue_running: [[0, "task"]], queue_pending: [] });
    const controller = new AbortController();
    const observed = client.waitForCompletion("task", () => {}, controller.signal);
    const rejected = expect(observed).rejects.toMatchObject({ name: "AbortError" });
    await tick(); Socket.last().onerror?.(); await tick();
    expect(Socket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(Socket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(Socket.instances).toHaveLength(3);
    const reconnect = Socket.last(); controller.abort(); await rejected;
    expect(reconnect.closed).toBe(true); expect(reconnect.onmessage).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops reconnect attempts after an explicit disconnect while HTTP observation can continue", async () => {
    const client = await connected(); Socket.last().close();
    const history = vi.spyOn(client, "getHistory").mockResolvedValue({});
    vi.spyOn(client, "getQueue").mockResolvedValue({ queue_running: [[0, "task"]], queue_pending: [] });
    const controller = new AbortController();
    const observed = client.waitForCompletion("task", () => {}, controller.signal);
    const rejected = expect(observed).rejects.toMatchObject({ name: "AbortError" });
    await tick(); const reconnect = Socket.last(); client.disconnect(); await tick();
    expect(reconnect.closed).toBe(true); expect(reconnect.onmessage).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(Socket.instances).toHaveLength(2); expect(history).toHaveBeenCalledTimes(3);
    controller.abort(); await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears obsolete node progress only when the task is actually pending again", async () => {
    const client = await connected();
    Socket.last().message({ type: "progress", data: { prompt_id: "task", node: "92", value: 6, max: 10 } }); Socket.last().close();
    vi.spyOn(client, "getHistory").mockResolvedValue({});
    vi.spyOn(client, "getQueue").mockResolvedValue({ queue_running: [], queue_pending: [[0, "task"]] });
    const states: Partial<TaskState>[] = [], controller = new AbortController();
    const observed = client.waitForCompletion("task", state => states.push(state), controller.signal);
    const rejected = expect(observed).rejects.toMatchObject({ name: "AbortError" });
    await tick();
    expect(states.at(-1)).toMatchObject({ status: "queued", progress: undefined, execution: { nodeId: undefined, value: undefined, max: undefined, queueRemaining: 1 } });
    controller.abort(); await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
