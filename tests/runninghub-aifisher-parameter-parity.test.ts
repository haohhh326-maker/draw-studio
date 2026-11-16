import { describe, expect, it } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { runningHubAppFromRead } from "../src/runninghub/client";
import { analyzeRunningHubUpstream, buildRunningHubUpstream, type RunningHubReaderResult } from "../src/runninghub/upstream-reader";
import { prepareRunningHubApp } from "../src/runninghub/workflows";
import { generationParameterSurface } from "../src/generation/parameter-actions";
import { ratioParameterChoices } from "../src/generation/ratio-parameter";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { validateRunningHubMediaInputs } from "../src/runninghub/client";
import type { CanvasNode } from "../src/types";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";

const appId = "2092444522851684354";
const aspectChoices = ["1:1 (Square)", "2:3 (Portrait Photo)", "3:2 (Photo)", "3:4 (Portrait Standard)", "4:3 (Standard)", "9:16 (Portrait Widescreen)", "16:9 (Widescreen)", "21:9 (Ultrawide)"];
// Public application schema: prompts and sample media names are sanitized.
// Missing required flags remain missing, exactly as the published contract.
const publicSchema = {
  appName: "MiniMax H3_电影质感V2",
  tags: [{ name: "文生视频", nameEn: "Text-to-Video" }],
  nodeInfoList: [
    { nodeId: "199", nodeName: "LoadImage", fieldName: "image", fieldType: "IMAGE", description: "image", fieldValue: "reference-a.png", fieldData: '[["reference-a.png","None","reference-b.png","keep_this_dic"],{"image_upload":true}]' },
    { nodeId: "188", nodeName: "LoadImage", fieldName: "image", fieldType: "IMAGE", description: "image", fieldValue: "reference-b.png", fieldData: '[["reference-a.png","None","reference-b.png","keep_this_dic"],{"image_upload":true}]' },
    { nodeId: "228", fieldName: "aspect_ratio", fieldType: "LIST", description: "aspect_ratio", fieldValue: "16:9 (Widescreen)", fieldData: JSON.stringify([aspectChoices, { default: "1:1 (Square)" }]) },
    { nodeId: "228", fieldName: "megapixels", fieldType: "FLOAT", description: "megapixels", fieldValue: "1", fieldData: '["FLOAT",{"default":1,"min":0.1,"max":16,"step":0.1}]' },
    { nodeId: "227", fieldName: "value", fieldType: "FLOAT", description: "value", fieldValue: "10", fieldData: '["FLOAT",{"min":-9223372036854775807,"max":9223372036854775807,"step":0.1}]' },
    { nodeId: "166", fieldName: "strength_model", fieldType: "FLOAT", description: "电影感lora强度", fieldValue: "0.8500000000000002", fieldData: '["FLOAT",{"default":1,"min":-100,"max":100,"step":0.01}]' },
    { nodeId: "238", fieldName: "value", fieldType: "STRING", description: "value", fieldValue: "[sanitized prompt] ".repeat(8).trim(), fieldData: '["STRING",{"multiline":true}]' },
  ],
};

async function readFixture() {
  const read = await readAIFisherWorkflow({ environment: "runninghub-webapp", source: publicSchema, remoteId: appId });
  const app = runningHubAppFromRead(read as unknown as AifisherWorkflowReadResult);
  return { app, read, reader: read as unknown as RunningHubReaderResult };
}

