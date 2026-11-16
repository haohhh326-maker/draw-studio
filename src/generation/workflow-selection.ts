import type { Generation, NodeData, WorkflowDefinition } from "../types";
import { defaults } from "../workflow/catalog";

/** Selecting an execution model never imports its example prompt into the user's draft. */
export function workflowSelectionPatch(generation: Generation, workflow: WorkflowDefinition): Pick<NodeData, "kind" | "generation"> {
  const kind = workflow.output.kind === "image" ? "image-generation"
    : workflow.output.kind === "file" ? "tool" : workflow.output.kind;
  return {
    kind,
    generation: { ...generation, workflowId: workflow.id, params: defaults(workflow) },
  };
}
