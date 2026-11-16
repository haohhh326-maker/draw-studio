import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCleanupAction } from "../src/comfyui/memory-cleanup";
import { ComfyUIClient } from "../src/comfyui/client";
import { defaultConnection } from "../src/workflow/catalog";
import { clearCommunicationLog, communicationSnapshot } from "../src/comfyui/diagnostics";
import type { Connection } from "../src/types";

const connection = { ...defaultConnection, baseUrl: "https://compute.example/canvas/comfy", token: "secret-auth" };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const idle = { queue_running: [], queue_pending: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(callback => { resolve = callback; }); return { promise, resolve }; }
function setup(initial: Connection = connection) {
  let current = { ...initial };
  const listeners = new Set<() => void>(), notify = vi.fn(), busy = vi.fn();
  const action = new MemoryCleanupAction({ connection: () => current, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, notify, busy });
  return { action, notify, busy, listeners, change: (next: Partial<Connection>) => { current = { ...current, ...next }; for (const listener of listeners) listener(); } };
}
afterEach(() => { vi.unstubAllGlobals(); clearCommunicationLog(); });

describe("standalone memory cleanup action", () => {
  it("checks a fresh queue, uses existing authentication and only reports that cleanup was requested", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ Authorization: "Bearer secret-auth" });
      if (url.endsWith("/queue")) return json(idle);
      expect(url).toBe(connection.baseUrl + "/free"); expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ unload_models: true, free_memory: true }); return new Response(null);
    }); vi.stubGlobal("fetch", fetcher);
    const fixture = setup(); await fixture.action.run();
    expect(fixture.notify).toHaveBeenCalledWith("已向工作站请求卸载模型并清理内存 / 显存。");
    expect(fixture.busy.mock.calls).toEqual([[true], [false]]); expect(fixture.listeners.size).toBe(0);
    expect(communicationSnapshot().slice(-4).map(item => item.route)).toEqual(["/queue", "/queue", "/free", "/free"]);
    expect(JSON.stringify(communicationSnapshot())).not.toContain("secret-auth");
  });

  it("does not submit duplicate requests while the first queue check is pending", async () => {
    const gate = deferred<Response>();
    const fetcher = vi.fn(async (url: string) => url.endsWith("/queue") ? gate.promise : new Response(null)); vi.stubGlobal("fetch", fetcher);
    const fixture = setup(), first = fixture.action.run(); await fixture.action.run();
    expect(fetcher).toHaveBeenCalledTimes(1); gate.resolve(json(idle)); await first;
    expect(fetcher).toHaveBeenCalledTimes(2); expect(fixture.notify).toHaveBeenCalledTimes(1);
  });

  it.each([{ queue_running: [[1, "running"]], queue_pending: [] }, { queue_running: [], queue_pending: [[1, "pending"]] }])("refuses cleanup while any task is running or waiting", async value => {
    const fetcher = vi.fn(async () => json(value)); vi.stubGlobal("fetch", fetcher);
    const fixture = setup(); await fixture.action.run();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining("队列清空"));
    expect(fixture.busy.mock.calls).toEqual([[true], [false]]);
  });

  it("aborts before /free when the selected connection changes during queue retrieval", async () => {
    const gate = deferred<Response>(); const fetcher = vi.fn(async () => gate.promise); vi.stubGlobal("fetch", fetcher);
    const fixture = setup(), operation = fixture.action.run();
    fixture.change({ baseUrl: "https://other.example/comfy" }); gate.resolve(json(idle)); await operation;
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fixture.notify).toHaveBeenCalledWith("连接已切换，上一连接的清理结果未确认。");
  });

  it("does not report old-server success when a connection changes after /free has been submitted", async () => {
    const gate = deferred<Response>(); let submitted!: () => void; const submission = new Promise<void>(resolve => { submitted = resolve; });
    const fetcher = vi.fn(async (url: string) => { if (url.endsWith("/queue")) return json(idle); submitted(); return gate.promise; }); vi.stubGlobal("fetch", fetcher);
    const fixture = setup(), operation = fixture.action.run(); await submission;
    fixture.change({ token: "new-token" }); gate.resolve(new Response(null)); await operation;
    expect(fixture.notify).toHaveBeenCalledTimes(1); expect(fixture.notify).toHaveBeenCalledWith("连接已切换，上一连接的清理结果未确认。");
    expect(fixture.listeners.size).toBe(0);
  });

  it("ignores a connection name change because it leaves server identity intact", async () => {
    const gate = deferred<Response>(); const fetcher = vi.fn(async (url: string) => url.endsWith("/queue") ? gate.promise : new Response(null)); vi.stubGlobal("fetch", fetcher);
    const fixture = setup(), operation = fixture.action.run(); fixture.change({ name: "Renamed" }); gate.resolve(json(idle)); await operation;
    expect(fetcher).toHaveBeenCalledTimes(2); expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining("已向工作站请求"));
  });

  it("aborts an unmounted action and prevents late notifications or state updates", async () => {
    const gate = deferred<Response>(); const fetcher = vi.fn(async () => gate.promise); vi.stubGlobal("fetch", fetcher);
    const fixture = setup(), operation = fixture.action.run(); fixture.action.dispose();
    expect(fixture.listeners.size).toBe(0); gate.resolve(json(idle)); await operation; await fixture.action.run();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fixture.notify).not.toHaveBeenCalled(); expect(fixture.busy.mock.calls).toEqual([[true]]);
  });

  it("shows an HTTP failure instead of success and permits a later retry", async () => {
    let attempt = 0;
    const fetcher = vi.fn(async (url: string) => url.endsWith("/queue") ? json(idle) : ++attempt === 1 ? new Response("private server details", { status: 503 }) : new Response(null)); vi.stubGlobal("fetch", fetcher);
    const fixture = setup(); await fixture.action.run();
    expect(fixture.notify).toHaveBeenLastCalledWith("清理请求失败（HTTP 503），请稍后重试。");
    await fixture.action.run(); expect(fixture.notify).toHaveBeenLastCalledWith(expect.stringContaining("已向工作站请求"));
    expect(JSON.stringify(fixture.notify.mock.calls)).not.toContain("private server details");
  });

  it("does not submit malformed queues or an empty service address", async () => {
    const fetcher = vi.fn(async () => json({ queue_running: [], queue_pending: null })); vi.stubGlobal("fetch", fetcher);
    await expect(new ComfyUIClient(connection).freeMemory()).rejects.toThrow("执行队列格式无效"); expect(fetcher).toHaveBeenCalledTimes(1);
    const fixture = setup({ ...connection, baseUrl: "" }); await fixture.action.run();
    expect(fixture.notify).toHaveBeenCalledWith("请先填写 ComfyUI 服务地址。"); expect(fixture.busy).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
