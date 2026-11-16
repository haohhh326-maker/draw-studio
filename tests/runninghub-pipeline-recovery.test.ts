import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiWorkflow, Asset, GenerationTask, Project, WorkflowDefinition } from "../src/types";

const fixtures = vi.hoisted(() => ({ records: new Map<string, unknown>(), blobs: new Map<string, Blob>(), assetId: 0 }));
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(fixtures.records.get(key)),
  writeRecord: async (key: string, value: unknown) => { fixtures.records.set(key, structuredClone(value)); },
  safeConnection: (connection: Record<string, unknown>) => ({ ...connection, token: "" }),
  getBlob: async (id: string) => {
    const blob = fixtures.blobs.get(id);
    if (!blob) throw new Error("Missing local blob");
    return blob;
  },
  putBlob: async () => {},
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/assets/assets", () => ({ importAsset: vi.fn() }));

import { ApiError, ComfyUIClient, ExecutionError, type History } from "../src/comfyui/client";
import { outputKey } from "../src/comfyui/files";
import { RunningHubClient, runningHubNodeInfoList } from "../src/runninghub/client";
import { cancelTask, generate, hasActiveTasks, resumeTask } from "../src/generation/pipeline";
import { createNode, useStore, type ProjectLibrary } from "../src/stores/store";
import { defaultConnection } from "../src/workflow/catalog";
import { defaultRunningHubConnection } from "../src/compute/providers";
import { importAsset } from "../src/assets/assets";
import { elapsedSeconds } from "../src/generation/elapsed";
import { runningHubTimingDiagnostics } from "../src/generation/runninghub-timing";
import { selectRunningHubBindings } from "../src/runninghub/selected-bindings";
import { attachRunningHubExecutionContract, validateRunningHubExecutionGraph } from "../src/runninghub/execution-contract";
import * as runningHubRunBindings from "../src/runninghub/run-bindings";
import { withRunningHubWorkflowReader } from "./runninghub-test-reader";
import { prepareRunningHubWorkflow } from "../src/runninghub/workflows";

const connection = { ...defaultRunningHubConnection, token: "rh-recovery-fixture", timeoutMinutes: 2 };
const legacyDefinition: WorkflowDefinition = {
  id: "rh-recovery", name: "恢复原任务", family: "Tests", description: "", mode: "text-to-image",
  runninghub: { workflowId: "1234567890123456789", baseUrl: connection.baseUrl },
  requiredInputs: [], optionalInputs: [], parameters: [],
  template: {
    "1": { class_type: "GenerateImage", inputs: { prompt: "" } },
    "9": { class_type: "SaveImage", inputs: { image: ["1", 0] } },
  },
  mapping: [{ semantic: "prompt", nodeId: "1", field: "prompt" }],
  output: { nodeId: "9", field: "images", kind: "image" },
};
async function originalDefinition(graph: ApiWorkflow, selectedFields?: string[]) {
  const options = { workflowId: legacyDefinition.runninghub!.workflowId, baseUrl: connection.baseUrl,
    name: legacyDefinition.name, promptKey: "1.prompt", outputs: [{ nodeId: "9", field: "images", kind: "image" as const }] };
  let workflow = prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, options)).workflow;
  if (selectedFields) {
    const keys = workflow.mapping.filter(binding => selectedFields.includes(binding.field)).map(binding => binding.semantic);
    workflow = selectRunningHubBindings(workflow, keys);
  }
  return attachRunningHubExecutionContract({ ...workflow, id: legacyDefinition.id });
}
const definition = await originalDefinition(legacyDefinition.template!);
const files = ["first.png", "second.png"].map(filename => ({
  filename, subfolder: "", type: "output" as const, url: "https://cdn.example/" + filename,
}));
const identifiedFiles = files.map(file => ({ ...file, sourceNodeId: "9", sourceField: "images" }));
const history: History = { status: { completed: true }, outputs: { "9": { images: files } } };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function task() { return Object.values(useStore.getState().project.tasks)[0]; }
function selectInstanceType(value: GenerationTask["runningHubInstanceType"]) {
  const node = useStore.getState().project.canvases[0].nodes.find(item => item.id === "node")!;
  useStore.getState().patchNode("node", { generation: { ...node.data.generation!, runningHubInstanceType: value } }, "canvas");
}
let cloudTransportExpected = false;
function interrupted(): GenerationTask {
  const { token: _, ...endpoint } = connection;
  return {
    taskId: "saved-task", promptId: "remote-task", executorType: "runninghub", requestId: "saved-request", clientId: "saved-client",
    projectId: "project", canvasId: "canvas", nodeId: "node", nodeTitle: "图像 1", status: "interrupted", createdAt: 1, updatedAt: 1,
    connection: endpoint, workflow: structuredClone(legacyDefinition), input: { prompt: "花", negativePrompt: "", params: {}, assets: [] }, outputs: [],
  };
}
async function saveAsset(blob: Blob, name: string): Promise<Asset> {
  const id = "result-" + ++fixtures.assetId;
  fixtures.blobs.set(id, blob);
  return { id, name, kind: "image", mime: blob.type, size: blob.size, createdAt: 1 };
}

