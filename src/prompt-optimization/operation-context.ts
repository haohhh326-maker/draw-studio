import { activeConnection, executionWorkflows, nodeComputeState } from "../compute/providers";
import type { useStore } from "../stores/store";
import { busyPhases } from "../types";
import { findWorkflow } from "../workflow/catalog";
import { selectWorkflowOutput } from "../workflow/execution";
import { optimizationContextIdentity, type OptimizationPromptField } from "./context";

export type OptimizationScope = { projectId: string; canvasId: string; nodeId: string; field: OptimizationPromptField };

/** Jobs belong to a saved node/field, independently of visible editors, selection
 * and the active canvas. Only changes to their real inputs invalidate results. */
export function optimizationOperationIdentity(state: ReturnType<typeof useStore.getState>, scope: OptimizationScope) {
  if (!state.projectOpen || state.project.id !== scope.projectId) return "missing";
  state = nodeComputeState(state, scope.canvasId, scope.nodeId);
  const canvas = state.project.canvases.find(item => item.id === scope.canvasId), node = canvas?.nodes.find(item => item.id === scope.nodeId);
  if (!canvas || !node || (scope.field === "generation" && !node.data.generation)) return "missing";
  const definition = findWorkflow(executionWorkflows(state), node.data.generation?.workflowId ?? "");
  const workflow = definition ? selectWorkflowOutput(definition, node.data.generation?.params ?? {}) : undefined;
  const task = state.project.tasks[node.data.generation?.taskId ?? ""];
  // Independent note text and generation input may optimize concurrently.
  // Scope the target snapshot to the field actually sent to the model.
  const contextCanvas = { ...canvas, nodes: canvas.nodes.map(item => item.id !== node.id ? item : { ...item,
    data: scope.field === "text" ? { ...item.data, generation: undefined } : { ...item.data, text: undefined } }) };
  return JSON.stringify([state.project.id, state.projectOpen, canvas.id, scope.field,
    busyPhases.includes(task?.status ?? "idle"), state.computeProvider, activeConnection(state),
    optimizationContextIdentity(contextCanvas, node.id, scope.field === "text" ? undefined : workflow, state.project.assets)]);
}
