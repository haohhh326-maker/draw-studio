import { describe, expect, it } from "vitest";
import type { CanvasNode, Connection, Project, WorkflowDefinition } from "../src/types";
import { activeConnection, activeWorkflows, allWorkflows, defaultRunningHubConnection, executionWorkflows, projectForNodeComputeProvider, nodeComputeState, restoreNodeComputeProviders } from "../src/compute/providers";
import { museConnection, museWorkflows } from "../src/muse/catalog";

const cn = "https://www.runninghub.cn", ai = "https://www.runninghub.ai";
function workflow(id: string, baseUrl?: string): WorkflowDefinition {
  return { id, name: id, family: "测试模型", description: "", mode: "text-to-image", requiredInputs: [], optionalInputs: [],
    parameters: [{ key: "seed", label: "种子", type: "number", default: 7 }], mapping: [{ semantic: "prompt", nodeId: "1", field: "prompt" }, { semantic: "seed", nodeId: "1", field: "seed" }],
    output: { nodeId: "2", field: "images", kind: "image" }, template: { "1": { class_type: "Maker", inputs: { prompt: "sample", seed: 7 } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "result" } } },
    ...(baseUrl ? { runninghub: { workflowId: "42", baseUrl, kind: "app" } } : {}) };
}
const cloud = workflow("cloud-workflow"), rhCn = workflow("runninghub-cn-workflow", cn), rhAi = workflow("runninghub-ai-workflow", ai);
const cloudConnection: Connection = { name: "Cloud", baseUrl: "https://cloud.example", token: "cloud-key", authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 60 };
const state = () => ({ computeProvider: "comfyui" as "comfyui" | "runninghub", connection: cloudConnection,
  runningHubConnection: { ...defaultRunningHubConnection, token: "rh-key" }, workflows: [cloud], runningHubWorkflows: [rhCn, rhAi] });
function project(): Project {
  const generated: CanvasNode = { id: "generated", position: { x: 0, y: 0 }, data: { title: "图像 1", kind: "image-generation", assetId: "result", generationFeedback: { status: "failed", error: "old feedback" },
    generation: { computeProvider: "comfyui", workflowId: cloud.id, prompt: "用户自己的提示词", negativePrompt: "保留负面词", params: { seed: 31, steps: 20 }, taskId: "live-task" } } };
  return { version: 2, id: "project", name: "Provider fixture", scenes: [{ id: "s", name: "场景" }], activeCanvasId: "c", updatedAt: 1,
    assets: { result: { id: "result", name: "结果.png", kind: "image", mime: "image/png", size: 10, createdAt: 1 } },
    tasks: { "live-task": { taskId: "live-task", executorType: "comfyui", status: "completed" } as Project["tasks"][string] }, history: [],
    canvases: [{ id: "c", name: "画布 1", sceneId: "s", viewport: { x: 11, y: 12, zoom: 1.2 }, nodes: [generated, { id: "reference", position: { x: 10, y: 20 }, data: { kind: "reference", title: "参考 1", assetId: "result" } }], edges: [{ id: "edge", source: "reference", target: "generated", data: { role: "referenceImage", order: 1 } }] }] };
}

const projectForComputeProvider = (project: Project, provider: Parameters<typeof projectForNodeComputeProvider>[3], workflows: WorkflowDefinition[]) =>
  projectForNodeComputeProvider(project, "c", "generated", provider, workflows, "comfyui");

