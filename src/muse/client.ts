import { syncNativeServiceAuth } from "../services/service-auth";

export type MuseSession = {
  status: "disconnected" | "checking" | "login-required" | "waiting-list" | "connected";
  message?: string;
  accountLabel?: string;
};
export type MuseJobRequest = {
  id: string;
  kind: "image" | "video";
  prompt: string;
  aspectRatio: string;
  references: ({ name: string; mime: string } & ({ uploadId: string; dataBase64?: never } | { dataBase64: string; uploadId?: never }))[];
};
export type MuseJob = {
  id: string;
  status: "queued" | "loading" | "uploading" | "submitting" | "generating" | "saving" | "completed" | "failed" | "interrupted" | "cancelled";
  message?: string;
  conversationUrl?: string;
  outputs?: { id: string; name: string; mime: string; url: string }[];
  error?: string;
  recovery?: "reconnect" | "manual";
};
export class MuseApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = "MuseApiError"; }
}
const prefix = "/api/muse";
function bridgeUrl(path: string): string {
  // The desktop package does not include Vite middleware. The same local bridge
  // must be running there; the browser build uses its own same-origin service.
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const sameHost = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  return (desktop && !sameHost ? "http://127.0.0.1:1420" : "") + path;
}
async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(bridgeUrl(prefix + path), {
      method, signal, credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MuseApiError("无法连接本机 Muse 服务，请通过画布启动程序打开应用。已提交的任务请恢复查询，不要重复生成。", 0);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new MuseApiError("本机 Muse 服务尚未加载，请重新启动画布服务。", response.ok ? 0 : response.status);
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new MuseApiError(data.error || `Muse 服务请求失败（HTTP ${response.status}）。`, response.status);
  return data;
}
export const getMuseSession = (signal?: AbortSignal) => request<MuseSession>("/session", "GET", undefined, signal);
export const loginMuseSession = () => request<MuseSession>("/session/login", "POST", {});
export const disconnectMuseSession = () => request<MuseSession>("/session/disconnect", "POST", {});
export const createMuseJob = async (body: MuseJobRequest, signal?: AbortSignal) => {
  try { await syncNativeServiceAuth("muse", signal); }
  catch (cause) {
    if (signal?.aborted) throw cause;
    // No request was sent to Muse, so the canvas may safely mark this attempt as unsubmitted.
    throw new MuseApiError(cause instanceof Error ? cause.message : "Muse 登录状态同步失败。", 409);
  }
  return request<MuseJob>("/jobs", "POST", body, signal);
};
export const getMuseJob = (id: string, signal?: AbortSignal) => request<MuseJob>("/jobs/" + encodeURIComponent(id), "GET", undefined, signal);
export const resumeMuseJob = (id: string, signal?: AbortSignal) => request<MuseJob>("/jobs/" + encodeURIComponent(id) + "/resume", "POST", {}, signal);
export const cancelMuseJob = (id: string, signal?: AbortSignal) => request<MuseJob>("/jobs/" + encodeURIComponent(id) + "/cancel", "POST", {}, signal);
export async function getMuseOutput(url: string, signal?: AbortSignal): Promise<Blob> {
  // Results are served only by our job-scoped bridge route, never arbitrary URLs.
  if (!/^\/api\/muse\/jobs\/[a-zA-Z0-9_-]+\/media\/[a-zA-Z0-9_-]+$/.test(url))
    throw new MuseApiError("Muse 返回了无效的结果地址。", 0);
  const response = await fetch(bridgeUrl(url), { signal, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new MuseApiError(`Muse 结果读取失败（HTTP ${response.status}），可恢复原任务。`, response.status);
  return response.blob();
}
export async function uploadMuseReference(jobId: string, blob: Blob, name: string, signal?: AbortSignal): Promise<{ uploadId: string; name: string; mime: string }> {
  const response = await fetch(bridgeUrl(prefix + "/jobs/" + encodeURIComponent(jobId) + "/references"), {
    method: "POST", body: blob, signal, credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": blob.type || "application/octet-stream", "X-Muse-Name": encodeURIComponent(name) },
  });
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new MuseApiError("本机 Muse 上传服务暂不可用，请重新连接。", response.status);
  const result = await response.json() as { uploadId: string; name: string; mime: string; error?: string };
  if (!response.ok) throw new MuseApiError(result.error || "参考素材上传未完成，请重试。", response.status);
  return result;
}

