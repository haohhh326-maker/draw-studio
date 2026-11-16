import { describe, it, expect, beforeEach, vi } from "vitest";
const persistence = vi.hoisted(() => ({ records: new Map<string, unknown>() }));
vi.mock("../src/projects/storage", () => ({
  readRecord: async (k: string) => structuredClone(persistence.records.get(k)),
  writeRecord: async (k: string, v: unknown) => {
    persistence.records.set(k, structuredClone(v));
  },
  safeConnection: (c: Record<string, unknown>) => ({ ...c, token: "" }),
  getBlob: async () => new Blob(["input"], { type: "image/png" }),
  putBlob: async () => {},
}));
import { useStore, createNode, type ProjectLibrary } from "../src/stores/store";
import { defaultConnection } from "../src/workflow/catalog";
import { ComfyUIClient, ExecutionError } from "../src/comfyui/client";
import { outputKey } from "../src/comfyui/files";
import { generate, resumeTask, cancelTask } from "../src/generation/pipeline";
import * as storage from "../src/projects/storage";
import { migrateProject } from "../src/projects/migrate";
import type { Project, WorkflowDefinition } from "../src/types";
const w: WorkflowDefinition = {
  id: "test",
  name: "Task protocol fixture",
  family: "Tests",
  description: "Local transport and persistence fixture",
  mode: "text-to-image",
  requiredInputs: [],
  optionalInputs: [],
  promptRequired: true,
  parameters: [{ key: "seed", label: "seed", type: "number", default: -1 }],
  template: {
    "1": { class_type: "Prompt", inputs: { text: "", seed: 0 } },
    "9": { class_type: "Save", inputs: { payload: ["1",0], prefix: "test" } },
  },
  mapping: [
    { semantic: "prompt", nodeId: "1", field: "text" },
    { semantic: "seed", nodeId: "1", field: "seed" },
  ],
  output: { nodeId: "9", field: "images", kind: "image" },
};
const objectInfo = {
  Prompt: { input:{required:{text:["STRING"],seed:["INT"]}}, output:["STRING"] },
  Save: { input:{required:{payload:["STRING"],prefix:["STRING"]},optional:{reference:["IMAGE"],filename_prefix:["STRING"]}}, output_node:true },
  LoadImage: { input:{required:{image:["STRING"]}},output:["IMAGE"] },
};
const queuePromptImplementation = ComfyUIClient.prototype.queuePrompt;
const history = {
  outputs: { "9": { images: [{ filename: "result.png", type: "output" }] } },
  status: { completed: true, status_str: "success" },
};
beforeEach(() => {
  vi.restoreAllMocks();
  persistence.records.clear();
  const n = createNode("image-generation", 1);
  n.id = "node";
  n.data.generation = {
    prompt: "original prompt",
    negativePrompt: "",
    workflowId: w.id,
    params: { seed: -1 },
    taskId: null,
  };
  const p: Project = {
    version: 2,
    id: "p",
    name: "Test",
    scenes: [{ id: "s", name: "Scene" }],
    canvases: [
      {
        id: "canvas",
        sceneId: "s",
        name: "Canvas",
        nodes: [n],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    ],
    activeCanvasId: "canvas",
    assets: {},
    tasks: {},
    history: [],
    updatedAt: 0,
  };
  useStore.setState({
    project: p,
    projects: {},
    projectOpen: false,
    navigating: false,
    workflows: [structuredClone(w)],
    connection: {
      ...defaultConnection,
      baseUrl: "http://localhost:8188",
      token: "secret",
    },
    ready: false,
    past: [],
    future: [],
  });
  vi.spyOn(ComfyUIClient.prototype, "getSystemStats").mockResolvedValue({
    system: { comfyui_version: "test" },
  });
  vi.spyOn(ComfyUIClient.prototype, "connect").mockResolvedValue();
  vi.spyOn(ComfyUIClient.prototype, "disconnect").mockImplementation(() => {});
  vi.spyOn(ComfyUIClient.prototype, "getObjectInfo").mockResolvedValue(objectInfo);
  vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockResolvedValue(
    "server-prompt",
  );
  vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockResolvedValue(
    history,
  );
  vi.spyOn(ComfyUIClient.prototype, "getOutput").mockResolvedValue(
    new Blob(["transport-fixture-only"], { type: "image/png" }),
  );
});
describe("durable task lifecycle", () => {
  it("keeps local validation feedback on the requested canvas without submitting a task", async () => {
    useStore.getState().editProject(project => ({ ...project, activeCanvasId: "other", canvases: [
      { ...project.canvases[0], nodes: project.canvases[0].nodes.map(node => ({ ...node, data: { ...node.data, generation: { ...node.data.generation!, prompt: "" } } })) },
      { ...structuredClone(project.canvases[0]), id: "other", nodes: [] },
    ] }));
    await generate("canvas", "node");
    const project = useStore.getState().project;
    expect(project.canvases[0].nodes[0].data.generationFeedback).toMatchObject({ status: "failed", error: expect.stringContaining("请输入提示词") });
    expect(project.canvases[1].nodes).toEqual([]);
    expect(Object.keys(project.tasks)).toEqual([]);
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });
  it("passes the submitted graph to execution tracking and preserves the original server failure on the task", async () => {
    const original = { node_id: "1", node_type: "Prompt", exception_message: "server source error", traceback: ["server.py:9"] };
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockImplementation(async (_id, _update, _signal, graph) => {
      const task = Object.values(useStore.getState().project.tasks)[0];
      expect(graph).toEqual(task.executionWorkflow);
      throw new ExecutionError(original.exception_message, "failed", JSON.stringify(original), { nodeId: "1", nodeType: "Prompt", nodeTitle: "Prompt" });
    });
    await generate("canvas", "node");
    const task = Object.values(useStore.getState().project.tasks)[0];
    expect(task).toMatchObject({ status: "failed", error: original.exception_message, execution: { nodeId: "1", nodeType: "Prompt" } });
    expect(JSON.parse(task.details!)).toEqual(original);
    expect(useStore.getState().project.history).toEqual([]);
  });
  it("never submits when durable local storage fails", async () => {
    vi.spyOn(storage, "writeRecord").mockRejectedValueOnce(
      new Error("disk full"),
    );
    await generate("canvas", "node");
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(Object.values(useStore.getState().project.tasks)[0].status).toBe(
      "failed",
    );
  });
  it("can cancel during the initial durable write without ever submitting", async () => {
    let release: (() => void) | undefined;
    vi.spyOn(storage, "writeRecord").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = generate("canvas", "node");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const taskId = Object.keys(useStore.getState().project.tasks)[0];
    const cancelling = cancelTask(taskId);
    release!();
    await Promise.all([pending, cancelling]);
    expect(useStore.getState().project.tasks[taskId].status).toBe("cancelled");
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });
  it("persists identity before submission, then promptId; completes in the SAME node", async () => {
    vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockImplementation(
      async () => {
        const saved = (
          persistence.records.get("project-library") as ProjectLibrary
        )["p"].project;
        const t = Object.values(saved.tasks)[0];
        expect(t.taskId).toBeTruthy();
        expect(t.promptId).toBeNull();
        expect(t.executorType).toBe("comfyui");
        expect(t.status).toBe("submitting");
        expect(t.input.params.seed).toBeGreaterThanOrEqual(0);
        expect(JSON.stringify(t)).not.toContain("secret");
        return "server-prompt";
      },
    );
    await generate("canvas", "node");
    const p = useStore.getState().project,
      t = Object.values(p.tasks)[0];
    expect(t.status).toBe("completed");
    expect(t.promptId).toBe("server-prompt");
    expect(p.canvases[0].nodes).toHaveLength(1);
    expect(p.canvases[0].nodes[0].id).toBe("node");
    expect(p.canvases[0].nodes[0].data.assetId).toBe(t.outputs[0]);
    expect(p.canvases[0].nodes[0].data.generation).not.toHaveProperty("task");
    expect(p.history[0].id).toBe(t.taskId);
    expect(
      (persistence.records.get("project-library") as ProjectLibrary)["p"]
        .project.tasks[t.taskId].status,
    ).toBe("completed");
  });
  it("preserves seed=-1 as user choice while task history stores the actual seed", async () => {
    await generate("canvas", "node");
    const p = useStore.getState().project;
    expect(p.canvases[0].nodes[0].data.generation!.params.seed).toBe(-1);
    expect(p.history[0].params.seed).toBeGreaterThanOrEqual(0);
  });
  it("resumes from original task after reload without requeue or current workflow dependence", async () => {
    vi.spyOn(
      ComfyUIClient.prototype,
      "waitForCompletion",
    ).mockRejectedValueOnce(new Error("connection lost"));
    await generate("canvas", "node");
    const stored = (
        persistence.records.get("project-library") as ProjectLibrary
      )["p"].project,
      t = Object.values(stored.tasks)[0];
    expect(t.status).toBe("interrupted");
    const reloaded = migrateProject(stored);
    reloaded.canvases[0].nodes[0].data.generation!.prompt = "edited later";
    useStore.setState({ project: reloaded, workflows: [] });
    await resumeTask(t.taskId);
    expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
    expect(useStore.getState().project.history[0].prompt).toBe(
      "original prompt",
    );
    expect(useStore.getState().project.tasks[t.taskId].promptId).toBe(
      "server-prompt",
    );
  });
  it("retains uncertain submissions and does not silently generate twice", async () => {
    vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockRejectedValue(
      new Error("network failure"),
    );
    await generate("canvas", "node");
    const t = Object.values(useStore.getState().project.tasks)[0];
    expect(t.status).toBe("interrupted");
    expect(t.promptId).toBeNull();
    await generate("canvas", "node");
    expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
    vi.spyOn(ComfyUIClient.prototype, "findSubmittedPrompt").mockResolvedValue(
      "found-original",
    );
    await resumeTask(t.taskId);
    expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
    expect(useStore.getState().project.tasks[t.taskId].promptId).toBe(
      "found-original",
    );
  });
  it("marks actual server failure as failed, not successful or recoverable", async () => {
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockRejectedValue(
      new ExecutionError("CUDA out of memory"),
    );
    await generate("canvas", "node");
    const t = Object.values(useStore.getState().project.tasks)[0];
    expect(t.status).toBe("failed");
    expect(t.error).toContain("CUDA out of memory");
    expect(useStore.getState().project.history).toHaveLength(0);
  });
  it("keeps task history when source node is deleted", async () => {
    await generate("canvas", "node");
    const taskId = Object.keys(useStore.getState().project.tasks)[0];
    useStore.getState().editCanvas((c) => ({ ...c, nodes: [] }));
    await useStore.getState().save();
    expect(
      (persistence.records.get("project-library") as ProjectLibrary)["p"]
        .project.tasks[taskId].promptId,
    ).toBe("server-prompt");
  });
  it("does not overwrite a newer node task when an old result returns", async () => {
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockImplementation(
      async () => {
        const s = useStore.getState(),
          n = s.project.canvases[0].nodes[0];
        s.patchNode(n.id, {
          generation: { ...n.data.generation!, taskId: "newer-task" },
        });
        return history;
      },
    );
    await generate("canvas", "node");
    expect(
      useStore.getState().project.canvases[0].nodes[0].data.assetId,
    ).toBeUndefined();
    expect(useStore.getState().project.history).toHaveLength(1);
  });
  it("recovers in-flight v2 task identity and strips old v1 node task in one-way migration", async () => {
    const p = structuredClone(useStore.getState().project) as any;
    p.version = 1;
    delete p.tasks;
    delete p.canvases[0].nodes[0].data.generation.taskId;
    p.canvases[0].nodes[0].data.generation.task = {
      phase: "queued",
      promptId: "old-prompt",
      clientId: "old-client",
    };
    const migrated = migrateProject(p, [w], defaultConnection);
    const t = Object.values(migrated.tasks)[0];
    expect(t.promptId).toBe("old-prompt");
    expect(t.status).toBe("interrupted");
    expect(migrated.canvases[0].nodes[0].data.generation).not.toHaveProperty(
      "task",
    );
    expect(t).not.toHaveProperty("phase");
  });
});

describe("task staging and resumable downloads", () => {
  function inputWorkflow() {
    const workflow = structuredClone(w);
    workflow.mode = "image-to-image";
    workflow.requiredInputs = ["image"];
    workflow.template!["2"] = {
      class_type: "LoadImage",
      inputs: { image: "original.png" },
    };
    workflow.template!["9"].inputs.filename_prefix = "original";
    workflow.template!["9"].inputs.reference = ["2",0];
    workflow.mapping.push({ semantic: "image", nodeId: "2", field: "image" });
    useStore.setState({ workflows: [workflow] });
    useStore.getState().editProject((p) => ({
      ...p,
      assets: {
        a: {
          id: "a",
          name: "same.png",
          kind: "image",
          mime: "image/png",
          size: 5,
          createdAt: 0,
        },
      },
      canvases: p.canvases.map((c) => ({
        ...c,
        nodes: [
          ...c.nodes,
          {
            id: "source",
            position: { x: 0, y: 0 },
            data: { kind: "reference", title: "Input", assetId: "a" },
          },
        ],
        edges: [
          {
            id: "edge",
            source: "source",
            target: "node",
            data: { role: "auto", order: 1 },
          },
        ],
      })),
    }));
    return workflow;
  }
  it("persists task-relative uploads and the exact execution graph before POST", async () => {
    const workflow = inputWorkflow();
    const original = JSON.stringify(workflow);
    vi.spyOn(ComfyUIClient.prototype, "uploadAsset").mockImplementation(
      async (_blob, _name, subfolder) => ({
        name: "renamed.png",
        subfolder,
        type: "input",
        inputName: subfolder + "/renamed.png",
      }),
    );
    vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockImplementation(
      async (prompt) => {
        const task = Object.values(
          (persistence.records.get("project-library") as ProjectLibrary)["p"]
            .project.tasks,
        )[0];
        expect(task.staging!.inputSubfolder).toBe(
          "infinite-canvas/" + task.taskId,
        );
        expect(task.staging!.uploads.a.inputName).toBe(
          task.staging!.inputSubfolder + "/renamed.png",
        );
        expect(prompt["2"].inputs.image).toBe(
          task.staging!.uploads.a.inputName,
        );
        expect(prompt["9"].inputs.filename_prefix).toBe(
          task.staging!.outputPrefix,
        );
        expect(task.executionWorkflow).toEqual(prompt);
        return "server-prompt";
      },
    );
    await generate("canvas", "node");
    expect(Object.values(useStore.getState().project.tasks)[0].status).toBe(
      "completed",
    );
    expect(JSON.stringify(useStore.getState().workflows[0])).toBe(original);
    expect(ComfyUIClient.prototype.uploadAsset).toHaveBeenCalledTimes(1);
  });
  it("does not upload or submit when a required local asset is missing", async () => {
    inputWorkflow();
    vi.spyOn(storage, "getBlob").mockRejectedValue(new Error("local missing"));
    const upload = vi.spyOn(ComfyUIClient.prototype, "uploadAsset");
    await generate("canvas", "node");
    expect(upload).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });
  it("does not submit if the uploaded manifest cannot be persisted", async () => {
    inputWorkflow();
    vi.spyOn(ComfyUIClient.prototype, "uploadAsset").mockImplementation(
      async (_blob, _name, subfolder) => {
        vi.spyOn(storage, "writeRecord").mockRejectedValue(
          new Error("disk full after upload"),
        );
        return {
          name: "a.png",
          subfolder,
          type: "input",
          inputName: subfolder + "/a.png",
        };
      },
    );
    await generate("canvas", "node");
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(Object.values(useStore.getState().project.tasks)[0].status).toBe(
      "failed",
    );
  });
  it("continues partial downloads after reopening without history, upload, or a second POST", async () => {
    const blobs = new Map<string, Blob>();
    vi.spyOn(storage, "putBlob").mockImplementation(async (id, blob) => {
      blobs.set(id, blob);
    });
    vi.spyOn(storage, "getBlob").mockImplementation(async (id) => {
      if (!blobs.has(id)) throw new Error("missing");
      return blobs.get(id)!;
    });
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockResolvedValue({
      ...history,
      outputs: {
        "9": {
          images: [
            { filename: "first.png", type: "output" },
            { filename: "second.png", type: "output" },
          ],
        },
      },
    });
    vi.spyOn(ComfyUIClient.prototype, "getOutput").mockImplementation(
      async (file) => {
        if (file.filename === "second.png")
          throw new Error("download interrupted");
        return new Blob(["first-result"], { type: "image/png" });
      },
    );
    await generate("canvas", "node");
    const saved = (
      persistence.records.get("project-library") as ProjectLibrary
    )["p"].project;
    const task = Object.values(saved.tasks)[0];
    expect(task.status).toBe("interrupted");
    expect(task.downloadedOutputs).toHaveLength(1);
    expect(saved.assets[task.downloadedOutputs![0].asset.id]).toBeDefined();
    expect(saved.canvases[0].nodes[0].data.assetId).toBeUndefined();
    useStore.setState({
      project: migrateProject(saved, [w], defaultConnection),
    });
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockRejectedValue(
      new Error("history removed"),
    );
    const download = vi
      .spyOn(ComfyUIClient.prototype, "getOutput")
      .mockResolvedValue(new Blob(["second-result"], { type: "image/png" }));
    download.mockClear();
    await resumeTask(task.taskId);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][0].filename).toBe("second.png");
    expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
    const p = useStore.getState().project;
    expect(p.tasks[task.taskId].status).toBe("completed");
    expect(p.tasks[task.taskId].outputs).toHaveLength(2);
    expect(p.canvases[0].nodes).toHaveLength(1);
    expect(p.canvases[0].nodes[0].data.assetId).toBe(
      p.tasks[task.taskId].outputs[0],
    );
  });
});

