import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode, Project } from "../src/types";
vi.mock("../src/projects/storage", () => ({ readRecord: async () => undefined, writeRecord: async () => {}, safeConnection: (value: object) => value, getBlob: vi.fn() }));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));
import { useStore } from "../src/stores/store";

function node(prompt: string): CanvasNode {
  return { id: "shared-id", position: { x: 0, y: 0 }, data: { kind: "text", title: prompt, text: prompt,
    generation: { workflowId: "", prompt, negativePrompt: "keep", params: {}, taskId: null } } };
}
beforeEach(() => {
  const project: Project = { version: 2, id: "project", name: "History", scenes: [], activeCanvasId: "canvas-b", updatedAt: 1, history: [], assets: {}, tasks: {}, canvases: [
    { id: "canvas-a", name: "A", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node("A original")], edges: [] },
    { id: "canvas-b", name: "B", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node("B original")], edges: [] },
  ] };
  useStore.setState({ project, projectOpen: true, workflows: [], selectedId: null, selectedEdgeId: null, past: [], future: [], toast: "" });
});
function prompt(canvasId: string) { return useStore.getState().project.canvases.find(canvas => canvas.id === canvasId)!.nodes[0].data.generation!.prompt; }
function edit(canvasId: string, value: string) {
  const current = useStore.getState().project.canvases.find(canvas => canvas.id === canvasId)!.nodes[0];
  useStore.getState().patchNode("shared-id", { generation: { ...current.data.generation!, prompt: value } }, canvasId);
}
const select = (canvasId: string) => useStore.setState(state => ({ project: { ...state.project, activeCanvasId: canvasId } }));

describe("canvas-scoped checkpoints in the real project store", () => {
  it("undoes and redoes a background edit on its source canvas while another canvas is visible", () => {
    useStore.getState().checkpoint("canvas-a"); edit("canvas-a", "A optimized");
    expect(useStore.getState().project.activeCanvasId).toBe("canvas-b");
    expect(useStore.getState().past.at(-1)?.canvasId).toBe("canvas-a");
    useStore.getState().undo();
    expect(prompt("canvas-a")).toBe("A original"); expect(prompt("canvas-b")).toBe("B original");
    expect(useStore.getState().future[0]).toMatchObject({ canvasId: "canvas-a", nodes: [{ data: { generation: { prompt: "A optimized" } } }] });
    select("canvas-b"); useStore.getState().redo();
    expect(prompt("canvas-a")).toBe("A optimized"); expect(prompt("canvas-b")).toBe("B original");
    expect(useStore.getState().past.at(-1)).toMatchObject({ canvasId: "canvas-a", nodes: [{ data: { generation: { prompt: "A original" } } }] });
    select("canvas-b"); useStore.getState().undo();
    expect(prompt("canvas-a")).toBe("A original"); expect(prompt("canvas-b")).toBe("B original");
  });
  it("retains the global operation order for interleaved edits on two canvases", () => {
    useStore.getState().checkpoint("canvas-a"); edit("canvas-a", "A first");
    useStore.getState().checkpoint(); edit("canvas-b", "B first");
    select("canvas-a"); useStore.getState().undo();
    expect(prompt("canvas-a")).toBe("A first"); expect(prompt("canvas-b")).toBe("B original");
    useStore.getState().undo();
    expect(prompt("canvas-a")).toBe("A original"); expect(prompt("canvas-b")).toBe("B original");
    expect(useStore.getState().future.map(snapshot => snapshot.canvasId)).toEqual(["canvas-a", "canvas-b"]);
    select("canvas-b"); useStore.getState().redo();
    expect(prompt("canvas-a")).toBe("A first"); expect(prompt("canvas-b")).toBe("B original");
    select("canvas-a"); useStore.getState().redo();
    expect(prompt("canvas-a")).toBe("A first"); expect(prompt("canvas-b")).toBe("B first");
    expect(useStore.getState().past.map(snapshot => snapshot.canvasId)).toEqual(["canvas-a", "canvas-b"]);
  });
  it("preserves the default active-canvas checkpoint behavior", () => {
    useStore.getState().checkpoint(); edit("canvas-b", "B changed");
    expect(useStore.getState().past.at(-1)?.canvasId).toBe("canvas-b");
    useStore.getState().undo(); expect(prompt("canvas-b")).toBe("B original");
    useStore.getState().redo(); expect(prompt("canvas-b")).toBe("B changed");
    expect(prompt("canvas-a")).toBe("A original");
  });
  it("ignores a missing explicit checkpoint without clearing redo or changing the store", () => {
    useStore.getState().checkpoint("canvas-a"); edit("canvas-a", "A changed"); useStore.getState().undo();
    const previous = useStore.getState();
    expect(() => previous.checkpoint("deleted-canvas")).not.toThrow();
    expect(useStore.getState()).toBe(previous); expect(useStore.getState().future).toHaveLength(1);
  });
  it.each(["undo", "redo"] as const)("ignores %s when its saved canvas was deleted instead of restoring another canvas or selecting a missing one", action => {
    useStore.getState().checkpoint("canvas-a"); edit("canvas-a", "A changed");
    if (action === "redo") useStore.getState().undo();
    useStore.setState(state => ({ project: { ...state.project, activeCanvasId: "canvas-b", canvases: state.project.canvases.filter(canvas => canvas.id !== "canvas-a") } }));
    const previous = useStore.getState();
    expect(() => previous[action]()).not.toThrow();
    expect(useStore.getState()).toBe(previous); expect(prompt("canvas-b")).toBe("B original");
    expect(useStore.getState().project.activeCanvasId).toBe("canvas-b");
  });
});
