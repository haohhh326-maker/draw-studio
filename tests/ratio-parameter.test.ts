import { describe, expect, it } from "vitest";
import type { ApiWorkflow, CanvasNode, Parameter, WorkflowDefinition } from "../src/types";
import { ratioParameterChoices } from "../src/generation/ratio-parameter";
import { defaults } from "../src/workflow/catalog";
import { buildWorkflow } from "../src/workflow-adapter/adapter";

const ratios = ["1:1 (Square)", "2:3 (Portrait Photo)", "3:2 (Photo)", "3:4 (Portrait Standard)", "4:3 (Standard)", "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "21:9 (Ultrawide)"];
function imported(source?: ApiWorkflow) {
  const graph = source ?? {
    resolution: { class_type: "ResolutionSelector", inputs: { aspect_ratio: "16:9 (Widescreen)", megapixels: .7, multiple: 32 } },
    latent: { class_type: "EmptyLatentImage", inputs: { width: ["resolution", 0], height: ["resolution", 1], batch_size: 1 } },
    save: { class_type: "SaveImage", inputs: { images: ["latent", 0], filename_prefix: "original/result" } },
  };
  const parameters: Parameter[] = [], mapping: WorkflowDefinition["mapping"] = [];
  for (const [nodeId, node] of Object.entries(graph)) for (const [field, value] of Object.entries(node.inputs)) {
    if (!["number", "string", "boolean"].includes(typeof value)) continue;
    const key = nodeId + "." + field;
    parameters.push({ key, label: field, type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "text", default: value as string | number | boolean });
    mapping.push({ semantic: key, nodeId, field });
  }
  return { id: "ratio-fixture", name: "比例控件", family: "图像工具", mode: "text-to-image", promptRequired: false, requiredInputs: [], optionalInputs: [], parameters, mapping, template: graph,
    output: { nodeId: "save", field: "images", kind: "image" }, runninghub: { workflowId: "1234567890123456789", baseUrl: "https://www.runninghub.cn" },
    original: { id: "fixture", version: "1", folder: "", configFile: "", configSha256: "", executionFile: "", executionStatus: "plain", executionSha256: "", inputs: [], models: [], docsUrl: "", promptPlaceholder: "",
      parameterBindings: Object.fromEntries(mapping.map(item => [item.semantic, { nodeId: item.nodeId, path: "inputs." + item.field }])) } } as WorkflowDefinition;
}
function ratio(workflow: WorkflowDefinition, nodeId = "resolution", field = "aspect_ratio") {
  const key = workflow.mapping.find(mapping => mapping.nodeId === nodeId && mapping.field === field)!.semantic;
  return workflow.parameters.find(parameter => parameter.key === key)!;
}
function canvasNode(workflow: WorkflowDefinition, params: Record<string, string | number | boolean>): CanvasNode {
  return { id: "node", position: { x: 0, y: 0 }, data: { kind: "image-generation", title: "图像", generation: { workflowId: workflow.id, prompt: "", negativePrompt: "", params, taskId: null } } };
}

describe("ratio parameter choices", () => {
  it("offers complete ResolutionSelector enum values while displaying concise ratios without mutating the workflow", () => {
    const workflow = imported(), before = structuredClone(workflow), parameter = ratio(workflow);
    const chooser = ratioParameterChoices(parameter, String(parameter.default), workflow);
    expect(chooser).toMatchObject({ type: "select", default: "16:9 (Widescreen)", options: ratios });
    expect(chooser.optionLabels?.["16:9 (Widescreen)"]).toBe("16:9");
    expect(chooser.optionLabels?.["9:16 (Portrait Widescreen)"]).toBe("9:16");
    expect(chooser).not.toBe(parameter);
    expect(workflow).toEqual(before);
  });

  it("executes the exact chosen decorated value at the original field and preserves every other source value", () => {
    const workflow = imported(), before = structuredClone(workflow), parameter = ratio(workflow);
    const choice = ratioParameterChoices(parameter, String(parameter.default), workflow).options!.find(option => option === "9:16 (Portrait Widescreen)")!;
    const executed = buildWorkflow(workflow, canvasNode(workflow, { ...defaults(workflow), [parameter.key]: choice }), [], {}).workflow;
    const expected = structuredClone(before.template!);
    expected.resolution.inputs.aspect_ratio = choice;
    expect(executed).toEqual(expected);
    expect(workflow).toEqual(before);
  });

  it("honors supplied schema choices and value aliases instead of broadening a constrained enum", () => {
    const workflow = imported(), parameter: Parameter = { ...ratio(workflow), type: "select", options: ["16:9 (Widescreen)"], optionLabels: { "16:9 (Widescreen)": "横屏" }, optionValues: { "16:9 (Widescreen)": "16:9 (Widescreen)" } };
    const before = structuredClone(parameter), chooser = ratioParameterChoices(parameter, "9:16 (Portrait Widescreen)", workflow);
    expect(chooser.options).toEqual(parameter.options);
    expect(chooser.optionLabels).toEqual(parameter.optionLabels);
    expect(chooser.optionValues).toEqual(parameter.optionValues);
    expect(chooser.options).not.toBe(parameter.options);
    expect(parameter).toEqual(before);
    const unknown: Parameter = { key: "aspect_ratio", label: "比例", type: "select", default: "special", options: ["special", "other"], optionLabels: { special: "自定" } };
    expect(ratioParameterChoices(unknown, "special")).toEqual(unknown);
  });

  it("follows a primitive string's actual consumer and original bindings without relying on parameter names or node IDs", () => {
    const workflow = imported({
      text: { class_type: "PrimitiveString", inputs: { value: "16:9 (Widescreen)" } },
      forward: { class_type: "PrimitiveString", inputs: { value: ["text", 0] } },
      resolution: { class_type: "ResolutionSelector", inputs: { aspect_ratio: ["forward", 0], megapixels: .7 } },
      save: { class_type: "SaveImage", inputs: { images: ["resolution", 0], filename_prefix: "original/result" } },
    });
    const parameter = ratio(workflow, "text", "value"), before = structuredClone(workflow);
    expect(ratioParameterChoices(parameter, String(parameter.default), workflow).options).toEqual(ratios);
    workflow.mapping = workflow.mapping.filter(mapping => mapping.semantic !== parameter.key);
    expect(ratioParameterChoices(parameter, String(parameter.default), workflow).options).toEqual(ratios);
    expect(workflow.template).toEqual(before.template);
    expect(workflow.original?.parameterBindings).toEqual(before.original?.parameterBindings);
  });

  it("does not infer the known node contract for mixed primitive consumers or similarly named custom nodes", () => {
    const workflow = imported({
      text: { class_type: "PrimitiveString", inputs: { value: "16:9 (Widescreen)" } },
      resolution: { class_type: "ResolutionSelector", inputs: { aspect_ratio: ["text", 0], megapixels: .7 } },
      other: { class_type: "CustomResolutionSelector", inputs: { aspect_ratio: ["text", 0] } },
      save: { class_type: "SaveImage", inputs: { images: ["resolution", 0], filename_prefix: "original/result" } },
    });
    const parameter = ratio(workflow, "text", "value"), chooser = ratioParameterChoices(parameter, String(parameter.default), workflow);
    expect(chooser.type).toBe("text");
    expect(chooser.options).toEqual(["16:9 (Widescreen)"]);
    const custom = imported({ resolution: { class_type: "CustomResolutionSelector", inputs: { aspect_ratio: "16:9 (Widescreen)" } }, save: { class_type: "SaveImage", inputs: { images: ["resolution", 0] } } });
    expect(ratioParameterChoices(ratio(custom), "16:9 (Widescreen)", custom).type).toBe("text");
  });

  it("retains unusual current and default values on a verified node without changing either stored value", () => {
    const workflow = imported(), parameter = { ...ratio(workflow), default: "original-node-value" };
    const chooser = ratioParameterChoices(parameter, "custom-current-value", workflow);
    expect(chooser.options).toEqual([...ratios, "custom-current-value", "original-node-value"]);
    expect(chooser.default).toBe("original-node-value");
    expect(chooser.optionLabels?.["custom-current-value"]).toBe("custom-current-value");
  });

  it("keeps unknown ratio text editable and suggests bare ratios only when current and default are both bare", () => {
    const parameter: Parameter = { key: "aspect_ratio", label: "比例", type: "text", default: "16:9" };
    const chooser = ratioParameterChoices(parameter, "5:4");
    expect(chooser.type).toBe("text");
    expect(chooser.options).toEqual(["5:4", "16:9", "1:1", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"]);
    expect(ratioParameterChoices({ ...parameter, default: "original" }, "original").options).toEqual(["original"]);
    expect(ratioParameterChoices(parameter, "16:9 (Unknown Meaning)").options).toEqual(["16:9 (Unknown Meaning)", "16:9"]);
  });

  it("leaves unrelated text and resize-node named values intact without fabricating known enum choices", () => {
    const unrelated: Parameter = { key: "notes", label: "备注", type: "text", default: "16:9 (Widescreen)" };
    expect(ratioParameterChoices(unrelated, "16:9 (Widescreen)")).toEqual(unrelated);
    const workflow = imported({ resolution: { class_type: "LayerUtility: ImageScaleByAspectRatio V2", inputs: { aspect_ratio: "original", scale_to_length: 1024 } }, save: { class_type: "SaveImage", inputs: { images: ["resolution", 0] } } });
    const chooser = ratioParameterChoices(ratio(workflow), "original", workflow);
    expect(chooser.type).toBe("text");
    expect(chooser.options).toEqual(["original"]);
  });
});

describe("consumer remote workflow ResolutionSelector controls", () => {
  function consumer(source?: ApiWorkflow) {
    const workflow = imported(source);
    workflow.runninghub = { ...workflow.runninghub!, kind: "workflow", billingMode: "consumer", parameterSchemaVersion: 2 };
    for (const parameter of workflow.parameters) parameter.sourceControl = { kind: parameter.type === "number" ? "number" : "text", valueType: parameter.type === "number" ? "FLOAT" : "STRING", order: 0 };
    return workflow;
  }
  it("offers concise official ratio labels for verified schema-v2 text controls while submitting the complete string", () => {
    const workflow = consumer(), parameter = ratio(workflow), before = structuredClone(workflow);
    const chooser = ratioParameterChoices(parameter, "9:16 (Portrait Widescreen)", workflow);
    expect(chooser.type).toBe("select"); expect(chooser.options).toEqual(ratios);
    expect(chooser.optionLabels?.["9:16 (Portrait Widescreen)"]).toBe("9:16");
    const execution = buildWorkflow(workflow, canvasNode(workflow, { [parameter.key]: "9:16 (Portrait Widescreen)" }), [], {}).workflow;
    expect(execution.resolution.inputs.aspect_ratio).toBe("9:16 (Portrait Widescreen)");
    expect(workflow).toEqual(before); expect(parameter.type).toBe("text");
  });
  it("retains the platform's restricted select options and wire-value aliases", () => {
    const workflow = consumer(), parameter: Parameter = { ...ratio(workflow), type: "select", options: ["portrait"], default: "9:16 (Portrait Widescreen)", optionLabels: { portrait: "Portrait Widescreen" }, optionValues: { portrait: "9:16 (Portrait Widescreen)" } };
    const before = structuredClone(parameter), chooser = ratioParameterChoices(parameter, String(parameter.default), workflow);
    expect(chooser.options).toEqual(["portrait"]); expect(chooser.optionValues).toEqual(parameter.optionValues);
    expect(chooser.optionLabels).toEqual({ portrait: "9:16" }); expect(parameter).toEqual(before);
  });
  it("follows exact primitive consumers but does not guess an enum for similarly named custom or mixed targets", () => {
    const workflow = consumer({ text: { class_type: "PrimitiveString", inputs: { value: "16:9 (Widescreen)" } }, resolution: { class_type: "ResolutionSelector", inputs: { aspect_ratio: ["text", 0] } }, save: { class_type: "SaveImage", inputs: { images: ["resolution", 0] } } });
    const parameter = ratio(workflow, "text", "value");
    expect(ratioParameterChoices(parameter, String(parameter.default), workflow).options).toEqual(ratios);
    workflow.template!.custom = { class_type: "CustomResolutionSelector", inputs: { aspect_ratio: ["text", 0] } };
    expect(ratioParameterChoices(parameter, "16:9 (Unknown Meaning)", workflow)).toBe(parameter);
    workflow.template!.resolution.class_type = "CustomResolutionSelector"; delete workflow.template!.custom;
    expect(ratioParameterChoices(parameter, "16:9 (Unknown Meaning)", workflow)).toBe(parameter);
  });
  it("keeps AI applications and other schema-v2 controls on their original public presentation path", () => {
    const workflow = consumer(), parameter = ratio(workflow);
    workflow.runninghub!.kind = "app";
    expect(ratioParameterChoices(parameter, String(parameter.default), workflow)).toBe(parameter);
    workflow.runninghub!.kind = "workflow"; delete workflow.runninghub!.billingMode;
    expect(ratioParameterChoices(parameter, String(parameter.default), workflow)).toBe(parameter);
  });
});