testMissingPromptResponse();
function testMissingPromptResponse() {
  it("keeps a malformed successful submission recoverable and blocks a second Generate", async () => {
    vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockImplementation(
      queuePromptImplementation,
    );
    vi.spyOn(ComfyUIClient.prototype, "request").mockResolvedValue(
      new Response(JSON.stringify({ number: 1 }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await generate("canvas", "node");
    const task = Object.values(useStore.getState().project.tasks)[0];
    expect(task.status).toBe("interrupted");
    expect(task.promptId).toBeNull();
    await generate("canvas", "node");
    expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
    expect(
      Object.values(
        (persistence.records.get("project-library") as ProjectLibrary)["p"]
          .project.tasks,
      )[0].status,
    ).toBe("interrupted");
  });
}

describe("text node video prompts", () => {
  function setupText(text: string, localPrompt = "") {
    const workflow = structuredClone(w);
    workflow.output.kind = "video";
    useStore.setState({ workflows: [workflow] });
    const s = useStore.getState(),
      node = s.project.canvases[0].nodes[0];
    s.patchNode(node.id, {
      kind: "video",
      generation: { ...node.data.generation!, prompt: localPrompt },
    });
    s.editCanvas((c) => ({
      ...c,
      nodes: [
        ...c.nodes,
        {
          id: "text-source",
          position: { x: 0, y: 0 },
          data: { kind: "text", title: "镜头描述", text },
        },
      ],
      edges: [
        {
          id: "text-edge",
          source: "text-source",
          target: node.id,
          data: { role: "prompt", order: 123 },
        },
      ],
    }));
    vi.spyOn(ComfyUIClient.prototype, "getOutput").mockResolvedValue(
      new Blob(["video-protocol-fixture"], { type: "video/mp4" }),
    );
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockResolvedValue({
      outputs:{"9":{images:[{filename:"result.mp4",type:"output"}]}},
      status:{completed:true,status_str:"success"},
    });
  }
  it("uses connected text without a local prompt and never uploads text as media", async () => {
    setupText("一只狐狸穿过雪地");
    const upload = vi.spyOn(ComfyUIClient.prototype, "uploadAsset");
    vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockImplementation(
      async (prompt) => {
        expect(prompt["1"].inputs.text).toBe("一只狐狸穿过雪地");
        const saved = Object.values(
          (persistence.records.get("project-library") as ProjectLibrary)["p"]
            .project.tasks,
        )[0];
        expect(saved.input.texts).toEqual([
          {
            nodeId: "text-source",
            edgeId: "text-edge",
            title: "镜头描述",
            text: "一只狐狸穿过雪地",
            order: 123,
          },
        ]);
        expect(saved.input.assets).toEqual([]);
        useStore
          .getState()
          .patchNode("text-source", { text: "下一次任务的描述" });
        return "server-prompt";
      },
    );
    await generate("canvas", "node");
    const p = useStore.getState().project,
      t = Object.values(p.tasks)[0];
    expect(t.status).toBe("completed");
    expect(t.input.prompt).toBe("一只狐狸穿过雪地");
    expect(p.history[0].prompt).toBe("一只狐狸穿过雪地");
    expect(p.canvases[0].nodes).toHaveLength(2);
    expect(p.canvases[0].nodes[0].data.assetId).toBe(t.outputs[0]);
    expect(upload).not.toHaveBeenCalled();
  });
  it("appends local camera directions to connected text", async () => {
    setupText("森林里的清晨", "镜头缓慢推进");
    await generate("canvas", "node");
    expect(
      Object.values(useStore.getState().project.tasks)[0].input.prompt,
    ).toBe("森林里的清晨\n\n镜头缓慢推进");
  });
  it("rejects an empty connected text before submitting", async () => {
    setupText("   ");
    await generate("canvas", "node");
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(useStore.getState().toast).toContain("文本");
    expect(Object.keys(useStore.getState().project.tasks)).toHaveLength(0);
  });
});

describe("reference node migration", () => {
  it("persists inline tool output and restores it without another cloud query", async () => {
    const tool: WorkflowDefinition = { ...structuredClone(w), output: { nodeId: "9", field: "text", kind: "text" }, promptRequired: false };
    useStore.setState({ workflows: [tool] });
    useStore.getState().patchNode("node", { kind: "tool" });
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockResolvedValue({ outputs: { "9": { text: ["[Verse]", "Result lyrics"] } } });
    await generate("canvas", "node");
    const p = useStore.getState().project;
    const task = Object.values(p.tasks)[0];
    expect(task.status).toBe("completed");
    expect(task.outputText).toBe("[Verse]\nResult lyrics");
    expect(p.canvases[0].nodes[0].data.text).toBe(task.outputText);
    expect(p.assets[task.outputs[0]].kind).toBe("text");
    const query = vi.spyOn(ComfyUIClient.prototype, "waitForCompletion");
    const stats = vi.spyOn(ComfyUIClient.prototype, "getSystemStats");
    query.mockClear(); stats.mockClear();
    useStore.getState().patchTask(task.taskId, { status: "interrupted" });
    await resumeTask(task.taskId);
    expect(useStore.getState().project.tasks[task.taskId].status).toBe("completed");
    expect(query).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
  });
  it("downloads audio and writes it back to the original audio node", async () => {
    const audioWorkflow: WorkflowDefinition = { ...structuredClone(w), output: { nodeId: "9", field: "audio", kind: "audio" } };
    useStore.setState({ workflows: [audioWorkflow] });
    useStore.getState().patchNode("node", { kind: "audio" });
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockResolvedValue({
      outputs: { "9": { audio: [{ filename: "song.mp3", type: "output" }] } },
      status: { completed: true, status_str: "success" },
    });
    vi.spyOn(ComfyUIClient.prototype, "getOutput").mockResolvedValue(new Blob(["audio-fixture"], { type: "audio/mpeg" }));
    await generate("canvas", "node");
    const p = useStore.getState().project;
    const task = Object.values(p.tasks)[0];
    expect(task.status).toBe("completed");
    expect(p.canvases[0].nodes).toHaveLength(1);
    expect(p.canvases[0].nodes[0].data.assetId).toBe(task.outputs[0]);
    expect(p.assets[task.outputs[0]].kind).toBe("audio");
    expect(task.remoteOutputs?.[0].filename).toBe("song.mp3");
  });
  it("migrates old materials and default titles while preserving assets, edges and custom names", () => {
    const raw = structuredClone(useStore.getState().project);
    const image = {
      ...createNode("reference", 1),
      id: "source",
      data: { kind: "image", title: "图像 1", assetId: "existing" },
    };
    const custom = {
      ...image,
      id: "custom",
      data: { ...image.data, title: "角色设定.png" },
    };
    const note = createNode("text", 1);
    note.data.title = "笔记 1";
    raw.canvases[0].nodes.push(image as never, custom as never, note);
    raw.canvases[0].nodes[0].data.title = "图像生成 1";
    raw.canvases[0].edges.push({
      id: "edge",
      source: "source",
      target: "node",
      data: { role: "auto", order: 1 },
    });
    const result = migrateProject(raw);
    expect(result.canvases[0].nodes[1].data).toEqual({
      kind: "reference",
      title: "参考 1",
      assetId: "existing",
    });
    expect(result.canvases[0].nodes[2].data.title).toBe("角色设定.png");
    expect(result.canvases[0].nodes[2].data.kind).toBe("reference");
    expect(result.canvases[0].nodes[0].data.title).toBe("图像 1");
    expect(result.canvases[0].nodes[3].data.title).toBe("文本 1");
    expect(result.canvases[0].edges).toEqual(raw.canvases[0].edges);
    expect(result.canvases[0].nodes[0].data.generation).toEqual(
      raw.canvases[0].nodes[0].data.generation,
    );
    expect(migrateProject(result)).toEqual(result);
  });
});

describe("mixed custom workflow outputs", () => {
  const localBlobs = () => {
    const blobs = new Map<string, Blob>();
    vi.spyOn(storage, "putBlob").mockImplementation(async (id, blob) => { blobs.set(id, blob); });
    vi.spyOn(storage, "getBlob").mockImplementation(async id => { const blob = blobs.get(id); if (!blob) throw new Error("Missing local result"); return blob; });
    return blobs;
  };
  const outputBlob = (filename: string) => new Blob(["bytes:" + filename], { type: filename.endsWith(".mp4") ? "video/mp4" : filename.endsWith(".wav") ? "audio/wav" : filename.endsWith(".json") ? "application/json" : "image/png" });
  it.each([
    ["video", "result.gif", "image/gif", "image"],
    ["image", "result.mp4", "video/mp4", "video"],
    ["image", "result.wav", "audio/wav", "audio"],
    ["file", "result.png", "image/png", "image"],
  ] as const)("receives a %s declaration as the actual content in %s and reuses its checkpoint", async (declaredKind, filename, mime, actualKind) => {
    const blobs = localBlobs();
    const workflow = structuredClone(w);
    workflow.output.kind = declaredKind;
    useStore.setState({ workflows: [workflow] });
    useStore.getState().patchNode("node", { kind: declaredKind === "file" ? "tool" : declaredKind === "video" ? "video" : "image-generation" });
    const file = { filename, type: "output" as const };
    const source = new Blob([new Uint8Array([0, 255, 128, 13, 10, 1])], { type: mime });
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockResolvedValue({ status: { completed: true }, outputs: { "9": { images: [file] } } });
    const download = vi.spyOn(ComfyUIClient.prototype, "getOutput").mockResolvedValue(source);

    await generate("canvas", "node");

    const project = useStore.getState().project, task = Object.values(project.tasks)[0];
    expect(task.status).toBe("completed");
    expect(task.outputs).toHaveLength(1);
    const asset = project.assets[task.outputs[0]];
    expect(asset).toMatchObject({ name: filename, kind: actualKind, mime, size: source.size });
    expect(await blobs.get(asset.id)!.arrayBuffer()).toEqual(await source.arrayBuffer());
    expect(task.remoteOutputKinds).toEqual({ [outputKey(file)]: actualKind });
    expect(project.canvases[0].nodes[0].data.assetId).toBe(asset.id);
    expect(project.history[0].outputs).toEqual([asset.id]);
    expect(download).toHaveBeenCalledTimes(1);
    useStore.getState().patchTask(task.taskId, { status: "interrupted", remoteOutputKinds: { [outputKey(file)]: declaredKind } });
    await useStore.getState().save(true);
    useStore.setState({ project: structuredClone((persistence.records.get("project-library") as ProjectLibrary).p.project) });
    download.mockClear();
    vi.mocked(ComfyUIClient.prototype.waitForCompletion).mockClear();

    await resumeTask(task.taskId);

    const resumed = useStore.getState().project.tasks[task.taskId];
    expect(resumed).toMatchObject({ status: "completed", outputs: [asset.id], remoteOutputKinds: { [outputKey(file)]: actualKind } });
    expect((persistence.records.get("project-library") as ProjectLibrary).p.project.tasks[task.taskId].remoteOutputKinds)
      .toEqual({ [outputKey(file)]: actualKind });
    expect(await blobs.get(asset.id)!.arrayBuffer()).toEqual(await source.arrayBuffer());
    expect(download).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.waitForCompletion).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
  });
  function setupMixed() {
    const mixed = structuredClone(w);
    mixed.additionalOutputs = [
      { nodeId: "10", field: "clips", kind: "video" }, { nodeId: "11", field: "sound", kind: "audio" },
      { nodeId: "12", field: "caption", kind: "text" }, { nodeId: "13", field: "attachments", kind: "file" },
      { nodeId: "14", field: "same_image", kind: "image" },
    ];
    const info: Record<string, unknown> = { ...objectInfo };
    for (const output of mixed.additionalOutputs) {
      const class_type = "CustomSaver" + output.nodeId;
      mixed.template![output.nodeId] = { class_type, inputs: { payload: ["1", 0], prefix: "original", filename_prefix: "original" } };
      info[class_type] = objectInfo.Save;
    }
    useStore.setState({ workflows: [mixed] });
    vi.spyOn(ComfyUIClient.prototype, "getObjectInfo").mockResolvedValue(info);
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockResolvedValue({ status: { completed: true }, outputs: {
      "9": { images: [{ filename: "result.png", type: "output" }] }, "10": { clips: [{ filename: "result.mp4", type: "output" }] },
      "11": { sound: [{ filename: "result.wav", type: "output" }] }, "12": { caption: ["Generated caption", "Second line"] },
      "13": { attachments: [{ filename: "report.json", type: "output" }] }, "14": { same_image: [{ filename: "result.png", type: "output" }] },
    } });
    return mixed;
  }
  it("downloads mixed output types once, stores every result on the original node, and resumes from local checkpoints", async () => {
    localBlobs(); setupMixed();
    const download = vi.spyOn(ComfyUIClient.prototype, "getOutput").mockImplementation(async file => outputBlob(file.filename));
    await generate("canvas", "node");
    const project = useStore.getState().project, task = Object.values(project.tasks)[0];
    expect(task.status).toBe("completed"); expect(download).toHaveBeenCalledTimes(4);
    expect(task.outputs.map(id => project.assets[id].kind)).toEqual(["image", "video", "audio", "file", "text"]);
    expect(project.assets[task.outputs[3]].mime).toBe("application/json");
    expect(project.canvases[0].nodes).toHaveLength(1); expect(project.canvases[0].nodes[0].data.assetId).toBe(task.outputs[0]);
    expect(project.history[0].outputs).toEqual(task.outputs); expect(task.remoteOutputs).toHaveLength(4);
    expect(Object.values(task.remoteOutputKinds ?? {})).toEqual(["image", "video", "audio", "file"]);
    expect(task.outputText).toBe("Generated caption\nSecond line"); expect(task.outputTextAsset?.id).toBe(task.outputs[4]); expect(task.outputTextFirst).toBe(false);
    expect(task.executionWorkflow?.["10"].inputs.filename_prefix).toMatch(/\/result-output-1$/);
    expect(task.executionWorkflow?.["13"]).toBeDefined();
    const previousOutputs = [...task.outputs]; download.mockClear();
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockRejectedValue(new Error("History removed"));
    useStore.getState().patchTask(task.taskId, { status: "interrupted" });
    await resumeTask(task.taskId);
    expect(useStore.getState().project.tasks[task.taskId].status).toBe("completed");
    expect(useStore.getState().project.tasks[task.taskId].outputs).toEqual(previousOutputs); expect(download).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
  });
  it("persists mixed result kinds and inline text before partial downloads and resumes only missing files", async () => {
    localBlobs(); const mixed = setupMixed();
    vi.spyOn(ComfyUIClient.prototype, "getOutput").mockImplementation(async file => { if (file.filename === "result.mp4") throw new Error("Download interrupted"); return outputBlob(file.filename); });
    await generate("canvas", "node");
    const saved = (persistence.records.get("project-library") as ProjectLibrary)["p"].project;
    const task = Object.values(saved.tasks)[0];
    expect(task.status).toBe("interrupted"); expect(task.downloadedOutputs).toHaveLength(1); expect(task.outputTextAsset).toBeDefined();
    expect(task.remoteOutputs).toHaveLength(4); expect(Object.values(task.remoteOutputKinds ?? {})).toEqual(["image", "video", "audio", "file"]);
    useStore.setState({ project: migrateProject(saved, [mixed], defaultConnection) });
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockRejectedValue(new Error("History removed"));
    const download = vi.spyOn(ComfyUIClient.prototype, "getOutput").mockImplementation(async file => outputBlob(file.filename)); download.mockClear();
    await resumeTask(task.taskId);
    expect(download.mock.calls.map(call => call[0].filename)).toEqual(["result.mp4", "result.wav", "report.json"]);
    const completed = useStore.getState().project.tasks[task.taskId]; expect(completed.status).toBe("completed"); expect(completed.outputs).toHaveLength(5);
    expect(completed.outputTextAsset?.id).toBe(task.outputTextAsset?.id); expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
  });
  it("keeps the primary text asset first when another branch produces an image", async () => {
    localBlobs(); const mixed = setupMixed();
    mixed.output = { nodeId: "12", field: "caption", kind: "text" };
    mixed.additionalOutputs = [{ nodeId: "9", field: "images", kind: "image" }]; useStore.setState({ workflows: [mixed] });
    useStore.getState().patchNode("node", { kind: "tool" });
    vi.spyOn(ComfyUIClient.prototype, "getOutput").mockImplementation(async file => outputBlob(file.filename));
    await generate("canvas", "node");
    const project = useStore.getState().project, task = Object.values(project.tasks)[0];
    expect(task.status).toBe("completed"); expect(task.outputs.map(id => project.assets[id].kind)).toEqual(["text", "image"]);
    expect(project.canvases[0].nodes[0].data.text).toBe("Generated caption\nSecond line"); expect(task.outputTextFirst).toBe(true);
  });
  it("runs automatic custom outputs without field bindings and preserves actual media kinds through resume", async () => {
    localBlobs(); const automatic = setupMixed();
    automatic.output = { nodeId: "9", field: "*", kind: "file" };
    automatic.additionalOutputs = automatic.additionalOutputs?.map(output => ({ ...output, field: "*", kind: "file" }));
    useStore.setState({ workflows: [automatic] }); useStore.getState().patchNode("node", { kind: "tool" });
    const download = vi.spyOn(ComfyUIClient.prototype, "getOutput").mockImplementation(async file => outputBlob(file.filename));
    await generate("canvas", "node");
    const project = useStore.getState().project, task = Object.values(project.tasks)[0];
    expect(task.status).toBe("completed"); expect(task.outputs.map(id => project.assets[id].kind)).toEqual(["image", "video", "audio", "file", "text"]);
    expect(task.remoteAutomaticFiles).toHaveLength(4); expect(download).toHaveBeenCalledTimes(4);
    expect(project.canvases[0].nodes[0].data.assetId).toBe(task.outputs[0]);
    const outputs = [...task.outputs]; download.mockClear(); useStore.getState().patchTask(task.taskId, { status: "interrupted" });
    await resumeTask(task.taskId);
    expect(useStore.getState().project.tasks[task.taskId].outputs).toEqual(outputs); expect(download).not.toHaveBeenCalled();
  });
  it("uses actual automatic JSON results as a text asset without pretending progress alone is a result", async () => {
    localBlobs(); const automatic = structuredClone(w); automatic.output = { nodeId: "9", field: "*", kind: "file" };
    useStore.setState({ workflows: [automatic] }); useStore.getState().patchNode("node", { kind: "tool" });
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockResolvedValue({ status: { completed: true }, outputs: { "9": { progress: 1, result: { boxes: [[0, 1, 2, 3]], confidence: .9 } } } });
    await generate("canvas", "node");
    const project = useStore.getState().project, task = Object.values(project.tasks)[0];
    expect(task.status).toBe("completed"); expect(project.assets[task.outputs[0]].kind).toBe("text");
    expect(JSON.parse(task.outputText ?? "null")).toEqual({ result: { boxes: [[0, 1, 2, 3]], confidence: .9 } });
    expect(ComfyUIClient.prototype.getOutput).not.toHaveBeenCalled();
  });
});
