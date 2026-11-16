import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection, GenerationTask, WorkflowDefinition } from "../src/types";

const local = vi.hoisted(() => ({ records: new Map<string, unknown>() }));
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(local.records.get(key)),
  writeRecord: async (key: string, value: unknown) => { local.records.set(key, structuredClone(value)); },
  safeConnection: (value: object) => ({ ...value }), getBlob: async () => new Blob(["image"]), putBlob: async () => {},
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline fixture"); } }));
vi.mock("../src/assets/assets", () => ({ importAsset: vi.fn(async () => ({ id: "result", kind: "image", name: "result.png", mime: "image/png", size: 5, createdAt: 2 })) }));

import { RunningHubClient } from "../src/runninghub/client";
import { defaultRunningHubConnections } from "../src/compute/providers";
import { hasActiveTasks, resumeTask } from "../src/generation/pipeline";
import { createNode, useStore } from "../src/stores/store";
import { defaultConnection } from "../src/workflow/catalog";

const cn: Connection = { ...defaultRunningHubConnections.cn, token: "cn-private-fixture", name: "国内账号" };
const ai: Connection = { ...defaultRunningHubConnections.ai, token: "ai-private-fixture", name: "海外账号" };
const workflow = (site: Connection, id: string): WorkflowDefinition => ({ id, name: id, description: "", family: "Image", mode: "text-to-image", runninghub: { workflowId: "1234567890123456789", baseUrl: site.baseUrl },
  requiredInputs: [], optionalInputs: [], parameters: [], mapping: [{ semantic: "prompt", nodeId: "1", field: "prompt" }],
  template: { "1": { class_type: "ApiModel", inputs: { prompt: "author" } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } } }, output: { nodeId: "2", field: "images", kind: "image" } });

