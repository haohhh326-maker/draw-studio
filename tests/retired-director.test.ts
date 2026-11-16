import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kind, Project, WorkflowDefinition } from "../src/types";

const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(records.get(key)),
  writeRecord: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
  safeConnection: (value: object) => value,
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline fixture"); } }));

import { migrateProject } from "../src/projects/migrate";
import { retireDirectorProject } from "../src/projects/retired-tools";
import { createNode, projectBusy, taskForNode, useStore, type ProjectLibrary } from "../src/stores/store";
import { defaultConnection } from "../src/workflow/catalog";
import { defaultRunningHubConnection } from "../src/compute/providers";

const workflow: WorkflowDefinition = {
  id: "ordinary-workflow", name: "普通工作流", family: "fixture", description: "", mode: "text-to-image",
  requiredInputs: [], optionalInputs: [], parameters: [], mapping: [],
  output: { kind: "image", nodeId: "1", field: "images" },
  template: { "1": { class_type: "OrdinaryGenerator", inputs: { seed: 42 } } },
};
const receipt = { status: "queued", taskId: "remote-director-receipt", outputIds: ["generated-video"], inputAssetIds: ["input-image"] };
function legacyProject(): Project {
  const { token: _, ...connection } = defaultConnection;
  return {
    version: 2, id: "legacy", name: "保留项目", scenes: [{ id: "s", name: "场景" }], activeCanvasId: "legacy-canvas", updatedAt: 1,
    director: { run: receipt, workflowId: "legacy-top-level" },
    assets: {
      "input-image": { id: "input-image", name: "input.png", kind: "image", mime: "image/png", size: 2, createdAt: 1 },
      "generated-video": { id: "generated-video", name: "output.mp4", kind: "video", mime: "video/mp4", size: 3, createdAt: 2 },
    },
    tasks: { ordinary: { taskId: "ordinary", promptId: "ordinary-remote", executorType: "comfyui", status: "completed",
      requestId: "request", clientId: "client", canvasId: "legacy-canvas", nodeId: "generation", nodeTitle: "普通生成", createdAt: 1, updatedAt: 2,
      connection, workflow, input: { prompt: "保留提示词", negativePrompt: "", params: { seed: 42 }, assets: [] }, outputs: ["generated-video"] } },
    history: [{ id: "history", canvasId: "legacy-canvas", nodeId: "director-node", nodeTitle: "已生成结果", workflowId: "legacy-director-workflow",
      prompt: "原始生成提示词", negativePrompt: "", params: {}, inputs: [{ assetId: "input-image", role: "image" }], outputs: ["generated-video"], promptId: "remote-director-receipt", createdAt: 2 }],
    canvases: [{ id: "legacy-canvas", name: "原导演画布", sceneId: "s", kind: "director", director: { run: receipt, workflowId: "canvas-workflow" },
      viewport: { x: 12, y: 24, zoom: 0.8 }, nodes: [
        { id: "reference", type: "media", position: { x: 10, y: 20 }, data: { kind: "reference", title: "参考 1", assetId: "input-image" } },
        { id: "director-node", type: "director", position: { x: 70, y: 80 }, width: 880, height: 620,
          data: { kind: "director", title: "导演台 1", assetId: "generated-video", director: { run: receipt, prompt: "原始专用数据" } } },
        { id: "generation", type: "media", position: { x: 100, y: 200 }, data: { kind: "image-generation", title: "普通生成", assetId: "generated-video",
          generation: { computeProvider: "comfyui", workflowId: workflow.id, prompt: "保留提示词", negativePrompt: "", params: { seed: 42 }, taskId: "ordinary" } } },
      ], edges: [
        { id: "ordinary-edge", source: "reference", target: "generation", data: { role: "image", order: 1 } },
        { id: "director-input", source: "reference", target: "director-node", data: { role: "image", order: 2 } },
        { id: "director-output", source: "director-node", target: "generation", data: { role: "auto", order: 3 } },
      ] },
      { id: "other-canvas", name: "其它画布", sceneId: "s", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
    ],
  } as unknown as Project;
}
function expectRetired(project: Project) {
  const canvas = project.canvases[0];
  expect(project.activeCanvasId).toBe("legacy-canvas");
  expect(canvas.id).toBe("legacy-canvas");
  expect(canvas.nodes.map(node => node.id)).toEqual(["reference", "generation"]);
  expect(canvas.edges.map(edge => edge.id)).toEqual(["ordinary-edge"]);
  expect(canvas).not.toHaveProperty("director");
  expect(canvas).not.toHaveProperty("kind");
  expect(canvas.retiredTools?.director).toMatchObject({ version: 1, executable: false });
  expect(project).not.toHaveProperty("director");
}

beforeEach(() => {
  records.clear();
  vi.useFakeTimers();
  const session = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => session.set(key, value), removeItem: (key: string) => session.delete(key) });
  useStore.setState({ ready: false, projectOpen: false });
  useStore.setState({ project: retireDirectorProject(legacyProject()), projects: {}, workflows: [workflow], runningHubWorkflows: [],
    computeProvider: "comfyui", runningHubConnection: defaultRunningHubConnection, connection: defaultConnection,
    ready: false, projectOpen: false, navigating: false, past: [], future: [], workflowLibrary: undefined,
    selectedId: null, selectedEdgeId: null, toast: "" });
});
afterEach(() => {
  useStore.setState({ ready: false, projectOpen: false });
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("retired Director recovery data", () => {
  it("visits clean node data once and skips all edge endpoints without allocating replacement graph arrays", () => {
    const count = 5000;
    let nodeReads = 0, edgeReads = 0;
    const project = legacyProject();
    delete (project as Project & { director?: unknown }).director;
    const nodes = Array.from({ length: count }, (_, index) => {
      const data = { kind: "reference" as const, title: "参考 " + index };
      return { id: "ordinary-" + index, position: { x: index, y: index }, get data() { nodeReads++; return data; } };
    });
    const edges = Array.from({ length: count }, (_, index) => ({ id: "edge-" + index,
      get source() { edgeReads++; return "ordinary-" + index; },
      get target() { edgeReads++; return "ordinary-" + (index + 1); },
    }));
    project.canvases = [{ id: "large", name: "大画布", sceneId: "s", viewport: { x: 0, y: 0, zoom: 1 }, nodes, edges }];
    const canvases = project.canvases;
    expect(retireDirectorProject(project)).toBe(project);
    expect(nodeReads).toBe(count);
    expect(edgeReads).toBe(0);
    expect(project.canvases).toBe(canvases);
    expect(project.canvases[0].nodes).toBe(nodes);
    expect(project.canvases[0].edges).toBe(edges);
  });

  it("rechecks in-place changes to an object previously seen as clean", () => {
    const project = legacyProject();
    delete (project as Project & { director?: unknown }).director;
    project.canvases = [{ id: "ordinary", name: "画布", sceneId: "s", viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [project.canvases[0].nodes[0]], edges: [] }];
    expect(retireDirectorProject(project)).toBe(project);
    project.canvases[0].nodes[0].data.director = { receipt: "late-data" };
    project.canvases[0].nodes.push(legacyProject().canvases[0].nodes[1]);
    project.canvases[0].edges.push({ id: "late-edge", source: "reference", target: "director-node" });
    const retired = retireDirectorProject(project);
    expect(retired.canvases[0].nodes).toHaveLength(1);
    expect(retired.canvases[0].nodes[0].data).not.toHaveProperty("director");
    expect(retired.canvases[0].edges).toEqual([]);
    expect(retired.canvases[0].retiredTools?.director?.snapshots[0].nodeFields).toEqual([
      { nodeId: "reference", fields: { director: { receipt: "late-data" } } },
    ]);
  });
  it.each([1, 2])("retires version %i canvases and nodes without altering ordinary media, tasks, history or raw receipts", version => {
    const raw = { ...legacyProject(), version };
    const original = structuredClone(raw);
    const migrated = migrateProject(raw, [workflow]);
    expectRetired(migrated);
    expect(migrated.assets).toEqual(original.assets);
    expect(migrated.tasks).toEqual(original.tasks);
    expect(migrated.history).toEqual(original.history);
    expect(migrated.canvases[0].viewport).toEqual(original.canvases[0].viewport);
    expect(migrated.canvases[0].nodes[1]).toEqual(original.canvases[0].nodes[2]);
    expect(migrated.canvases[1]).toEqual(original.canvases[1]);
    expect(migrated.canvases[0].retiredTools?.director?.snapshots).toEqual([{
      canvasFields: { kind: "director", director: { run: receipt, workflowId: "canvas-workflow" } },
      nodes: [original.canvases[0].nodes[1]], edges: original.canvases[0].edges.slice(1),
    }]);
    expect(migrated.retiredTools?.director?.snapshots).toEqual([{ projectFields: { director: { run: receipt, workflowId: "legacy-top-level" } } }]);
    expect(raw).toEqual(original);
    expect(migrateProject(JSON.parse(JSON.stringify(migrated)), [workflow])).toEqual(migrated);
  });

  it("also retires old renderer types and strips dedicated data from retained ordinary nodes", () => {
    const raw = legacyProject();
    raw.canvases[0].nodes[1].data.kind = "reference";
    raw.canvases[0].nodes[0].data.director = { run: receipt, retained: "exact source" };
    raw.canvases[0].retiredTools = { unrelated: { keep: true } };
    const retired = retireDirectorProject(raw);
    expectRetired(retired);
    expect(retired.canvases[0].nodes[0].data).not.toHaveProperty("director");
    expect(retired.canvases[0].retiredTools?.unrelated).toEqual({ keep: true });
    expect(retired.canvases[0].retiredTools?.director?.snapshots[0].nodeFields).toEqual([
      { nodeId: "reference", fields: { director: { run: receipt, retained: "exact source" } } },
    ]);
    expect(retireDirectorProject(retired)).toBe(retired);
  });

  it("ignores archived run status while ordinary tasks retain their busy state", () => {
    const retired = retireDirectorProject(legacyProject());
    expect(projectBusy(retired)).toBe(false);
    expect(taskForNode(retired, retired.canvases[0].nodes[1])).toBe(retired.tasks.ordinary);
    expect(projectBusy({ ...retired, tasks: { ordinary: { ...retired.tasks.ordinary, status: "queued" } } })).toBe(true);
    expect(() => createNode("director" as Kind, 1)).toThrow("停用");
  });
});

describe("Director retirement in project store entry points", () => {
  it("cleans direct project replacement and later edits without losing prior recovery snapshots", () => {
    useStore.getState().setProject(legacyProject());
    const first = useStore.getState().project;
    expectRetired(first);
    const raw = legacyProject();
    useStore.getState().editProject(project => ({ ...project, canvases: project.canvases.map((canvas, index) => index ? canvas : {
      ...canvas, nodes: raw.canvases[0].nodes, edges: raw.canvases[0].edges,
    }) }));
    const updated = useStore.getState().project;
    expectRetired(updated);
    expect(updated.assets).toBe(first.assets);
    expect(updated.tasks).toBe(first.tasks);
    expect(updated.history).toBe(first.history);
    expect(updated.canvases[0].retiredTools?.director?.snapshots).toHaveLength(2);
  });

  it.each(["undo", "redo"] as const)("filters legacy %s snapshots and their edges, retaining exact raw data once", action => {
    const raw = legacyProject();
    const snapshot = { canvasId: raw.activeCanvasId, nodes: raw.canvases[0].nodes, edges: raw.canvases[0].edges };
    useStore.setState({ [action === "undo" ? "past" : "future"]: [snapshot] });
    useStore.getState()[action]();
    const project = useStore.getState().project;
    expectRetired(project);
    expect(project.canvases[0].retiredTools?.director?.snapshots.at(-1)).toEqual({
      nodes: [raw.canvases[0].nodes[1]], edges: raw.canvases[0].edges.slice(1),
    });
    useStore.setState({ [action === "undo" ? "past" : "future"]: [snapshot] });
    useStore.getState()[action]();
    expectRetired(useStore.getState().project);
    expect(useStore.getState().project.canvases[0].retiredTools?.director?.snapshots).toHaveLength(2);
    expect(useStore.getState().project.assets).toEqual(raw.assets);
    expect(useStore.getState().project.history).toEqual(raw.history);
  });

  it("imports and saves recovery records while preserving the ordinary workflow catalog", async () => {
    await useStore.getState().enterProject(legacyProject(), [workflow]);
    expectRetired(useStore.getState().project);
    expect(useStore.getState().workflows.find(item => item.id === workflow.id)).toEqual(workflow);
    const saved = records.get("project-library") as ProjectLibrary;
    expectRetired(saved.legacy.project);
    expect(saved.legacy.project.canvases[0].retiredTools).toEqual(useStore.getState().project.canvases[0].retiredTools);
    expect(saved.legacy.workflows.find(item => item.id === workflow.id)).toEqual(workflow);
  });

  it.each(["project", "project-library"])("retires persisted %s state on hydration", async source => {
    const raw = legacyProject();
    records.set("workflows", [workflow]);
    if (source === "project") records.set(source, raw);
    else records.set(source, { legacy: { project: raw, workflows: [workflow] },
      inactive: { project: { ...structuredClone(raw), id: "inactive" }, workflows: [workflow], deletedAt: 10 } });
    sessionStorage.setItem("clearframe-open-project", raw.id);
    await useStore.getState().hydrate();
    expectRetired(useStore.getState().project);
    expectRetired(useStore.getState().projects.legacy.project);
    if (source === "project-library") {
      expectRetired(useStore.getState().projects.inactive.project);
      expect(useStore.getState().projects.inactive.deletedAt).toBe(10);
    }
    expect(useStore.getState().project.assets).toEqual(raw.assets);
    expect(useStore.getState().project.history).toEqual(raw.history);
  });
});
