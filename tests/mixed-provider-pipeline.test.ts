import { afterEach, expect, it, vi } from "vitest";
import type { Asset, Canvas, ComputeProvider, GenerationTask, Project, WorkflowDefinition } from "../src/types";
import type { History } from "../src/comfyui/client";
import type { MuseJob, MuseJobRequest } from "../src/muse/client";

const fixture = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  blobs: new Map<string, Blob>(),
  power: vi.fn(),
  museCreate: vi.fn(),
  museGet: vi.fn(),
  museResume: vi.fn(),
  museOutput: vi.fn(),
  museUpload: vi.fn(),
  museCancel: vi.fn(),
}));
vi.mock("../src/projects/storage", async importOriginal => ({
  ...await importOriginal<typeof import("../src/projects/storage")>(),
  readRecord: async (key: string) => structuredClone(fixture.records.get(key)),
  writeRecord: async (key: string, value: unknown) => { fixture.records.set(key, structuredClone(value)); },
  getBlob: async (id: string) => {
    const blob = fixture.blobs.get(id);
    if (!blob) throw new Error("Missing isolated test asset");
    return blob;
  },
  putBlob: async (id: string, blob: Blob) => { fixture.blobs.set(id, blob); },
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/autodl/client", () => ({ autoDLTaskPower: fixture.power }));
vi.mock("../src/muse/client", () => ({
  createMuseJob: fixture.museCreate, getMuseJob: fixture.museGet, resumeMuseJob: fixture.museResume,
  getMuseOutput: fixture.museOutput, uploadMuseReference: fixture.museUpload, cancelMuseJob: fixture.museCancel,
}));

import { ComfyUIClient } from "../src/comfyui/client";
import { defaultRunningHubConnections } from "../src/compute/providers";
import { cancelTask, generate, hasActiveTasks, resumeTask } from "../src/generation/pipeline";
import { museWorkflows } from "../src/muse/catalog";
import { RunningHubClient } from "../src/runninghub/client";
import { attachRunningHubExecutionContract } from "../src/runninghub/execution-contract";
import { prepareRunningHubApp, prepareRunningHubWorkflow, runningHubAppOutputNode } from "../src/runninghub/workflows";
import { createNode, useStore, type ProjectLibrary } from "../src/stores/store";
import { defaultConnection } from "../src/workflow/catalog";
import { withRunningHubAppReader, withRunningHubWorkflowReader } from "./runninghub-test-reader";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const remoteId = "2110000000000000420";
const acceptedId = "same-upstream-id";
const cloud = { ...defaultConnection, baseUrl: "https://autodl.fixture.invalid", token: "cloud-fixture-secret", autodl: { instanceUuid: "pro-fixture" } };
const local = { ...defaultConnection, baseUrl: "http://127.0.0.1:8188", token: "local-fixture-secret" };
const cn = { ...defaultRunningHubConnections.cn, token: "cn-fixture-secret" };
const ai = { ...defaultRunningHubConnections.ai, token: "ai-fixture-secret" };
const graph = {
  "1": { class_type: "FixtureGenerator", inputs: { prompt: "" } },
  "9": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "authored" } },
};
const cloudWorkflow: WorkflowDefinition = {
  id: "cloud-image", name: "Cloud image", family: "Test", description: "Fixture", mode: "text-to-image", requiredInputs: [], optionalInputs: [], parameters: [],
  mapping: [{ semantic: "prompt", nodeId: "1", field: "prompt" }], template: graph,
  output: { nodeId: "9", field: "images", kind: "image" },
};
const localWorkflow: WorkflowDefinition = {
  ...cloudWorkflow, id: "local-video", name: "Local video", mode: "text-to-video",
  template: { ...graph, "9": { class_type: "VHS_VideoCombine", inputs: { images: ["1", 0], filename_prefix: "authored" } } },
  output: { nodeId: "9", field: "videos", kind: "video" },
};
const museWorkflow = museWorkflows.find(workflow => workflow.muse?.kind === "video")!;
const projectId = "mixed-provider-project";
const taskIn = (canvasId: string) => Object.values(useStore.getState().project.tasks).find(task => task.canvasId === canvasId)!;
const savedProject = () => {
  const library = fixture.records.get("project-library") as ProjectLibrary | undefined;
  const project = library?.[projectId]?.project;
  if (!project) throw new Error("Missing durable test project");
  return project;
};
const clientConnection = (context: unknown) => (context as ComfyUIClient).connection;

function media(id: string, kind: "image" | "video" | "audio"): Asset {
  const [extension, mime] = { image: ["png", "image/png"], video: ["mp4", "video/mp4"], audio: ["wav", "audio/wav"] }[kind];
  const blob = new Blob([id], { type: mime });
  fixture.blobs.set(id, blob);
  return { id, name: id + "." + extension, kind, mime, size: blob.size, createdAt: 1 };
}

function pane(id: string, provider: ComputeProvider, workflow: WorkflowDefinition, inputs: Asset[] = []): Canvas {
  const node = createNode(workflow.output.kind === "video" ? "video" : "image-generation", 1);
  // Deliberately identical node and edge IDs in separate canvases.
  node.id = "node";
  node.data.generation = { workflowId: workflow.id, prompt: "prompt-" + id, negativePrompt: "", params: {}, taskId: null, computeProvider: provider };
  const sources = inputs.map((asset, index) => {
    const reference = createNode("reference", index + 1);
    reference.id = "reference-" + index;
    reference.data.assetId = asset.id;
    return reference;
  });
  return { id, name: id, sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node, ...sources],
    edges: sources.map((source, order) => ({ id: "edge-" + order, source: source.id, target: node.id, data: { role: "auto", order } })) };
}

