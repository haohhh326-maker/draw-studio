import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { autoDLTaskPower, getAutoDLInstances, getAutoDLSession, openAutoDLAccount, saveAutoDLSettings } from "../src/autodl/client";
import type { AutoDLLease } from "../src/autodl/types";
import type { Connection } from "../src/types";

const connection: Connection = { name: "AutoDL", baseUrl: "https://comfy.example", token: "comfy-access-token",
  authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 60, autodl: { instanceUuid: "pro-fixture" } };
const ready: AutoDLLease = { leaseId: "lease-fixture", instanceUuid: "pro-fixture", phase: "ready" };
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("window", globalThis); vi.stubGlobal("fetch", fetcher); fetcher.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("opens the dedicated official login and reads its account and instance summaries", async () => {
  const waiting = { status: "login-required", message: "请在官网窗口登录。" };
  const session = { status: "connected", message: "已连接 AutoDL.Art 账号。" };
  const instances = { instances: [{ instanceUuid: "pro-fixture", name: "ComfyUI", status: "shutdown" }] };
  fetcher.mockImplementation(async url => Response.json(String(url).endsWith("/open-account") ? waiting : String(url).endsWith("/instances") ? instances : session));
  expect(await openAutoDLAccount()).toEqual(waiting);
  expect(await getAutoDLSession()).toEqual(session);
  expect(await getAutoDLInstances()).toEqual(instances);
  expect(fetcher.mock.calls.map(([url, init]) => ({ url, method: init?.method, body: init?.body }))).toEqual([
    { url: "/__canvas/autodl/open-account", method: "POST", body: "{}" },
    { url: "/__canvas/autodl/session", method: "GET", body: undefined },
    { url: "/__canvas/autodl/instances", method: "GET", body: undefined },
  ]);
});

it("sends only binding settings even when an old caller includes a credential field", async () => {
  fetcher.mockResolvedValue(Response.json({ settings: { enabled: false }, phase: "disabled" }));
  await saveAutoDLSettings({ enabled: false, endpoint: connection.baseUrl, instanceUuid: "pro-fixture", apiToken: "discarded-legacy-secret" } as Parameters<typeof saveAutoDLSettings>[0]);
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ enabled: false, endpoint: connection.baseUrl, instanceUuid: "pro-fixture" });
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("discarded-legacy-secret");
});

it("reports an expired website login without opening a window or making a power request automatically", async () => {
  fetcher.mockResolvedValue(Response.json({ error: "AutoDL.Art 登录已失效，请在浏览器重新登录。" }, { status: 401 }));
  await expect(getAutoDLInstances()).rejects.toThrow("登录已失效");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("/__canvas/autodl/instances");
});

it("surfaces a browser launch failure without retrying the launch", async () => {
  fetcher.mockResolvedValue(Response.json({ error: "无法打开 AutoDL.Art 官网窗口。" }, { status: 503 }));
  await expect(openAutoDLAccount()).rejects.toThrow("无法打开 AutoDL.Art 官网窗口。");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("leaves ordinary ComfyUI connections outside automatic power management", async () => {
  const { autodl: _, ...ordinary } = connection;
  expect(await autoDLTaskPower(ordinary, { taskId: "task", attemptId: "attempt", signal: new AbortController().signal, onStatus: vi.fn() })).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it("acquires the exact AutoDL instance from its official gateway when a legacy connection has no marker", async () => {
  const legacy = { ...connection, baseUrl: "https://u42-abcd1234.westd.seetacloud.com:8443", autodl: undefined };
  fetcher.mockImplementation(async () => Response.json({ ...ready, instanceUuid: "pro-abcd1234" }));
  const handle = await autoDLTaskPower(legacy, { taskId: "task", attemptId: "attempt", signal: new AbortController().signal, onStatus: vi.fn() });
  expect(fetcher.mock.calls[0][0]).toBe("/__canvas/autodl/acquire");
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
    endpoint: legacy.baseUrl, instanceUuid: "pro-abcd1234", taskId: "task", attemptId: "attempt",
  });
  await handle!.release();
});

it("reports disabled AutoDL settings on an older gateway connection without retrying a rejected acquisition", async () => {
  fetcher.mockResolvedValue(Response.json({ error: "请在算力设置中启用 AutoDL 自动开关机。" }, { status: 409 }));
  await expect(autoDLTaskPower({ ...connection, baseUrl: "https://u42-abcd1234.westd.seetacloud.com:8443", autodl: undefined },
    { taskId: "task", attemptId: "attempt", signal: new AbortController().signal, onStatus: vi.fn() })).rejects.toThrow("启用 AutoDL 自动开关机");
  expect(fetcher).toHaveBeenCalledTimes(1);
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

it("shows an inventory wait while keeping the same startup request alive", async () => {
  const onStatus = vi.fn();
  const waiting = "AutoDL 暂无可用库存，正在等待下次重试。";
  let heartbeat = 0;
  fetcher.mockImplementation(async url => {
    if (String(url).endsWith("/acquire")) return Response.json({ ...ready, phase: "starting" });
    if (String(url).endsWith("/heartbeat") && ++heartbeat === 1) return Response.json({ ...ready, phase: "starting", message: waiting });
    return Response.json(ready);
  });
  const pending = autoDLTaskPower(connection, { taskId: "task", attemptId: "attempt", signal: new AbortController().signal, onStatus });
  await vi.advanceTimersByTimeAsync(2_000);
  const handle = await pending;
  expect(onStatus).toHaveBeenCalledWith(waiting);
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
