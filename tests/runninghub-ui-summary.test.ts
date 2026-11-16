import { describe, expect, it } from "vitest";
import type { ApiWorkflow, WorkflowDefinition } from "../src/types";
import type { RunningHubAiApp } from "../src/runninghub/client";
import { prepareRunningHubApp, prepareRunningHubWorkflowCandidates } from "../src/runninghub/workflows";
import { attachRunningHubExecutionContract } from "../src/runninghub/execution-contract";
import { runningHubCanvasParameterKeys, runningHubSelectableParameters, runningHubSourceSummary } from "../src/runninghub/source-summary";
import { withRunningHubAppReader, withRunningHubWorkflowReader } from "./runninghub-test-reader";

const graph = (): ApiWorkflow => ({
  input: { class_type: "LoadImage", inputs: { image: "author-example.png" } },
  generate: { class_type: "ImageGenerator", inputs: { image: ["input", 0], prompt: "author prompt", seed: 1, steps: 20, cfg: 7,
    internal_value: "fixed helper setting", provider_api_key: "fixture-author-key" } },
  model: { class_type: "UNETLoader", inputs: { unet_name: "generator.safetensors" } },
  save: { class_type: "SaveImage", inputs: { images: ["generate", 0], filename_prefix: "original", save_output: true } },
});
const options = { workflowId: "1234567890123456789", baseUrl: "https://www.runninghub.cn", name: "Fixture",
  promptKey: "generate.prompt", outputs: [{ nodeId: "save", field: "images", kind: "image" as const }] };
const keyFor = (workflow: WorkflowDefinition, nodeId: string, field: string) => workflow.mapping.find(mapping => mapping.nodeId === nodeId && mapping.field === field)!.semantic;
async function fixture() { const source = graph(); return prepareRunningHubWorkflowCandidates(source, await withRunningHubWorkflowReader(source, options)).workflow; }

describe("RunningHub original-source setup summary", () => {
  it("counts all source controls instead of applying a role-based subset", async () => {
    const workflow = await fixture();
    expect(runningHubSourceSummary(workflow)?.label).toBe("输入 2 项 · 输出 1 项 · 可调参数 7 项");
    expect(workflow.parameters).toHaveLength(8);
    expect(workflow.template?.save.inputs.filename_prefix).toBe("original");
    expect(workflow.parameters.filter(parameter => parameter.secret)).toHaveLength(1);
  });

  it("keeps explicit checkbox choices separate from complete source counts and source hash", async () => {
    const workflow = await attachRunningHubExecutionContract(await fixture());
    const before = structuredClone(workflow), version = workflow.runninghub!.executionContract!.sourceHash;
    const internal = keyFor(workflow, "generate", "internal_value"), credential = keyFor(workflow, "generate", "provider_api_key");
    const keys = runningHubCanvasParameterKeys(workflow, [internal, internal, "gone", credential]);
    expect(keys).toEqual([internal]);
    for (const selected of [[], keys]) {
      const copy = { ...workflow, runninghub: { ...workflow.runninghub!, canvasParameterKeys: selected } };
      expect(runningHubSourceSummary(copy)).toEqual({ label: "输入 2 项 · 输出 1 项 · 可调参数 7 项", version });
      expect(copy.template).toEqual(before.template);
      expect(copy.parameters).toEqual(before.parameters);
    }
    expect(workflow).toEqual(before);
  });

  it("offers every published technical control by default while excluding credential routes", async () => {
    const workflow = await fixture(), choices = runningHubSelectableParameters(workflow).map(parameter => parameter.key);
    for (const [nodeId, field] of [["generate", "internal_value"], ["model", "unet_name"], ["save", "filename_prefix"], ["save", "save_output"]])
      expect(choices).toContain(keyFor(workflow, nodeId, field));
    expect(choices).not.toContain(keyFor(workflow, "generate", "provider_api_key"));
    expect(runningHubCanvasParameterKeys(workflow)).toEqual(choices);
    expect(runningHubCanvasParameterKeys(workflow, [])).toEqual([]);
  });

  it("retains every app public parameter independently of full-workflow checkbox metadata", async () => {
    const app: RunningHubAiApp = { apiVersion: "v1", outputKind: "image", nodeInfoList: [
      { nodeId: "1", fieldName: "prompt", fieldValue: "sample prompt", fieldType: "STRING" },
      { nodeId: "2", fieldName: "image", fieldValue: "None", fieldType: "IMAGE", required: true },
      { nodeId: "3", fieldName: "seed", fieldValue: 1, fieldType: "INT" },
      { nodeId: "4", fieldName: "custom_contrast", fieldValue: 0.7, fieldType: "FLOAT", required: true },
      { nodeId: "5", fieldName: "api_key", fieldValue: "", fieldType: "PASSWORD", secret: true },
    ] };
    const workflow = prepareRunningHubApp(await withRunningHubAppReader(app), { workflowId: options.workflowId, baseUrl: options.baseUrl, name: options.name }).workflow;
    workflow.runninghub!.canvasParameterKeys = [];
    expect(runningHubSourceSummary(workflow)?.label).toBe("输入 2 项 · 输出 1 项 · 可调参数 2 项");
    expect(runningHubSelectableParameters(workflow).map(parameter => parameter.key)).toEqual([
      keyFor(workflow, "3", "seed"), keyFor(workflow, "4", "custom_contrast"),
    ]);
    expect(workflow.parameters.find(parameter => parameter.key === keyFor(workflow, "4", "custom_contrast"))?.required).toBe(true);
  });

  it("deduplicates identical output bindings and leaves ordinary compute summaries alone", async () => {
    const workflow = await fixture();
    workflow.additionalOutputs = [{ ...workflow.output }, { nodeId: "save", field: "preview", kind: "image" }];
    expect(runningHubSourceSummary(workflow)?.label).toContain("输出 2 项");
    expect(runningHubSourceSummary({ ...workflow, template: undefined })?.label).toBe("尚未读取输入结构");
    expect(runningHubSourceSummary({ ...workflow, runninghub: undefined })).toBeUndefined();
  });
});