function receipt(field: "images" | "videos" | "files", extension: "png" | "mp4", nodeId = "9"): History {
  return { status: { completed: true }, outputs: { [nodeId]: { [field]: [
    { filename: "same-result." + extension, type: "output", subfolder: "", url: "https://cdn.fixture.invalid/same-result." + extension },
  ] } } };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("keeps five overlapping provider tasks isolated through a canvas switch, cancellation and retry", async () => {
  fixture.records.clear();
  fixture.blobs.clear();
  for (const mock of [fixture.power, fixture.museCreate, fixture.museGet, fixture.museResume, fixture.museOutput, fixture.museUpload, fixture.museCancel]) mock.mockReset();
  const network = vi.fn(async () => { throw new Error("Unexpected real network in the mixed provider test"); });
  vi.stubGlobal("fetch", network);
  const options = { baseUrl: cn.baseUrl, workflowId: remoteId, name: "CN workflow", promptKey: "1.prompt", outputs: [cloudWorkflow.output] };
  const rhWorkflow = await attachRunningHubExecutionContract(prepareRunningHubWorkflow(graph, await withRunningHubWorkflowReader(graph, options)).workflow);
  const app = await withRunningHubAppReader({ apiVersion: "v2", name: "AI app", nodeInfoList: [
    { nodeId: "2", fieldName: "prompt", fieldValue: "sample", fieldType: "STRING" },
  ] });
  const rhApp = await attachRunningHubExecutionContract(prepareRunningHubApp(app, {
    baseUrl: ai.baseUrl, workflowId: remoteId, name: "AI app", promptKey: "2.prompt",
    outputs: [{ nodeId: runningHubAppOutputNode, field: "files", kind: "image" }],
  }).workflow, app);
  const inputs = [media("image-source", "image"), media("video-source", "video"), media("audio-source", "audio")];
  const project: Project = {
    version: 2, id: projectId, name: "Mixed provider test", updatedAt: 1, activeCanvasId: "cloud",
    scenes: [{ id: "scene", name: "Scene" }], tasks: {}, history: [], assets: Object.fromEntries(inputs.map(asset => [asset.id, asset])),
    canvases: [
      pane("cloud", "comfyui", cloudWorkflow), pane("local", "comfyui", localWorkflow), pane("cn", "runninghub-workflow", rhWorkflow),
      pane("ai", "runninghub", rhApp), pane("muse", "muse", museWorkflow, inputs),
    ],
  };
  useStore.setState({ project, projects: {}, projectOpen: true, navigating: false, ready: false, workflowCredentials: {},
    computeProvider: "comfyui", workflows: [cloudWorkflow, localWorkflow], runningHubWorkflows: [rhWorkflow, rhApp],
    connection: cloud, comfyConnectionProfiles: { cloud, native: defaultConnection }, runningHubConnection: ai, runningHubConnections: { cn, ai } });
  const results = new Map([cloud, local, cn, ai].map(connection => [connection.baseUrl, deferred<History>()]));
  const museResult = deferred<Omit<MuseJob, "id">>();
  const leaseReady = deferred<void>();
  let statusAtLeaseRelease: GenerationTask["status"] | undefined;
  const release = vi.fn(async () => { statusAtLeaseRelease = savedProject().tasks[taskIn("cloud").taskId]?.status; });
  fixture.power.mockImplementation(async () => {
    await leaseReady.promise;
    return { leaseId: "fixture-lease", signal: new AbortController().signal, release };
  });
  vi.spyOn(ComfyUIClient.prototype, "connect").mockResolvedValue();
  vi.spyOn(RunningHubClient.prototype, "connect").mockResolvedValue();
  const healthy = vi.spyOn(ComfyUIClient.prototype, "json").mockResolvedValue({ system: {} });
  const submit = vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockResolvedValue(acceptedId);
  const submitRH = vi.spyOn(RunningHubClient.prototype, "queuePrompt").mockResolvedValue(acceptedId);
  const observe = vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockImplementation(function (this: ComfyUIClient) {
    return results.get(this.connection.baseUrl)!.promise;
  });
  const observeRH = vi.spyOn(RunningHubClient.prototype, "waitForCompletion").mockImplementation(function (this: RunningHubClient) {
    return results.get(this.connection.baseUrl)!.promise;
  });
  const cancel = vi.spyOn(RunningHubClient.prototype, "cancel").mockResolvedValue();
  const download = vi.spyOn(ComfyUIClient.prototype, "getOutput").mockImplementation(async function (this: ComfyUIClient) {
    return new Blob([this.connection.baseUrl], { type: this.connection.baseUrl === local.baseUrl ? "video/mp4" : "image/png" });
  });
  const downloadRH = vi.spyOn(RunningHubClient.prototype, "getOutput").mockImplementation(async function (this: RunningHubClient) {
    return new Blob([this.connection.baseUrl], { type: "image/png" });
  });
  fixture.museCreate.mockImplementation(async (request: MuseJobRequest) => ({ ...await museResult.promise, id: request.id }));
  fixture.museUpload.mockImplementation(async (_id, blob: Blob, name: string) => ({ name, mime: blob.type, uploadId: name }));
  fixture.museOutput.mockResolvedValue(new Blob(["muse-result"], { type: "video/mp4" }));
  const pending = [generate("cloud", "node")];
  try {
    await vi.waitFor(() => expect(fixture.power).toHaveBeenCalledOnce(), { timeout: 3000 });
    useStore.setState({ connection: local, comfyConnectionProfiles: { cloud: local, native: defaultConnection } });
    pending.push(...["local", "cn", "ai", "muse"].flatMap(id => [generate(id, "node"), generate(id, "node")]));
    await vi.waitFor(() => {
      expect(observe).toHaveBeenCalledTimes(1);
      expect(observeRH).toHaveBeenCalledTimes(2);
      expect(fixture.museCreate).toHaveBeenCalledOnce();
    }, { timeout: 5000 });
    useStore.setState(state => ({ computeProvider: "muse", project: { ...state.project, activeCanvasId: "muse" } }));
    const cancelling = taskIn("ai");
    await cancelTask(cancelling.taskId);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(acceptedId);
    expect(clientConnection(cancel.mock.contexts[0])).toMatchObject({ baseUrl: ai.baseUrl, token: ai.token });
    const observeAI = observeRH.mock.contexts.findIndex(context => clientConnection(context).baseUrl === ai.baseUrl);
    expect(observeAI).toBeGreaterThanOrEqual(0);
    observeRH.mock.calls[observeAI][1]({ status: "generating", progress: 99 });
    results.get(ai.baseUrl)!.resolve(receipt("files", "png", runningHubAppOutputNode));
    results.get(local.baseUrl)!.resolve(receipt("videos", "mp4"));
    results.get(cn.baseUrl)!.reject(new TypeError("Fake receipt connection dropped"));
    const museRequest = fixture.museCreate.mock.calls[0][0] as MuseJobRequest;
    expect(museRequest).toMatchObject({ id: taskIn("muse").taskId, kind: "video", prompt: "prompt-muse",
      references: inputs.map(asset => ({ name: asset.name, mime: asset.mime, uploadId: asset.name })) });
    museResult.resolve({ status: "completed", outputs: [
      { id: "media", name: "same-result.mp4", mime: "video/mp4", url: "/fixture/muse/media" },
    ] });
    await vi.waitFor(() => expect(taskIn("cn")?.status).toBe("interrupted"), { timeout: 3000 });
    const reopened = deferred<History>();
    results.set(cn.baseUrl, reopened);
    useStore.setState({ runningHubConnections: { cn: { ...cn, token: "cn-rotated-fixture-secret" }, ai } });
    // Let the prior observer finish before reattaching to the accepted job.
    await Promise.all(pending.slice(1));
    pending.push(resumeTask(taskIn("cn").taskId));
    reopened.resolve(receipt("images", "png"));
    leaseReady.resolve();
    results.get(cloud.baseUrl)!.resolve(receipt("images", "png"));
    await Promise.all(pending);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submitRH).toHaveBeenCalledTimes(2);
    expect(observeRH.mock.contexts.map(clientConnection).filter(connection => connection.baseUrl === cn.baseUrl).map(connection => connection.token))
      .toEqual([cn.token, "cn-rotated-fixture-secret"]);
    expect(observeRH.mock.calls.every(([id]) => id === acceptedId)).toBe(true);
    expect(downloadRH.mock.contexts.map(clientConnection).map(connection => connection.baseUrl)).toEqual([cn.baseUrl]);
    expect(download.mock.contexts.map(clientConnection).map(connection => connection.baseUrl)).toEqual([local.baseUrl, cloud.baseUrl]);
    expect(healthy.mock.contexts.map(clientConnection).map(connection => connection.baseUrl)).toEqual([cloud.baseUrl]);
    const routes = [{ canvas: "cloud", endpoint: cloud }, { canvas: "local", endpoint: local },
      { canvas: "cn", endpoint: cn }, { canvas: "ai", endpoint: ai }];
    for (const queue of [submit, submitRH]) {
      for (const [index, [submitted]] of queue.mock.calls.entries()) {
        const connection = clientConnection(queue.mock.contexts[index]);
        const route = routes.find(({ endpoint }) => endpoint.baseUrl === connection.baseUrl);
        if (!route) throw new Error("Unexpected fixture provider: " + connection.baseUrl);
        expect(connection.token, connection.baseUrl).toBe(route.endpoint.token);
        expect(submitted[route.canvas === "ai" ? "2" : "1"].inputs.prompt).toBe("prompt-" + route.canvas);
      }
    }
    const saved = savedProject();
    expect(saved.canvases).toHaveLength(5);
    expect(saved.history).toHaveLength(4);
    const assetIds = new Set<string>();
    for (const [canvasId, kind, content] of [
      ["cloud", "image", cloud.baseUrl], ["local", "video", local.baseUrl], ["cn", "image", cn.baseUrl], ["muse", "video", "muse-result"],
    ]) {
      const completed: GenerationTask = saved.tasks[taskIn(canvasId).taskId];
      const original = saved.canvases.find(canvas => canvas.id === canvasId)!.nodes[0];
      expect(completed).toMatchObject({ canvasId, nodeId: original.id, status: "completed" });
      expect(original.data.assetId).toBe(completed.outputs[0]);
      expect(saved.assets[completed.outputs[0]].kind).toBe(kind);
      expect(await fixture.blobs.get(completed.outputs[0])?.text()).toBe(content);
      expect(saved.history.find(item => item.id === completed.taskId)).toMatchObject({ canvasId, outputs: completed.outputs });
      assetIds.add(completed.outputs[0]);
    }
    expect(assetIds.size).toBe(4);
    expect(saved.tasks[cancelling.taskId]).toMatchObject({ status: "cancelled", promptId: acceptedId, outputs: [] });
    expect(saved.canvases.find(canvas => canvas.id === "ai")!.nodes[0].data.assetId).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain("-fixture-secret");
    expect(release).toHaveBeenCalledOnce();
    expect(statusAtLeaseRelease).toBe("completed");
    expect(hasActiveTasks()).toBe(false);
    expect(network).not.toHaveBeenCalled();
  } finally {
    leaseReady.resolve();
    for (const [endpoint, gate] of results) gate.resolve(endpoint === local.baseUrl ? receipt("videos", "mp4") : receipt("images", "png"));
    museResult.resolve({ status: "failed" });
    await Promise.allSettled(pending);
  }
}, 20_000);
