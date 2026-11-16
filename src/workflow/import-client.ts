import type { ApiWorkflow, WorkflowDefinition } from "../types";

export type WorkflowImportRequest = {
  filename: string;
  source: unknown;
  graph?: ApiWorkflow;
  config: Record<string, unknown>;
  requirements: Record<string, unknown>;
  overwrite?: boolean;
  reuseExisting?: boolean;
};
export type WorkflowImportResult = {
  folder: string;
  path: string;
  workflowId: string;
  updated: boolean;
  reused?: boolean;
  status?: "pending" | "ready";
  diagnostics?: import("./import-pending").WorkflowImportDiagnostic[];
};
export type WorkflowImportSource = { source: unknown; filename: string; config: Record<string, unknown> };
export class WorkflowImportConflict extends Error {
  constructor(public existing: WorkflowImportResult, message = "这个工作流已经添加。可以更新已有工作流。") {
    super(message);
  }
}
export async function saveWorkflowImport(request: WorkflowImportRequest, signal?: AbortSignal): Promise<WorkflowImportResult> {
  const response = await fetch(import.meta.env.BASE_URL + "__canvas/workflow-library/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 409 && result.existing) throw new WorkflowImportConflict(result.existing, result.error);
  if (!response.ok) throw new Error(result.error || "保存工作流失败（HTTP " + response.status + "）。");
  if (typeof result.path !== "string" || typeof result.workflowId !== "string" || typeof result.folder !== "string")
    throw new Error("本机服务没有返回完整的工作流保存结果。");
  return result;
}

/** Identity follows the original JSON, independently of its filename or display name. */
export async function workflowImportId(source: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(source));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return "custom." + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

export async function resolveWorkflowImport(workflowId: string, objectInfo?: Record<string, unknown>, signal?: AbortSignal): Promise<WorkflowImportResult> {
  const response = await fetch(import.meta.env.BASE_URL + "__canvas/workflow-library/resolve", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflowId, objectInfo }),
    signal,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "重新检查工作流失败（HTTP " + response.status + "）。");
  if (typeof result.path !== "string" || typeof result.workflowId !== "string" || typeof result.folder !== "string") throw new Error("本机服务没有返回完整的工作流检查结果。");
  return result;
}

/** Re-import only a managed library source, never a caller-selected path. */
export async function readWorkflowImportSource(workflowId: string, signal?: AbortSignal): Promise<WorkflowImportSource> {
  if (!/^custom\.[a-f0-9]{16,64}$/.test(workflowId)) throw new Error("自定义工作流 ID 格式无效。");
  const response = await fetch(import.meta.env.BASE_URL + "__canvas/workflow-library/source", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflowId }),
    signal,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error || "读取原始工作流失败（HTTP " + response.status + "）。");
  if (!result || typeof result !== "object" || Array.isArray(result) || !result.source || typeof result.source !== "object" || Array.isArray(result.source) || typeof result.filename !== "string" || !result.filename ||
      !result.config || typeof result.config !== "object" || Array.isArray(result.config) || result.config.id !== workflowId)
    throw new Error("本机服务没有返回匹配的工作流原始文件。");
  return result;
}

/** A displayed snapshot authorizes only its own configured-library folder, never an arbitrary path. */
export async function deleteWorkflowLibraryWorkflow(workflow: WorkflowDefinition, signal?: AbortSignal): Promise<void> {
  const workflowId = workflow.original?.id, folder = workflow.library?.folder, configSha256 = workflow.original?.configSha256;
  if (!workflowId || !folder || !configSha256) throw new Error("此工作流没有可删除的本地目录。");
  const response = await fetch(import.meta.env.BASE_URL + "__canvas/workflow-library/delete", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflowId, folder, configSha256 }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "删除工作流失败（HTTP " + response.status + "）。");
  if (result.deleted !== true || result.workflowId !== workflowId || result.folder !== folder) throw new Error("本机服务没有返回匹配的工作流删除结果。");
}
