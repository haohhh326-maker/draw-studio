import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode, Project } from "../src/types";

vi.mock("../src/projects/storage", () => ({ readRecord: async () => undefined, writeRecord: async () => {}, safeConnection: (value: unknown) => value }));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));
import { copyDirectorData, migrateDirectorCanvases } from "../src/director/node-migration";
import { createDirectorNode } from "../src/director/create-canvas";
import { projectBusy, taskForNode, useStore } from "../src/stores/store";
import { migrateProject } from "../src/projects/migrate";

function project(): Project {
  return { version: 2, id: "project", name: "Test", activeCanvasId: "canvas", scenes: [{ id: "scene", name: "场景" }], updatedAt: 1,
    canvases: [{ id: "canvas", name: "画布 1", sceneId: "scene", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }],
    assets: {}, tasks: {}, history: [] };
}
const data = () => ({ workflowId: "12345", instanceType: "plus", media: { "folder/image.png": "asset" },
  snapshot: { values: { global_prompt: "DO NOT SAVE", timeline_data: '{"global":{"prompt":"DO NOT SAVE"},"seconds":10}' }, timeline: { segments: [{ prompt: "DO NOT SAVE", seconds: 10 }] } },
  run: { taskId: "accepted-task", status: "completed", outputIds: ["result"], receipt: { taskId: "accepted-task", downloads: [{ key: "file", assetId: "result" }] } },
});

beforeEach(() => {
  useStore.setState({ project: project(), projects: {}, projectOpen: true, navigating: false, ready: false, workflows: [], past: [], future: [], selectedId: null, selectedEdgeId: null });
});

