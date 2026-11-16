import { describe, expect, it } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { prepareWorkflowImport } from "../src/workflow/import-pipeline";
import type { AifisherWorkflowReadRequest, AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";
import { convertLibraryWorkflow } from "../src/workflow/library-converter";
import { assertAifisherVariableAssetsSupported } from "../src/workflow/aifisher-variable-assets";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { selectWorkflowOutput } from "../src/workflow/execution";
import type { CanvasNode } from "../src/types";
import type { ResolvedInput } from "../src/semantic/resolver";
import type { ApiWorkflow } from "../src/types";

const reader = async (request: AifisherWorkflowReadRequest) => await readAIFisherWorkflow(request) as AifisherWorkflowReadResult;
const source: ApiWorkflow = {
  load: { class_type: "LoadImage", inputs: { image: "my-existing-reference.png" } },
  prompt: { class_type: "PromptText", inputs: { prompt: "Animate the reference", detail: "natural light" } },
  frames: { class_type: "OwnVideoFrames", inputs: { image: ["load", 0], positive: ["prompt", 0], width: 1280, height: 720, aspect_ratio: "16:9", quality: true } },
  saveVideo: { class_type: "VHS_VideoCombine", inputs: { images: ["frames", 0], frame_rate: 24, format: "video/h264-mp4", save_output: false } },
  saveImage: { class_type: "SaveImage", inputs: { images: ["frames", 0], filename_prefix: "thumbnail" } },
  disconnected: { class_type: "UnusedBranch", inputs: { weight: 0.2, arbitrary_setting: "retain me" } },
};
const info = {
  LoadImage: { input: { required: { image: [["my-existing-reference.png"], { image_upload: true }] } }, output: ["IMAGE"], output_name: ["IMAGE"] },
  PromptText: { input: { required: { prompt: ["STRING", { multiline: true }], detail: ["STRING"] } }, output: ["STRING"], output_name: ["STRING"] },
  OwnVideoFrames: { input: { required: { image: ["IMAGE", { forceInput: true }], positive: ["STRING", { forceInput: true }], width: ["INT", { min: 64, max: 8192, step: 64 }], height: ["INT", { min: 64, max: 8192, step: 64 }], aspect_ratio: [["16:9", "9:16", "1:1"]], quality: ["BOOLEAN"] } }, output: ["IMAGE"], output_name: ["frames"] },
  VHS_VideoCombine: { input: { required: { images: ["IMAGE", { forceInput: true }], frame_rate: ["FLOAT", { min: 1, max: 120, step: 0.01 }], format: [["video/h264-mp4", "image/gif"]], save_output: ["BOOLEAN"] } }, output: [], output_node: true },
  SaveImage: { input: { required: { images: ["IMAGE", { forceInput: true }], filename_prefix: ["STRING"] } }, output: [], output_node: true },
  UnusedBranch: { input: { required: { weight: ["FLOAT"], arbitrary_setting: ["STRING"] } }, output: [] },
};
const origin = { sourcePath: "local-fixture", folder: "unchanged-upstream", configSha256: "fixture-config", executionSha256: "fixture-execution", executionStatus: "plain" as const };

describe("AIFISHER through the real local import pipeline", () => {
  it("preserves every API node, link and scalar, including disconnected branches and an author-disabled save switch", async () => {
    const original = structuredClone(source);
    const prepared = await prepareWorkflowImport(source, "video-with-thumbnail_api.json", info, reader);
    expect(prepared.importState.status).toBe("ready");
    expect(prepared.graph).toEqual(original);
    expect(Object.keys(prepared.graph!)).toHaveLength(6);
    expect(source).toEqual(original);
    expect(prepared.config.importReader).toMatchObject({ environment: "comfyui", revision: "bdcf3bec054594fcab591952a8c5acef858d6de4", compileStatus: "ready" });
    const definition = convertLibraryWorkflow(prepared.config, prepared.graph, prepared.requirements, origin);
    expect(definition.template).toEqual(original);
    expect(prepared.graph).toEqual(original);
  });

  it("creates local controls from upstream object_info candidate options and ranges", async () => {
    const prepared = await prepareWorkflowImport(source, "video_api.json", info, reader);
    expect(prepared.importState.status).toBe("ready");
    const definition = convertLibraryWorkflow(prepared.config, prepared.graph, prepared.requirements, origin);
    expect(definition.parameters.find(parameter => parameter.key === "aspect_ratio")).toMatchObject({ type: "select", options: ["16:9", "9:16", "1:1"], default: "16:9" });
    expect(definition.parameters.find(parameter => parameter.key === "width")).toMatchObject({ type: "number", min: 64, max: 8192, step: 64, default: 1280 });
    expect(definition.parameters.find(parameter => parameter.key === "quality")).toMatchObject({ type: "boolean", default: true });
    expect(definition.inputSlots).toEqual([expect.objectContaining({ kind: "image", required: true })]);
    expect(definition.mapping).toEqual(expect.arrayContaining([expect.objectContaining({ semantic: "prompt", nodeId: "prompt", field: "prompt" })]));
  });

  it("projects known output media while keeping wildcard receipt collection and mixed output classification", async () => {
    const prepared = await prepareWorkflowImport(source, "video-with-thumbnail.json", info, reader);
    expect(prepared.analysis.outputs.map(output => ({ nodeId: output.nodeId, field: output.field, kind: output.kind }))).toEqual(expect.arrayContaining([
      { nodeId: "saveVideo", field: "*", kind: "video" }, { nodeId: "saveImage", field: "*", kind: "image" },
    ]));
    expect(prepared.analysis.outputs).toHaveLength(2);
    expect(prepared.config.nodeKind).toBe("file");
    const executionSource = structuredClone(source);
    executionSource.saveVideo.inputs.save_output = true;
    const received = await readAIFisherWorkflow({ environment: "comfyui", source: executionSource, objectInfo: info, promptId: "receipt", history: {
      receipt: { status: { status_str: "success", completed: true }, outputs: { saveVideo: { images: [{ filename: "result.mp4", type: "output", subfolder: "" }] }, saveImage: { images: [{ filename: "cover.png", type: "output", subfolder: "" }] } } },
    } });
    expect(received.outputEvidence.outputs.map(output => output.mediaKind)).toEqual(["video", "image"]);
    expect(prepared.graph).toEqual(source);
  });

  it("retains an ordinary UI artifact pending when object_info is missing instead of falling back to the old converter", async () => {
    const ui = { version: 0.4, nodes: [{ id: 1, type: "SaveImage", pos: [0, 0], inputs: [], outputs: [], widgets_values: ["keep-this"] }], links: [] };
    const prepared = await prepareWorkflowImport(ui, "unresolved.json", undefined, reader);
    expect(prepared.importState.status).toBe("pending");
    expect(prepared.graph).toBeUndefined();
    expect(prepared.source).toEqual(ui);
    expect(prepared.config.importReader).toMatchObject({ environment: "comfyui", compileStatus: "needs-runtime-capabilities" });
    expect(prepared.importState.environmentReport?.capabilities).toBe("unavailable");
    expect(prepared.importState.diagnostics.some(item => item.code === "OBJECT_INFO_REQUIRED" && item.message.includes("节点定义"))).toBe(true);
  });

  it("does not make positional UI widget mapping executable even when object_info is supplied", async () => {
    const ui = { version: 0.4, nodes: [{ id: 1, type: "SaveImage", pos: [0, 0], inputs: [], outputs: [], widgets_values: ["keep-this"] }], links: [] };
    const prepared = await prepareWorkflowImport(ui, "positional.json", { SaveImage: { input: { required: { filename_prefix: ["STRING"] } }, output: [], output_node: true } }, reader);
    expect(prepared.importState.status).toBe("pending");
    expect(prepared.graph).toBeUndefined();
    expect(prepared.config.importReader).toMatchObject({ compileStatus: "needs-confirmation" });
  });

  it("imports an unambiguous named-widget UI artifact using its real runtime input definitions", async () => {
    const ui = { version: 0.4, nodes: [
      { id: 1, type: "LoadImage", pos: [0, 0], inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }], widgets_values: { image: "my-existing-reference.png" } },
      { id: 2, type: "SaveImage", pos: [400, 0], inputs: [{ name: "images", type: "IMAGE", link: 1 }], outputs: [], widgets_values: { filename_prefix: "saved" } },
    ], links: [[1, 1, 0, 2, 0, "IMAGE"]] };
    const expected = { "1": { class_type: "LoadImage", inputs: { image: "my-existing-reference.png" }, _meta: { title: "LoadImage" } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "saved" }, _meta: { title: "SaveImage" } } };
    const prepared = await prepareWorkflowImport(ui, "named-widgets.json", info, reader);
    expect(prepared.importState.status).toBe("ready");
    expect(prepared.graph).toEqual(expected);
    const definition = convertLibraryWorkflow(prepared.config, prepared.graph, prepared.requirements, origin);
    expect(definition.template).toEqual(expected);
    expect(prepared.source).toEqual(ui);
  });

  it("keeps source branches and authored output settings when only explicit user inputs are applied at runtime", async () => {
    const prepared = await prepareWorkflowImport(source, "video_api.json", info, reader);
    const definition = convertLibraryWorkflow(prepared.config, prepared.graph, prepared.requirements, origin);
    const selected = selectWorkflowOutput(definition, {});
    expect(selected).toBe(definition);
    const params = Object.fromEntries(definition.parameters.map(parameter => [parameter.key, parameter.default]));
    const node = { data: { generation: { prompt: "Explicit user prompt", negativePrompt: "", params, workflowId: definition.id, taskId: null } } } as CanvasNode;
    const expected = structuredClone(source);
    expected.prompt.inputs.prompt = "Explicit user prompt";
    expected.load.inputs.image = "uploaded-reference.png";
    const selectedInputs = [{ semantic: "slot:input1", asset: { id: "reference", name: "selected.png", kind: "image" } }] as ResolvedInput[];
    // A task-specific runtime prefix must not override an upstream field that
    // is already represented by an authored/default parameter.
    const result = buildWorkflow(selected, node, selectedInputs, { reference: "uploaded-reference.png" }, "task-specific-prefix");
    expect(result.workflow).toEqual(expected);
    expect(definition.template).toEqual(source);
  });

  it("binds existing autogrow loader slots without inventing scalar group inputs or changing links", async () => {
    const dynamicSource = {
      "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
      "2": { class_type: "LoadImage", inputs: { image: "b.png" } },
      "3": { class_type: "ReferenceCollection", inputs: { "references.image0": ["1", 0], "references.image1": ["2", 0] } },
      "4": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "result" } },
    };
    const dynamicInfo = {
      LoadImage: { input: { required: { image: [["a.png", "b.png"], { image_upload: true }] } }, output: ["IMAGE"] },
      ReferenceCollection: { input: { optional: { references: ["COMFY_AUTOGROW_V3", { template: { prefix: "image", min: 1, max: 9, input: { required: { image: ["IMAGE"] } } } }] } }, output: ["IMAGE"] },
      SaveImage: info.SaveImage,
    };
    const read = await reader({ environment: "comfyui", source: dynamicSource, objectInfo: dynamicInfo });
    expect(read.bindingCandidates.find(candidate => candidate.valueType === "ASSET_GROUP")).toMatchObject({ nodeId: "3", fieldName: "references" });
    expect(() => assertAifisherVariableAssetsSupported(read)).not.toThrow();
    const prepared = await prepareWorkflowImport(dynamicSource, "dynamic_api.json", dynamicInfo, reader);
    expect(prepared.importState.status).toBe("ready");
    expect(prepared.graph).toEqual(dynamicSource);
    expect(prepared.source).toEqual(dynamicSource);
    expect(prepared.importState.diagnostics.some(item => item.code === "aifisher-variable-asset-runtime-required")).toBe(false);
    const definition = convertLibraryWorkflow(prepared.config, prepared.graph, prepared.requirements, origin);
    expect(definition.inputSlots).toHaveLength(2);
    const params = Object.fromEntries(definition.parameters.map(parameter => [parameter.key, parameter.default]));
    const node = { data: { generation: { prompt: "", negativePrompt: "", params, workflowId: definition.id, taskId: null } } } as CanvasNode;
    const references = [{ semantic: "slot:input1", asset: { id: "a", name: "a.png", kind: "image" } },
      { semantic: "slot:input2", asset: { id: "b", name: "b.png", kind: "image" } }] as ResolvedInput[];
    const built = buildWorkflow(definition, node, references, { a: "uploaded-a.png", b: "uploaded-b.png" }, "test");
    const expected = structuredClone(dynamicSource);
    expected["1"].inputs.image = "uploaded-a.png";
    expected["2"].inputs.image = "uploaded-b.png";
    expect(built.workflow).toEqual(expected);
    expect(definition.template).toEqual(dynamicSource);
    const invalid = structuredClone(read);
    const group = invalid.bindingCandidates.find(candidate => candidate.valueType === "ASSET_GROUP")!;
    (group.variableAssetGroup as any).branches[0].connections[0].outputIndex = 99;
    expect(() => assertAifisherVariableAssetsSupported(invalid)).toThrow("动态素材组 references");
  });
});