beforeEach(() => {
  vi.restoreAllMocks(); local.records.clear();
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Tests must never call remote or paid endpoints"); }));
  const node = createNode("image-generation", 1); node.id = "node"; node.data.generation = { workflowId: "cn-workflow", prompt: "自己的提示词", negativePrompt: "", params: { seed: 12 }, taskId: null, computeProvider: "runninghub" };
  node.data.assetId = "previous-result";
  useStore.setState({ ready: false, projectOpen: true, navigating: false, projects: {}, past: [], future: [], toast: "", credentialWorkflow: null, workflowCredentials: {},
    computeProvider: "runninghub", connection: defaultConnection, runningHubConnection: cn, runningHubConnections: { cn, ai }, workflows: [], runningHubWorkflows: [workflow(cn, "cn-workflow"), workflow(ai, "ai-workflow")],
    project: { version: 2, id: "project", name: "Site profiles", activeCanvasId: "canvas", scenes: [{ id: "scene", name: "场景" }], updatedAt: 1,
      canvases: [{ id: "canvas", name: "画布", sceneId: "scene", nodes: [node], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }], assets: { "previous-result": { id: "previous-result", name: "previous.png", kind: "image", mime: "image/png", size: 5, createdAt: 1 } }, tasks: {}, history: [] },
  });
  vi.spyOn(RunningHubClient.prototype, "connect").mockResolvedValue();
  vi.spyOn(RunningHubClient.prototype, "disconnect").mockImplementation(() => {});
  vi.spyOn(RunningHubClient.prototype, "queuePrompt").mockRejectedValue(new Error("Resume must never submit"));
  vi.spyOn(RunningHubClient.prototype, "waitForCompletion").mockResolvedValue({ status: { completed: true }, outputs: { "2": { images: [{ filename: "result.png", type: "output" }] } } });
  vi.spyOn(RunningHubClient.prototype, "getOutput").mockResolvedValue(new Blob(["image"], { type: "image/png" }));
});
afterEach(() => { useStore.setState({ ready: false }); expect(hasActiveTasks()).toBe(false); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("RunningHub site profiles", () => {
  it("saves CN and AI keys separately and restores the selected site's profile", async () => {
    useStore.setState({ ready: true });
    useStore.getState().setRunningHubSiteConnection("cn", { ...cn, token: "updated-cn-fixture" });
    useStore.getState().setRunningHubSiteConnection("ai", { ...ai, token: "updated-ai-fixture" });
    useStore.getState().setRunningHubSite("ai");
    expect(useStore.getState().runningHubConnection).toMatchObject({ baseUrl: ai.baseUrl, token: "updated-ai-fixture" });
    useStore.getState().setRunningHubSite("cn");
    expect(useStore.getState().runningHubConnection).toMatchObject({ baseUrl: cn.baseUrl, token: "updated-cn-fixture" });
    await vi.waitFor(() => expect(local.records.get("compute-preferences")).toMatchObject({ runningHubConnections: { cn: { token: "updated-cn-fixture" }, ai: { token: "updated-ai-fixture" } } }));
  });

  it("updates an inactive site's key without changing the current canvas, workflow, parameters or result", () => {
    const project = useStore.getState().project;
    useStore.getState().setRunningHubSiteConnection("ai", { ...ai, token: "replacement-ai-fixture" });
    expect(useStore.getState().project).toBe(project);
    expect(useStore.getState().project.canvases[0].nodes[0].data.generation).toMatchObject({ workflowId: "cn-workflow", params: { seed: 12 }, prompt: "自己的提示词" });
    expect(useStore.getState().project.canvases[0].nodes[0].data.assetId).toBe("previous-result");
    expect(useStore.getState().runningHubConnection).toEqual(cn);
    expect(useStore.getState().runningHubConnections.ai.token).toBe("replacement-ai-fixture");
  });

  it("hydrates both saved profiles and the last selected site", async () => {
    local.records.set("compute-preferences", { provider: "runninghub", runningHubConnection: ai, runningHubConnections: { cn, ai } });
    useStore.setState({ runningHubConnections: structuredClone(defaultRunningHubConnections), runningHubConnection: defaultRunningHubConnections.cn });
    await useStore.getState().hydrate();
    expect(useStore.getState().runningHubConnection).toEqual(ai);
    expect(useStore.getState().runningHubConnections).toEqual({ cn, ai });
    useStore.getState().setRunningHubSite("cn");
    expect(useStore.getState().runningHubConnection).toEqual(cn);
  });

  it.each(["cn", "ai"] as const)("migrates the old single %s profile without copying its key to the other site", async site => {
    const saved = site === "cn" ? cn : ai, other = site === "cn" ? "ai" : "cn";
    local.records.set("compute-preferences", { provider: "runninghub", runningHubConnection: saved });
    useStore.setState({ runningHubConnections: structuredClone(defaultRunningHubConnections), runningHubConnection: defaultRunningHubConnections.cn });
    await useStore.getState().hydrate();
    expect(useStore.getState().runningHubConnection).toEqual(saved);
    expect(useStore.getState().runningHubConnections[site].token).toBe(saved.token);
    expect(useStore.getState().runningHubConnections[other].token).toBe("");
  });

  it.each(["cn", "ai"] as const)("uses the persisted %s task's own site key when another site is selected", async site => {
    const owner = site === "cn" ? cn : ai, other = site === "cn" ? "ai" : "cn";
    const { token: _, ...endpoint } = owner;
    const definition = workflow(owner, site + "-workflow");
    const task: GenerationTask = { taskId: "interrupted", promptId: "already-submitted", executorType: "runninghub", requestId: "request", clientId: "client", projectId: "project", canvasId: "canvas", nodeId: "node", nodeTitle: "图像 1", createdAt: 1, updatedAt: 1, status: "interrupted", connection: endpoint, workflow: definition, input: { prompt: "自己的提示词", negativePrompt: "", params: {}, assets: [] }, outputs: [] };
    useStore.getState().createTask(task);
    useStore.getState().setRunningHubSite(other);
    await resumeTask(task.taskId);
    const query = vi.mocked(RunningHubClient.prototype.waitForCompletion);
    expect(query.mock.calls[0][0]).toBe("already-submitted");
    expect(query.mock.contexts[0].connection).toMatchObject({ baseUrl: owner.baseUrl, token: owner.token });
    expect(useStore.getState().project.tasks[task.taskId].status).toBe("completed");
    expect(useStore.getState().runningHubConnection.baseUrl).toBe(defaultRunningHubConnections[other].baseUrl);
    expect(RunningHubClient.prototype.queuePrompt).not.toHaveBeenCalled();
  });
});
