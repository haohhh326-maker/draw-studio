import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { autoDLTaskPower } from "../src/autodl/client";
import type { AutoDLLease } from "../src/autodl/types";
import type { Connection } from "../src/types";

const connection: Connection = { name: "AutoDL", baseUrl: "https://comfy.example", token: "comfy-access-token",
  authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 60, autodl: { instanceUuid: "pro-fixture" } };
const ready: AutoDLLease = { leaseId: "lease-fixture", instanceUuid: "pro-fixture", phase: "ready" };
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("window", globalThis); vi.stubGlobal("fetch", fetcher); fetcher.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("leaves ordinary ComfyUI connections outside automatic power management", async () => {
  const { autodl: _, ...ordinary } = connection;
  expect(await autoDLTaskPower(ordinary, { taskId: "task", attemptId: "attempt", signal: new AbortController().signal, onStatus: vi.fn() })).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps a ready task alive and releases only once without forwarding the ComfyUI credential", async () => {
  fetcher.mockImplementation(async () => Response.json(ready));
  const handle = await autoDLTaskPower(connection, { taskId: "task", attemptId: "attempt", signal: new AbortController().signal, onStatus: vi.fn() });
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/heartbeat"))).toBe(true);
  await Promise.all([handle!.release(), handle!.release()]);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/release"))).toHaveLength(1);
  const previousCalls = fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetcher).toHaveBeenCalledTimes(previousCalls);
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain(connection.token);
});

it("releases a lease received after cancellation while the acquisition request was pending", async () => {
  let answer!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { answer = resolve; }));
  fetcher.mockImplementation(async () => Response.json({ phase: "stopping" }));
  const abort = new AbortController();
  const task = autoDLTaskPower(connection, { taskId: "task", attemptId: "attempt", signal: abort.signal, onStatus: vi.fn() });
  const failure = expect(task).rejects.toMatchObject({ name: "AbortError" });
  abort.abort();
  answer(Response.json({ ...ready, phase: "starting" }));
  await failure;
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/release"))).toHaveLength(1);
  const releaseSignal = fetcher.mock.calls.find(([url]) => String(url).endsWith("/release"))![1]!.signal;
  expect(releaseSignal).not.toBe(abort.signal);
  expect(releaseSignal?.aborted).toBe(false);
});

it("cleans a failed startup and stops its renewal timer", async () => {
  fetcher.mockImplementationOnce(async () => Response.json({ ...ready, phase: "failed", error: "GPU unavailable" }));
  fetcher.mockImplementation(async () => Response.json({ phase: "stopping" }));
  await expect(autoDLTaskPower(connection, { taskId: "task", attemptId: "attempt", signal: new AbortController().signal, onStatus: vi.fn() })).rejects.toThrow("GPU unavailable");
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/release"))).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/heartbeat"))).toHaveLength(0);
});

it.each(["failed", "released"] as const)("aborts an already ready task on a %s heartbeat and releases once", async phase => {
  const onStatus = vi.fn();
  fetcher.mockImplementation(async url => String(url).endsWith("/heartbeat")
    ? Response.json({ ...ready, phase, ...(phase === "failed" ? { error: "Lease expired on server" } : {}) }) : Response.json(ready));
  const handle = await autoDLTaskPower(connection, { taskId: "task", attemptId: "attempt", signal: new AbortController().signal, onStatus });
  expect(handle!.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(10000);
  expect(handle!.signal.aborted).toBe(true);
  expect(handle!.signal.reason.message).toContain(phase === "failed" ? "Lease expired on server" : "租约已释放");
  expect(onStatus).toHaveBeenCalledWith(handle!.signal.reason.message);
  await handle!.release();
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/release"))).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/heartbeat"))).toHaveLength(1);
});

it.each([404, 410])("treats HTTP %s as a lost lease even without a JSON response", async status => {
  fetcher.mockImplementation(async url => String(url).endsWith("/heartbeat") ? new Response("gone", { status }) : Response.json(ready));
  const handle = await autoDLTaskPower(connection, { taskId: "task", attemptId: "attempt", signal: new AbortController().signal, onStatus: vi.fn() });
  await vi.advanceTimersByTimeAsync(10000);
  expect(handle!.signal.aborted).toBe(true);
  expect(handle!.signal.reason.message).toContain("租约已不存在");
  await handle!.release();
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/release"))).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/heartbeat"))).toHaveLength(1);
});

