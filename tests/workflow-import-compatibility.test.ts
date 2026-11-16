import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { convertEditorWorkflow, workflowImportInputSchema } from "../src/workflow/import-editor";
import { prepareApiWorkflow } from "../src/workflow/import-api";
import { prepareWorkflowImport } from "../src/workflow/import-pipeline";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";

// These format tuples and loader compatibility fields come from the captured
// VideoHelperSuite object_info and its upstream onConfigure implementation.
const combine = { input: { required: {
  images: ["IMAGE"], frame_rate: ["FLOAT"], loop_count: ["INT"], filename_prefix: ["STRING"],
  format: [["image/gif", "video/h264-mp4"], { formats: { "video/h264-mp4": [
    ["pix_fmt", ["yuv420p", "yuv420p10le"]], ["crf", "INT", { default: 19, min: 0, max: 100 }],
    ["save_metadata", "BOOLEAN", { default: true }], ["trim_to_audio", "BOOLEAN", { default: false }],
  ] } }], pingpong: ["BOOLEAN"], save_output: ["BOOLEAN"],
} }, output: ["VHS_FILENAMES"], output_node: true };
const source = { input: { required: {} }, output: ["IMAGE"] };
const info = { VHS_VideoCombine: combine, ImageSource: source };
const values = { frame_rate: 24, loop_count: 0, filename_prefix: "author/prefix", format: "video/h264-mp4", pix_fmt: "yuv420p", crf: 19, save_metadata: false, trim_to_audio: false, pingpong: false, save_output: true };
const file = (widgets_values: unknown = values) => ({ nodes: [
  { id: 1, type: "ImageSource", widgets_values: [], outputs: [{ type: "IMAGE" }] },
  { id: 2, type: "VHS_VideoCombine", inputs: [{ name: "images", type: "IMAGE", link: 1 }], widgets_values },
], links: [[1, 1, 0, 2, 0, "IMAGE"]] });

