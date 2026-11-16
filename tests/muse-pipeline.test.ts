import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, GenerationTask, Project, WorkflowDefinition } from "../src/types";

const fixtures = vi.hoisted(() => ({
  records: new Map<string, unknown>(), blobs: new Map<string, Blob>(),
  create: vi.fn(), get: vi.fn(), resume: vi.fn(), output: vi.fn(), upload: vi.fn(), cancel: vi.fn(),
  beforeWrite: undefined as undefined | ((key: string) => void | Promise<void>),
}));
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(fixtures.records.get(key)),
  writeRecord: async (key: string, value: unknown) => { await fixtures.beforeWrite?.(key); fixtures.records.set(key, structuredClone(value)); },
  safeConnection: (connection: Record<string, unknown>) => ({ ...connection, token: "" }),
  getBlob: async (id: string) => { const blob = fixtures.blobs.get(id); if (!blob) throw new Error("本地素材丢失"); return blob; },
  putBlob: async (id: string, blob: Blob) => { fixtures.blobs.set(id, blob); },
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/muse/client", () => ({
  createMuseJob: fixtures.create, getMuseJob: fixtures.get,
  resumeMuseJob: fixtures.resume, getMuseOutput: fixtures.output,
  uploadMuseReference: fixtures.upload,
  cancelMuseJob: fixtures.cancel,
}));

import { cancelTask, generate, hasActiveTasks, recoverTasks, resumeTask } from "../src/generation/pipeline";
import { createNode, useStore, type ProjectLibrary } from "../src/stores/store";
import * as assets from "../src/assets/assets";
import { museWorkflows } from "../src/muse/catalog";

