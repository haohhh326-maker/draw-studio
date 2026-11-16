import { describe, expect, it } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { buildAifisherImportPackage } from "../src/workflow/aifisher-import-adapter";

const sampling = ["COMFY_DYNAMICCOMBO_V3", { options: [
  { key: "on", inputs: { required: {
    temperature: ["FLOAT", { min: 0.01, max: 2, step: 0.000001 }],
    top_k: ["INT", { min: 0, max: 1000, step: 1 }],
    top_p: ["FLOAT", { min: 0, max: 1, step: 0.01 }],
    min_p: ["FLOAT", { min: 0, max: 1, step: 0.01 }],
    repetition_penalty: ["FLOAT", { min: 0, max: 5, step: 0.01 }],
    presence_penalty: ["FLOAT", { min: 0, max: 5, step: 0.01 }],
    seed: ["INT", { min: 0, max: 18446744073709551615, step: 1 }],
  } } }, { key: "off", inputs: {} },
] }];
const info = {
  TextGenerateLTX2Prompt: { input: { required: { sampling_mode: sampling } }, output: ["STRING"] },
  PreviewAny: { input: { required: { source: ["STRING"] } }, output: [], output_node: true },
};
const values = { sampling_mode: "on", "sampling_mode.temperature": 0.7, "sampling_mode.top_k": 64,
  "sampling_mode.top_p": 0.95, "sampling_mode.min_p": 0.05, "sampling_mode.repetition_penalty": 1.05,
  "sampling_mode.presence_penalty": 0, "sampling_mode.seed": 666 };
const workflow = (inputs: Record<string, unknown> = values) => ({
  "484": { class_type: "TextGenerateLTX2Prompt", inputs: { ...inputs } },
  "496": { class_type: "PreviewAny", inputs: { source: ["484", 0] } },
});
const read = (inputs?: Record<string, unknown>) => readAIFisherWorkflow({ environment: "comfyui", source: workflow(inputs), objectInfo: info });

describe("ComfyUI DynamicCombo import compatibility", () => {
  it("reads the Qwen prompt generator's selector and all seven branch parameters without changing source or contracts", async () => {
    const source = workflow(), snapshot = structuredClone(source), definitions = structuredClone(info);
    const result = await readAIFisherWorkflow({ environment: "comfyui", source, objectInfo: info });
    expect(result.analysis.warnings).toEqual([]);
    expect(result.workflow).toEqual(snapshot);
    expect(source).toEqual(snapshot);
    expect(info).toEqual(definitions);
    expect(result.nodeDefinitions.TextGenerateLTX2Prompt.input.required.sampling_mode).toEqual(sampling);
    expect(result.bindingCandidates).toHaveLength(8);
    expect(result.bindingCandidates.find(c => c.fieldName === "sampling_mode")).toMatchObject({ value: "on", valueType: "COMBO", options: ["on", "off"], control: "select" });
    expect(result.bindingCandidates.find(c => c.fieldName === "sampling_mode.temperature")).toMatchObject({ value: 0.7, valueType: "FLOAT", minimum: 0.01, maximum: 2, step: 0.000001, required: true });
    expect(result.bindingCandidates.find(c => c.fieldName === "sampling_mode.presence_penalty")).toMatchObject({ value: 0, valueType: "FLOAT", minimum: 0, maximum: 5, step: 0.01 });
    expect(result.bindingCandidates.find(c => c.fieldName === "sampling_mode.seed")).toMatchObject({ value: 666, valueType: "INT", control: "seed" });
    const packageResult = buildAifisherImportPackage(result as never, "qwen", "Qwen");
    expect(packageResult.graph).toEqual(snapshot);
    expect(packageResult.config.parameters).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "sampling_mode.temperature", type: "float", min: 0.01, max: 2, step: 0.000001,
      binding: { target: "comfyui", nodeId: "484", path: "inputs.sampling_mode.temperature" },
    })]));
  });

  it("keeps same-class nodes' different selected branches independent", async () => {
    const source = { ...workflow(), "485": { class_type: "TextGenerateLTX2Prompt", inputs: { sampling_mode: "off" } } };
    const result = await readAIFisherWorkflow({ environment: "comfyui", source, objectInfo: info });
    expect(result.analysis.warnings).toEqual([]);
    expect(result.bindingCandidates.filter(c => c.nodeId === "485")).toHaveLength(1);
    expect(result.bindingCandidates.filter(c => c.nodeId === "484")).toHaveLength(8);
  });

  it.each([
    ["sampling_mode.top_p", 1.1], ["sampling_mode.top_k", 1.2], ["sampling_mode.temperature", 0],
    ["sampling_mode.seed", "666"], ["sampling_mode", "unknown"],
  ])("retains invalid dynamic values: %s = %s", async (field, value) => {
    const result = await read({ ...values, [field]: value });
    expect(result.analysis.warnings).toContainEqual(expect.objectContaining({ code: "INVALID_INPUT_VALUE", nodeId: "484", fieldName: field }));
    expect(result.workflow!["484"].inputs[field]).toBe(value);
  });

  it("does not invent a missing required dynamic value or accept an undeclared dotted field", async () => {
    const inputs: Record<string, unknown> = { ...values, "sampling_mode.unknown": 1 };
    delete inputs["sampling_mode.top_p"];
    const result = await read(inputs);
    expect(result.analysis.warnings).toEqual(expect.arrayContaining([
      { code: "MISSING_REQUIRED_INPUT", nodeId: "484", fieldName: "sampling_mode.top_p" },
      { code: "UNKNOWN_NODE_INPUT", nodeId: "484", fieldName: "sampling_mode.unknown" },
    ]));
    expect(result.workflow!["484"].inputs).not.toHaveProperty("sampling_mode.top_p");
  });

  it("supports nested selected branches, optional fields and linked sockets", async () => {
    const source = {
      "1": { class_type: "Source", inputs: {} },
      "2": { class_type: "Nested", inputs: { mode: "video", "mode.kind": "quality", "mode.kind.steps": 12, "mode.reference": ["1", 0] } },
    };
    const objectInfo = {
      Source: { input: {}, output: ["IMAGE"] },
      Nested: { output: [], output_node: true, input: { required: { mode: ["COMFY_DYNAMICCOMBO_V3", { options: [
        { key: "video", inputs: { required: {
          kind: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "quality", inputs: { required: { steps: ["INT", { min: 1, max: 100 }] } } }] }],
          reference: ["IMAGE"],
        }, optional: { label: ["STRING"] } } },
      ] }] } } },
    };
    const result = await readAIFisherWorkflow({ environment: "comfyui", source, objectInfo });
    expect(result.analysis.warnings).toEqual([]);
    expect(result.bindingCandidates.find(c => c.fieldName === "mode.kind.steps")).toMatchObject({ valueType: "INT", minimum: 1, maximum: 100 });
    expect(result.workflow).toEqual(source);
  });

  it("does not accept malformed option metadata or a different branch's fields", async () => {
    const result = await read({ sampling_mode: "off", "sampling_mode.temperature": 0.7 });
    expect(result.analysis.warnings).toContainEqual({ code: "UNKNOWN_NODE_INPUT", nodeId: "484", fieldName: "sampling_mode.temperature" });
    const broken = { ...info, TextGenerateLTX2Prompt: { ...info.TextGenerateLTX2Prompt,
      input: { required: { sampling_mode: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "on", inputs: false }] }] } } } };
    const malformed = await readAIFisherWorkflow({ environment: "comfyui", source: workflow(), objectInfo: broken });
    expect(malformed.analysis.warnings.length).toBeGreaterThan(0);
  });
});
