import { describe, expect, it } from "vitest";
import type { ApiWorkflow, CanvasNode, WorkflowDefinition } from "../src/types";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { generationParameterSurface } from "../src/generation/parameter-actions";
import { selectWorkflowOutput } from "../src/workflow/execution";
import { hasLoraModels, identifyLoraParameter, withLoraParameters, withServerLoraChoices } from "../src/workflow/lora-parameters";

function definition(template: ApiWorkflow): WorkflowDefinition {
  return { id: "test", name: "User workflow", family: "Custom", description: "", mode: "text-to-image", requiredInputs: [], optionalInputs: [], parameters: [], mapping: [], promptRequired: false, output: { nodeId: "save", field: "images", kind: "image" }, template };
}
function graph(): ApiWorkflow {
  return { checkpoint: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "main.safetensors" } },
    loader: { class_type: "LoraLoader", inputs: { model: ["checkpoint", 0], clip: ["checkpoint", 1], lora_name: "first.safetensors", strength_model: .7, strength_clip: .4 } },
    save: { class_type: "SaveImage", inputs: { images: ["loader", 0], filename_prefix: "author" } } };
}
function run(workflow: WorkflowDefinition, params: Record<string, string | number | boolean> = {}) {
  const node: CanvasNode = { id: "canvas-node", position: { x: 0, y: 0 }, data: { title: "Test", kind: "image-generation", generation: { workflowId: workflow.id, prompt: "", negativePrompt: "", taskId: null, params } } };
  return buildWorkflow(workflow, node, [], {}).workflow;
}
const bound = (workflow: WorkflowDefinition, nodeId: string, field: string) => workflow.parameters.find(parameter => workflow.mapping.some(mapping => mapping.semantic === parameter.key && mapping.nodeId === nodeId && mapping.field === field))!;
const schema = (choices: string[]) => ({ input: { required: { lora_name: [choices], strength_model: ["FLOAT", { min: -10, max: 10 }] } } });

