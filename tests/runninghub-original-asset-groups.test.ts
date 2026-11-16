import { describe, expect, it } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { deriveBindingCandidates, deriveBindingSetBindings, toBindingSetDto } from "../vendor/aifisher/server/workflowRuntime/workflowBindingCompiler.js";
import { prepareRunningHubWorkflow } from "../src/runninghub/workflows";
import { analyzeRunningHubUpstream, type RunningHubReaderResult } from "../src/runninghub/upstream-reader";
import { attachRunningHubExecutionContract, validateRunningHubExecutionGraph } from "../src/runninghub/execution-contract";
import { prepareRunningHubRun } from "../src/runninghub/run-bindings";
import { runningHubNodeInfoList } from "../src/runninghub/client";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import type { ApiWorkflow, CanvasNode } from "../src/types";

const source = (): ApiWorkflow => ({
  "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
  "2": { class_type: "LoadImage", inputs: { image: "b.png" } },
  "3": { class_type: "ReferenceCollection", inputs: { "references.image0": ["1", 0], "references.image1": ["2", 0] } },
  "4": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "result" } },
});
const definitions = {
  LoadImage: { input: { required: { image: [["a.png", "b.png"], { image_upload: true }] } }, output: ["IMAGE"] },
  VHS_LoadVideo: { input: { required: { video: ["STRING", { default: "" }] } }, output: ["IMAGE", "AUDIO"] },
  ReferenceCollection: { input: { optional: {
    references: ["COMFY_AUTOGROW_V3", { template: { prefix: "image", min: 1, max: 9, input: { required: { image: ["IMAGE"] } } } }],
    videos: ["COMFY_AUTOGROW_V3", { template: { prefix: "video", min: 0, max: 3, input: { required: { video: ["IMAGE"] } } } }],
    video_audio: ["COMFY_AUTOGROW_V3", { template: { prefix: "audio", min: 0, max: 3, input: { required: { audio: ["AUDIO"] } } } }],
  } }, output: ["IMAGE"] },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
};

async function readOriginalGroups(graph = source()) {
  // Use unchanged AIFISHER schema analysis and binding compilation. The remote
  // adapter may receive the same declared groups from an execution environment.
  const detailed = await readAIFisherWorkflow({ environment: "comfyui", source: graph, objectInfo: definitions });
  const portable = await readAIFisherWorkflow({ environment: "runninghub-workflow", source: graph });
  const bindingCandidates = deriveBindingCandidates({ executionPlan: graph, nodeDefinitions: definitions });
  const parameterBindings = deriveBindingSetBindings({ executionPlan: graph, nodeDefinitions: definitions,
    selections: bindingCandidates.map(candidate => ({ candidateId: candidate.id })) });
  return { ...portable, analysis: detailed.analysis, nodeDefinitions: definitions,
    bindingCandidates, parameterBindings,
    parameterBindingDto: toBindingSetDto({ bindings: parameterBindings }) } as unknown as RunningHubReaderResult;
}
const options = { workflowId: "2115791287499706370", baseUrl: "https://www.runninghub.cn", name: "Original groups", promptKey: "",
  outputs: [{ nodeId: "4", field: "images", kind: "image" as const }] };

describe("RunningHub original connected asset groups", () => {
  it("binds existing loader fields and applies uploaded files without expanding or rewriting grouped connections", async () => {
    const reader = await readOriginalGroups(), before = structuredClone(reader);
    expect(reader.bindingCandidates.some(candidate => candidate.valueType === "ASSET_GROUP")).toBe(true);
    const analysis = analyzeRunningHubUpstream(reader);
    expect(analysis.inputs.map(input => input.nodeId + "." + input.field)).toEqual(["1.image", "2.image"]);
    let workflow = prepareRunningHubWorkflow(reader.workflow, { ...options, reader }).workflow;
    workflow.runninghub = { ...workflow.runninghub!, billingMode: "consumer", kind: "workflow", includeWorkflowJson: false };
    workflow = await attachRunningHubExecutionContract(workflow);
    expect(workflow.mapping.some(mapping => mapping.nodeId === "3")).toBe(false);
    const prepared = await prepareRunningHubRun(workflow, {});
    const inputs = workflow.inputSlots!.map((slot, index) => ({ semantic: slot.semantic,
      asset: { id: String(index), kind: "image", name: String(index) + ".png" }, edgeId: String(index) })) as Parameters<typeof buildWorkflow>[2];
    const node = { data: { generation: { workflowId: workflow.id, prompt: "", negativePrompt: "", params: prepared.params, taskId: null } } } as CanvasNode;
    const built = buildWorkflow(prepared.workflow, node, inputs, { "0": "openapi/first.png", "1": "openapi/second.png" });
    await expect(validateRunningHubExecutionGraph(prepared.workflow, built.workflow)).resolves.toBeUndefined();
    expect(built.workflow["3"]).toEqual(reader.workflow!["3"]);
    expect(Object.keys(built.workflow)).toEqual(Object.keys(reader.workflow!));
    expect(runningHubNodeInfoList(built.workflow, prepared.workflow)).toEqual(expect.arrayContaining([
      { nodeId: "1", fieldName: "image", fieldValue: "openapi/first.png" },
      { nodeId: "2", fieldName: "image", fieldValue: "openapi/second.png" },
    ]));
    expect(reader).toEqual(before);
  });
  it("retains a zero-capacity optional group without inventing input nodes or scalar fields", async () => {
    const reader = await readOriginalGroups();
    const groups = reader.bindingCandidates.filter(candidate => candidate.valueType === "ASSET_GROUP") as any[];
    expect(groups.some(group => group.variableAssetGroup.capacity === 0 && group.variableAssetGroup.minimumItems === 0)).toBe(true);
    const workflow = await attachRunningHubExecutionContract(prepareRunningHubWorkflow(reader.workflow, { ...options, reader }).workflow);
    expect(workflow.inputSlots).toHaveLength(2);
    await expect(prepareRunningHubRun(workflow, {})).resolves.toBeDefined();
    expect(workflow.template).toEqual(source());
  });
  it("rejects unsupported group metadata with the exact group and node instead of mapping an object to a scalar override", async () => {
    const reader = await readOriginalGroups(), invalid = structuredClone(reader);
    const group = invalid.bindingCandidates.find(candidate => candidate.valueType === "ASSET_GROUP") as any;
    group.variableAssetGroup.branches[0].connections[0].outputIndex = 99;
    expect(() => analyzeRunningHubUpstream(invalid)).toThrow("动态素材组 references");
    expect(() => prepareRunningHubWorkflow(invalid.workflow, { ...options, reader: invalid })).toThrow("节点 3");
    expect(invalid.workflow).toEqual(reader.workflow);
  });
});
