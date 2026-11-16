import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApiWorkflow,
  Asset,
  Connection,
  Project,
  RemoteFile,
} from "../src/types";

const fake = vi.hoisted(() => ({
  getWorkflow: vi.fn(),
  uploadAsset: vi.fn(),
  queuePrompt: vi.fn(),
  findSubmittedPrompt: vi.fn(),
  waitForCompletion: vi.fn(),
  getOutput: vi.fn(),
  cancel: vi.fn(),
  disconnect: vi.fn(),
  getBlob: vi.fn(),
  importAsset: vi.fn(),
  save: vi.fn(),
  state: {} as any,
  clients: [] as any[],
}));
vi.mock("../src/runninghub/client", () => ({
  RunningHubClient: class {
    constructor(...args: any[]) {
      fake.clients.push(args);
    }
    getWorkflow = fake.getWorkflow;
    uploadAsset = fake.uploadAsset;
    queuePrompt = fake.queuePrompt;
    findSubmittedPrompt = fake.findSubmittedPrompt;
    waitForCompletion = fake.waitForCompletion;
    getOutput = fake.getOutput;
    cancel = fake.cancel;
    disconnect = fake.disconnect;
  },
}));
vi.mock("../src/runninghub/execution-contract", () => ({
  attachRunningHubExecutionContract: async (definition: unknown) => definition,
}));
vi.mock("../src/projects/storage", () => ({
  getBlob: (...args: unknown[]) => fake.getBlob(...args),
}));
vi.mock("../src/assets/assets", () => ({
  importAsset: (...args: unknown[]) => fake.importAsset(...args),
}));
vi.mock("../src/stores/store", () => ({
  useStore: { getState: () => fake.state },
}));
vi.mock("../src/director/upstream-host", () => ({
  normalizeDirectorWidgetValues: (values: unknown) => values,
}));

import {
  anyDirectorRunning,
  cancelDirector,
  DIRECTOR_WORKFLOW_ID,
  directorRunning,
  directorSessionId,
  readDirectorWorkflow,
  runDirector,
  uploadDirectorTimeline,
  type DirectorRun,
} from "../src/director/execution";
import { ExecutionError } from "../src/comfyui/client";

const connection: Connection = {
  name: "RH",
  baseUrl: "https://www.runninghub.cn",
  token: "fixture-private-key",
  authHeader: "",
  authPrefix: "",
  timeoutMinutes: 1,
};
const source: Asset = {
  id: "source",
  name: "photo.png",
  kind: "image",
  mime: "image/png",
  size: 8,
  createdAt: 1,
};
const graph: ApiWorkflow = {
  "12": {
    class_type: "MiniMaxH3Director",
    inputs: {
      task_type: "r2v",
      global_prompt: "website example prompt",
      timeline_data: "",
      model: ["1", 0],
    },
  },
  "1": {
    class_type: "UNETLoader",
    inputs: { unet_name: "ref2va.safetensors" },
  },
  "20": { class_type: "SaveVideo", inputs: { video: ["12", 0] } },
  "21": { class_type: "SaveVideo", inputs: { video: ["12", 0] } },
};
const files: RemoteFile[] = [
  {
    filename: "first.mp4",
    type: "output",
    url: "https://cdn.example/results/first.mp4?signature=old",
  },
  {
    filename: "second.mp4",
    type: "output",
    url: "https://cdn.example/results/second.mp4?signature=old",
  },
];
const history = () => ({
  outputs: { "20": { files: [files[0]] }, "21": { files: [files[1]] } },
  status: { completed: true, status_str: "success" },
});
const makeOptions = () => ({
  canvasId: "canvas",
  workflowId: "12345",
  instanceType: "plus" as const,
  connection,
  snapshot: {
    values: { task_type: "r2v", global_prompt: "PRIVATE USER PROMPT" },
    timeline: { global: { prompt: "PRIVATE USER PROMPT" }, segments: [] },
  },
  media: {},
  onState: (run: DirectorRun) => {
    fake.state.project.canvases[0].director.run = run;
  },
});
const lastRun = (): DirectorRun => fake.state.project.canvases[0].director.run;
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.clearAllMocks();
  fake.clients.length = 0;
  fake.state = {
    project: {
      id: "project",
      canvases: [{ id: "canvas", director: {} }],
      assets: { source },
    },
    editProject(fn: (project: Project) => Project) {
      this.project = fn(this.project);
    },
    save: fake.save,
  };
  fake.save.mockResolvedValue(undefined);
  fake.getWorkflow.mockReset().mockResolvedValue(graph);
  fake.uploadAsset.mockReset().mockResolvedValue({
    name: "remote.png",
    subfolder: "api/asset",
    inputName: "api/asset/remote.png",
    type: "input",
  });
  fake.queuePrompt.mockReset().mockResolvedValue("accepted-task");
  fake.findSubmittedPrompt.mockReset().mockResolvedValue(null);
  fake.cancel.mockReset().mockResolvedValue(undefined);
  fake.waitForCompletion.mockReset().mockResolvedValue(history());
  fake.getOutput
    .mockReset()
    .mockImplementation(async () => new Blob(["video"], { type: "video/mp4" }));
  fake.getBlob.mockReset().mockImplementation(async () => new Blob(["cache"]));
  let next = 0;
  fake.importAsset
    .mockReset()
    .mockImplementation(async (_blob: Blob, name: string) => ({
      id: "output-" + ++next,
      name,
      kind: "video",
      mime: "video/mp4",
      size: 5,
      createdAt: 1,
    }));
});

