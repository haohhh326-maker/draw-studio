import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection, GenerationTask, MediaKind, Project, WorkflowDefinition } from "../src/types";

const storage = vi.hoisted(() => ({ records: new Map<string, unknown>(), read: vi.fn(), write: vi.fn() }));
vi.mock("../src/projects/storage", () => ({ readRecord: storage.read, writeRecord: storage.write, safeConnection: (connection: object) => connection, getBlob: vi.fn() }));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("test: cloud directory offline"); } }));

import { activeWorkflows, nodeComputeState, defaultRunningHubConnection } from "../src/compute/providers";
import { useStore } from "../src/stores/store";

const cn = "https://www.runninghub.cn", ai = "https://www.runninghub.ai";
const cloudConnection: Connection = { name: "原云端", baseUrl: "https://cloud.example", token: "cloud-only-token", authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 60 };
const rhConnection: Connection = { ...defaultRunningHubConnection, token: "rh-only-token" };
function workflow(id: string, kind: MediaKind = "image", site?: string): WorkflowDefinition {
  const mode = kind === "text" ? "text-tool" : kind === "audio" ? "text-to-audio" : kind === "video" ? "text-to-video" : "text-to-image";
  return { id, name: id, family: "测试模型", description: "", mode, requiredInputs: [], optionalInputs: [], promptRequired: false,
    parameters: [{ key: "seed", label: "种子", type: "number", default: site ? 7 : 3 }], mapping: [{ semantic: "prompt", nodeId: "1", field: "prompt" }, { semantic: "seed", nodeId: "1", field: "seed" }],
    output: { nodeId: "2", field: "images", kind }, template: { "1": { class_type: "Maker", inputs: { prompt: "平台示例", seed: 7 } }, "2": { class_type: "Publisher", inputs: { source: ["1", 0] } } },
    ...(site ? { runninghub: { workflowId: "42", baseUrl: site, kind: "app" } } : {}) };
}
const cloud = workflow("cloud-image"), rhCn = workflow("runninghub-cn-image", "image", cn), rhAi = workflow("runninghub-ai-image", "image", ai);
function project(): Project {
  const { token: _, ...endpoint } = cloudConnection;
  const task: GenerationTask = { taskId: "task", promptId: "remote", executorType: "comfyui", requestId: "request", clientId: "client", canvasId: "c", nodeId: "target", nodeTitle: "图像 1", status: "completed", createdAt: 1, updatedAt: 2,
    connection: endpoint, workflow: cloud, input: { prompt: "保留的用户提示词", negativePrompt: "负面词", params: { seed: 31 }, assets: [] }, outputs: ["asset"] };
  return { version: 2, id: "p", name: "算力隔离", activeCanvasId: "c", scenes: [{ id: "s", name: "场景" }], updatedAt: 1, history: [],
    assets: { asset: { id: "asset", name: "原有素材.png", kind: "image", mime: "image/png", size: 100, createdAt: 1, inLibrary: true } }, tasks: { task },
    canvases: [{ id: "c", name: "画布 1", sceneId: "s", viewport: { x: 0, y: 0, zoom: 1 }, edges: [{ id: "edge", source: "reference", target: "target", data: { role: "image", order: 1 } }], nodes: [
      { id: "reference", position: { x: 0, y: 0 }, data: { kind: "reference", title: "参考 1", assetId: "asset" } },
      { id: "target", position: { x: 200, y: 0 }, data: { kind: "image-generation", title: "图像 1", assetId: "asset", generation: { computeProvider: "comfyui", workflowId: cloud.id, prompt: "保留的用户提示词", negativePrompt: "负面词", params: { seed: 31, steps: 20 }, taskId: "task" } } },
    ] }] };
}
const generation = () => useStore.getState().project.canvases[0].nodes.find(node => node.id === "target")!.data.generation!;
const initialCatalog = useStore.getState().runningHubWorkflows;
const session = new Map<string, string>();

