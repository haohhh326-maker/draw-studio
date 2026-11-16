import { activeCanvas, taskForNode, useStore } from "../stores/store";
import { busyPhases, type CanvasNode, type Project } from "../types";
import { directorRunning } from "./execution";

export function nodeRemovalBlocked(project: Project, canvasId: string, node?: CanvasNode) {
  return busyPhases.includes(taskForNode(project, node).status)
    || (node?.data.kind === "director" && directorRunning(canvasId, node.id));
}

/** Form editing keeps Delete/Backspace, including nested contenteditable targets. */
export function isDirectorDeleteKey(event: Pick<KeyboardEvent, "key" | "target" | "defaultPrevented" | "isComposing" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & { composedPath?: () => EventTarget[] }) {
  if (!["Delete", "Backspace"].includes(event.key) || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  const target = (event.composedPath?.()[0] ?? event.target) as HTMLElement | null;
  return !target?.closest?.("input,textarea,select,[contenteditable],[role=textbox]");
}

export function selectDirectorNode(id: string) {
  const state = useStore.getState(), canvas = activeCanvas(state);
  const node = canvas.nodes.find(item => item.id === id && item.data.kind === "director");
  if (!node || (state.selectedId === id && node.selected)) return;
  state.editCanvas(current => ({ ...current, nodes: current.nodes.map(item => ({ ...item, selected: item.id === id })) }));
  useStore.setState({ selectedId: id, selectedEdgeId: null });
}

export function deleteDirectorNode(id: string) {
  const state = useStore.getState(), canvas = activeCanvas(state);
  const node = canvas.nodes.find(item => item.id === id && item.data.kind === "director");
  if (!node) return false;
  if (nodeRemovalBlocked(state.project, canvas.id, node)) {
    state.notify("导演台正在运行，请先停止任务后再删除。");
    return false;
  }
  const removedEdges = new Set(canvas.edges.filter(edge => edge.source === id || edge.target === id).map(edge => edge.id));
  state.editCanvas(current => ({ ...current, nodes: current.nodes.filter(item => item.id !== id),
    edges: current.edges.filter(edge => !removedEdges.has(edge.id)) }), true);
  useStore.setState({ selectedId: state.selectedId === id ? null : state.selectedId,
    selectedEdgeId: state.selectedEdgeId && removedEdges.has(state.selectedEdgeId) ? null : state.selectedEdgeId });
  return true;
}
