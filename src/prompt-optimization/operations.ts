import { executionWorkflows, nodeComputeState } from "../compute/providers";
import { useStore } from "../stores/store";
import { busyPhases } from "../types";
import { findWorkflow } from "../workflow/catalog";
import { selectWorkflowOutput } from "../workflow/execution";
import { optimizationClient, OptimizationError } from "./client";
import { collectOptimizationContext, optimizationPromptPatch, readOptimizationPrompt } from "./context";
import { createOptimizationGuard } from "./operation-guard";
import { optimizationOperationIdentity, type OptimizationScope } from "./operation-context";
import { isPromptHistoryRestore, promptDraftKey, promptDraftSessions, type PromptVersion, type createPromptDraftSessions } from "./prompt-drafts";
import type { OptimizationResult } from "./types";

type OperationState = { loading: boolean; message: string; error: OptimizationError | null; result: OptimizationResult | null };
const idle: OperationState = Object.freeze({ loading: false, message: "", error: null, result: null });
type Dependencies = {
  readState: typeof useStore.getState;
  subscribe: (listener: () => void) => () => void;
  settings: typeof optimizationClient.settings;
  collect: typeof collectOptimizationContext;
  optimize: typeof optimizationClient.optimize;
  drafts: ReturnType<typeof createPromptDraftSessions>;
};

/** A UI subscription only observes a job. Unmounting or hiding its editor never
 * owns cancellation; each running job keeps its own input guard and source draft. */
