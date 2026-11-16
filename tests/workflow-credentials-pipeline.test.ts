import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { ApiWorkflow, ComputeProvider, Connection, WorkflowDefinition } from "../src/types";

const local = vi.hoisted(() => ({ records: new Map<string, unknown>(), assets: new Map<string, Blob>() }));
vi.mock("idb", () => ({ openDB: async () => ({
  get: async (store: string, key: string) => store === "assets" ? local.assets.get(key) : structuredClone(local.records.get(key)),
  put: async (store: string, value: unknown, key: string) => { if (store === "assets") local.assets.set(key, value as Blob); else local.records.set(key, structuredClone(value)); },
}) }));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline fixture"); } }));
vi.mock("../src/assets/assets", () => ({ importAsset: vi.fn(async (blob: Blob) => {
  local.assets.set("output-asset", blob);
  return { id: "output-asset", kind: "image", name: "result.png", mime: "image/png", size: blob.size, createdAt: 2 };
}) }));

import { ComfyUIClient, ExecutionError } from "../src/comfyui/client";
import { RunningHubClient } from "../src/runninghub/client";
import * as runningHubRunBindings from "../src/runninghub/run-bindings";
import { defaultRunningHubConnections } from "../src/compute/providers";
import { generate, hasActiveTasks } from "../src/generation/pipeline";
import { projectArchive } from "../src/projects/storage";
import { createNode, useStore, workflowCredentialKey, workflowCredentialValues } from "../src/stores/store";
import { defaultConnection } from "../src/workflow/catalog";
import { cleanWorkflowCredentials } from "../src/workflow/credentials";

const cloud: Connection = { ...defaultConnection, baseUrl: "https://cloud.fixture", token: "cloud-account-key" };
const cn: Connection = { ...defaultRunningHubConnections.cn, token: "rh-account-key" };
const innerKey = "workflow-private-key-fixture-74";

function definition(provider: ComputeProvider = "comfyui", id = provider + "-credential"): WorkflowDefinition {
  return cleanWorkflowCredentials({ id, name: id, family: "Image", description: "", mode: "text-to-image", requiredInputs: [], optionalInputs: [],
    ...(provider === "runninghub" ? { runninghub: { workflowId: "1234567890123456789", baseUrl: cn.baseUrl } } : {}),
    parameters: [{ key: "providerKey", label: "节点 API Key", type: "text", default: "author-example-key", secret: true, required: true }, { key: "seed", label: "种子", type: "number", default: 4 }],
    mapping: [{ semantic: "providerKey", nodeId: "1", field: "api_key" }, { semantic: "prompt", nodeId: "1", field: "prompt" }, { semantic: "seed", nodeId: "1", field: "seed" }],
    template: { "1": { class_type: "ApiModel", inputs: { api_key: "author-example-key", prompt: "author prompt", seed: 4 } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "author" } } },
    output: { nodeId: "2", field: "images", kind: "image" },
  });
}
const node = () => useStore.getState().project.canvases[0].nodes[0];
const task = () => Object.values(useStore.getState().project.tasks)[0];
function select(provider: ComputeProvider, workflow = definition(provider)) {
  // The credential tests isolate key handling; the complete AIFISHER reader
  // contract and its refusal of legacy definitions are tested separately.
  if (provider === "runninghub") vi.spyOn(runningHubRunBindings, "prepareRunningHubRun").mockImplementation(async (definition, params) => ({ workflow: definition, params }));
  useStore.setState({ computeProvider: provider, workflows: provider === "comfyui" ? [workflow] : [definition()], runningHubWorkflows: provider === "runninghub" ? [workflow] : [] });
  useStore.getState().patchNode("node", { generation: { workflowId: workflow.id, prompt: "用户自己的提示词", negativePrompt: "", params: { seed: 42 }, taskId: null, computeProvider: provider } }, "canvas");
  return workflow;
}