describe("director media and recovery", () => {
  it("loads a fresh copy of the default exported graph without a remote read or saved prompts", async () => {
    const client = { getWorkflow: fake.getWorkflow };
    const first = await readDirectorWorkflow(client, DIRECTOR_WORKFLOW_ID);
    expect(fake.getWorkflow).not.toHaveBeenCalled();
    expect(first["12"].class_type).toBe("MiniMaxH3Director");
    expect(first["12"].inputs.global_prompt).toBe("");
    expect(first["12"].inputs.timeline_data).toBe("");
    first["12"].inputs.global_prompt = "MUST NOT MUTATE TEMPLATE";
    const second = await readDirectorWorkflow(client, DIRECTOR_WORKFLOW_ID);
    expect(second["12"].inputs.global_prompt).toBe("");
    expect(second).not.toBe(first);
  });

  it("uses the unchanged remote workflow reader for custom IDs and explains platform 810 without falling back", async () => {
    const client = { getWorkflow: fake.getWorkflow },
      signal = new AbortController().signal;
    expect(await readDirectorWorkflow(client, "12345", signal)).toBe(graph);
    expect(fake.getWorkflow).toHaveBeenCalledWith("12345", signal);
    fake.getWorkflow.mockRejectedValueOnce(
      new Error("RunningHub WORKFLOW_NOT_SAVED_OR_NOT_RUNNING（810）"),
    );
    await expect(readDirectorWorkflow(client, "999", signal)).rejects.toThrow(
      "请在 RunningHub 官网手动保存并运行这份工作流",
    );
    expect(fake.getWorkflow).toHaveBeenCalledTimes(2);
    expect(fake.queuePrompt).not.toHaveBeenCalled();
  });

  it("preserves a create-time platform 810 failure and does not switch IDs or retry", async () => {
    fake.queuePrompt.mockRejectedValueOnce(
      new ExecutionError(
        "RunningHub 提交失败（810）：WORKFLOW_NOT_SAVED_OR_NOT_RUNNING",
      ),
    );
    await runDirector(makeOptions());
    expect(lastRun().status).toBe("failed");
    expect(lastRun().message).toContain(
      "请在 RunningHub 官网手动保存并运行这份工作流",
    );
    expect(lastRun().workflowId).toBe("12345");
    expect(fake.queuePrompt).toHaveBeenCalledTimes(1);
    expect(fake.waitForCompletion).not.toHaveBeenCalled();
  });

  it("retains full uploaded relative paths and deduplicates references already containing their folder", async () => {
    const timeline = {
      global: {
        refs: [
          {
            index: 0,
            imageFile: "local/photo.png",
            subfolder: "local",
            fileName: "photo.png",
          },
        ],
      },
      segments: [{ genImage: { imageFile: "photo.png", subfolder: "local" } }],
    };
    const original = structuredClone(timeline);
    const updated = await uploadDirectorTimeline(
      timeline,
      { "local/photo.png": "source" },
      { source },
      fake.uploadAsset,
    );
    expect(updated.global.refs[0]).toMatchObject({
      imageFile: "api/asset/remote.png",
      subfolder: "api/asset",
      fileName: "remote.png",
    });
    expect(updated.segments[0].genImage.imageFile).toBe("api/asset/remote.png");
    expect(fake.uploadAsset).toHaveBeenCalledTimes(1);
    expect(timeline).toEqual(original);
  });

  it("recovers an accepted ID after a submission response error without submitting again", async () => {
    fake.queuePrompt.mockRejectedValue(
      new Error("accepted response metadata invalid"),
    );
    fake.findSubmittedPrompt.mockResolvedValue("accepted-task");
    await runDirector(makeOptions());
    expect(fake.queuePrompt).toHaveBeenCalledTimes(1);
    expect(fake.findSubmittedPrompt).toHaveBeenCalledWith(
      fake.queuePrompt.mock.calls[0][1],
    );
    expect(fake.waitForCompletion.mock.calls[0][0]).toBe("accepted-task");
    expect(lastRun().status).toBe("completed");
    expect(lastRun().receipt).toMatchObject({
      taskId: "accepted-task",
      instanceType: "plus",
      outputs: [
        { nodeId: "20", field: "*", kind: "video" },
        { nodeId: "21", field: "*", kind: "video" },
      ],
    });
    const saved = JSON.stringify(lastRun());
    expect(saved).not.toContain("PRIVATE USER PROMPT");
    expect(saved).not.toContain("website example prompt");
    expect(saved).not.toContain(connection.token);
    expect(saved).not.toContain("signature=old");
  });

  it("preserves partial downloads and resumes with the receipt without loading, uploading or resubmitting the workflow", async () => {
    fake.getOutput
      .mockResolvedValueOnce(new Blob(["first"]))
      .mockRejectedValueOnce(new Error("download disconnected"));
    await runDirector(makeOptions());
    const partial = structuredClone(lastRun());
    expect(partial.status).toBe("interrupted");
    expect(partial.outputIds).toEqual(["output-1"]);
    expect(partial.receipt?.downloads).toHaveLength(1);
    fake.getWorkflow
      .mockClear()
      .mockRejectedValue(new Error("workflow deleted"));
    fake.queuePrompt.mockClear();
    fake.uploadAsset.mockClear();
    fake.getOutput.mockClear();
    fake.waitForCompletion.mockResolvedValue({
      ...history(),
      outputs: {
        "20": {
          files: [
            {
              ...files[0],
              url: "https://cdn.example/results/first.mp4?signature=new",
            },
          ],
        },
        "21": { files: [files[1]] },
      },
    });
    await runDirector({
      ...makeOptions(),
      snapshot: { values: {}, timeline: {} },
      resumeTaskId: partial.taskId,
      resumeRun: partial,
    });
    expect(lastRun().status).toBe("completed");
    expect(lastRun().outputIds).toEqual(["output-1", "output-2"]);
    expect(fake.getOutput).toHaveBeenCalledTimes(1);
    expect(fake.getOutput.mock.calls[0][0].filename).toBe("second.mp4");
    expect(fake.getWorkflow).not.toHaveBeenCalled();
    expect(fake.queuePrompt).not.toHaveBeenCalled();
    expect(fake.uploadAsset).not.toHaveBeenCalled();
    expect(fake.importAsset).toHaveBeenCalledTimes(2);
    expect(fake.save).toHaveBeenCalled();
    expect(anyDirectorRunning()).toBe(false);
    expect(directorRunning("canvas")).toBe(false);
  });

  it("redownloads an output whose cached blob is missing", async () => {
    await runDirector(makeOptions());
    const completed = structuredClone(lastRun());
    fake.getBlob.mockImplementation(async (id: string) => {
      if (id === "output-1") throw new Error("missing");
      return new Blob(["cache"]);
    });
    fake.getOutput.mockClear();
    await runDirector({
      ...makeOptions(),
      resumeTaskId: completed.taskId,
      resumeRun: completed,
    });
    expect(fake.getOutput).toHaveBeenCalledTimes(1);
    expect(lastRun().outputIds).toEqual(["output-3", "output-2"]);
  });

  it.each(["failed", "cancelled"] as const)(
    "preserves remote terminal state %s and permits an explicit new run",
    async (status) => {
      fake.waitForCompletion.mockRejectedValueOnce(
        new ExecutionError("remote terminal result", status),
      );
      await runDirector(makeOptions());
      expect(lastRun().status).toBe(status);
      expect(lastRun().taskId).toBe("accepted-task");
      expect(directorRunning("canvas")).toBe(false);
      await runDirector(makeOptions());
      expect(fake.queuePrompt).toHaveBeenCalledTimes(2);
      expect(lastRun().status).toBe("completed");
    },
  );

  it("keeps unconfirmed network errors recoverable", async () => {
    fake.waitForCompletion.mockRejectedValueOnce(
      new Error("network disconnected"),
    );
    await runDirector(makeOptions());
    expect(lastRun().status).toBe("interrupted");
    expect(lastRun().taskId).toBe("accepted-task");
  });

  it("marks a server-confirmed user cancellation terminal", async () => {
    let ready!: () => void;
    const polling = new Promise<void>((resolve) => {
      ready = resolve;
    });
    fake.waitForCompletion.mockImplementationOnce(
      (_id, _state, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          ready();
        }),
    );
    const pending = runDirector(makeOptions());
    await polling;
    await cancelDirector("canvas");
    await pending;
    expect(fake.cancel).toHaveBeenCalledWith("accepted-task");
    expect(lastRun().status).toBe("cancelled");
    expect(anyDirectorRunning()).toBe(false);
  });

  it("cancels a task accepted after the user stopped an in-flight submission", async () => {
    let ready!: () => void, accept!: (id: string) => void;
    const submitting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    fake.queuePrompt.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          accept = resolve;
          ready();
        }),
    );
    const pending = runDirector(makeOptions());
    await submitting;
    await cancelDirector("canvas");
    accept("late-accepted-task");
    await pending;
    expect(fake.cancel).toHaveBeenCalledWith("late-accepted-task");
    expect(fake.waitForCompletion).not.toHaveBeenCalled();
    expect(lastRun().status).toBe("cancelled");
    expect(lastRun().taskId).toBe("late-accepted-task");
  });
});

