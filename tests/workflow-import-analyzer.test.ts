import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type { ApiWorkflow } from "../src/types";
import { analyzeWorkflowImport, buildWorkflowImport, validateImportGraph, type ImportBindings } from "../src/workflow/import-analyzer";
import { convertLibraryWorkflow, createLibraryRegistration } from "../src/workflow/library-converter";

const source = { sourcePath: "test", folder: "test", configSha256: "", executionSha256: "", executionStatus: "plain" as const };
const options = { id: "my.image", name: "我的图像", family: "自己的工作流" };
const graph = (): ApiWorkflow => ({
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "正面描述", clip: ["1", 1] } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "负面描述", clip: ["1", 1] } },
  "4": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "5": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], seed: 985625657145008, steps: 25, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
  "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
  "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "original" } },
});
const info = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["model.safetensors", "other.safetensors"]] } }, output: ["MODEL", "CLIP", "VAE"] },
  CLIPTextEncode: { input: { required: { text: ["STRING", { multiline: true }], clip: ["CLIP"] } }, output: ["CONDITIONING"] },
  EmptyLatentImage: { input: { required: { width: ["INT", { min: 16, max: 8192, step: 8 }], height: ["INT", { min: 16, max: 8192, step: 8 }], batch_size: ["INT"] } }, output: ["LATENT"] },
  KSampler: { input: { required: { model: ["MODEL"], positive: ["CONDITIONING"], negative: ["CONDITIONING"], latent_image: ["LATENT"], seed: ["INT", { min: 0, max: 18446744073709551615 }], steps: ["INT", { min: 1, max: 10000 }], cfg: ["FLOAT"], sampler_name: [["euler", "dpmpp_2m"]], scheduler: [["simple", "normal"]], denoise: ["FLOAT", { min: 0, max: 1, step: .01 }] } }, output: ["LATENT"] },
  VAEDecode: { input: { required: { samples: ["LATENT"], vae: ["VAE"] } }, output: ["IMAGE"] },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [] },
};