describe("LoRA parameter enrichment", () => {
  it("exposes undeclared vendor LoRA filename and strengths with executable bindings while preserving the saved graph", () => {
    const original = definition(graph()), before = structuredClone(original), workflow = withLoraParameters(original);
    expect(workflow.parameters.map(parameter => parameter.key)).toEqual(["lora:loader:lora_name", "lora:loader:strength_model", "lora:loader:strength_clip"]);
    expect(hasLoraModels(workflow)).toBe(true);
    const execution = run(workflow, { [bound(workflow, "loader", "lora_name").key]: "another.safetensors", [bound(workflow, "loader", "strength_model").key]: -.2 });
    expect(execution.loader.inputs).toEqual({ model: ["checkpoint", 0], clip: ["checkpoint", 1], lora_name: "another.safetensors", strength_model: -.2, strength_clip: .4 });
    expect(execution.checkpoint).toEqual(before.template!.checkpoint);
    expect(execution.save).toEqual(before.template!.save);
    expect(original).toEqual(before);
    expect(workflow.template).toBe(original.template);
    expect(withLoraParameters(workflow)).toBe(workflow);
  });

  it("keeps authored parameter keys, ranges, model options and hidden values without creating duplicate bindings", () => {
    const original = definition(graph());
    original.parameters = [{ key: "gain", label: "Saved strength", type: "number", default: .7, min: -2, max: 2, step: .05 }, { key: "name", label: "Saved filename", type: "select", default: "first.safetensors", options: ["first.safetensors", "second.safetensors"] }, { key: "prefix", label: "hidden", type: "text", default: "author", advanced: true }];
    original.mapping = [{ semantic: "gain", nodeId: "loader", field: "strength_model" }, { semantic: "name", nodeId: "loader", field: "lora_name" }, { semantic: "prefix", nodeId: "save", field: "filename_prefix" }];
    const workflow = withLoraParameters(original);
    expect(workflow.parameters).toHaveLength(4);
    expect(workflow.parameters.slice(0, 3)).toEqual(original.parameters);
    expect(workflow.parameters[0]).toBe(original.parameters[0]);
    expect(identifyLoraParameter(workflow.parameters[0], workflow)).toEqual([{ kind: "strength", nodeId: "loader", field: "strength_model" }]);
    expect(identifyLoraParameter(workflow.parameters[1], workflow)).toEqual([{ kind: "model", nodeId: "loader", field: "lora_name" }]);
    expect(() => run(workflow, { gain: 3 })).toThrow("参数超出范围");
  });

  it("recognizes independent indexed stack slots including None and binds every selection to its own exact field", () => {
    const original = definition({ stack: { class_type: "Lora Loader Stack (rgthree)", inputs: { lora_01: "None", strength_01: 1, lora_02: "second.safetensors", strength_02: .6 } },
      multi: { class_type: "LoraSelectMulti", inputs: { lora_0: "third.safetensors", strength_0: .8, lora_1: "None", strength_1: 0 } },
      save: { class_type: "SaveImage", inputs: { images: ["stack", 0] } } });
    const workflow = withLoraParameters(original);
    expect(workflow.parameters).toHaveLength(8);
    expect(identifyLoraParameter(bound(workflow, "stack", "lora_01"), workflow)).toEqual([{ kind: "model", nodeId: "stack", field: "lora_01", slot: "01" }]);
    expect(identifyLoraParameter(bound(workflow, "multi", "strength_0"), workflow)).toEqual([{ kind: "strength", nodeId: "multi", field: "strength_0", slot: "0" }]);
    const hydrated = withServerLoraChoices(workflow, { "Lora Loader Stack (rgthree)": { input: { required: { lora_01: [["None", "first.safetensors"]], lora_02: ["COMBO", { options: ["None", "second.safetensors"] }] } } }, LoraSelectMulti: { input: { required: { lora_0: [["None", "third.safetensors"]], lora_1: [["None", "fourth.safetensors"]] } } } });
    const execution = run(hydrated, { [bound(hydrated, "stack", "lora_01").key]: "first.safetensors", [bound(hydrated, "multi", "lora_1").key]: "fourth.safetensors" });
    expect(execution.stack.inputs).toEqual({ lora_01: "first.safetensors", strength_01: 1, lora_02: "second.safetensors", strength_02: .6 });
    expect(execution.multi.inputs).toEqual({ lora_0: "third.safetensors", strength_0: .8, lora_1: "fourth.safetensors", strength_1: 0 });
  });

  it("synthesizes primitive scalar controls instead of replacing loader links and reuses a shared existing control", () => {
    const source = graph();
    source.name = { class_type: "PrimitiveString", inputs: { value: "first.safetensors" } };
    source.gain = { class_type: "PrimitiveFloat", inputs: { value: .7 } };
    source.loader.inputs.lora_name = ["name", 0]; source.loader.inputs.strength_model = ["gain", 0];
    source.second = { class_type: "LoraLoaderModelOnly", inputs: { model: ["loader", 0], lora_name: ["name", 0], strength_model: .5 } };
    const original = definition(source);
    original.parameters = [{ key: "filename", label: "filename", type: "text", default: "first.safetensors" }];
    original.mapping = [{ semantic: "filename", nodeId: "name", field: "value" }];
    const workflow = withLoraParameters(original);
    expect(workflow.mapping.filter(mapping => mapping.nodeId === "name")).toEqual(original.mapping);
    expect(identifyLoraParameter(workflow.parameters[0], workflow)).toEqual([{ kind: "model", nodeId: "loader", field: "lora_name" }, { kind: "model", nodeId: "second", field: "lora_name" }]);
    const execution = run(workflow, { filename: "another.safetensors", [bound(workflow, "gain", "value").key]: .9 });
    expect(execution.name.inputs.value).toBe("another.safetensors");
    expect(execution.gain.inputs.value).toBe(.9);
    expect(execution.loader.inputs.lora_name).toEqual(["name", 0]);
    expect(execution.loader.inputs.strength_model).toEqual(["gain", 0]);
    expect(execution.second.inputs.lora_name).toEqual(["name", 0]);
    expect(source.name.inputs.value).toBe("first.safetensors");
  });

  it("does not overwrite computed connections, cycles or fields reserved by another semantic", () => {
    const source = graph();
    source.computed = { class_type: "ComputeFilename", inputs: { value: "first.safetensors" } };
    source.loader.inputs.lora_name = ["computed", 0];
    source.gain = { class_type: "PrimitiveFloat", inputs: { value: ["gain", 0] } };
    source.loader.inputs.strength_model = ["gain", 0];
    const original = definition(source);
    original.mapping = [{ semantic: "external_gain", nodeId: "loader", field: "strength_clip" }];
    expect(withLoraParameters(original)).toBe(original);
    expect(hasLoraModels(original)).toBe(false);
  });

  it("excludes main Vox model filenames, guide strengths without an adapter filename, and workflows with no LoRA", () => {
    const source: ApiWorkflow = { voice: { class_type: "VoxLoader", inputs: { model_name: "voice.safetensors", lora_name: "adapter.safetensors", lora_strength: .9 } },
      guide: { class_type: "LTXLoRAGuide", inputs: { strength: 1, strength_model: .8, model_name: "guide.safetensors" } },
      save: { class_type: "SaveImage", inputs: { images: ["voice", 0] } } };
    const workflow = withLoraParameters(definition(source));
    expect(workflow.mapping.map(mapping => mapping.nodeId + "." + mapping.field)).toEqual(["voice.lora_name", "voice.lora_strength"]);
    const execution = run(workflow, { [bound(workflow, "voice", "lora_name").key]: "replacement.safetensors" });
    expect(execution.voice.inputs.model_name).toBe("voice.safetensors");
    expect(execution.guide).toEqual(source.guide);
    const noLora = definition({ loader: { class_type: "CheckpointLoader", inputs: { model_name: "model.safetensors" } }, save: { class_type: "SaveImage", inputs: { images: ["loader", 0] } } });
    expect(withLoraParameters(noLora)).toBe(noLora);
    expect(hasLoraModels(noLora)).toBe(false);
  });

  it("uses each exact legacy or modern filename schema, preserves numeric ranges, and leaves all source metadata unchanged", () => {
    const original = withLoraParameters(definition(graph()));
    const gain = bound(original, "loader", "strength_model"); gain.min = -2; gain.max = 2;
    const before = structuredClone(original);
    const schemaInfo = { LoraLoader: schema(["first.safetensors", "actual-lora.safetensors"]), CheckpointLoaderSimple: { input: { required: { ckpt_name: [["wrong-checkpoint.safetensors"]] } } } };
    const hydrated = withServerLoraChoices(original, schemaInfo), model = bound(hydrated, "loader", "lora_name");
    expect(model).toMatchObject({ type: "select", options: ["first.safetensors", "actual-lora.safetensors"], model: true });
    expect(bound(hydrated, "loader", "strength_model")).toEqual(gain);
    expect(run(hydrated, { [model.key]: "actual-lora.safetensors" }).loader.inputs.lora_name).toBe("actual-lora.safetensors");
    expect(() => run(hydrated, { [model.key]: "wrong-checkpoint.safetensors" })).toThrow("参数选项无效");
    expect(original).toEqual(before);
    expect(withServerLoraChoices(hydrated, schemaInfo)).toBe(hydrated);
    const modern = withServerLoraChoices(original, { LoraLoader: { input: { optional: { lora_name: ["COMBO", { options: ["first.safetensors", "modern.safetensors"] }] } } } });
    expect(bound(modern, "loader", "lora_name").options).toEqual(["first.safetensors", "modern.safetensors"]);
  });

  it("intersects choices for a shared primitive according to its real consumers rather than its source STRING schema", () => {
    const source = graph();
    source.name = { class_type: "PrimitiveString", inputs: { value: "first.safetensors" } };
    source.loader.inputs.lora_name = ["name", 0];
    source.second = { class_type: "LoraLoaderModelOnly", inputs: { lora_name: ["name", 0], strength_model: .4 } };
    const workflow = withLoraParameters(definition(source));
    const info = { LoraLoader: schema(["first.safetensors", "shared.safetensors", "only-first.safetensors"]), LoraLoaderModelOnly: schema(["first.safetensors", "shared.safetensors", "only-second.safetensors"]), PrimitiveString: { input: { required: { value: [["wrong-source.safetensors"]] } } } };
    const hydrated = withServerLoraChoices(workflow, info), model = bound(hydrated, "name", "value");
    expect(model.options).toEqual(["first.safetensors", "shared.safetensors"]);
    const execution = run(hydrated, { [model.key]: "shared.safetensors" });
    expect(execution.name.inputs.value).toBe("shared.safetensors");
    expect(execution.loader.inputs.lora_name).toEqual(["name", 0]);
    expect(withServerLoraChoices(workflow, { LoraLoader: info.LoraLoader })).toBe(workflow);
  });

  it("keeps a saved missing filename visible and normalizes authored display aliases into real filename values", () => {
    const original = definition(graph());
    original.parameters = [{ key: "name", label: "Adapter", type: "select", default: "first.safetensors", options: ["Original", "Fast"], optionValues: { Original: "first.safetensors", Fast: "fast.safetensors" } }];
    original.mapping = [{ semantic: "name", nodeId: "loader", field: "lora_name" }];
    const hydrated = withServerLoraChoices(original, { LoraLoader: schema(["fast.safetensors", "other.safetensors"]) }), model = bound(hydrated, "loader", "lora_name");
    expect(model.options).toEqual(["first.safetensors", "fast.safetensors", "other.safetensors"]);
    expect(model.optionValues).toBeUndefined();
    expect(model.optionLabels).toEqual({ "first.safetensors": "Original", "fast.safetensors": "Fast" });
    expect(run(hydrated).loader.inputs.lora_name).toBe("first.safetensors");
    expect(run(hydrated, { name: "fast.safetensors" }).loader.inputs.lora_name).toBe("fast.safetensors");
  });

  it("makes authored missing LoRA controls visible through execution selection with separate groups for each stack slot", () => {
    const original = definition({ stack: { class_type: "Lora Loader Stack (rgthree)", inputs: { lora_01: "first.safetensors", strength_01: 1, lora_02: "None", strength_02: .5 } },
      save: { class_type: "SaveImage", inputs: { images: ["stack", 0] } } });
    const workflow = selectWorkflowOutput(original, {}), surface = generationParameterSurface(workflow);
    expect(surface.advanced.map(parameter => ({ field: workflow.mapping.find(mapping => mapping.semantic === parameter.key)!.field, group: parameter.group }))).toEqual([
      { field: "lora_01", group: "LoRA 1" }, { field: "lora_02", group: "LoRA 2" }, { field: "strength_01", group: "LoRA 1" }, { field: "strength_02", group: "LoRA 2" },
    ]);
    expect(surface.basic).toEqual([]);
    expect(original.parameters).toEqual([]);
    expect(run(workflow).stack.inputs).toEqual(original.template!.stack.inputs);
  });

  it("uses the shared primitive's non-LoRA filename contract too, without changing that consumer's connections", () => {
    const source = graph();
    source.name = { class_type: "PrimitiveString", inputs: { value: "first.safetensors" } };
    source.loader.inputs.lora_name = ["name", 0];
    source.extra = { class_type: "OwnFilenameConsumer", inputs: { filename: ["name", 0] } };
    const workflow = withLoraParameters(definition(source));
    const loaderInfo = schema(["first.safetensors", "both.safetensors", "only-lora.safetensors"]);
    const hydrated = withServerLoraChoices(workflow, { LoraLoader: loaderInfo, OwnFilenameConsumer: { input: { required: { filename: [["first.safetensors", "both.safetensors", "only-extra.safetensors"]] } } } });
    const model = bound(hydrated, "name", "value");
    expect(model.options).toEqual(["first.safetensors", "both.safetensors"]);
    expect(run(hydrated, { [model.key]: "both.safetensors" }).extra.inputs.filename).toEqual(["name", 0]);
    expect(withServerLoraChoices(workflow, { LoraLoader: loaderInfo })).toBe(workflow);
  });
});
