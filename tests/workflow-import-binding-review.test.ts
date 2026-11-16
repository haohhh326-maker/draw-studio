import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareWorkflowImport } from "../src/workflow/import-pipeline";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";
import { applyImportReview, initialImportReview, importPromptChoices, importReadiness } from "../src/workflow/import-review";
import { convertLibraryWorkflow } from "../src/workflow/library-converter";
import { writeWorkflowLibraryImport, readWorkflowLibraryImportSource } from "../scripts/workflow-library-writer";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { workflowSelectionPatch } from "../src/generation/workflow-selection";
import type { CanvasNode } from "../src/types";

const source = {
  positive: { class_type: "PromptText", inputs: { text: "author positive" } },
  negative: { class_type: "PromptText", inputs: { text: "author negative" } },
  generate: { class_type: "OwnGenerator", inputs: { positive: ["positive", 0], negative: ["negative", 0], api_key: "", seed: 123 } },
  still: { class_type: "SaveImage", inputs: { images: ["generate", 0], filename_prefix: "image" } },
  movie: { class_type: "VHS_VideoCombine", inputs: { images: ["generate", 0], frame_rate: 24, format: "video/h264-mp4", save_output: true } },
};
const info = {
  PromptText: { input: { required: { text: ["STRING", { multiline: true }] } }, output: ["STRING"] },
  OwnGenerator: { input: { required: { positive: ["STRING", { forceInput: true }], negative: ["STRING", { forceInput: true }], api_key: ["STRING"], seed: ["INT"] } }, output: ["IMAGE"] },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
  VHS_VideoCombine: { input: { required: { images: ["IMAGE"], frame_rate: ["FLOAT"], format: [["video/h264-mp4"]], save_output: ["BOOLEAN"] } }, output: [], output_node: true },
};
const origin = { sourcePath: "fixture", folder: "review", configSha256: "test", executionSha256: "test", executionStatus: "plain" as const };
const prepare = () => prepareWorkflowImport(source, "mixed.json", info, async input => await readAIFisherWorkflow(input) as AifisherWorkflowReadResult);

describe("explicit ComfyUI import bindings", () => {
  it("lists both text candidates without exposing secrets or media enums", async () => {
    const prepared = await prepare();
    expect(importPromptChoices(prepared).map(field => field.nodeId)).toEqual(expect.arrayContaining(["positive", "negative"]));
    expect(importPromptChoices(prepared).some(field => field.field === "api_key" || field.field === "format")).toBe(false);
    expect(initialImportReview(prepared).prompt).toEqual({ nodeId: "positive", field: "text", classType: "PromptText" });
  });
  it("uses explicit prompt and main output without modifying graph, other branches or the empty canvas draft", async () => {
    const prepared = await prepare(), before = structuredClone(prepared);
    const review = initialImportReview(prepared);
    review.prompt = { nodeId: "positive", field: "text", classType: "PromptText" };
    review.outputs = review.outputs.sort((a, b) => Number(b.nodeId === "movie") - Number(a.nodeId === "movie"))
      .map(output => ({ ...output, kind: output.nodeId === "movie" ? "video" : "image" }));
    const applied = applyImportReview(prepared, review);
    expect(applied.graph).toEqual(source);
    expect(prepared).toEqual(before);
    const workflow = convertLibraryWorkflow(applied.config, applied.graph, applied.requirements, origin);
    expect(workflow.output).toMatchObject({ nodeId: "movie", kind: "video" });
    const selected = workflowSelectionPatch({ prompt: "", negativePrompt: "", params: {}, workflowId: "", taskId: null }, workflow);
    expect(selected.generation!.prompt).toBe("");
    selected.generation!.prompt = "user text";
    for (const parameter of workflow.parameters.filter(p => p.secret)) selected.generation!.params[parameter.key] = "fixture-only-key";
    const result = buildWorkflow(workflow, { data: selected } as CanvasNode, [], {}, "test");
    expect(result.workflow.positive.inputs.text).toBe("user text");
    expect(result.workflow.negative.inputs.text).toBe("author negative");
    expect(result.workflow.movie.inputs.save_output).toBe(true);
  });
  it("restores the previous main prompt as a parameter when switching or removing the binding", async () => {
    const prepared = await prepare(), first = initialImportReview(prepared);
    first.prompt = { nodeId: "positive", field: "text", classType: "PromptText" };
    const a = applyImportReview(prepared, first), second = initialImportReview(a);
    second.prompt = { nodeId: "negative", field: "text", classType: "PromptText" };
    const b = applyImportReview(a, second), clear = initialImportReview(b); clear.prompt = null;
    const c = applyImportReview(b, clear);
    const parameters = c.config.parameters as any[];
    for (const nodeId of ["positive", "negative"]) expect(parameters.filter(p => p.binding.nodeId === nodeId && p.binding.path === "inputs.text")).toHaveLength(1);
    expect(c.config.prompt).toBeUndefined();
    expect(c.graph).toEqual(source);
  });
  it("rejects stale classes, secret prompt fields, lost outputs and duplicate outputs", async () => {
    const prepared = await prepare(), baseline = initialImportReview(prepared);
    expect(() => applyImportReview(prepared, { ...baseline, prompt: { nodeId: "positive", field: "text", classType: "Changed" } })).toThrow("提示词绑定已失效");
    expect(() => applyImportReview(prepared, { ...baseline, prompt: { nodeId: "generate", field: "api_key", classType: "OwnGenerator" } })).toThrow("提示词绑定已失效");
    expect(() => applyImportReview(prepared, { ...baseline, outputs: baseline.outputs.slice(0, 1) })).toThrow("全部输出");
    expect(() => applyImportReview(prepared, { ...baseline, outputs: [...baseline.outputs, baseline.outputs[0]] })).toThrow("重复");
  });
  it("distinguishes read, binding and execution status even with a live schema", async () => {
    const prepared = await prepare();
    expect(importReadiness(prepared, true)).toMatchObject({ read: "已读取并转换", bindings: "提示词已自动绑定；输出按运行结果识别", execution: expect.stringContaining("尚未验证") });
    const applied = applyImportReview(prepared, initialImportReview(prepared));
    expect(importReadiness(applied, false)).toMatchObject({ bindings: "使用已保存的自定义绑定", execution: expect.stringContaining("未确认") });
  });
  it("persists confirmed bindings and keeps the original file unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-review-"));
    try {
      const prepared = await prepare(), review = initialImportReview(prepared);
      review.prompt = { nodeId: "positive", field: "text", classType: "PromptText" };
      review.outputs[0].kind = "image";
      const applied = applyImportReview(prepared, review);
      const saved = await writeWorkflowLibraryImport(root, applied);
      const restored = await readWorkflowLibraryImportSource(root, saved.workflowId);
      expect(restored.config.importBindingReview).toEqual(review);
      expect(JSON.parse(await readFile(path.join(saved.path, "source.json"), "utf8"))).toEqual(source);
      const reread = await prepare();
      expect(applyImportReview(reread, restored.config.importBindingReview as typeof review).config.prompt).toEqual(applied.config.prompt);
    } finally {
      if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("canvas-review-")) throw new Error("Unsafe fixture cleanup");
      await rm(root, { recursive: true, force: true });
    }
  });
});
