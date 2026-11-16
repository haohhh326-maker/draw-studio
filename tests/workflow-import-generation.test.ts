import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const persistence = vi.hoisted(() => ({ records: new Map<string, unknown>() }));
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(persistence.records.get(key)),
  writeRecord: async (key: string, value: unknown) => { persistence.records.set(key, structuredClone(value)); },
  safeConnection: (connection: Record<string, unknown>) => ({ ...connection, token: "" }),
  getBlob: async () => new Blob(["input"]), putBlob: async () => {},
}));
vi.mock("../src/assets/assets", () => ({ importAsset: async () => ({
  id: "generated", kind: "image", name: "result.png", mime: "image/png", size: 5, url: "blob:result", createdAt: Date.now(),
}) }));
import { ApiError, ComfyUIClient } from "../src/comfyui/client";
import { generate } from "../src/generation/pipeline";
import { createNode, useStore } from "../src/stores/store";
import { defaultConnection, withBuiltinBindings } from "../src/workflow/catalog";
import { prepareWorkflowImport } from "../src/workflow/import-pipeline";
import * as importClient from "../src/workflow/import-client";
import * as storage from "../src/projects/storage";
import { readWorkflowLibrary } from "../scripts/workflow-library-reader";
import { resolveWorkflowLibraryImport, writeWorkflowLibraryImport } from "../scripts/workflow-library-writer";
import { workflowVisibilityGroups } from "../src/workflow/visibility";
import type { WorkflowDefinition } from "../src/types";

const info = {
  OwnMaker: { input: { required: { prompt: ["STRING", { multiline: true }], steps: ["INT", { default: 6 }], seed: ["INT"] } }, output: ["IMAGE"] },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
};
const source = { version: 0.4, nodes: [
  // Named widgets are unambiguous to the unchanged AIFISHER compiler.
  { id: 1, type: "OwnMaker", widgets_values: { prompt: "saved original prompt", steps: 6, seed: 0 }, inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }] },
  { id: 2, type: "SaveImage", widgets_values: { filename_prefix: "original-prefix" }, inputs: [{ name: "images", type: "IMAGE", link: 1 }], outputs: [] },
], links: [[1, 1, 0, 2, 0, "IMAGE"]] };
let root = "", id = "";
async function loadLibrary() {
  const snapshot = await readWorkflowLibrary(root);
  useStore.setState({ workflowLibrary: snapshot, libraryState: "loaded", libraryError: "", workflows: withBuiltinBindings([], snapshot.workflows, snapshot.sourcePath) });
}
/** The explicit import/configuration action runs before generate, never from generate. */
async function finishImport() {
  await resolveWorkflowLibraryImport(root, { workflowId: id, objectInfo: info });
  await loadLibrary();
  expect(useStore.getState().workflows[0].library?.importStatus, JSON.stringify(useStore.getState().workflows[0].library?.diagnostics)).toBe("ready");
}
beforeEach(async () => {
  vi.restoreAllMocks(); persistence.records.clear();
  root = await mkdtemp(path.join(os.tmpdir(), "canvas-import-generate-"));
  const prepared = await prepareWorkflowImport(structuredClone(source), "own.json");
  const saved = await writeWorkflowLibraryImport(root, { ...prepared, reuseExisting: true });
  id = saved.workflowId;
  await loadLibrary();
  const workflow = useStore.getState().workflows[0], node = createNode("image-generation", 1);
  node.id = "node";
  node.data.generation = { workflowId: workflow.id, prompt: "user prompt", negativePrompt: "", params: {}, taskId: null };
  useStore.setState({
    project: { version: 2, id: "project", name: "Import", scenes: [{ id: "scene", name: "Scene" }], activeCanvasId: "canvas",
      canvases: [{ id: "canvas", name: "Canvas", sceneId: "scene", nodes: [node], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }], assets: {}, tasks: {}, history: [], updatedAt: 0 },
    projects: {}, projectOpen: true, navigating: false, ready: false, past: [], future: [], hiddenWorkflowKeys: [],
    connection: { ...defaultConnection, baseUrl: "http://localhost:8188" },
  });
  vi.spyOn(importClient, "resolveWorkflowImport").mockRejectedValue(new Error("Run must not resolve imports"));
  vi.spyOn(useStore.getState(), "refreshWorkflowLibrary").mockRejectedValue(new Error("Run must not refresh definitions"));
  vi.spyOn(ComfyUIClient.prototype, "getObjectInfo").mockRejectedValue(new Error("Schema endpoint deliberately unavailable"));
  vi.spyOn(ComfyUIClient.prototype, "getSystemStats").mockRejectedValue(new Error("Run must not probe the service before submission"));
  vi.spyOn(ComfyUIClient.prototype, "connect").mockResolvedValue();
  vi.spyOn(ComfyUIClient.prototype, "disconnect").mockImplementation(() => {});
  vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockResolvedValue("prompt-id");
  vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockResolvedValue({ status: { completed: true, status_str: "success" }, outputs: { "2": { images: [{ filename: "result.png", type: "output" }] } } });
  vi.spyOn(ComfyUIClient.prototype, "getOutput").mockResolvedValue(new Blob(["image"], { type: "image/png" }));
});
afterEach(async () => {
  if (root && path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("canvas-import-generate-"))
    await rm(root, { recursive: true, force: true });
});
const noRuntimeSchemaCheck = () => {
  expect(ComfyUIClient.prototype.getSystemStats).not.toHaveBeenCalled();
  expect(ComfyUIClient.prototype.getObjectInfo).not.toHaveBeenCalled();
  expect(importClient.resolveWorkflowImport).not.toHaveBeenCalled();
  expect(useStore.getState().refreshWorkflowLibrary).not.toHaveBeenCalled();
};

