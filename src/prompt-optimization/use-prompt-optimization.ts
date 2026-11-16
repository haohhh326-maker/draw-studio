import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useStore } from "../stores/store";
import type { Asset, Canvas, WorkflowDefinition } from "../types";
import { describeCanvasOptimizationTarget, optimizationPromptField, readOptimizationPrompt, type OptimizationPromptField } from "./context";
import { promptDraftKey, promptDraftSessions } from "./prompt-drafts";
import { optimizationOperations } from "./operations";
import { nodeComputeState } from "../compute/providers";

export function usePromptOptimization({ canvas, nodeId, workflow, assets, disabled, promptField }: {
  canvas: Canvas; nodeId?: string; workflow?: WorkflowDefinition; assets: Record<string, Asset>; disabled: boolean;
  promptField?: OptimizationPromptField;
}) {
  const projectId = useStore(state => state.project.id);
  const computeProvider = useStore(state => nodeComputeState(state, canvas.id, nodeId ?? "").computeProvider);
  const node = canvas.nodes.find(item => item.id === nodeId);
  const field = node ? optimizationPromptField(node, promptField) : promptField ?? "generation";
  const scope = useMemo(() => ({ projectId, canvasId: canvas.id, nodeId: nodeId ?? "", field }), [projectId, canvas.id, nodeId, field]);
  const draftKey = promptDraftKey(projectId, canvas.id, nodeId ?? "", field);
  const operation = useSyncExternalStore(optimizationOperations.subscribe, () => optimizationOperations.get(scope));
  const drafts = useSyncExternalStore(promptDraftSessions.subscribe, () => promptDraftSessions.get(draftKey));
  const target = useMemo(() => node ? describeCanvasOptimizationTarget(canvas, node, workflow, assets, field) : undefined, [node, workflow, canvas, assets, field]);
  const prompt = node ? readOptimizationPrompt(node, field) : "";
  useEffect(() => {
    if (nodeId && node && (field !== "generation" || node.data.generation)) {
      promptDraftSessions.restore(draftKey, node.data.promptDrafts?.[field]);
      promptDraftSessions.capture(draftKey, prompt);
    }
  }, [draftKey, nodeId, prompt, field, !!node, !!node?.data.generation, node?.data.promptDrafts]);
  // UI lifetime only subscribes to saved work. There is deliberately no cleanup
  // that cancels a job when selection or panel visibility changes.
  const run = async (textOnly = false) => {
    if (!disabled && nodeId && target) await optimizationOperations.start(scope, textOnly);
  };
  const switchVersion = (version?: "original" | "optimized") => {
    if (!disabled && nodeId && target) optimizationOperations.switchVersion(scope, version);
  };
  const canToggle = drafts?.optimized !== undefined;
  return { ...operation, canvasId: canvas.id, computeProvider, nodeId, promptField: field, canToggle, promptVersion: drafts?.version ?? "original",
    canUndo: canToggle && drafts?.version === "optimized", target, disabled: disabled || !target || !nodeId,
    run, cancel: () => optimizationOperations.cancel(scope), toggleVersion: () => switchVersion(), undoOptimization: () => switchVersion("original") };
}
export type OptimizationController = ReturnType<typeof usePromptOptimization>;
