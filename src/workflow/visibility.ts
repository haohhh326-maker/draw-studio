import type { WorkflowDefinition } from "../types";

export const WORKFLOW_VISIBILITY_RECORD = "workflow-visibility";
export type WorkflowVisibilityPreferences = { version: 1; hiddenKeys: string[] };

function sourceIdentity(source: string) {
  const normalized = source.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

/** Preference identity follows the library source, even when old canvas IDs are aliases. */
export function workflowVisibilityKey(workflow: WorkflowDefinition) {
  return workflow.library ? JSON.stringify(["library", sourceIdentity(workflow.library.sourcePath), workflow.original?.id ?? workflow.directory?.bindingKey ?? workflow.id])
    : JSON.stringify(["workflow", workflow.id]);
}

export function readHiddenWorkflowKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Partial<WorkflowVisibilityPreferences>;
  if (record.version !== 1 || !Array.isArray(record.hiddenKeys)) return [];
  return [...new Set(record.hiddenKeys.filter(key => typeof key === "string" && key.length > 0 && key.length < 4096))];
}

/** The active directory owns the definitions; preferences never recreate removed entries. */
export function workflowVisibilityGroups(workflows: WorkflowDefinition[], hiddenKeys: readonly string[]) {
  const hidden = new Set(hiddenKeys);
  return {
    visible: workflows.filter(workflow => !hidden.has(workflowVisibilityKey(workflow))),
    hidden: workflows.filter(workflow => hidden.has(workflowVisibilityKey(workflow))),
  };
}
