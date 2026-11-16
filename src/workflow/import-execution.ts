import type { WorkflowDefinition } from "../types";

/** Only managed, saved editor imports have a source that the local resolver can re-read. */
export function canCheckImportedWorkflow(workflow?: WorkflowDefinition) {
  return workflow?.library?.importStatus === "pending" &&
    workflow.library.runnerType === "comfyui" &&
    /^custom\.[a-f0-9]{64}$/.test(workflow.original?.id ?? "");
}

export function importDependencyMessage(workflow?: WorkflowDefinition) {
  const details = workflow?.library?.diagnostics?.map(item => item.message).filter(Boolean);
  return details?.length ? "缺失项：" + [...new Set(details)].join("；") :
    workflow?.library?.executionIssue || "没有读取到完整的节点定义、参数或输出信息。";
}