describe("RunningHub parameters match AIFISHER binding controls", () => {
  it("publishes the actual upstream binding controls and their presentation order", async () => {
    const { read } = await readFixture();
    expect(read.parameterBindings).toHaveLength(7);
    expect(read.parameterBindingDto?.bindings).toHaveLength(7);
    const numericAndChoice = read.parameterBindings!.filter(binding => binding.control.kind !== "asset" && binding.target.nodeId !== "238");
    expect(numericAndChoice.map(binding => [binding.target.nodeId, binding.target.fieldName, binding.label, binding.control.kind])).toEqual([
      ["166", "strength_model", "电影感lora强度", "number"],
      ["227", "value", "value", "number"],
      ["228", "aspect_ratio", "aspect_ratio", "select"],
      ["228", "megapixels", "megapixels", "number"],
    ]);
    expect(numericAndChoice.map(binding => binding.control.defaultValue)).toEqual([0.8500000000000002, 10, "16:9 (Widescreen)", 1]);
    expect(numericAndChoice.map(binding => binding.presentation.order)).toEqual([...numericAndChoice.map(binding => binding.presentation.order)].sort((a, b) => a - b));
    const ratio = numericAndChoice.find(binding => binding.target.fieldName === "aspect_ratio")!;
    expect(ratio.control.options).toEqual(aspectChoices);
    const dtoRatio = read.parameterBindingDto!.bindings.find((binding: { id: string }) => binding.id === ratio.id);
    expect(dtoRatio.control.options.map((option: { label: string }) => option.label)).toEqual(aspectChoices);
    expect(dtoRatio.control.options.some((option: { id: string }) => option.id === dtoRatio.control.defaultValue)).toBe(true);
  });

  it("recognizes the unique multiline node 238.value as the main prompt and keeps both images optional", async () => {
    const { reader } = await readFixture();
    const analysis = analyzeRunningHubUpstream(reader);
    expect(analysis.prompts).toEqual([expect.objectContaining({ nodeId: "238", field: "value" })]);
    expect(analysis.inputs).toHaveLength(2);
    expect(analysis.inputs.map(input => input.required)).toEqual([false, false]);
    expect(new Set(analysis.inputs.map(input => input.nodeId))).toEqual(new Set(["188", "199"]));
  });

  it("uses four generation controls instead of treating the main prompt as a fifth parameter", async () => {
    const { reader } = await readFixture();
    const before = structuredClone(reader.workflow);
    const workflow = buildRunningHubUpstream(reader, {
      id: "parity", workflowId: appId, baseUrl: "https://www.runninghub.cn", name: publicSchema.appName,
      outputs: [{ nodeId: "fisherai_webapp_output", field: "files", kind: "video" }],
    });
    expect(workflow.mapping.find(binding => binding.semantic === "prompt")).toMatchObject({ nodeId: "238", field: "value" });
    expect(workflow.promptRequired).toBe(true);
    expect(workflow.parameters.map(parameter => [parameter.label, parameter.type, parameter.default])).toEqual([
      ["电影感lora强度", "number", 0.8500000000000002],
      ["value", "number", 10],
      ["aspect_ratio", "select", "16:9 (Widescreen)"],
      ["megapixels", "number", 1],
    ]);
    const ratio = workflow.parameters.find(parameter => parameter.label === "aspect_ratio")!;
    expect(ratio.options?.map(id => ratio.optionLabels?.[id])).toEqual(aspectChoices);
    expect(ratio.options?.map(id => ratio.optionValues?.[id])).toEqual(aspectChoices);
    expect(ratio.options).not.toContain("16:9 (Widescreen)");
    const selectedId = ratio.options?.find(id => ratio.optionValues?.[id] === ratio.default);
    expect(selectedId).toBeDefined();
    expect(ratio.optionLabels?.[selectedId!]).toBe("16:9 (Widescreen)");
    expect(ratio.default).toBe("16:9 (Widescreen)");
    expect(workflow.inputSlots).toHaveLength(2);
    expect(workflow.inputSlots?.every(slot => slot.required === false)).toBe(true);
    expect(workflow.requiredInputs).toEqual([]);
    expect(workflow.optionalInputs).toHaveLength(2);
    expect(workflow.template).toEqual(before);
    expect(reader.workflow).toEqual(before);
  });

  it("retains the same optional media contract and four controls through app preparation", async () => {
    const { app, reader } = await readFixture();
    const before = structuredClone(reader.workflow);
    const { workflow } = prepareRunningHubApp({ ...app, reader }, {
      workflowId: appId, baseUrl: "https://www.runninghub.cn", name: publicSchema.appName, reader,
      outputs: [{ nodeId: "fisherai_webapp_output", field: "files", kind: "video" }],
    });
    expect(workflow.parameters).toHaveLength(4);
    expect(workflow.runninghub?.bindingMode).toBe("selected");
    expect(workflow.runninghub?.mediaInputs).toEqual([
      expect.objectContaining({ nodeId: "188", field: "image", required: false, emptyValue: "None" }),
      expect.objectContaining({ nodeId: "199", field: "image", required: false, emptyValue: "None" }),
    ]);
    expect(workflow.mapping.find(binding => binding.semantic === "prompt")).toMatchObject({ nodeId: "238", field: "value" });
    expect(workflow.template).toEqual(before);
  });

  it("keeps all four source control kinds, value types, order and labels on the visible surface", async () => {
    const { app, reader } = await readFixture();
    const { workflow } = prepareRunningHubApp({ ...app, reader }, {
      workflowId: appId, baseUrl: "https://www.runninghub.cn", name: publicSchema.appName, reader,
      outputs: [{ nodeId: "fisherai_webapp_output", field: "files", kind: "video" }],
    });
    const sourceBindings = reader.parameterBindings!.filter(binding => binding.control.kind !== "asset" && binding.target.nodeId !== "238");
    expect(workflow.parameters.map(parameter => parameter.sourceControl)).toEqual(sourceBindings.map(binding => ({
      kind: binding.control.kind, valueType: binding.target.expectedValueType, order: binding.presentation.order,
    })));
    expect(workflow.parameters.map(parameter => [parameter.sourceControl?.kind, parameter.sourceControl?.valueType])).toEqual([
      ["number", "FLOAT"], ["number", "FLOAT"], ["select", "COMBO"], ["number", "FLOAT"],
    ]);
    const before = structuredClone(workflow);
    const surface = generationParameterSurface(workflow);
    const visible = [...surface.basic, ...surface.advanced, ...surface.other];
    expect(visible).toEqual(workflow.parameters);
    expect(visible.map(parameter => parameter.label)).toEqual(["电影感lora强度", "value", "aspect_ratio", "megapixels"]);
    expect(visible.map(parameter => parameter.default)).toEqual([0.8500000000000002, 10, "16:9 (Widescreen)", 1]);
    const ratio = visible.find(parameter => parameter.label === "aspect_ratio")!;
    expect(ratioParameterChoices(ratio, String(ratio.default), workflow)).toBe(ratio);
    expect(ratio.options?.map(id => ratio.optionValues?.[id])).toEqual(aspectChoices);
    const freeRatio = { ...ratio, type: "text" as const, default: "16:9", options: undefined, optionLabels: undefined, optionValues: undefined,
      sourceControl: { ...ratio.sourceControl!, kind: "text", valueType: "STRING" } };
    expect(ratioParameterChoices(freeRatio, "16:9", workflow)).toBe(freeRatio);
    expect(ratioParameterChoices(freeRatio, "16:9", workflow).options).toBeUndefined();
    expect(workflow).toEqual(before);
  });

  it("keeps numeric and boolean choice defaults typed while opaque option IDs map back to their wire values", async () => {
    const source = { appName: "typed choice schema", nodeInfoList: [
      { nodeId: "1", fieldName: "mode", fieldType: "LIST", fieldValue: 1, fieldData: [[0, 1, 2], {}] },
      { nodeId: "2", fieldName: "enabled", fieldType: "LIST", fieldValue: true, fieldData: [[false, true], {}] },
    ] };
    const read = await readAIFisherWorkflow({ environment: "runninghub-webapp", source, remoteId: appId });
    const app = runningHubAppFromRead(read as unknown as AifisherWorkflowReadResult);
    const reader = read as unknown as RunningHubReaderResult;
    const { workflow } = prepareRunningHubApp({ ...app, reader }, { workflowId: appId, baseUrl: "https://www.runninghub.cn", name: "typed choice schema", reader });
    const [numeric, boolean] = workflow.parameters;
    expect(numeric.default).toBe(1);
    expect(boolean.default).toBe(true);
    expect(numeric.options?.map(id => numeric.optionValues?.[id])).toEqual([0, 1, 2]);
    expect(boolean.options?.map(id => boolean.optionValues?.[id])).toEqual([false, true]);
    expect(numeric.options?.map(id => numeric.optionLabels?.[id])).toEqual(["0", "1", "2"]);
    expect(boolean.options?.map(id => boolean.optionLabels?.[id])).toEqual(["false", "true"]);
    expect(workflow.template).toEqual(reader.workflow);
  });

  it("builds the actual app's prompt, typed parameters and optional media without making any network request", async () => {
    const { app, reader } = await readFixture();
    const before = structuredClone(reader.workflow);
    const { workflow } = prepareRunningHubApp({ ...app, reader }, {
      workflowId: appId, baseUrl: "https://www.runninghub.cn", name: publicSchema.appName, reader,
      outputs: [{ nodeId: "fisherai_webapp_output", field: "files", kind: "video" }],
    });
    const params = Object.fromEntries(workflow.parameters.map(parameter => [parameter.key, parameter.default]));
    const node = { id: "parity-build", data: { generation: {
      workflowId: workflow.id, prompt: "[user prompt]", negativePrompt: "", params, taskId: null,
    } } } as CanvasNode;
    const built = buildWorkflow(workflow, node, [], {});
    expect(built.workflow["238"].inputs.value).toBe("[user prompt]");
    expect(built.workflow["227"].inputs.value).toBe(10);
    expect(built.workflow["166"].inputs.strength_model).toBe(0.8500000000000002);
    expect(built.workflow["228"].inputs.aspect_ratio).toBe("16:9 (Widescreen)");
    expect(built.workflow["228"].inputs.megapixels).toBe(1);
    expect(built.workflow["188"].inputs.image).toBe("None");
    expect(built.workflow["199"].inputs.image).toBe("None");
    expect(() => validateRunningHubMediaInputs(workflow, built.workflow)).not.toThrow();
    expect(workflow.template).toEqual(before);
    expect(reader.workflow).toEqual(before);
    expect(node.data.generation?.params).toEqual(params);
    expect(Object.keys(built.workflow)).toEqual(Object.keys(reader.workflow!));
  });

  it("keeps an uploaded optional image while clearing only the other unconnected input", async () => {
    const { app, reader } = await readFixture();
    const { workflow } = prepareRunningHubApp({ ...app, reader }, {
      workflowId: appId, baseUrl: "https://www.runninghub.cn", name: publicSchema.appName, reader,
      outputs: [{ nodeId: "fisherai_webapp_output", field: "files", kind: "video" }],
    });
    const image = workflow.mapping.find(mapping => mapping.nodeId === "188" && mapping.field === "image")!;
    const node = { data: { generation: { workflowId: workflow.id, prompt: "[user prompt]", negativePrompt: "", params: {}, taskId: null } } } as CanvasNode;
    const inputs = [{ semantic: image.semantic, asset: { id: "connected-image", name: "reference.png", kind: "image" }, edgeId: "image-edge" }] as Parameters<typeof buildWorkflow>[2];
    const before = structuredClone(workflow.template);
    const built = buildWorkflow(workflow, node, inputs, { "connected-image": "openapi/uploaded.png" });
    expect(built.workflow["188"].inputs.image).toBe("openapi/uploaded.png");
    expect(built.workflow["199"].inputs.image).toBe("None");
    expect(() => validateRunningHubMediaInputs(workflow, built.workflow)).not.toThrow();
    expect(workflow.template).toEqual(before);
  });
});