function addDirectorNodes() {
  fake.state.project.canvases[0].nodes = ["director-a", "director-b"].map(
    (id, index) => ({
      id,
      type: "director",
      position: { x: index * 2000, y: 80 },
      width: 1160,
      height: 900,
      data: { kind: "director", title: id, director: {} },
    }),
  );
  fake.state.project.canvases[0].edges = [];
}
function nodeOptions(nodeId: string) {
  return {
    ...makeOptions(),
    nodeId,
    onState: (run: DirectorRun) => {
      const node = fake.state.project.canvases[0].nodes.find(
        (item: any) => item.id === nodeId,
      );
      if (node) node.data.director.run = run;
    },
  };
}
const nodeRun = (nodeId: string): DirectorRun =>
  fake.state.project.canvases[0].nodes.find((item: any) => item.id === nodeId)
    .data.director.run;

describe("director node execution scope", () => {
  it("runs two directors on one canvas independently and cancels only the selected node", async () => {
    addDirectorNodes();
    fake.queuePrompt
      .mockResolvedValueOnce("task-a")
      .mockResolvedValueOnce("task-b");
    const pendingTasks = new Map<string, (history: unknown) => void>();
    let ready!: () => void;
    const bothPolling = new Promise<void>((resolve) => {
      ready = resolve;
    });
    fake.waitForCompletion.mockImplementation(
      (id: string, _state, signal: AbortSignal) =>
        new Promise((resolve, reject) => {
          pendingTasks.set(id, resolve);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          if (pendingTasks.size === 2) ready();
        }),
    );
    const first = runDirector(nodeOptions("director-a")),
      second = runDirector(nodeOptions("director-b"));
    await bothPolling;
    expect(directorRunning("canvas", "director-a")).toBe(true);
    expect(directorRunning("canvas", "director-b")).toBe(true);
    expect(directorRunning("canvas")).toBe(false);
    await runDirector(nodeOptions("director-a"));
    expect(fake.queuePrompt).toHaveBeenCalledTimes(2);
    await cancelDirector("canvas", "director-a");
    await first;
    expect(fake.cancel).toHaveBeenCalledTimes(1);
    expect(fake.cancel).toHaveBeenCalledWith("task-a");
    expect(nodeRun("director-a").status).toBe("cancelled");
    expect(directorRunning("canvas", "director-b")).toBe(true);
    pendingTasks.get("task-b")!(history());
    await second;
    expect(nodeRun("director-b").status).toBe("completed");
    const canvas = fake.state.project.canvases[0];
    expect(
      canvas.nodes.filter((node: any) => node.data.directorOutput),
    ).toHaveLength(2);
    expect(canvas.edges.map((edge: any) => edge.source)).toEqual([
      "director-b",
      "director-b",
    ]);
    expect(canvas.director.run).toBeUndefined();
    expect(anyDirectorRunning()).toBe(false);
  });

  it("reads the node's saved receipt on resume and repairs cached result nodes without duplication", async () => {
    addDirectorNodes();
    fake.getOutput
      .mockResolvedValueOnce(new Blob(["first"]))
      .mockRejectedValueOnce(new Error("download disconnected"));
    await runDirector(nodeOptions("director-a"));
    const partial = structuredClone(nodeRun("director-a"));
    expect(partial.status).toBe("interrupted");
    const canvas = fake.state.project.canvases[0],
      originalResult = canvas.nodes.find(
        (node: any) =>
          node.data.directorOutput && node.data.assetId === "output-1",
      );
    expect(originalResult).toBeDefined();
    expect(originalResult.position.x).toBe(1300);
    // The other director and legacy canvas receipt must never be consulted.
    canvas.director.run = {
      taskId: "wrong-task",
      workflowId: "wrong-workflow",
    };
    canvas.nodes.find(
      (node: any) => node.id === "director-b",
    ).data.director.run = { taskId: "other-task", status: "queued" };
    canvas.edges = [];
    fake.getWorkflow.mockClear();
    fake.queuePrompt.mockClear();
    fake.getOutput.mockClear();
    fake.uploadAsset.mockClear();
    await runDirector({
      ...nodeOptions("director-a"),
      snapshot: { values: {}, timeline: {} },
      resumeTaskId: partial.taskId,
    });
    expect(nodeRun("director-a").status).toBe("completed");
    expect(nodeRun("director-b").taskId).toBe("other-task");
    expect(fake.getWorkflow).not.toHaveBeenCalled();
    expect(fake.queuePrompt).not.toHaveBeenCalled();
    expect(fake.uploadAsset).not.toHaveBeenCalled();
    expect(fake.getOutput).toHaveBeenCalledTimes(1);
    const completeCanvas = fake.state.project.canvases[0];
    expect(
      completeCanvas.nodes.filter((node: any) => node.data.directorOutput),
    ).toHaveLength(2);
    expect(
      completeCanvas.nodes.find(
        (node: any) =>
          node.data.directorOutput && node.data.assetId === "output-1",
      ).id,
    ).toBe(originalResult.id);
    expect(completeCanvas.edges).toHaveLength(2);
    fake.getOutput.mockClear();
    await runDirector({
      ...nodeOptions("director-a"),
      resumeTaskId: partial.taskId,
    });
    expect(fake.getOutput).not.toHaveBeenCalled();
    expect(
      fake.state.project.canvases[0].nodes.filter(
        (node: any) => node.data.directorOutput,
      ),
    ).toHaveLength(2);
  });

  it("replaces a missing output blob on its existing result node and retains its user-moved position", async () => {
    addDirectorNodes();
    await runDirector(nodeOptions("director-a"));
    const completed = structuredClone(nodeRun("director-a"));
    const result = fake.state.project.canvases[0].nodes.find(
      (node: any) =>
        node.data.directorOutput && node.data.assetId === "output-1",
    );
    result.position = { x: 5000, y: 1234 };
    fake.getBlob.mockImplementation(async (id: string) => {
      if (id === "output-1") throw new Error("missing");
      return new Blob(["cache"]);
    });
    await runDirector({
      ...nodeOptions("director-a"),
      resumeTaskId: completed.taskId,
    });
    const canvas = fake.state.project.canvases[0],
      replaced = canvas.nodes.find((node: any) => node.id === result.id);
    expect(replaced.data.assetId).toBe("output-3");
    expect(replaced.position).toEqual({ x: 5000, y: 1234 });
    expect(
      canvas.nodes.filter((node: any) => node.data.directorOutput),
    ).toHaveLength(2);
    expect(canvas.edges).toHaveLength(2);
  });
});