export function createOptimizationOperations(deps: Dependencies) {
  const states = new Map<string, OperationState>(), pending = new Map<string, ReturnType<typeof createOptimizationGuard>>();
  const listeners = new Set<() => void>();
  const key = (scope: OptimizationScope) => promptDraftKey(scope.projectId, scope.canvasId, scope.nodeId, scope.field);
  const get = (scope: OptimizationScope) => states.get(key(scope)) ?? idle;
  const publish = (scope: OptimizationScope, patch: Partial<OperationState>) => {
    states.set(key(scope), { ...get(scope), ...patch });
    for (const listener of listeners) listener();
  };
  const location = (scope: OptimizationScope) => {
    const state = nodeComputeState(deps.readState(), scope.canvasId, scope.nodeId);
    if (!state.projectOpen || state.project.id !== scope.projectId) return;
    const canvas = state.project.canvases.find(item => item.id === scope.canvasId), node = canvas?.nodes.find(item => item.id === scope.nodeId);
    if (!canvas || !node || (scope.field === "generation" && !node.data.generation)) return;
    const task = state.project.tasks[node.data.generation?.taskId ?? ""];
    if (busyPhases.includes(task?.status ?? "idle")) return;
    return { state, canvas, node };
  };
  // Capture edits even while a panel is hidden, including history restores.
  const restoreSavedDrafts = (state: ReturnType<Dependencies["readState"]>, restore = false) => {
    for (const canvas of state.project.canvases) for (const node of canvas.nodes) for (const field of ["generation", "text"] as const) {
      if (field === "generation" && !node.data.generation) continue;
      const draftKey = promptDraftKey(state.project.id, canvas.id, node.id, field);
      if (node.data.promptDrafts?.[field]) deps.drafts.restore(draftKey, node.data.promptDrafts[field]);
      if (deps.drafts.get(draftKey)) deps.drafts.capture(draftKey, readOptimizationPrompt(node, field), restore);
    }
  };
  let previous = deps.readState();
  restoreSavedDrafts(previous);
  const stopDraftCapture = deps.subscribe(() => {
    const state = deps.readState(), restore = isPromptHistoryRestore(state, previous);
    const changed = state.project.id !== previous.project.id || state.project.canvases !== previous.project.canvases;
    previous = state;
    if (!changed) return;
    restoreSavedDrafts(state, restore);
  });
  const cancel = (scope: OptimizationScope) => {
    const current = pending.get(key(scope));
    if (!current) return;
    pending.delete(key(scope)); current.cancel(); current.dispose();
    publish(scope, { loading: false, message: "优化已取消，原提示词保留。" });
  };
  const start = async (scope: OptimizationScope, textOnly = false) => {
    const operationKey = key(scope), source = location(scope);
    if (!source || pending.has(operationKey)) return;
    const { state, canvas, node } = source, original = readOptimizationPrompt(node, scope.field);
    deps.drafts.restore(operationKey, node.data.promptDrafts?.[scope.field]);
    const sourceDraft = deps.drafts.capture(operationKey, original);
    const definition = findWorkflow(executionWorkflows(state), node.data.generation?.workflowId ?? "");
    const workflow = definition ? selectWorkflowOutput(definition, node.data.generation?.params ?? {}) : undefined;
    const guard = createOptimizationGuard(() => optimizationOperationIdentity(deps.readState(), scope), deps.subscribe, () => {
      if (pending.get(operationKey) !== guard) return;
      pending.delete(operationKey); guard.dispose();
      publish(scope, { loading: false, message: "提示词或节点上下文已改变，本次优化已取消。" });
    });
    pending.set(operationKey, guard);
    publish(scope, { loading: true, error: null, result: null, message: "正在读取 Skill 与提示词上下文…" });
    try {
      const settings = await deps.settings(guard.signal, state.computeProvider);
      if (!guard.valid() || pending.get(operationKey) !== guard) return;
      const effectiveTextOnly = textOnly || state.computeProvider !== "comfyui" || !settings.readMedia;
      const context = await deps.collect(canvas, node.id, workflow, state.project.assets, { signal: guard.signal, textOnly: effectiveTextOnly, promptField: scope.field });
      if (!guard.valid() || pending.get(operationKey) !== guard) return;
      publish(scope, { message: "AI 正在优化提示词…" });
      const result = await deps.optimize(context, effectiveTextOnly, guard.signal, {
        computeProvider: state.computeProvider, connection: state.connection,
      });
      if (!guard.valid() || pending.get(operationKey) !== guard) return;
      const latest = location(scope);
      if (!latest || readOptimizationPrompt(latest.node, scope.field) !== original || deps.drafts.get(operationKey) !== sourceDraft) return;
      const patch = optimizationPromptPatch(latest.node, result.prompt, scope.field);
      if (!patch) return;
      guard.dispose(); pending.delete(operationKey);
      latest.state.checkpoint(scope.canvasId);
      const completed = deps.drafts.complete(operationKey, sourceDraft, result.prompt);
      if (!completed) return;
      latest.state.patchNode(scope.nodeId, { ...patch,
        promptDrafts: { ...latest.node.data.promptDrafts, [scope.field]: completed },
      }, scope.canvasId);
      publish(scope, { loading: false, result, message: "提示词已优化。" });
    } catch (cause) {
      if (!guard.valid() || pending.get(operationKey) !== guard) return;
      const textOnlyAllowed = !!(cause && typeof cause === "object" && "textOnlyAllowed" in cause && cause.textOnlyAllowed);
      const error = cause instanceof OptimizationError ? cause : new OptimizationError(cause instanceof Error ? cause.message : "优化失败。", undefined, textOnlyAllowed);
      publish(scope, { error, message: "" });
    } finally {
      guard.dispose();
      if (pending.get(operationKey) === guard) { pending.delete(operationKey); publish(scope, { loading: false }); }
    }
  };
  const switchVersion = (scope: OptimizationScope, requested?: PromptVersion) => {
    if (pending.has(key(scope))) return;
    const current = location(scope);
    if (!current) return;
    const prompt = readOptimizationPrompt(current.node, scope.field), operationKey = key(scope);
    deps.drafts.restore(operationKey, current.node.data.promptDrafts?.[scope.field]);
    if (deps.drafts.capture(operationKey, prompt).optimized === undefined) return;
    current.state.checkpoint(scope.canvasId);
    const next = deps.drafts.switchVersion(operationKey, prompt, requested);
    if (!next) return;
    const patch = optimizationPromptPatch(current.node, next[next.version]!, scope.field);
    if (!patch) return;
    current.state.patchNode(scope.nodeId, { ...patch, promptDrafts: { ...current.node.data.promptDrafts, [scope.field]: next } }, scope.canvasId);
    publish(scope, { error: null, message: next.version === "original" ? "已切换到原文。" : "已切换到优化提示词。" });
  };
  return { key, get, start, cancel, switchVersion,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { stopDraftCapture(); for (const job of pending.values()) { job.cancel(); job.dispose(); } pending.clear(); listeners.clear(); },
  };
}

export const optimizationOperations = createOptimizationOperations({ readState: useStore.getState, subscribe: listener => useStore.subscribe(listener),
  settings: optimizationClient.settings, collect: collectOptimizationContext, optimize: optimizationClient.optimize, drafts: promptDraftSessions });