describe("director nodes", () => {
  it("creates a selected full director interface node inside the active canvas without adding a canvas tab", () => {
    useStore.setState({ selectedEdgeId: "old-edge" });
    const id = createDirectorNode({ x: 250, y: 300 });
    const state = useStore.getState(), canvas = state.project.canvases[0];
    expect(state.project.canvases).toHaveLength(1);
    expect(state.project.activeCanvasId).toBe("canvas");
    expect(canvas.nodes[0]).toMatchObject({ id, type: "director", selected: true, width: 880, height: 620, position: { x: 250, y: 300 }, data: { kind: "director", title: "导演台 1", director: {} } });
    expect(canvas.nodes[0].data.generation).toBeUndefined();
    expect(state.selectedId).toBe(id); expect(state.selectedEdgeId).toBeNull();
    expect(state.past).toHaveLength(1);
    state.undo();
    expect(useStore.getState().project.canvases[0].nodes).toHaveLength(0);
    useStore.getState().redo();
    expect(useStore.getState().project.canvases[0].nodes[0].id).toBe(id);
  });

  it("migrates a legacy dedicated tab to one ordinary canvas node, preserving media and receipts but not prompts", () => {
    const original = project(), canvas = original.canvases[0];
    canvas.name = "导演台 1"; canvas.kind = "director"; canvas.director = data();
    const migrated = migrateProject(original, []), restored = migrated.canvases[0];
    expect(restored.kind).toBe("standard"); expect(restored.director).toBeUndefined();
    expect(restored.id).toBe(canvas.id); expect(restored.name).toBe(canvas.name);
    expect(restored.nodes).toHaveLength(1);
    expect(restored.nodes[0]).toMatchObject({ type: "director", width: 880, height: 620, data: { kind: "director", director: { media: data().media, run: data().run, inlineLayoutVersion: 1 } } });
    expect(JSON.stringify(restored.nodes[0])).not.toContain("DO NOT SAVE");
    expect(original.canvases[0].director?.snapshot).toEqual(data().snapshot);
    expect(migrateProject(migrated, []).canvases[0].nodes).toEqual(restored.nodes);
  });

  it("keeps existing nodes and converts unfinished persisted work to recoverable state", () => {
    const original = project(), canvas = original.canvases[0];
    canvas.kind = "director"; canvas.director = { ...data(), run: { ...data().run, status: "generating" } };
    canvas.nodes = [{ id: "director-canvas", type: "media", position: { x: 50, y: 10 }, data: { kind: "reference", title: "参考 1" } }];
    const migrated = migrateDirectorCanvases(original), nodes = migrated.canvases[0].nodes;
    expect(nodes).toHaveLength(2); expect(nodes[0]).toEqual(canvas.nodes[0]);
    expect(nodes[1].id).not.toBe(nodes[0].id);
    expect(nodes[1].data.director?.run).toMatchObject({ status: "interrupted", taskId: "accepted-task", outputIds: ["result"] });
    expect(projectBusy(migrated)).toBe(false);
  });

  it("copies settings and media without inheriting accepted jobs or prompt drafts", () => {
    const original = data(), copy = copyDirectorData(original);
    expect(copy.run).toBeUndefined(); expect(copy.media).toEqual(original.media);
    expect(copy.workflowId).toBe(original.workflowId); expect(copy.instanceType).toBe("plus");
    expect(JSON.stringify(copy)).not.toContain("DO NOT SAVE");
    expect(original.run.taskId).toBe("accepted-task");
  });

  it.each([[360, 240], [420, 280]])("upgrades an old %i by %i card once and then preserves user resizing", (width, height) => {
    const original = project();
    original.canvases[0].nodes = [{ id: "director", type: "director", position: { x: -150, y: 80 }, width, height,
      style: { width, height, opacity: 0.9 }, data: { kind: "director", title: "导演台 2", director: data() } }];
    const migrated = migrateDirectorCanvases(original), node = migrated.canvases[0].nodes[0];
    expect(node).toMatchObject({ width: 880, height: 620, position: { x: -150, y: 80 }, style: { width: 880, height: 620, opacity: 0.9 },
      data: { title: "导演台 2", director: { inlineLayoutVersion: 1, media: data().media, run: data().run } } });
    expect(original.canvases[0].nodes[0].width).toBe(width);
    expect(migrateDirectorCanvases(migrated)).toEqual(migrated);
    node.width = 420; node.height = 280; node.style = { ...node.style, width: 420, height: 280 };
    const resized = migrateDirectorCanvases(migrated).canvases[0].nodes[0];
    expect(resized).toMatchObject({ width: 420, height: 280, style: { width: 420, height: 280 } });
  });

  it("keeps already expanded dimensions and upgrades style-only legacy cards", () => {
    const original = project();
    original.canvases[0].nodes = [
      { id: "expanded", type: "director", position: { x: 1, y: 2 }, width: 1200, height: 900, data: { kind: "director", title: "大导演台", director: {} } },
      { id: "style-only", type: "director", position: { x: 3, y: 4 }, style: { width: 420, height: 280 }, data: { kind: "director", title: "旧导演台", director: {} } },
    ];
    const migrated = migrateDirectorCanvases(original);
    expect(migrated.canvases[0].nodes[0]).toMatchObject({ width: 1200, height: 900, position: { x: 1, y: 2 } });
    expect(migrated.canvases[0].nodes[1]).toMatchObject({ width: 880, height: 620, position: { x: 3, y: 4 }, style: { width: 880, height: 620 } });
    expect(migrateDirectorCanvases(migrated)).toEqual(migrated);
  });

  it("protects live director nodes through the shared busy-state checks and keeps completed receipts on undo", () => {
    const id = createDirectorNode();
    const state = useStore.getState();
    state.patchNode(id, { director: { ...data(), run: { ...data().run, status: "generating" } } });
    const busyProject = useStore.getState().project, node = busyProject.canvases[0].nodes[0];
    expect(taskForNode(busyProject, node).status).toBe("generating"); expect(projectBusy(busyProject)).toBe(true);
    state.undo(); expect(useStore.getState().project.canvases[0].nodes).toHaveLength(1);
    state.checkpoint();
    state.patchNode(id, { director: data() });
    state.undo();
    const restored = useStore.getState().project.canvases[0].nodes[0] as CanvasNode;
    expect(restored.data.director?.run).toEqual(data().run);
  });
});