describe("director node lifetime", () => {
  it("separates identical node IDs on different canvases", () => {
    expect(directorSessionId("canvas-a", "same-node")).not.toBe(
      directorSessionId("canvas-b", "same-node"),
    );
    expect(directorSessionId("canvas-a")).toBe("canvas-a");
    expect(directorSessionId(directorSessionId("canvas-a", "node"))).toBe(
      directorSessionId("canvas-a", "node"),
    );
  });
  it.each(["project", "canvas", "node"])(
    "ignores late results when the owning %s no longer exists",
    async (scope) => {
      addDirectorNodes();
      let ready!: () => void, finish!: (value: unknown) => void;
      const polling = new Promise<void>((resolve) => {
        ready = resolve;
      });
      fake.waitForCompletion.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
            ready();
          }),
      );
      const options = nodeOptions("director-a"),
        onState = vi.fn(options.onState);
      const pending = runDirector({ ...options, onState });
      await polling;
      onState.mockClear();
      if (scope === "project") fake.state.project.id = "different-project";
      if (scope === "canvas") fake.state.project.canvases = [];
      if (scope === "node")
        fake.state.project.canvases[0].nodes =
          fake.state.project.canvases[0].nodes.filter(
            (node: any) => node.id !== "director-a",
          );
      finish(history());
      await pending;
      expect(onState).not.toHaveBeenCalled();
      expect(fake.getOutput).not.toHaveBeenCalled();
      expect(fake.importAsset).not.toHaveBeenCalled();
      expect(anyDirectorRunning()).toBe(false);
    },
  );
});

