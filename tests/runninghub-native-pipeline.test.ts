import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection, GenerationTask, Project, WorkflowDefinition } from "../src/types";

const local = vi.hoisted(() => ({ records: new Map<string, unknown>() }));
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(local.records.get(key)),
  writeRecord: async (key: string, value: unknown) => { local.records.set(key, structuredClone(value)); },
  // Deliberately bypass the storage normalizer to test the pipeline's own boundary.
  safeConnection: (value: object) => value,
  getBlob: async () => new Blob(["image"], { type: "image/png" }), putBlob: async () => {},
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/assets/assets", () => ({ importAsset: async (blob: Blob) => ({ id: "result-asset", kind: blob.type.startsWith("video/") ? "video" : "image", name: blob.type.startsWith("video/") ? "result.mp4" : "result.png", mime: blob.type, size: blob.size, createdAt: 2 }) }));

import { ComfyUIClient } from "../src/comfyui/client";
import { cancelTask, generate, hasActiveTasks, resumeTask } from "../src/generation/pipeline";
import { createNode, useStore } from "../src/stores/store";
import { defaultConnection } from "../src/workflow/catalog";

const secret = "native-task-private-fixture-key";
const native: Connection = { ...defaultConnection, name: "RH native", baseUrl: "https://www.runninghub.cn/proxy", token: secret };
const cloud: Connection = { ...defaultConnection, baseUrl: "https://cloud.fixture/comfy", token: "cloud-private-fixture-key" };
const definition: WorkflowDefinition = {
  id: "native-workflow", name: "Native workflow", family: "Image", mode: "text-to-image", requiredInputs: [], optionalInputs: [], parameters: [],
  mapping: [{ semantic: "prompt", nodeId: "1", field: "prompt" }],
  template: { "1": { class_type: "GenerateImage", inputs: { prompt: "" } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "original" } } },
  output: { nodeId: "2", field: "images", kind: "image" },
};
const currentTask = () => Object.values(useStore.getState().project.tasks)[0];
function interrupted(connection = native, promptId: string | null = "accepted-task"): GenerationTask {
  const { token: _, ...endpoint } = connection;
  return { taskId: "saved-task", promptId, executorType: "comfyui", requestId: "saved-request", clientId: "saved-client", projectId: "project", canvasId: "canvas", nodeId: "node", nodeTitle: "生成", status: "interrupted", createdAt: 1, updatedAt: 1, connection: endpoint,
    workflow: structuredClone(definition), input: { prompt: "flower", negativePrompt: "", params: {}, assets: [] }, outputs: [] };
}
function pendingAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) return Promise.reject(new Error("Native task signal was not forwarded"));
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

