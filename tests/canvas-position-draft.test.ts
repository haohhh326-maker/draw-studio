import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "../src/types";
import { CanvasPositionDraft, flushCanvasPositionDrafts, registerCanvasPositionFlush } from "../src/canvas/position-draft";

const storage = vi.hoisted(() => ({ write: vi.fn(async (_key: string, _value: unknown) => {}) }));
vi.mock("../src/projects/storage", () => ({ readRecord: async () => undefined, writeRecord: storage.write, safeConnection: (value: object) => value, getBlob: vi.fn() }));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));
import { useStore } from "../src/stores/store";

const node = (id: string, parentId?: string): CanvasNode => ({ id, parentId, position: { x: 0, y: 0 }, data: { kind: "video", title: id } });
const cleanups: (() => void)[] = [];
beforeEach(() => {
  storage.write.mockClear();
  const initial = useStore.getInitialState();
  useStore.setState({ ...initial, ready: false, projectOpen: true, workflows: [], runningHubWorkflows: [], project: { ...initial.project,
    id: "project", activeCanvasId: "canvas", tasks: {}, history: [], assets: {}, canvases: [{ id: "canvas", name: "Canvas", sceneId: "scene",
      nodes: [node("a"), node("b")], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }],
  } });
});
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });

describe("transient canvas drag positions", () => {
  it("records 120 drag frames without changing the project or notifying its subscribers", () => {
    const state = useStore.getState();
    const original = state.project;
    const nodes = original.canvases[0].nodes;
    const draft = new CanvasPositionDraft(original.id, "canvas");
    const changed = vi.fn();
    cleanups.push(useStore.subscribe(changed));
    for (let x = 1; x <= 120; x++) draft.record([{ type: "position", id: "a", position: { x, y: 30 }, dragging: true }], nodes);
    expect(useStore.getState().project).toBe(original);
    expect(changed).not.toHaveBeenCalled();
    expect(draft.merge(nodes)[0]).toMatchObject({ position: { x: 120, y: 30 }, dragging: true });
    expect(nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it("merges positions into concurrent completed results and preserves untouched nodes and topology", () => {
    const nodes = [node("a"), node("b")];
    const draft = new CanvasPositionDraft("project", "canvas");
    draft.record([{ type: "position", id: "a", position: { x: 200, y: 70 }, dragging: true }], nodes);
    const data = { ...nodes[0].data, assetId: "completed-video", title: "Finished", generation: {
      workflowId: "runninghub-video", prompt: "new prompt", negativePrompt: "", params: { seed: 17 }, taskId: "running-task",
    } };
    const latest = [{ ...nodes[0], data, style: { width: 700 } }, nodes[1]];
    const result = draft.merge(latest, true);
    expect(result[0]).toMatchObject({ position: { x: 200, y: 70 }, dragging: false, style: { width: 700 } });
    expect(result[0].data).toBe(data);
    expect(result[1]).toBe(nodes[1]);
    expect(draft.merge(result, true)).toBe(result);
  });

  it("preserves group-relative positions and applies all selected nodes together", () => {
    const nodes = [node("group"), node("child", "group"), node("other")];
    const draft = new CanvasPositionDraft("project", "canvas");
    draft.record([{ type: "position", id: "group", position: { x: 100, y: 50 }, dragging: true },
      { type: "position", id: "other", position: { x: 200, y: 150 }, dragging: true }], nodes);
    const result = draft.merge(nodes, true);
    expect(result[0].position).toEqual({ x: 100, y: 50 });
    expect(result[1]).toBe(nodes[1]);
    expect(result[2].position).toEqual({ x: 200, y: 150 });
  });

  it("does not resurrect deleted nodes or apply old coordinates after reparenting", () => {
    const nodes = [node("a"), node("b")];
    const draft = new CanvasPositionDraft("project", "canvas");
    draft.record(nodes.map(item => ({ type: "position", id: item.id, position: { x: 100, y: 80 }, dragging: true })), nodes);
    const latest = [{ ...nodes[1], parentId: "new-group", position: { x: 10, y: 20 } }];
    expect(draft.merge(latest, true)).toBe(latest);
  });

  it("save flushes visible coordinates before taking its snapshot and later drag frames remain available", async () => {
    const draft = new CanvasPositionDraft("project", "canvas");
    const apply = (finish: boolean) => {
      const current = useStore.getState();
      current.editProject(project => ({ ...project, canvases: project.canvases.map(canvas => ({ ...canvas, nodes: draft.merge(canvas.nodes, true) })) }));
      expect(finish).toBe(false);
    };
    cleanups.push(registerCanvasPositionFlush(apply));
    draft.record([{ type: "position", id: "a", position: { x: 80, y: 40 }, dragging: true }], useStore.getState().project.canvases[0].nodes);
    await useStore.getState().save(true);
    const saved = storage.write.mock.calls.find(call => call[0] === "project-library")?.[1] as any;
    expect(saved.project.project.canvases[0].nodes[0]).toMatchObject({ position: { x: 80, y: 40 }, dragging: false });
    draft.record([{ type: "position", id: "a", position: { x: 160, y: 90 }, dragging: true }], useStore.getState().project.canvases[0].nodes);
    flushCanvasPositionDrafts();
    expect(useStore.getState().project.canvases[0].nodes[0].position).toEqual({ x: 160, y: 90 });
  });

  it("undo finishes the draft first, restores the start, and redo restores the final position", () => {
    useStore.getState().checkpoint();
    let draft: CanvasPositionDraft | null = new CanvasPositionDraft("project", "canvas");
    draft.record([{ type: "position", id: "a", position: { x: 80, y: 40 }, dragging: true }], useStore.getState().project.canvases[0].nodes);
    cleanups.push(registerCanvasPositionFlush(finish => {
      const current = draft;
      if (finish) draft = null;
      if (current) useStore.getState().editProject(project => ({ ...project, canvases: project.canvases.map(canvas => ({ ...canvas, nodes: current.merge(canvas.nodes, true) })) }));
    }));
    useStore.getState().undo();
    expect(draft).toBeNull();
    expect(useStore.getState().project.canvases[0].nodes[0].position).toEqual({ x: 0, y: 0 });
    flushCanvasPositionDrafts();
    expect(useStore.getState().project.canvases[0].nodes[0].position).toEqual({ x: 0, y: 0 });
    useStore.getState().redo();
    expect(useStore.getState().project.canvases[0].nodes[0].position).toEqual({ x: 80, y: 40 });
  });

  it("keeps the final drag position when changing projects fails and rolls back", async () => {
    let draft: CanvasPositionDraft | null = new CanvasPositionDraft("project", "canvas");
    draft.record([{ type: "position", id: "a", position: { x: 120, y: 60 }, dragging: true }], useStore.getState().project.canvases[0].nodes);
    cleanups.push(registerCanvasPositionFlush(finish => {
      const current = draft;
      if (finish) draft = null;
      if (current) useStore.getState().editProject(project => ({ ...project, canvases: project.canvases.map(canvas => ({ ...canvas, nodes: current.merge(canvas.nodes, true) })) }));
    }));
    storage.write.mockRejectedValueOnce(new Error("disk unavailable"));
    const next = { ...useStore.getState().project, id: "next-project" };
    await expect(useStore.getState().enterProject(next, [])).rejects.toThrow("disk unavailable");
    expect(draft).toBeNull();
    expect(useStore.getState().project.id).toBe("project");
    expect(useStore.getState().project.canvases[0].nodes[0]).toMatchObject({ position: { x: 120, y: 60 }, dragging: false });
  });
});