describe("director result source handle", () => {
  it("exposes the last result on its own director and restores a missing legacy source asset without duplicate nodes", async () => {
    addDirectorNodes();
    await runDirector(nodeOptions("director-a"));
    let canvas = fake.state.project.canvases[0];
    const director = canvas.nodes.find((node: any) => node.id === "director-a");
    expect(director.data.assetId).toBe("output-2");
    expect(
      canvas.nodes.find((node: any) => node.id === "director-b").data.assetId,
    ).toBeUndefined();
    expect(director.position).toEqual({ x: 0, y: 80 });
    expect(director.width).toBe(1160);
    const resultPositions = canvas.nodes
      .filter((node: any) => node.data.directorOutput)
      .map((node: any) => ({ id: node.id, position: node.position }));
    const completed = structuredClone(nodeRun("director-a"));
    delete director.data.assetId;
    fake.getOutput.mockClear();
    await runDirector({
      ...nodeOptions("director-a"),
      resumeTaskId: completed.taskId,
    });
    canvas = fake.state.project.canvases[0];
    expect(
      canvas.nodes.find((node: any) => node.id === "director-a").data.assetId,
    ).toBe("output-2");
    expect(
      canvas.nodes
        .filter((node: any) => node.data.directorOutput)
        .map((node: any) => ({ id: node.id, position: node.position })),
    ).toEqual(resultPositions);
    expect(canvas.edges).toHaveLength(2);
    expect(fake.getOutput).not.toHaveBeenCalled();
  });
  it("advances the source handle to the new task result while retaining older results", async () => {
    addDirectorNodes();
    fake.queuePrompt
      .mockResolvedValueOnce("first-task")
      .mockResolvedValueOnce("second-task");
    await runDirector(nodeOptions("director-a"));
    expect(
      fake.state.project.canvases[0].nodes.find(
        (node: any) => node.id === "director-a",
      ).data.assetId,
    ).toBe("output-2");
    await runDirector(nodeOptions("director-a"));
    const canvas = fake.state.project.canvases[0];
    expect(
      canvas.nodes.find((node: any) => node.id === "director-a").data.assetId,
    ).toBe("output-4");
    expect(
      canvas.nodes.filter((node: any) => node.data.directorOutput),
    ).toHaveLength(4);
    expect(canvas.edges).toHaveLength(4);
  });
});

describe("director submission lifetime guards", () => {
  it("does not start a request for a removed director", async () => {
    addDirectorNodes();
    fake.state.project.canvases[0].nodes = [];
    await runDirector(nodeOptions("director-a"));
    expect(fake.getWorkflow).not.toHaveBeenCalled();
    expect(fake.uploadAsset).not.toHaveBeenCalled();
    expect(fake.queuePrompt).not.toHaveBeenCalled();
    expect(anyDirectorRunning()).toBe(false);
  });
  it.each(["read", "blob", "upload", "save"] as const)(
    "does not submit after the director is deleted during %s",
    async (stage) => {
      addDirectorNodes();
      let entered!: () => void, finish!: (value?: any) => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const hold = () =>
        new Promise((resolve) => {
          finish = resolve;
          entered();
        });
      if (stage === "read") fake.getWorkflow.mockImplementationOnce(hold);
      if (stage === "blob") fake.getBlob.mockImplementationOnce(hold);
      if (stage === "upload") fake.uploadAsset.mockImplementationOnce(hold);
      if (stage === "save") fake.save.mockImplementationOnce(hold);
      const options = nodeOptions("director-a");
      const pending = runDirector({
        ...options,
        media: { "local/photo.png": "source" },
        snapshot: {
          ...options.snapshot,
          timeline: {
            ...options.snapshot.timeline,
            global: {
              prompt: "PRIVATE USER PROMPT",
              refs: [{ imageFile: "local/photo.png" }],
            },
          },
        },
      });
      await waiting;
      fake.state.project.canvases[0].nodes =
        fake.state.project.canvases[0].nodes.filter(
          (node: any) => node.id !== "director-a",
        );
      finish(
        stage === "read"
          ? graph
          : stage === "blob"
            ? new Blob(["image"])
            : stage === "upload"
              ? {
                  name: "remote.png",
                  subfolder: "api/asset",
                  inputName: "api/asset/remote.png",
                  type: "input",
                }
              : undefined,
      );
      await pending;
      expect(fake.queuePrompt).not.toHaveBeenCalled();
      expect(fake.waitForCompletion).not.toHaveBeenCalled();
      expect(fake.getOutput).not.toHaveBeenCalled();
      if (stage === "read" || stage === "blob")
        expect(fake.uploadAsset).not.toHaveBeenCalled();
      expect(anyDirectorRunning()).toBe(false);
    },
  );
  it("uses startup asset metadata and survives selection changes while the owning node remains", async () => {
    addDirectorNodes();
    let entered!: () => void, finish!: (value: ApiWorkflow) => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fake.getWorkflow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          entered();
        }),
    );
    const options = nodeOptions("director-a");
    const pending = runDirector({
      ...options,
      media: { "local/photo.png": "source" },
      snapshot: {
        ...options.snapshot,
        timeline: {
          ...options.snapshot.timeline,
          global: {
            prompt: "PRIVATE USER PROMPT",
            refs: [{ imageFile: "local/photo.png" }],
          },
        },
      },
    });
    await waiting;
    fake.state.selectedId = "director-b";
    fake.state.project.activeCanvasId = "some-other-canvas";
    fake.state.project.assets = {
      ...fake.state.project.assets,
      source: { ...source, name: "new-selection.png" },
    };
    finish(graph);
    await pending;
    expect(fake.uploadAsset.mock.calls[0][1]).toBe("photo.png");
    expect(fake.queuePrompt).toHaveBeenCalledTimes(1);
    expect(nodeRun("director-a").status).toBe("completed");
  });
});

