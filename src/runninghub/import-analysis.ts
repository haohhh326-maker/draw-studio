import type { ApiWorkflow, WorkflowDefinition } from "../types";
import { detectWorkflowCredentials } from "../workflow/credentials";
import { aifisherReadResultFor } from "../workflow/aifisher-reader-client";
import { isRunningHubAppCredentialField, type RunningHubAiApp } from "./client";
import { analyzeRunningHubUpstream, requireRunningHubReader } from "./upstream-reader";

/** Credentials are a canvas container concern, independent from workflow reading. */
export function runningHubImportCredentialIdentities(graph: ApiWorkflow, app?: RunningHubAiApp): Set<string> {
  return new Set([...detectWorkflowCredentials({ template: graph, parameters: [], mapping: [] } as unknown as WorkflowDefinition).map(field => JSON.stringify([field.nodeId, field.field])), ...(app?.nodeInfoList.filter(isRunningHubAppCredentialField).map(field => JSON.stringify([field.nodeId, field.fieldName])) ?? [])]);
}

/** Compatibility entry point; only an attached original reader result can supply analysis. */
export function analyzeRunningHubImport(graph: ApiWorkflow, app?: RunningHubAiApp) {
  const reader = requireRunningHubReader(app?.reader ?? aifisherReadResultFor(graph));
  return analyzeRunningHubUpstream(reader, app?.outputKind);
}
