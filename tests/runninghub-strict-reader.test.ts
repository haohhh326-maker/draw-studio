import { describe, expect, it } from "vitest";
import { readRunningHubWorkflowFixture, withRunningHubAppReader } from "./runninghub-test-reader";
import { analyzeRunningHubImport } from "../src/runninghub/import-analysis";
import { analyzeRunningHubUpstream, type RunningHubReaderResult } from "../src/runninghub/upstream-reader";
import { prepareRunningHubApp, prepareRunningHubWorkflow, prepareRunningHubWorkflowCandidates, runningHubAppGraph } from "../src/runninghub/workflows";
import { runningHubCanvasParameterKeys } from "../src/runninghub/source-summary";

const options = { workflowId: "42", baseUrl: "https://www.runninghub.cn", name: "Original source only", promptKey: "1.prompt" };
const source = () => ({
  "1": { class_type: "Generator", inputs: { prompt: "Author prompt", seed: 7, steps: 12, internal: "Author setting" } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "authored" } },
});
const app = () => ({ apiVersion: "v1" as const, nodeInfoList: [{ nodeId: "1", fieldName: "prompt", fieldType: "STRING", fieldValue: "Author prompt" }] });

describe("RunningHub requires the original reader on every import path", () => {
  it("never substitutes the old graph importer or app graph builder when the reader is absent", () => {
    const graph = source();
    expect(() => prepareRunningHubWorkflowCandidates(graph, options)).toThrow("完整的 AIFISHER 原版读取结果");
    expect(() => prepareRunningHubWorkflow(graph, options)).toThrow("完整的 AIFISHER 原版读取结果");
    expect(() => prepareRunningHubApp(app(), options)).toThrow("完整的 AIFISHER 原版读取结果");
    expect(() => runningHubAppGraph(app())).toThrow("完整的 AIFISHER 原版读取结果");
    expect(() => analyzeRunningHubImport(graph)).toThrow("完整的 AIFISHER 原版读取结果");
  });

  it("rejects missing raw bindings, missing DTOs and incomplete DTO entries", async () => {
    const reader = await readRunningHubWorkflowFixture(source());
    for (const broken of [
      { ...reader, parameterBindings: undefined },
      { ...reader, parameterBindingDto: undefined },
      { ...reader, parameterBindingDto: { ...reader.parameterBindingDto, bindings: reader.parameterBindingDto!.bindings.slice(1) } },
    ]) expect(() => prepareRunningHubWorkflowCandidates(source(), { ...options, reader: broken as unknown as RunningHubReaderResult })).toThrow("AIFISHER");
  });

  it("rejects an app projection that was dropped rather than constructing a replacement", async () => {
    const original = await withRunningHubAppReader(app());
    expect(() => prepareRunningHubApp({ ...original, reader: { ...original.reader!, projection: undefined } }, options)).toThrow("完整的 AIFISHER");
  });

  it("uses only the verified read result and retains every original source binding by default", async () => {
    const graph = source(), before = structuredClone(graph), reader = await readRunningHubWorkflowFixture(graph);
    const { workflow } = prepareRunningHubWorkflow({ malformed: "must never be parsed here" }, { ...options, reader });
    expect(workflow.template).toEqual(before);
    expect(workflow.mapping.map(mapping => mapping.nodeId + "." + mapping.field)).toEqual(expect.arrayContaining(["1.prompt", "1.seed", "1.steps", "1.internal", "2.filename_prefix"]));
    expect(workflow.parameters).toHaveLength(4);
    expect(workflow.runninghub!.sourceBindings).toEqual(reader.parameterBindings);
    expect(workflow.runninghub!.sourceBindingDto).toEqual(reader.parameterBindingDto);
    expect(workflow.runninghub!.sourceBlueprint).toEqual(reader.canvasBlueprint);
    expect(workflow.runninghub!.sourceBindings).not.toBe(reader.parameterBindings);
    expect(graph).toEqual(before);
  });

  it("keeps the original seed policy in the saved source contract", async () => {
    const reader = await readRunningHubWorkflowFixture(source());
    const sourceSeed = reader.parameterBindings!.find(binding => binding.target.fieldName === "seed")!;
    expect(sourceSeed.control.kind).toBe("seed");
    const { workflow } = prepareRunningHubWorkflow(source(), { ...options, reader });
    expect(workflow.runninghub!.sourceBindings!.find(binding => binding.id === sourceSeed.id)).toEqual(sourceSeed);
  });

  it("does not invent output media types from the class name", async () => {
    const reader = await readRunningHubWorkflowFixture(source());
    expect(analyzeRunningHubUpstream(reader).outputs).toMatchObject([{ nodeId: "2", kind: "file", field: "*", needsBinding: true }]);
    const { workflow } = prepareRunningHubWorkflow(source(), { ...options, reader, outputs: [{ nodeId: "2", kind: "video", field: "files" }] });
    expect(workflow.output).toEqual({ nodeId: "2", kind: "video", field: "files" });
  });

  it("migrates explicit parameter selections by concrete target when native source keys change", async () => {
    const reader = await readRunningHubWorkflowFixture(source());
    const next = prepareRunningHubWorkflowCandidates(source(), { ...options, reader }).workflow;
    const seed = next.mapping.find(mapping => mapping.nodeId === "1" && mapping.field === "seed")!.semantic;
    const previous = structuredClone(next);
    previous.parameters = previous.parameters.map(parameter => parameter.key === seed ? { ...parameter, key: "old_seed" } : parameter);
    previous.mapping = previous.mapping.map(mapping => mapping.semantic === seed ? { ...mapping, semantic: "old_seed" } : mapping);
    expect(runningHubCanvasParameterKeys(next, ["old_seed"], previous)).toEqual([seed]);
    expect(runningHubCanvasParameterKeys(next, ["old_seed"])).toEqual([]);
    expect(runningHubCanvasParameterKeys(next)).toEqual(next.parameters.filter(parameter => !parameter.secret && !parameter.inputText).map(parameter => parameter.key));
  });
});
