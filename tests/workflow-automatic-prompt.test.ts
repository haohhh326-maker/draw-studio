import { describe, expect, it } from "vitest";
import { prepareWorkflowImport } from "../src/workflow/import-pipeline";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";
import { convertLibraryWorkflow } from "../src/workflow/library-converter";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { workflowSelectionPatch } from "../src/generation/workflow-selection";
import type { ApiWorkflow, CanvasNode } from "../src/types";

const info = {
  TextValue: { input: { required: { value: ["STRING", { multiline: true }] } }, output: ["STRING"] },
  Encode: { input: { required: { text: ["STRING", { forceInput: true }] } }, output: ["CONDITIONING"] },
  Generate: { input: { required: { positive: ["CONDITIONING"], negative: ["CONDITIONING"] } }, output: ["IMAGE"] },
  Merge: { input: { required: { a: ["CONDITIONING"], b: ["CONDITIONING"] } }, output: ["CONDITIONING"] },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
};
const source: ApiWorkflow = {
  a: { class_type: "TextValue", inputs: { value: "author subject" } },
  b: { class_type: "TextValue", inputs: { value: "keep exclusions" } },
  pa: { class_type: "Encode", inputs: { text: ["a", 0] } },
  nb: { class_type: "Encode", inputs: { text: ["b", 0] } },
  make: { class_type: "Generate", inputs: { positive: ["pa", 0], negative: ["nb", 0] } },
  save: { class_type: "SaveImage", inputs: { images: ["make", 0], filename_prefix: "result" } },
};
const prepare = (graph: ApiWorkflow) => prepareWorkflowImport(graph, "automatic_api.json", info, async request => await readAIFisherWorkflow(request) as AifisherWorkflowReadResult);
const origin = { sourcePath: "fixture", folder: "auto", configSha256: "fixture", executionSha256: "fixture", executionStatus: "plain" as const };

describe("automatic canvas prompt adaptation after unchanged AIFISHER parsing", () => {
  it("imports and builds directly from a value field flowing to positive without a manual review", async () => {
    const prepared = await prepare(source);
    expect(prepared.config.prompt).toMatchObject({ binding: { nodeId: "a", path: "inputs.value" } });
    expect(prepared.config.importBindingReview).toBeUndefined();
    const workflow = convertLibraryWorkflow(prepared.config, prepared.graph, prepared.requirements, origin);
    const selected = workflowSelectionPatch({ prompt: "", negativePrompt: "", params: {}, workflowId: "", taskId: null }, workflow);
    expect(selected.generation!.prompt).toBe("");
    selected.generation!.prompt = "user subject";
    const built = buildWorkflow(workflow, { data: selected } as CanvasNode, [], {}, "test");
    expect(built.workflow.a.inputs.value).toBe("user subject");
    expect(built.workflow.b.inputs.value).toBe("keep exclusions");
    expect(prepared.graph).toEqual(source);
  });
  it("preserves two distinct positive texts rather than silently choosing one", async () => {
    const graph = structuredClone(source);
    graph.merge = { class_type: "Merge", inputs: { a: ["pa", 0], b: ["nb", 0] } };
    graph.make.inputs.positive = ["merge", 0];
    delete graph.make.inputs.negative;
    const prepared = await prepare(graph);
    expect(prepared.config.prompt).toBeUndefined();
    expect((prepared.config.parameters as any[]).filter(p => ["a", "b"].includes(p.binding.nodeId))).toHaveLength(2);
    expect(prepared.graph).toEqual(graph);
  });
  it("never overwrites a shared positive/negative source as the main prompt", async () => {
    const graph = structuredClone(source);
    graph.make.inputs.negative = ["pa", 0];
    const prepared = await prepare(graph);
    expect(prepared.config.prompt).toBeUndefined();
    expect(prepared.graph).toEqual(graph);
  });
});
