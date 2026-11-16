import { create } from "zustand";
import type { Canvas, CanvasNode } from "../types";

/** Visible editor only. Background optimization jobs have an independent lifetime. */
export type GenerationPanelTarget = { projectId: string; canvasId: string; nodeId: string };
export const useGenerationPanelState = create<{ target: GenerationPanelTarget | null }>(() => ({ target: null }));

export function resolvePanelEditorTarget(target: GenerationPanelTarget | null, projectId: string, canvas: Canvas): CanvasNode | undefined {
  if (!target || target.projectId !== projectId || target.canvasId !== canvas.id) return undefined;
  return canvas.nodes.find(node => node.id === target.nodeId && (!!node.data.generation || node.data.kind === "text"));
}
export function resolveGenerationPanelTarget(target: GenerationPanelTarget | null, projectId: string, canvas: Canvas): CanvasNode | undefined {
  const node = resolvePanelEditorTarget(target, projectId, canvas);
  return node?.data.generation ? node : undefined;
}
export function resolveTextPanelTarget(target: GenerationPanelTarget | null, projectId: string, canvas: Canvas): CanvasNode | undefined {
  const node = resolvePanelEditorTarget(target, projectId, canvas);
  return node?.data.kind === "text" ? node : undefined;
}

/** Clearing selection or selecting a reference/edge closes the visible editor. */
export function nextGenerationPanelTarget(_previous: GenerationPanelTarget | null, projectId: string, canvas: Canvas, selectedId: string | null): GenerationPanelTarget | null {
  if (selectedId === null) return null;
  const selected = canvas.nodes.find(node => node.id === selectedId && (!!node.data.generation || node.data.kind === "text"));
  if (selected) return { projectId, canvasId: canvas.id, nodeId: selected.id };
  return null;
}

function sameTarget(a: GenerationPanelTarget | null, b: GenerationPanelTarget | null) {
  return a === b || !!a && !!b && a.projectId === b.projectId && a.canvasId === b.canvasId && a.nodeId === b.nodeId;
}
export function openGenerationPanelTarget(target: GenerationPanelTarget) {
  if (!sameTarget(useGenerationPanelState.getState().target, target)) useGenerationPanelState.setState({ target });
}
export function closeGenerationPanelTarget() {
  if (useGenerationPanelState.getState().target) useGenerationPanelState.setState({ target: null });
}
export function syncGenerationPanelTarget(projectId: string, canvas: Canvas, selectedId: string | null) {
  const previous = useGenerationPanelState.getState().target;
  const target = nextGenerationPanelTarget(previous, projectId, canvas, selectedId);
  if (!sameTarget(previous, target)) useGenerationPanelState.setState({ target });
}
