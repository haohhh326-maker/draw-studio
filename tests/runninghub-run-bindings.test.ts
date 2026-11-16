import { describe, expect, it } from "vitest";
import type { CanvasNode, WorkflowDefinition } from "../src/types";
import { attachRunningHubExecutionContract, validateRunningHubExecutionGraph } from "../src/runninghub/execution-contract";
import { prepareRunningHubRun } from "../src/runninghub/run-bindings";
import { selectRunningHubBindings } from "../src/runninghub/selected-bindings";
import { selectWorkflowOutput } from "../src/workflow/execution";
import { prepareRunningHubWorkflow, prepareRunningHubApp } from "../src/runninghub/workflows";
import { withRunningHubWorkflowReader, withRunningHubAppReader } from "./runninghub-test-reader";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { runningHubNodeInfoList } from "../src/runninghub/client";

function legacy(): WorkflowDefinition {
  return {
    id: "rh-selected-run", name: "Selected run", family: "Test", mode: "text-to-image",
    runninghub: { workflowId: "12345", baseUrl: "https://www.runninghub.cn", canvasParameterKeys: ["seed"] },
    requiredInputs: [], optionalInputs: [],
    parameters: [
      { key: "seed", label: "Seed", type: "number", default: 1 },
      { key: "device", label: "Device", type: "text", default: "cuda" },
      { key: "lora", label: "LoRA", type: "text", default: "source.safetensors" },
    ],
    mapping: [
      { semantic: "prompt", nodeId: "1", field: "prompt" },
      { semantic: "seed", nodeId: "1", field: "seed" },
      { semantic: "device", nodeId: "1", field: "device" },
      { semantic: "lora", nodeId: "2", field: "lora_name" },
    ],
    template: {
      "1": { class_type: "GenerateImage", inputs: { prompt: "source prompt", seed: 1, device: "cuda" } },
      "2": { class_type: "LoraLoader", inputs: { lora_name: "source.safetensors", strength_model: 1, strength_clip: 1 } },
      "9": { class_type: "SaveImage", inputs: { image: ["1", 0], filename_prefix: "author-prefix" } },
    },
    output: { nodeId: "9", field: "images", kind: "image" },
  };
}

async function originalWorkflow() {
  const source = legacy(), options = { workflowId: source.runninghub!.workflowId, baseUrl: source.runninghub!.baseUrl, name: source.name,
    promptKey: "1.prompt", outputs: [{ nodeId: "9", field: "images", kind: "image" as const }] };
  const workflow = prepareRunningHubWorkflow(source.template!, await withRunningHubWorkflowReader(source.template!, options)).workflow;
  return attachRunningHubExecutionContract(workflow);
}
function parameterKey(workflow: WorkflowDefinition, nodeId: string, field: string) {
  const mapping = workflow.mapping.find(mapping => mapping.nodeId === nodeId && mapping.field === field);
  if (!mapping) throw new Error("Missing fixture binding: " + nodeId + "." + field);
  return mapping.semantic;
}

