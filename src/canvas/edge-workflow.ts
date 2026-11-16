import { executionWorkflows, nodeComputeState } from "../compute/providers";
import { findWorkflow } from "../workflow/catalog";

/** An edge's input choices belong to its destination card, even when another provider is selected. */
export function workflowForCanvasEdge(state: Parameters<typeof nodeComputeState>[0], canvasId: string, edgeId: string | null | undefined) {
  const canvas = state.project.canvases.find(item => item.id === canvasId);
  const edge = edgeId ? canvas?.edges.find(item => item.id === edgeId) : undefined;
  const target = edge ? canvas?.nodes.find(item => item.id === edge.target) : undefined;
  const generation = target?.data.generation;
  return generation && target
    ? findWorkflow(executionWorkflows(nodeComputeState(state, canvasId, target.id)), generation.workflowId)
    : undefined;
}