describe("director shared upload identity", () => {
  it("finds another director's asset by its canonical path when the node-local media map is absent", async () => {
    const timeline = {
      global: {
        refs: [
          {
            imageFile: "canvas/source/photo.png",
            subfolder: "canvas/source",
            fileName: "photo.png",
          },
        ],
      },
      segments: [
        { refs: [{ imageFile: "photo.png", subfolder: "canvas/source" }] },
      ],
    };
    const result = await uploadDirectorTimeline(
      timeline,
      {},
      { source },
      fake.uploadAsset,
    );
    expect(result.global.refs[0].imageFile).toBe("api/asset/remote.png");
    expect(result.segments[0].refs[0].imageFile).toBe("api/asset/remote.png");
    expect(fake.uploadAsset).toHaveBeenCalledTimes(1);
  });
});

describe("director result localization", () => {
  it("prefetches two missing files while keeping import and canvas placement in output order", async () => {
    addDirectorNodes();
    const complete = new Map<string, (blob: Blob) => void>();
    let ready!: () => void;
    const bothDownloading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    fake.getOutput.mockImplementation(
      (file: RemoteFile) =>
        new Promise((resolve) => {
          complete.set(file.filename, resolve);
          if (complete.size === 2) ready();
        }),
    );
    const pending = runDirector(nodeOptions("director-a"));
    await bothDownloading;
    expect(fake.importAsset).not.toHaveBeenCalled();
    expect(nodeRun("director-a").status).toBe("saving");
    expect(nodeRun("director-a").syncPhase).toBe("download");
    complete.get("second.mp4")!(new Blob(["video"], { type: "video/mp4" }));
    await Promise.resolve();
    expect(fake.importAsset).not.toHaveBeenCalled();
    complete.get("first.mp4")!(new Blob(["video"], { type: "video/mp4" }));
    await pending;
    expect(fake.importAsset.mock.calls.map((call) => call[1])).toEqual([
      "first.mp4",
      "second.mp4",
    ]);
    expect(nodeRun("director-a").status).toBe("completed");
    expect(fake.state.project.canvases[0].edges).toHaveLength(2);
  });

  it("recovers reordered outputs and old indexed receipts without downloading or duplicating moved nodes", async () => {
    addDirectorNodes();
    fake.waitForCompletion.mockResolvedValue({
      ...history(),
      outputs: { "20": { files } },
    });
    await runDirector(nodeOptions("director-a"));
    const canvas = fake.state.project.canvases[0],
      run = nodeRun("director-a");
    run.receipt!.downloads.forEach((item, index) => {
      item.key = JSON.stringify([index, ...JSON.parse(item.key)]);
    });
    const results = canvas.nodes.filter(
      (node: any) => node.data.directorOutput,
    );
    results.forEach((node: any, index: number) => {
      node.data.directorOutput.fileKey = JSON.stringify([
        index,
        ...JSON.parse(node.data.directorOutput.fileKey),
      ]);
      node.position = { x: 9000, y: index * 1000 };
    });
    const positions = results.map((node: any) => ({
      id: node.id,
      position: node.position,
    }));
    fake.getOutput.mockClear();
    fake.waitForCompletion.mockResolvedValue({
      ...history(),
      outputs: {
        "20": {
          files: [...files]
            .reverse()
            .map((file) => ({ ...file, url: file.url!.replace("old", "new") })),
        },
      },
    });
    await runDirector({
      ...nodeOptions("director-a"),
      resumeTaskId: run.taskId,
    });
    expect(fake.getOutput).not.toHaveBeenCalled();
    const next = fake.state.project.canvases[0];
    expect(
      next.nodes
        .filter((node: any) => node.data.directorOutput)
        .map((node: any) => ({ id: node.id, position: node.position })),
    ).toEqual(positions);
    expect(next.edges).toHaveLength(2);
    expect(
      nodeRun("director-a").receipt!.downloads.every(
        (item) => JSON.parse(item.key).length === 4,
      ),
    ).toBe(true);
  });

  it("redownloads a nonempty but truncated cached file", async () => {
    await runDirector(makeOptions());
    const run = structuredClone(lastRun());
    fake.getBlob.mockImplementation(
      async (id: string) => new Blob([id === "output-1" ? "bad" : "cache"]),
    );
    fake.getOutput.mockClear();
    await runDirector({
      ...makeOptions(),
      resumeTaskId: run.taskId,
      resumeRun: run,
    });
    expect(fake.getOutput).toHaveBeenCalledTimes(1);
    expect(fake.getOutput.mock.calls[0][0].filename).toBe("first.mp4");
    expect(lastRun().outputIds).toEqual(["output-3", "output-2"]);
  });

  it.each([
    new Blob([]),
    new Blob(["<html>error</html>"], { type: "text/html" }),
    new Blob(['{"error":"unavailable"}'], { type: "application/json" }),
  ])(
    "keeps an empty or error-page result recoverable without importing it",
    async (blob) => {
      fake.getOutput.mockResolvedValue(blob);
      await runDirector(makeOptions());
      expect(lastRun().status).toBe("interrupted");
      expect(lastRun().taskId).toBe("accepted-task");
      expect(lastRun().receipt!.downloads).toEqual([]);
      expect(fake.importAsset).not.toHaveBeenCalled();
      expect(lastRun().timing?.completedAt).toBeUndefined();
    },
  );

  it("stops a local download without trying to cancel the already completed remote task", async () => {
    let ready!: () => void;
    const downloading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    fake.getOutput.mockImplementation(
      (_file, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          ready();
        }),
    );
    const pending = runDirector(makeOptions());
    await downloading;
    await cancelDirector("canvas");
    await pending;
    expect(fake.cancel).not.toHaveBeenCalled();
    expect(lastRun().status).toBe("interrupted");
    expect(lastRun().taskId).toBe("accepted-task");
    expect(fake.importAsset).not.toHaveBeenCalled();
  });
});

