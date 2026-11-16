import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AIFISHER_READER_SOURCE, readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { createRunningHubWebAppProjection } from "../vendor/aifisher/server/workflowRuntime/runningHubWebApp.js";
import { analyzeWorkflow, normalizeApiWorkflow } from "../vendor/aifisher/server/workflowRuntime/workflowFormat.js";
import { deriveBindingSetBindings, toBindingSetDto } from "../vendor/aifisher/server/workflowRuntime/workflowBindingCompiler.js";
import { createPortableWorkflowProjection } from "../vendor/aifisher/server/workflowRuntime/workflowDeploymentService.js";

const projectRoot = process.cwd();
const upstreamRoot = path.join(projectRoot, "vendor/aifisher");
const graph = {
  "1": { class_type: "LoadImage", inputs: { image: "reference.png" } },
  "2": { class_type: "VHS_VideoCombine", inputs: { images: ["1", 0], frame_rate: 24, format: "video/h264-mp4", save_output: true } },
  "3": { class_type: "PreviewImage", inputs: { images: ["1", 0] } },
};
const objectInfo = {
  LoadImage: { input: { required: { image: [["reference.png"], { image_upload: true }] } }, output: ["IMAGE"], output_name: ["IMAGE"] },
  VHS_VideoCombine: { input: { required: { images: ["IMAGE", { forceInput: true }], frame_rate: ["FLOAT", { min: 1, max: 120 }], format: [["video/h264-mp4", "image/gif"]], save_output: ["BOOLEAN"] } }, output: [], output_node: true },
  PreviewImage: { input: { required: { images: ["IMAGE", { forceInput: true }] } }, output: [], output_node: true },
};