describe("custom workflow import analysis", () => {
  it("preserves an explicit nullable JSON widget while still rejecting missing model or primitive inputs", () => {
    const graph: ApiWorkflow = { custom: { class_type: "JsonNode", inputs: { payload: null } } };
    expect(validateImportGraph(graph, { JsonNode: { input: { required: { payload: ["JSON", { __canvas_literal: true }] } }, output: [] } }).errors).toEqual([]);
    for (const type of ["MODEL", "STRING", "INT"]) {
      expect(validateImportGraph(graph, { JsonNode: { input: { required: { payload: [type] } }, output: [] } }).errors.some(error => error.includes("缺少必填"))).toBe(true);
    }
    delete graph.custom.inputs.payload;
    expect(validateImportGraph(graph, { JsonNode: { input: { required: { payload: ["JSON", { __canvas_literal: true }] } }, output: [] } }).errors.some(error => error.includes("缺少必填"))).toBe(true);
  });
  it("binds positive prompt, keeps negative prompt editable, and preserves a large safe seed", () => {
    const original = graph();
    const analysis = analyzeWorkflowImport(original, info);
    expect(analysis.errors).toEqual([]); expect(analysis.warnings).toEqual([]);
    expect(analysis.prompts).toEqual([{ nodeId: "2", field: "text", label: "CLIPTextEncode · 2.text", value: "正面描述" }]);
    const built = buildWorkflowImport(original, options, info);
    const definition = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(definition.mapping).toContainEqual({ semantic: "prompt", nodeId: "2", field: "text" });
    expect(definition.promptRequired).toBe(false);
    const legacyConfig = structuredClone(built.config) as Record<string, any>; delete legacyConfig.prompt.required;
    expect(convertLibraryWorkflow(legacyConfig, built.graph, built.requirements, source).promptRequired).toBe(true);
    expect(definition.parameters.find(parameter => parameter.key === "seed")).toMatchObject({ default: 985625657145008, max: Number.MAX_SAFE_INTEGER, advanced: false });
    expect(definition.parameters.find(parameter => parameter.key === "text")).toMatchObject({ default: "负面描述", advanced: true, multiline: true });
    expect(definition.parameters.find(parameter => parameter.key === "ckpt_name")).toMatchObject({ model: true, type: "select", advanced: true, options: ["model.safetensors", "other.safetensors"] });
    expect(built.requirements).toEqual({ schemaVersion: 1, items: [{ name: "model.safetensors", relativePath: "models/checkpoints/model.safetensors", required: true }] });
    expect(definition.parameters.some(parameter => parameter.key === "filename_prefix")).toBe(false);
    expect(original).toEqual(graph());
  });

  it("collects all outputs by default while supporting explicit output selection", () => {
    const raw = { ...graph(), "8": { class_type: "SaveImageAdvanced", inputs: { images: ["6", 0], filename_prefix: "second" } } };
    const automatic = buildWorkflowImport(raw, options);
    expect((automatic.config.execution as Record<string, any>).outputs.map((output: { nodeId: string }) => output.nodeId)).toEqual(["7", "8"]);
    const built = buildWorkflowImport(raw, { ...options, outputNodeId: "8" });
    expect(convertLibraryWorkflow(built.config, built.graph, built.requirements, source).output).toMatchObject({ nodeId: "8", field: "images", kind: "image" });
    const bad = structuredClone(built.config) as Record<string, any>;
    bad.execution.output.field = "arbitrary-history-key";
    expect(convertLibraryWorkflow(bad, built.graph, built.requirements, source).output.field).toBe("arbitrary-history-key");
    bad.execution.output.nodeId = "missing";
    expect(() => convertLibraryWorkflow(bad, built.graph, built.requirements, source)).toThrow("输出绑定节点不存在");
  });

  it("adds a SaveImage only to the execution copy for a PreviewImage output", () => {
    const raw = graph(); raw["7"] = { class_type: "PreviewImage", inputs: { images: ["6", 0] } };
    const before = structuredClone(raw);
    const built = buildWorkflowImport(raw, options);
    expect(built.graph["canvas-save-7"]).toEqual({ class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "infinite-canvas/result" } });
    expect(convertLibraryWorkflow(built.config, built.graph, built.requirements, source).output.nodeId).toBe("canvas-save-7");
    expect(raw).toEqual(before);
  });

  it("gives each image, video and audio loader an independent required canvas slot", () => {
    const raw: ApiWorkflow = {
      "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
      "2": { class_type: "LoadImage", inputs: { image: "b.png" } },
      "3": { class_type: "VHS_LoadVideoPath", inputs: { video: "C:/original.mp4", force_rate: 0 } },
      "4": { class_type: "VHS_LoadAudio", inputs: { audio_file: "source.wav", seek_seconds: 0 } },
      "5": { class_type: "VHS_VideoCombine", inputs: { images: ["6", 0], audio: ["4", 0], filename_prefix: "result", save_output: false } },
      "6": { class_type: "CustomProcessor", inputs: { images: ["1", 0], reference: ["2", 0], video: ["3", 0], audio: ["4", 0] } },
    };
    const analysis = analyzeWorkflowImport(raw);
    expect(analysis.inputs.map(input => input.kind)).toEqual(["image", "image", "video", "audio"]);
    const built = buildWorkflowImport(raw, options);
    const definition = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(definition.inputSlots).toHaveLength(4);
    expect(definition.inputSlots?.every(input => input.required)).toBe(true);
    expect(definition.mapping).toContainEqual({ semantic: "slot:input3", nodeId: "3", field: "video", pathMode: "comfy-input" });
    expect(definition.mapping).toContainEqual({ semantic: "slot:input4", nodeId: "4", field: "audio_file", pathMode: "comfy-input" });
    expect(built.graph["5"].inputs.save_output).toBe(true);
  });

  it("rejects incomplete core API exports while offline instead of guessing model or VAE connections", () => {
    const raw = graph(); delete raw["5"].inputs.model; delete raw["6"].inputs.vae; delete raw["2"].inputs.clip;
    const analysis = analyzeWorkflowImport(raw);
    expect(analysis.errors).toEqual(expect.arrayContaining([expect.stringContaining("5）.model"), expect.stringContaining("6）.vae"), expect.stringContaining("2）.clip")]));
    expect(() => buildWorkflowImport(raw, options)).toThrow("缺少必填输入");
  });

  it("allows storing missing cloud nodes and model options as preparation warnings", () => {
    const raw = graph(); raw["1"].inputs.ckpt_name = "missing.safetensors";
    const partialInfo = { ...info } as Record<string, unknown>; delete partialInfo.VAEDecode;
    const built = buildWorkflowImport(raw, options, partialInfo);
    expect(built.warnings).toEqual(expect.arrayContaining([expect.stringContaining("missing.safetensors"), expect.stringContaining("当前节点定义未包含：VAEDecode")]));
    const definition = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(definition.verification).toBe("not-run");
    expect(definition.parameters.find(parameter => parameter.key === "ckpt_name")?.options).toContain("missing.safetensors");
  });

  it("validates registered required inputs, scalar types, connection indexes, types and cycles", () => {
    const raw: ApiWorkflow = {
      "a": { class_type: "Source", inputs: { dependency: ["b", 0] } },
      "b": { class_type: "Target", inputs: { image: ["a", 0], bad: ["a", 1], steps: "wrong", gain: .5 } },
    };
    const schema = {
      Source: { output: ["AUDIO"] },
      Target: { input: { required: { image: ["IMAGE"], required_connection: ["MODEL"], steps: ["INT"], gain: ["FLOAT", { min: 1 }] } }, output: ["IMAGE"] },
    };
    const result = validateImportGraph(raw, schema);
    expect(result.errors.join("\n")).toContain("循环");
    expect(result.errors.join("\n")).toContain("required_connection");
    expect(result.errors.join("\n")).toContain("类型不匹配");
    expect(result.errors.join("\n")).toContain("输出索引超出");
    expect(result.errors.join("\n")).toContain("整数参数无效");
    expect(result.errors.join("\n")).toContain("最小值");
    expect(validateImportGraph({ "1": { class_type: "PrimitiveConsumer", inputs: { text: "API literal" } } }, { PrimitiveConsumer: { input: { required: { text: ["STRING", { forceInput: true }] } } } }).errors).toEqual([]);
  });

  it("keeps ambiguous positive fields editable without blocking import and leaves system fields advanced", () => {
    const raw = graph(); raw["8"] = { class_type: "CLIPTextEncode", inputs: { text: "另一个提示词", clip: ["1", 1], system_prompt: "规则" } };
    raw["9"] = { class_type: "ConditioningCombine", inputs: { conditioning_1: ["2", 0], conditioning_2: ["8", 0] } };
    raw["5"].inputs.positive = ["9", 0];
    const analysis = analyzeWorkflowImport(raw);
    expect(analysis.prompts.map(prompt => prompt.nodeId)).toEqual(["2", "8"]);
    const automatic = buildWorkflowImport(raw, options);
    expect(automatic.config.prompt).toBeUndefined();
    expect((automatic.config.parameters as { defaultValue: unknown }[]).map(parameter => parameter.defaultValue)).toEqual(expect.arrayContaining(["正面描述", "另一个提示词", "规则"]));
    const built = buildWorkflowImport(raw, { ...options, promptKey: "8.text" });
    expect(built.config.prompt).toEqual({ required: false, binding: { target: "comfyui", nodeId: "8", path: "inputs.text" } });
    const unbound = buildWorkflowImport(raw, { ...options, promptKey: "" });
    expect(unbound.config.prompt).toBeUndefined();
  });

  it("supports literal field names containing dots without interpreting nested paths", () => {
    const raw = graph(); raw["4"].inputs["control.strength"] = .5;
    const built = buildWorkflowImport(raw, options);
    expect(convertLibraryWorkflow(built.config, built.graph, built.requirements, source).mapping).toContainEqual({ semantic: "control.strength", nodeId: "4", field: "control.strength" });
  });

  it("automates known text contracts and collects unknown history fields through the generic result contract", () => {
    const raw = { "1": { class_type: "LLM", inputs: { prompt: "描述", system_prompt: "规则" } }, "2": { class_type: "easy showAnything", inputs: { anything: ["1", 0], text: "" } } };
    const built = buildWorkflowImport(raw, options);
    expect(convertLibraryWorkflow(built.config, built.graph, built.requirements, source).output).toEqual({ nodeId: "2", kind: "text", field: "text" });
    const unsupported = { "1": raw["1"], "2": { class_type: "Save Text File", inputs: { text: ["1", 0], path: "result" } } };
    const discovered = analyzeWorkflowImport(unsupported, { "Save Text File": { output_node: true } });
    expect(discovered.outputs).toEqual([{ nodeId: "2", label: "Save Text File · 2", kind: "file", field: "*" }]);
    expect(discovered.errors).toEqual([]);
    const automatic = buildWorkflowImport(unsupported, options, { "Save Text File": { output_node: true } });
    expect(convertLibraryWorkflow(automatic.config, automatic.graph, automatic.requirements, source).output).toEqual({ nodeId: "2", field: "*", kind: "file" });
    const manual = buildWorkflowImport(unsupported, { ...options, bindings: { outputs: [{ nodeId: "2", field: "document_result", kind: "text" }] } });
    expect(convertLibraryWorkflow(manual.config, manual.graph, manual.requirements, source).output).toEqual({ nodeId: "2", field: "document_result", kind: "text" });
  });

  it("isolates the chosen output branch while listing all outputs and retaining the original graph", () => {
    const raw = graph();
    raw["8"] = { class_type: "SaveAudio", inputs: { audio: ["9", 0] } };
    raw["9"] = { class_type: "KSampler", inputs: { seed: 0, unrelated_model: "missing.bin", extra_image: ["10", 0] } };
    raw["10"] = { class_type: "LoadImage", inputs: { image: "unrelated.png" } };
    const original = structuredClone(raw);
    expect(analyzeWorkflowImport(raw).errors.length).toBeGreaterThan(0);
    const analysis = analyzeWorkflowImport(raw, undefined, "7");
    expect(analysis.outputs.map(output => output.nodeId)).toEqual(["7", "8"]);
    expect(analysis.errors).toEqual([]); expect(analysis.inputs).toEqual([]);
    const built = buildWorkflowImport(raw, { ...options, outputNodeId: "7" });
    expect(Object.keys(built.graph)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(JSON.stringify(built.requirements)).not.toContain("missing.bin");
    expect(() => buildWorkflowImport(raw, { ...options, outputNodeId: "8" })).toThrow("缺少必填输入");
    expect(raw).toEqual(original);
  });

  it("preserves literal array wrappers through analysis, conversion and execution while validating wrapped primitive types", () => {
    const raw: ApiWorkflow = {
      "1": { class_type: "ListToImage", inputs: { value: { __value__: ["not-a-node", 0] } } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "result" } },
    };
    const schema = { ListToImage: { input: { required: { value: ["LIST"] } }, output: ["IMAGE"] }, SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } } } };
    expect(analyzeWorkflowImport(raw, schema).errors).toEqual([]);
    const built = buildWorkflowImport(raw, options, schema);
    expect(convertLibraryWorkflow(built.config, built.graph, built.requirements, source).template?.["1"].inputs.value).toEqual({ __value__: ["not-a-node", 0] });
    expect(validateImportGraph({ "1": { class_type: "WrappedInteger", inputs: { count: { __value__: "wrong" } } } }, { WrappedInteger: { input: { required: { count: ["INT"] } } } }).errors).toContain("整数参数无效：1.count");
  });

  it("trusts registered class contracts over fallback core field names", () => {
    const raw: ApiWorkflow = { "1": { class_type: "SaveVideo", inputs: { images: { __value__: [] } } } };
    const schema = { SaveVideo: { input: { required: { images: ["LIST"] } }, output: [] } };
    expect(analyzeWorkflowImport(raw, schema).errors).toEqual([]);
    expect(analyzeWorkflowImport(raw).errors.join("\n")).toContain(".video");
  });

  it("retains numeric and boolean enum values in dropdown contracts", () => {
    const raw: ApiWorkflow = {
      "1": { class_type: "EnumGenerator", inputs: { quality: 2, enabled: false } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "result" } },
    };
    const schema = { EnumGenerator: { input: { required: { quality: [[1, 2, 3]], enabled: [[false, true]] } }, output: ["IMAGE"] }, SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } } } };
    const built = buildWorkflowImport(raw, options, schema);
    const definition = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(definition.parameters.find(parameter => parameter.key === "quality")).toMatchObject({ type: "select", default: 2, options: ["1", "2", "3"], optionValues: { "1": 1, "2": 2, "3": 3 } });
    expect(definition.parameters.find(parameter => parameter.key === "enabled")).toMatchObject({ type: "select", default: false, options: ["false", "true"], optionValues: { false: false, true: true } });
  });

  it("expands registered V3 dynamic branches and media collections into actual dotted API keys", () => {
    const raw: ApiWorkflow = {
      "1": { class_type: "LoadImage", inputs: { image: "reference.png" } },
      "2": { class_type: "DynamicProcessor", inputs: { "references.image_0": ["1", 0], mode: "fast", "mode.steps": 4 } },
      "3": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "result" } },
    };
    const schema = {
      LoadImage: { input: { required: { image: ["STRING"] } }, output: ["IMAGE"] },
      DynamicProcessor: { input: { required: {
        references: ["COMFY_AUTOGROW_V3", { template: { prefix: "image_", min: 1, max: 3, input: { required: { image: ["COMFY_MATCHTYPE_V3", { template: { allowed_types: ["IMAGE", "MASK"] } }] } } } }],
        mode: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "fast", inputs: { required: { steps: ["INT", { min: 1, max: 10, step: 1 }] } } }, { key: "slow", inputs: { required: { strength: ["FLOAT"] } } }] }],
      } }, output: ["IMAGE"] },
      SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [] },
    };
    expect(analyzeWorkflowImport(raw, schema).errors).toEqual([]);
    const built = buildWorkflowImport(raw, options, schema);
    const definition = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(definition.parameters.find(parameter => parameter.key === "mode")).toMatchObject({ type: "select", options: ["fast"], default: "fast" });
    expect(built.warnings.join("\n")).toContain("切换其他分支需在 ComfyUI 中更改后重新导入");
    expect(definition.parameters.find(parameter => parameter.key === "mode.steps")).toMatchObject({ type: "number", default: 4, min: 1, max: 10 });
    const wrong = structuredClone(raw); delete wrong["2"].inputs["references.image_0"];
    expect(analyzeWorkflowImport(wrong, schema).errors.join("\n")).toContain("至少需要");
    expect(analyzeWorkflowImport(raw, { ...schema, LoadImage: { ...schema.LoadImage, output: ["AUDIO"] } }).errors.join("\n")).toContain("类型不匹配");
  });

  it("binds standard primitive prompt and seed values by their explicit consumer connections", () => {
    const raw = graph();
    raw["8"] = { class_type: "PrimitiveInt", inputs: { value: 58 } };
    raw["9"] = { class_type: "PrimitiveStringMultiline", inputs: { value: "Primary primitive prompt" } };
    raw["10"] = { class_type: "PrimitiveStringMultiline", inputs: { value: "Negative primitive prompt" } };
    raw["2"].inputs.text = ["9", 0]; raw["3"].inputs.text = ["10", 0]; raw["5"].inputs.seed = ["8", 0];
    const schema = { ...info, PrimitiveInt: { input: { required: { value: ["INT", { min: 0, max: 100 }] } }, output: ["INT"] }, PrimitiveStringMultiline: { input: { required: { value: ["STRING", { multiline: true }] } }, output: ["STRING"] } };
    const analysis = analyzeWorkflowImport(raw, schema);
    expect(analysis.errors).toEqual([]);
    expect(analysis.prompts.map(prompt => prompt.nodeId + "." + prompt.field)).toEqual(["9.value"]);
    const built = buildWorkflowImport(raw, options, schema);
    const definition = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(definition.mapping).toContainEqual({ semantic: "prompt", nodeId: "9", field: "value" });
    expect(definition.mapping).toContainEqual({ semantic: "seed", nodeId: "8", field: "value" });
    expect(definition.parameters.find(parameter => parameter.key === "seed")).toMatchObject({ type: "number", default: 58, label: "种子", advanced: false });
    expect(built.graph["5"].inputs.seed).toEqual(["8", 0]);
  });

  it("resolves V3 output match types through declared templates and rejects conflicting or incompatible ports", () => {
    const raw: ApiWorkflow = {
      "1": { class_type: "LatentSource", inputs: {} },
      "2": { class_type: "MatchSwitch", inputs: { switch: false, on_false: ["1", 0], on_true: ["3", 0] } },
      "3": { class_type: "LatentSource", inputs: {} },
      "4": { class_type: "DecodeFixture", inputs: { samples: ["2", 0] } },
      "5": { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "result" } },
    };
    const match = ["COMFY_MATCHTYPE_V3", { template: { template_id: "switch", allowed_types: "*" } }];
    const schema = {
      LatentSource: { input: {}, output: ["LATENT"] },
      ImageSource: { input: {}, output: ["IMAGE"] },
      MatchSwitch: { input: { required: { switch: ["BOOLEAN"] }, optional: { on_false: match, on_true: match } }, output: ["COMFY_MATCHTYPE_V3"], output_matchtypes: ["switch"] },
      DecodeFixture: { input: { required: { samples: ["LATENT"] } }, output: ["IMAGE"] },
      SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [] },
    };
    expect(analyzeWorkflowImport(raw, schema).errors).toEqual([]);
    const mixed = structuredClone(raw); mixed["3"].class_type = "ImageSource";
    expect(analyzeWorkflowImport(mixed, schema).errors.join("\n")).toContain("匹配端口类型不一致");
    const wrong = structuredClone(mixed); wrong["1"].class_type = "ImageSource";
    expect(analyzeWorkflowImport(wrong, schema).errors.join("\n")).toContain("需要 LATENT，收到 IMAGE");
    const unsupportedSchema = { ...schema, MatchSwitch: { ...schema.MatchSwitch, output_matchtypes: [] } };
    expect(analyzeWorkflowImport(raw, unsupportedSchema).errors.join("\n")).toContain("收到 COMFY_MATCHTYPE_V3");
  });

  it("keeps compatible dynamic choices and ordinary enums while limiting structurally different branches", () => {
    const raw: ApiWorkflow = {
      "1": { class_type: "DynamicImage", inputs: { mode: "fast", "mode.steps": 4, quality: "high" } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "result" } },
    };
    const schema = {
      DynamicImage: { input: { required: {
        mode: ["COMFY_DYNAMICCOMBO_V3", { options: [
          { key: "fast", inputs: { required: { steps: ["INT", { min: 1, max: 10, default: 4 }] } } },
          { key: "compatible", inputs: { required: { steps: ["INT", { default: 6, max: 10, min: 1 }] } } },
          { key: "different", inputs: { required: { strength: ["FLOAT", { default: .5 }] } } },
        ] }], quality: [["high", "low"]],
      } }, output: ["IMAGE"] },
      SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [] },
    };
    const built = buildWorkflowImport(raw, options, schema);
    const definition = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(definition.parameters.find(parameter => parameter.key === "mode")?.options).toEqual(["fast", "compatible"]);
    expect(definition.parameters.find(parameter => parameter.key === "quality")?.options).toEqual(["high", "low"]);
    const same = structuredClone(raw); same["1"].inputs.mode = "compatible";
    expect(analyzeWorkflowImport(same, schema).errors).toEqual([]);
  });

  it("imports arbitrary custom image, video and text output contracts with all selected ancestor branches", () => {
    const raw: ApiWorkflow = {
      "1": { class_type: "AcmeSource_71c9", inputs: { prose: "My own instruction", weight: "base.safetensors", strength: .7 } },
      "2": { class_type: "AcmeSink_8e30", inputs: { value: ["1", 0], filename_prefix: "original-image" } },
      "3": { class_type: "AcmeMotion_211a", inputs: { weight: "motion.gguf", duration: 7 } },
      "4": { class_type: "AcmeSink_c011", inputs: { value: ["3", 0], filename_prefix: "original-video", save_output: true } },
      "5": { class_type: "AcmeWords_f513", inputs: { document: "Other branch", temperature: .3 } },
      "6": { class_type: "AcmeSink_03ea", inputs: { value: ["5", 0] } },
      "7": { class_type: "KSampler", inputs: { seed: 0, weight: "unselected.bin" } },
      "8": { class_type: "AcmeUnusedSink_7d36", inputs: { value: ["7", 0] } },
    };
    const schema = Object.fromEntries(Object.values(raw).map(node => [node.class_type, { output_node: node.class_type.includes("Sink"), output: ["*"] }]));
    const before = structuredClone(raw);
    const discovered = analyzeWorkflowImport(raw, schema, "2");
    expect(discovered.outputs).toHaveLength(4);
    expect(discovered.outputs.every(output => output.field === "*" && !output.needsBinding)).toBe(true);
    expect(discovered.fields).toContainEqual({ nodeId: "1", field: "prose", label: "AcmeSource_71c9 · 1.prose", value: "My own instruction" });
    const bindings: ImportBindings = { outputs: [
      { nodeId: "2", field: "rendered_images", kind: "image" },
      { nodeId: "4", field: "rendered_clips", kind: "video" },
      { nodeId: "6", field: "answer_tokens", kind: "text" },
    ] };
    const built = buildWorkflowImport(raw, { ...options, promptKey: "1.prose", bindings }, schema);
    expect(Object.keys(built.graph)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(built.graph["2"].inputs.value).toEqual(["1", 0]);
    expect(JSON.stringify(built.requirements)).not.toContain("unselected.bin");
    expect((built.requirements.items as { name: string }[]).map(item => item.name)).toEqual(["base.safetensors", "motion.gguf"]);
    const execution = built.config.execution as Record<string, any>;
    expect(execution.outputs).toEqual(bindings.outputs);
    expect(execution.output).toEqual(bindings.outputs![0]);
    const definition = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(definition.defaultPrompt).toBe("My own instruction");
    expect(definition.output).toMatchObject(bindings.outputs![0]);
    expect(definition.additionalOutputs?.map(output => ({ nodeId: output.nodeId, field: output.field, kind: output.kind }))).toEqual(bindings.outputs!.slice(1));
    expect(definition.parameters.some(parameter => ["filename_prefix", "save_output"].includes(parameter.key))).toBe(false);
    expect(raw).toEqual(before);
  });

  it("allows binding any existing node as a file output without a known save class or output_node flag", () => {
    const raw: ApiWorkflow = { "1": { class_type: "UnknownExporter_e92b", inputs: { title: "Dataset", rows: 2 } } };
    expect(analyzeWorkflowImport(raw).outputs).toEqual([{ nodeId: "1", label: "UnknownExporter_e92b · 1", kind: "file", field: "*" }]);
    expect(analyzeWorkflowImport(raw).fields.map(field => field.field)).toEqual(["title", "rows"]);
    const built = buildWorkflowImport(raw, { ...options, promptKey: "", bindings: { outputs: [{ nodeId: "1", field: "archives", kind: "file" }] } });
    const definition = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(definition.output).toEqual({ nodeId: "1", field: "archives", kind: "file" });
    expect(definition.mode).toBe("dataset"); expect(definition.directory?.canvas).toBe("image");
    expect(createLibraryRegistration(built.config, built.requirements, source)).toMatchObject({ mode: "dataset", directory: { canvas: "image" }, output: { kind: "file" } });
    expect((built.config.execution as Record<string, unknown>).outputs).toBeUndefined();
  });

  it("discovers arbitrary media loader fields from upload metadata and preserves explicit path metadata", () => {
    const raw: ApiWorkflow = {
      "1": { class_type: "ForeignLoader_b231", inputs: { source_file: "local-picture.png" } },
      "2": { class_type: "ForeignLoader_93d8", inputs: { clip_resource: "local-video.mp4" } },
      "3": { class_type: "ForeignLoader_36ea", inputs: { waveform: "local-audio.wav" } },
      "4": { class_type: "MergeMedia_c637", inputs: { first: ["1", 0], second: ["2", 0], third: ["3", 0] } },
      "5": { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "result" } },
    };
    const schema = {
      ForeignLoader_b231: { input: { required: { source_file: [["cloud-only.png"], { image_upload: true, pathMode: "comfy-input" }] } }, output: ["IMAGE"] },
      ForeignLoader_93d8: { input: { required: { clip_resource: ["STRING", { video_upload: true }] } }, output: ["VIDEO"] },
      ForeignLoader_36ea: { input: { required: { waveform: ["STRING", { upload: "audio" }] } }, output: ["AUDIO"] },
      MergeMedia_c637: { input: { required: { first: ["IMAGE"], second: ["VIDEO"], third: ["AUDIO"] } }, output: ["IMAGE"] },
      SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [] },
    };
    const analysis = analyzeWorkflowImport(raw, schema);
    expect(analysis.errors).toEqual([]);
    expect(analysis.inputs.map(input => input.kind)).toEqual(["image", "video", "audio"]);
    expect(analysis.inputs[0].pathMode).toBe("comfy-input");
    const built = buildWorkflowImport(raw, { ...options, promptKey: "" }, schema);
    expect(convertLibraryWorkflow(built.config, built.graph, built.requirements, source).mapping).toContainEqual({ semantic: "slot:input1", nodeId: "1", field: "source_file", pathMode: "comfy-input" });
  });

  it("treats manual media inputs as a full replacement and preserves optional server paths", () => {
    const raw: ApiWorkflow = {
      "1": { class_type: "LoadImage", inputs: { image: "server-existing.png" } },
      "2": { class_type: "ArbitraryLoader_983c", inputs: { location: "original/server/clip.mp4", notes: "Describe this clip", gain: 1 } },
      "3": { class_type: "ArbitrarySink_fa39", inputs: { first: ["1", 0], second: ["2", 0] } },
    };
    const bindings: ImportBindings = { outputs: [{ nodeId: "3", field: "new_video_result", kind: "video" }], mediaInputs: [{ nodeId: "2", field: "location", kind: "video", required: false, pathMode: "comfy-input", label: "Custom video" }] };
    const analysis = analyzeWorkflowImport(raw, undefined, "3", bindings);
    expect(analysis.inputs).toEqual([{ nodeId: "2", field: "location", kind: "video", required: false, pathMode: "comfy-input", label: "Custom video" }]);
    const built = buildWorkflowImport(raw, { ...options, promptKey: "2.notes", bindings });
    const definition = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(definition.inputSlots).toEqual([{ semantic: "slot:input1", label: "Custom video", kind: "video", required: false }]);
    expect(definition.template?.["2"].inputs.location).toBe("original/server/clip.mp4");
    expect(definition.template?.["1"].inputs.image).toBe("server-existing.png");
    expect(definition.parameters.find(parameter => parameter.key === "image")?.default).toBe("server-existing.png");
    expect(definition.defaultPrompt).toBe("Describe this clip");
    const required = buildWorkflowImport(raw, { ...options, promptKey: "2.notes", bindings: { ...bindings, mediaInputs: [{ ...bindings.mediaInputs![0], required: true }] } });
    expect(convertLibraryWorkflow(required.config, required.graph, required.requirements, source).template?.["2"].inputs.location).toBe("");
  });

  it("validates generic bindings while keeping scalar fields available for correction", () => {
    const raw: ApiWorkflow = { "1": { class_type: "Unknown_936d", inputs: { text: "Prompt", count: 3 } }, "2": { class_type: "Unknown_e6f1", inputs: { source: ["1", 0] } } };
    const empty: ImportBindings = { outputs: [{ nodeId: "2", field: "", kind: "text" }] };
    const analysis = analyzeWorkflowImport(raw, undefined, "2", empty);
    expect(analysis.errors.join("\n")).toContain("history 字段");
    expect(analysis.fields).toHaveLength(2);
    const outputs = [{ nodeId: "2", field: "result", kind: "text" as const }];
    expect(() => buildWorkflowImport(raw, { ...options, promptKey: "2.source", bindings: { outputs } })).toThrow("不能覆盖连接");
    expect(() => buildWorkflowImport(raw, { ...options, promptKey: "1.count", bindings: { outputs } })).toThrow("现有文本字段");
    expect(() => buildWorkflowImport(raw, { ...options, bindings: { outputs: [...outputs, ...outputs] } })).toThrow("重复输出绑定");
    expect(() => buildWorkflowImport(raw, { ...options, bindings: { outputs, mediaInputs: [{ nodeId: "2", field: "source", kind: "image" }] } })).toThrow("不能覆盖连接");
    expect(() => buildWorkflowImport(raw, { ...options, promptKey: "1.text", bindings: { outputs, mediaInputs: [{ nodeId: "1", field: "text", kind: "audio" }] } })).toThrow("主提示词与素材输入");
    const made = buildWorkflowImport(raw, { ...options, promptKey: "1.text", bindings: { outputs } });
    const bad = structuredClone(made.config) as Record<string, any>;
    bad.execution.outputs = [outputs[0], { nodeId: "1", field: "alternate", kind: "file" }];
    bad.execution.output = { nodeId: "1", field: "alternate", kind: "file" };
    expect(() => convertLibraryWorkflow(bad, made.graph, made.requirements, source)).toThrow("第一项一致");
  });

  it("preserves custom widget and JSON literals while keeping known connection contracts strict", () => {
    const raw: ApiWorkflow = {
      "1": { class_type: "ForeignWidget_176d", inputs: { widget: "opaque:selection", data: { entries: [1, 2], settings: { enabled: true } } } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "result" } },
    };
    const schema = { ForeignWidget_176d: { input: { required: { widget: ["MY_CUSTOM_WIDGET"], data: ["JSON"] } }, output: ["IMAGE"] }, SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [] } };
    const analysis = analyzeWorkflowImport(raw, schema);
    expect(analysis.errors).toEqual([]); expect(analysis.warnings.join("\n")).toContain("MY_CUSTOM_WIDGET"); expect(analysis.warnings.join("\n")).toContain("JSON");
    const built = buildWorkflowImport(raw, { ...options, promptKey: "1.widget" }, schema);
    expect(built.graph["1"].inputs.data).toEqual(raw["1"].inputs.data);
    const wrong = structuredClone(raw); wrong["2"].inputs.images = "not-an-image-connection";
    expect(analyzeWorkflowImport(wrong, schema).errors.join("\n")).toContain("缺少必需连接");
    const missing = structuredClone(raw); delete missing["1"].inputs.widget;
    expect(analyzeWorkflowImport(missing, schema).errors.join("\n")).toContain("缺少必填输入");
  });

  it("automatically imports unknown output classes and filename loaders without manual bindings", () => {
    const raw: ApiWorkflow = {
      "1": { class_type: "ArbitraryPhotoReader_26db", inputs: { src: "own-picture.png" } },
      "2": { class_type: "ArbitraryClipReader_468c", inputs: { file_path: "own-video.mp4" } },
      "3": { class_type: "ArbitraryVoiceReader_bc2f", inputs: { path: "own-audio.wav" } },
      "4": { class_type: "ArbitraryGenerator_efd4", inputs: { ideas: "Write a scene with moving waves", first: ["1", 0], clip: ["2", 0], audio: ["3", 0], model_name: "main.safetensors", format: "mp4", resolution: "720p", prompt_reference: "Mention figure.png" } },
      "5": { class_type: "ArbitraryExporter_007e", inputs: { payload: ["4", 0] } },
    };
    const schema = {
      ArbitraryPhotoReader_26db: { input: { required: { src: [["cloud-picture.png"]] } }, output: ["IMAGE"], output_node: false },
      ArbitraryClipReader_468c: { input: { required: { file_path: ["STRING"] } }, output: ["IMAGE", "AUDIO"], output_node: false },
      ArbitraryVoiceReader_bc2f: { input: { required: { path: ["STRING"] } }, output: ["AUDIO"], output_node: false },
      ArbitraryGenerator_efd4: { input: { required: { ideas: ["STRING"], first: ["IMAGE"], clip: ["IMAGE"], audio: ["AUDIO"], model_name: [["main.safetensors"]], format: [["mp4", "webm"]], resolution: [["720p", "1080p"]], prompt_reference: ["STRING"] } }, output: ["IMAGE"], output_node: false },
      ArbitraryExporter_007e: { input: { required: { payload: ["IMAGE"] } }, output: [], output_node: true },
    };
    const before = structuredClone(raw);
    const analysis = analyzeWorkflowImport(raw, schema);
    expect(analysis.errors).toEqual([]);
    expect(analysis.outputs).toEqual([{ nodeId: "5", label: "ArbitraryExporter_007e · 5", field: "*", kind: "file" }]);
    expect(analysis.inputs.map(input => ({ nodeId: input.nodeId, field: input.field, kind: input.kind }))).toEqual([
      { nodeId: "1", field: "src", kind: "image" }, { nodeId: "2", field: "file_path", kind: "video" }, { nodeId: "3", field: "path", kind: "audio" },
    ]);
    const built = buildWorkflowImport(raw, options, schema);
    expect(convertLibraryWorkflow(built.config, built.graph, built.requirements, source).output.field).toBe("*");
    expect(built.warnings.join("\n")).toContain("history 自动识别");
    expect((built.config.inputs as unknown[])).toHaveLength(3);
    expect(raw).toEqual(before);
    const photoToVideo = { ...schema, ArbitraryPhotoReader_26db: { ...schema.ArbitraryPhotoReader_26db, output: ["VIDEO"] }, ArbitraryGenerator_efd4: { ...schema.ArbitraryGenerator_efd4, input: { required: { ...schema.ArbitraryGenerator_efd4.input.required, first: ["VIDEO"] } } } };
    expect(analyzeWorkflowImport(raw, photoToVideo).errors).toEqual([]);
    expect(analyzeWorkflowImport(raw, photoToVideo).inputs[0].kind).toBe("image");
  });

  it("uses only terminal nodes for offline generic outputs and trusts cloud output_node metadata when present", () => {
    const raw: ApiWorkflow = {
      "a": { class_type: "UnknownSource_11ce", inputs: { ideas: "A quiet landscape" } },
      "b": { class_type: "UnknownTerminal_18af", inputs: { source: ["a", 0] } },
      "c": { class_type: "UnknownTerminal_442d", inputs: { source: ["a", 0] } },
    };
    const offline = analyzeWorkflowImport(raw);
    expect(offline.outputs.map(output => output.nodeId)).toEqual(["b", "c"]);
    expect(offline.outputs.every(output => output.field === "*" && output.kind === "file")).toBe(true);
    expect(offline.warnings.join("\n")).toContain("服务端注册为真实输出节点");
    const built = buildWorkflowImport(raw, options);
    expect((built.config.execution as Record<string, any>).outputs).toEqual([{ nodeId: "b", field: "*", kind: "file" }, { nodeId: "c", field: "*", kind: "file" }]);
    expect(convertLibraryWorkflow(built.config, built.graph, built.requirements, source).additionalOutputs).toEqual([{ nodeId: "c", field: "*", kind: "file" }]);
    const schema = { UnknownSource_11ce: { output: ["IMAGE"], output_node: false }, UnknownTerminal_18af: { output: [], output_node: true }, UnknownTerminal_442d: { output: [], output_node: false } };
    expect(analyzeWorkflowImport(raw, schema).outputs.map(output => output.nodeId)).toEqual(["b"]);
    expect(Object.keys(buildWorkflowImport(raw, options, schema).graph)).toEqual(["a", "b"]);
    const missingTerminalSchema = { UnknownSource_11ce: schema.UnknownSource_11ce, UnknownTerminal_442d: schema.UnknownTerminal_442d };
    expect(analyzeWorkflowImport(raw, missingTerminalSchema).outputs.map(output => output.nodeId)).toEqual(["b"]);
    expect(analyzeWorkflowImport(raw, missingTerminalSchema).warnings.join("\n")).toContain("缺少输出节点元信息");
    expect(buildWorkflowImport(raw, options, missingTerminalSchema).config.execution).toMatchObject({ output: { nodeId: "b", field: "*", kind: "file" } });
    const unspecified = { ...missingTerminalSchema, UnknownTerminal_18af: { output: [] } };
    expect(analyzeWorkflowImport(raw, unspecified).outputs.map(output => output.nodeId)).toEqual(["b"]);
    expect(analyzeWorkflowImport(raw, { ...unspecified, UnknownTerminal_18af: { output: [], output_node: false } }).outputs).toEqual([]);
  });

  it("suggests one free text field as prompt and keeps multiple free texts or configuration values unbound", () => {
    const single: ApiWorkflow = { "1": { class_type: "UnknownResult_156e", inputs: { ideas: "A quiet landscape", format: "mp4", resolution: "720p", filename_prefix: "result", model_path: "model.safetensors", system: "Do not change settings", choice: "fast" } } };
    const schema = { UnknownResult_156e: { output_node: true, input: { required: { ideas: ["STRING"], format: ["STRING"], resolution: ["STRING"], filename_prefix: ["STRING"], model_path: ["STRING"], system: ["STRING"], choice: [["fast", "slow"]] } } } };
    expect(analyzeWorkflowImport(single, schema).prompts.map(prompt => prompt.field)).toEqual(["ideas"]);
    const built = buildWorkflowImport(single, options, schema);
    expect((built.config.prompt as Record<string, any>).binding.path).toBe("inputs.ideas");
    const multiple = structuredClone(single); multiple["1"].inputs.story = "A second free text";
    expect(analyzeWorkflowImport(multiple, schema).prompts).toEqual([]);
    const ambiguous = buildWorkflowImport(multiple, options, schema);
    expect(ambiguous.config.prompt).toBeUndefined();
    expect((ambiguous.config.parameters as { defaultValue: unknown }[]).map(parameter => parameter.defaultValue)).toEqual(expect.arrayContaining(["A quiet landscape", "A second free text"]));
    const controlsOnly = structuredClone(single); delete controlsOnly["1"].inputs.ideas;
    const controlsSchema = structuredClone(schema); delete (controlsSchema.UnknownResult_156e.input.required as Record<string, unknown>).ideas;
    expect(analyzeWorkflowImport(controlsOnly, controlsSchema).prompts).toEqual([]);
  });

  it("keeps all generic fields uniquely bound when literal names collide with the standard seed key", () => {
    const raw: ApiWorkflow = {
      "a": { class_type: "ForeignOptions_581e", inputs: { seed: "fixed", "input:c:seed": "literal", value: 1 } },
      "b": { class_type: "ForeignSeed_eb1e", inputs: { noise_seed: 785 } },
      "c": { class_type: "ForeignSink_124d", inputs: { first: ["a", 0], second: ["b", 0], seed: "other", value: 2 } },
    };
    const built = buildWorkflowImport(raw, { ...options, promptKey: "" });
    const definition = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(definition.mapping.find(mapping => mapping.semantic === "seed")).toEqual({ semantic: "seed", nodeId: "b", field: "noise_seed" });
    expect(new Set(definition.parameters.map(parameter => parameter.key)).size).toBe(definition.parameters.length);
    expect(definition.mapping.filter(mapping => mapping.nodeId === "c" && mapping.field === "seed")).toHaveLength(1);
  });

  it("excludes exact virtual routing helpers from automatic outputs without excluding genuine custom result nodes", () => {
    const helperTypes = ["Note", "MarkdownNote", "Reroute", "SetNode", "GetNode", "PrimitiveNode", "PrimitiveNodeValue", "Image Comparer (rgthree)", "Fast Groups Muter (rgthree)", "Fast Groups Bypasser (rgthree)", "FastGroupsBypasser", "FastGroupsMuter", "Power Puter (rgthree)", "Anything Everywhere", "Anything Everywhere3", "Anything Everywhere?"];
    const raw: ApiWorkflow = {
      "source-a": { class_type: "CustomSource_a", inputs: {} },
      "source-b": { class_type: "CustomSource_b", inputs: {} },
      preview: { class_type: "PreviewImage", inputs: { images: ["source-a", 0] } },
      save: { class_type: "SaveImage", inputs: { images: ["source-b", 0], filename_prefix: "result" } },
      custom: { class_type: "RealEverywhereResult_741e", inputs: {} },
      ...Object.fromEntries(helperTypes.map((class_type, index) => ["helper-" + index, { class_type, inputs: {} }])),
    };
    const info = Object.fromEntries([...helperTypes, "RealEverywhereResult_741e"].map(type => [type, { output_node: true }]));
    const before = structuredClone(raw);
    const analysis = analyzeWorkflowImport(raw, info);
    expect(analysis.outputs.map(output => output.nodeId)).toEqual(["preview", "save", "custom"]);
    expect(analyzeWorkflowImport(raw).outputs.map(output => output.nodeId)).toEqual(["preview", "save", "custom"]);
    const built = buildWorkflowImport(raw, { ...options, promptKey: "" }, info);
    expect((built.config.execution as Record<string, any>).outputs.map((output: { nodeId: string }) => output.nodeId)).toEqual(["canvas-save-preview", "save", "custom"]);
    expect(built.graph.save.inputs.images).toEqual(["source-b", 0]);
    expect(built.graph["canvas-save-preview"].inputs.images).toEqual(["source-a", 0]);
    expect(Object.keys(built.graph)).not.toContain("helper-3");
    const explicit = buildWorkflowImport(raw, { ...options, promptKey: "", bindings: { outputs: [{ nodeId: "helper-3", field: "*", kind: "file" }] } }, info);
    expect((explicit.config.execution as Record<string, any>).output.nodeId).toBe("helper-3");
    expect(Object.keys(explicit.graph)).toEqual(["helper-3"]);
    expect(raw).toEqual(before);
  });
});

const personalApi = "E:/123/【Qwen Image 2.1】图像生成大合集_api.json";
const personalSchema = ".cache/directory-cloud-capabilities.json";
it.skipIf(!existsSync(personalApi) || !existsSync(personalSchema))("discovers only real Qwen API results and leaves the user's source unchanged", () => {
  const before = readFileSync(personalApi, "utf8");
  const graph = JSON.parse(before);
  const info = JSON.parse(readFileSync(personalSchema, "utf8")).objectInfo;
  const analysis = analyzeWorkflowImport(graph, info);
  expect(analysis.outputs.map(output => output.nodeId)).toEqual(["414", "470", "496"]);
  expect(analysis.outputs.map(output => graph[output.nodeId].class_type)).toEqual(["PreviewImage", "SaveImage", "PreviewAny"]);
  const offline = analyzeWorkflowImport(graph);
  expect(offline.outputs.map(output => output.nodeId)).toEqual(expect.arrayContaining(["414", "470", "496"]));
  expect(offline.outputs.some(output => ["Anything Everywhere3", "SetNode", "GetNode"].includes(graph[output.nodeId].class_type))).toBe(false);
  expect(readFileSync(personalApi, "utf8")).toBe(before);
});
