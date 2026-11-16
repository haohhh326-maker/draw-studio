import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/projects/storage", () => ({
  readRecord: async () => undefined,
  writeRecord: async () => {},
  safeConnection: (connection: Record<string, unknown>) => ({ ...connection, token: "" }),
  getBlob: async () => new Blob(["input"]), putBlob: async () => {},
}));
vi.mock("../src/assets/assets", () => ({ importAsset: async () => ({
  id: "generated", kind: "image", name: "result.png", mime: "image/png", size: 5, url: "blob:result", createdAt: Date.now(),
}) }));
import { ComfyUIClient } from "../src/comfyui/client";
import { generate } from "../src/generation/pipeline";
import { createNode, useStore } from "../src/stores/store";
import { defaultConnection } from "../src/workflow/catalog";
import { selectWorkflowOutput } from "../src/workflow/execution";
import { generationParameterSurface } from "../src/generation/parameter-actions";
import { identifyLoraParameter } from "../src/workflow/lora-parameters";
import type { WorkflowDefinition } from "../src/types";

const workflow: WorkflowDefinition = {
  id: "lora-execution", name: "Existing vendor workflow", family: "Image", description: "", mode: "text-to-image",
  requiredInputs: [], optionalInputs: [], parameters: [], promptRequired: false,
  template: {
    base: { class_type: "BaseModel", inputs: {} },
    adapter: { class_type: "LoraLoaderModelOnly", inputs: { model: ["base", 0], lora_name: "original.safetensors", strength_model: .7 } },
    maker: { class_type: "MakeImage", inputs: { model: ["adapter", 0] } },
    save: { class_type: "SaveImage", inputs: { images: ["maker", 0], filename_prefix: "author" } },
  }, mapping: [], output: { nodeId: "save", field: "images", kind: "image" },
};
const info = {
  BaseModel: { input: { required: {} }, output: ["MODEL"] },
  LoraLoaderModelOnly: { input: { required: { model: ["MODEL"], lora_name: ["COMBO", { options: ["original.safetensors", "chosen.safetensors"] }], strength_model: ["FLOAT", { min: -2, max: 2, step: .01 }] } }, output: ["MODEL"] },
  MakeImage: { input: { required: { model: ["MODEL"] } }, output: ["IMAGE"] },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
};
const loraKey = (kind: "model" | "strength") => {
  const selected = selectWorkflowOutput(useStore.getState().workflows[0], {});
  return generationParameterSurface(selected).advanced.find(parameter => identifyLoraParameter(parameter, selected).some(target => target.kind === kind))!.key;
};
const editParams = (params: Record<string, string | number | boolean>) => {
  const node = useStore.getState().project.canvases[0].nodes[0];
  useStore.getState().patchNode(node.id, { generation: { ...node.data.generation!, params: { ...node.data.generation!.params, ...params } } });
};
beforeEach(() => {
  vi.restoreAllMocks();
  const node = createNode("image-generation", 1); node.id = "node";
  node.data.generation = { workflowId: workflow.id, prompt: "", negativePrompt: "", params: {}, taskId: null };
  useStore.setState({ project: { version: 2, id: "project", name: "LoRA", scenes: [{ id: "scene", name: "Scene" }], activeCanvasId: "canvas",
    canvases: [{ id: "canvas", name: "Canvas", sceneId: "scene", nodes: [node], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }], assets: {}, tasks: {}, history: [], updatedAt: 0 },
    projects: {}, projectOpen: true, navigating: false, ready: false, past: [], future: [], workflows: [structuredClone(workflow)],
    connection: { ...defaultConnection, baseUrl: "http://workstation.example" },
  });
  vi.spyOn(ComfyUIClient.prototype, "getObjectInfo").mockResolvedValue(info);
  vi.spyOn(ComfyUIClient.prototype, "getSystemStats").mockResolvedValue({});
  vi.spyOn(ComfyUIClient.prototype, "connect").mockResolvedValue();
  vi.spyOn(ComfyUIClient.prototype, "disconnect").mockImplementation(() => {});
  vi.spyOn(ComfyUIClient.prototype, "queuePrompt").mockResolvedValue("prompt-id");
  vi.spyOn(ComfyUIClient.prototype, "waitForCompletion").mockResolvedValue({ status: { completed: true, status_str: "success" }, outputs: { save: { images: [{ filename: "result.png", type: "output" }] } } });
  vi.spyOn(ComfyUIClient.prototype, "getOutput").mockResolvedValue(new Blob(["image"], { type: "image/png" }));
});

describe("LoRA chooser execution", () => {
  it("submits model and strength edits for undeclared vendor fields without changing the original definition", async () => {
    const before = structuredClone(useStore.getState().workflows[0]);
    editParams({ [loraKey("model")]: "chosen.safetensors", [loraKey("strength")]: .9 });
    await generate("canvas", "node");
    expect(ComfyUIClient.prototype.queuePrompt).toHaveBeenCalledTimes(1);
    const queued = vi.mocked(ComfyUIClient.prototype.queuePrompt).mock.calls[0][0];
    expect(queued.adapter.inputs).toEqual({ model: ["base", 0], lora_name: "chosen.safetensors", strength_model: .9 });
    expect(Object.values(useStore.getState().project.tasks)[0].status).toBe("completed");
    expect(useStore.getState().workflows[0]).toEqual(before);
  });

  it("submits saved LoRA edits when the node-definition endpoint is unavailable", async () => {
    vi.spyOn(ComfyUIClient.prototype, "getObjectInfo").mockRejectedValue(new Error("object_info unavailable"));
    editParams({ [loraKey("model")]: "chosen.safetensors", [loraKey("strength")]: .3 });
    await generate("canvas", "node");
    const queued = vi.mocked(ComfyUIClient.prototype.queuePrompt).mock.calls[0][0];
    expect(queued.adapter.inputs.lora_name).toBe("chosen.safetensors");
    expect(queued.adapter.inputs.strength_model).toBe(.3);
    expect(ComfyUIClient.prototype.getObjectInfo).not.toHaveBeenCalled();
  });

  it("preserves the chosen model path instead of matching filenames against server options", async () => {
    editParams({ [loraKey("model")]: "my-folder/chosen.safetensors" });
    await generate("canvas", "node");
    const queued = vi.mocked(ComfyUIClient.prototype.queuePrompt).mock.calls[0][0];
    expect(queued.adapter.inputs.lora_name).toBe("my-folder/chosen.safetensors");
    expect(ComfyUIClient.prototype.getObjectInfo).not.toHaveBeenCalled();
  });
});
