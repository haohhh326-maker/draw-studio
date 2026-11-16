import type { MediaKind, WorkflowDefinition } from "../types";

type OutputCategory = Exclude<MediaKind, "file">;

/** Output contracts own media classification. Image previews cannot hide video/audio results. */
export function declaredWorkflowCategory(workflow: Pick<WorkflowDefinition, "output" | "additionalOutputs">): OutputCategory | undefined {
  const outputs = [workflow.output, ...(workflow.additionalOutputs ?? [])];
  return (["video", "audio", "image", "text"] as const).find(kind => outputs.some(output => output.kind === kind));
}

/** Public topic tags never establish what media an application actually returns. */
export function runningHubWorkflowCategory(workflow: WorkflowDefinition): OutputCategory | undefined {
  return declaredWorkflowCategory(workflow);
}