beforeEach(() => {
  vi.restoreAllMocks(); local.records.clear(); local.assets.clear();
  const target = createNode("image-generation", 1); target.id = "node";
  useStore.setState({ ready: false, projectOpen: true, navigating: false, projects: {}, past: [], future: [], toast: "", credentialWorkflow: null, workflowCredentials: {},
    computeProvider: "comfyui", connection: cloud, runningHubConnection: cn, runningHubConnections: { cn, ai: { ...defaultRunningHubConnections.ai } }, workflows: [], runningHubWorkflows: [],
    project: { version: 2, id: "project", name: "Credential pipeline", activeCanvasId: "canvas", scenes: [{ id: "scene", name: "场景" }], updatedAt: 1,
      canvases: [{ id: "canvas", name: "画布", sceneId: "scene", nodes: [target], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }], assets: {}, tasks: {}, history: [] },
  });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Tests must never call remote or paid endpoints"); }));
  for (const client of [ComfyUIClient, RunningHubClient]) {
    vi.spyOn(client.prototype, "connect").mockResolvedValue();
    vi.spyOn(client.prototype, "disconnect").mockImplementation(() => {});
    vi.spyOn(client.prototype, "queuePrompt").mockResolvedValue("remote-task");
    vi.spyOn(client.prototype, "waitForCompletion").mockResolvedValue({ status: { completed: true }, outputs: { "2": { images: [{ filename: "result.png", type: "output" }] } } });
    vi.spyOn(client.prototype, "getOutput").mockResolvedValue(new Blob(["image"], { type: "image/png" }));
  }
});
afterEach(() => { expect(hasActiveTasks()).toBe(false); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe.each(["comfyui", "runninghub"] as const)("%s workflow-local credentials", provider => {
  const client = provider === "runninghub" ? RunningHubClient : ComfyUIClient;
  it("opens the workflow key dialog and stops before any task or submission when a required key is missing", async () => {
    const workflow = select(provider);
    await generate("canvas", "node");
    expect(useStore.getState().credentialWorkflow?.id).toBe(workflow.id);
    expect(node().data.generationFeedback?.error).toContain("单独填写 API Key");
    expect(Object.keys(useStore.getState().project.tasks)).toHaveLength(0);
    expect(client.prototype.connect).not.toHaveBeenCalled(); expect(client.prototype.queuePrompt).not.toHaveBeenCalled();
    expect(JSON.stringify(useStore.getState().credentialWorkflow)).not.toContain("author-example-key");
  });

  it("submits the saved key in the execution graph while keeping task, parameters, history and portable exports clean", async () => {
    const workflow = select(provider);
    await useStore.getState().saveWorkflowCredentials(workflow, { "1:api_key": innerKey });
    expect(workflowCredentialValues(useStore.getState(), workflow)).toEqual({ "1:api_key": innerKey });
    await generate("canvas", "node");
    expect(task()?.status).toBe("completed");
    const submitted = vi.mocked(client.prototype.queuePrompt).mock.calls[0]?.[0] as ApiWorkflow;
    expect(submitted["1"].inputs.api_key).toBe(innerKey);
    expect(submitted["1"].inputs.prompt).toBe("用户自己的提示词");
    expect(submitted["1"].inputs.seed).toBe(42);
    const state = useStore.getState();
    expect(task().workflow.template!["1"].inputs.api_key).toBe("");
    expect(task().executionWorkflow!["1"].inputs.api_key).toBe("");
    expect(task().input.params).not.toHaveProperty("providerKey");
    expect(state.project.history[0].params).not.toHaveProperty("providerKey");
    expect(JSON.stringify(state.project)).not.toContain(innerKey);
    expect(JSON.stringify(state.workflows)).not.toContain(innerKey);
    expect(JSON.stringify(state.runningHubWorkflows)).not.toContain(innerKey);
    for (const [name, value] of local.records) if (name !== "workflow-credentials") expect(JSON.stringify(value), name).not.toContain(innerKey);
    const archive = await projectArchive(state.project, provider === "runninghub" ? state.runningHubWorkflows : state.workflows);
    const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(strFromU8(files["project.json"])).not.toContain(innerKey);
    expect(strFromU8(files["workflows.json"])).not.toContain(innerKey);
    expect(files["workflow-credentials.json"]).toBeUndefined();
    expect(JSON.stringify(local.records.get("workflow-credentials"))).toContain(innerKey);
  });

  it("redacts a backend echo from the error and advanced details shown on the canvas", async () => {
    const workflow = select(provider);
    await useStore.getState().saveWorkflowCredentials(workflow, { "1:api_key": innerKey });
    vi.mocked(client.prototype.queuePrompt).mockRejectedValue(new ExecutionError("invalid key " + innerKey, "failed", "request api_key=" + innerKey + " at node 1", { nodeId: "1", nodeType: "ApiModel" }));
    await generate("canvas", "node");
    expect(task()?.status).toBe("failed");
    expect(task().error).toContain("[已隐藏密钥]"); expect(task().details).toContain("[已隐藏密钥]");
    expect(task().execution?.nodeId).toBe("1");
    expect(JSON.stringify(useStore.getState().project)).not.toContain(innerKey);
    expect(useStore.getState().toast).not.toContain(innerKey);
  });
});

it("keeps per-workflow keys independent even when fields and model names match", async () => {
  const first = definition("runninghub", "first-workflow"), second = definition("runninghub", "second-workflow");
  second.runninghub!.workflowId = "2234567890123456789";
  await useStore.getState().saveWorkflowCredentials(first, { "1:api_key": "first-private-fixture" });
  await useStore.getState().saveWorkflowCredentials(second, { "1:api_key": "second-private-fixture" });
  expect(workflowCredentialKey(first)).not.toBe(workflowCredentialKey(second));
  expect(workflowCredentialValues(useStore.getState(), first)).toEqual({ "1:api_key": "first-private-fixture" });
  expect(workflowCredentialValues(useStore.getState(), second)).toEqual({ "1:api_key": "second-private-fixture" });
  const clean = select("runninghub", second);
  await generate("canvas", "node");
  expect(task()?.status).toBe("completed");
  expect(vi.mocked(RunningHubClient.prototype.queuePrompt).mock.calls[0][0]["1"].inputs.api_key).toBe("second-private-fixture");
  expect(clean.template!["1"].inputs.api_key).toBe("");
});

it("restores workflow credentials from their separate local record after reloading", async () => {
  const workflow = select("comfyui");
  await useStore.getState().saveWorkflowCredentials(workflow, { "1:api_key": innerKey });
  useStore.setState({ workflowCredentials: {} });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  await useStore.getState().hydrate();
  expect(workflowCredentialValues(useStore.getState(), workflow)).toEqual({ "1:api_key": innerKey });
  useStore.setState({ ready: false });
  await useStore.getState().saveWorkflowCredentials(workflow, { "1:api_key": "" });
  expect(workflowCredentialValues(useStore.getState(), workflow)).toEqual({ "1:api_key": "" });
  expect(JSON.stringify(local.records.get("workflow-credentials"))).not.toContain(innerKey);
});

it("honors explicit secret schema metadata for a generic auth input without relying on the field name", async () => {
  const workflow = definition("comfyui");
  delete workflow.template!["1"].inputs.api_key;
  workflow.template!["1"].inputs.auth = "";
  workflow.mapping.find(mapping => mapping.semantic === "providerKey")!.field = "auth";
  delete workflow.credentials;
  select("comfyui", workflow);
  await useStore.getState().saveWorkflowCredentials(workflow, { "1:auth": innerKey });
  await generate("canvas", "node");
  expect(task()?.status).toBe("completed");
  expect(vi.mocked(ComfyUIClient.prototype.queuePrompt).mock.calls[0][0]["1"].inputs.auth).toBe(innerKey);
  expect(JSON.stringify(useStore.getState().project)).not.toContain(innerKey);
});

it("does not write a late ComfyUI result into a replacement project with matching canvas and node IDs", async () => {
  const workflow = select("comfyui");
  await useStore.getState().saveWorkflowCredentials(workflow, { "1:api_key": innerKey });
  let resolveOutput!: (blob: Blob) => void;
  vi.mocked(ComfyUIClient.prototype.getOutput).mockImplementation(() => new Promise(resolve => { resolveOutput = resolve; }));
  const pending = generate("canvas", "node");
  await vi.waitFor(() => expect(ComfyUIClient.prototype.getOutput).toHaveBeenCalledOnce());
  const previous = useStore.getState().project;
  const replacement = { ...previous, id: "other-project", assets: {}, tasks: {}, history: [],
    canvases: previous.canvases.map(canvas => ({ ...canvas, nodes: canvas.nodes.map(item => ({ ...item,
      data: { ...item.data, generation: { ...item.data.generation!, taskId: null } },
    })) })),
  };
  useStore.setState({ project: replacement, toast: "replacement project" });
  resolveOutput(new Blob(["late-image"], { type: "image/png" }));
  await pending;
  expect(useStore.getState().project).toBe(replacement);
  expect(useStore.getState().project.assets).toEqual({});
  expect(useStore.getState().project.history).toEqual([]);
  expect(useStore.getState().toast).toBe("replacement project");
});
