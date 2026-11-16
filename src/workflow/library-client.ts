import type { WorkflowDefinition } from "../types";

export type WorkflowLibrarySnapshot = {
  sourcePath: string;
  loadedAt: number;
  workflows: WorkflowDefinition[];
  scanned: number;
  issues: { folder: string; message: string }[];
};

// The local host reads its configured directory. Browser code never requests an
// arbitrary filesystem path, and this request never contacts the cloud engine.
export async function readWorkflowLibrary(): Promise<WorkflowLibrarySnapshot> {
  const response = await fetch(import.meta.env.BASE_URL + "__canvas/workflow-library", {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("本地工作流目录读取失败（HTTP " + response.status + "）。");
  const result = await response.json();
  if (!result || typeof result.sourcePath !== "string" || !Array.isArray(result.workflows) ||
    !Array.isArray(result.issues) || !Number.isFinite(result.loadedAt) || !Number.isFinite(result.scanned))
    throw new Error("当前服务未提供本地工作流目录，请使用画布启动程序。");
  return result;
}
