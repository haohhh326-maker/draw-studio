import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type { ApiWorkflow, CanvasNode, Parameter } from "../src/types";
import { buildWorkflowImport } from "../src/workflow/import-analyzer";
import { convertLibraryWorkflow } from "../src/workflow/library-converter";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { defaults } from "../src/workflow/catalog";
import { dimensionRatioControls, dimensionRatioOptions, dimensionRatioPatch, dimensionRatioValue, generationParameterSurface, parameterRole } from "../src/generation/parameter-actions";
import { readWorkflowLibrary } from "../scripts/workflow-library-reader";

const graph = (): ApiWorkflow => ({
  checkpoint: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "author.ckpt" } },
  first: { class_type: "LoraLoader", inputs: { model: ["checkpoint", 0], clip: ["checkpoint", 1], lora_name: "first.safetensors", strength_model: .7, strength_clip: .4 } },
  second: { class_type: "LoraLoaderModelOnly", inputs: { model: ["first", 0], lora_name: "second.safetensors", strength_model: .5 } },
  positive: { class_type: "CLIPTextEncode", inputs: { clip: ["first", 1], text: "author prompt" } },
  negative: { class_type: "CLIPTextEncode", inputs: { clip: ["first", 1], text: "author negative" } },
  latent: { class_type: "EmptyLatentImage", inputs: { width: 576, height: 1024, batch_size: 1 } },
  sample: { class_type: "KSampler", inputs: { model: ["second", 0], positive: ["positive", 0], negative: ["negative", 0], latent_image: ["latent", 0], seed: 58, steps: 24, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, internal_flag: true, internal_text: "keep exact author text" } },
  decode: { class_type: "VAEDecode", inputs: { samples: ["sample", 0], vae: ["checkpoint", 2] } },
  save: { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: "author-prefix" } },
});
const info = {
  EmptyLatentImage: { input: { required: { width: ["INT", { min: 16, max: 4096, step: 8 }], height: ["INT", { min: 16, max: 4096, step: 8 }], batch_size: ["INT"] } }, output: ["LATENT"] },
  LoraLoader: { input: { required: { model: ["MODEL"], clip: ["CLIP"], lora_name: [["first.safetensors", "other.safetensors"]], strength_model: ["FLOAT", { min: -2, max: 2, step: .05 }], strength_clip: ["FLOAT", { min: -2, max: 2, step: .05 }] } }, output: ["MODEL", "CLIP"] },
  LoraLoaderModelOnly: { input: { required: { model: ["MODEL"], lora_name: [["second.safetensors", "other.safetensors"]], strength_model: ["FLOAT", { min: -2, max: 2, step: .05 }] } }, output: ["MODEL"] },
};
function imported(source: ApiWorkflow, definitions?: Record<string, unknown>) {
  const built = buildWorkflowImport(source, { id: "custom.0123456789abcdef", name: "Custom workflow", family: "图像生成" }, definitions);
  const workflow = convertLibraryWorkflow(built.config, built.graph, built.requirements, { sourcePath: "test", folder: "test", configSha256: "", executionSha256: "", executionStatus: "plain" });
  return { built, workflow };
}
const generationNode = (workflowId: string, params: Record<string, string | number | boolean>): CanvasNode => ({ id: "node", position: { x: 0, y: 0 }, data: { kind: "image-generation", title: "Test", generation: { workflowId, prompt: "", negativePrompt: "", params, taskId: null } } });

