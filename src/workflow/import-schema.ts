import { ComfyUIClient } from "../comfyui/client";
import { readRecord, writeRecord } from "../projects/storage";
import type { Connection } from "../types";
import { isRunningHubNativeConnection } from "../runninghub/native-connection";

type SchemaCache = { endpoint: string; info: Record<string, unknown>; loadedAt: number };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
// A proxy can return HTTP 200 with an error payload. It is not a node catalog.
const validInfo = (value: unknown): value is Record<string, unknown> => record(value) && !!Object.keys(value).length
  && Object.values(value).every(node => {
    if (!record(node) || !record(node.input)) return false;
    const input = node.input;
    return ["required", "optional", "hidden"].every(group => input[group] === undefined || record(input[group]));
  });

/** Cache node contracts per engine; never substitute schemas from another server. */
export async function loadImportSchema(connection: Connection, signal: AbortSignal): Promise<{ info?: Record<string, unknown>; warnings: string[]; catalogScope?: "platform" }> {
  signal.throwIfAborted();
  if (!connection.baseUrl.trim()) return { warnings: [] };
  const client = new ComfyUIClient(connection);
  // RunningHub's shared proxy catalog is not an inventory of the worker that
  // will execute this graph. Never infer missing installed models from it.
  const scope = isRunningHubNativeConnection(connection) ? { catalogScope: "platform" as const } : {};
  let endpoint: string;
  try { endpoint = client.url("/object_info"); }
  catch { return { warnings: ["当前 ComfyUI 地址无效，已按文件自身的信息读取。"] }; }
  const identity = new TextEncoder().encode(endpoint + "\0" + connection.authHeader + "\0" + connection.authPrefix + "\0" + connection.token);
  const digest = await crypto.subtle.digest("SHA-256", identity);
  const key = "workflow-schema-" + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  let cached: SchemaCache | undefined;
  try { cached = await readRecord<SchemaCache>(key); } catch { /* Storage cannot prevent importing. */ }
  try {
    // Enumerating a large workstation has no fixed time limit. The user can
    // cancel the import; elapsed time alone must not skip automatic repair.
    const value: unknown = await (await client.request("/object_info", { signal }, null)).json();
    signal.throwIfAborted();
    if (!validInfo(value)) throw new Error("ComfyUI 返回的内容不是有效节点定义，请检查服务地址与连接状态。");
    try { await writeRecord(key, { endpoint, info: value, loadedAt: Date.now() }); } catch { /* A live schema remains usable. */ }
    return { info: value, warnings: [], ...scope };
  } catch (reason) {
    signal.throwIfAborted();
    const message = "暂时无法检查云端节点与模型：" + (reason instanceof Error ? reason.message : String(reason));
    if (cached?.endpoint === endpoint && validInfo(cached.info)) return { info: cached.info, ...scope,
      warnings: [message, "已使用此服务此前读取的节点定义；当前服务状态尚未确认，可在导入时重新读取。"] };
    return { warnings: [message] };
  }
}
