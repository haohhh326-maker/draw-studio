import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, Connection, GenerationTask, WorkflowDefinition } from "../src/types";

const fixtures = vi.hoisted(() => ({ records: new Map<string, unknown>(), calls: [] as string[] }));
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(fixtures.records.get(key)),
  writeRecord: async (key: string, value: unknown) => { fixtures.records.set(key, structuredClone(value)); },
  safeConnection: (connection: Record<string, unknown>) => ({ ...connection }),
  getBlob: async () => new Blob(["input"], { type: "image/png" }), putBlob: async () => {},
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/assets/assets", () => ({ importAsset: vi.fn(async () => {
  fixtures.calls.push("import");
  return { id: "generated-rh", kind: "image", name: "result.png", mime: "image/png", size: 5, createdAt: Date.now() };
}) }));

import { ApiError, ComfyUIClient, ExecutionError } from "../src/comfyui/client";
import { RunningHubClient } from "../src/runninghub/client";
import { cancelTask, generate, hasActiveTasks, resumeTask } from "../src/generation/pipeline";
import { createNode, useStore } from "../src/stores/store";
import { defaultConnection } from "../src/workflow/catalog";
import { defaultRunningHubConnection, defaultRunningHubConnections } from "../src/compute/providers";
import { importAsset } from "../src/assets/assets";
import { withRunningHubWorkflowReader } from "./runninghub-test-reader";
import { prepareRunningHubWorkflow } from "../src/runninghub/workflows";
import { selectRunningHubBindings } from "../src/runninghub/selected-bindings";
import { attachRunningHubExecutionContract } from "../src/runninghub/execution-contract";

const rhConnection: Connection = { ...defaultRunningHubConnection, token: "rh-fixture-key", timeoutMinutes: 2 };
const cloudConnection: Connection = { ...defaultConnection, name: "云端工作站", baseUrl: "https://cloud.example", token: "cloud-fixture-key" };
const legacyDefinition: WorkflowDefinition = {
  id: "runninghub-own-workflow", name: "自己的 RunningHub 工作流", family: "Image", description: "", mode: "image-to-image",
  runninghub: { workflowId: "1234567890123456789", baseUrl: rhConnection.baseUrl },
  requiredInputs: ["image"], optionalInputs: [], parameters: [{ key: "seed", label: "种子", type: "number", default: 12 }],
  template: {
    "1": { class_type: "LoadImage", inputs: { image: "author-reference.png" } },
    "2": { class_type: "OwnImageGenerator", inputs: { prompt: "author prompt", reference: ["1", 0], seed: 12 } },
    "9": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "author-prefix" } },
    "10": { class_type: "OwnAdditionalNode", inputs: { enabled: true } },
  },
  mapping: [{ semantic: "prompt", nodeId: "2", field: "prompt" }, { semantic: "seed", nodeId: "2", field: "seed" }, { semantic: "image", nodeId: "1", field: "image" }],
  output: { nodeId: "9", field: "images", kind: "image", prefix: { nodeId: "9", field: "filename_prefix" } },
};
const sourceGraph = legacyDefinition.template!;
const readOptions = { baseUrl: rhConnection.baseUrl, workflowId: legacyDefinition.runninghub!.workflowId, name: legacyDefinition.name,
  promptKey: "2.prompt", outputs: [{ nodeId: "9", field: "images", kind: "image" as const }] };
const original = prepareRunningHubWorkflow(sourceGraph, await withRunningHubWorkflowReader(sourceGraph, readOptions)).workflow;
const seedKey = original.mapping.find(binding => binding.nodeId === "2" && binding.field === "seed")!.semantic;
const definition = await attachRunningHubExecutionContract({ ...selectRunningHubBindings(original, [seedKey]), id: legacyDefinition.id,
  output: { nodeId: "9", field: "images", kind: "image", prefix: { nodeId: "9", field: "filename_prefix" } } });
const mediaSemantic = definition.mapping.find(binding => binding.nodeId === "1" && binding.field === "image")!.semantic;
const cloudDefinition: WorkflowDefinition = { ...legacyDefinition, id: "cloud-own-workflow", name: "云端专用工作流", runninghub: undefined };
const input: Asset = { id: "reference-asset", kind: "image", name: "reference.png", mime: "image/png", size: 5, createdAt: 1, inLibrary: true };
const result = { filename: "result.png", subfolder: "", type: "output" as const, url: "https://cdn.example/result.png?signature=fixture" };
const currentNode = () => useStore.getState().project.canvases[0].nodes.find(node => node.id === "node")!;
const currentTask = () => Object.values(useStore.getState().project.tasks)[0];