beforeEach(() => {
  storage.records.clear(); vi.clearAllMocks(); session.clear();
  storage.read.mockImplementation(async (key: string) => structuredClone(storage.records.get(key)));
  storage.write.mockImplementation(async (key: string, value: unknown) => { storage.records.set(key, structuredClone(value)); });
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value), removeItem: (key: string) => session.delete(key) });
  useStore.setState({ ready: false, projectOpen: false });
  useStore.setState({ project: project(), projects: {}, projectOpen: true, navigating: false, ready: false, workflows: [cloud], runningHubWorkflows: [],
    computeProvider: "comfyui", runningHubConnection: rhConnection, connection: cloudConnection, workflowLibrary: undefined, libraryState: "idle", libraryError: "",
    past: [], future: [], selectedId: "target", selectedEdgeId: null, toast: "", modal: null });
});
afterEach(() => { useStore.setState({ ready: false, projectOpen: false }); vi.unstubAllGlobals(); });

describe("provider actions in the real store", () => {
  it("creates remote workflow nodes from the remote catalog while retaining the local catalog", async () => {
    const remote = workflow("remote-linked-workflow", "image", cn); remote.runninghub!.kind = "workflow";
    await useStore.getState().saveRunningHubWorkflow(remote);
    await useStore.getState().saveRunningHubWorkflow(rhCn);
    useStore.getState().setComputeProvider("runninghub-workflow");
    const nodeId = useStore.getState().addNode("image-generation");
    const node = useStore.getState().project.canvases[0].nodes.find(node => node.id === nodeId)!;
    expect(node.data.generation).toMatchObject({ computeProvider: "runninghub-workflow", workflowId: remote.id, prompt: "" });
    expect(activeWorkflows(useStore.getState())).toEqual([remote]);
    expect(useStore.getState().workflows).toEqual([cloud]);
    expect(storage.records.get("runninghub-workflows")).toEqual([remote, rhCn]);
  });
  it("restores the remote provider and selected remote reference after hydration without changing task executors", async () => {
    const remote = workflow("remote-linked-workflow", "image", cn); remote.runninghub!.kind = "workflow";
    const saved = project();
    saved.canvases[0].nodes.find(node => node.id === "target")!.data.generation = { ...generation(), computeProvider: "runninghub-workflow", workflowId: remote.id, params: { seed: 500 }, providerSelections: {
      runninghub: { workflowId: rhCn.id, params: { seed: 88 } }, "runninghub-workflow": { workflowId: remote.id, params: { seed: 500 } },
    } };
    saved.tasks.acceptedRemote = { ...saved.tasks.task, taskId: "acceptedRemote", executorType: "runninghub", promptId: "accepted-remote-id", workflow: remote };
    storage.records.set("compute-preferences", { provider: "runninghub-workflow", runningHubConnection: rhConnection });
    storage.records.set("runninghub-workflows", [remote, rhCn]);
    storage.records.set("connection", cloudConnection);
    storage.records.set("project-library", { p: { project: saved, workflows: [cloud, remote, rhCn] } });
    session.set("clearframe-open-project", "p");
    await useStore.getState().hydrate();
    expect(useStore.getState().computeProvider).toBe("runninghub-workflow");
    expect(generation()).toMatchObject({ computeProvider: "runninghub-workflow", workflowId: remote.id, params: { seed: 500 }, providerSelections: { runninghub: { workflowId: rhCn.id } } });
    expect(activeWorkflows(useStore.getState())).toEqual([remote]);
    expect(useStore.getState().project.tasks.acceptedRemote).toMatchObject({ executorType: "runninghub", promptId: "accepted-remote-id", status: "completed" });
  });
  it("initializes RunningHub without a built-in or copied cloud directory", () => {
    expect(initialCatalog).toEqual([]);
    useStore.getState().setComputeProvider("runninghub");
    expect(activeWorkflows(useStore.getState())).toEqual([]);
    expect(useStore.getState().workflows).toEqual([cloud]);
  });
  it("switches selection and parameters while retaining prompts, assets, edges, results and tasks", () => {
    const before = useStore.getState().project;
    useStore.getState().setNodeComputeProvider("c", "target", "runninghub");
    const after = useStore.getState().project;
    expect(generation()).toMatchObject({ computeProvider: "runninghub", workflowId: "", params: {}, prompt: "保留的用户提示词", negativePrompt: "负面词", taskId: "task" });
    expect(after.assets).toBe(before.assets); expect(after.tasks).toBe(before.tasks); expect(after.history).toBe(before.history);
    expect(after.canvases[0].edges).toBe(before.canvases[0].edges);
    expect(after.canvases[0].nodes.find(node => node.id === "target")!.data.assetId).toBe("asset");
    expect(generation().providerSelections?.comfyui).toEqual({ workflowId: cloud.id, params: { seed: 31, steps: 20 } });
  });
  it("restores each provider's own workflow and seed after switching back", () => {
    useStore.setState({ runningHubWorkflows: [rhCn] });
    useStore.getState().setNodeComputeProvider("c", "target", "runninghub");
    useStore.getState().patchNode("target", { generation: { ...generation(), workflowId: rhCn.id, params: { seed: 88, steps: 4 }, prompt: "修改后的用户提示词" } });
    useStore.getState().setNodeComputeProvider("c", "target", "comfyui");
    expect(generation()).toMatchObject({ workflowId: cloud.id, params: { seed: 31, steps: 20 }, prompt: "修改后的用户提示词" });
    useStore.getState().setNodeComputeProvider("c", "target", "runninghub");
    expect(generation()).toMatchObject({ workflowId: rhCn.id, params: { seed: 88, steps: 4 }, prompt: "修改后的用户提示词" });
  });
  it.each([
    ["image-generation", "image"], ["video", "video"], ["audio", "audio"], ["text", "text"],
  ] as const)("creates a %s node only from the active RunningHub site", (kind, outputKind) => {
    const matching = workflow("runninghub-current-" + outputKind, outputKind, cn);
    useStore.setState({ workflows: [workflow("cloud-" + outputKind, outputKind)], runningHubWorkflows: [workflow("runninghub-other-" + outputKind, outputKind, ai), matching] });
    useStore.getState().setComputeProvider("runninghub");
    const id = useStore.getState().addNode(kind);
    const node = useStore.getState().project.canvases[0].nodes.find(node => node.id === id)!;
    expect(node.data.generation).toMatchObject({ computeProvider: "runninghub", workflowId: matching.id, params: { seed: 7 }, prompt: "" });
  });
  it.each(["image-generation", "video", "audio", "text"] as const)("never fills a new %s node from cloud workflows when RunningHub is empty", kind => {
    useStore.setState({ workflows: [cloud, workflow("cloud-video", "video"), workflow("cloud-audio", "audio"), workflow("cloud-text", "text")] });
    useStore.getState().setComputeProvider("runninghub");
    const id = useStore.getState().addNode(kind);
    expect(useStore.getState().project.canvases[0].nodes.find(node => node.id === id)!.data.generation).toMatchObject({ computeProvider: "runninghub", workflowId: "", params: {}, prompt: "" });
  });
  it("does not switch while a project transition is in progress", () => {
    useStore.setState({ navigating: true }); const before = useStore.getState();
    useStore.getState().setComputeProvider("runninghub");
    expect(useStore.getState()).toBe(before);
  });
  it("keeps a card's site and remembered selection when changing the default RunningHub site", () => {
    useStore.setState({ runningHubWorkflows: [rhCn, rhAi] });
    useStore.getState().setNodeComputeProvider("c", "target", "runninghub");
    useStore.getState().patchNode("target", { generation: { ...generation(), workflowId: rhCn.id, params: { seed: 88 } } });
    const before = useStore.getState().project;
    useStore.getState().setRunningHubConnection({ ...rhConnection, baseUrl: ai });
    expect(useStore.getState().project).toBe(before);
    expect(generation()).toMatchObject({ computeProvider: "runninghub", workflowId: rhCn.id, params: { seed: 88 } });
    expect(nodeComputeState(useStore.getState(), "c", "target").runningHubConnection.baseUrl).toBe(cn);
    expect(activeWorkflows(nodeComputeState(useStore.getState(), "c", "target"))).toEqual([rhCn]);
  });
  it("keeps a current site's selection when only its API key changes", () => {
    useStore.setState({ runningHubWorkflows: [rhCn] });
    useStore.getState().setComputeProvider("runninghub");
    useStore.getState().patchNode("target", { generation: { ...generation(), workflowId: rhCn.id, params: { seed: 88 } } });
    useStore.getState().setRunningHubConnection({ ...rhConnection, token: "new-rh-key" });
    expect(generation()).toMatchObject({ workflowId: rhCn.id, params: { seed: 88 } });
  });
});