beforeEach(() => {
  vi.restoreAllMocks(); local.records.clear();
  const node = createNode("image-generation", 1); node.id = "node";
  node.data.generation = { workflowId: definition.id, prompt: "flower", negativePrompt: "", params: {}, taskId: null };
  const project: Project = { version: 2, id: "project", name: "Native pipeline", activeCanvasId: "canvas", scenes: [{ id: "scene", name: "Scene" }], updatedAt: 1,
    canvases: [{ id: "canvas", name: "Canvas", sceneId: "scene", nodes: [node], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }], assets: {}, tasks: {}, history: [] };
  useStore.setState({ ready: false, projectOpen: true, navigating: false, projects: {}, past: [], future: [], toast: "", workflowCredentials: {},
    project, workflows: [structuredClone(definition)], runningHubWorkflows: [], computeProvider: "comfyui", connection: { ...native },
    comfyConnectionProfiles: { native: { ...native }, cloud: { ...cloud } }, connectionState: "offline" });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No real network or paid endpoint calls in pipeline tests"); }));
  vi.spyOn(ComfyUIClient.prototype, "connect").mockResolvedValue();
  vi.spyOn(ComfyUIClient.prototype, "disconnect").mockImplementation(() => {});
  vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockResolvedValue("accepted-task");
  vi.spyOn(ComfyUIClient.prototype, "findSubmittedPrompt").mockResolvedValue("recovered-task");
  vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockResolvedValue({ status: { completed: true }, outputs: { "2": { images: [{ filename: "result.png", type: "output" }] } } });
  vi.spyOn(ComfyUIClient.prototype, "getOutput").mockResolvedValue(new Blob(["image"], { type: "image/png" }));
  vi.spyOn(ComfyUIClient.prototype, "cancel").mockResolvedValue();
});
afterEach(() => { expect(hasActiveTasks()).toBe(false); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("native RunningHub tasks in the ComfyUI pipeline", () => {
  it.each([true, false])("recovers an accepted VHS task with an RH images video receipt only for native mode (native=%s)", async nativeEndpoint => {
    const task = interrupted(nativeEndpoint ? native : cloud);
    task.workflow.output = { nodeId: "4", field: "gifs", kind: "video" };
    task.workflow.template["4"] = { class_type: "VHS_VideoCombine", inputs: { images: ["1", 0] } };
    const before = structuredClone(task.workflow);
    useStore.getState().createTask(task);
    vi.mocked(ComfyUIClient.prototype.waitForCompletion).mockResolvedValue({ status: { status_str: "success" }, outputs: {
      "4": { images: [{ filename: "result.mp4", subfolder: "job", type: "output", bucket: "result", storageProvider: "tos", objectKey: "result-key" }] },
    } });
    vi.mocked(ComfyUIClient.prototype.getOutput).mockResolvedValue(new Blob(["video"], { type: "video/mp4" }));
    await resumeTask(task.taskId);
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(currentTask().workflow).toEqual(before);
    if (nativeEndpoint) {
      expect(currentTask().status).toBe("completed");
      expect(currentTask().remoteOutputs).toEqual([{ filename: "result.mp4", subfolder: "job", type: "output", sourceNodeId: "4", sourceField: "gifs" }]);
      expect(useStore.getState().project.assets["result-asset"].kind).toBe("video");
    } else {
      expect(currentTask().status).toBe("interrupted");
      expect(currentTask().error).toContain("4.gifs");
      expect(ComfyUIClient.prototype.getOutput).not.toHaveBeenCalled();
    }
  });
  it.each([true, false])("blocks retired native video generation and preserves ordinary cloud generation (native=%s)", async nativeEndpoint => {
    const workflow = structuredClone(definition);
    workflow.requiredInputs = ["video"];
    workflow.mapping.push({ semantic: "video", nodeId: "28", field: "video", pathMode: "comfy-input" });
    workflow.template["28"] = { class_type: "VHS_LoadVideoPath", inputs: { video: "authored.mp4", force_rate: 24, custom_width: 0, custom_height: 0 } };
    workflow.template["2"].inputs.images = ["28", 0];
    const project = structuredClone(useStore.getState().project);
    project.assets.clip = { id: "clip", kind: "video", name: "clip.mp4", mime: "video/mp4", size: 5, createdAt: 1 };
    project.canvases[0].nodes.push({ id: "source", position: { x: 0, y: 0 }, data: { kind: "video", title: "Clip", assetId: "clip" } });
    project.canvases[0].edges.push({ id: "video-edge", source: "source", target: "node", data: { role: "auto" } });
    useStore.setState({ project, workflows: [workflow], connection: { ...(nativeEndpoint ? native : cloud) } });
    vi.spyOn(ComfyUIClient.prototype, "uploadAsset").mockResolvedValue({ name: "server.mp4", subfolder: "job", inputName: "job/server.mp4", type: "input" });
    const schema = vi.spyOn(ComfyUIClient.prototype, "json").mockImplementation(async path => {
      const type = path.split("/").at(-1)!;
      // RH's native catalog exposes different generations of the two loaders.
      return { [type]: { input: { required: { video: ["STRING"], force_rate: [type.endsWith("Path") ? "FLOAT" : "INT"], custom_width: ["INT"], custom_height: ["INT"],
        ...(!type.endsWith("Path") ? { force_size: [["Disabled", "Custom Width", "Custom Height", "Custom"]] } : {}),
      } }, output: ["IMAGE", "INT", "AUDIO", "VHS_VIDEOINFO"] } };
    });
    await generate("canvas", "node");
    if (nativeEndpoint) {
      expect(currentTask()).toBeUndefined();
      expect(useStore.getState().project.canvases[0].nodes[0].data.generationFeedback?.error).toContain("入口已停用");
      expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
      expect(ComfyUIClient.prototype.uploadAsset).not.toHaveBeenCalled();
      expect(schema).not.toHaveBeenCalled();
      return;
    }
    expect(currentTask().status).toBe("completed");
    expect(vi.mocked(ComfyUIClient.prototype.queuePrompt).mock.calls[0][0]["28"]).toEqual({
      class_type: nativeEndpoint ? "VHS_LoadVideo" : "VHS_LoadVideoPath",
      inputs: { video: nativeEndpoint ? "job/server.mp4" : "input/job/server.mp4", force_rate: 24, custom_width: 0, custom_height: 0,
        ...(nativeEndpoint ? { force_size: "Disabled" } : {}),
      },
    });
    expect(schema).toHaveBeenCalledTimes(nativeEndpoint ? 2 : 0);
    expect(currentTask().workflow.template["28"]).toEqual(workflow.template["28"]);
  });
  it("rejects a pasted keyed native endpoint before creating a task or sending any request", async () => {
    useStore.setState({ connection: { ...native, baseUrl: native.baseUrl + "/" + secret, token: "" } });
    await generate("canvas", "node");
    expect(currentTask()).toBeUndefined();
    expect(useStore.getState().project.canvases[0].nodes[0].data.generationFeedback?.error).toContain("RunningHub ComfyUI 工作流");
    expect(ComfyUIClient.prototype.connect).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(JSON.stringify(useStore.getState().project)).not.toContain(secret);
    expect(JSON.stringify([...local.records])).not.toContain(secret);
  });
  it("recovers a native task using its saved profile after switching to the cloud and retains the original tier", async () => {
    useStore.getState().createTask(interrupted());
    useStore.setState({ connection: { ...cloud }, comfyConnectionProfiles: { cloud: { ...cloud }, native: { ...native, baseUrl: "https://www.runninghub.cn/proxy-plus" } }, connectionState: "offline" });
    let recoveredConnection: Connection | undefined;
    vi.mocked(ComfyUIClient.prototype.connect).mockImplementation(async function (this: ComfyUIClient) { recoveredConnection = this.connection; });
    await resumeTask("saved-task");
    expect(recoveredConnection).toMatchObject({ baseUrl: native.baseUrl, token: secret });
    expect(currentTask()).toMatchObject({ status: "completed", promptId: "accepted-task" });
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(useStore.getState().connection).toEqual(cloud);
    expect(useStore.getState().connectionState).toBe("offline");
  });
  it("also restores a cloud task from the cloud profile while the native profile is active", async () => {
    useStore.getState().createTask(interrupted(cloud));
    let recoveredConnection: Connection | undefined;
    vi.mocked(ComfyUIClient.prototype.connect).mockImplementation(async function (this: ComfyUIClient) { recoveredConnection = this.connection; });
    await resumeTask("saved-task");
    expect(recoveredConnection).toEqual(cloud);
    expect(ComfyUIClient.prototype.connect).toHaveBeenCalledWith();
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(currentTask().status).toBe("completed");
  });
  it("cancels an accepted native task during its recovery handshake without resubmission", async () => {
    useStore.getState().createTask(interrupted());
    vi.mocked(ComfyUIClient.prototype.connect).mockImplementation(signal => pendingAbort(signal));
    const pending = resumeTask("saved-task");
    await vi.waitFor(() => expect(ComfyUIClient.prototype.connect).toHaveBeenCalledOnce());
    await cancelTask(currentTask().taskId); await pending;
    expect(currentTask().status).toBe("cancelled");
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.cancel).toHaveBeenCalledOnce();
  });
  it("recovers an older uncertain native submission by request ID without creating a new task", async () => {
    useStore.getState().createTask(interrupted(native, null));
    await resumeTask("saved-task");
    expect(ComfyUIClient.prototype.findSubmittedPrompt).toHaveBeenCalledWith(currentTask().requestId, expect.any(AbortSignal));
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(currentTask()).toMatchObject({ status: "completed", promptId: "recovered-task" });
  });
  it("cancels recovery HTTP without resubmitting the task", async () => {
    useStore.getState().createTask(interrupted(native, null));
    vi.mocked(ComfyUIClient.prototype.findSubmittedPrompt).mockImplementation((_id, signal) => pendingAbort(signal));
    const pending = resumeTask("saved-task");
    await vi.waitFor(() => expect(ComfyUIClient.prototype.findSubmittedPrompt).toHaveBeenCalledOnce());
    await cancelTask("saved-task"); await pending;
    expect(currentTask().status).toBe("interrupted");
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });
  it.each(["https://www.runninghub.cn/proxy", "https://www.runninghub.cn/proxy-plus", "https://www.runninghub.cn/proxy-plus/pasted-fixture-key"])("rejects retired endpoint %s before account or generation requests", async baseUrl => {
    useStore.setState({ connection: { ...native, baseUrl, token: "" } });
    await generate("canvas", "node");
    expect(currentTask()).toBeUndefined();
    expect(useStore.getState().project.canvases[0].nodes[0].data.generationFeedback?.error).toContain("入口已停用");
    expect(ComfyUIClient.prototype.connect).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.waitForCompletion).not.toHaveBeenCalled();
  });
  it("stops native observation when its owning project changes without writing into the new project", async () => {
    useStore.getState().createTask(interrupted());
    vi.mocked(ComfyUIClient.prototype.waitForCompletion).mockImplementation((_id, _state, signal) => pendingAbort(signal));
    const pending = resumeTask("saved-task");
    await vi.waitFor(() => expect(ComfyUIClient.prototype.waitForCompletion).toHaveBeenCalledOnce());
    const original = useStore.getState().project;
    const replacement = { ...original, id: "other-project", tasks: {}, history: [] };
    useStore.setState({ project: replacement });
    await pending;
    expect(useStore.getState().project).toEqual(replacement);
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.getOutput).not.toHaveBeenCalled();
  });
});