describe("unchanged AIFISHER workflow readers", () => {
  it("retains every vendored upstream byte at the pinned revision", async () => {
    const manifest = JSON.parse(await readFile(path.join(upstreamRoot, "SOURCE.json"), "utf8"));
    expect(manifest.revision).toBe(AIFISHER_READER_SOURCE.revision);
    expect(manifest.license).toBe("AIFISHER Noncommercial Source License 1.0");
    for (const entry of manifest.files) {
      const bytes = await readFile(path.join(upstreamRoot, entry.path));
      expect(bytes.length, entry.path).toBe(entry.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), entry.path).toBe(entry.sha256);
    }
  });

  it("imports complete upstream services without extracting or rebuilding source declarations", async () => {
    const host = await readFile(path.join(projectRoot, "scripts/aifisher-runninghub-import.ts"), "utf8");
    const reader = await readFile(path.join(projectRoot, "scripts/aifisher-workflow-reader.ts"), "utf8");
    expect(host).toContain("new RunningHubWebAppLibraryService(");
    expect(host).toContain("new WorkflowDeploymentService(");
    expect(host).toContain("new WorkflowCanvasNodeService(");
    expect(host + reader).not.toMatch(/portableProjectionSource|data:text\/javascript|new Function/);
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", source: graph });
    expect(result.nodeDefinitions).toEqual(createPortableWorkflowProjection(result.workflow!));
    expect(result.canvasBlueprint?.parameterSchema).toBeDefined();
  });

  it("uses ComfyUI object_info and exactly the upstream API analysis without rewriting input values", async () => {
    const original = structuredClone(graph);
    const result = await readAIFisherWorkflow({ environment: "comfyui", source: graph, objectInfo });
    expect(result.workflow).toEqual(normalizeApiWorkflow(graph));
    expect(result.analysis).toEqual(analyzeWorkflow(graph, "comfy-api", { objectInfo }));
    expect(result.bindingCandidates.find(field => field.fieldName === "image")).toMatchObject({ control: "asset", mediaKind: "image" });
    expect(result.bindingCandidates.find(field => field.fieldName === "format")).toMatchObject({ control: "select", options: ["video/h264-mp4", "image/gif"] });
    expect(result.category).toBeUndefined();
    expect(result.parameterBindings).toBeUndefined();
    expect(result.parameterBindingDto).toBeUndefined();
    expect(result.outputEvidence.state).toBe("declared");
    expect(result.outputEvidence.outputs).toEqual([]);
    expect(graph).toEqual(original);
  });

  it("does not guess a local UI widget map when runtime capabilities are unavailable", async () => {
    const ui = { version: 0.4, nodes: [{ id: 1, type: "LoadImage", pos: [0, 0], widgets_values: ["reference.png"] }], links: [] };
    const without = await readAIFisherWorkflow({ environment: "comfyui", source: ui });
    expect(without.workflow).toBeNull();
    expect(without.analysis.compileStatus).toBe("needs-runtime-capabilities");
    const withRuntime = await readAIFisherWorkflow({ environment: "comfyui", source: ui, objectInfo });
    expect(withRuntime.workflow).toBeNull();
    expect(withRuntime.analysis.compileStatus).toBe("needs-confirmation");
    expect(withRuntime.analysis.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "POSITIONAL_WIDGET_MAPPING_REQUIRES_CONFIRMATION" })]));
  });

  it("classifies a saved video by the actual completed output file and ignores temporary image previews", async () => {
    const result = await readAIFisherWorkflow({ environment: "comfyui", source: graph, objectInfo, promptId: "p1", history: {
      p1: { status: { status_str: "success", completed: true }, outputs: {
        "2": { images: [{ filename: "movie.mp4", subfolder: "", type: "output" }], animated: true },
        "3": { images: [{ filename: "preview.png", subfolder: "", type: "temp" }] },
      } },
    } });
    expect(result.outputEvidence.state).toBe("verified");
    expect(result.outputEvidence.outputs).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "2", outputKey: "images", mediaKind: "video", kind: "file" })]));
    expect(result.outputEvidence.outputs.some(output => output.nodeId === "3")).toBe(false);
  });

  it("keeps RunningHub workflow fields and links as the upstream portable schema declares them", async () => {
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", source: graph }, { projectRoot });
    expect(result.workflow).toEqual(normalizeApiWorkflow(graph));
    expect(result.nodeDefinitions.VHS_VideoCombine.input.optional.images).toEqual(["ANY", { forceInput: true }]);
    expect(result.nodeDefinitions.LoadImage.output).toEqual(["ANY"]);
    expect(result.category).toBeUndefined();
    expect(result.bindingCandidates.some(field => field.fieldName === "images")).toBe(false);
    expect(result.bindingCandidates.find(field => field.fieldName === "frame_rate")?.value).toBe(24);
  });

  it("uses RunningHub public app projection and category even when its input is an image", async () => {
    const source = { appName: "Image to Video", categoryName: "视频", nodeInfoList: [{ nodeId: "1", fieldName: "image", fieldType: "IMAGE", fieldValue: "" }, { nodeId: "2", fieldName: "prompt", fieldType: "STRING", fieldValue: "animate" }] };
    const expected = createRunningHubWebAppProjection("2092444522851684354", source);
    const result = await readAIFisherWorkflow({ environment: "runninghub-webapp", source, remoteId: "2092444522851684354" });
    expect(result.projection).toEqual(expected);
    expect(result.workflow).toEqual(expected.executionPlan);
    expect(result.category).toBe("video");
    expect(result.bindingCandidates.find(field => field.fieldName === "image")?.mediaKind).toBe("image");
  });

  it("returns exactly upstream RunningHub binding controls, typed options, seed policies and presentation", async () => {
    const source = { appName: "Video controls", nodeInfoList: [
      { nodeId: "1", fieldName: "image", fieldType: "IMAGE", fieldValue: "", required: true, label: "参考图", description: "参考输入" },
      { nodeId: "2", fieldName: "choice", fieldType: "LIST", fieldValue: 1, options: [1, "1", true], label: "选项" },
      { nodeId: "3", fieldName: "seed", fieldType: "INT", fieldValue: 8, min: 0, max: 1000, step: 2, description: "种子" },
      { nodeId: "4", fieldName: "strength", fieldType: "FLOAT", fieldValue: 0.75, min: 0, max: 2, step: 0.25, label: "强度", description: "精确步长" },
      { nodeId: "5", fieldName: "value", fieldType: "STRING", fieldValue: "完整文本", description: "提示词" },
    ] };
    const before = structuredClone(source);
    const result = await readAIFisherWorkflow({ environment: "runninghub-webapp", source, remoteId: "321" });
    const fields = new Map<string, Record<string, any>>(result.projection!.snapshot.fields.map((field: Record<string, any>) => [JSON.stringify([field.nodeId, field.fieldName]), field]));
    const expected = deriveBindingSetBindings({ executionPlan: result.workflow, nodeDefinitions: result.nodeDefinitions, selections: result.bindingCandidates.map(candidate => {
      const field = fields.get(JSON.stringify([candidate.nodeId, candidate.fieldName]))!;
      return { candidateId: candidate.id, key: `field_${candidate.nodeId}_${candidate.fieldName}`, label: field.label, description: field.description, section: candidate.mediaKind ? "输入素材" : "生成参数" };
    }) });
    const withoutIds = (bindings: Record<string, any>[]) => bindings.map(({ id: _id, ...binding }) => binding);
    expect(withoutIds(result.parameterBindings!)).toEqual(withoutIds(expected));
    expect(result.parameterBindingDto!.bindings).toEqual(toBindingSetDto({ bindings: result.parameterBindings }).bindings);
    expect(result.parameterBindings!.find(binding => binding.target.fieldName === "image")).toMatchObject({ label: "参考图", description: "参考输入", control: { kind: "asset", required: true }, presentation: { section: "输入素材", order: 0 } });
    // Keep upstream behavior exactly: its snapshot uses minimum/maximum while
    // specification reads min/max, so those controls advertise null bounds.
    expect(fields.get(JSON.stringify(["3", "seed"]))).toMatchObject({ minimum: 0, maximum: 1000, step: 2 });
    expect(result.parameterBindings!.find(binding => binding.target.fieldName === "seed")).toMatchObject({ control: { kind: "seed", minimum: null, maximum: null, step: 2, defaultValue: { mode: "fixed", value: 8 } }, target: { expectedValueType: "INT" } });
    expect(result.parameterBindings!.find(binding => binding.target.fieldName === "strength")).toMatchObject({ label: "强度", description: "精确步长", control: { kind: "number", minimum: null, maximum: null, step: 0.25, defaultValue: 0.75 } });
    const rawChoice = result.parameterBindings!.find(binding => binding.target.fieldName === "choice")!;
    const publicChoice = result.parameterBindingDto!.bindings.find((binding: Record<string, any>) => binding.key === rawChoice.key);
    expect(rawChoice.control.options).toEqual([1, "1", true]);
    expect(publicChoice.control.options.map((option: Record<string, any>) => option.label)).toEqual(["1", "1", "true"]);
    expect(new Set(publicChoice.control.options.map((option: Record<string, any>) => option.id)).size).toBe(3);
    expect(publicChoice.control.defaultValue).toBe(publicChoice.control.options[0].id);
    expect(source).toEqual(before);
  });

  it("keeps the original binding-set limit explicit instead of omitting or privately batching fields", async () => {
    const inputs = Object.fromEntries(Array.from({ length: 300 }, (_, index) => ["value_" + String(index).padStart(3, "0"), index]));
    await expect(readAIFisherWorkflow({ environment: "runninghub-workflow", source: { "1": { class_type: "SaveVideo", inputs } } })).rejects.toMatchObject({ code: "BINDING_SET_SIZE_LIMIT" });
    expect(Object.keys(inputs)).toHaveLength(300);
  });

  it("uses the original compiler default keys for native workflow selections", async () => {
    const longField = "long".repeat(20);
    const source = {
      a: { class_type: "SaveVideo", inputs: { seed: 1, b_c: 2, [longField]: 3, "字段": 4 } },
      a_b: { class_type: "SaveVideo", inputs: { c: 5 } },
    };
    const first = await readAIFisherWorkflow({ environment: "runninghub-workflow", source });
    const again = await readAIFisherWorkflow({ environment: "runninghub-workflow", source });
    const keys = first.parameterBindings!.map(binding => binding.key);
    expect(keys).toEqual(["input_1", "input_2", "input_3", "input_4", "input_5"]);
    expect(keys).toEqual(again.parameterBindings!.map(binding => binding.key));
    expect(keys.every(key => /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(key))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("retains structured native source defaults instead of omitting non-scalar bindings", async () => {
    const config = { enabled: true, nested: { iterations: 4 } }, presets = [1, 2, 3];
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", source: { "1": { class_type: "SaveVideo", inputs: { config, presets } } } });
    expect(result.parameterBindings).toHaveLength(2);
    expect(result.parameterBindings!.find(binding => binding.target.fieldName === "config")!.control.defaultValue).toEqual(config);
    expect(result.parameterBindings!.find(binding => binding.target.fieldName === "presets")!.control.defaultValue).toEqual(presets);
    expect(result.parameterBindingDto!.bindings).toHaveLength(2);
  });

  it("does not silently repair unsupported artifacts or treat failed history as successful output", async () => {
    await expect(readAIFisherWorkflow({ environment: "runninghub-workflow", source: { version: 0.4, nodes: [], links: [] } })).rejects.toMatchObject({ code: "AIFISHER_RUNNINGHUB_API_REQUIRED" });
    await expect(readAIFisherWorkflow({ environment: "comfyui", source: graph, history: { p: { status: { completed: false, status_str: "error" }, outputs: {} } }, promptId: "p" })).rejects.toMatchObject({ code: "COMFYUI_EXECUTION_FAILED" });
  });
});