describe("provider catalogs", () => {
  it("selects remote ComfyUI workflows independently from AI apps and local directories", () => {
    const remote = workflow("remote-cn", cn); remote.runninghub!.kind = "workflow";
    const legacy = workflow("legacy-cn", cn); delete legacy.runninghub!.kind;
    const foreign = workflow("remote-ai", ai); foreign.runninghub!.kind = "workflow";
    const current = { ...state(), computeProvider: "runninghub-workflow" as const, runningHubWorkflows: [rhCn, remote, legacy, foreign] };
    const choices = activeWorkflows(current);
    expect(choices).toEqual([remote, legacy]);
    expect(activeWorkflows(current)).toBe(choices);
    expect(activeConnection(current)).toBe(current.runningHubConnection);
    expect(executionWorkflows(current)).toEqual([rhCn, remote, legacy]);
    expect(activeWorkflows({ ...current, computeProvider: "runninghub" })).toEqual([rhCn]);
    expect(activeWorkflows({ ...current, runningHubConnection: { ...current.runningHubConnection, baseUrl: ai } })).toEqual([foreign]);
  });
  it("starts RunningHub with an empty directory and never borrows the cloud catalog", () => {
    const current = { ...state(), computeProvider: "runninghub" as const, runningHubWorkflows: [] };
    expect(activeWorkflows(current)).toEqual([]);
    expect(activeWorkflows(current)).not.toContain(cloud);
    expect(activeWorkflows({ ...current, computeProvider: "comfyui" })).toBe(current.workflows);
  });
  it("separates CN and AI sites while returning stable selector references", () => {
    const current = { ...state(), computeProvider: "runninghub" as const };
    const china = activeWorkflows(current);
    expect(china).toEqual([rhCn]);
    expect(activeWorkflows(current)).toBe(china);
    expect(activeWorkflows({ ...current, connection: { ...cloudConnection, token: "another-cloud-key" } })).toBe(china);
    const internationalState = { ...current, runningHubConnection: { ...current.runningHubConnection, baseUrl: ai } };
    const international = activeWorkflows(internationalState);
    expect(international).toEqual([rhAi]);
    expect(activeWorkflows(internationalState)).toBe(international);
    expect(activeWorkflows(current)).toBe(china);
  });
  it("normalizes surrounding whitespace and trailing slashes without mixing sites", () => {
    const current = { ...state(), computeProvider: "runninghub" as const, runningHubConnection: { ...defaultRunningHubConnection, baseUrl: cn + "/" } };
    expect(activeWorkflows(current)).toEqual([rhCn]);
    expect(activeWorkflows({ ...current, runningHubConnection: { ...current.runningHubConnection, baseUrl: " " + ai + "/// " } })).toEqual([rhAi]);
  });
  it("invalidates the filtered list when the dedicated RunningHub record changes", () => {
    const current = { ...state(), computeProvider: "runninghub" as const };
    const before = activeWorkflows(current);
    const added = workflow("runninghub-cn-second", cn);
    const changed = { ...current, runningHubWorkflows: [...current.runningHubWorkflows, added] };
    expect(activeWorkflows(changed)).toEqual([rhCn, added]);
    expect(activeWorkflows(changed)).not.toBe(before);
    expect(activeWorkflows(current)).toBe(before);
  });
  it("uses provider-specific credentials while exposing both catalogs only for persistence", () => {
    const current = state();
    expect(activeConnection(current)).toBe(current.connection);
    expect(activeConnection({ ...current, computeProvider: "runninghub" })).toBe(current.runningHubConnection);
    expect(allWorkflows(current)).toEqual([cloud, rhCn, rhAi, ...museWorkflows]);
    expect(defaultRunningHubConnection.token).toBe("");
  });
  it("separates new app choices from saved legacy execution records without changing either record", () => {
    const legacy = workflow("legacy-cn", cn), untyped = workflow("untyped-cn", cn), foreign = workflow("legacy-ai", ai);
    legacy.runninghub!.kind = "workflow"; delete untyped.runninghub!.kind; foreign.runninghub!.kind = "workflow";
    const current = { ...state(), computeProvider: "runninghub" as const, runningHubWorkflows: [rhCn, legacy, untyped, foreign, rhAi] };
    const before = structuredClone(current.runningHubWorkflows);
    const selectable = activeWorkflows(current), executable = executionWorkflows(current);
    expect(selectable).toEqual([rhCn]);
    expect(executable).toEqual([rhCn, legacy, untyped]);
    expect(activeWorkflows(current)).toBe(selectable);
    expect(executionWorkflows(current)).toBe(executable);
    const international = { ...current, runningHubConnection: { ...current.runningHubConnection, baseUrl: ai } };
    expect(activeWorkflows(international)).toEqual([rhAi]);
    expect(executionWorkflows(international)).toEqual([foreign, rhAi]);
    expect(allWorkflows(current)).toEqual([cloud, ...current.runningHubWorkflows, ...museWorkflows]);
    expect(current.runningHubWorkflows).toEqual(before);
    expect(executionWorkflows({ ...current, computeProvider: "comfyui" })).toBe(current.workflows);
    expect(activeWorkflows({ ...current, computeProvider: "comfyui" })).toBe(current.workflows);
  });
  it("keeps legacy execution records when there are no selectable AI apps", () => {
    const legacy = workflow("legacy-only", cn); legacy.runninghub!.kind = "workflow";
    const current = { ...state(), computeProvider: "runninghub" as const, runningHubWorkflows: [legacy] };
    expect(activeWorkflows(current)).toEqual([]);
    expect(executionWorkflows(current)).toEqual([legacy]);
    expect(allWorkflows(current)).toContain(legacy);
  });
});

