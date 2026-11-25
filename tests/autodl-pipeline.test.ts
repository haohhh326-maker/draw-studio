import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection, GenerationTask, Project, WorkflowDefinition } from "../src/types";

const fixture = vi.hoisted(() => ({ records: new Map<string, unknown>(), events: [] as string[], acquire: vi.fn() }));
vi.mock("../src/autodl/client", () => ({ autoDLTaskPower: fixture.acquire }));
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(fixture.records.get(key)),
  writeRecord: async (key: string, value: unknown) => { fixture.records.set(key, structuredClone(value)); },
  safeConnection: (connection: Record<string, unknown>) => ({ ...connection, token: "" }),
  getBlob: async () => new Blob(["input"], { type: "image/png" }), putBlob: async () => {},
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/assets/assets", () => ({ importAsset: async (blob: Blob, name: string) => {
  fixture.events.push("import");
  return { id: "generated", kind: blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : "image", name, mime: blob.type, size: blob.size, createdAt: 2 };
} }));

import { ApiError, ComfyUIClient, ExecutionError } from "../src/comfyui/client";
import { cancelTask, generate, hasActiveTasks, resumeTask } from "../src/generation/pipeline";
import { createNode, useStore, type ProjectLibrary } from "../src/stores/store";
import { defaultConnection } from "../src/workflow/catalog";

