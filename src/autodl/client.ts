import type { Connection } from "../types";
import type { AutoDLAcquireRequest, AutoDLLease, AutoDLPowerStatus, AutoDLSettingsInput } from "./types";

const root = "/__canvas/autodl";
class AutoDLRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(route: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${root}/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let value: T & { error?: string };
    try { value = JSON.parse(text); }
    catch {
      if (!response.ok) throw new AutoDLRequestError(`AutoDL 请求失败（${response.status}）。`, response.status);
      throw new Error("AutoDL 自动开关机服务尚未启动，请重新启动画布服务。");
    }
    if (!response.ok) throw new AutoDLRequestError(typeof value?.error === "string" && value.error || `AutoDL 请求失败（${response.status}）。`, response.status);
    return value;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("AutoDL 本机服务响应超时，请检查连接。后台关机记录会继续保留。");
    throw error;
  } finally { window.clearTimeout(timer); }
}

export const getAutoDLStatus = () => request<AutoDLPowerStatus>("status");
export const saveAutoDLSettings = (settings: AutoDLSettingsInput) => request<AutoDLPowerStatus>("settings", settings);
export const checkAutoDLSettings = () => request<AutoDLPowerStatus>("check", {});
export const retryAutoDLShutdown = () => request<AutoDLPowerStatus>("retry-shutdown", {});

function pause(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const done = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = window.setTimeout(done, 1000);
    const abort = () => { window.clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export type AutoDLTaskPower = { leaseId: string; signal: AbortSignal; release: () => Promise<void> };

/** One execution owns a lease until every result has been saved or its attempt ends. */
export async function autoDLTaskPower(connection: Connection, options: {
  taskId: string;
  attemptId: string;
  signal: AbortSignal;
  onStatus: (message: string) => void;
}): Promise<AutoDLTaskPower | undefined> {
  if (!connection.autodl?.instanceUuid) return;
  options.signal.throwIfAborted();
  options.onStatus("正在启动 AutoDL 云端实例…");
  const input: AutoDLAcquireRequest = { endpoint: connection.baseUrl, instanceUuid: connection.autodl.instanceUuid,
    taskId: options.taskId, attemptId: options.attemptId };
  // Keep the response observable even if the task is cancelled while acquisition is in flight.
  let lease: AutoDLLease;
  try { lease = await request<AutoDLLease>("acquire", input); }
  catch (error) {
    // A timed-out/lost response does not prove the server rejected acquisition.
    // Cancel this exact attempt independently; never repeat a potentially paid acquire.
    await request("release", input).catch(() => options.onStatus("AutoDL 启动响应丢失，关机清理尚未确认，请在算力设置中检查。"));
    throw error;
  }
  const lost = new AbortController();
  const signal = AbortSignal.any([options.signal, lost.signal]);
  let released: Promise<void> | undefined;
  let polling: Promise<void> | undefined;
  const leaseId = lease.leaseId;
  let timer: number | undefined;
  const release = () => released ??= (async () => {
    window.clearInterval(timer);
    // This request deliberately has its own signal so cancellation cannot cancel shutdown.
    await request("release", { leaseId });
  })();
  const lostLease = (error: Error) => {
    if (released || lost.signal.aborted) return;
    lost.abort(error);
    options.onStatus(error.message);
    void release().catch(() => options.onStatus("AutoDL 关机尚未确认，本机后台将继续清理和重试。"));
  };
  const leaseError = (value: AutoDLLease) => value.phase === "failed" || value.phase === "released"
    ? new Error(value.error || (value.phase === "released" ? "AutoDL 任务租约已释放，已停止本次生成。" : "AutoDL 任务租约已失效，已停止本次生成。")) : undefined;
  const heartbeat = (): Promise<void> => {
    if (released || lost.signal.aborted) return Promise.resolve();
    return polling ??= request<AutoDLLease>("heartbeat", { leaseId }).then(value => {
      if (released) return;
      lease = value;
      const error = leaseError(value);
      if (error) lostLease(error);
    }).catch(error => {
      if (released) return;
      if (error instanceof AutoDLRequestError && [404, 410].includes(error.status))
        lostLease(new Error("AutoDL 任务租约已不存在，已停止本次生成。"));
      else options.onStatus("AutoDL 管理连接暂时中断，正在重试…");
    }).finally(() => { polling = undefined; });
  };
  timer = window.setInterval(() => { void heartbeat(); }, 10000);
  try {
    const initialError = leaseError(lease);
    if (initialError) lostLease(initialError);
    while (lease.phase !== "ready") {
      signal.throwIfAborted();
      await pause(signal);
      await heartbeat();
    }
    signal.throwIfAborted();
    options.onStatus("AutoDL 已开机，正在等待 ComfyUI 服务就绪…");
    return { leaseId, signal: lost.signal, release };
  } catch (error) {
    await release().catch(() => options.onStatus("AutoDL 关机尚未确认，本机后台将继续清理和重试。"));
    throw error;
  }
}
