import { executionWorkflows, nodeComputeState } from "../compute/providers";
import { useMemo } from "react";
import { busyPhases } from "../types";
import { activeCanvas, useStore } from "../stores/store";
import { findWorkflow } from "../workflow/catalog";
import { selectWorkflowOutput } from "../workflow/execution";
import { usePromptOptimization } from "./use-prompt-optimization";
import { OptimizationControls, OptimizationFeedback } from "./OptimizationControls";

/** The toolbar follows selection. Its optimization job lives independently in
 * the background, so returning to this editor restores the saved draft state. */
export function TextNodeOptimization({ nodeId }: { nodeId: string }) {
  const canvas = useStore(activeCanvas), assets = useStore(state => state.project.assets);
  const workflows = useStore(state => executionWorkflows(nodeComputeState(state, canvas.id, nodeId)));
  const node = canvas.nodes.find(item => item.id === nodeId);
  const task = useStore(state => state.project.tasks[node?.data.generation?.taskId ?? ""]);
  const definition = findWorkflow(workflows, node?.data.generation?.workflowId ?? "");
  const workflow = useMemo(() => definition ? selectWorkflowOutput(definition, node?.data.generation?.params ?? {}) : undefined, [definition, node?.data.generation?.params]);
  const controller = usePromptOptimization({ canvas, nodeId: node?.id, workflow, assets, disabled: !node || busyPhases.includes(task?.status ?? "idle"), promptField: "text" });
  return <div className="text-optimization nodrag nopan nowheel" aria-label="文本优化"
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <OptimizationControls controller={controller} />
    {controller.error && <OptimizationFeedback controller={controller} />}
  </div>;
}