it("retains FLOAT contracts with integer defaults and allows decimal edits at runtime", async () => {
  const graph = structuredClone(source);
  graph.disconnected.inputs.weight = 1;
  const prepared = await prepareWorkflowImport(graph, "float.json", info, reader);
  expect((prepared.config.parameters as Array<Record<string, unknown>>).find(item => item.id === "weight")).toMatchObject({ type: "float", defaultValue: 1 });
  const definition = convertLibraryWorkflow(prepared.config, prepared.graph, prepared.requirements, origin);
  expect(definition.parameters.find(item => item.key === "weight")).toMatchObject({ type: "number", numericType: "float", default: 1 });
  const params = Object.fromEntries(definition.parameters.map(item => [item.key, item.default]));
  params.weight = 0.85;
  const node = { data: { generation: { prompt: "test", negativePrompt: "", params, workflowId: definition.id, taskId: null } } } as CanvasNode;
  const references = [{ semantic: "slot:input1", asset: { id: "reference", name: "selected.png", kind: "image" } }] as ResolvedInput[];
  const built = buildWorkflow(definition, node, references, { reference: "uploaded.png" }, "test");
  expect(built.workflow.disconnected.inputs.weight).toBe(0.85);
  expect(prepared.graph!.disconnected.inputs.weight).toBe(1);
});

it("passes cancellation into the reader and never converts a cancellation to a pending import", async () => {
  const controller = new AbortController();
  const cancelledReader = async (_request: AifisherWorkflowReadRequest, signal?: AbortSignal): Promise<AifisherWorkflowReadResult> => {
    expect(signal).toBe(controller.signal);
    return new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      controller.abort(new DOMException("cancel import", "AbortError"));
    });
  };
  await expect(prepareWorkflowImport(source, "cancel.json", info, cancelledReader, controller.signal)).rejects.toThrow("cancel import");
});