describe("serialized workflow compatibility", () => {
  it.each(["named", "array"])("expands exact format widget definitions for %s editor saves", mode => {
    const saved = file(mode === "named" ? { ...values, videopreview: { params: { filename: "old-preview.mp4" } } } : Object.values(values));
    const before = structuredClone(saved), contracts = structuredClone(info);
    const result = convertEditorWorkflow(saved, info);
    expect(result.graph["2"].inputs).toEqual({ ...values, images: ["1", 0] });
    expect(saved).toEqual(before); expect(info).toEqual(contracts);
  });

  it("exposes the same format-specific contract to API validation without changing saved fields", () => {
    const graph = { "1": { class_type: "ImageSource", inputs: {} }, "2": { class_type: "VHS_VideoCombine", inputs: { ...values, images: ["1", 0] } } };
    const schema = workflowImportInputSchema(graph["2"], combine);
    expect(schema.required).toMatchObject({ pix_fmt: [["yuv420p", "yuv420p10le"], {}], crf: ["INT", { default: 19, min: 0, max: 100 }] });
    expect(prepareApiWorkflow(graph, info)).toMatchObject({ graph, repairs: [], errors: [] });
  });

  it("does not treat loader preset dictionaries as input widgets or accept undeclared fields", () => {
    const schema = { input: { required: { format: [["AnimateDiff"], { formats: { AnimateDiff: { target_rate: 8, dim: [8, 0, 512, 512] } } }] } }, output: [] };
    expect(Object.keys(workflowImportInputSchema({ class_type: "Loader", inputs: { format: "AnimateDiff" } }, schema).required)).toEqual(["format"]);
    expect(() => convertEditorWorkflow(file({ ...values, made_up: 1 }), info)).toThrow("made_up");
    const duplicate = structuredClone(combine); (duplicate.input.required.format[1] as { formats: Record<string, unknown[]> }).formats["video/h264-mp4"].push(["crf", "INT"]);
    expect(() => convertEditorWorkflow(file(), { ...info, VHS_VideoCombine: duplicate })).toThrow("重复定义");
  });

  it("restores explicit named snapshots without guessing array order", () => {
    const saved = { nodes: [{ id: 1, type: "OwnColorTool", widgets_values: [0, 1, -10], widgets_values_named: { contrast: -10, temperature: 0, gamma: 1 }, outputs: [{ type: "IMAGE" }] }], links: [] };
    const result = convertEditorWorkflow(saved);
    expect(result.graph["1"].inputs).toEqual({ contrast: -10, temperature: 0, gamma: 1 });
    const incomplete = structuredClone(saved); delete (incomplete.nodes[0].widgets_values_named as Record<string, number>).gamma;
    expect(() => convertEditorWorkflow(incomplete)).toThrow("快照不完整");
    const stale = structuredClone(saved); stale.nodes[0].widgets_values_named.gamma = 9;
    expect(() => convertEditorWorkflow(stale)).toThrow("快照与保存值不一致");
  });

  it("cross-checks named values against a trusted widget order instead of accepting a same-value permutation", () => {
    const schema = { OwnColorTool: { input: { required: { temperature: ["FLOAT"], gamma: ["FLOAT"] } }, input_order: { required: ["temperature", "gamma"] }, output: ["IMAGE"] } };
    const saved = { nodes: [{ id: 1, type: "OwnColorTool", widgets_values: [0, 1], widgets_values_named: { temperature: 1, gamma: 0 }, outputs: [{ type: "IMAGE" }] }], links: [] };
    expect(() => convertEditorWorkflow(saved, schema)).toThrow("控件顺序不一致");
    const correct = structuredClone(saved); correct.nodes[0].widgets_values_named = { temperature: 0, gamma: 1 };
    expect(convertEditorWorkflow(correct, schema).graph["1"].inputs).toEqual({ temperature: 0, gamma: 1 });
  });

  it("keeps selected dynamic branches from complete named snapshots when the server definition is absent", () => {
    const saved = { nodes: [{ id: 1, type: "OwnUpscaler", widgets_values: ["scale by multiplier", 2], widgets_values_named: { mode: "scale by multiplier", "mode.scale": 2 }, inputs: [
      { name: "mode", type: "COMFY_DYNAMICCOMBO_V3", widget: { name: "mode" } },
      { name: "mode.scale", type: "FLOAT", widget: { name: "mode.scale" } },
    ], outputs: [{ type: "IMAGE" }] }], links: [] };
    const result = convertEditorWorkflow(saved);
    expect(result.graph["1"].inputs).toEqual({ mode: "scale by multiplier", "mode.scale": 2 });
    const schema = result.objectInfo.OwnUpscaler as { input: { required: Record<string, unknown[]> } };
    expect(schema.input.required.mode[0]).toEqual(["scale by multiplier"]);
    expect(schema.input.required).toHaveProperty("mode.scale");
  });

  it("restores saved primitive hidden widgets but leaves server-owned hidden fields alone", () => {
    const schema = { OwnExists: { input: { optional: { Any: ["IMAGE"] }, hidden: { gh_input_type: ["STRING", { default: "ANY" }], unique_id: "UNIQUE_ID" } }, output: ["IMAGE", "BOOLEAN"] } };
    const saved = { nodes: [{ id: 1, type: "OwnExists", widgets_values: ["IMAGE"], widgets_values_named: { gh_input_type: "IMAGE" }, properties: { gh_input_type: "IMAGE" }, outputs: [{ type: "IMAGE" }, { type: "BOOLEAN" }] }], links: [] };
    expect(convertEditorWorkflow(saved, schema).graph["1"].inputs).toEqual({ gh_input_type: "IMAGE" });
  });

  it.each(["array", "named"])("does not send the frontend after-generate state from a %s save as an API input", mode => {
    const schema = { PrimitiveInt: { input: { required: { value: ["INT", { control_after_generate: "fixed" }] } }, output: ["INT"] } };
    const saved = { nodes: [{ id: 1, type: "PrimitiveInt", widgets_values: mode === "array" ? [20, "fixed"] : { value: 20, control_after_generate: "fixed" }, outputs: [{ type: "INT" }] }], links: [] };
    expect(convertEditorWorkflow(saved, schema).graph["1"].inputs).toEqual({ value: 20 });
  });

  it("preserves a legitimate following STRING widget containing fixed when a seed has no declared UI control", () => {
    const schema = { OwnSeed: { input: { required: { seed: ["INT"] }, optional: { label: ["STRING"] } }, output: ["INT"] } };
    const saved = { nodes: [{ id: 1, type: "OwnSeed", widgets_values: [20, "fixed"], outputs: [{ type: "INT" }] }], links: [] };
    expect(convertEditorWorkflow(saved, schema).graph["1"].inputs).toEqual({ seed: 20, label: "fixed" });
    const surplus = structuredClone(saved); surplus.nodes[0].widgets_values = [20, "fixed", "my label"];
    expect(convertEditorWorkflow(surplus, schema).graph["1"].inputs).toEqual({ seed: 20, label: "my label" });
  });

  it.each([["Disabled", 0, 0], ["1280x720", 1280, 720], ["512x?", 512, 0], ["?x768", 0, 768]])("migrates VHS force_size %s like its own frontend", (force_size, width, height) => {
    const schema = { VHS_LoadVideo: { input: { required: { video: ["STRING"], custom_width: ["INT"], custom_height: ["INT"] }, hidden: { force_size: "STRING" } }, output: ["IMAGE"] } };
    const saved = { nodes: [{ id: 1, type: "VHS_LoadVideo", widgets_values: { video: "author.mp4", custom_width: 1, custom_height: 2, force_size, "choose video to upload": "image", videopreview: {} }, outputs: [{ type: "IMAGE" }] }], links: [] };
    const before = structuredClone(saved);
    expect(convertEditorWorkflow(saved, schema).graph["1"].inputs).toEqual({ video: "author.mp4", custom_width: width, custom_height: height });
    expect(saved).toEqual(before);
  });

  it("rejects unknown legacy size modes and preserves a still-declared optional force_size", () => {
    const schema = { VHS_LoadVideo: { input: { required: { video: ["STRING"], custom_width: ["INT"], custom_height: ["INT"] }, hidden: { force_size: "STRING" } }, output: ["IMAGE"] } };
    const saved = { nodes: [{ id: 1, type: "VHS_LoadVideo", widgets_values: { video: "author.mp4", custom_width: 512, custom_height: 768, force_size: "unknown-mode" }, outputs: [{ type: "IMAGE" }] }], links: [] };
    expect(() => convertEditorWorkflow(saved, schema)).toThrow("无法可靠迁移");
    const declared = { VHS_LoadVideo: { ...schema.VHS_LoadVideo, input: { ...schema.VHS_LoadVideo.input, optional: { force_size: ["STRING"] } } } };
    expect(convertEditorWorkflow(saved, declared).graph["1"].inputs).toEqual(saved.nodes[0].widgets_values);
  });
});