function interruptedTask(extra: Partial<GenerationTask> = {}): GenerationTask {
  const { token: _, ...endpoint } = rhConnection;
  return { taskId: "durable-rh-task", promptId: "remote-rh-task", executorType: "runninghub", requestId: "durable-request", clientId: "durable-client",
    projectId: "project", canvasId: "canvas", nodeId: "node", nodeTitle: "图像 1", createdAt: 1, updatedAt: 1, status: "interrupted",
    connection: endpoint, workflow: structuredClone(legacyDefinition), input: { prompt: "自己的提示词", negativePrompt: "", params: { seed: 18 }, assets: [] }, outputs: [], ...extra };
}

beforeEach(() => {
  vi.restoreAllMocks(); fixtures.records.clear(); fixtures.calls.length = 0;
  const node = createNode("image-generation", 1); node.id = "node";
  node.data.generation = { workflowId: definition.id, prompt: "自己的提示词", negativePrompt: "保留细节", params: { [seedKey]: 18 }, taskId: null, computeProvider: "runninghub" };
  const reference = createNode("reference", 1); reference.id = "reference"; reference.data.assetId = input.id;
  useStore.setState({
    project: { version: 2, id: "project", name: "RH pipeline", activeCanvasId: "canvas", scenes: [{ id: "scene", name: "场景" }], updatedAt: 1,
      canvases: [{ id: "canvas", name: "画布", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node, reference], edges: [{ id: "input-edge", source: "reference", target: "node", data: { role: mediaSemantic, order: 0 } }] }],
      assets: { [input.id]: structuredClone(input) }, tasks: {}, history: [] },
    projects: {}, projectOpen: true, navigating: false, ready: false, past: [], future: [], toast: "",
    workflows: [structuredClone(cloudDefinition)], runningHubWorkflows: [structuredClone(definition)],
    computeProvider: "runninghub", connection: { ...cloudConnection }, runningHubConnection: { ...rhConnection }, runningHubConnections: structuredClone(defaultRunningHubConnections), connectionState: "offline", runningHubConnectionState: "offline",
  });
  // Any unexpected network call is an immediate failure; every remote operation below is a spy.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Tests must never access a remote or paid endpoint"); }));
  vi.spyOn(ComfyUIClient.prototype, "connect").mockRejectedValue(new Error("Must not contact ComfyUI"));
  vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockRejectedValue(new Error("Must not submit to ComfyUI"));
  vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockRejectedValue(new Error("Must not query ComfyUI"));
  vi.spyOn(ComfyUIClient.prototype, "cancel").mockRejectedValue(new Error("Must not cancel a ComfyUI task"));
  vi.spyOn(RunningHubClient.prototype, "connect").mockResolvedValue();
  vi.spyOn(RunningHubClient.prototype, "disconnect").mockImplementation(() => {});
  vi.spyOn(RunningHubClient.prototype, "uploadAsset").mockImplementation(async () => { fixtures.calls.push("upload"); return { name: "uploaded.png", subfolder: "openapi", type: "input", inputName: "openapi/uploaded.png" }; });
  vi.spyOn(RunningHubClient.prototype, "queuePrompt").mockImplementation(async () => { fixtures.calls.push("submit"); return "remote-rh-task"; });
  vi.spyOn(RunningHubClient.prototype, "waitForCompletion").mockImplementation(async (_id, onState) => {
    fixtures.calls.push("query"); onState({ status: "generating", execution: { nodeId: "2", nodeType: "OwnImageGenerator" }, progress: undefined });
    return { status: { completed: true }, outputs: { "9": { images: [result] } } };
  });
  vi.spyOn(RunningHubClient.prototype, "getOutput").mockImplementation(async () => { fixtures.calls.push("download"); return new Blob(["image"], { type: "image/png" }); });
  vi.spyOn(RunningHubClient.prototype, "findSubmittedPrompt").mockResolvedValue(null);
  vi.spyOn(RunningHubClient.prototype, "cancel").mockResolvedValue();
  vi.mocked(importAsset).mockClear();
});

