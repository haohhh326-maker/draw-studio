import { describe, expect, it } from "vitest";
import type { ApiWorkflow, CanvasNode, Parameter, WorkflowDefinition } from "../src/types";
import { prepareRunningHubApp, prepareRunningHubWorkflowCandidates } from "../src/runninghub/workflows";
import { generationParameterSurface, parameterRole, dimensionRatioControls, dimensionRatioPatch, dimensionRatioValue, runningHubDefaultCanvasParameterKeys } from "../src/generation/parameter-actions";
import { selectRunningHubBindings } from "../src/runninghub/selected-bindings";
import { defaults } from "../src/workflow/catalog";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { withRunningHubAppReader, withRunningHubWorkflowReader } from "./runninghub-test-reader";
import type { RunningHubAiApp } from "../src/runninghub/client";

function fullGraph(): ApiWorkflow {
  const graph: ApiWorkflow = {
    model: { class_type: "UNETLoader", inputs: { unet_name: "generator.safetensors" } },
    vae: { class_type: "VAELoader", inputs: { vae_name: "generator_vae.safetensors" } },
    lora: { class_type: "LoraLoaderModelOnly", inputs: { model: ["model", 0], lora_name: "motion.safetensors", strength_model: 1 } },
    noise: { class_type: "RandomNoise", inputs: { noise_seed: 915535698798554 } },
    duration: { class_type: "PrimitiveFloat", _meta: { title: "Float (duration)" }, inputs: { value: 5 } },
    resolution: { class_type: "ResolutionSelector", inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: .7 } },
    latent: { class_type: "EmptyLTXVLatentVideo", inputs: { width: ["resolution", 0], height: ["resolution", 1], length: ["duration", 0], batch_size: 1 } },
    sampler: { class_type: "SamplerCustomAdvanced", inputs: { model: ["lora", 0], noise: ["noise", 0], latent_image: ["latent", 0], steps: 40, sampler_name: "euler", cfg: 1.2 } },
    upscale: { class_type: "MiniMaxH3LearnedLatentUpscaleT8Advanced", inputs: { samples: ["sampler", 0], target_width: 1280, target_height: 704 } },
    llm: { class_type: "RH_LLMAPI_Pro_Node", inputs: { seed: 978706083, temperature: .7, system_prompt: "[sanitized helper prompt]" } },
    decode: { class_type: "VAEDecode", inputs: { samples: ["upscale", 0], vae: ["vae", 0] } },
    save: { class_type: "VHS_VideoCombine", inputs: { images: ["decode", 0], frame_rate: 24, filename_prefix: "original/result", save_output: true } },
  };
  for (let index = 1; index <= 6; index++) graph["resize-" + index] = { class_type: "LayerUtility: ImageScaleByAspectRatio V2", inputs: {
    image: ["decode", 0], aspect_ratio: "original", scale_to_side: "longest", scale_to_length: 1024,
  } };
  return graph;
}
async function imported(graph = fullGraph()) {
  const options = { workflowId: "1234567890123456789", baseUrl: "https://www.runninghub.cn", name: "完整视频工作流", promptKey: "",
    outputs: [{ nodeId: "save", field: "gifs", kind: "video" as const }] };
  return prepareRunningHubWorkflowCandidates(graph, await withRunningHubWorkflowReader(graph, options)).workflow;
}
function boundParameter(workflow: WorkflowDefinition, nodeId: string, field: string): Parameter {
  const key = workflow.mapping.find(mapping => mapping.nodeId === nodeId && mapping.field === field)?.semantic;
  const parameter = workflow.parameters.find(parameter => parameter.key === key);
  if (!parameter) throw new Error("Missing fixture parameter: " + nodeId + "." + field);
  return parameter;
}
function visible(workflow: WorkflowDefinition, values?: Record<string, string | number | boolean>) {
  const surface = generationParameterSurface(workflow, values);
  return [...surface.basic, ...surface.advanced, ...surface.other];
}
function canvasNode(workflow: WorkflowDefinition, params: Record<string, string | number | boolean>): CanvasNode {
  return { id: "video", position: { x: 0, y: 0 }, data: { kind: "video", title: "视频", generation: {
    workflowId: workflow.id, prompt: "", negativePrompt: "", params, taskId: null,
  } } };
}
async function appFixture(fields: RunningHubAiApp["nodeInfoList"]) {
  return prepareRunningHubApp(await withRunningHubAppReader({ apiVersion: "v1", outputKind: "image", nodeInfoList: fields }),
    { workflowId: "1234567890123456789", baseUrl: "https://www.runninghub.cn", name: "公开应用" }).workflow;
}