for (const [filename, nodes] of [["E:/123/MiniMaxH3-双时钟采样加速Lora.json", 6], ["E:/123/海螺H3视频编辑-人物替换V1+.json", 28], ["E:/123/DFCine/MiniMax - H3 智能一体化视频创作 V3.json", 22]] as const) {
  for (const actualInfo of [".cache/cloud-final-object-info.json", ".cache/cloud-current-object-info-20261016.json"]) {
  it.skipIf(!existsSync(filename) || !existsSync(actualInfo))("preserves the actual GUI source and reads its named API conversion: " + filename + " with " + actualInfo, async () => {
    const bytes = readFileSync(filename), original = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
    const definition = JSON.parse(readFileSync(actualInfo, "utf8"));
    const result = convertEditorWorkflow(original, definition.objectInfo ?? definition);
    expect(Object.keys(result.graph)).toHaveLength(nodes);
    const prepared = await prepareWorkflowImport(original, filename.split("/").at(-1)!, definition.objectInfo ?? definition,
      async request => await readAIFisherWorkflow(request) as AifisherWorkflowReadResult);
    // These cached catalogs do not establish all source plugin/widget contracts.
    // The upstream reader keeps the GUI source pending instead of guessing.
    expect(prepared.importState.status).toBe("pending");
    expect(prepared.graph).toBeUndefined();
    expect(prepared.source).toEqual(original);
    expect(prepared.config.importReader).toMatchObject({ revision: "bdcf3bec054594fcab591952a8c5acef858d6de4" });
    expect(prepared.importState.diagnostics.some(item => ["MISSING_NODE_TYPE", "POSITIONAL_WIDGET_MAPPING_REQUIRES_CONFIRMATION", "AMBIGUOUS_WIDGET_MAPPING", "AMBIGUOUS_WIDGET_COUNT"].includes(item.code))).toBe(true);
    // API exports name their inputs and preserve the legacy helper's exact
    // graph independently of the unresolved original GUI widget order.
    const api = await prepareWorkflowImport(result.graph, "converted_api.json", definition.objectInfo ?? definition,
      async request => await readAIFisherWorkflow(request) as AifisherWorkflowReadResult);
    expect(api.importState.status, JSON.stringify({ reader: api.config.importReader,
      diagnostics: api.importState.diagnostics.map(({ code, nodeId, field }) => ({ code, nodeId, field })),
      errors: api.analysis.errors.slice(0, 2) })).toBe("ready");
    expect(api.graph).toEqual(result.graph);
    expect(api.source).toEqual(result.graph);
    expect(readFileSync(filename)).toEqual(bytes);
    if (filename.includes("智能一体化")) {
      expect([...new Set(api.importState.environmentReport!.issues.filter(item => item.category === "missing-node").map(item => item.classType))].sort()).toEqual([
        "ColorCorrect", "GoohaiAnyExists", "GoohaiMinimaxH3LatentUpscalerGH", "GoohaiMinimaxH3TiledSampler", "GoohaiUniversalSlider",
        "MiniMaxH3AVDecodeT8GH", "MiniMaxH3DualClockT8GH", "MiniMaxH3IntegrationAdapterGH", "MiniMaxH3IntegrationGH",
      ]);
      expect(result.graph["232"].inputs.gh_input_type).toBe("IMAGE");
      expect(result.graph["244"].inputs.mode).toBe("scale by multiplier");
      expect(result.graph["244"].inputs["mode.scale"]).toEqual(["228", 0]);
      expect(result.graph["252"].inputs).toMatchObject({ temperature: 0, hue: 1, brightness: 0, contrast: -10, saturation: -10, gamma: 1 });
    }
  });
  }
}
