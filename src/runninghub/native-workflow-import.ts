import type { ApiWorkflow, Connection } from "../types";
import { RunningHubClient } from "./client";
import { getNativeRunningHubEndpoint, redactNativeRunningHubText } from "./native-connection";
import { parseRunningHubReference } from "./workflows";
import { readableRunningHubError } from "./error-message";

export type NativeRunningHubWorkflowImport = {
  source: ApiWorkflow;
  name: string;
  fileName: string;
  workflowId: string;
  sourceUrl: string;
};

/** Read a shared workflow with the native connection's key; execution stays in ComfyUI. */
export async function readNativeRunningHubWorkflow(
  reference: string, connection: Connection, signal?: AbortSignal,
): Promise<NativeRunningHubWorkflowImport> {
  signal?.throwIfAborted();
  const endpoint = getNativeRunningHubEndpoint(connection);
  const parsed = parseRunningHubReference(reference, endpoint.site);
  if (parsed.kind === "app") throw new Error("此链接是 RunningHub AI 应用，请填写 ComfyUI 工作流的 post 或 workflow 链接。");
  // Only the graph reader uses the public API site. Do not change the saved
  // connection, selected compute provider, or the workflow's execution route.
  const reader = new RunningHubClient({ ...connection, baseUrl: endpoint.site, token: endpoint.token });
  try {
    const source = await reader.getWorkflow(parsed.id, signal);
    signal?.throwIfAborted();
    let name = "RunningHub " + parsed.id;
    try {
      const metadata = await reader.getWorkflowMetadata(parsed.id, "workflow", signal);
      if (metadata.name?.trim()) name = metadata.name.trim();
    } catch (reason) {
      signal?.throwIfAborted();
      if (reason instanceof Error && reason.name === "AbortError") throw reason;
      // A missing public card must not discard a successfully read API graph.
    }
    signal?.throwIfAborted();
    name = name.slice(0, 120);
    const fileName = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").replace(/[. ]+$/, "") + ".json";
    return { source, name, fileName, workflowId: parsed.id, sourceUrl: endpoint.site + "/post/" + parsed.id };
  } catch (reason) {
    signal?.throwIfAborted();
    const message = redactNativeRunningHubText(reason instanceof Error ? reason.message : String(reason), { ...connection, token: endpoint.token });
    if (reason instanceof Error && reason.name === "AbortError") throw new DOMException(message, "AbortError");
    const error = new Error(readableRunningHubError(message));
    if (reason && typeof reason === "object") {
      for (const field of ["status", "code"] as const) {
        const value = (reason as Record<string, unknown>)[field];
        if (typeof value === "number" || typeof value === "string") Object.assign(error, { [field]: typeof value === "string" ? redactNativeRunningHubText(value, { ...connection, token: endpoint.token }) : value });
      }
    }
    throw error;
  }
}