describe("imported generation parameter surface", () => {
  it("keeps only both LoRA models and their real strengths in settings, with steps primary and hidden parameters executable", () => {
    const source = graph(), before = structuredClone(source), { workflow } = imported(source, info);
    const surface = generationParameterSurface(workflow);
    const actual = surface.advanced.map(parameter => workflow.mapping.find(mapping => mapping.semantic === parameter.key)).map(mapping => `${mapping!.nodeId}.${mapping!.field}`);
    expect(actual).toEqual(["first.lora_name", "first.strength_model", "first.strength_clip", "second.lora_name", "second.strength_model"]);
    expect(surface.advanced.map(parameter => parameter.group)).toEqual(["LoRA 1", "LoRA 1", "LoRA 1", "LoRA 2", "LoRA 2"]);
    expect(surface.basic.find(parameter => parameterRole(parameter, workflow) === "steps")).toMatchObject({ label: "步数", advanced: false });
    expect(surface.basic.map(parameter => workflow.mapping.find(mapping => mapping.semantic === parameter.key)?.field)).toEqual(expect.arrayContaining(["width", "height", "seed"]));
    const values = defaults(workflow), executed = buildWorkflow(workflow, generationNode(workflow.id, values), [], {});
    expect(executed.workflow.sample.inputs).toEqual(source.sample.inputs);
    expect(executed.workflow.checkpoint.inputs.ckpt_name).toBe("author.ckpt");
    expect(workflow.parameters.some(parameter => parameter.key === "internal_flag")).toBe(true);
    expect(source).toEqual(before);
    const checkpoint = workflow.parameters.find(parameter => parameter.key === "ckpt_name")!;
    checkpoint.group = "模型与 LoRA · CheckpointLoaderSimple";
    expect(generationParameterSurface(workflow).advanced.some(parameter => parameter.key === checkpoint.key)).toBe(false);
  });

  it("changes imported bound width and height through common ratios without changing unrelated source data", () => {
    const { workflow } = imported(graph(), info), values = defaults(workflow), controls = dimensionRatioControls(workflow);
    expect(controls).toHaveLength(1);
    expect(dimensionRatioValue(controls[0], values)).toBe("9:16");
    expect(dimensionRatioOptions(controls[0], values)).toEqual(expect.arrayContaining(["1:1", "16:9", "9:16", "4:3", "3:4"]));
    const patch = dimensionRatioPatch(controls[0], "16:9", values)!;
    const steps = generationParameterSurface(workflow).basic.find(parameter => parameter.group === "步数")!;
    const strength = workflow.parameters.find(parameter => workflow.mapping.some(mapping => mapping.semantic === parameter.key && mapping.nodeId === "second" && mapping.field === "strength_model"))!;
    const executed = buildWorkflow(workflow, generationNode(workflow.id, { ...values, ...patch, [steps.key]: 32, [strength.key]: .9 }), [], {});
    expect(executed.workflow.latent.inputs).toEqual({ width: 1024, height: 576, batch_size: 1 });
    expect(executed.workflow.sample.inputs.steps).toBe(32);
    expect(executed.workflow.second.inputs.strength_model).toBe(.9);
    expect(executed.workflow.first.inputs.strength_model).toBe(.7);
    expect(executed.workflow.sample.inputs.internal_text).toBe("keep exact author text");
    expect(executed.workflow.sample.inputs.cfg).toBe(7);
    expect(executed.workflow.save.inputs.filename_prefix).toBe("author-prefix");
  });

  it("follows actual primitive LoRA model and strength consumers and keeps multiple adapters in separate groups", () => {
    const source = graph();
    source.firstName = { class_type: "PrimitiveString", inputs: { value: "first.safetensors" } };
    source.firstGain = { class_type: "PrimitiveFloat", inputs: { value: .7 } };
    source.firstClipGain = { class_type: "PrimitiveFloat", inputs: { value: .4 } };
    source.secondName = { class_type: "PrimitiveString", inputs: { value: "second.safetensors" } };
    source.secondGain = { class_type: "PrimitiveFloat", inputs: { value: .5 } };
    source.first.inputs.lora_name = ["firstName", 0]; source.first.inputs.strength_model = ["firstGain", 0]; source.first.inputs.strength_clip = ["firstClipGain", 0];
    source.second.inputs.lora_name = ["secondName", 0]; source.second.inputs.strength_model = ["secondGain", 0];
    const { workflow } = imported(source, { ...info,
      PrimitiveString: { input: { required: { value: ["STRING"] } }, output: ["STRING"] },
      PrimitiveFloat: { input: { required: { value: ["FLOAT"] } }, output: ["FLOAT"] },
    });
    const advanced = generationParameterSurface(workflow).advanced;
    const control = (nodeId: string) => advanced.find(parameter => workflow.mapping.some(mapping => mapping.semantic === parameter.key && mapping.nodeId === nodeId))!;
    expect(control("firstName")).toMatchObject({ group: "LoRA 1", label: "LoRA 模型", options: ["first.safetensors", "other.safetensors"] });
    expect(control("firstGain")).toMatchObject({ group: "LoRA 1", label: "LoRA 强度（模型）", min: -2, max: 2 });
    expect(control("firstClipGain")).toMatchObject({ group: "LoRA 1", label: "LoRA 强度（文本）" });
    expect(control("secondName")).toMatchObject({ group: "LoRA 2", label: "LoRA 模型" });
    expect(control("secondGain")).toMatchObject({ group: "LoRA 2", label: "LoRA 强度（模型）" });
    const executed = buildWorkflow(workflow, generationNode(workflow.id, { ...defaults(workflow), [control("firstName").key]: "other.safetensors", [control("secondGain").key]: .85 }), [], {});
    expect(executed.workflow.firstName.inputs.value).toBe("other.safetensors");
    expect(executed.workflow.secondGain.inputs.value).toBe(.85);
    expect(executed.workflow.firstGain.inputs.value).toBe(.7);
    expect(executed.workflow.first.inputs.strength_model).toEqual(["firstGain", 0]);
  });

  it("keeps exact declared dimension ranges and increments, and omits ratios that cannot fit", () => {
    const parameter = (key: string): Parameter => ({ key, label: key, type: "number", default: 512, min: 512, max: 512, step: 8 });
    const control = { key: "width|height", label: "比例", width: parameter("width"), height: parameter("height") };
    expect(dimensionRatioOptions(control, {})).toEqual(["1:1"]);
    expect(dimensionRatioPatch(control, "16:9", {})).toBeUndefined();
    expect(dimensionRatioPatch(control, "0:9", {})).toBeUndefined();
    const { workflow } = imported(graph(), info), flexible = dimensionRatioControls(workflow)[0];
    for (const ratio of dimensionRatioOptions(flexible, {})) {
      const patch = dimensionRatioPatch(flexible, ratio, {})!;
      expect(patch[flexible.width.key] % 8).toBe(0);
      expect(patch[flexible.height.key] % 8).toBe(0);
      expect(patch[flexible.width.key]).toBeGreaterThanOrEqual(16);
      expect(patch[flexible.height.key]).toBeLessThanOrEqual(4096);
    }
  });

  it("derives proportions from numeric width/height enums while keeping their exact allowed choices", () => {
    const { workflow } = imported({ make: { class_type: "OwnImageGenerator", inputs: { width: 576, height: 1024 } },
      save: { class_type: "SaveImage", inputs: { images: ["make", 0] } } }, {
      OwnImageGenerator: { input: { required: { width: [[576, 768, 1024]], height: [[576, 768, 1024]] } }, output: ["IMAGE"] },
    });
    const control = dimensionRatioControls(workflow)[0];
    expect(dimensionRatioOptions(control, {})).toEqual(["1:1", "16:9", "9:16", "4:3", "3:4"]);
    const patch = dimensionRatioPatch(control, "1:1", {})!;
    const executed = buildWorkflow(workflow, generationNode(workflow.id, { ...defaults(workflow), ...patch }), [], {});
    expect(executed.workflow.make.inputs).toEqual({ width: 768, height: 768 });
    expect(dimensionRatioPatch(control, "21:9", {})).toBeUndefined();
  });

  it("resolves primitive dimensions and steps through actual consumers with available consumer schema", () => {
    const source = graph();
    source.w = { class_type: "PrimitiveInt", inputs: { value: 576 } };
    source.h = { class_type: "PrimitiveInt", inputs: { value: 1024 } };
    source.iterations = { class_type: "PrimitiveInt", inputs: { value: 24 } };
    source.latent.inputs.width = ["w", 0]; source.latent.inputs.height = ["h", 0]; source.sample.inputs.steps = ["iterations", 0];
    const { workflow } = imported(source, { ...info,
      PrimitiveInt: { input: { required: { value: ["INT"] } }, output: ["INT"] },
      KSampler: { input: { required: { model: ["MODEL"], latent_image: ["LATENT"], steps: ["INT", { min: 1, max: 1000, step: 1 }] } }, output: ["LATENT"] },
    });
    const controls = dimensionRatioControls(workflow);
    expect(controls).toHaveLength(1);
    expect(controls[0].width).toMatchObject({ min: 16, max: 4096, step: 8, label: "宽度" });
    const values = defaults(workflow), patch = dimensionRatioPatch(controls[0], "1:1", values)!;
    const step = generationParameterSurface(workflow).basic.find(parameter => workflow.mapping.some(mapping => mapping.semantic === parameter.key && mapping.nodeId === "iterations"))!;
    expect(step).toMatchObject({ label: "步数", advanced: false, min: 1, max: 1000 });
    const executed = buildWorkflow(workflow, generationNode(workflow.id, { ...values, ...patch, [step.key]: 40 }), [], {});
    expect(executed.workflow.w.inputs.value).toBe(768);
    expect(executed.workflow.h.inputs.value).toBe(768);
    expect(executed.workflow.iterations.inputs.value).toBe(40);
    expect(executed.workflow.latent.inputs.width).toEqual(["w", 0]);
  });

  it("keeps free aspect strings editable and uses the full real enum contract instead of a singleton imported value", () => {
    const source: ApiWorkflow = { make: { class_type: "OwnImageGenerator", inputs: { aspect_ratio: "9:16", seed: 1 } }, save: { class_type: "SaveImage", inputs: { images: ["make", 0] } } };
    const free = imported(source).workflow;
    const freeRatio = generationParameterSurface(free).basic.find(parameter => parameterRole(parameter, free) === "ratio")!;
    expect(freeRatio).toMatchObject({ type: "text", default: "9:16" });
    expect(freeRatio.options).toBeUndefined();
    const enumerated = imported(source, { OwnImageGenerator: { input: { required: { aspect_ratio: [["1:1", "9:16", "16:9"]], seed: ["INT"] } }, output: ["IMAGE"] } }).workflow;
    expect(enumerated.parameters.find(parameter => parameter.key === "aspect_ratio")).toMatchObject({ type: "select", options: ["1:1", "9:16", "16:9"] });
    const executed = buildWorkflow(enumerated, generationNode(enumerated.id, { ...defaults(enumerated), aspect_ratio: "16:9" }), [], {});
    expect(executed.workflow.make.inputs.aspect_ratio).toBe("16:9");
    const modern = imported(source, { OwnImageGenerator: { input: { required: { aspect_ratio: ["COMBO", { options: ["1:1", "9:16", "16:9"] }], seed: ["INT"] } }, output: ["IMAGE"] } }).workflow;
    expect(modern.parameters.find(parameter => parameter.key === "aspect_ratio")?.options).toEqual(["1:1", "9:16", "16:9"]);
    const constrained = imported(source, { OwnImageGenerator: { input: { required: { aspect_ratio: [["9:16"]], seed: ["INT"] } }, output: ["IMAGE"] } }).workflow;
    expect(constrained.parameters.find(parameter => parameter.key === "aspect_ratio")?.options).toEqual(["9:16"]);
    expect(() => buildWorkflow(constrained, generationNode(constrained.id, { ...defaults(constrained), aspect_ratio: "16:9" }), [], {})).toThrow("参数选项无效");
  });

  it("uses an aspect primitive's actual enum consumer contract and preserves arbitrary custom values without inventing model controls", () => {
    const source: ApiWorkflow = { ratio: { class_type: "PrimitiveString", inputs: { value: "9:16" } },
      make: { class_type: "OwnImageGenerator", inputs: { aspect_ratio: ["ratio", 0], mysterious: "do not alter", unrelated_text: "also keep exact", gain: .7 } },
      save: { class_type: "SaveImage", inputs: { images: ["make", 0] } } };
    const { workflow } = imported(source, { PrimitiveString: { input: { required: { value: ["STRING"] } }, output: ["STRING"] },
      OwnImageGenerator: { input: { required: { aspect_ratio: [["9:16", "1:1", "16:9"]] } }, output: ["IMAGE"] } });
    const ratio = generationParameterSurface(workflow).basic.find(parameter => parameterRole(parameter, workflow) === "ratio")!;
    expect(ratio.options).toEqual(["9:16", "1:1", "16:9"]);
    expect(generationParameterSurface(workflow).advanced).toEqual([]);
    const executed = buildWorkflow(workflow, generationNode(workflow.id, { ...defaults(workflow), [ratio.key]: "1:1" }), [], {});
    expect(executed.workflow.ratio.inputs.value).toBe("1:1");
    expect(executed.workflow.make.inputs).toEqual({ aspect_ratio: ["ratio", 0], mysterious: "do not alter", unrelated_text: "also keep exact", gain: .7 });
  });

  it("keeps bound duration controls primary even when their saved placement was advanced", () => {
    const { workflow } = imported({ make: { class_type: "OwnImageGenerator", inputs: { seconds: 5, noise_seed: 2, num_inference_steps: 8, device: "cuda" } }, save: { class_type: "SaveImage", inputs: { images: ["make", 0] } } });
    const surface = generationParameterSurface(workflow);
    expect(surface.basic.map(parameter => parameter.key)).toEqual(expect.arrayContaining(["seconds", "seed", "num_inference_steps"]));
    expect(surface.advanced).toEqual([]);
    expect(workflow.parameters.find(parameter => parameter.key === "device")?.default).toBe("cuda");
  });

  it.each([
    { mode: "text-to-image", kind: "image", field: "steps" },
    { mode: "text-to-video", kind: "video", field: "num_inference_steps" },
    { mode: "text-to-audio", kind: "audio", field: "total_steps" },
    { mode: "text-tool", kind: "text", field: "denoise_steps" },
  ] as const)("places the actual $mode step binding in the common bar without exposing technical defaults", ({ mode, kind, field }) => {
    const { workflow } = imported({
      make: { class_type: "CustomGenerator", inputs: { [field]: 40, device: "cuda", filename_prefix: "author-prefix" } },
      save: { class_type: "SaveImage", inputs: { images: ["make", 0] } },
    });
    workflow.mode = mode;
    workflow.output.kind = kind;
    for (const parameter of workflow.parameters) parameter.advanced = true;
    const source = structuredClone(workflow), surface = generationParameterSurface(workflow);
    expect(surface.basic).toHaveLength(1);
    expect(surface.basic[0]).toMatchObject({ key: field, label: "步数", advanced: false, default: 40 });
    expect(surface.advanced).toEqual([]);
    const node = generationNode(workflow.id, { ...defaults(workflow), [surface.basic[0].key]: 52 });
    node.data.kind = kind === "image" ? "image-generation" : kind;
    expect(buildWorkflow(workflow, node, [], {}).workflow.make.inputs).toEqual({ [field]: 52, device: "cuda", filename_prefix: "author-prefix" });
    expect(workflow).toEqual(source);
  });

  it("gives independently bound sampling stages distinct common-bar controls and leaves step indices hidden", () => {
    const { workflow } = imported({
      sample: { class_type: "OwnImageGenerator", inputs: { steps_1: 40, steps_stage2: 12, start_step: 0, end_step: 40, device: "cuda" } },
      save: { class_type: "SaveImage", inputs: { images: ["sample", 0] } },
    });
    for (const parameter of workflow.parameters) parameter.advanced = true;
    const source = structuredClone(workflow), surface = generationParameterSurface(workflow);
    expect(surface.basic.map(parameter => ({ key: parameter.key, label: parameter.label, advanced: parameter.advanced }))).toEqual([
      { key: "steps_1", label: "步数 1", advanced: false },
      { key: "steps_stage2", label: "步数 2", advanced: false },
    ]);
    expect(surface.advanced).toEqual([]);
    const executed = buildWorkflow(workflow, generationNode(workflow.id, { ...defaults(workflow), steps_1: 48, steps_stage2: 16 }), [], {});
    expect(executed.workflow.sample.inputs).toEqual({ steps_1: 48, steps_stage2: 16, start_step: 0, end_step: 40, device: "cuda" });
    expect(workflow).toEqual(source);
  });

  it("resolves integer primitive aliases and nested numeric controls to their real sampling consumer", () => {
    const source = graph();
    source.count = { class_type: "PrimitiveInteger", inputs: { integer: 24 } };
    source.forward = { class_type: "PrimitiveInt", inputs: { int: ["count", 0] } };
    source.sample.inputs.steps = ["forward", 0];
    const { workflow } = imported(source, { ...info,
      PrimitiveInteger: { input: { required: { integer: ["INT"] } }, output: ["INT"] },
      PrimitiveInt: { input: { required: { int: ["INT"] } }, output: ["INT"] },
    });
    const count = workflow.parameters.find(parameter => workflow.mapping.some(mapping => mapping.semantic === parameter.key && mapping.nodeId === "count"))!;
    count.label = "自定义次数";
    count.advanced = true;
    const surface = generationParameterSurface(workflow), step = surface.basic.find(parameter => parameter.key === count.key)!;
    expect(step).toMatchObject({ label: "步数", advanced: false, default: 24 });
    expect(surface.advanced.every(parameter => parameter.group?.startsWith("LoRA"))).toBe(true);
    const executed = buildWorkflow(workflow, generationNode(workflow.id, { ...defaults(workflow), [step.key]: 44 }), [], {});
    expect(executed.workflow.count.inputs.integer).toBe(44);
    expect(executed.workflow.forward.inputs.int).toEqual(["count", 0]);
    expect(executed.workflow.sample.inputs.steps).toEqual(["forward", 0]);
  });
});