describe("RunningHub new runs require the complete original reader contract", () => {
  it("drops remembered consumer-workflow internal overrides while retaining the source graph and original reader metadata", async () => {
    const original = await originalWorkflow(); original.runninghub!.billingMode = "consumer"; original.runninghub!.kind = "workflow";
    const before = structuredClone(original);
    const seed = parameterKey(original, "1", "seed"), device = parameterKey(original, "1", "device"), lora = parameterKey(original, "2", "lora_name");
    const run = await prepareRunningHubRun(original, { [seed]: 42, [device]: "cpu", [lora]: "unwanted-override.safetensors", unknown: 1 });
    expect(run.params).toEqual({ [seed]: 42 });
    expect(run.workflow.parameters.map(parameter => parameter.key)).toEqual([seed]);
    expect(run.workflow.mapping.map(mapping => mapping.semantic)).toEqual(["prompt", seed]);
    expect(run.workflow.template).toEqual(before.template);
    expect(run.workflow.runninghub!.sourceBindings).toEqual(before.runninghub!.sourceBindings);
    expect(run.workflow.runninghub!.sourceBindingDto).toEqual(before.runninghub!.sourceBindingDto);
    expect(run.workflow.runninghub!.sourceBlueprint).toEqual(before.runninghub!.sourceBlueprint);
    expect(run.workflow.runninghub!.executionContract!.sourceHash).toBe(before.runninghub!.executionContract!.sourceHash);
    expect(run.workflow.runninghub!.executionContract!.bindingHash).not.toBe(before.runninghub!.executionContract!.bindingHash);
    const node = { data: { generation: { prompt: "User prompt", negativePrompt: "", workflowId: original.id, params: run.params, taskId: null } } } as CanvasNode;
    const built = buildWorkflow(run.workflow, node, [], {});
    expect(runningHubNodeInfoList(built.workflow, run.workflow)).toEqual([
      { nodeId: "1", fieldName: "prompt", fieldValue: "User prompt" },
      { nodeId: "1", fieldName: "seed", fieldValue: 42 },
    ]);
    expect(built.workflow["1"].inputs.device).toBe("cuda");
    expect(built.workflow["2"].inputs.lora_name).toBe("source.safetensors");
    await expect(validateRunningHubExecutionGraph(run.workflow, built.workflow)).resolves.toBeUndefined();
    expect(original).toEqual(before);
  });
  it("validates the old consumer execution contract before discarding an internal control", async () => {
    const original = await originalWorkflow(); original.runninghub!.billingMode = "consumer";
    const device = parameterKey(original, "1", "device");
    original.mapping.find(mapping => mapping.semantic === device)!.field = "seed";
    await expect(prepareRunningHubRun(original, { [device]: "cpu" })).rejects.toMatchObject({ code: "RUNNINGHUB_READ_REQUIRED" });
  });
  it("retains every original binding and source value while excluding unrelated node values", async () => {
    const original = await originalWorkflow(), before = structuredClone(original);
    const seed = parameterKey(original, "1", "seed"), device = parameterKey(original, "1", "device");
    const run = await prepareRunningHubRun(original, { [seed]: 42, [device]: "cpu", unknown: "stale" });
    expect(run.workflow.runninghub?.bindingMode).toBe("selected");
    expect(run.workflow.parameters.map(parameter => parameter.key)).toEqual(original.parameters.map(parameter => parameter.key));
    expect(run.params).toEqual({ [seed]: 42, [device]: "cpu" });
    expect(run.workflow.template).toEqual(before.template);
    expect(run.workflow.runninghub?.sourceBindings).toEqual(before.runninghub?.sourceBindings);
    expect(run.workflow.runninghub?.sourceBindingDto).toEqual(before.runninghub?.sourceBindingDto);
    expect(run.workflow.runninghub?.sourceBlueprint).toEqual(before.runninghub?.sourceBlueprint);
    expect(original).toEqual(before);
    await expect(validateRunningHubExecutionGraph(run.workflow)).resolves.toBeUndefined();
  });

  it("honors explicit deselection without restoring old nondefault node values", async () => {
    const original = await originalWorkflow();
    const seed = parameterKey(original, "1", "seed"), lora = parameterKey(original, "2", "lora_name");
    const selected = await attachRunningHubExecutionContract(selectRunningHubBindings(original, []));
    const run = await prepareRunningHubRun(selected, { [seed]: 99, [lora]: "old.safetensors" });
    expect(run.workflow.parameters).toEqual([]);
    expect(run.params).toEqual({});
    expect(run.workflow.mapping.map(mapping => mapping.semantic)).toEqual(["prompt"]);
    expect(run.workflow.template).toEqual(original.template);
    expect(run.workflow.runninghub?.sourceBindings).toEqual(original.runninghub?.sourceBindings);
  });

  it("rejects a modified saved source without replacing its accepted execution contract", async () => {
    const original = await originalWorkflow(), contract = structuredClone(original.runninghub!.executionContract);
    original.template!["1"].inputs.device = "tampered";
    await expect(prepareRunningHubRun(original, {})).rejects.toThrow(/执行图或绑定/);
    expect(original.runninghub!.executionContract).toEqual(contract);
  });

  it("does not re-add unselected LoRA bindings during output selection", async () => {
    const original = await originalWorkflow(), seed = parameterKey(original, "1", "seed");
    const selected = selectRunningHubBindings(original, [seed]);
    expect(selectWorkflowOutput(selected, { lora: "old.safetensors" })).toBe(selected);
    expect(selected.parameters.map(parameter => parameter.key)).toEqual([seed]);
    expect(selected.mapping.some(mapping => mapping.nodeId === "2")).toBe(false);
  });

  it("still normalizes ordinary cloud LoRA controls", () => {
    const cloud = legacy(); delete cloud.runninghub;
    const normalized = selectWorkflowOutput(cloud, {});
    expect(normalized.parameters.some(parameter => /strength/.test(parameter.key))).toBe(true);
  });

  it("keeps all original public application fields and its existing execution snapshot", async () => {
    const app = await withRunningHubAppReader({ apiVersion: "v1", outputKind: "image", name: "Public fixture", nodeInfoList: [
      { nodeId: "1", fieldName: "prompt", fieldType: "STRING", fieldValue: "source prompt" },
      { nodeId: "1", fieldName: "seed", fieldType: "INT", fieldValue: 1 },
      { nodeId: "1", fieldName: "device", fieldType: "STRING", fieldValue: "cuda" },
      { nodeId: "2", fieldName: "lora_name", fieldType: "STRING", fieldValue: "source.safetensors" },
    ] });
    const workflow = await attachRunningHubExecutionContract(prepareRunningHubApp(app, { workflowId: "12345", baseUrl: "https://www.runninghub.cn", name: "Public fixture", promptKey: "1.prompt" }).workflow, app);
    // Consumer billing alone does not opt AI applications into the remote
    // ComfyUI control policy; all published app fields remain available.
    workflow.runninghub!.billingMode = "consumer";
    const before = structuredClone(workflow), seed = parameterKey(workflow, "1", "seed"), device = parameterKey(workflow, "1", "device");
    const run = await prepareRunningHubRun(workflow, { [seed]: 2, [device]: "cpu", unrelated: true });
    expect(run.workflow.parameters.map(parameter => parameter.key)).toEqual(workflow.parameters.map(parameter => parameter.key));
    expect(run.params).toEqual({ [seed]: 2, [device]: "cpu" });
    expect(run.workflow.runninghub?.executionContract).toEqual(before.runninghub?.executionContract);
    expect(run.workflow.runninghub?.sourceBlueprint).toEqual(before.runninghub?.sourceBlueprint);
    expect(workflow).toEqual(before);
  });

  it("requires an original re-read for legacy cached definitions instead of inferring a replacement schema", async () => {
    for (const original of [legacy(), await attachRunningHubExecutionContract(legacy())]) {
      const before = structuredClone(original);
      await expect(prepareRunningHubRun(original, { seed: 42 })).rejects.toMatchObject({ code: "RUNNINGHUB_READ_REQUIRED" });
      expect(original).toEqual(before);
    }
  });

  it.each(["revision", "bindings", "dto", "blueprint", "control"] as const)("rejects an incomplete original %s contract before a new run", async missing => {
    const original = await originalWorkflow();
    if (missing === "revision") original.importReader!.revision = "old-revision";
    if (missing === "bindings") delete original.runninghub!.sourceBindings;
    if (missing === "dto") delete original.runninghub!.sourceBindingDto;
    if (missing === "blueprint") delete original.runninghub!.sourceBlueprint;
    if (missing === "control") delete original.parameters[0].sourceControl;
    await expect(prepareRunningHubRun(original, {})).rejects.toMatchObject({ code: "RUNNINGHUB_READ_REQUIRED" });
  });
});
