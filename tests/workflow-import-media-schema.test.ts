import { describe, expect, it, vi } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { workflowImportMediaSchema } from "../scripts/workflow-import-media-schema";
import { createCapabilityProjection, normalizeApiWorkflow } from "../vendor/aifisher/server/workflowRuntime/workflowFormat.js";

const info = {
  LoadImage: { input: { required: { image: [["station-image.png"], { image_upload: true }], mode: [["normal", "fast"]] } }, output: ["IMAGE"] },
  VHS_LoadVideo: { input: { required: { video: [["station-video.mp4"]] } }, output: ["VIDEO"] },
  LoadAudio: { input: { required: { audio: ["COMBO", { options: ["station-audio.wav"] }] } }, output: ["AUDIO"] },
  LoadMask: { input: { required: { mask: [["station-mask.png"]] } }, output: ["MASK"] },
  PublicMedia: { input: { optional: { source: [["station-upload.png"], { image_upload: true }] } }, output: ["IMAGE"] },
  CheckpointLoader: { input: { required: { ckpt_name: [["installed.safetensors"]] } }, output: ["MODEL"] },
  SaveImage: { input: { required: { images: ["IMAGE", { forceInput: true }] } }, output: [], output_node: true },
};
const api = {
  "1": { class_type: "LoadImage", inputs: { image: "unavailable-example.png", mode: "normal" } },
  "2": { class_type: "VHS_LoadVideo", inputs: { video: "https://example.invalid/sample.mp4" } },
  "3": { class_type: "LoadAudio", inputs: { audio: "unavailable-example.wav" } },
  "4": { class_type: "LoadMask", inputs: { mask: "unavailable-mask.png" } },
  "5": { class_type: "PublicMedia", inputs: { source: "unavailable-upload.png" } },
  "6": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
};
function editor(image: unknown = "unavailable-example.png", mode = "normal") {
  return { version: 0.4, nodes: [
    { id: 1, type: "LoadImage", inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }], widgets_values: { image, mode } },
    { id: 2, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: 1 }], outputs: [], widgets_values: {} },
  ], links: [[1, 1, 0, 2, 0, "IMAGE"]] };
}