const cloud: Connection = { ...defaultConnection, baseUrl: "https://comfy.fixture.example", token: "comfy-only-private-token", autodl: { instanceUuid: "pro-fixture" } };
const workflow: WorkflowDefinition = {
  id: "autodl-workflow", name: "AutoDL fixture", family: "Tests", mode: "image-to-image", requiredInputs: ["image"], optionalInputs: [], parameters: [],
  mapping: [{ semantic: "prompt", nodeId: "1", field: "prompt" }, { semantic: "image", nodeId: "3", field: "image" }],
  template: { "1": { class_type: "GenerateImage", inputs: { prompt: "", reference: ["3", 0] } }, "3": { class_type: "LoadImage", inputs: { image: "" } },
    "9": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "original" } } },
  output: { nodeId: "9", field: "images", kind: "image" },
};
const currentTask = () => Object.values(useStore.getState().project.tasks)[0];
function savedTask(): GenerationTask {
  return Object.values((fixture.records.get("project-library") as ProjectLibrary).project.project.tasks)[0];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function pendingAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) throw new Error("Startup readiness request must carry the task signal");
  return new Promise((_resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}
let release: ReturnType<typeof vi.fn>;
let leaseAbort: AbortController;

beforeEach(() => {
  vi.restoreAllMocks(); fixture.records.clear(); fixture.events.length = 0; fixture.acquire.mockReset();
  leaseAbort = new AbortController();
  release = vi.fn(async () => { fixture.events.push("release"); });
  fixture.acquire.mockImplementation(async (_connection, options) => {
    fixture.events.push("acquire"); options.onStatus("正在启动 AutoDL 云端实例…");
    return { leaseId: "lease-fixture", signal: leaseAbort.signal, release };
  });
  const node = createNode("image-generation", 1); node.id = "node";
  node.data.generation = { workflowId: workflow.id, prompt: "flower", negativePrompt: "", params: {}, taskId: null, computeProvider: "comfyui" };
  const source = createNode("reference", 1); source.id = "source"; source.data.assetId = "input";
  const project: Project = { version: 2, id: "project", name: "AutoDL pipeline", activeCanvasId: "canvas", scenes: [{ id: "scene", name: "Scene" }], updatedAt: 1,
    canvases: [{ id: "canvas", name: "Canvas", sceneId: "scene", nodes: [node, source], edges: [{ id: "input-edge", source: "source", target: "node", data: { role: "image", order: 0 } }], viewport: { x: 0, y: 0, zoom: 1 } }],
    assets: { input: { id: "input", name: "input.png", kind: "image", mime: "image/png", size: 5, createdAt: 1 } }, tasks: {}, history: [] };
  useStore.setState({ ready: false, projectOpen: true, navigating: false, projects: {}, past: [], future: [], toast: "", workflowCredentials: {},
    project, workflows: [structuredClone(workflow)], runningHubWorkflows: [], computeProvider: "comfyui", connection: structuredClone(cloud),
    comfyConnectionProfiles: { native: { ...defaultConnection }, cloud: structuredClone(cloud) }, connectionState: "offline" });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No real AutoDL or ComfyUI network calls in this test"); }));
  vi.spyOn(ComfyUIClient.prototype, "json").mockImplementation(async path => {
    expect(path).toBe("/system_stats"); fixture.events.push("healthy"); return { system: { comfyui_version: "fixture" } };
  });
  vi.spyOn(ComfyUIClient.prototype, "connect").mockImplementation(async () => { fixture.events.push("connect"); });
  vi.spyOn(ComfyUIClient.prototype, "disconnect").mockImplementation(() => {});
  vi.spyOn(ComfyUIClient.prototype, "uploadAsset").mockImplementation(async (_blob, _name, subfolder) => {
    fixture.events.push("upload"); return { name: "uploaded.png", subfolder, inputName: subfolder + "/uploaded.png", type: "input" };
  });
  vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockImplementation(async () => { fixture.events.push("submit"); return "accepted-prompt"; });
  vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockImplementation(async () => {
    fixture.events.push("complete"); return { status: { completed: true }, outputs: { "9": { images: [{ filename: "result.png", type: "output" }] } } };
  });
  vi.spyOn(ComfyUIClient.prototype, "getOutput").mockImplementation(async () => { fixture.events.push("download"); return new Blob(["image"], { type: "image/png" }); });
  vi.spyOn(ComfyUIClient.prototype, "cancel").mockResolvedValue();
});
afterEach(() => { expect(hasActiveTasks()).toBe(false); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("AutoDL instance leases around canvas generation", () => {
  it("waits for power and ComfyUI readiness before connecting or uploading, then releases after durable result completion", async () => {
    const powered = deferred<{ leaseId: string; signal: AbortSignal; release: () => Promise<void> }>();
    const healthy = deferred<{ system: object }>();
    fixture.acquire.mockImplementation(async () => { fixture.events.push("acquire"); return powered.promise; });
    vi.mocked(ComfyUIClient.prototype.json).mockImplementation(async () => { fixture.events.push("health-request"); return healthy.promise; });
    release.mockImplementation(async () => {
      expect(savedTask().status).toBe("completed");
      expect(savedTask().outputs).toEqual(["generated"]);
      fixture.events.push("release");
    });
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(fixture.acquire).toHaveBeenCalledOnce());
    expect(savedTask().connection).toMatchObject({ baseUrl: cloud.baseUrl, autodl: { instanceUuid: "pro-fixture" } });
    expect(JSON.stringify(savedTask())).not.toContain(cloud.token);
    expect(ComfyUIClient.prototype.json).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.connect).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.uploadAsset).not.toHaveBeenCalled();
    powered.resolve({ leaseId: "lease-fixture", signal: leaseAbort.signal, release });
    await vi.waitFor(() => expect(ComfyUIClient.prototype.json).toHaveBeenCalledOnce());
    expect(currentTask().details).toContain("等待 ComfyUI");
    expect(ComfyUIClient.prototype.uploadAsset).not.toHaveBeenCalled();
    healthy.resolve({ system: {} });
    await pending;
    expect(currentTask().status).toBe("completed");
    expect(fixture.events).toEqual(["acquire", "health-request", "connect", "upload", "submit", "complete", "download", "import", "release"]);
    expect(release).toHaveBeenCalledWith();
  });

  it("retries service readiness after the platform is running without uploading too early", async () => {
    vi.mocked(ComfyUIClient.prototype.json).mockRejectedValueOnce(new TypeError("Service is still booting"));
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(ComfyUIClient.prototype.json).toHaveBeenCalledOnce());
    expect(ComfyUIClient.prototype.connect).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.uploadAsset).not.toHaveBeenCalled();
    await pending;
    expect(ComfyUIClient.prototype.json).toHaveBeenCalledTimes(2);
    expect(currentTask().status).toBe("completed");
    expect(release).toHaveBeenCalledOnce();
  });

  it("cancels a readiness wait, never submits, and releases independently of the aborted signal", async () => {
    vi.mocked(ComfyUIClient.prototype.json).mockImplementation(async (_path, init) => pendingAbort(init?.signal ?? undefined));
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(ComfyUIClient.prototype.json).toHaveBeenCalledOnce());
    const acquisitionSignal = fixture.acquire.mock.calls[0][1].signal as AbortSignal;
    await cancelTask(currentTask().taskId);
    await pending;
    expect(acquisitionSignal.aborted).toBe(true);
    expect(currentTask().status).toBe("cancelled");
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith();
  });

  it("releases the original lease on project replacement without patching the replacement project", async () => {
    vi.mocked(ComfyUIClient.prototype.json).mockImplementation(async (_path, init) => pendingAbort(init?.signal ?? undefined));
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(ComfyUIClient.prototype.json).toHaveBeenCalledOnce());
    const replacement = { ...structuredClone(useStore.getState().project), id: "replacement", tasks: {} };
    useStore.setState({ project: replacement });
    await pending;
    expect(useStore.getState().project.id).toBe("replacement");
    expect(useStore.getState().project.tasks).toEqual({});
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not submit when ComfyUI authentication fails and still releases the acquired instance", async () => {
    vi.mocked(ComfyUIClient.prototype.json).mockRejectedValue(new ApiError("Unauthorized", 401));
    await generate("canvas", "node");
    expect(currentTask()).toMatchObject({ status: "failed", error: expect.stringContaining("ComfyUI 服务鉴权失败") });
    expect(ComfyUIClient.prototype.uploadAsset).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases when remote execution fails, preserving the original generation error", async () => {
    vi.mocked(ComfyUIClient.prototype.waitForCompletion).mockRejectedValue(new ExecutionError("Original workflow error"));
    await generate("canvas", "node");
    expect(currentTask()).toMatchObject({ status: "failed", error: "Original workflow error" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps a successful saved result when automatic shutdown needs recovery", async () => {
    release.mockRejectedValue(new Error("Shutdown not confirmed"));
    await generate("canvas", "node");
    expect(currentTask().status).toBe("completed");
    expect(savedTask().status).toBe("completed");
    expect(currentTask().outputs).toEqual(["generated"]);
    expect(useStore.getState().toast).toContain("AutoDL 自动关机未确认");
    expect(useStore.getState().toast).toContain("Shutdown not confirmed");
  });

  it.each(["video", "audio"] as const)("keeps the instance leased until the %s result has been downloaded and saved", async kind => {
    const output = kind === "video" ? { field: "gifs", filename: "result.mp4", mime: "video/mp4" } : { field: "audio", filename: "result.wav", mime: "audio/wav" };
    const definition = { ...structuredClone(workflow), output: { nodeId: "9", field: output.field, kind } };
    useStore.setState({ workflows: [definition], project: { ...useStore.getState().project, canvases: useStore.getState().project.canvases.map(canvas => ({
      ...canvas, nodes: canvas.nodes.map(node => node.id === "node" ? { ...node, data: { ...node.data, kind } } : node),
    })) } });
    vi.mocked(ComfyUIClient.prototype.waitForCompletion).mockResolvedValue({ status: { completed: true }, outputs: { "9": { [output.field]: [{ filename: output.filename, type: "output" }] } } });
    vi.mocked(ComfyUIClient.prototype.getOutput).mockResolvedValue(new Blob([kind], { type: output.mime }));
    release.mockImplementation(async () => { expect(savedTask().status).toBe("completed"); expect(savedTask().outputs).toEqual(["generated"]); });
    await generate("canvas", "node");
    expect(currentTask().status).toBe("completed");
    expect(useStore.getState().project.assets.generated.kind).toBe(kind);
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not contact ComfyUI or submit if automatic startup fails", async () => {
    fixture.acquire.mockRejectedValue(new Error("AutoDL startup unavailable"));
    await generate("canvas", "node");
    expect(currentTask()).toMatchObject({ status: "failed", error: "AutoDL startup unavailable" });
    expect(ComfyUIClient.prototype.json).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.connect).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.uploadAsset).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    // An acquisition that does not return a lease owns its own cleanup in the client.
    expect(release).not.toHaveBeenCalled();
  });

  it("recovers the task's original AutoDL binding with a fresh attempt identity", async () => {
    await generate("canvas", "node");
    const first = currentTask();
    const firstAttempt = fixture.acquire.mock.calls[0][1].attemptId;
    useStore.getState().patchTask(first.taskId, { status: "interrupted" });
    useStore.setState({ connection: { ...cloud, autodl: { instanceUuid: "pro-other" } } });
    await resumeTask(first.taskId);
    expect(fixture.acquire).toHaveBeenCalledTimes(2);
    expect(fixture.acquire.mock.calls[1][0].autodl).toEqual({ instanceUuid: "pro-fixture" });
    expect(fixture.acquire.mock.calls[1][1]).toMatchObject({ taskId: first.taskId, attemptId: expect.any(String) });
    expect(fixture.acquire.mock.calls[1][1].attemptId).not.toBe(firstAttempt);
    expect(fixture.acquire.mock.calls[1][1].attemptId).not.toBe(first.requestId);
    expect(currentTask().status).toBe("completed");
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("does not add any AutoDL or startup polling request to an ordinary ComfyUI connection", async () => {
    useStore.setState({ connection: { ...cloud, autodl: undefined } });
    await generate("canvas", "node");
    expect(currentTask().status).toBe("completed");
    expect(fixture.acquire).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.json).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("routes a legacy unmarked AutoDL card through power and readiness before making a ComfyUI request", async () => {
    const endpoint = "https://u42-abcd1234.westd.seetacloud.com:8443";
    useStore.setState({ connection: { ...cloud, baseUrl: endpoint, autodl: undefined } });
    await generate("canvas", "node");
    expect(fixture.acquire).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: endpoint }), expect.any(Object));
    expect(fixture.events).toEqual(["acquire", "healthy", "connect", "upload", "submit", "complete", "download", "import", "release"]);
    expect(currentTask().status).toBe("completed");
  });

  it.each(["health", "connect", "upload", "submit", "wait", "download"] as const)("halts the %s operation when the lease is lost without treating it as user cancellation", async stage => {
    const reached = vi.fn();
    if (stage === "health") vi.mocked(ComfyUIClient.prototype.json).mockImplementation(async (_path, init) => { reached(); return pendingAbort(init?.signal ?? undefined); });
    if (stage === "connect") vi.mocked(ComfyUIClient.prototype.connect).mockImplementation(async signal => {
      expect(signal).toBeInstanceOf(AbortSignal); reached();
      // The normal ComfyUI socket handshake can ignore its signal. The pipeline must stop waiting and disconnect it.
      return new Promise<void>(() => {});
    });
    if (stage === "upload") vi.mocked(ComfyUIClient.prototype.uploadAsset).mockImplementation(async (_blob, _name, _directory, signal) => { reached(); return pendingAbort(signal); });
    if (stage === "submit") vi.mocked(ComfyUIClient.prototype.queuePrompt).mockImplementation(async (_workflow, _request, signal) => { reached(); return pendingAbort(signal); });
    if (stage === "wait") vi.mocked(ComfyUIClient.prototype.waitForCompletion).mockImplementation(async (_id, _update, signal) => { reached(); return pendingAbort(signal); });
    if (stage === "download") vi.mocked(ComfyUIClient.prototype.getOutput).mockImplementation(async (_file, signal) => { reached(); return pendingAbort(signal); });
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(reached).toHaveBeenCalledOnce());
    leaseAbort.abort(new Error("AutoDL task lease was revoked"));
    await pending;
    expect(currentTask()).toMatchObject({ status: ["submit", "wait", "download"].includes(stage) ? "interrupted" : "failed", error: "AutoDL task lease was revoked" });
    expect(fixture.acquire.mock.calls[0][1].signal.aborted).toBe(false);
    expect(ComfyUIClient.prototype.cancel).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith();
    if (stage === "connect") expect(ComfyUIClient.prototype.disconnect).toHaveBeenCalled();
    if (["health", "connect", "upload"].includes(stage)) expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });

  it("persists a late accepted prompt after lease loss and stops before observing it", async () => {
    const accepted = deferred<string>();
    vi.mocked(ComfyUIClient.prototype.queuePrompt).mockReturnValue(accepted.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledOnce());
    leaseAbort.abort(new Error("AutoDL lease expired before submit response"));
    accepted.resolve("late-accepted-prompt");
    await pending;
    expect(currentTask()).toMatchObject({ status: "interrupted", promptId: "late-accepted-prompt", error: "AutoDL lease expired before submit response" });
    expect(savedTask().promptId).toBe("late-accepted-prompt");
    expect(ComfyUIClient.prototype.waitForCompletion).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.cancel).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("retains completed results if the lease ends after their final checkpoint", async () => {
    release.mockImplementation(async () => {
      expect(savedTask().status).toBe("completed");
      leaseAbort.abort(new Error("Lease ended after saved result"));
    });
    await generate("canvas", "node");
    expect(currentTask()).toMatchObject({ status: "completed", outputs: ["generated"] });
    expect(savedTask().status).toBe("completed");
    expect(currentTask().error).toBeUndefined();
  });
});
