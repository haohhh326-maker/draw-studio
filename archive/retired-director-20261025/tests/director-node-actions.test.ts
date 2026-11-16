import { beforeEach, describe, expect, it, vi } from "vitest";
import { busyPhases, type CanvasNode, type Project } from "../src/types";
const live = vi.hoisted(() => ({ running: false }));
vi.mock("../src/director/execution", () => ({ directorRunning: () => live.running }));
vi.mock("../src/projects/storage", () => ({ readRecord: async () => undefined, writeRecord: async () => {}, safeConnection: (value: unknown) => value }));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));
import { deleteDirectorNode, isDirectorDeleteKey, nodeRemovalBlocked, selectDirectorNode } from "../src/director/node-actions";
import { useStore } from "../src/stores/store";

const director = (status = "idle"): CanvasNode => ({ id: "director", type: "director", position: { x: 100, y: 200 },
  data: { title: "导演台", kind: "director", director: { run: { status } } } });
function project(status = "idle"): Project {
  return { version: 2, id: "project", name: "Test", activeCanvasId: "canvas", scenes: [{ id: "scene", name: "场景" }], updatedAt: 1,
    canvases: [{ id: "canvas", name: "画布", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [director(status), { id: "image", type: "media", position: { x: 0, y: 0 }, data: { title: "图片", kind: "reference", assetId: "asset" } }],
      edges: [{ id: "input", source: "image", target: "director" }, { id: "output", source: "director", target: "image" }, { id: "keep", source: "image", target: "other" }] }],
    assets: { asset: { id: "asset", kind: "image", name: "image.png", mime: "image/png", size: 1, createdAt: 1 } }, tasks: {}, history: [] };
}
beforeEach(() => {
  live.running = false;
  useStore.setState({ project: project(), projects: {}, projectOpen: true, navigating: false, ready: false, workflows: [], past: [], future: [], selectedId: "director", selectedEdgeId: "input" });
});

describe("director node deletion", () => {
  it("repairs selectedId and node.selected divergence even when the director id is already active", () => {
    expect(useStore.getState().project.canvases[0].nodes[0].selected).toBeUndefined();
    selectDirectorNode("director");
    const state = useStore.getState();
    expect(state.selectedId).toBe("director"); expect(state.selectedEdgeId).toBeNull();
    expect(state.project.canvases[0].nodes[0].selected).toBe(true);
    expect(state.project.canvases[0].nodes[1].selected).toBe(false);
    expect(state.past).toHaveLength(0);
  });

  it("deletes the node and its attached edges, retains assets, clears stale selection and supports undo", () => {
    expect(deleteDirectorNode("director")).toBe(true);
    const state = useStore.getState();
    expect(state.project.canvases[0].nodes.map(node => node.id)).toEqual(["image"]);
    expect(state.project.canvases[0].edges.map(edge => edge.id)).toEqual(["keep"]);
    expect(state.project.assets.asset.name).toBe("image.png");
    expect(state.selectedId).toBeNull(); expect(state.selectedEdgeId).toBeNull();
    expect(state.past).toHaveLength(1);
    state.undo();
    expect(useStore.getState().project.canvases[0].nodes.map(node => node.id)).toEqual(["director", "image"]);
    expect(useStore.getState().project.canvases[0].edges).toHaveLength(3);
  });

  it.each(busyPhases)("blocks a persisted %s task without changing its node or edges", status => {
    useStore.setState({ project: project(status) });
    const before = useStore.getState().project;
    expect(nodeRemovalBlocked(before, "canvas", before.canvases[0].nodes[0])).toBe(true);
    expect(deleteDirectorNode("director")).toBe(false);
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it("blocks a live task before its persisted status has caught up", () => {
    live.running = true;
    expect(deleteDirectorNode("director")).toBe(false);
    expect(useStore.getState().project.canvases[0].nodes).toHaveLength(2);
  });

  it.each(["completed", "failed", "cancelled", "interrupted"])("allows deletion after %s", status => {
    useStore.setState({ project: project(status) });
    expect(deleteDirectorNode("director")).toBe(true);
  });
});

describe("director deletion keys", () => {
  const key = (name: string, editable = false) => ({ key: name, target: { closest: () => editable ? {} : null } as unknown as EventTarget,
    defaultPrevented: false, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
  it.each(["Delete", "Backspace"])("deletes using %s outside an editor", name => {
    expect(isDirectorDeleteKey(key(name))).toBe(true);
  });
  it.each(["Delete", "Backspace"])("keeps %s inside prompt, parameter and nested contenteditable editors", name => {
    expect(isDirectorDeleteKey(key(name, true))).toBe(false);
    expect(isDirectorDeleteKey({ ...key(name), composedPath: () => [key(name, true).target] })).toBe(false);
  });
  it("ignores composing text, modified shortcuts and an event already handled by the editor", () => {
    expect(isDirectorDeleteKey({ ...key("Backspace"), isComposing: true })).toBe(false);
    expect(isDirectorDeleteKey({ ...key("Backspace"), ctrlKey: true })).toBe(false);
    expect(isDirectorDeleteKey({ ...key("Delete"), defaultPrevented: true })).toBe(false);
    expect(isDirectorDeleteKey(key("Enter"))).toBe(false);
  });
});
