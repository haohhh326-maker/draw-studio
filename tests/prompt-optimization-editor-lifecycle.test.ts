import { beforeEach, expect, it, vi } from "vitest";
import type { Project } from "../src/types";
vi.mock("../src/projects/storage", () => ({ readRecord: async () => undefined, writeRecord: async () => {}, safeConnection: (value: object) => value, getBlob: vi.fn() }));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));
import { useStore } from "../src/stores/store";
import { closeGenerationPanelTarget, openGenerationPanelTarget, syncGenerationPanelTarget, useGenerationPanelState } from "../src/generation/generation-panel-state";
import { optimizationOperationIdentity } from "../src/prompt-optimization/operation-context";
import { createOptimizationGuard } from "../src/prompt-optimization/operation-guard";
import { createPromptDraftSessions } from "../src/prompt-optimization/prompt-drafts";

const scope = { projectId: "project", canvasId: "canvas", nodeId: "node" };
beforeEach(() => {
  const project: Project = { version: 2, id: scope.projectId, name: "Test", activeCanvasId: scope.canvasId, scenes: [], updatedAt: 1,
    assets: {}, tasks: {}, history: [], canvases: [{ id: scope.canvasId, name: "Canvas", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 }, edges: [], nodes: [
      { id: "node", position: { x: 0, y: 0 }, data: { kind: "text", title: "Text", text: "original note", generation: { workflowId: "", prompt: "original prompt", negativePrompt: "keep", params: {}, taskId: null } } },
      { id: "other", position: { x: 200, y: 0 }, data: { kind: "reference", title: "Reference" } },
    ] }] };
  useStore.setState({ project, projectOpen: true, selectedId: "node", selectedEdgeId: null, workflows: [] });
  openGenerationPanelTarget(scope);
});
function guard(field: "text" | "generation" = "generation") {
  return createOptimizationGuard(() => optimizationOperationIdentity(useStore.getState(), { ...scope, field }), listener => {
    const a = useStore.subscribe(listener), b = useGenerationPanelState.subscribe(listener);
    return () => { a(); b(); };
  });
}
it.each(["generation", "text"] as const)("keeps a pending %s response and both drafts after blank clicks, reference selection and viewport motion", async field => {
  const operation = guard(field), drafts = createPromptDraftSessions();
  const original = field === "text" ? "original note" : "original prompt", source = drafts.capture("editor", original);
  let finish!: (value: string) => void;
  const delayed = new Promise<string>(resolve => { finish = resolve; });
  const completion = delayed.then(value => operation.valid() && drafts.complete("editor", source, value));
  for (const selection of [null, "other", null]) {
    useStore.setState({ selectedId: selection, selectedEdgeId: selection === null ? "edge" : null });
    const state = useStore.getState(); syncGenerationPanelTarget(state.project.id, state.project.canvases[0], selection);
  }
  useStore.getState().editCanvas(canvas => ({ ...canvas, viewport: { x: 500, y: -700, zoom: 0.5 }, nodes: canvas.nodes.map(node => ({ ...node, selected: false })) }));
  expect(operation.valid()).toBe(true); expect(operation.signal.aborted).toBe(false);
  finish("optimized prompt"); expect(await completion).toMatchObject({ original, optimized: "optimized prompt", version: "optimized" });
  expect(drafts.switchVersion("editor", "optimized prompt")).toMatchObject({ original, version: "original" });
  expect(drafts.switchVersion("editor", original)).toMatchObject({ optimized: "optimized prompt", version: "optimized" });
  operation.dispose();
});
it.each(["close", "other-editor", "canvas"])("keeps a background response valid after %s presentation changes", change => {
  const operation = guard();
  if (change === "close") closeGenerationPanelTarget();
  if (change === "other-editor") openGenerationPanelTarget({ ...scope, nodeId: "other-editor" });
  if (change === "canvas") useStore.setState(state => ({ project: { ...state.project, activeCanvasId: "different" } }));
  expect(operation.valid()).toBe(true); expect(operation.signal.aborted).toBe(false);
  operation.dispose();
});
it.each(["delete", "edit", "delete-canvas", "close-project", "project", "connection"])("rejects a delayed response after %s", change => {
  const operation = guard();
  if (change === "delete") useStore.getState().editCanvas(canvas => ({ ...canvas, nodes: canvas.nodes.filter(node => node.id !== scope.nodeId) }));
  if (change === "edit") {
    const node = useStore.getState().project.canvases[0].nodes[0];
    useStore.getState().patchNode(scope.nodeId, { generation: { ...node.data.generation!, prompt: "edited" } });
    useStore.getState().patchNode(scope.nodeId, { generation: { ...node.data.generation!, prompt: "original prompt" } });
  }
  if (change === "delete-canvas") useStore.setState(state => ({ project: { ...state.project, canvases: [] } }));
  if (change === "close-project") useStore.setState({ projectOpen: false });
  if (change === "project") useStore.setState(state => ({ project: { ...state.project, id: "different" } }));
  if (change === "connection") useStore.setState(state => ({ connection: { ...state.connection, baseUrl: "http://another-host:8188" } }));
  expect(operation.valid()).toBe(false); expect(operation.signal.aborted).toBe(true);
  operation.dispose();
});