describe("director selection and timing", () => {
  it("checkpoints the starting run selection before remote submission even if the caller edits its later UI snapshot", async () => {
    const options = makeOptions();
    options.snapshot.timeline = {
      global: { prompt: "draft" },
      segments: [{}, {}],
      runSelectEnabled: true,
      runSelection: [1],
    } as any;
    fake.getWorkflow.mockImplementationOnce(async () => {
      (options.snapshot.timeline as any).runSelection = [0, 1];
      return graph;
    });
    fake.queuePrompt.mockImplementationOnce(async () => {
      expect(lastRun().receipt?.runProgress).toEqual({
        segmentTotal: 1,
        timelineSegmentTotal: 2,
      });
      return "accepted-task";
    });
    await runDirector(options);
    expect(lastRun().runProgress).toEqual({
      segmentTotal: 1,
      timelineSegmentTotal: 2,
    });
    expect(lastRun().receipt?.runProgress).toEqual(lastRun().runProgress);
    expect(
      JSON.parse(fake.queuePrompt.mock.calls[0][0]["12"].inputs.timeline_data)
        .runSelection,
    ).toEqual([1]);
    expect(lastRun().outputIds).toHaveLength(2);
    expect(JSON.stringify(lastRun())).not.toContain("draft");
  });

  it.each([true, false])(
    "restores counts only from a saved run checkpoint, never today's snapshot (recorded=%s)",
    async (recorded) => {
      const options = makeOptions();
      options.snapshot.timeline = {
        global: { prompt: "draft" },
        segments: [{}, {}],
        runSelectEnabled: true,
        runSelection: [1],
      } as any;
      fake.getOutput.mockRejectedValueOnce(new Error("download lost"));
      await runDirector(options);
      const partial = structuredClone(lastRun());
      expect(partial.status).toBe("interrupted");
      if (!recorded) {
        delete partial.runProgress;
        delete partial.receipt!.runProgress;
      }
      fake.getOutput.mockResolvedValue(
        new Blob(["video"], { type: "video/mp4" }),
      );
      await runDirector({
        ...makeOptions(),
        snapshot: { values: {}, timeline: { segments: [{}, {}, {}, {}, {}] } },
        resumeTaskId: partial.taskId,
        resumeRun: partial,
      });
      expect(lastRun().status).toBe("completed");
      expect(lastRun().runProgress).toEqual(
        recorded ? { segmentTotal: 1, timelineSegmentTotal: 2 } : undefined,
      );
      expect(lastRun().receipt?.runProgress).toEqual(lastRun().runProgress);
      expect(fake.queuePrompt).toHaveBeenCalledTimes(1);
    },
  );

  it.each([[], [-1, 5], [null, false, "", "wrong", 0.5]])(
    "rejects an enabled selection with no valid group before uploads or submission: %j",
    async (selection) => {
      const options = makeOptions();
      await runDirector({
        ...options,
        snapshot: {
          ...options.snapshot,
          timeline: {
            runSelectEnabled: true,
            runSelection: selection,
            segments: [{ prompt: "private group" }],
          },
        },
      });
      expect(lastRun().status).toBe("failed");
      expect(lastRun().message).toContain("请选择");
      expect(fake.uploadAsset).not.toHaveBeenCalled();
      expect(fake.queuePrompt).not.toHaveBeenCalled();
    },
  );

  it("retains unselected groups and the original selection fields in the submitted timeline", async () => {
    const options = makeOptions(),
      timeline = {
        runSelectEnabled: true,
        runSelection: [1],
        segments: [{ prompt: "not selected" }, { prompt: "selected" }],
      };
    await runDirector({
      ...options,
      snapshot: { ...options.snapshot, timeline },
    });
    expect(
      JSON.parse(fake.queuePrompt.mock.calls[0][0]["12"].inputs.timeline_data),
    ).toEqual(timeline);
    expect(lastRun().status).toBe("completed");
    expect(JSON.stringify(lastRun())).not.toContain("not selected");
  });

  it("records observed remote readiness separately from provider duration and local work", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fake.getWorkflow.mockImplementation(async () => {
      now += 5;
      return graph;
    });
    fake.queuePrompt.mockImplementation(async () => {
      now += 10;
      return "accepted-task";
    });
    fake.save.mockImplementation(async () => {
      now += 7;
    });
    fake.waitForCompletion.mockImplementation(async () => {
      now += 500;
      return {
        ...history(),
        outputs: { "20": { files: [files[0]] } },
        runningHubTiming: { providerDurationSeconds: 118 },
      };
    });
    fake.getOutput.mockImplementation(async () => {
      now += 20;
      return new Blob(["video"], { type: "video/mp4" });
    });
    fake.importAsset.mockImplementation(async (_blob: Blob, name: string) => {
      now += 30;
      return {
        id: "result",
        name,
        kind: "video",
        mime: "video/mp4",
        size: 5,
        createdAt: now,
      };
    });
    await runDirector(makeOptions());
    expect(lastRun().timing).toEqual({
      startedAt: 1000,
      submittedAt: 1022,
      remoteCompletedAt: 1529,
      completedAt: 1586,
      providerDurationSeconds: 118,
      uploadMs: 0,
      downloadMs: 20,
      importMs: 30,
      saveMs: 28,
    });
    expect(lastRun().receipt?.timing).toEqual(lastRun().timing);
  });

  it("preserves the original start, remote observation and reported duration across recovery", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fake.waitForCompletion.mockImplementationOnce(async () => {
      now = 2000;
      return {
        ...history(),
        runningHubTiming: { providerDurationSeconds: 118 },
      };
    });
    fake.getOutput.mockRejectedValueOnce(new Error("download lost"));
    await runDirector(makeOptions());
    const partial = structuredClone(lastRun());
    expect(partial.status).toBe("interrupted");
    now = 5000;
    fake.getOutput.mockResolvedValue(
      new Blob(["video"], { type: "video/mp4" }),
    );
    await runDirector({
      ...makeOptions(),
      resumeTaskId: partial.taskId,
      resumeRun: partial,
    });
    expect(lastRun().timing).toMatchObject({
      startedAt: 1000,
      submittedAt: 1000,
      remoteCompletedAt: 2000,
      providerDurationSeconds: 118,
      completedAt: 5000,
    });
    expect(fake.queuePrompt).toHaveBeenCalledTimes(1);
  });
});

