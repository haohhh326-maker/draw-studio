import { isTauri } from "@tauri-apps/api/core";
import type { Connection, RemoteFile } from "../types";
import { requestNativeRunningHub } from "./native-connection";

const hosts = new Set(["rh-images.xiaoyaoyou.com", "rh-images-tos.xiaoyaoyou.com", "rh-images-1252422369.cos.ap-beijing.myqcloud.com"]);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Recover an expired/invalid native /view address from the same accepted task.
 * This queries outputs only; it never creates or re-runs a generation. */
export async function recoverNativeRunningHubOutput(connection: Connection, file: RemoteFile, context: { promptId: string; onlyOutput: boolean }, signal?: AbortSignal): Promise<Blob | null> {
  if (!/^\d{1,32}$/.test(context.promptId)) return null;
  const response = await requestNativeRunningHub(connection, "/task-outputs/" + context.promptId, { signal });
  if (!response.ok) return null;
  const result: unknown = await response.json();
  if (!record(result) || ![0, "0"].includes(result.code as string | number) || !Array.isArray(result.data)) return null;
  const files = result.data.filter(record).flatMap(item => {
    if (typeof item.fileUrl !== "string") return [];
    try {
      const url = new URL(item.fileUrl);
      let decoded = url.href;
      for (let i = 0; i < 3; i++) { try { decoded = decodeURIComponent(decoded); } catch { break; } }
      if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.username || url.password || url.hash || (url.port && url.port !== "443") || decoded.includes(connection.token)) return [];
      const name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      return [{ url: url.href, name, declared: item.fileName }];
    } catch { return []; }
  });
  const exact = files.filter(item => item.name === file.filename || item.declared === file.filename);
  const selected = exact.length === 1 ? exact[0] : context.onlyOutput && files.length === 1 && result.data.length === 1 ? files[0] : undefined;
  if (!selected) return null;
  const desktop = isTauri(), fetcher = desktop ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
  const url = desktop ? selected.url : new URL(import.meta.env.BASE_URL + "api/runninghub-result?url=" + encodeURIComponent(selected.url), window.location.origin).toString();
  let download: Response;
  try { download = await fetcher(url, { signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow" }); }
  catch { signal?.throwIfAborted(); throw new Error("RunningHub 原任务结果下载连接中断，可恢复查询原任务。"); }
  if (!download.ok) { await download.body?.cancel(); throw new Error("RunningHub 原任务结果下载失败（HTTP " + download.status + "），可恢复查询原任务。"); }
  return download.blob();
}