describe("RunningHub source-owned parameter presentation", () => {
  it("shows every ordinary source control, including internal resize and helper fields", async () => {
    const workflow = await imported(), before = structuredClone(workflow), shown = visible(workflow);
    expect(new Set(shown.map(parameter => parameter.key))).toEqual(new Set(workflow.parameters.map(parameter => parameter.key)));
    for (const [node, field] of [["llm", "seed"], ["upscale", "target_width"], ["resize-1", "aspect_ratio"], ["save", "filename_prefix"]])
      expect(shown.some(parameter => parameter.key === boundParameter(workflow, node, field).key)).toBe(true);
    for (const parameter of shown) expect(parameter.label).toBe(workflow.parameters.find(source => source.key === parameter.key)!.label);
    expect(workflow).toEqual(before);
  });

  it("never changes the complete graph, defaults or bindings while presenting source controls", async () => {
    const graph = fullGraph(), beforeGraph = structuredClone(graph), workflow = await imported(graph), beforeWorkflow = structuredClone(workflow);
    const values = defaults(workflow), shown = visible(workflow);
    expect(shown).toHaveLength(workflow.parameters.length);
    expect(new Set(shown.map(parameter => parameter.key)).size).toBe(shown.length);
    expect(new Set(runningHubDefaultCanvasParameterKeys(workflow))).toEqual(new Set(shown.map(parameter => parameter.key)));
    for (const parameter of shown) expect(parameter.default).toBe(values[parameter.key]);
    expect(buildWorkflow(workflow, canvasNode(workflow, values), [], {}).workflow).toEqual(beforeGraph);
    expect(workflow).toEqual(beforeWorkflow); expect(graph).toEqual(beforeGraph);
  });

  it("keeps exact writes for secondary seed, upscale dimensions and all six resize ratios", async () => {
    const workflow = await imported(), before = structuredClone(workflow);
    const changes = { [boundParameter(workflow, "llm", "seed").key]: 88, [boundParameter(workflow, "upscale", "target_width").key]: 1536,
      [boundParameter(workflow, "upscale", "target_height").key]: 864,
      ...Object.fromEntries(Array.from({ length: 6 }, (_, index) => [boundParameter(workflow, "resize-" + (index + 1), "aspect_ratio").key, "4:3"])) };
    const execution = buildWorkflow(workflow, canvasNode(workflow, { ...defaults(workflow), ...changes }), [], {}).workflow;
    expect(execution.llm.inputs.seed).toBe(88); expect(execution.upscale.inputs.target_width).toBe(1536); expect(execution.upscale.inputs.target_height).toBe(864);
    for (let index = 1; index <= 6; index++) expect(execution["resize-" + index].inputs.aspect_ratio).toBe("4:3");
    expect(execution.noise.inputs.noise_seed).toBe(915535698798554);
    expect(workflow).toEqual(before);
  });

  it("retains every explicit dimension pair instead of choosing one by output distance", async () => {
    const graph = fullGraph(); delete graph.resolution; graph.latent.inputs.width = 768; graph.latent.inputs.height = 512;
    const workflow = await imported(graph), shown = visible(workflow), pairs = dimensionRatioControls(workflow);
    for (const [node, field] of [["latent", "width"], ["latent", "height"], ["upscale", "target_width"], ["upscale", "target_height"]])
      expect(shown.some(parameter => parameter.key === boundParameter(workflow, node, field).key)).toBe(true);
    expect(pairs).toHaveLength(2);
  });

  it("resolves primitive dimensions through actual consumers without renaming their source labels", async () => {
    const graph = fullGraph(); delete graph.resolution;
    graph.width = { class_type: "PrimitiveInt", _meta: { title: "Custom width" }, inputs: { value: 768 } };
    graph.height = { class_type: "PrimitiveInt", _meta: { title: "Custom height" }, inputs: { value: 512 } };
    graph.latent.inputs.width = ["width", 0]; graph.latent.inputs.height = ["height", 0];
    const workflow = await imported(graph), width = boundParameter(workflow, "width", "value"), height = boundParameter(workflow, "height", "value");
    expect(parameterRole(width, workflow)).toBe("width"); expect(parameterRole(height, workflow)).toBe("height");
    expect(visible(workflow).find(parameter => parameter.key === width.key)?.label).toBe(width.label);
    expect(visible(workflow).find(parameter => parameter.key === height.key)?.label).toBe(height.label);
  });

  it("never exposes credential controls or dedicated connected text inputs", async () => {
    const workflow = await imported();
    workflow.parameters.push({ key: "secret", label: "API Key", type: "text", default: "", secret: true },
      { key: "connected-text", label: "文本输入", type: "text", default: "", inputText: true });
    expect(visible(workflow).some(parameter => parameter.secret || parameter.inputText)).toBe(false);
  });

  it("keeps explicitly selected ratio and dimensions without adding unrelated source controls", async () => {
    const source = await imported(), ratio = boundParameter(source, "resolution", "aspect_ratio"), width = boundParameter(source, "upscale", "target_width"), height = boundParameter(source, "upscale", "target_height");
    const selected = selectRunningHubBindings(source, [ratio.key, width.key, height.key]), before = structuredClone(selected);
    expect(new Set(visible(selected).map(parameter => parameter.key))).toEqual(new Set([ratio.key, width.key, height.key]));
    expect(selected).toEqual(before);
  });

  it("cannot restore pruned dimensions through stale old node values", async () => {
    const source = await imported(), ratio = boundParameter(source, "resolution", "aspect_ratio"), width = boundParameter(source, "upscale", "target_width");
    const selected = selectRunningHubBindings(source, [ratio.key]);
    expect(visible(selected, { [ratio.key]: "16:9", [width.key]: 1920 }).map(parameter => parameter.key)).toEqual([ratio.key]);
    expect(selected.template!.upscale.inputs.target_width).toBe(1280);
  });

  it("keeps public app dimensions directly available and edits their same source values", async () => {
    const workflow = await appFixture([{ nodeId: "1", fieldName: "prompt", fieldValue: "[sanitized prompt]", fieldType: "STRING" },
      { nodeId: "2", fieldName: "width", fieldValue: 1280, fieldType: "INT" }, { nodeId: "2", fieldName: "height", fieldValue: 1920, fieldType: "INT" }]);
    const surface = generationParameterSurface(workflow), width = boundParameter(workflow, "2", "width"), height = boundParameter(workflow, "2", "height");
    expect(new Set(surface.basic.map(parameter => parameter.key))).toEqual(new Set([width.key, height.key]));
    const controls = dimensionRatioControls(workflow), values = defaults(workflow), patch = dimensionRatioPatch(controls[0], "16:9", values);
    expect(controls).toHaveLength(1); expect(patch).toBeDefined();
    expect(dimensionRatioValue(controls[0], { ...values, ...patch })).toBe("16:9");
    expect(values[width.key]).toBe(1280); expect(values[height.key]).toBe(1920);
  });

  it("recognizes neutral public width labels only for RH and retains each original label", async () => {
    const workflow = await appFixture([{ nodeId: "60", fieldName: "value", fieldValue: 1280, fieldType: "INT", description: "宽" },
      { nodeId: "61", fieldName: "value", fieldValue: 1920, fieldType: "INT", description: "高" }]);
    expect(workflow.parameters.map(parameter => parameterRole(parameter, workflow))).toEqual(["width", "height"]);
    expect(visible(workflow).map(parameter => parameter.label)).toEqual(["宽", "高"]);
    const cloud = structuredClone(workflow); delete cloud.runninghub;
    expect(cloud.parameters.map(parameter => parameterRole(parameter, cloud))).toEqual([undefined, undefined]);
  });

  it("does not silently drop the helper seed when no main sampling seed is published", async () => {
    const graph = fullGraph(); delete graph.noise.inputs.noise_seed;
    const workflow = await imported(graph), helper = boundParameter(workflow, "llm", "seed");
    expect(visible(workflow).some(parameter => parameter.key === helper.key)).toBe(true);
  });

  it("retains sampling steps from helper and disconnected nodes in the source parameter set", async () => {
    const graph = fullGraph(); graph.llm.inputs.steps = 99; graph.auxSampler = { class_type: "AuxSampler", inputs: { steps: 80, seed: 7 } };
    const workflow = await imported(graph), keys = new Set(visible(workflow).map(parameter => parameter.key));
    for (const node of ["sampler", "llm", "auxSampler"]) expect(keys.has(boundParameter(workflow, node, "steps").key)).toBe(true);
  });

  it("does not invent latent controls when only internal resizing has scalar dimensions", async () => {
    const graph = fullGraph(); delete graph.resolution;
    graph.dimensions = { class_type: "CustomDimensionSource", inputs: { precision: "auto" } };
    graph.latent.inputs.width = ["dimensions", 0]; graph.latent.inputs.height = ["dimensions", 1];
    const workflow = await imported(graph);
    expect(workflow.mapping.some(mapping => mapping.nodeId === "latent" && ["width", "height"].includes(mapping.field))).toBe(false);
    expect(visible(workflow).some(parameter => parameter.key === boundParameter(workflow, "upscale", "target_width").key)).toBe(true);
    expect(workflow.template).toEqual(graph);
  });

  it("retains scalar Primitive and custom value controls independently of their output slot", async () => {
    for (const classType of ["MathConstant", "PrimitiveInt"]) for (const slot of [0, 1]) {
      const graph = fullGraph(); graph.fake = { class_type: classType, inputs: { value: 123 } }; graph.sampler.inputs.seed = ["fake", slot];
      const workflow = await imported(graph), value = boundParameter(workflow, "fake", "value");
      expect(visible(workflow).filter(parameter => parameter.key === value.key)).toHaveLength(1);
      expect(workflow.template!.sampler.inputs.seed).toEqual(["fake", slot]);
    }
  });

  it("honors explicit custom and empty binding selections without changing source defaults", async () => {
    const source = await imported(), custom = boundParameter(source, "llm", "temperature"), before = structuredClone(source);
    const selected = selectRunningHubBindings(source, [custom.key]), empty = selectRunningHubBindings(source, []);
    expect(visible(selected).map(parameter => parameter.key)).toEqual([custom.key]);
    expect(visible(empty)).toEqual([]);
    expect(runningHubDefaultCanvasParameterKeys(source)).toHaveLength(source.parameters.length);
    expect(source).toEqual(before);
  });

  it("cannot revive unbound writes through stale nondefault generation values", async () => {
    const source = await imported(), width = boundParameter(source, "upscale", "target_width"), ratio = boundParameter(source, "resize-1", "aspect_ratio");
    const empty = selectRunningHubBindings(source, []), values = { [width.key]: 1536, [ratio.key]: "4:3", orphanedOldKey: "legacy value" }, before = structuredClone(values);
    expect(visible(empty, values)).toEqual([]);
    const execution = buildWorkflow(empty, canvasNode(empty, values), [], {}).workflow;
    expect(execution.upscale.inputs.target_width).toBe(1280); expect(execution["resize-1"].inputs.aspect_ratio).toBe("original");
    expect(values).toEqual(before);
  });

  it("retains public required fields and enum wire values without inventing absent source bounds", async () => {
    const workflow = await appFixture([{ nodeId: "1", fieldName: "prompt", fieldValue: "[sanitized prompt]", fieldType: "STRING" },
      { nodeId: "2", fieldName: "business_control", fieldValue: "", fieldType: "STRING", required: true, description: "必须填写的业务字段" },
      { nodeId: "3", fieldName: "variant", fieldValue: "a", fieldType: "LIST", fieldData: [["a", "b"], {}], required: true },
      { nodeId: "4", fieldName: "opaque_scale", fieldValue: 2, fieldType: "FLOAT", required: true, min: .5, max: 8, step: .5 },
      { nodeId: "5", fieldName: "api_key", fieldValue: "", fieldType: "API_KEY", secret: true }]);
    const shown = visible(workflow), variant = boundParameter(workflow, "3", "variant"), scale = boundParameter(workflow, "4", "opaque_scale");
    expect(shown).toHaveLength(3);
    expect(boundParameter(workflow, "2", "business_control")).toMatchObject({ type: "text", required: true, default: "" });
    expect(variant.options?.map(id => variant.optionValues?.[id])).toEqual(["a", "b"]);
    expect(variant.default).toBe("a"); expect(variant.required).toBe(true);
    expect(scale).toMatchObject({ default: 2, required: true, step: .5 });
    expect(scale.min).toBeUndefined(); expect(scale.max).toBeUndefined();
  });

  it("leaves local cloud presentation on its existing independent path", async () => {
    const workflow = await imported(); delete workflow.runninghub;
    const surface = generationParameterSurface(workflow);
    expect(surface.other).toEqual([]);
    expect(surface.advanced.every(parameter => parameter.group?.startsWith("LoRA"))).toBe(true);
    expect(surface.basic.some(parameter => parameterRole(parameter, workflow) === "steps")).toBe(true);
  });
});