describe("dedicated RunningHub storage", () => {
  it("preserves legacy API records while offering only AI apps for newly created nodes", async () => {
    const legacy = workflow("legacy-api-video", "video", cn); legacy.runninghub!.kind = "workflow";
    const app = workflow("video-ai-app", "video", cn);
    await useStore.getState().saveRunningHubWorkflow(legacy);
    await useStore.getState().saveRunningHubWorkflow(app);
    useStore.getState().setComputeProvider("runninghub");
    const nodeId = useStore.getState().addNode("video");
    const added = useStore.getState().project.canvases[0].nodes.find(node => node.id === nodeId)!;
    expect(added.data.generation?.workflowId).toBe(app.id);
    expect(useStore.getState().runningHubWorkflows).toEqual([legacy, app]);
    expect(storage.records.get("runninghub-workflows")).toEqual([legacy, app]);
  });

  function rebindingDefinitions(selected = true) {
    const previous = structuredClone(rhCn);
    if (selected) previous.runninghub!.bindingMode = "selected";
    previous.template!["1"].inputs.steps = 20;
    previous.parameters.push({ key: "steps", label: "步数", type: "number", default: 20 });
    previous.mapping.push({ semantic: "steps", nodeId: "1", field: "steps" });
    const next = structuredClone(previous);
    next.parameters[0].key = "steps"; next.parameters[1].key = "seed";
    next.mapping.find(mapping => mapping.field === "seed")!.semantic = "steps";
    next.mapping.find(mapping => mapping.field === "steps")!.semantic = "seed";
    return { previous, next };
  }
  function projectUsingRunningHub(previous: WorkflowDefinition) {
    const current = project(), target = current.canvases[0].nodes.find(node => node.id === "target")!;
    target.data.generation = { ...target.data.generation!, computeProvider: "runninghub", workflowId: previous.id,
      params: { seed: 88, steps: 12, removed: true }, runningHubInstanceType: "plus", providerSelections: {
        runninghub: { workflowId: previous.id, params: { seed: 55, steps: 16, orphan: 9 } },
        comfyui: { workflowId: cloud.id, params: { seed: 31, steps: 20 } },
      } };
    current.tasks.acceptedRh = { ...current.tasks.task, taskId: "acceptedRh", executorType: "runninghub", workflow: previous,
      input: { ...current.tasks.task.input, params: { seed: 66, steps: 18 } } };
    current.history = [{ id: "rh-history", canvasId: "c", nodeId: "target", nodeTitle: "图像 1", workflowId: previous.id,
      prompt: "原任务提示词", negativePrompt: "", params: { seed: 66, steps: 18 }, inputs: [], outputs: ["asset"], promptId: "remote-rh", createdAt: 1 }];
    return current;
  }

  it("reconciles current and remembered selected values by target only after the catalog is durable", async () => {
    const { previous, next } = rebindingDefinitions();
    await useStore.getState().saveRunningHubWorkflow(previous);
    const active = projectUsingRunningHub(previous), before = structuredClone(active), catalog = useStore.getState().runningHubWorkflows;
    useStore.setState({ project: active, computeProvider: "runninghub", saveState: "已保存" });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    storage.write.mockImplementationOnce(async (key: string, value: unknown) => { await gate; storage.records.set(key, structuredClone(value)); });
    const saving = useStore.getState().saveRunningHubWorkflow(next);
    await vi.waitFor(() => expect(storage.write).toHaveBeenCalledTimes(2));
    expect(useStore.getState().project).toBe(active);
    expect(useStore.getState().runningHubWorkflows).toBe(catalog);
    release(); await saving;
    const result = useStore.getState().project;
    expect(generation().params).toEqual({ steps: 88, seed: 12 });
    expect(generation().providerSelections!.runninghub!.params).toEqual({ steps: 55, seed: 16 });
    expect(generation()).toMatchObject({ prompt: "保留的用户提示词", negativePrompt: "负面词", taskId: "task", runningHubInstanceType: "plus" });
    expect(generation().providerSelections!.comfyui).toBe(active.canvases[0].nodes[1].data.generation!.providerSelections!.comfyui);
    expect(result.tasks).toBe(active.tasks); expect(result.history).toBe(active.history); expect(result.assets).toBe(active.assets);
    expect(result.tasks.acceptedRh.workflow).toBe(previous);
    expect(result.tasks.acceptedRh.input.params).toEqual({ seed: 66, steps: 18 });
    expect(result.history[0].params).toEqual({ seed: 66, steps: 18 });
    expect(active).toEqual(before);
    expect(useStore.getState().saveState).toBe("待保存");
  });

  it("leaves project and selected catalog untouched if saving the new binding version fails", async () => {
    const { previous, next } = rebindingDefinitions();
    await useStore.getState().saveRunningHubWorkflow(previous);
    const active = projectUsingRunningHub(previous), catalog = useStore.getState().runningHubWorkflows;
    useStore.setState({ project: active, computeProvider: "runninghub", saveState: "已保存" });
    storage.write.mockRejectedValueOnce(new Error("binding catalog disk full"));
    await expect(useStore.getState().saveRunningHubWorkflow(next)).rejects.toThrow("binding catalog disk full");
    expect(useStore.getState().project).toBe(active);
    expect(useStore.getState().runningHubWorkflows).toBe(catalog);
    expect(storage.records.get("runninghub-workflows")).toEqual(catalog);
    expect(generation().params).toEqual({ seed: 88, steps: 12, removed: true });
    expect(useStore.getState().saveState).toBe("已保存");
  });

  it("does not reinterpret project parameters when saving an updated legacy workflow", async () => {
    const { previous, next } = rebindingDefinitions(false);
    await useStore.getState().saveRunningHubWorkflow(previous);
    const active = projectUsingRunningHub(previous);
    useStore.setState({ project: active, computeProvider: "runninghub", saveState: "已保存" });
    await useStore.getState().saveRunningHubWorkflow(next);
    expect(useStore.getState().project).toBe(active);
    expect(generation().params).toEqual({ seed: 88, steps: 12, removed: true });
    expect(generation().providerSelections!.runninghub!.params).toEqual({ seed: 55, steps: 16, orphan: 9 });
    expect(useStore.getState().runningHubWorkflows[0].mapping).toEqual(next.mapping);
    expect(useStore.getState().saveState).toBe("已保存");
  });

  it("writes, updates and removes only the dedicated workflow record", async () => {
    const beforeProject = useStore.getState().project, beforeCloud = useStore.getState().workflows;
    await useStore.getState().saveRunningHubWorkflow(rhCn);
    await useStore.getState().saveRunningHubWorkflow(rhAi);
    await useStore.getState().saveRunningHubWorkflow({ ...rhCn, name: "用户改名" });
    expect(useStore.getState().runningHubWorkflows).toHaveLength(2);
    expect(useStore.getState().runningHubWorkflows.find(workflow => workflow.id === rhCn.id)?.name).toBe("用户改名");
    await useStore.getState().removeRunningHubWorkflow(rhCn.id);
    expect(storage.records.get("runninghub-workflows")).toEqual([rhAi]);
    expect(new Set(storage.write.mock.calls.map(([key]) => key))).toEqual(new Set(["runninghub-workflows"]));
    expect(useStore.getState().workflows).toBe(beforeCloud); expect(useStore.getState().project).toBe(beforeProject);
  });
  it("does not mutate the caller's workflow and rejects definitions missing the platform contract", async () => {
    const draft = structuredClone(rhCn);
    await useStore.getState().saveRunningHubWorkflow(draft);
    draft.name = "后来编辑"; draft.template!["1"].inputs.seed = 999;
    expect(useStore.getState().runningHubWorkflows[0]).toMatchObject({ name: rhCn.name, template: { "1": { inputs: { seed: 7 } } } });
    await expect(useStore.getState().saveRunningHubWorkflow(cloud)).rejects.toThrow("平台 ID");
    expect(useStore.getState().runningHubWorkflows).toHaveLength(1);
  });
  it("keeps the last durable catalog on write failure and allows a later retry", async () => {
    await useStore.getState().saveRunningHubWorkflow(rhCn);
    storage.write.mockRejectedValueOnce(new Error("local disk full"));
    await expect(useStore.getState().removeRunningHubWorkflow(rhCn.id)).rejects.toThrow("local disk full");
    expect(useStore.getState().runningHubWorkflows).toEqual([rhCn]);
    await useStore.getState().removeRunningHubWorkflow(rhCn.id);
    expect(useStore.getState().runningHubWorkflows).toEqual([]);
  });
  it("persists the selected provider and RunningHub configuration independently of the cloud credentials", async () => {
    const savedCn = { ...rhConnection, token: "saved-cn-only-token" };
    useStore.getState().setRunningHubSiteConnection("cn", savedCn);
    useStore.setState({ ready: true, projectOpen: false });
    useStore.getState().setComputeProvider("runninghub");
    useStore.getState().setRunningHubConnection({ ...rhConnection, baseUrl: ai });
    await vi.waitFor(() => expect(storage.records.get("compute-preferences")).toMatchObject({ provider: "runninghub", runningHubConnection: { ...rhConnection, baseUrl: ai },
      runningHubConnections: { cn: savedCn, ai: { ...rhConnection, baseUrl: ai } },
    }));
    expect(storage.records.has("connection")).toBe(false);
    expect(useStore.getState().connection).toBe(cloudConnection);
  });
  it("hydrates provider, both site catalogs and an open project's existing RunningHub selection", async () => {
    const saved = project();
    saved.canvases[0].nodes.find(node => node.id === "target")!.data.generation = { ...generation(), computeProvider: "runninghub", workflowId: rhCn.id, params: { seed: 88 }, providerSelections: { comfyui: { workflowId: cloud.id, params: { seed: 31 } } } };
    storage.records.set("compute-preferences", { provider: "runninghub", runningHubConnection: rhConnection });
    storage.records.set("connection", cloudConnection);
    storage.records.set("workflows", [cloud, rhCn]);
    storage.records.set("runninghub-workflows", [rhCn, rhAi, { id: "invalid-row" }]);
    storage.records.set("project-library", { p: { project: saved, workflows: [cloud, rhCn] } });
    session.set("clearframe-open-project", "p");
    await useStore.getState().hydrate();
    const current = useStore.getState();
    expect(current.ready).toBe(true); expect(current.projectOpen).toBe(true); expect(current.computeProvider).toBe("runninghub");
    expect(current.runningHubConnection).toEqual(rhConnection); expect(current.connection).toEqual(cloudConnection);
    expect(current.runningHubWorkflows).toEqual([rhCn, rhAi]);
    expect(current.workflows.map(workflow => workflow.id)).toEqual([cloud.id]);
    expect(activeWorkflows(current)).toEqual([rhCn]);
    expect(generation()).toMatchObject({ workflowId: rhCn.id, params: { seed: 88 }, prompt: "保留的用户提示词", taskId: "task" });
    expect(current.project.assets).toEqual(saved.assets); expect(current.project.tasks.task.executorType).toBe("comfyui");
  });
  it("hydrates an empty RunningHub catalog without taking workflows from the saved cloud record", async () => {
    storage.records.set("compute-preferences", { provider: "runninghub", runningHubConnection: rhConnection });
    storage.records.set("workflows", [cloud]);
    await useStore.getState().hydrate();
    expect(useStore.getState().computeProvider).toBe("runninghub");
    expect(activeWorkflows(useStore.getState())).toEqual([]);
    expect(useStore.getState().workflows.map(workflow => workflow.id)).toEqual([cloud.id]);
  });
  it("preserves a reopened CN card when the default site is AI", async () => {
    const saved = project();
    saved.canvases[0].nodes.find(node => node.id === "target")!.data.generation = { ...generation(), computeProvider: "runninghub", workflowId: rhCn.id, params: { seed: 88 }, providerSelections: {
      comfyui: { workflowId: cloud.id, params: { seed: 31 } }, runninghub: { workflowId: rhCn.id, params: { seed: 88 } },
    } };
    storage.records.set("compute-preferences", { provider: "runninghub", runningHubConnection: { ...rhConnection, baseUrl: ai } });
    storage.records.set("connection", cloudConnection);
    storage.records.set("runninghub-workflows", [rhCn, rhAi]);
    storage.records.set("project-library", { p: { project: saved, workflows: [cloud, rhCn] } });
    session.set("clearframe-open-project", "p");
    await useStore.getState().hydrate();
    const current = useStore.getState();
    expect(current.projectOpen).toBe(true); expect(activeWorkflows(current)).toEqual([rhAi]);
    expect(generation()).toMatchObject({ computeProvider: "runninghub", workflowId: rhCn.id, params: { seed: 88 }, prompt: "保留的用户提示词", negativePrompt: "负面词", taskId: "task" });
    expect(generation().providerSelections?.runninghub).toEqual({ workflowId: rhCn.id, params: { seed: 88 } });
    expect(generation().providerSelections?.comfyui).toEqual({ workflowId: cloud.id, params: { seed: 31 } });
    expect(current.project.assets).toEqual(saved.assets); expect(current.project.tasks).toEqual(saved.tasks);
    expect(current.project.canvases[0].edges).toEqual(saved.canvases[0].edges);
    expect(current.project.canvases[0].nodes.find(node => node.id === "target")!.data.assetId).toBe("asset");
    expect(current.runningHubWorkflows).toEqual([rhCn, rhAi]);
  });
  it("preserves an imported CN card when the default site is AI", async () => {
    const incoming = project();
    incoming.canvases[0].nodes.find(node => node.id === "target")!.data.generation = { ...generation(), computeProvider: "runninghub", workflowId: rhCn.id, params: { seed: 88 }, providerSelections: {
      comfyui: { workflowId: cloud.id, params: { seed: 31 } }, runninghub: { workflowId: rhCn.id, params: { seed: 88 } },
    } };
    useStore.setState({ projectOpen: false, computeProvider: "runninghub", runningHubConnection: { ...rhConnection, baseUrl: ai }, runningHubWorkflows: [rhCn, rhAi] });
    await useStore.getState().enterProject(incoming, [cloud, rhCn]);
    const current = useStore.getState();
    expect(current.projectOpen).toBe(true); expect(activeWorkflows(current)).toEqual([rhAi]);
    expect(generation()).toMatchObject({ computeProvider: "runninghub", workflowId: rhCn.id, params: { seed: 88 }, prompt: "保留的用户提示词", negativePrompt: "负面词", taskId: "task" });
    expect(generation().providerSelections?.runninghub).toEqual({ workflowId: rhCn.id, params: { seed: 88 } });
    expect(generation().providerSelections?.comfyui).toEqual({ workflowId: cloud.id, params: { seed: 31 } });
    expect(current.project.assets).toEqual(incoming.assets); expect(current.project.tasks).toEqual(incoming.tasks);
    expect(current.project.canvases[0].edges).toEqual(incoming.canvases[0].edges);
    expect(current.runningHubWorkflows.map(workflow => workflow.id).sort()).toEqual([rhCn.id, rhAi.id].sort());
    expect(session.get("clearframe-open-project")).toBe(incoming.id);
  });
});