describe("ComfyUI imports ignore example media availability", () => {
  it("accepts unavailable API image/video/audio/mask and explicit upload names without fetching their contents", async () => {
    const source = structuredClone(api), objectInfo = structuredClone(info);
    const fetcher = vi.fn(() => { throw new Error("Unexpected media request"); });
    const result = await readAIFisherWorkflow({ environment: "comfyui", source, objectInfo }, { fetcher });
    expect(result.analysis.compileStatus).toBe("ready");
    expect(result.analysis.warnings).toEqual([]);
    expect(result.workflow).toEqual(normalizeApiWorkflow(source));
    expect(result.nodeDefinitions).toEqual(createCapabilityProjection(source, info).nodeDefinitions);
    expect(result.analysis.nodeDefinitions).toEqual(result.nodeDefinitions);
    expect(result.analysis.relevantCapabilityHash).toEqual(createCapabilityProjection(source, info).relevantCapabilityHash);
    expect(result.bindingCandidates.find(candidate => candidate.nodeId === "1" && candidate.fieldName === "image"))
      .toMatchObject({ control: "asset", mediaKind: "image", options: ["station-image.png"] });
    expect(fetcher).not.toHaveBeenCalled();
    expect(source).toEqual(api);
    expect(objectInfo).toEqual(info);
  });

  it("compiles named editor widgets while retaining the source and original workstation definitions", async () => {
    const source = editor(), before = structuredClone(source), objectInfo = structuredClone(info);
    const result = await readAIFisherWorkflow({ environment: "comfyui", source, objectInfo });
    expect(result.analysis.compileStatus).toBe("ready");
    expect(result.analysis.warnings).toEqual([]);
    expect(result.workflow?.["1"].inputs).toEqual({ image: "unavailable-example.png", mode: "normal" });
    expect(result.workflow?.["2"].inputs.images).toEqual(["1", 0]);
    expect(result.nodeDefinitions.LoadImage.input.required.image).toEqual(info.LoadImage.input.required.image);
    expect(source).toEqual(before);
    expect(objectInfo).toEqual(info);
  });

  it("keeps string type checks and unrelated scalar/model enum checks", async () => {
    const nonString = await readAIFisherWorkflow({ environment: "comfyui", source: editor(123), objectInfo: info });
    expect(nonString.analysis.compileStatus).toBe("needs-confirmation");
    expect(nonString.analysis.warnings).toContainEqual(expect.objectContaining({ code: "AMBIGUOUS_WIDGET_MAPPING", fieldName: "image" }));
    const otherScalar = await readAIFisherWorkflow({ environment: "comfyui", source: editor("unavailable-example.png", "unsupported"), objectInfo: info });
    expect(otherScalar.analysis.compileStatus).toBe("needs-confirmation");
    expect(otherScalar.analysis.warnings).toContainEqual(expect.objectContaining({ code: "AMBIGUOUS_WIDGET_MAPPING", fieldName: "mode" }));
    const modelSource = { ...api, model: { class_type: "CheckpointLoader", inputs: { ckpt_name: "missing.safetensors" } } };
    const model = await readAIFisherWorkflow({ environment: "comfyui", source: modelSource, objectInfo: info });
    expect(model.analysis.warnings).toContainEqual(expect.objectContaining({ code: "INVALID_INPUT_VALUE", nodeId: "model", fieldName: "ckpt_name" }));
  });

  it("keeps positional widget confirmation and never infers their field order", async () => {
    const source = { version: 0.4, nodes: [{ id: 1, type: "LoadImage", inputs: [], outputs: [], widgets_values: ["unavailable-example.png", "normal"] }], links: [] };
    expect(workflowImportMediaSchema(source, "comfy-ui-0.4", info)).toBe(info);
    const result = await readAIFisherWorkflow({ environment: "comfyui", source, objectInfo: info });
    expect(result.workflow).toBeNull();
    expect(result.analysis.compileStatus).toBe("needs-confirmation");
    expect(result.analysis.warnings).toContainEqual(expect.objectContaining({ code: "POSITIONAL_WIDGET_MAPPING_REQUIRES_CONFIRMATION" }));
  });

  it("preserves required connections and runtime port checks", async () => {
    const missingInput = editor();
    missingInput.nodes[1].inputs = [];
    missingInput.links = [];
    missingInput.nodes[0].outputs[0].links = [];
    const required = await readAIFisherWorkflow({ environment: "comfyui", source: missingInput, objectInfo: info });
    expect(required.analysis.compileStatus).toBe("needs-confirmation");
    expect(required.analysis.warnings).toContainEqual(expect.objectContaining({ code: "UNCONNECTED_REQUIRED_INPUT", fieldName: "images" }));
    const wrongOutput = { ...info, LoadImage: { ...info.LoadImage, output: ["AUDIO"] } };
    const mismatch = await readAIFisherWorkflow({ environment: "comfyui", source: editor(), objectInfo: wrongOutput });
    expect(mismatch.analysis.compileStatus).toBe("needs-confirmation");
    expect(mismatch.analysis.warnings.some(warning => /(?:TYPE|SLOT|LINK)/.test(warning.code))).toBe(true);
  });

  it("leaves accepted media enums untouched and does not let another loader's connection block a file widget", async () => {
    const accepted = { "1": { class_type: "LoadImage", inputs: { image: "station-image.png", mode: "normal" } } };
    expect(workflowImportMediaSchema(accepted, "comfy-api", info)).toBe(info);
    const sharedDefinition = { ...api, connected: { class_type: "LoadImage", inputs: { image: ["5", 0], mode: "normal" } } };
    expect((workflowImportMediaSchema(sharedDefinition, "comfy-api", info)!.LoadImage as typeof info.LoadImage).input.required.image)
      .toEqual([["station-image.png", "unavailable-example.png"], { image_upload: true }]);
    const result = await readAIFisherWorkflow({ environment: "comfyui", source: sharedDefinition, objectInfo: info });
    expect(result.workflow?.["1"].inputs.image).toBe("unavailable-example.png");
    expect(result.workflow?.connected.inputs.image).toEqual(["5", 0]);
    expect(result.analysis.warnings).not.toContainEqual(expect.objectContaining({ code: "INVALID_INPUT_VALUE", nodeId: "1", fieldName: "image" }));
    expect(result.analysis.warnings).toContainEqual(expect.objectContaining({ code: "RUNTIME_SLOT_MISMATCH", nodeId: "connected", fieldName: "image" }));
  });

  it("retains named editor port mismatches when another node of the same class uses an unavailable file name", async () => {
    const source = { version: 0.4, nodes: [
      ...editor().nodes,
      { id: 3, type: "StringValue", inputs: [], outputs: [{ name: "STRING", type: "STRING", links: [2] }], widgets_values: {} },
      { id: 4, type: "LoadImage", inputs: [{ name: "image", type: "STRING", link: 2 }], outputs: [], widgets_values: { mode: "normal" } },
    ], links: [...editor().links, [2, 3, 0, 4, 0, "STRING"]] };
    const objectInfo = { ...info, StringValue: { input: { required: {} }, output: ["STRING"] } };
    const result = await readAIFisherWorkflow({ environment: "comfyui", source, objectInfo });
    expect(result.workflow).toBeNull();
    expect(result.analysis.compileStatus).toBe("needs-confirmation");
    expect(result.analysis.warnings).toContainEqual(expect.objectContaining({ code: "RUNTIME_SLOT_MISMATCH", targetNodeId: "4" }));
    expect(result.analysis.warnings).not.toContainEqual(expect.objectContaining({ code: "AMBIGUOUS_WIDGET_MAPPING", nodeId: "1", fieldName: "image" }));
  });
});