beforeEach(() => {
  cloudTransportExpected = false;
  vi.restoreAllMocks(); fixtures.records.clear(); fixtures.blobs.clear(); fixtures.assetId = 0;
  const node = createNode("image-generation", 1); node.id = "node";
  node.data.generation = { workflowId: definition.id, prompt: "花", negativePrompt: "", params: {}, taskId: null, computeProvider: "runninghub" };
  const project: Project = {
    version: 2, id: "project", name: "恢复测试", scenes: [{ id: "scene", name: "场景" }], activeCanvasId: "canvas", updatedAt: 1,
    canvases: [{ id: "canvas", name: "画布", sceneId: "scene", nodes: [node], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }],
    tasks: {}, assets: {}, history: [],
  };
  useStore.setState({ project, projects: {}, projectOpen: true, navigating: false, ready: false, past: [], future: [], toast: "",
    workflows: [], runningHubWorkflows: [structuredClone(definition)], computeProvider: "runninghub", connection: { ...defaultConnection },
    runningHubConnection: { ...connection }, connectionState: "offline", runningHubConnectionState: "offline" });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No real network or paid calls in recovery tests"); }));
  vi.spyOn(ComfyUIClient.prototype, "connect").mockRejectedValue(new Error("Cloud transport must remain unused"));
  vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockRejectedValue(new Error("Cloud submission must remain unused"));
  vi.spyOn(RunningHubClient.prototype, "connect").mockResolvedValue();
  vi.spyOn(RunningHubClient.prototype, "disconnect").mockImplementation(() => {});
  vi.spyOn(RunningHubClient.prototype, "uploadAsset").mockRejectedValue(new Error("No input upload expected"));
  vi.spyOn(RunningHubClient.prototype, "queuePrompt").mockResolvedValue("remote-task");
  vi.spyOn(RunningHubClient.prototype, "waitForCompletion").mockResolvedValue(history);
  vi.spyOn(RunningHubClient.prototype, "getOutput").mockImplementation(async file => new Blob([file.filename], { type: "image/png" }));
  vi.spyOn(RunningHubClient.prototype, "findSubmittedPrompt").mockResolvedValue(null);
  vi.spyOn(RunningHubClient.prototype, "cancel").mockResolvedValue();
  vi.mocked(importAsset).mockReset().mockImplementation(saveAsset);
});
afterEach(() => {
  expect(hasActiveTasks()).toBe(false);
  if (cloudTransportExpected) {
    expect(ComfyUIClient.prototype.connect).toHaveBeenCalledTimes(1);
    expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
  } else {
    expect(ComfyUIClient.prototype.connect).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
  }
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("RunningHub selected bindings through the generation pipeline", () => {
  it.each([2, 3])("saves every one of %i results and uses decoded HD dimensions for the canvas and durable history", async count => {
    const results = ["ultra-preview.png", "actual-result.png", "third-result.png"].slice(0, count).map((filename, index) => ({
      filename, type: "output" as const, subfolder: "", url: "https://cdn.example/" + filename,
      sourceNodeId: "9", sourceField: "images", width: index === 0 ? 8192 : 256, height: index === 0 ? 8192 : 256,
    }));
    vi.mocked(RunningHubClient.prototype.waitForCompletion).mockResolvedValue({ status: { completed: true }, outputs: { "9": { images: results } } });
    vi.mocked(importAsset).mockImplementation(async (blob, name) => ({
      ...await saveAsset(blob, name), width: name === "actual-result.png" ? 4096 : 512, height: name === "actual-result.png" ? 2048 : 512,
    }));
    await generate("canvas", "node");
    const project = useStore.getState().project, completed = task();
    expect(completed.status).toBe("completed");
    expect(completed.downloadedOutputs).toHaveLength(count);
    expect(completed.outputs).toHaveLength(count);
    expect(new Set(completed.outputs).size).toBe(count);
    const primary = project.assets[completed.outputs[0]];
    expect(primary).toMatchObject({ name: "actual-result.png", width: 4096, height: 2048 });
    expect(project.canvases[0].nodes[0].data.assetId).toBe(primary.id);
    expect(project.history[0].outputs).toEqual(completed.outputs);
    const persisted = (fixtures.records.get("project-library") as ProjectLibrary).project.project;
    expect(persisted.tasks[completed.taskId].outputs).toEqual(completed.outputs);
    expect(persisted.history[0].outputs[0]).toBe(primary.id);
    expect(RunningHubClient.prototype.getOutput).toHaveBeenCalledTimes(count);
  });

  it("recovers saved ordinary and HD results without resubmitting or downloading them again", async () => {
    const saved = interrupted();
    const normal = await saveAsset(new Blob(["normal"], { type: "image/png" }), "normal.png");
    const hd = { ...await saveAsset(new Blob(["hd"], { type: "image/png" }), "hd.png"), width: 4096, height: 4096 };
    normal.width = 512; normal.height = 512;
    saved.remoteOutputs = files;
    saved.downloadedOutputs = [{ file: files[0], asset: normal }, { file: files[1], asset: hd }];
    useStore.getState().createTask(saved);
    await resumeTask(saved.taskId);
    const completed = useStore.getState().project.tasks[saved.taskId];
    expect(completed.status).toBe("completed");
    expect(completed.outputs).toEqual([hd.id, normal.id]);
    expect(useStore.getState().project.history[0].outputs).toEqual([hd.id, normal.id]);
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.getOutput).not.toHaveBeenCalled();
  });

  it.each(["edges", "project-return"] as const)("expires asynchronous preparation permanently after %s changes", async change => {
    const prepared = await runningHubRunBindings.prepareRunningHubRun(definition, {});
    const waiting = deferred<typeof prepared>();
    const prepare = vi.spyOn(runningHubRunBindings, "prepareRunningHubRun").mockReturnValue(waiting.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    const original = useStore.getState().project;
    if (change === "edges") useStore.setState({ project: { ...original, canvases: original.canvases.map(canvas => ({ ...canvas,
      edges: [...canvas.edges, { id: "new-input", source: "reference", target: "node", data: { role: "auto", order: 0 } }],
    })) } });
    else {
      useStore.setState({ project: { ...original, id: "different-project" } });
      useStore.setState({ project: original });
    }
    waiting.resolve(prepared); await pending;
    expect(useStore.getState().project.tasks).toEqual({});
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(useStore.getState().project.canvases[0].nodes[0].data.generationFeedback).toBeUndefined();
  });

  it("keeps asynchronous preparation isolated from another card, global provider, viewport and unrelated assets", async () => {
    const prepared = await runningHubRunBindings.prepareRunningHubRun(definition, {});
    const waiting = deferred<typeof prepared>();
    const prepare = vi.spyOn(runningHubRunBindings, "prepareRunningHubRun").mockReturnValue(waiting.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    const other = createNode("image-generation", 2); other.id = "other";
    other.data.generation = { workflowId: "muse-image", computeProvider: "muse", prompt: "Another job", negativePrompt: "", params: {}, taskId: null };
    useStore.setState(state => ({ computeProvider: "muse", project: { ...state.project,
      assets: { ...state.project.assets, unrelated: { id: "unrelated", name: "other.png", kind: "image", mime: "image/png", size: 9, createdAt: 1 } },
      canvases: state.project.canvases.map(canvas => ({ ...canvas, edges: [...canvas.edges], viewport: { x: 123, y: 456, zoom: 0.5 },
        nodes: [...canvas.nodes.map(node => ({ ...node, position: { x: 100, y: 300 } })), other] })),
    } }));
    waiting.resolve(prepared); await pending;
    expect(task()).toMatchObject({ status: "completed", executorType: "runninghub", canvasId: "canvas", nodeId: "node" });
    expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
    expect(useStore.getState().project.canvases[0].nodes.find(node => node.id === "other")?.data.generation).toMatchObject({ prompt: "Another job", taskId: null });
  });

  it("does not attach an obsolete preparation error to a changed generation draft", async () => {
    const waiting = deferred<Awaited<ReturnType<typeof runningHubRunBindings.prepareRunningHubRun>>>();
    const prepare = vi.spyOn(runningHubRunBindings, "prepareRunningHubRun").mockReturnValue(waiting.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    const node = useStore.getState().project.canvases[0].nodes[0];
    useStore.getState().patchNode("node", { generation: { ...node.data.generation!, prompt: "New draft" } }, "canvas");
    waiting.reject(new Error("Obsolete source error")); await pending;
    expect(useStore.getState().project.canvases[0].nodes[0].data.generationFeedback).toBeUndefined();
    expect(useStore.getState().toast).not.toContain("Obsolete");
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("excludes stale node values from execution and history and retains the remote filename default", async () => {
    const source = structuredClone(definition.template!);
    Object.assign(source["1"].inputs, { seed: 1, device: "cuda" });
    source["9"].inputs.filename_prefix = "author-prefix";
    const selected = await originalDefinition(source, ["seed"]);
    const seedKey = selected.mapping.find(binding => binding.nodeId === "1" && binding.field === "seed")!.semantic;
    const deviceKey = selected.runninghub!.sourceBindings!.find(binding => binding.target.nodeId === "1" && binding.target.fieldName === "device")!.key;
    useStore.setState({ runningHubWorkflows: [selected] });
    const node = useStore.getState().project.canvases[0].nodes[0];
    useStore.getState().patchNode("node", { generation: { ...node.data.generation!, params: { [seedKey]: 42, [deviceKey]: "cpu", obsolete: 99 } } }, "canvas");
    vi.mocked(RunningHubClient.prototype.queuePrompt).mockImplementation(async graph => {
      await validateRunningHubExecutionGraph(task().workflow, graph);
      expect(graph["1"].inputs).toEqual({ prompt: "花", seed: 42, device: "cuda" });
      expect(graph["9"].inputs.filename_prefix).toBe("author-prefix");
      expect(runningHubNodeInfoList(graph, task().workflow).map(field => field.fieldName)).toEqual(["prompt", "seed"]);
      return "selected-task";
    });
    await generate("canvas", "node");
    expect(task()).toMatchObject({ status: "completed", promptId: "selected-task", input: { params: { [seedKey]: 42 } } });
    expect(useStore.getState().project.history[0].params).toEqual({ [seedKey]: 42 });
  });

  it("does not migrate or re-submit an accepted legacy task after catalog bindings change", async () => {
    const saved = interrupted(); saved.input.params = { legacyValue: 77 };
    const before = structuredClone(saved.workflow);
    useStore.getState().createTask(saved);
    const catalog = await attachRunningHubExecutionContract(selectRunningHubBindings(definition, []));
    useStore.setState({ runningHubWorkflows: [catalog] });
    await resumeTask(saved.taskId);
    expect(task().workflow).toEqual(before);
    expect(task().input.params).toEqual({ legacyValue: 77 });
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.waitForCompletion).toHaveBeenCalledWith("remote-task", expect.any(Function), expect.any(AbortSignal), before.template);
  });
});

describe("RunningHub execution-mode snapshots", () => {
  it.each(["plus", "ultra"] as const)("persists selected %s in the accepted task and history independently of later node changes", async mode => {
    selectInstanceType(mode);
    let submittedGraph: ApiWorkflow | undefined;
    vi.mocked(RunningHubClient.prototype.queuePrompt).mockImplementation(async graph => {
      submittedGraph = structuredClone(graph);
      expect(task().runningHubInstanceType).toBe(mode);
      const checkpoint = (fixtures.records.get("project-library") as ProjectLibrary).project.project;
      expect(checkpoint.tasks[task().taskId].runningHubInstanceType).toBe(mode);
      selectInstanceType("default");
      return "accepted-" + mode;
    });

    await generate("canvas", "node");
    const state = useStore.getState(), saved = (fixtures.records.get("project-library") as ProjectLibrary).project.project;
    expect(task()).toMatchObject({ status: "completed", promptId: "accepted-" + mode, runningHubInstanceType: mode });
    expect(state.project.canvases[0].nodes[0].data.generation?.runningHubInstanceType).toBe("default");
    expect(state.project.history[0].runningHubInstanceType).toBe(mode);
    expect(saved.tasks[task().taskId].runningHubInstanceType).toBe(mode);
    expect(saved.history[0].runningHubInstanceType).toBe(mode);
    expect(task().workflow.template).toEqual(definition.template);
    expect(submittedGraph).toEqual({ ...definition.template, "1": { class_type: "GenerateImage", inputs: { prompt: "花" } } });
    expect(task().input.params).not.toHaveProperty("runningHubInstanceType");
    expect(JSON.stringify(runningHubNodeInfoList(submittedGraph!, task().workflow))).not.toMatch(/runningHubInstanceType|instanceType/);
    expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
  });

  it("defaults an older node without an execution mode to default in task and persisted history", async () => {
    expect(useStore.getState().project.canvases[0].nodes[0].data.generation).not.toHaveProperty("runningHubInstanceType");
    await generate("canvas", "node");
    expect(task()).toMatchObject({ status: "completed", runningHubInstanceType: "default" });
    const saved = (fixtures.records.get("project-library") as ProjectLibrary).project.project;
    expect(saved.tasks[task().taskId].runningHubInstanceType).toBe("default");
    expect(saved.history[0].runningHubInstanceType).toBe("default");
  });

  it.each(["plus", "ultra"] as const)("recovers a persisted %s task using its snapshot while the current node selects another mode", async mode => {
    const saved = { ...interrupted(), runningHubInstanceType: mode };
    useStore.getState().createTask(saved);
    await useStore.getState().save(true);
    const persisted = structuredClone((fixtures.records.get("project-library") as ProjectLibrary).project.project);
    useStore.setState({ project: persisted });
    const currentMode = mode === "plus" ? "ultra" : "plus";
    selectInstanceType(currentMode);
    vi.mocked(RunningHubClient.prototype.waitForCompletion).mockImplementation(async id => {
      expect(id).toBe(saved.promptId);
      expect(task().runningHubInstanceType).toBe(mode);
      expect(useStore.getState().project.canvases[0].nodes[0].data.generation?.runningHubInstanceType).toBe(currentMode);
      return history;
    });

    await resumeTask(saved.taskId);
    expect(task()).toMatchObject({ status: "completed", promptId: saved.promptId, runningHubInstanceType: mode });
    expect(useStore.getState().project.history[0].runningHubInstanceType).toBe(mode);
    const completed = (fixtures.records.get("project-library") as ProjectLibrary).project.project;
    expect(completed.tasks[saved.taskId].runningHubInstanceType).toBe(mode);
    expect(completed.history[0].runningHubInstanceType).toBe(mode);
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("keeps a legacy accepted task's default mode when the current node selects ultra", async () => {
    const saved = interrupted();
    useStore.getState().createTask(saved);
    selectInstanceType("ultra");
    await resumeTask(saved.taskId);
    expect(task()).toMatchObject({ status: "completed", promptId: saved.promptId });
    expect(useStore.getState().project.history[0].runningHubInstanceType).toBe("default");
    expect((fixtures.records.get("project-library") as ProjectLibrary).project.project.history[0].runningHubInstanceType).toBe("default");
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("rejects an invalid runtime mode before creating, connecting, uploading or submitting a task", async () => {
    selectInstanceType("unsupported-mode" as GenerationTask["runningHubInstanceType"]);
    await generate("canvas", "node");
    expect(useStore.getState().project.tasks).toEqual({});
    expect(useStore.getState().project.history).toEqual([]);
    expect(useStore.getState().project.canvases[0].nodes[0].data.generationFeedback?.status).toBe("failed");
    expect(RunningHubClient.prototype.connect).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.uploadAsset).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.waitForCompletion).not.toHaveBeenCalled();
  });

  it("does not apply or validate a stale RunningHub mode when generating with the cloud provider", async () => {
    cloudTransportExpected = true;
    const cloudWorkflow = { ...structuredClone(definition), id: "cloud-mode-isolation", runninghub: undefined };
    useStore.setState({ computeProvider: "comfyui", workflows: [cloudWorkflow], connection: { ...defaultConnection } });
    const node = useStore.getState().project.canvases[0].nodes[0];
    useStore.getState().patchNode("node", { generation: { ...node.data.generation!, workflowId: cloudWorkflow.id,
      computeProvider: "comfyui", runningHubInstanceType: "unsupported-rh-mode" as GenerationTask["runningHubInstanceType"] } }, "canvas");
    vi.mocked(ComfyUIClient.prototype.connect).mockResolvedValue();
    vi.mocked(ComfyUIClient.prototype.queuePrompt).mockResolvedValue("cloud-task");
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockResolvedValue(history);
    vi.spyOn(ComfyUIClient.prototype, "getOutput").mockImplementation(async file => new Blob([file.filename], { type: "image/png" }));

    await generate("canvas", "node");
    expect(task()).toMatchObject({ status: "completed", promptId: "cloud-task", executorType: "comfyui" });
    expect(task()).not.toHaveProperty("runningHubInstanceType");
    expect(useStore.getState().project.history[0]).not.toHaveProperty("runningHubInstanceType");
    expect(RunningHubClient.prototype.connect).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });
});

describe("RunningHub original-task recovery", () => {
  it("does not accept a download error page as a completed media result", async () => {
    const saved = interrupted();
    saved.remoteOutputs = [files[0]];
    useStore.getState().createTask(saved);
    vi.mocked(RunningHubClient.prototype.getOutput).mockResolvedValue(new Blob(["<!doctype html><html>Storage unavailable</html>"], { type: "text/html" }));
    await resumeTask(saved.taskId);
    expect(task().status).toBe("interrupted");
    expect(task().error).toContain("下载返回了网页");
    expect(task().outputs).toEqual([]);
    expect(importAsset).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("recovers an old image receipt failure by downloading the two PNGs and skipping their bundled ZIP", async () => {
    const bundle = { ...files[0], filename: "results.zip", url: "https://cdn.example/results.zip" };
    const saved = interrupted();
    saved.error = "输出媒体类型与工作流定义不符";
    saved.remoteOutputs = [bundle, ...files];
    saved.remoteOutputKinds = Object.fromEntries(saved.remoteOutputs.map(file => [outputKey(file), "image" as const]));
    useStore.getState().createTask(saved);
    await useStore.getState().save(true);
    useStore.setState({ project: structuredClone((fixtures.records.get("project-library") as ProjectLibrary).project.project) });

    await resumeTask(saved.taskId);

    const project = useStore.getState().project;
    expect(task()).toMatchObject({ status: "completed", promptId: saved.promptId, remoteOutputs: [bundle, ...files] });
    expect(vi.mocked(RunningHubClient.prototype.getOutput).mock.calls.map(call => call[0])).toEqual(files);
    expect(task().outputs.map(id => project.assets[id])).toEqual([
      expect.objectContaining({ name: "first.png", kind: "image", mime: "image/png" }),
      expect.objectContaining({ name: "second.png", kind: "image", mime: "image/png" }),
    ]);
    expect(task().downloadedOutputs?.map(entry => entry.file.filename)).toEqual(["first.png", "second.png"]);
    expect(Object.values(project.assets).some(asset => asset.name.endsWith(".zip"))).toBe(false);
    expect(project.canvases[0].nodes[0].data.assetId).toBe(task().outputs[0]);
    expect(project.history[0].outputs).toEqual(task().outputs);
    expect(task().outputWarnings).toEqual([expect.stringContaining("附带压缩包")]);
    expect((fixtures.records.get("project-library") as ProjectLibrary).project.project.tasks[saved.taskId].outputs).toEqual(task().outputs);
    expect(RunningHubClient.prototype.waitForCompletion).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it.each([
    ["video", "result.gif", "image/gif"],
    ["file", "result.png", "image/png"],
  ] as const)("receives a %s declaration as its actual image and reuses it despite stale checkpoint kinds", async (declaredKind, filename, mime) => {
    const file = { ...files[0], filename, url: "https://cdn.example/" + filename };
    const saved = interrupted();
    saved.workflow.output.kind = declaredKind;
    saved.remoteOutputs = [file];
    saved.remoteOutputKinds = { [outputKey(file)]: declaredKind };
    saved.error = "输出媒体类型与工作流定义不符";
    useStore.getState().createTask(saved);
    vi.mocked(RunningHubClient.prototype.getOutput).mockResolvedValue(new Blob(["original image bytes"], { type: mime }));

    await resumeTask(saved.taskId);

    const first = structuredClone(task());
    expect(first.status).toBe("completed");
    expect(first.remoteOutputKinds).toEqual({ [outputKey(file)]: "image" });
    expect(useStore.getState().project.assets[first.outputs[0]]).toMatchObject({ name: filename, kind: "image", mime });
    expect(importAsset).toHaveBeenCalledExactlyOnceWith(expect.any(Blob), filename);
    expect(RunningHubClient.prototype.getOutput).toHaveBeenCalledExactlyOnceWith(file, expect.any(AbortSignal), expect.any(Function));
    useStore.getState().patchTask(saved.taskId, { status: "interrupted", remoteOutputKinds: { [outputKey(file)]: declaredKind } });
    await useStore.getState().save(true);
    useStore.setState({ project: structuredClone((fixtures.records.get("project-library") as ProjectLibrary).project.project) });
    vi.mocked(RunningHubClient.prototype.getOutput).mockClear();
    vi.mocked(importAsset).mockClear();

    await resumeTask(saved.taskId);

    expect(task()).toMatchObject({ status: "completed", outputs: first.outputs, remoteOutputKinds: { [outputKey(file)]: "image" } });
    expect((fixtures.records.get("project-library") as ProjectLibrary).project.project.tasks[saved.taskId].remoteOutputKinds)
      .toEqual({ [outputKey(file)]: "image" });
    expect(RunningHubClient.prototype.getOutput).not.toHaveBeenCalled();
    expect(importAsset).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.waitForCompletion).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it.each(["archive-only", "explicit-file"] as const)("keeps an %s result downloadable", async variant => {
    const bundle = { ...files[0], filename: "results.zip", url: "https://cdn.example/results.zip" };
    const saved = interrupted();
    saved.remoteOutputs = variant === "archive-only" ? [bundle] : [bundle, files[0]];
    saved.remoteOutputKinds = { [outputKey(bundle)]: variant === "archive-only" ? "image" : "file", [outputKey(files[0])]: "image" };
    useStore.getState().createTask(saved);
    vi.mocked(RunningHubClient.prototype.getOutput).mockImplementation(async file => new Blob([file.filename], {
      type: file.filename.endsWith(".zip") ? "application/zip" : "image/png",
    }));
    vi.mocked(importAsset).mockImplementation(async (blob, name) => ({ ...await saveAsset(blob, name),
      kind: blob.type === "application/zip" ? "file" : "image" }));

    await resumeTask(saved.taskId);

    const project = useStore.getState().project;
    expect(task().status).toBe("completed");
    expect(vi.mocked(RunningHubClient.prototype.getOutput).mock.calls.map(call => call[0])).toEqual(saved.remoteOutputs);
    expect(task().outputs.map(id => project.assets[id].kind)).toEqual(variant === "archive-only" ? ["file"] : ["image", "file"]);
    const archive = task().outputs.map(id => project.assets[id]).find(asset => asset.kind === "file");
    expect(archive).toMatchObject({ name: "results.zip", kind: "file", mime: "application/zip" });
    if (variant === "explicit-file") expect(project.assets[task().outputs[0]].name).toBe(files[0].filename);
    expect(task().outputWarnings).toEqual([]);
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("persists completed remote outputs after a download rejection and restores only missing files without queueing", async () => {
    vi.mocked(RunningHubClient.prototype.waitForCompletion).mockResolvedValue({ ...history, runningHubTiming: { providerDurationSeconds: 130 } });
    vi.mocked(RunningHubClient.prototype.getOutput).mockImplementation(async file => {
      if (file.filename === "second.png") throw new ExecutionError("CDN 暂不可读", "failed", "download rejection");
      return new Blob([file.filename], { type: "image/png" });
    });
    await generate("canvas", "node");
    expect(task()).toMatchObject({ status: "interrupted", promptId: "remote-task", remoteOutputs: files });
    expect(task().downloadedOutputs).toHaveLength(1);
    const saved = (fixtures.records.get("project-library") as ProjectLibrary).project.project;
    const original = Object.values(saved.tasks)[0];
    expect(original.status).toBe("interrupted"); expect(original.remoteOutputs).toEqual(identifiedFiles);
    expect(original.runningHubTiming?.remoteFinishedAt).toBeTypeOf("number");
    expect(original.runningHubTiming?.providerDurationSeconds).toBe(130);
    const originalFinish = original.runningHubTiming!.remoteFinishedAt!;
    vi.spyOn(Date, "now").mockReturnValue(originalFinish + 60000);
    useStore.setState({ project: structuredClone(saved) });
    vi.mocked(RunningHubClient.prototype.connect).mockRejectedValue(new Error("A changed schema must not block downloading an old result"));
    vi.mocked(RunningHubClient.prototype.waitForCompletion).mockRejectedValue(new Error("History already removed"));
    vi.mocked(RunningHubClient.prototype.getOutput).mockClear().mockImplementation(async file => new Blob([file.filename], { type: "image/png" }));
    await resumeTask(original.taskId);
    expect(task().status).toBe("completed"); expect(task().outputs).toHaveLength(2);
    expect(task().outputs[0]).toBe(original.downloadedOutputs![0].asset.id);
    expect(task().createdAt).toBe(original.createdAt);
    expect(task().runningHubTiming?.remoteFinishedAt).toBe(originalFinish);
    expect(task().runningHubTiming?.providerDurationSeconds).toBe(130);
    expect(task().runningHubTiming?.observeMs).toBe(original.runningHubTiming?.observeMs);
    expect(elapsedSeconds(task(), Date.now())).toBe(Math.floor((task().completedAt! - original.createdAt) / 1000));
    expect(task().completedAt! - originalFinish).toBe(60000);
    expect(RunningHubClient.prototype.getOutput).toHaveBeenCalledExactlyOnceWith(identifiedFiles[1], expect.any(AbortSignal), expect.any(Function));
    expect(RunningHubClient.prototype.connect).toHaveBeenCalledTimes(1);
    expect(RunningHubClient.prototype.waitForCompletion).toHaveBeenCalledTimes(1);
    expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
  });

  it("downloads two RH outputs together but imports and checkpoints them in their original order", async () => {
    const first = deferred<Blob>(), second = deferred<Blob>(), firstImport = deferred<void>(), allowImport = deferred<void>();
    vi.mocked(RunningHubClient.prototype.getOutput).mockImplementation(file => file.filename === "first.png" ? first.promise : second.promise);
    vi.mocked(importAsset).mockImplementation(async (blob, name) => {
      if (name === "first.png") { firstImport.resolve(); await allowImport.promise; }
      else {
        const persisted = (fixtures.records.get("project-library") as ProjectLibrary).project.project;
        expect(Object.values(persisted.tasks)[0].downloadedOutputs?.map(entry => entry.file.filename)).toEqual(["first.png"]);
      }
      return saveAsset(blob, name);
    });
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(RunningHubClient.prototype.getOutput).toHaveBeenCalledTimes(2));
    expect(vi.mocked(RunningHubClient.prototype.getOutput).mock.calls.map(call => call[0])).toEqual(identifiedFiles);
    second.resolve(new Blob(["second-ready-first"], { type: "image/png" }));
    await Promise.resolve(); await Promise.resolve();
    expect(importAsset).not.toHaveBeenCalled();
    first.resolve(new Blob(["first-ready-second"], { type: "image/png" }));
    await firstImport.promise;
    expect(importAsset).toHaveBeenCalledTimes(1);
    expect(task().status).toBe("saving");
    allowImport.resolve(); await pending;
    expect(task().status).toBe("completed");
    expect(task().outputs.map(id => useStore.getState().project.assets[id].name)).toEqual(["first.png", "second.png"]);
    expect(task().downloadedOutputs?.map(entry => entry.file.filename)).toEqual(["first.png", "second.png"]);
    expect(RunningHubClient.prototype.getOutput).toHaveBeenCalledTimes(2);
  });

  it("prefetches only missing or corrupt local results, deduplicating repeated output descriptors", async () => {
    const third = { ...files[1], filename: "third.png", url: "https://cdn.example/third.png" };
    const firstBlob = new Blob(["valid local result"], { type: "image/png" });
    const firstAsset: Asset = { id: "local-first", name: "first.png", kind: "image", mime: "image/png", size: firstBlob.size, createdAt: 1 };
    const corruptAsset: Asset = { ...firstAsset, id: "corrupt-second", name: "second.png", size: 999 };
    fixtures.blobs.set(firstAsset.id, firstBlob); fixtures.blobs.set(corruptAsset.id, new Blob(["truncated"]));
    const saved = interrupted();
    saved.remoteOutputs = [files[0], files[1], third, { ...third }];
    saved.runningHubTiming = { remoteFinishedAt: 1234, providerDurationSeconds: 130 };
    saved.downloadedOutputs = [{ file: files[0], asset: firstAsset }, { file: files[1], asset: corruptAsset }];
    useStore.getState().createTask(saved);
    useStore.getState().editProject(p => ({ ...p, assets: { [firstAsset.id]: firstAsset, [corruptAsset.id]: corruptAsset } }));
    await resumeTask(saved.taskId);
    expect(task().status).toBe("completed");
    expect(vi.mocked(RunningHubClient.prototype.getOutput).mock.calls.map(call => call[0])).toEqual([files[1], third]);
    expect(task().outputs[0]).toBe(firstAsset.id);
    expect(task().outputs.map(id => useStore.getState().project.assets[id].name)).toEqual(["first.png", "second.png", "third.png"]);
    expect(task().outputs).not.toContain(corruptAsset.id);
    expect(task().runningHubTiming).toMatchObject({ remoteFinishedAt: 1234, providerDurationSeconds: 130 });
    expect(RunningHubClient.prototype.waitForCompletion).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("measures overlapping downloads once and preserves the provider duration independently of the full elapsed clock", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(RunningHubClient.prototype.connect).mockImplementation(async () => { now += 1000; });
    vi.mocked(RunningHubClient.prototype.queuePrompt).mockImplementation(async () => { now += 2000; return "remote-task"; });
    vi.mocked(RunningHubClient.prototype.waitForCompletion).mockImplementation(async () => {
      now += 133000;
      return { ...history, runningHubTiming: { providerDurationSeconds: 130 } };
    });
    const first = deferred<Blob>(), second = deferred<Blob>(), bothStarted = deferred<void>();
    let started = 0;
    vi.mocked(RunningHubClient.prototype.getOutput).mockImplementation(file => {
      if (++started === 2) bothStarted.resolve();
      return file.filename === "first.png" ? first.promise : second.promise;
    });
    vi.mocked(importAsset).mockImplementation(async (blob, name) => { now += 2000; return saveAsset(blob, name); });
    const pending = generate("canvas", "node");
    await bothStarted.promise;
    const remoteFinishedAt = now;
    now += 5000; second.resolve(new Blob(["two"], { type: "image/png" }));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    now += 5000; first.resolve(new Blob(["one"], { type: "image/png" }));
    await pending;
    expect(task().status).toBe("completed");
    expect(task().runningHubTiming).toMatchObject({
      providerDurationSeconds: 130, remoteFinishedAt,
      prepareMs: 1000, submitMs: 2000, observeMs: 133000,
      downloadMs: 10000, importMs: 4000, checkpointMs: 0, downloadBytes: 6,
    });
    expect(elapsedSeconds(task(), now)).toBe(150);
    expect(task().completedAt! - task().createdAt).toBe(150000);
    expect(runningHubTimingDiagnostics(task(), now)).toMatchObject({ totalSeconds: 150, totalMs: 150000, providerDurationSeconds: 130 });
  });

  it("aborts both prefetched downloads promptly when their owning project disappears", async () => {
    const first = deferred<Blob>(), second = deferred<Blob>();
    const signals: AbortSignal[] = [];
    vi.mocked(RunningHubClient.prototype.getOutput).mockImplementation((file, signal) => {
      signals.push(signal!);
      return file.filename === "first.png" ? first.promise : second.promise;
    });
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    const replacement = { ...structuredClone(useStore.getState().project), id: "replacement-project", tasks: {}, assets: {}, history: [] };
    useStore.setState({ project: replacement });
    await pending;
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(useStore.getState().project).toEqual(replacement);
    expect(importAsset).not.toHaveBeenCalled();
    first.resolve(new Blob(["late-first"])); second.resolve(new Blob(["late-second"]));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(useStore.getState().project).toEqual(replacement);
    expect(RunningHubClient.prototype.cancel).not.toHaveBeenCalled();
  });

  it("preserves the task and original outputs when saving a downloaded asset fails", async () => {
    vi.mocked(importAsset).mockRejectedValueOnce(new Error("本机磁盘已满"));
    await generate("canvas", "node");
    const id = task().taskId;
    expect(task()).toMatchObject({ status: "interrupted", promptId: "remote-task", remoteOutputs: files, error: "本机磁盘已满" });
    await resumeTask(id);
    expect(task().status).toBe("completed"); expect(task().outputs).toHaveLength(2);
    expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
    expect(RunningHubClient.prototype.waitForCompletion).toHaveBeenCalledTimes(1);
  });

  it("shows download bytes separately from generation progress and clears the saving message when finished", async () => {
    const output = deferred<Blob>();
    vi.mocked(RunningHubClient.prototype.getOutput).mockImplementation((file, _signal, onProgress) => {
      if (file.filename === "first.png") {
        if (typeof onProgress === "function") onProgress(8 * 1024 * 1024, 64 * 1024 * 1024);
        return output.promise;
      }
      return Promise.resolve(new Blob(["second"], { type: "image/png" }));
    });
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(task()?.savingMessage).toBe("正在下载结果 8.0 / 64.0 MB"));
    expect(task().details).toContain("正在下载结果 8.0 / 64.0 MB");
    expect(task().progress).toBeUndefined();
    output.resolve(new Blob(["first"], { type: "image/png" }));
    await pending;
    expect(task()).toMatchObject({ status: "completed", savingMessage: undefined });
  });

  it("stops a pending result download locally and resumes the original RH outputs without remote cancellation", async () => {
    const output = deferred<Blob>();
    const signals: AbortSignal[] = [];
    vi.mocked(RunningHubClient.prototype.getOutput).mockImplementation((_file, signal) => {
      signals.push(signal!); return output.promise;
    });
    vi.mocked(RunningHubClient.prototype.cancel).mockRejectedValue(new Error("A completed RH task cannot be cancelled"));
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    await cancelTask(task().taskId);
    await pending;
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(task()).toMatchObject({ status: "interrupted", promptId: "remote-task", savingMessage: undefined });
    expect(task().remoteOutputs).toHaveLength(2);
    expect(importAsset).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.cancel).not.toHaveBeenCalled();
    expect(hasActiveTasks()).toBe(false);
    vi.mocked(RunningHubClient.prototype.getOutput).mockImplementation(async file => new Blob([file.filename], { type: "image/png" }));
    await resumeTask(task().taskId);
    expect(task().status).toBe("completed");
    expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
    expect(RunningHubClient.prototype.waitForCompletion).toHaveBeenCalledTimes(1);
    output.resolve(new Blob(["late"], { type: "image/png" }));
  });

  it("keeps a locally stopped task interrupted when an in-flight import returns late", async () => {
    const imported = deferred<Asset>();
    vi.mocked(importAsset).mockImplementationOnce(() => imported.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(task()?.savingMessage).toBe("正在写入本地结果"));
    await cancelTask(task().taskId);
    expect(task().status).toBe("interrupted");
    expect(hasActiveTasks()).toBe(false);
    const lateAsset = await saveAsset(new Blob(["late"], { type: "image/png" }), "first.png");
    imported.resolve(lateAsset);
    await pending;
    expect(task()).toMatchObject({ status: "interrupted", savingMessage: undefined, outputs: [] });
    expect(useStore.getState().project.assets).not.toHaveProperty(lateAsset.id);
    expect(useStore.getState().project.history).toHaveLength(0);
    expect(RunningHubClient.prototype.cancel).not.toHaveBeenCalled();
    await resumeTask(task().taskId);
    expect(task().status).toBe("completed");
    expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
  });

  it("treats an aborted output download as recoverable instead of pretending the remote task was cancelled", async () => {
    vi.mocked(RunningHubClient.prototype.getOutput).mockRejectedValueOnce(new DOMException("Download timeout", "AbortError"));
    await generate("canvas", "node");
    expect(task()).toMatchObject({ status: "interrupted", promptId: "remote-task", remoteOutputs: files, error: expect.stringContaining("已完成") });
    await resumeTask(task().taskId);
    expect(task().status).toBe("completed"); expect(RunningHubClient.prototype.cancel).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
  });

  it("queries an already accepted task without preflighting a changed input schema", async () => {
    const saved = interrupted(); useStore.getState().createTask(saved);
    vi.mocked(RunningHubClient.prototype.connect).mockRejectedValue(new ExecutionError("A newly edited input schema is unrelated to the old task"));
    await resumeTask(saved.taskId);
    expect(task().status).toBe("completed"); expect(RunningHubClient.prototype.connect).not.toHaveBeenCalled();
    expect(vi.mocked(RunningHubClient.prototype.waitForCompletion).mock.calls[0][0]).toBe(saved.promptId);
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("recovers a legacy accepted task without projectId by capturing its original project owner", async () => {
    const { projectId: _, ...legacy } = interrupted();
    useStore.getState().createTask(legacy);
    await resumeTask(legacy.taskId);
    expect(task()).toMatchObject({ status: "completed", promptId: legacy.promptId });
    expect(task().outputs).toHaveLength(2);
    expect(RunningHubClient.prototype.waitForCompletion).toHaveBeenCalledExactlyOnceWith(
      legacy.promptId, expect.any(Function), expect.any(AbortSignal), legacy.workflow.template,
    );
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("does not move a legacy task's captured owner when a different project reuses its IDs", async () => {
    const { projectId: _, ...legacy } = interrupted(); useStore.getState().createTask(legacy);
    const observed = deferred<History>();
    vi.mocked(RunningHubClient.prototype.waitForCompletion).mockReturnValue(observed.promise);
    const pending = resumeTask(legacy.taskId);
    await vi.waitFor(() => expect(RunningHubClient.prototype.waitForCompletion).toHaveBeenCalledTimes(1));
    const replacement = { ...structuredClone(useStore.getState().project), id: "another-project" };
    useStore.setState({ project: replacement });
    observed.resolve(history); await pending;
    expect(useStore.getState().project).toEqual(replacement);
    expect(RunningHubClient.prototype.getOutput).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("blocks execution when RunningHub preflight rejects the saved input contract", async () => {
    vi.mocked(RunningHubClient.prototype.connect).mockRejectedValue(new ExecutionError("公开输入结构已变化，请重新读取工作流。"));
    await generate("canvas", "node");
    expect(task()).toMatchObject({ status: "failed", error: expect.stringContaining("结构已变化") });
    expect(RunningHubClient.prototype.uploadAsset).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.waitForCompletion).not.toHaveBeenCalled();
  });

  it("admits only one submission for simultaneous clicks on the same node", async () => {
    const accepted = deferred<string>();
    vi.mocked(RunningHubClient.prototype.queuePrompt).mockReturnValue(accepted.promise);
    const first = generate("canvas", "node");
    await vi.waitFor(() => expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1));
    await generate("canvas", "node");
    expect(Object.keys(useStore.getState().project.tasks)).toHaveLength(1);
    accepted.resolve("remote-task"); await first;
    expect(task().status).toBe("completed"); expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
  });

  it("shares the active owner for simultaneous recovery requests", async () => {
    const saved = interrupted(); useStore.getState().createTask(saved);
    const observed = deferred<History>();
    vi.mocked(RunningHubClient.prototype.waitForCompletion).mockReturnValue(observed.promise);
    const first = resumeTask(saved.taskId);
    await vi.waitFor(() => expect(RunningHubClient.prototype.waitForCompletion).toHaveBeenCalledTimes(1));
    await resumeTask(saved.taskId);
    observed.resolve(history); await first;
    expect(task().status).toBe("completed"); expect(RunningHubClient.prototype.waitForCompletion).toHaveBeenCalledTimes(1);
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("keeps a canvas switch attached to the original canvas and node", async () => {
    const original = useStore.getState().project.canvases[0];
    useStore.getState().editProject(p => ({ ...p, canvases: [...p.canvases, { ...structuredClone(original), id: "visible" }] }));
    const observed = deferred<History>();
    vi.mocked(RunningHubClient.prototype.waitForCompletion).mockReturnValue(observed.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(RunningHubClient.prototype.waitForCompletion).toHaveBeenCalledTimes(1));
    useStore.getState().editProject(p => ({ ...p, activeCanvasId: "visible" }));
    observed.resolve(history); await pending;
    const project = useStore.getState().project;
    expect(project.activeCanvasId).toBe("visible"); expect(task().status).toBe("completed");
    expect(project.canvases[0].nodes[0].data.assetId).toBe(task().outputs[0]);
    expect(project.canvases[1].nodes[0].data.assetId).toBeUndefined();
  });

  it("ignores late progress and results after replacement with another project, including colliding task IDs", async () => {
    const observed = deferred<History>();
    let progress!: Parameters<RunningHubClient["waitForCompletion"]>[1];
    vi.mocked(RunningHubClient.prototype.waitForCompletion).mockImplementation((_id, update) => { progress = update; return observed.promise; });
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(progress).toBeTypeOf("function"));
    const replacement = structuredClone(useStore.getState().project); replacement.id = "different-project";
    for (const entry of Object.values(replacement.tasks)) entry.projectId = replacement.id;
    useStore.setState({ project: replacement, toast: "new project", runningHubConnectionState: "offline" });
    const expected = structuredClone(useStore.getState().project);
    progress({ status: "generating", execution: { nodeId: "late-node" } });
    observed.resolve(history); await pending;
    expect(useStore.getState().project).toEqual(expected);
    expect(useStore.getState().toast).toBe("new project"); expect(useStore.getState().runningHubConnectionState).toBe("offline");
    expect(RunningHubClient.prototype.getOutput).not.toHaveBeenCalled(); expect(importAsset).not.toHaveBeenCalled();
    expect(RunningHubClient.prototype.cancel).not.toHaveBeenCalled();
  });

  it("expires the old callback permanently when leaving and reopening the same saved project", async () => {
    const observed = deferred<History>();
    vi.mocked(RunningHubClient.prototype.waitForCompletion).mockReturnValue(observed.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(RunningHubClient.prototype.waitForCompletion).toHaveBeenCalledTimes(1));
    const reopened = structuredClone(useStore.getState().project);
    useStore.setState({ project: { ...structuredClone(reopened), id: "temporary-project" } });
    useStore.setState({ project: reopened });
    observed.resolve(history); await pending;
    expect(useStore.getState().project).toEqual(reopened);
    expect(RunningHubClient.prototype.getOutput).not.toHaveBeenCalled(); expect(importAsset).not.toHaveBeenCalled();
  });

  it("does not insert a late local asset into a replacement project", async () => {
    const imported = deferred<Asset>();
    vi.mocked(importAsset).mockReturnValueOnce(imported.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(importAsset).toHaveBeenCalledTimes(1));
    const replacement = { ...structuredClone(useStore.getState().project), id: "new-project", assets: {}, tasks: {}, history: [] };
    useStore.setState({ project: replacement });
    imported.resolve({ id: "late-asset", kind: "image", name: "late.png", mime: "image/png", size: 3, createdAt: 1 });
    await pending;
    expect(useStore.getState().project).toEqual(replacement);
  });

  it("keeps cancellation with an unknown submission interrupted and blocks duplicate submission", async () => {
    const accepted = deferred<string>();
    vi.mocked(RunningHubClient.prototype.queuePrompt).mockReturnValue(accepted.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1));
    const id = task().taskId;
    await cancelTask(id);
    expect(task()).toMatchObject({ status: "interrupted", promptId: null, error: expect.stringContaining("无法确认") });
    expect(vi.mocked(RunningHubClient.prototype.queuePrompt).mock.calls[0][2]?.aborted).toBe(true);
    accepted.reject(new DOMException("Response lost while cancelling", "AbortError")); await pending;
    expect(task()).toMatchObject({ status: "interrupted", promptId: null, error: expect.stringContaining("尚未确认") });
    await generate("canvas", "node"); await resumeTask(id);
    expect(task().status).toBe("interrupted"); expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
    expect(RunningHubClient.prototype.cancel).not.toHaveBeenCalled();
  });

  it("waits for the actual remote task ID and confirms its cancellation before claiming success", async () => {
    const accepted = deferred<string>();
    vi.mocked(RunningHubClient.prototype.queuePrompt).mockReturnValue(accepted.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1));
    await cancelTask(task().taskId);
    expect(task()).toMatchObject({ status: "interrupted", promptId: null });
    accepted.resolve("accepted-before-cancel"); await pending;
    expect(RunningHubClient.prototype.cancel).toHaveBeenCalledExactlyOnceWith("accepted-before-cancel");
    expect(task()).toMatchObject({ status: "cancelled", promptId: "accepted-before-cancel" });
    expect(RunningHubClient.prototype.waitForCompletion).not.toHaveBeenCalled();
  });

  it("retains the remote ID when cancellation itself cannot be confirmed", async () => {
    const accepted = deferred<string>();
    vi.mocked(RunningHubClient.prototype.queuePrompt).mockReturnValue(accepted.promise);
    vi.mocked(RunningHubClient.prototype.cancel).mockRejectedValue(new ApiError("RunningHub cancellation response unavailable", 503));
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(RunningHubClient.prototype.queuePrompt).toHaveBeenCalledTimes(1));
    await cancelTask(task().taskId);
    accepted.resolve("accepted-before-cancel"); await pending;
    expect(task()).toMatchObject({ status: "interrupted", promptId: "accepted-before-cancel" });
    expect(RunningHubClient.prototype.cancel).toHaveBeenCalledExactlyOnceWith("accepted-before-cancel");
  });

  it("deduplicates concurrent cancellation and ignores its response after a project replacement", async () => {
    const saved = interrupted(); useStore.getState().createTask(saved);
    const cancelled = deferred<void>(); vi.mocked(RunningHubClient.prototype.cancel).mockReturnValue(cancelled.promise);
    const first = cancelTask(saved.taskId);
    await vi.waitFor(() => expect(RunningHubClient.prototype.cancel).toHaveBeenCalledTimes(1));
    await cancelTask(saved.taskId);
    const replacement = structuredClone(useStore.getState().project); replacement.id = "new-project";
    replacement.tasks[saved.taskId].projectId = replacement.id;
    useStore.setState({ project: replacement });
    const expected = structuredClone(useStore.getState().project);
    cancelled.resolve(); await first;
    expect(useStore.getState().project).toEqual(expected); expect(RunningHubClient.prototype.cancel).toHaveBeenCalledTimes(1);
  });
});