describe("director media type validation", () => {
  it("does not publish a text response as the requested video even for an automatically detected output", async () => {
    fake.importAsset.mockResolvedValue({
      id: "error-body",
      name: "first.mp4",
      kind: "text",
      mime: "text/plain",
      size: 5,
      createdAt: 1,
    });
    await runDirector(makeOptions());
    expect(lastRun().status).toBe("interrupted");
    expect(lastRun().message).toContain("媒体类型");
    expect(fake.state.project.assets["error-body"]).toBeUndefined();
    expect(lastRun().outputIds).toEqual([]);
  });
});

describe("director mode validation before paid execution", () => {
  it("rejects a stale imported fl2v workspace before uploading media or submitting a remote task", async () => {
    const options = makeOptions();
    const timeline = {
      timelineMode: "fl2v",
      global: { taskType: "r2v" },
      segments: [{ prompt: "draft", refs: [{ imageFile: "local/photo.png" }] }],
    };
    const original = structuredClone(timeline);
    await runDirector({
      ...options,
      media: { "local/photo.png": "source" },
      snapshot: { values: options.snapshot.values, timeline },
    });
    expect(lastRun().status).toBe("failed");
    expect(lastRun().message).toContain("时间线还保留首尾帧模式");
    expect(fake.uploadAsset).not.toHaveBeenCalled();
    expect(fake.queuePrompt).not.toHaveBeenCalled();
    expect(timeline).toEqual(original);
  });

  it("runs only the selected family of a mixed timeline without removing cached groups or submitting extra tasks", async () => {
    const options = makeOptions();
    const confirmed = structuredClone(graph);
    confirmed["1"].inputs.unet_name = "minimax_h3_ref2va_bf16.safetensors";
    fake.getWorkflow.mockResolvedValue(confirmed);
    const timeline = {
      runSelectEnabled: true,
      runSelection: [0],
      segments: [
        { taskType: "t2v", prompt: "selected" },
        { taskType: "r2v", prompt: "cached" },
      ],
    };
    await runDirector({
      ...options,
      workflowId: "2113192715495235585",
      snapshot: {
        values: { ...options.snapshot.values, task_type: "mixed" },
        timeline,
      },
    });
    expect(lastRun().status).toBe("completed");
    expect(fake.queuePrompt).toHaveBeenCalledTimes(1);
    const submitted = fake.queuePrompt.mock.calls[0][0];
    expect(submitted["1"].inputs.unet_name).toBe(
      "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    );
    expect(JSON.parse(submitted["12"].inputs.timeline_data)).toEqual(timeline);
    expect(timeline.segments).toHaveLength(2);
  });

  it("submits the selected confirmed base model in both workflow JSON and scalar bindings", async () => {
    const options = makeOptions();
    const confirmed = structuredClone(graph);
    confirmed["1"].inputs.unet_name = "minimax_h3_ref2va_bf16.safetensors";
    fake.getWorkflow.mockResolvedValue(confirmed);
    await runDirector({
      ...options,
      workflowId: "2113192715495235585",
      snapshot: {
        ...options.snapshot,
        values: { ...options.snapshot.values, task_type: "i2v" },
      },
    });
    expect(lastRun().status).toBe("completed");
    expect(fake.queuePrompt).toHaveBeenCalledTimes(1);
    expect(fake.queuePrompt.mock.calls[0][0]["1"].inputs.unet_name).toBe(
      "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    );
    expect(fake.clients.at(-1)[2].mapping).toContainEqual({
      semantic: "director_unet",
      nodeId: "1",
      field: "unet_name",
    });
    expect(graph["1"].inputs.unet_name).toBe("ref2va.safetensors");
  });

  it("rejects cross-family mixed mode before uploading media, with no automatic second task", async () => {
    const options = makeOptions();
    await runDirector({
      ...options,
      workflowId: "2113192715495235585",
      media: { "local/photo.png": "source" },
      snapshot: {
        values: { ...options.snapshot.values, task_type: "mixed" },
        timeline: {
          segments: [
            { taskType: "t2v", prompt: "first" },
            {
              taskType: "r2v",
              prompt: "second",
              refs: [{ imageFile: "local/photo.png" }],
            },
          ],
        },
      },
    });
    expect(lastRun().status).toBe("failed");
    expect(lastRun().message).toContain("一次运行共用一个底模");
    expect(fake.uploadAsset).not.toHaveBeenCalled();
    expect(fake.queuePrompt).not.toHaveBeenCalled();
    expect(fake.getOutput).not.toHaveBeenCalled();
  });

  it("does not replace a custom base model under a trusted ID or upload its media before rejecting", async () => {
    const options = makeOptions();
    await runDirector({
      ...options,
      workflowId: "2113192715495235585",
      media: { "local/photo.png": "source" },
      snapshot: {
        values: { ...options.snapshot.values, task_type: "i2v" },
        timeline: {
          segments: [
            { prompt: "draft", refs: [{ imageFile: "local/photo.png" }] },
          ],
        },
      },
    });
    expect(lastRun().status).toBe("failed");
    expect(lastRun().message).toContain("不能自动替换自定义底模");
    expect(fake.uploadAsset).not.toHaveBeenCalled();
    expect(fake.queuePrompt).not.toHaveBeenCalled();
  });
});