afterEach(() => {
  expect(hasActiveTasks()).toBe(false);
  expect(ComfyUIClient.prototype.connect).not.toHaveBeenCalled();
  expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
  expect(ComfyUIClient.prototype.waitForCompletion).not.toHaveBeenCalled();
  expect(ComfyUIClient.prototype.cancel).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("RunningHub canvas pipeline", () => {
  it.each(["comfyui", "muse"] as const)("dispatches an existing RH card through its own executor when the new-card default is %s", async computeProvider => {
    useStore.setState({ computeProvider });
    await generate("canvas", "node");
    expect(currentTask()).toMatchObject({ executorType: "runninghub", status: "completed", nodeId: "node" });
    expect(currentNode().data.generation?.computeProvider).toBe("runninghub");
    expect(fixtures.calls).toEqual(["upload", "submit", "query", "download", "import"]);
  });

  it("uses the saved workflow site's credential when the toolbar is on another RH site", async () => {
    const aiConnection = { ...rhConnection, baseUrl: "https://www.runninghub.ai", token: "ai-fixture-key" };
    useStore.setState({ runningHubConnection: aiConnection, runningHubConnections: { cn: rhConnection, ai: aiConnection } });
    await generate("canvas", "node");
    expect(currentTask()).toMatchObject({ executorType: "runninghub", status: "completed", connection: { baseUrl: rhConnection.baseUrl } });
    expect(vi.mocked(RunningHubClient.prototype.queuePrompt).mock.contexts[0].connection).toMatchObject({ baseUrl: rhConnection.baseUrl, token: rhConnection.token });
  });

  it("runs remote workflow selections through the RH API executor and returns results to the same node", async () => {
    useStore.setState({ computeProvider: "runninghub-workflow" });
    currentNode().data.generation!.computeProvider = "runninghub-workflow";
    await generate("canvas", "node");
    const task = currentTask();
    expect(task).toMatchObject({ executorType: "runninghub", status: "completed", promptId: "remote-rh-task" });
    expect(task.workflow.runninghub?.workflowId).toBe(definition.runninghub!.workflowId);
    expect(task.connection.baseUrl).toBe(rhConnection.baseUrl);
    expect(currentNode().data.assetId).toBe("generated-rh");
    expect(fixtures.calls).toEqual(["upload", "submit", "query", "download", "import"]);
  });
  it("uses the RH workflow/connection for upload, submit, query and download, then completes the original node outside the library", async () => {
    const before = structuredClone(useStore.getState().runningHubWorkflows[0]);
    await generate("canvas", "node");
    const state = useStore.getState(), task = currentTask();
    expect(task.status).toBe("completed"); expect(task.executorType).toBe("runninghub"); expect(task.workflow.id).toBe(definition.id);
    expect(task.submissionState).toBeUndefined();
    expect(task.connection.baseUrl).toBe(rhConnection.baseUrl); expect(task.connection).not.toHaveProperty("token");
    expect(fixtures.calls).toEqual(["upload", "submit", "query", "download", "import"]);
    const submit = vi.mocked(RunningHubClient.prototype.queuePrompt), queued = submit.mock.calls[0][0];
    expect(submit.mock.contexts[0].connection).toMatchObject({ baseUrl: rhConnection.baseUrl, token: rhConnection.token });
    expect(queued["1"].inputs.image).toBe("openapi/uploaded.png");
    expect(queued["2"].inputs.prompt).toBe("自己的提示词"); expect(queued["2"].inputs.seed).toBe(18);
    expect(queued["10"]).toBeDefined(); // RH receives the complete imported graph, including platform-specific roots.
    expect(vi.mocked(RunningHubClient.prototype.getOutput).mock.calls[0][0].url).toBe(result.url);
    expect(currentNode().data.assetId).toBe("generated-rh"); expect(currentNode().data.generation?.taskId).toBe(task.taskId);
    expect(state.project.assets["generated-rh"].inLibrary).toBe(false); expect(state.project.assets[input.id].inLibrary).toBe(true);
    expect(state.project.history[0].workflowId).toBe(definition.id); expect(state.project.history[0].outputs).toEqual(["generated-rh"]);
    expect(state.runningHubWorkflows[0]).toEqual(before); expect(state.runningHubConnectionState).toBe("connected"); expect(state.connectionState).toBe("offline");
  });

  it("preserves upload diagnostics separately from the durable pre-submission marker", async () => {
    const diagnostic = "upload rejected: HTTP 422; stage=upload; upstreamCode=INVALID_MEDIA";
    vi.mocked(RunningHubClient.prototype.uploadAsset).mockImplementation(async () => {
      expect(currentTask().submissionState).toBe("not-submitted");
      throw new ExecutionError("RunningHub 素材上传失败", "failed", diagnostic);
    });
    await generate("canvas", "node");
    const task = currentTask();
    expect(task).toMatchObject({ status: "failed", promptId: null, submissionState: "not-submitted", details: diagnostic });
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
    // A persisted upload interruption must not be queried as a submitted task.
    useStore.getState().patchTask(task.taskId, { status: "interrupted" });
    await resumeTask(task.taskId);
    expect(currentTask()).toMatchObject({ status: "failed", submissionState: "not-submitted", details: diagnostic });
    expect(RunningHubClient.prototype.findSubmittedPrompt).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.waitForCompletion).not.toHaveBeenCalled();
  });

  it("still recognizes older persisted pre-submission sentinels", async () => {
    const task = interruptedTask({ promptId: null, details: "not-submitted" });
    useStore.getState().createTask(task);
    await resumeTask(task.taskId);
    expect(currentTask().status).toBe("failed");
    expect(currentTask().error).toContain("提交前中断");
    expect(RunningHubClient.prototype.findSubmittedPrompt).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("treats a known accepted prompt ID as authoritative over an obsolete pre-submission marker", async () => {
    const task = interruptedTask({ submissionState: "not-submitted" });
    useStore.getState().createTask(task);
    await resumeTask(task.taskId);
    expect(currentTask().status).toBe("completed");
    expect(currentTask().submissionState).toBeUndefined();
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("retains a definite backend rejection and actual failing node on the task referenced by the canvas", async () => {
    vi.mocked(RunningHubClient.prototype.queuePrompt).mockRejectedValue(new ExecutionError("RunningHub：参考图加载失败", "failed", "LoadImage: input missing", { nodeId: "1", nodeType: "LoadImage", nodeTitle: "加载参考图" }));
    await generate("canvas", "node");
    const task = currentTask();
    expect(task.status).toBe("failed"); expect(task.error).toBe("RunningHub：参考图加载失败"); expect(task.details).toBe("LoadImage: input missing");
    expect(task.execution).toMatchObject({ nodeId: "1", nodeType: "LoadImage" }); expect(currentNode().data.generation?.taskId).toBe(task.taskId);
    expect(RunningHubClient.prototype.waitForCompletion).not.toHaveBeenCalled(); expect(RunningHubClient.prototype.getOutput).not.toHaveBeenCalled();
    expect(useStore.getState().project.history).toHaveLength(0); expect(importAsset).not.toHaveBeenCalled();
  });

  it("shows validation feedback on the canvas and makes no task when RH is given a cloud workflow", async () => {
    const node = currentNode(); useStore.getState().patchNode(node.id, { generation: { ...node.data.generation!, workflowId: cloudDefinition.id } }, "canvas");
    await generate("canvas", "node");
    expect(currentNode().data.generationFeedback).toMatchObject({ status: "failed", error: "请先添加并选择 RunningHub AI 应用。" });
    expect(Object.keys(useStore.getState().project.tasks)).toHaveLength(0); expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled(); expect(RunningHubClient.prototype.uploadAsset).not.toHaveBeenCalled();
  });

  it("requires the RH key without falling back to the cloud token", async () => {
    useStore.setState({ runningHubConnection: { ...rhConnection, token: "" } });
    await generate("canvas", "node");
    expect(currentNode().data.generationFeedback?.error).toContain("RunningHub API Key");
    expect(Object.keys(useStore.getState().project.tasks)).toHaveLength(0); expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("requires the other RH site's own credential without using the selected site's key or cloud catalog", async () => {
    useStore.setState({ runningHubWorkflows: [{ ...definition, runninghub: { ...definition.runninghub!, baseUrl: "https://www.runninghub.ai" } }] });
    await generate("canvas", "node");
    expect(currentNode().data.generationFeedback?.status).toBe("failed"); expect(currentTask()).toBeUndefined(); expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(currentNode().data.generationFeedback?.error).toContain("RunningHub API Key");
  });

  it("resumes a saved RH task using the current RH credential even after the visible provider switches to cloud", async () => {
    const task = interruptedTask(); useStore.getState().createTask(task);
    useStore.getState().setComputeProvider("comfyui");
    useStore.setState({ runningHubConnection: { ...rhConnection, token: "updated-rh-fixture-key" } });
    await resumeTask(task.taskId);
    const query = vi.mocked(RunningHubClient.prototype.waitForCompletion);
    expect(query.mock.calls[0][0]).toBe(task.promptId); expect(query.mock.contexts[0].connection).toMatchObject({ baseUrl: rhConnection.baseUrl, token: "updated-rh-fixture-key" });
    expect(useStore.getState().computeProvider).toBe("comfyui"); expect(currentTask().executorType).toBe("runninghub"); expect(currentTask().status).toBe("completed");
    expect(currentNode().data.assetId).toBe("generated-rh"); expect(RunningHubClient.prototype.uploadAsset).not.toHaveBeenCalled(); expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("cancels only the persisted RH task after switching providers", async () => {
    const task = interruptedTask(); useStore.getState().createTask(task); useStore.getState().setComputeProvider("comfyui");
    await cancelTask(task.taskId);
    const cancel = vi.mocked(RunningHubClient.prototype.cancel);
    expect(cancel).toHaveBeenCalledExactlyOnceWith("remote-rh-task"); expect(cancel.mock.contexts[0].connection).toMatchObject({ baseUrl: rhConnection.baseUrl, token: rhConnection.token });
    expect(currentTask().status).toBe("cancelled"); expect(currentTask().executorType).toBe("runninghub"); expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("does not send a new-site key to an interrupted task belonging to the previous RH site", async () => {
    const task = interruptedTask(); useStore.getState().createTask(task);
    useStore.setState({ runningHubConnection: { ...rhConnection, baseUrl: "https://www.runninghub.ai", token: "other-site-fixture-key" } });
    vi.mocked(RunningHubClient.prototype.waitForCompletion).mockImplementation(async function (this: RunningHubClient) {
      expect(this.connection.baseUrl).toBe(rhConnection.baseUrl); expect(this.connection.token).toBe("");
      throw new Error("请配置原 RunningHub 站点的 API Key。");
    });
    await resumeTask(task.taskId);
    expect(currentTask().status).toBe("interrupted"); expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("keeps uncertain submission interrupted and never resubmits while generating, resuming or cancelling it", async () => {
    vi.mocked(RunningHubClient.prototype.queuePrompt).mockImplementation(async () => {
      expect(currentTask().submissionState).toBeUndefined();
      throw new ApiError("RunningHub response lost", 503);
    });
    await generate("canvas", "node");
    const task = currentTask(); expect(task.status).toBe("interrupted"); expect(task.promptId).toBeNull();
    expect(task.submissionState).toBeUndefined(); expect(task.details).not.toBe("not-submitted");
    await generate("canvas", "node"); expect(Object.keys(useStore.getState().project.tasks)).toHaveLength(1);
    await resumeTask(task.taskId);
    expect(currentTask().status).toBe("interrupted"); expect(currentTask().error).toContain("不会自动重新提交");
    expect(currentTask().submissionState).toBeUndefined();
    await cancelTask(task.taskId);
    expect(currentTask().status).toBe("interrupted"); expect(useStore.getState().toast).toContain("无法确认服务器任务");
    expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1); expect(RunningHubClient.prototype.waitForCompletion).not.toHaveBeenCalled(); expect(RunningHubClient.prototype.cancel).not.toHaveBeenCalled();
  });

  it("can recover a known accepted task ID in memory without uploading or submitting again", async () => {
    const task = interruptedTask({ promptId: null }); useStore.getState().createTask(task);
    vi.mocked(RunningHubClient.prototype.findSubmittedPrompt).mockResolvedValue("recovered-rh-task");
    await resumeTask(task.taskId);
    expect(currentTask().status).toBe("completed"); expect(currentTask().promptId).toBe("recovered-rh-task");
    expect(RunningHubClient.prototype.findSubmittedPrompt).toHaveBeenCalledExactlyOnceWith(task.requestId);
    expect(vi.mocked(RunningHubClient.prototype.waitForCompletion).mock.calls[0][0]).toBe("recovered-rh-task");
    expect(RunningHubClient.prototype.uploadAsset).not.toHaveBeenCalled(); expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });
});