describe("project provider selections", () => {
  it("keeps Muse separate and restores cloud parameters after switching back", () => {
    const current = { ...state(), computeProvider: "muse" as const };
    expect(activeWorkflows(current)).toBe(museWorkflows);
    expect(activeConnection(current)).toBe(museConnection);
    expect(activeConnection(current).token).toBe("");
    const original = project(), catalog = allWorkflows(current);
    const selected = projectForComputeProvider(original, "muse", catalog);
    expect(selected.canvases[0].nodes[0].data.generation).toMatchObject({ workflowId: "muse-image", params: { aspectRatio: "auto" } });
    expect(selected.tasks).toBe(original.tasks);
    const restored = projectForComputeProvider(selected, "comfyui", catalog);
    expect(restored.canvases[0].nodes[0].data.generation).toMatchObject({ workflowId: cloud.id, params: { seed: 31, steps: 20 }, prompt: "用户自己的提示词" });
  });
  it("remembers separate AI app and remote workflow choices without changing accepted tasks", () => {
    const remote = workflow("remote", cn); remote.runninghub!.kind = "workflow";
    const original = project(), catalog = [cloud, rhCn, remote];
    let current = projectForComputeProvider(original, "runninghub", catalog);
    current.canvases[0].nodes[0].data.generation = { ...current.canvases[0].nodes[0].data.generation!, workflowId: rhCn.id, params: { seed: 40 } };
    current = projectForComputeProvider(current, "runninghub-workflow", catalog);
    expect(current.canvases[0].nodes[0].data.generation).toMatchObject({ workflowId: "", params: {}, providerSelections: { runninghub: { workflowId: rhCn.id, params: { seed: 40 } } } });
    current.canvases[0].nodes[0].data.generation = { ...current.canvases[0].nodes[0].data.generation!, workflowId: remote.id, params: { seed: 90 } };
    current = projectForComputeProvider(current, "runninghub", catalog);
    expect(current.canvases[0].nodes[0].data.generation).toMatchObject({ workflowId: rhCn.id, params: { seed: 40 } });
    current = projectForComputeProvider(current, "runninghub-workflow", catalog);
    expect(current.canvases[0].nodes[0].data.generation).toMatchObject({ workflowId: remote.id, params: { seed: 90 } });
    expect(current.tasks).toBe(original.tasks);
    expect(current.assets).toBe(original.assets);
    expect(current.history).toBe(original.history);
  });
  it("keeps a CN card executable when the default site changes to AI", () => {
    const original = project();
    original.canvases[0].nodes[0].data.generation = { ...original.canvases[0].nodes[0].data.generation!, computeProvider: "runninghub", workflowId: rhCn.id };
    const cnConnection = { ...defaultRunningHubConnection, token: "cn-key" };
    const aiConnection = { ...cnConnection, baseUrl: ai, token: "ai-key" };
    const current = { ...state(), project: original, runningHubConnection: aiConnection, runningHubConnections: { cn: cnConnection, ai: aiConnection } };
    const scoped = nodeComputeState(current, "c", "generated");
    expect(scoped.computeProvider).toBe("runninghub");
    expect(activeConnection(scoped)).toBe(cnConnection);
    expect(activeWorkflows(scoped)).toEqual([rhCn]);
    expect(scoped.project).toBe(original);
    expect(current.runningHubConnection).toBe(aiConnection);
  });
  it("only changes the addressed card, preserving siblings and other canvases", () => {
    const original = project();
    const sibling = { ...structuredClone(original.canvases[0].nodes[0]), id: "sibling" };
    original.canvases[0].nodes.push(sibling);
    original.canvases.push({ ...structuredClone(original.canvases[0]), id: "other" });
    const next = projectForComputeProvider(original, "muse", allWorkflows(state()));
    expect(next.canvases[0].nodes[2]).toBe(sibling);
    expect(next.canvases[1]).toBe(original.canvases[1]);
    expect(next.canvases[0].nodes[0].data.generation?.computeProvider).toBe("muse");
    expect(next.tasks).toBe(original.tasks);
    expect(next.assets).toBe(original.assets);
  });
  it("pins legacy cards from their own definitions and preserves explicit providers on reload", () => {
    const original = project();
    const first = original.canvases[0].nodes[0];
    first.data.generation!.workflowId = rhCn.id;
    delete first.data.generation!.computeProvider;
    const next = restoreNodeComputeProviders(original, allWorkflows(state()), "muse");
    expect(next.canvases[0].nodes[0].data.generation).toMatchObject({ computeProvider: "runninghub", workflowId: rhCn.id, params: { seed: 31 } });
    expect(restoreNodeComputeProviders(next, allWorkflows(state()), "comfyui")).toBe(next);
  });
  it("does not restore an AI app into the remote workflow selection", () => {
    const original = project();
    original.canvases[0].nodes[0].data.generation!.providerSelections = { "runninghub-workflow": { workflowId: rhCn.id, params: { seed: 900 } } };
    const current = projectForComputeProvider(original, "runninghub-workflow", [cloud, rhCn]);
    expect(current.canvases[0].nodes[0].data.generation).toMatchObject({ workflowId: "", params: {} });
  });
  it("clears the previous provider's workflow and parameters while keeping user content and results", () => {
    const original = project(), before = structuredClone(original);
    const switched = projectForComputeProvider(original, "runninghub", [cloud, rhCn]);
    const generation = switched.canvases[0].nodes[0].data.generation!;
    expect(generation).toMatchObject({ computeProvider: "runninghub", workflowId: "", params: {}, prompt: "用户自己的提示词", negativePrompt: "保留负面词", taskId: "live-task",
      providerSelections: { comfyui: { workflowId: cloud.id, params: { seed: 31, steps: 20 } } } });
    expect(switched.canvases[0].nodes[0].data.assetId).toBe("result");
    expect(switched.canvases[0].nodes[0].data.generationFeedback).toBeUndefined();
    expect(switched.assets).toBe(original.assets);
    expect(switched.tasks).toBe(original.tasks);
    expect(switched.history).toBe(original.history);
    expect(switched.canvases[0].edges).toBe(original.canvases[0].edges);
    expect(switched.canvases[0].nodes[1]).toBe(original.canvases[0].nodes[1]);
    expect(original).toEqual(before);
  });
  it("restores independent workflow and seed values after repeated provider switches", () => {
    let current = projectForComputeProvider(project(), "runninghub", [cloud, rhCn]);
    const generation = current.canvases[0].nodes[0].data.generation!;
    current.canvases[0].nodes[0].data.generation = { ...generation, workflowId: rhCn.id, params: { seed: 88, steps: 4 }, prompt: "修改后的用户提示词" };
    current = projectForComputeProvider(current, "comfyui", [cloud, rhCn]);
    expect(current.canvases[0].nodes[0].data.generation).toMatchObject({ workflowId: cloud.id, params: { seed: 31, steps: 20 }, prompt: "修改后的用户提示词" });
    current = projectForComputeProvider(current, "runninghub", [cloud, rhCn]);
    expect(current.canvases[0].nodes[0].data.generation).toMatchObject({ workflowId: rhCn.id, params: { seed: 88, steps: 4 }, prompt: "修改后的用户提示词" });
  });
  it("refuses a saved selection that was removed or points to the other provider", () => {
    const original = project();
    original.canvases[0].nodes[0].data.generation!.providerSelections = { runninghub: { workflowId: cloud.id, params: { seed: 999 } } };
    expect(projectForComputeProvider(original, "runninghub", [cloud, rhCn]).canvases[0].nodes[0].data.generation).toMatchObject({ workflowId: "", params: {} });
    original.canvases[0].nodes[0].data.generation!.providerSelections = { runninghub: { workflowId: "removed-runninghub-id", params: { seed: 999 } } };
    expect(projectForComputeProvider(original, "runninghub", [cloud, rhCn]).canvases[0].nodes[0].data.generation).toMatchObject({ workflowId: "", params: {} });
  });
  it("recognizes older RunningHub nodes without an explicit provider marker", () => {
    const original = project();
    const generation = original.canvases[0].nodes[0].data.generation!;
    delete generation.computeProvider; generation.workflowId = rhCn.id; generation.params = { seed: 50 };
    const migrated = projectForComputeProvider(original, "comfyui", [cloud, rhCn]);
    expect(migrated.canvases[0].nodes[0].data.generation).toMatchObject({ computeProvider: "comfyui", workflowId: "", params: {}, providerSelections: { runninghub: { workflowId: rhCn.id, params: { seed: 50 } } } });
  });
  it("returns the original project when all generation nodes already use the active provider", () => {
    const original = project();
    expect(projectForComputeProvider(original, "comfyui", [cloud, rhCn])).toBe(original);
  });
  it("keeps remote workflows out of AI app selection without modifying accepted tasks", () => {
    const legacy = workflow("legacy-runninghub", cn); legacy.runninghub!.kind = "workflow";
    const original = project();
    original.canvases[0].nodes[0].data.generation!.providerSelections = { runninghub: { workflowId: legacy.id, params: { seed: 77 } } };
    const task = { ...original.tasks["live-task"], executorType: "runninghub" as const, workflow: legacy, promptId: "accepted-api-task" };
    original.tasks["live-task"] = task;
    const switched = projectForComputeProvider(original, "runninghub", [cloud, legacy]);
    expect(switched.canvases[0].nodes[0].data.generation).toMatchObject({ workflowId: "", params: {} });
    expect(switched.tasks).toBe(original.tasks);
    expect(switched.tasks["live-task"]).toBe(task);
    expect(task.executorType).toBe("runninghub");
    expect(task.workflow.runninghub?.kind).toBe("workflow");
    const current = { ...state(), computeProvider: "runninghub" as const, runningHubWorkflows: [legacy] };
    expect(activeWorkflows(current)).not.toContain(legacy);
    expect(executionWorkflows(current).find(item => item.id === task.workflow.id)).toBe(legacy);
  });
});
