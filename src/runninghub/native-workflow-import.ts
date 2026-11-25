import { defaultRunningHubConnections } from "../compute/providers";
import type { ApiWorkflow, Connection, RunningHubSite } from "../types";
import { RunningHubClient, type RunningHubPublishedPrompt, type RunningHubWorkflowImportMetadata } from "./client";
import { getNativeRunningHubEndpoint, redactNativeRunningHubText } from "./native-connection";
import { parseRunningHubReference } from "./workflows";
import { readableRunningHubError } from "./error-message";

type RunningHubWorkflowImport<Source> = {
  source: Source;
  name: string;
  fileName: string;
  workflowId: string;
  sourceUrl: string;
  publishedPrompt?: RunningHubPublishedPrompt;
};
export type NativeRunningHubWorkflowImport = RunningHubWorkflowImport<ApiWorkflow>;

/** Read a shared workflow with the native connection's key; execution stays in ComfyUI. */
export async function readNativeRunningHubWorkflow(
  reference: string, connection: Connection, signal?: AbortSignal,
): Promise<NativeRunningHubWorkflowImport> {
  signal?.throwIfAborted();
  const endpoint = getNativeRunningHubEndpoint(connection);
  const id = workflowLinkId(reference, endpoint.site);
  const reader = new RunningHubClient({ ...connection, baseUrl: endpoint.site, token: endpoint.token });
  return readWorkflowSource(id, reader, () => reader.getWorkflow(id, signal), signal);
}

export async function readRunningHubWorkflowForComfyUI(
  reference: string, profiles: Record<RunningHubSite, Connection>, defaultSite: RunningHubSite, signal?: AbortSignal,
): Promise<RunningHubWorkflowImport<Record<string, unknown>>> {
  signal?.throwIfAborted();
  let site = defaultSite;
  try {
    const hostname = new URL(reference.trim()).hostname.replace(/^www\./, "");
    if (hostname === "runninghub.cn" || hostname === "runninghub.ai") site = hostname === "runninghub.ai" ? "ai" : "cn";
  } catch { /* The shared reference parser validates IDs and reports malformed links. */ }
  const { baseUrl } = defaultRunningHubConnections[site];
  const parsed = parseRunningHubReference(reference, baseUrl);
  const token = profiles[site].token.trim();
  const reader = new RunningHubClient({ ...profiles[site], baseUrl, token });
  try {
    const published = parsed.kind === "app" ? await reader.getPublishedAppWorkflow(parsed.id, signal) : undefined;
    if (parsed.kind === "app" && !published) throw new Error("这个 RunningHub AI 应用没有可访问的公开原始工作流。要用 AutoDL 运行，请使用作者提供的工作流链接或 API JSON。");
    const id = published?.id ?? parsed.id;
    const loadSource = async () => {
      if (token) {
        try { return await reader.getWorkflow(id, signal); }
        catch (reason) {
          signal?.throwIfAborted();
          if (!(reason instanceof Error) || !("code" in reason) || reason.code !== "RUNNINGHUB_WORKFLOW_EDITOR_CONVERSION_REQUIRED") throw reason;
        }
      }
      return reader.getPublicWorkflowExport(id, signal);
    };
    return await readWorkflowSource(id, reader, loadSource, signal, async () => published ?? reader.getWorkflowImportMetadata(id, signal));
  } catch (reason) {
    if (reason instanceof Error && reason.name !== "AbortError") {
      const code = "code" in reason ? reason.code : undefined;
      if (!token && (code === "RUNNINGHUB_WORKFLOW_PUBLIC_ACCESS_REQUIRED" || code === "RUNNINGHUB_WORKFLOW_EXPORT_UNAVAILABLE")) {
        const siteLabel = site === "cn" ? "CN 国内站" : "AI 海外站";
        reason.message = `官网未提供可直接导出的工作流。可以配置 RunningHub ${siteLabel} API Key 后重试，或导入有权限取得的工作流 JSON。`;
      } else if (code === "RUNNINGHUB_WORKFLOW_EXPORT_UNAVAILABLE" || code === "RUNNINGHUB_WORKFLOW_FORMAT_MISSING"
        || /\bWORKFLOW_NOT_SAVED_OR_NOT_RUNNING\b/.test(reason.message)) {
        reason.message = "RunningHub 未提供可导入的完整工作流。请确认该工作流已保存并且允许读取，或换一个工作流链接。\n" + reason.message;
      }
    }
    throw reason;
  }
}

function workflowLinkId(reference: string, baseUrl: string) {
  const parsed = parseRunningHubReference(reference, baseUrl);
  if (parsed.kind === "app") throw new Error("此链接是 RunningHub AI 应用，请填写 ComfyUI 工作流的 post 或 workflow 链接。");
  return parsed.id;
}

async function readWorkflowSource<Source>(id: string, reader: RunningHubClient, load: () => Promise<Source>,
  signal?: AbortSignal, loadMetadata = (): Promise<RunningHubWorkflowImportMetadata> => reader.getWorkflowMetadata(id, "workflow", signal),
): Promise<RunningHubWorkflowImport<Source>> {
  const { connection } = reader;
  try {
    const source = await load();
    signal?.throwIfAborted();
    let name = "RunningHub " + id;
    let publishedPrompt: RunningHubPublishedPrompt | undefined;
    try {
      const metadata = await loadMetadata();
      if (metadata.name?.trim()) name = metadata.name.trim();
      publishedPrompt = metadata.publishedPrompt;
    } catch (reason) {
      signal?.throwIfAborted();
      if (reason instanceof Error && reason.name === "AbortError") throw reason;
      // A missing public card must not discard a successfully read API graph.
    }
    signal?.throwIfAborted();
    name = name.slice(0, 120);
    const fileName = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").replace(/[. ]+$/, "") + ".json";
    return { source, name, fileName, workflowId: id, sourceUrl: connection.baseUrl + "/post/" + id,
      ...(publishedPrompt ? { publishedPrompt } : {}) };
  } catch (reason) {
    signal?.throwIfAborted();
    const message = redactNativeRunningHubText(reason instanceof Error ? reason.message : String(reason), connection);
    if (reason instanceof Error && reason.name === "AbortError") throw new DOMException(message, "AbortError");
    const error = new Error(readableRunningHubError(message));
    if (reason && typeof reason === "object") {
      for (const field of ["status", "code"] as const) {
        const value = (reason as Record<string, unknown>)[field];
        if (typeof value === "number" || typeof value === "string") Object.assign(error, { [field]: typeof value === "string" ? redactNativeRunningHubText(value, connection) : value });
      }
    }
    throw error;
  }
}