describe("run saved workflows without node-definition checks", () => {
  it("directs unresolved editor imports to the explicit configuration action without network or mutation", async () => {
    const before = structuredClone(useStore.getState().workflows[0]);
    await generate("canvas", "node");
    expect(useStore.getState().toast).toContain("重新自动转换");
    expect(Object.keys(useStore.getState().project.tasks)).toHaveLength(0);
    expect(useStore.getState().workflows[0]).toEqual(before);
    expect(useStore.getState().project.canvases[0].nodes[0].data.generation!.prompt).toBe("user prompt");
    expect(ComfyUIClient.prototype.getSystemStats).not.toHaveBeenCalled();
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    noRuntimeSchemaCheck();
  });

  it("submits the executable graph saved by import using defaults and the current user prompt", async () => {
    await finishImport();
    const before = structuredClone(useStore.getState().workflows[0]);
    await generate("canvas", "node");
    const state = useStore.getState(), task = Object.values(state.project.tasks)[0];
    expect(task.status).toBe("completed");
    expect(task.workflow.original?.id).toBe(id);
    expect(task.input.prompt).toBe("user prompt");
    const steps = task.workflow.mapping.find(mapping => mapping.nodeId === "1" && mapping.field === "steps")!;
    expect(task.input.params[steps.semantic]).toBe(6);
    expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
    expect(state.project.canvases[0].nodes[0].data.assetId).toBe("generated");
    expect(state.workflows[0]).toEqual(before);
    noRuntimeSchemaCheck();
  });

  it("executes selected workflows hidden from the menu without removing their source or binding", async () => {
    await finishImport();
    const selected = useStore.getState().workflows[0];
    await useStore.getState().setWorkflowHidden(selected, true);
    expect(workflowVisibilityGroups([selected], useStore.getState().hiddenWorkflowKeys).visible).toEqual([]);
    await generate("canvas", "node");
    expect(Object.values(useStore.getState().project.tasks)[0].status).toBe("completed");
    expect(useStore.getState().project.canvases[0].nodes[0].data.generation!.workflowId).toBe(selected.id);
    expect((await readWorkflowLibrary(root)).workflows[0].template).toBeDefined();
    noRuntimeSchemaCheck();
  });

  it("does not silently restore the author's prompt when the user clears their prompt", async () => {
    await finishImport();
    const node = useStore.getState().project.canvases[0].nodes[0];
    useStore.getState().patchNode(node.id, { generation: { ...node.data.generation!, prompt: "" } });
    await generate("canvas", "node");
    expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
    expect(Object.values(useStore.getState().project.tasks)[0].input.prompt).toBe("");
    expect(useStore.getState().project.canvases[0].nodes[0].data.generation!.prompt).toBe("");
    noRuntimeSchemaCheck();
  });

  it("uses connected text and never appends the saved author prompt", async () => {
    await finishImport();
    const state = useStore.getState(), node = state.project.canvases[0].nodes[0], text = createNode("text", 2);
    text.id = "text"; text.data.text = "connected text";
    state.patchNode(node.id, { generation: { ...node.data.generation!, prompt: "" } });
    state.editCanvas(canvas => ({ ...canvas, nodes: [...canvas.nodes, text], edges: [{ id: "text-edge", source: "text", target: "node" }] }));
    await generate("canvas", "node");
    expect(Object.values(useStore.getState().project.tasks)[0].input.prompt).toBe("connected text");
    noRuntimeSchemaCheck();
  });

  it("guards duplicate clicks during the durable task write and snapshots the prompt at the click", async () => {
    await finishImport();
    let release: (() => void) | undefined;
    vi.spyOn(storage, "writeRecord").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = generate("canvas", "node");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const node = useStore.getState().project.canvases[0].nodes[0];
    useStore.getState().patchNode(node.id, { generation: { ...node.data.generation!, prompt: "next prompt" } });
    await generate("canvas", "node");
    release!(); await first;
    expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
    expect(Object.values(useStore.getState().project.tasks)[0].input.prompt).toBe("user prompt");
    expect(useStore.getState().project.canvases[0].nodes[0].data.generation!.prompt).toBe("next prompt");
    noRuntimeSchemaCheck();
  });

  it("does not start while project navigation is already in progress", async () => {
    await finishImport();
    useStore.setState({ navigating: true });
    await generate("canvas", "node");
    expect(Object.keys(useStore.getState().project.tasks)).toHaveLength(0);
    expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
    noRuntimeSchemaCheck();
  });

  it("submits unknown custom API nodes unchanged and retains the server rejection", async () => {
    await finishImport();
    const current = useStore.getState().workflows[0];
    const custom: WorkflowDefinition = { ...current, source: undefined,
      template: { "1": { class_type: "MyUnlistedPlugin", inputs: { prompt: "", model: "author/folder/model.gguf", custom: { arbitrary: [1, 2, 3] } } }, "2": current.template!["2"] },
      parameters: [], mapping: [{ semantic: "prompt", nodeId: "1", field: "prompt" }],
    };
    useStore.setState({ workflows: [custom] });
    vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockRejectedValue(new ApiError("MyUnlistedPlugin: class_type does not exist", 400));
    await generate("canvas", "node");
    const queued = vi.mocked(ComfyUIClient.prototype.queuePrompt).mock.calls[0][0];
    expect(queued["1"]).toEqual({ class_type: "MyUnlistedPlugin", inputs: { prompt: "user prompt", model: "author/folder/model.gguf", custom: { arbitrary: [1, 2, 3] } } });
    const task = Object.values(useStore.getState().project.tasks)[0];
    expect(task.status).toBe("failed");
    expect(task.error).toBe("MyUnlistedPlugin: class_type does not exist");
    expect(task.details).toContain("MyUnlistedPlugin");
    expect(useStore.getState().project.history).toHaveLength(0);
    noRuntimeSchemaCheck();
  });

  it("uses the saved media policy, selected branch and actual upload without querying schemas", async () => {
    await finishImport();
    const original = useStore.getState().workflows[0];
    const workflow: WorkflowDefinition = { ...original, library: undefined, original: undefined, importReader: undefined,
      promptRequired: true, mediaInputMode: "schema", inputSlots: [{ semantic: "image", label: "Reference", kind: "image", required: true }],
      requiredInputs: ["image"], optionalInputs: [], parameters: [],
      template: {
        "1": { class_type: "OwnMaker", inputs: { prompt: "first", reference: ["3", 0] } },
        "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "first" } },
        "3": { class_type: "LoadImage", inputs: { image: "author.png" } },
        "4": { class_type: "OwnMaker", inputs: { prompt: "second", reference: ["3", 0] } },
        "5": { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "second" } },
      },
      mapping: [{ semantic: "prompt", nodeId: "1", field: "prompt" }, { semantic: "prompt", nodeId: "4", field: "prompt" }, { semantic: "image", nodeId: "3", field: "image" }],
      output: { nodeId: "2", field: "images", kind: "image" },
      outputChoices: [{ nodeId: "2", field: "images", kind: "image", label: "First", issues: [] }, { nodeId: "5", field: "images", kind: "image", label: "Second", issues: [] }],
      source: { file: "branch.json", sha256: "", sourceUrl: "", format: "api", models: [], missingNodes: [], missingModels: [], issues: [] },
    };
    useStore.setState({ workflows: [workflow] });
    const state = useStore.getState(), node = state.project.canvases[0].nodes[0];
    state.patchNode(node.id, { generation: { ...node.data.generation!, params: { __output: "5" } } });
    state.editProject(project => ({ ...project, assets: { a: { id: "a", kind: "image", name: "connected.png", mime: "image/png", size: 5, createdAt: 0 } },
      canvases: project.canvases.map(canvas => ({ ...canvas, nodes: [...canvas.nodes, { id: "reference", position: { x: 0, y: 0 }, data: { kind: "reference", title: "Reference", assetId: "a" } }],
        edges: [{ id: "edge", source: "reference", target: "node", data: { role: "auto", order: 0 } }] })) }));
    vi.spyOn(ComfyUIClient.prototype, "uploadAsset").mockImplementation(async (_blob, _name, subfolder) => ({ name: "uploaded.png", subfolder, type: "input", inputName: subfolder + "/uploaded.png" }));
    vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockResolvedValue({ status: { completed: true }, outputs: { "5": { images: [{ filename: "result.png", type: "output" }] } } });
    await generate("canvas", "node");
    const task = Object.values(useStore.getState().project.tasks)[0];
    expect(task.status).toBe("completed");
    const submitted = vi.mocked(ComfyUIClient.prototype.queuePrompt).mock.calls[0][0];
    expect(Object.keys(submitted).sort()).toEqual(["3", "4", "5"]);
    expect(submitted["3"].inputs.image).toBe(task.staging!.inputSubfolder + "/uploaded.png");
    expect(submitted["4"].inputs.prompt).toBe("user prompt");
    expect(workflow.template!["3"].inputs.image).toBe("author.png");
    noRuntimeSchemaCheck();
  });

  it.each([false, true])("honors saved optional-input policy while retaining required input checks (required=%s)", async required => {
    await finishImport();
    const original = useStore.getState().workflows[0];
    const workflow: WorkflowDefinition = { ...original, source: undefined, original: undefined, library: undefined,
      mediaInputMode: "schema", inputSlots: [{ semantic: "image", label: "Reference", kind: "image", required }],
      requiredInputs: required ? ["image"] : [], optionalInputs: required ? [] : ["image"],
      mediaInputPolicy: { optionalSemantics: required ? [] : ["image"], removals: [{ semantic: "image", nodeId: "1", field: "reference" }], groups: [] },
      template: { ...structuredClone(original.template!),
        "1": { ...structuredClone(original.template!["1"]), inputs: { ...original.template!["1"].inputs, reference: ["3", 0] } },
        "3": { class_type: "LoadImage", inputs: { image: "author.png" } },
      },
      mapping: [...original.mapping, { semantic: "image", nodeId: "3", field: "image" }],
    };
    useStore.setState({ workflows: [workflow] });
    const upload = vi.spyOn(ComfyUIClient.prototype, "uploadAsset");
    await generate("canvas", "node");
    if (required) {
      expect(ComfyUIClient.prototype.queuePrompt).not.toHaveBeenCalled();
      expect(Object.values(useStore.getState().project.tasks)).toHaveLength(0);
      expect(useStore.getState().toast).toContain("Reference");
    } else {
      const submitted = vi.mocked(ComfyUIClient.prototype.queuePrompt).mock.calls[0][0];
      expect(submitted["1"].inputs).not.toHaveProperty("reference");
      expect(submitted["3"]).toBeUndefined();
      expect(Object.values(useStore.getState().project.tasks)[0].status).toBe("completed");
    }
    expect(upload).not.toHaveBeenCalled();
    expect(workflow.template!["1"].inputs.reference).toEqual(["3", 0]);
    noRuntimeSchemaCheck();
  });
});