function definition(kind: "image" | "video"): WorkflowDefinition {
  return structuredClone(museWorkflows.find(workflow => workflow.muse?.kind === kind)!);
}
function task() { return Object.values(useStore.getState().project.tasks)[0]; }
function checkpoint() { return (fixtures.records.get("project-library") as ProjectLibrary).project.project; }
function result(id: string, kind: "image" | "video" = "image", count = 1) {
  return { id, status: "completed", outputs: Array.from({ length: count }, (_, index) => ({
    id: "output-" + index, name: kind === "image" ? "result-" + index + ".png" : "result-" + index + ".mp4",
    mime: kind === "image" ? "image/png" : "video/mp4", url: "/api/muse/jobs/" + id + "/media/output-" + index,
  })) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function seed(kind: "image" | "video" = "image") {
  const workflow = definition(kind);
  const node = createNode(kind === "image" ? "image-generation" : "video", 1); node.id = "node";
  node.data.generation = { workflowId: workflow.id, prompt: "测试生成", negativePrompt: "", params: { aspectRatio: "16:9" }, taskId: null, computeProvider: "muse" };
  const project: Project = {
    version: 2, id: "project", name: "Muse fixture", activeCanvasId: "canvas", scenes: [{ id: "scene", name: "场景" }], updatedAt: 1,
    canvases: [{ id: "canvas", name: "画布", sceneId: "scene", nodes: [node], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }],
    tasks: {}, assets: {}, history: [],
  };
  useStore.setState({ project, projects: {}, projectOpen: true, navigating: false, ready: false, past: [], future: [],
    toast: "", computeProvider: "muse", workflows: [workflow], runningHubWorkflows: [] });
}
function connectReference(id: string, kind: Asset["kind"] = "image", order = 0) {
  const [mime, extension] = kind === "image" ? ["image/png", "png"] : kind === "video" ? ["video/mp4", "mp4"] : kind === "audio" ? ["audio/mpeg", "mp3"] : ["application/octet-stream", "bin"];
  const blob = new Blob([id], { type: mime }); fixtures.blobs.set(id, blob);
  const asset: Asset = { id, name: id + "." + extension, kind, mime, size: blob.size, createdAt: 1 };
  const node = createNode("reference", 1); node.id = id; node.data.assetId = id;
  useStore.getState().editProject(project => ({ ...project, assets: { ...project.assets, [id]: asset },
    canvases: project.canvases.map(canvas => ({ ...canvas, nodes: [...canvas.nodes, node], edges: [...canvas.edges,
      { id: "edge-" + id, source: id, target: "node", data: { role: "auto", order } }],
    })),
  }));
}
function interrupted(overrides: Partial<GenerationTask> = {}) {
  const workflow = definition("image");
  const saved: GenerationTask = {
    taskId: "saved-task", promptId: "saved-task", requestId: "saved-task", clientId: "saved-client", executorType: "muse",
    projectId: "project", canvasId: "canvas", nodeId: "node", nodeTitle: "图像 1", status: "interrupted", createdAt: 1, updatedAt: 1,
    connection: { name: "Muse", baseUrl: "/api/muse", authHeader: "", authPrefix: "", timeoutMinutes: 0 }, workflow,
    input: { prompt: "原任务输入", negativePrompt: "", params: { aspectRatio: "auto" }, assets: [] }, outputs: [], ...overrides,
  };
  useStore.getState().createTask(saved);
  return saved;
}

beforeEach(() => {
  vi.restoreAllMocks(); fixtures.records.clear(); fixtures.blobs.clear();
  fixtures.beforeWrite = undefined;
  for (const fn of [fixtures.create, fixtures.get, fixtures.resume, fixtures.output, fixtures.upload, fixtures.cancel]) fn.mockReset();
  seed();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No real Muse calls are permitted in tests"); }));
  fixtures.create.mockImplementation(async input => result(input.id));
  fixtures.get.mockImplementation(async id => result(id));
  fixtures.resume.mockImplementation(async id => result(id));
  fixtures.output.mockResolvedValue(new Blob(["generated"], { type: "image/png" }));
  fixtures.upload.mockImplementation(async (_id: string, blob: Blob, name: string) => ({ uploadId: "upload-" + name, name: "stored-" + name, mime: blob.type }));
  fixtures.cancel.mockImplementation(async (id: string) => ({ id, status: "cancelled", message: "已从本机队列移除；已发送到 Muse 的生成可能继续运行。" }));
});
afterEach(() => {
  expect(hasActiveTasks()).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("Muse generation pipeline", () => {
  it("submits its Muse card after another provider is selected before and during its durable save", async () => {
    useStore.setState({ computeProvider: "runninghub" });
    const waiting = deferred<void>();
    fixtures.beforeWrite = vi.fn(() => waiting.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(fixtures.beforeWrite).toHaveBeenCalled());
    useStore.setState({ computeProvider: "comfyui" });
    useStore.getState().editCanvas(canvas => ({ ...canvas, nodes: canvas.nodes.map(node => ({ ...node, position: { x: 200, y: 300 } })), edges: [...canvas.edges] }));
    waiting.resolve(); await pending;
    expect(fixtures.create).toHaveBeenCalledTimes(1);
    expect(task()).toMatchObject({ status: "completed", executorType: "muse", nodeId: "node" });
    expect(useStore.getState().project.canvases[0].nodes[0].data.generation?.computeProvider).toBe("muse");
  });

  it("does not submit if its own provider changes during the durable save", async () => {
    const waiting = deferred<void>(); fixtures.beforeWrite = vi.fn(() => waiting.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(fixtures.beforeWrite).toHaveBeenCalled());
    const node = useStore.getState().project.canvases[0].nodes[0];
    useStore.getState().patchNode("node", { generation: { ...node.data.generation!, computeProvider: "runninghub" } }, "canvas");
    waiting.resolve(); await pending;
    expect(fixtures.create).not.toHaveBeenCalled();
    expect(task()).toMatchObject({ status: "failed", submissionState: "not-submitted" });
  });

  it.each(["image", "video"] as const)("persists before one submit and saves a real %s asset to the original node", async kind => {
    seed(kind);
    fixtures.create.mockImplementation(async input => {
      expect(checkpoint().tasks[input.id]).toMatchObject({ taskId: input.id, promptId: input.id, executorType: "muse", status: "submitting" });
      expect(input).toMatchObject({ id: task().taskId, kind, prompt: "测试生成", aspectRatio: "16:9", references: [] });
      expect(task().workflow.template).toBeUndefined();
      return result(input.id, kind);
    });
    fixtures.output.mockResolvedValue(new Blob(["media"], { type: kind === "image" ? "image/png" : "video/mp4" }));
    const imported = vi.spyOn(assets, "importAsset");
    await generate("canvas", "node");
    expect(fixtures.create).toHaveBeenCalledTimes(1);
    expect(task().status).toBe("completed");
    const output = useStore.getState().project.assets[task().outputs[0]];
    expect(output.kind).toBe(kind);
    expect(imported.mock.calls[0]).toHaveLength(2);
    expect(useStore.getState().project.canvases[0].nodes[0].data.assetId).toBe(output.id);
    expect(checkpoint().history[0]).toMatchObject({ id: task().taskId, outputs: [output.id] });
    expect(fixtures.blobs.get(output.id)?.size).toBe(output.size);
  });

  it("replaces delivery confirmation details while saving and records the completed writeback message", async () => {
    vi.useFakeTimers();
    fixtures.create.mockImplementation(async input => ({ id: input.id, status: "submitting", message: "Muse 尚未确认送达" }));
    const output = deferred<Blob>();
    fixtures.output.mockReturnValue(output.promise);
    const pending = generate("canvas", "node");
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(task()).toMatchObject({ status: "submitting", details: "Muse 尚未确认送达" });
      await vi.advanceTimersByTimeAsync(1500);
      expect(task()).toMatchObject({ status: "saving", details: "Muse 已完成，正在把成品写入原节点。" });
      expect(task().details).not.toContain("确认送达");
      expect(checkpoint().tasks[task().taskId].details).toBe(task().details);
    } finally {
      output.resolve(new Blob(["generated"], { type: "image/png" }));
      await pending;
    }
    expect(task()).toMatchObject({ status: "completed", details: "Muse 成品已保存到原节点。" });
    expect(checkpoint().tasks[task().taskId].details).toBe("Muse 成品已保存到原节点。");
  });

  it("uploads every reference in edge order from the persisted input snapshot", async () => {
    connectReference("second", "image", 2); connectReference("first", "image", 1);
    fixtures.create.mockImplementation(async input => {
      expect(input.references).toEqual([
        { uploadId: "upload-first.png", name: "stored-first.png", mime: "image/png" },
        { uploadId: "upload-second.png", name: "stored-second.png", mime: "image/png" },
      ]);
      expect(checkpoint().tasks[input.id].input.assets.map(reference => reference.asset.id)).toEqual(["first", "second"]);
      return result(input.id);
    });
    await generate("canvas", "node");
    expect(fixtures.upload.mock.calls).toEqual([
      [task().taskId, fixtures.blobs.get("first"), "first.png", expect.any(AbortSignal)],
      [task().taskId, fixtures.blobs.get("second"), "second.png", expect.any(AbortSignal)],
    ]);
    expect(fixtures.upload.mock.calls[0][3]).toBe(fixtures.upload.mock.calls[1][3]);
    expect(task().status).toBe("completed");
  });

  it.each(["image", "video"] as const)("submits mixed image/video/audio references in edge order for %s generation", async kind => {
    seed(kind);
    connectReference("sound", "audio", 3); connectReference("still", "image", 1); connectReference("clip", "video", 2);
    fixtures.create.mockImplementation(async input => {
      expect(input.references).toEqual([
        { uploadId: "upload-still.png", name: "stored-still.png", mime: "image/png" },
        { uploadId: "upload-clip.mp4", name: "stored-clip.mp4", mime: "video/mp4" },
        { uploadId: "upload-sound.mp3", name: "stored-sound.mp3", mime: "audio/mpeg" },
      ]);
      expect(checkpoint().tasks[input.id].input.assets.map(reference => reference.asset.kind)).toEqual(["image", "video", "audio"]);
      return result(input.id, kind);
    });
    fixtures.output.mockResolvedValue(new Blob(["generated"], { type: kind === "image" ? "image/png" : "video/mp4" }));
    await generate("canvas", "node");
    expect(fixtures.upload.mock.calls.map(([_id, blob, name]) => [blob, name])).toEqual([
      [fixtures.blobs.get("still"), "still.png"], [fixtures.blobs.get("clip"), "clip.mp4"], [fixtures.blobs.get("sound"), "sound.mp3"],
    ]);
    expect(fixtures.create).toHaveBeenCalledTimes(1);
    expect(task().status).toBe("completed");
    expect(checkpoint().history[0].inputs.map(input => input.assetId)).toEqual(["still", "clip", "sound"]);
  });

  it("rejects unsupported file references before submission", async () => {
    connectReference("unsupported", "file");
    await generate("canvas", "node");
    expect(fixtures.create).not.toHaveBeenCalled();
    expect(task()).toBeUndefined();
    expect(useStore.getState().project.canvases[0].nodes[0].data.generationFeedback?.status).toBe("failed");
  });

  it("uploads more than four references without silently discarding any", async () => {
    for (let index = 0; index < 5; index++) connectReference("ref" + index, "image", index);
    await generate("canvas", "node");
    expect(fixtures.create).toHaveBeenCalledTimes(1);
    expect(fixtures.create.mock.calls[0][0].references.map((reference: { uploadId: string }) => reference.uploadId))
      .toEqual(["upload-ref0.png", "upload-ref1.png", "upload-ref2.png", "upload-ref3.png", "upload-ref4.png"]);
    expect(task().status).toBe("completed");
  });

  it.each(["image", "video", "audio"] as const)("rejects an empty %s blob before submitting", async kind => {
    connectReference("empty", kind);
    fixtures.blobs.set("empty", new Blob([], { type: useStore.getState().project.assets.empty.mime }));
    await generate("canvas", "node");
    expect(fixtures.upload).not.toHaveBeenCalled();
    expect(fixtures.create).not.toHaveBeenCalled();
    expect(task()).toMatchObject({ status: "failed", submissionState: "not-submitted", promptId: null });
  });

  it("rejects changed local media types before submitting", async () => {
    connectReference("clip", "video");
    fixtures.blobs.set("clip", new Blob(["wrong"], { type: "image/png" }));
    await generate("canvas", "node");
    expect(fixtures.create).not.toHaveBeenCalled();
    expect(task()).toMatchObject({ status: "failed", submissionState: "not-submitted", promptId: null });
  });

  it("uploads blob bodies without reading them into a frontend array buffer", async () => {
    connectReference("clip", "video");
    const blob = fixtures.blobs.get("clip")!;
    const read = vi.spyOn(blob, "arrayBuffer").mockRejectedValue(new Error("Frontend must not buffer uploads"));
    await generate("canvas", "node");
    expect(read).not.toHaveBeenCalled();
    expect(fixtures.upload).toHaveBeenCalledWith(task().taskId, blob, "clip.mp4", expect.any(AbortSignal));
    expect(task().status).toBe("completed");
  });

  it("preserves the asset MIME when a stored blob has no MIME", async () => {
    connectReference("clip", "video");
    fixtures.blobs.set("clip", new Blob(["clip"]));
    await generate("canvas", "node");
    const uploaded = fixtures.upload.mock.calls[0][1] as Blob;
    expect(uploaded.type).toBe("video/mp4");
    expect(await uploaded.text()).toBe("clip");
    expect(task().status).toBe("completed");
  });

  it("marks a failed reference upload as unsubmitted and never creates a generation", async () => {
    connectReference("clip", "video");
    fixtures.upload.mockRejectedValue(new TypeError("Upload connection lost"));
    await generate("canvas", "node");
    expect(fixtures.create).not.toHaveBeenCalled();
    expect(task()).toMatchObject({ status: "failed", submissionState: "not-submitted", promptId: null });
  });

  it("expires an in-progress reference upload after a project switch and never uploads the next reference", async () => {
    connectReference("first", "image", 1); connectReference("second", "image", 2);
    const waiting = deferred<{ uploadId: string; name: string; mime: string }>();
    fixtures.upload.mockImplementation(() => waiting.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(fixtures.upload).toHaveBeenCalledTimes(1));
    const original = useStore.getState().project;
    useStore.setState({ project: { ...original, id: "other-project" } });
    useStore.setState({ project: original });
    expect((fixtures.upload.mock.calls[0][3] as AbortSignal).aborted).toBe(true);
    waiting.resolve({ uploadId: "uploaded-first", name: "stored-first.png", mime: "image/png" });
    await pending;
    expect(fixtures.upload).toHaveBeenCalledTimes(1);
    expect(fixtures.create).not.toHaveBeenCalled();
  });

  it("marks missing input files as unsubmitted and never creates a remote task", async () => {
    connectReference("missing"); fixtures.blobs.delete("missing");
    await generate("canvas", "node");
    expect(task()).toMatchObject({ status: "failed", submissionState: "not-submitted", promptId: null });
    expect(fixtures.create).not.toHaveBeenCalled();
  });

  it("does not submit when the durable checkpoint cannot be saved", async () => {
    fixtures.beforeWrite = () => { throw new Error("Disk full"); };
    await generate("canvas", "node");
    expect(fixtures.create).not.toHaveBeenCalled();
    expect(task()).toMatchObject({ status: "failed", submissionState: "not-submitted", promptId: null });
  });

  it("does not submit an obsolete preparation after the project is left and reopened", async () => {
    const waiting = deferred<void>();
    fixtures.beforeWrite = vi.fn(() => waiting.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(fixtures.beforeWrite).toHaveBeenCalled());
    const original = useStore.getState().project;
    useStore.setState({ project: { ...original, id: "other" } });
    useStore.setState({ project: original });
    waiting.resolve(); await pending;
    expect(fixtures.create).not.toHaveBeenCalled();
  });

  it("recovers a lost submit response by GET only with the same durable task id", async () => {
    connectReference("original");
    fixtures.create.mockRejectedValue(new TypeError("Connection lost"));
    await generate("canvas", "node");
    const id = task().taskId;
    expect(task()).toMatchObject({ status: "interrupted", promptId: id });
    fixtures.blobs.delete("original");
    await resumeTask(id);
    expect(fixtures.upload).toHaveBeenCalledTimes(1);
    expect(fixtures.create).toHaveBeenCalledTimes(1);
    expect(fixtures.get).toHaveBeenCalledWith(id, expect.any(AbortSignal));
    expect(fixtures.resume).not.toHaveBeenCalled(); expect(task().status).toBe("completed");
  });

  it("treats a confirmed access rejection as unsubmitted, but a request timeout as uncertain", async () => {
    fixtures.create.mockRejectedValue(Object.assign(new Error("账号尚未开放"), { status: 403 }));
    await generate("canvas", "node");
    expect(task()).toMatchObject({ status: "failed", promptId: null, submissionState: "not-submitted" });
    seed();
    fixtures.create.mockRejectedValue(Object.assign(new Error("Request timeout"), { status: 408 }));
    await generate("canvas", "node");
    expect(task()).toMatchObject({ status: "interrupted", promptId: task().taskId });
    expect(task().submissionState).toBeUndefined();
  });

  it("does not create a second job on a repeated generate click", async () => {
    const waiting = deferred<ReturnType<typeof result>>();
    fixtures.create.mockImplementation(() => waiting.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(fixtures.create).toHaveBeenCalledTimes(1));
    await generate("canvas", "node");
    expect(Object.values(useStore.getState().project.tasks)).toHaveLength(1);
    waiting.resolve(result(task().taskId)); await pending;
    expect(fixtures.create).toHaveBeenCalledTimes(1);
  });

  it("resumes an interrupted bridge job without creating another generation", async () => {
    const saved = interrupted({ promptId: null });
    fixtures.get.mockResolvedValue({ id: saved.taskId, status: "interrupted" });
    await recoverTasks();
    expect(fixtures.create).not.toHaveBeenCalled();
    expect(fixtures.resume).toHaveBeenCalledWith(saved.taskId, expect.any(AbortSignal));
    expect(task().status).toBe("completed");
  });

  it("does not submit when the bridge has no record of an uncertain original job", async () => {
    interrupted(); fixtures.get.mockRejectedValue(new Error("原任务不存在"));
    await resumeTask("saved-task");
    expect(fixtures.create).not.toHaveBeenCalled(); expect(fixtures.resume).not.toHaveBeenCalled();
    expect(task().status).toBe("interrupted");
  });

  it("reconnects a disconnected original job during polling without uploading or creating again", async () => {
    vi.useFakeTimers();
    fixtures.create.mockImplementation(async input => ({ id: input.id, status: "generating" }));
    fixtures.get.mockImplementationOnce(async id => ({ id, status: "interrupted", recovery: "reconnect", error: "浏览器连接已关闭" }));
    fixtures.resume.mockImplementation(async id => ({ id, status: "loading", conversationUrl: "https://muse.ai/" }));
    const pending = generate("canvas", "node");
    await vi.advanceTimersByTimeAsync(4500);
    await pending;
    const id = task().taskId;
    expect(fixtures.resume).toHaveBeenCalledExactlyOnceWith(id, expect.any(AbortSignal));
    expect(fixtures.get).toHaveBeenCalledTimes(2);
    expect(fixtures.create).toHaveBeenCalledTimes(1); expect(fixtures.upload).not.toHaveBeenCalled();
    expect(task().status).toBe("completed");
    expect(checkpoint().tasks[id].status).toBe("completed");
    expect(checkpoint().tasks[id].muse?.conversationUrl).toBe("https://muse.ai/");
  });

  it.each(["interrupted", "error"])("does not repeat automatic recovery when resume returns %s", async outcome => {
    fixtures.create.mockImplementation(async input => ({ id: input.id, status: "interrupted", recovery: "reconnect" }));
    if (outcome === "interrupted") fixtures.resume.mockImplementation(async id => ({ id, status: "interrupted", recovery: "reconnect", error: "请打开原聊天" }));
    else fixtures.resume.mockRejectedValue(new Error("请打开原聊天"));
    await generate("canvas", "node");
    expect(fixtures.resume).toHaveBeenCalledTimes(1);
    expect(fixtures.create).toHaveBeenCalledTimes(1); expect(fixtures.upload).not.toHaveBeenCalled();
    expect(fixtures.get).not.toHaveBeenCalled(); expect(fixtures.output).not.toHaveBeenCalled();
    expect(task()).toMatchObject({ status: "interrupted", error: "请打开原聊天" });
  });

  it("does not automatically resume an interruption that requires manual attention", async () => {
    fixtures.create.mockImplementation(async input => ({ id: input.id, status: "interrupted", recovery: "manual", error: "未确认送达" }));
    await generate("canvas", "node");
    expect(fixtures.resume).not.toHaveBeenCalled(); expect(fixtures.output).not.toHaveBeenCalled();
    expect(task()).toMatchObject({ status: "interrupted", error: "未确认送达" });
  });

  it("keeps cancellation after a late automatic reconnect response", async () => {
    const waiting = deferred<ReturnType<typeof result>>();
    fixtures.create.mockImplementation(async input => ({ id: input.id, status: "interrupted", recovery: "reconnect" }));
    fixtures.resume.mockReturnValue(waiting.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(fixtures.resume).toHaveBeenCalledTimes(1));
    const id = task().taskId;
    expect(task()).toMatchObject({ status: "loading", details: expect.stringContaining("查询原任务") });
    await cancelTask(id);
    expect((fixtures.resume.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    waiting.resolve(result(id)); await pending;
    expect(task().status).toBe("cancelled"); expect(fixtures.output).not.toHaveBeenCalled();
    expect(fixtures.create).toHaveBeenCalledTimes(1); expect(fixtures.upload).not.toHaveBeenCalled();
  });

  it("does not request recovery if cancelled while saving the reconnect checkpoint", async () => {
    const waiting = deferred<void>();
    let blocked = false;
    fixtures.create.mockImplementation(async input => {
      fixtures.beforeWrite = () => { if (!blocked) { blocked = true; return waiting.promise; } };
      return { id: input.id, status: "interrupted", recovery: "reconnect" };
    });
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(blocked).toBe(true));
    const id = task().taskId;
    const stopping = cancelTask(id);
    await vi.waitFor(() => expect(fixtures.cancel).toHaveBeenCalledExactlyOnceWith(id));
    waiting.resolve();
    await Promise.all([pending, stopping]);
    expect(task().status).toBe("cancelled");
    expect(fixtures.resume).not.toHaveBeenCalled(); expect(fixtures.output).not.toHaveBeenCalled();
    expect(fixtures.create).toHaveBeenCalledTimes(1);
  });

  it("can reconnect another later disconnection after the first recovery makes progress", async () => {
    vi.useFakeTimers();
    fixtures.create.mockImplementation(async input => ({ id: input.id, status: "interrupted", recovery: "reconnect" }));
    fixtures.resume.mockImplementationOnce(async id => ({ id, status: "generating" }));
    fixtures.get.mockImplementationOnce(async id => ({ id, status: "interrupted", recovery: "reconnect" }));
    const pending = generate("canvas", "node");
    await vi.advanceTimersByTimeAsync(3000);
    await pending;
    expect(fixtures.resume).toHaveBeenCalledTimes(2);
    expect(fixtures.resume.mock.calls.every(([id]) => id === task().taskId)).toBe(true);
    expect(fixtures.create).toHaveBeenCalledTimes(1); expect(fixtures.upload).not.toHaveBeenCalled();
    expect(task().status).toBe("completed");
  });

  it("expires automatic recovery after leaving and reopening the project", async () => {
    const waiting = deferred<ReturnType<typeof result>>();
    fixtures.create.mockImplementation(async input => ({ id: input.id, status: "interrupted", recovery: "reconnect" }));
    fixtures.resume.mockReturnValue(waiting.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(fixtures.resume).toHaveBeenCalledTimes(1));
    const original = useStore.getState().project, id = task().taskId;
    useStore.setState({ project: { ...original, id: "other-project" } });
    useStore.setState({ project: original });
    const before = useStore.getState().project;
    waiting.resolve(result(id)); await pending;
    expect(useStore.getState().project).toBe(before);
    expect((fixtures.resume.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    expect(fixtures.output).not.toHaveBeenCalled(); expect(fixtures.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched GET receipt before requesting recovery", async () => {
    const saved = interrupted();
    fixtures.get.mockResolvedValue({ id: "another-task", status: "interrupted", recovery: "reconnect" });
    await resumeTask(saved.taskId);
    expect(task()).toMatchObject({ status: "interrupted", error: expect.stringContaining("其他任务") });
    expect(fixtures.resume).not.toHaveBeenCalled(); expect(fixtures.create).not.toHaveBeenCalled();
    expect(fixtures.output).not.toHaveBeenCalled();
  });

  it("checkpoints partial downloads and recovers only the missing media", async () => {
    fixtures.create.mockImplementation(async input => result(input.id, "image", 2));
    fixtures.output.mockResolvedValueOnce(new Blob(["first"], { type: "image/png" })).mockRejectedValueOnce(new TypeError("Download lost"));
    await generate("canvas", "node");
    const id = task().taskId, firstAsset = task().downloadedOutputs![0].asset;
    expect(task().status).toBe("interrupted");
    expect(checkpoint().tasks[id].downloadedOutputs).toHaveLength(1);
    fixtures.output.mockResolvedValue(new Blob(["second"], { type: "image/png" }));
    await resumeTask(id);
    expect(fixtures.create).toHaveBeenCalledTimes(1); expect(fixtures.get).not.toHaveBeenCalled();
    expect(fixtures.output).toHaveBeenCalledTimes(3);
    expect(task().outputs[0]).toBe(firstAsset.id); expect(task().outputs).toHaveLength(2);
    expect(task().status).toBe("completed");
  });

  it.each(["text/html", "image/png"])("does not turn %s into a video result", async mime => {
    seed("video"); fixtures.create.mockImplementation(async input => result(input.id, "video"));
    fixtures.output.mockResolvedValue(new Blob(["wrong media"], { type: mime }));
    await generate("canvas", "node");
    expect(task().status).toBe("interrupted"); expect(task().outputs).toEqual([]);
    expect(useStore.getState().project.assets).toEqual({});
  });

  it("stops the bridge queue and keeps cancellation when the original submit response arrives later", async () => {
    const waiting = deferred<ReturnType<typeof result>>();
    fixtures.create.mockImplementation(() => waiting.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(fixtures.create).toHaveBeenCalledTimes(1));
    const id = task().taskId;
    await cancelTask(id);
    expect(fixtures.cancel).toHaveBeenCalledExactlyOnceWith(id);
    expect(task()).toMatchObject({ status: "cancelled", details: expect.stringContaining("可能继续运行") });
    expect(useStore.getState().toast).toContain("可能继续运行");
    waiting.resolve(result(id)); await pending;
    expect(task().status).toBe("cancelled"); expect(fixtures.output).not.toHaveBeenCalled();
    await resumeTask(id);
    expect(task().status).toBe("cancelled"); expect(fixtures.create).toHaveBeenCalledTimes(1);
    expect(fixtures.get).not.toHaveBeenCalled(); expect(fixtures.resume).not.toHaveBeenCalled();
    expect(checkpoint().tasks[id].status).toBe("cancelled");
  });

  it("stops an interrupted task even when no frontend observer is running", async () => {
    const saved = interrupted();
    await cancelTask(saved.taskId);
    expect(fixtures.cancel).toHaveBeenCalledExactlyOnceWith(saved.taskId);
    expect(task().status).toBe("cancelled");
    expect(fixtures.create).not.toHaveBeenCalled(); expect(fixtures.get).not.toHaveBeenCalled(); expect(fixtures.resume).not.toHaveBeenCalled();
  });

  it("coalesces concurrent stop clicks into one bridge cancellation", async () => {
    const saved = interrupted();
    const waiting = deferred<{ id: string; status: string; message: string }>();
    fixtures.cancel.mockReturnValue(waiting.promise);
    const first = cancelTask(saved.taskId), second = cancelTask(saved.taskId);
    await vi.waitFor(() => expect(fixtures.cancel).toHaveBeenCalledTimes(1));
    waiting.resolve({ id: saved.taskId, status: "cancelled", message: "已停止本机队列" });
    await Promise.all([first, second]);
    expect(task().status).toBe("cancelled");
  });

  it("stops preparation before create and allows a new task without reviving the cancelled one", async () => {
    const waiting = deferred<void>();
    let blocked = false;
    fixtures.beforeWrite = () => { if (!blocked) { blocked = true; return waiting.promise; } };
    const originalPreparation = generate("canvas", "node");
    await vi.waitFor(() => expect(blocked).toBe(true));
    const originalId = task().taskId;
    const stopping = cancelTask(originalId);
    await vi.waitFor(() => expect(fixtures.cancel).toHaveBeenCalledExactlyOnceWith(originalId));
    const nextPreparation = generate("canvas", "node");
    expect(Object.values(useStore.getState().project.tasks)).toHaveLength(2);
    const nextId = Object.keys(useStore.getState().project.tasks).find(id => id !== originalId)!;
    waiting.resolve();
    await Promise.all([originalPreparation, stopping, nextPreparation]);
    expect(fixtures.create).toHaveBeenCalledTimes(1);
    expect(fixtures.create.mock.calls[0][0].id).toBe(nextId);
    expect(useStore.getState().project.tasks[originalId].status).toBe("cancelled");
    expect(useStore.getState().project.tasks[nextId].status).toBe("completed");
  });

  it("does not stop a new preparation when stopping an older cancelled task again", async () => {
    const previous = interrupted();
    await cancelTask(previous.taskId);
    const waiting = deferred<void>();
    let blocked = false;
    fixtures.beforeWrite = () => { if (!blocked) { blocked = true; return waiting.promise; } };
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(blocked).toBe(true));
    const nextId = Object.keys(useStore.getState().project.tasks).find(id => id !== previous.taskId)!;
    const stoppingOld = cancelTask(previous.taskId);
    await vi.waitFor(() => expect(fixtures.cancel).toHaveBeenCalledTimes(2));
    waiting.resolve();
    await Promise.all([pending, stoppingOld]);
    expect(fixtures.create).toHaveBeenCalledTimes(1);
    expect(fixtures.create.mock.calls[0][0].id).toBe(nextId);
    expect(useStore.getState().project.tasks[previous.taskId].status).toBe("cancelled");
    expect(useStore.getState().project.tasks[nextId].status).toBe("completed");
  });

  it("does not replace cancellation if the older preparation checkpoint fails", async () => {
    let rejectWrite!: (reason: Error) => void;
    const waiting = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    let blocked = false;
    fixtures.beforeWrite = () => { if (!blocked) { blocked = true; return waiting; } };
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(blocked).toBe(true));
    const id = task().taskId;
    const stopping = cancelTask(id);
    await vi.waitFor(() => expect(fixtures.cancel).toHaveBeenCalledExactlyOnceWith(id));
    rejectWrite(new Error("Old checkpoint failed"));
    await Promise.all([pending, stopping]);
    expect(task().status).toBe("cancelled");
    expect(fixtures.create).not.toHaveBeenCalled();
  });

  it("aborts an upload and never sends its late result or the next reference after stopping", async () => {
    connectReference("first", "image", 1); connectReference("second", "video", 2);
    const waiting = deferred<{ uploadId: string; name: string; mime: string }>();
    fixtures.upload.mockReturnValue(waiting.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(fixtures.upload).toHaveBeenCalledTimes(1));
    const id = task().taskId;
    await cancelTask(id);
    expect((fixtures.upload.mock.calls[0][3] as AbortSignal).aborted).toBe(true);
    waiting.resolve({ uploadId: "uploaded-first", name: "stored-first.png", mime: "image/png" });
    await pending;
    expect(task().status).toBe("cancelled");
    expect(fixtures.cancel).toHaveBeenCalledExactlyOnceWith(id);
    expect(fixtures.upload).toHaveBeenCalledTimes(1); expect(fixtures.create).not.toHaveBeenCalled();
  });

  it("keeps a failed stop actionable and ignores the aborted observer before retrying", async () => {
    const waiting = deferred<ReturnType<typeof result>>();
    fixtures.create.mockReturnValue(waiting.promise);
    fixtures.cancel.mockRejectedValueOnce(new Error("Bridge unavailable"));
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(fixtures.create).toHaveBeenCalledTimes(1));
    const id = task().taskId;
    await cancelTask(id);
    expect(task()).toMatchObject({ status: "interrupted", error: expect.stringContaining("停止尚未确认") });
    waiting.resolve(result(id)); await pending;
    expect(task()).toMatchObject({ status: "interrupted", error: expect.stringContaining("Bridge unavailable") });
    expect(fixtures.output).not.toHaveBeenCalled();
    await cancelTask(id);
    expect(fixtures.cancel).toHaveBeenCalledTimes(2);
    expect(task().status).toBe("cancelled");
    expect(fixtures.create).toHaveBeenCalledTimes(1);
  });

  it("does not apply an old stop response after leaving and reopening its project", async () => {
    const saved = interrupted();
    const waiting = deferred<{ id: string; status: string; message: string }>();
    fixtures.cancel.mockReturnValue(waiting.promise);
    const stopping = cancelTask(saved.taskId);
    await vi.waitFor(() => expect(fixtures.cancel).toHaveBeenCalledTimes(1));
    const original = useStore.getState().project;
    useStore.setState({ project: { ...original, id: "other-project" } });
    useStore.setState({ project: original });
    const before = useStore.getState().project;
    const previousToast = useStore.getState().toast;
    waiting.resolve({ id: saved.taskId, status: "cancelled", message: "Late response from old project visit" });
    await stopping;
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().toast).toBe(previousToast);
    expect(task().details).not.toContain("Late response");
  });

  it("recognizes a bridge cancellation during recovery without resuming or resubmitting", async () => {
    const saved = interrupted();
    fixtures.get.mockResolvedValue({ id: saved.taskId, status: "cancelled", message: "本机队列已停止" });
    await resumeTask(saved.taskId);
    expect(task()).toMatchObject({ status: "cancelled", details: "本机队列已停止" });
    expect(fixtures.get).toHaveBeenCalledTimes(1);
    expect(fixtures.resume).not.toHaveBeenCalled(); expect(fixtures.create).not.toHaveBeenCalled();
  });

  it("honors a cancellation tombstone returned by create without polling or downloading", async () => {
    fixtures.create.mockImplementation(async input => ({ id: input.id, status: "cancelled", message: "任务已停止，未发送" }));
    await generate("canvas", "node");
    expect(task()).toMatchObject({ status: "cancelled", details: "任务已停止，未发送" });
    expect(fixtures.get).not.toHaveBeenCalled(); expect(fixtures.output).not.toHaveBeenCalled();
  });

  it("permanently expires observation on project change even if the project is reopened", async () => {
    const waiting = deferred<ReturnType<typeof result>>();
    fixtures.create.mockImplementation(() => waiting.promise);
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(fixtures.create).toHaveBeenCalledTimes(1));
    const original = useStore.getState().project, id = task().taskId;
    useStore.setState({ project: { ...original, id: "other-project" } });
    useStore.setState({ project: original });
    waiting.resolve(result(id)); await pending;
    expect(fixtures.output).not.toHaveBeenCalled(); expect(useStore.getState().project.history).toEqual([]);
  });

  it("rejects a receipt belonging to a different task", async () => {
    fixtures.create.mockResolvedValue(result("another-task"));
    await generate("canvas", "node");
    expect(task().status).toBe("interrupted"); expect(fixtures.output).not.toHaveBeenCalled();
  });

  it("keeps observing a long running task without a generation deadline", async () => {
    vi.useFakeTimers();
    const waiting = deferred<ReturnType<typeof result>>();
    fixtures.create.mockImplementation(async input => ({ id: input.id, status: "generating" }));
    fixtures.get.mockImplementation(() => waiting.promise);
    const pending = generate("canvas", "node");
    await vi.advanceTimersByTimeAsync(1500);
    expect(fixtures.get).toHaveBeenCalledTimes(1);
    const id = task().taskId;
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    waiting.resolve(result(id));
    await pending;
    expect(task().status).toBe("completed"); expect(fixtures.create).toHaveBeenCalledTimes(1);
  });
});