it.each(["network", "server"])("retries a transient %s heartbeat failure without aborting or releasing the ready task", async failure => {
  let heartbeat = 0;
  const onStatus = vi.fn();
  fetcher.mockImplementation(async url => {
    if (String(url).endsWith("/heartbeat") && ++heartbeat === 1) {
      if (failure === "network") throw new TypeError("network unavailable");
      return Response.json({ error: "temporarily unavailable" }, { status: 503 });
    }
    return Response.json(ready);
  });
  const handle = await autoDLTaskPower(connection, { taskId: "task", attemptId: "attempt", signal: new AbortController().signal, onStatus });
  await vi.advanceTimersByTimeAsync(10000);
  expect(handle!.signal.aborted).toBe(false);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/release"))).toHaveLength(0);
  expect(onStatus).toHaveBeenCalledWith(expect.stringContaining("正在重试"));
  await vi.advanceTimersByTimeAsync(10000);
  expect(heartbeat).toBe(2);
  expect(handle!.signal.aborted).toBe(false);
  await handle!.release();
});

it("continues startup after a temporary heartbeat failure", async () => {
  let heartbeat = 0;
  fetcher.mockImplementation(async url => {
    if (String(url).endsWith("/acquire")) return Response.json({ ...ready, phase: "starting" });
    if (String(url).endsWith("/heartbeat") && ++heartbeat === 1) throw new TypeError("temporary network error");
    return Response.json(ready);
  });
  const pending = autoDLTaskPower(connection, { taskId: "task", attemptId: "attempt", signal: new AbortController().signal, onStatus: vi.fn() });
  await vi.advanceTimersByTimeAsync(2000);
  const handle = await pending;
  expect(heartbeat).toBe(2);
  expect(handle!.signal.aborted).toBe(false);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/acquire"))).toHaveLength(1);
  await handle!.release();
});

it("cleans an acquire whose response never arrives by exact attempt without repeating acquire", async () => {
  const abort = new AbortController();
  fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith("/acquire")) return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    return Response.json({ phase: "stopping" });
  });
  const task = autoDLTaskPower(connection, { taskId: "task", attemptId: "lost-attempt", signal: abort.signal, onStatus: vi.fn() });
  const failed = expect(task).rejects.toThrow("响应超时");
  abort.abort();
  await vi.advanceTimersByTimeAsync(30000);
  await failed;
  const acquisitions = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/acquire"));
  const releases = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/release"));
  expect(acquisitions).toHaveLength(1);
  expect(releases).toHaveLength(1);
  expect(JSON.parse(releases[0][1]!.body as string)).toEqual({ endpoint: connection.baseUrl, instanceUuid: "pro-fixture", taskId: "task", attemptId: "lost-attempt" });
  expect(releases[0][1]!.signal).not.toBe(abort.signal);
  expect(releases[0][1]!.signal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/heartbeat"))).toHaveLength(0);
});

it("preserves an acquire error when independent attempt cleanup also fails", async () => {
  const original = new TypeError("lost acquisition response");
  const onStatus = vi.fn();
  fetcher.mockRejectedValueOnce(original).mockRejectedValue(new Error("cleanup unreachable"));
  await expect(autoDLTaskPower(connection, { taskId: "task", attemptId: "attempt", signal: new AbortController().signal, onStatus })).rejects.toBe(original);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/acquire"))).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/release"))).toHaveLength(1);
  expect(onStatus).toHaveBeenCalledWith(expect.stringContaining("清理尚未确认"));
});

it("ignores a late terminal heartbeat after normal release", async () => {
  let answer!: (response: Response) => void;
  const onStatus = vi.fn();
  fetcher.mockImplementation(async url => String(url).endsWith("/heartbeat")
    ? new Promise<Response>(resolve => { answer = resolve; }) : Response.json(ready));
  const handle = await autoDLTaskPower(connection, { taskId: "task", attemptId: "attempt", signal: new AbortController().signal, onStatus });
  await vi.advanceTimersByTimeAsync(10000);
  await handle!.release();
  answer(Response.json({ ...ready, phase: "failed", error: "late terminal heartbeat" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(handle!.signal.aborted).toBe(false);
  expect(onStatus).not.toHaveBeenCalledWith("late terminal heartbeat");
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/release"))).toHaveLength(1);
});