const realLibrary = "E:/123/DFCine/DFCine0.26/workflows/library";
const localCapabilities = ".cache/cloud-final-object-info.json";
it.skipIf(!existsSync(realLibrary) || !existsSync(localCapabilities))("reads the user's registered H3 ratio contract and imports the actual modern COMBO options without changing its library", async () => {
  const snapshot = await readWorkflowLibrary(realLibrary);
  const workflow = snapshot.workflows.find(item => item.original?.id === "h3.t2v.cloud")!;
  expect(workflow.template).toBeDefined();
  const originalConfig = readFileSync(realLibrary + "/" + workflow.original!.folder + "/workflow.config.json");
  const ratio = generationParameterSurface(workflow).basic.find(parameter => parameterRole(parameter, workflow) === "ratio")!;
  expect(ratio.options).toEqual(expect.arrayContaining(["1:1 (Square)", "16:9 (Widescreen)", "4:3 (Standard)", "3:4 (Portrait Standard)"]));
  const changed = buildWorkflow(workflow, generationNode(workflow.id, { ...defaults(workflow), [ratio.key]: "1:1 (Square)" }), [], {});
  const mapping = workflow.mapping.find(item => item.semantic === ratio.key)!;
  expect(changed.workflow[mapping.nodeId].inputs[mapping.field]).toBe("1:1 (Square)");
  const raw = JSON.parse(readFileSync(localCapabilities, "utf8"));
  const snapshotInfo = raw.objectInfo ?? raw;
  const ratioClass = workflow.template![mapping.nodeId].class_type;
  // The cached schema is newer than this H3 file's SaveVideo format; only its exact ratio node contract is needed here.
  const { workflow: importedH3 } = imported(workflow.template!, { [ratioClass]: snapshotInfo[ratioClass] });
  const importedRatio = generationParameterSurface(importedH3).basic.find(parameter => parameterRole(parameter, importedH3) === "ratio")!;
  expect(importedRatio.type).toBe("select");
  expect(importedRatio.options).toEqual(ratio.options);
  const execution = buildWorkflow(importedH3, generationNode(importedH3.id, { ...defaults(importedH3), [importedRatio.key]: "16:9 (Widescreen)" }), [], {});
  const importedMapping = importedH3.mapping.find(item => item.semantic === importedRatio.key)!;
  expect(execution.workflow[importedMapping.nodeId].inputs[importedMapping.field]).toBe("16:9 (Widescreen)");
  expect(readFileSync(realLibrary + "/" + workflow.original!.folder + "/workflow.config.json")).toEqual(originalConfig);
});