describe("independent image, video and audio cards", () => {
  it("the toolbar changes only defaults for new cards, preserving existing selections and undo", () => {
    useStore.getState().checkpoint();
    const before = useStore.getState();
    useStore.getState().setComputeProvider("muse");
    expect(useStore.getState().project).toBe(before.project);
    expect(useStore.getState().past).toBe(before.past);
    expect(generation().computeProvider).toBe("comfyui");
    const id = useStore.getState().addNode("video");
    expect(useStore.getState().project.canvases[0].nodes.find(node => node.id === id)?.data.generation?.computeProvider).toBe("muse");
  });
  it.each(["image-generation", "video", "audio"] as const)("changes and persists only the selected %s card across canvases", async kind => {
    const id = useStore.getState().addNode(kind);
    useStore.getState().editProject(project => ({ ...project, canvases: [...project.canvases, { ...structuredClone(project.canvases[0]), id: "second" }] }));
    const before = useStore.getState().project;
    useStore.getState().setNodeComputeProvider("c", id, "runninghub-workflow");
    const next = useStore.getState().project;
    expect(next.canvases[0].nodes.find(node => node.id === id)?.data.generation?.computeProvider).toBe("runninghub-workflow");
    expect(next.canvases[0].nodes.find(node => node.id === "target")).toBe(before.canvases[0].nodes.find(node => node.id === "target"));
    expect(next.canvases[1]).toBe(before.canvases[1]);
    expect(next.tasks).toBe(before.tasks);
    expect(next.assets).toBe(before.assets);
    useStore.getState().setProject(structuredClone(next));
    expect(useStore.getState().project.canvases[0].nodes.find(node => node.id === id)?.data.generation?.computeProvider).toBe("runninghub-workflow");
    expect(useStore.getState().project.canvases[1].nodes.find(node => node.id === id)?.data.generation?.computeProvider).toBe("comfyui");
  });
});
