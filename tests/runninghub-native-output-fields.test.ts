import { describe, expect, it } from "vitest";
import { normalizeNativeRunningHubOutputFields } from "../src/runninghub/native-output-fields";
import { collectWorkflowOutputs, type History } from "../src/comfyui/client";
import { outputKey } from "../src/comfyui/files";
import { catalog } from "../src/workflow/catalog";
import type { WorkflowDefinition } from "../src/types";

const workflow = (): WorkflowDefinition => ({ ...catalog[0], output: { nodeId: "4", field: "gifs", kind: "video" },
  template: { "4": { class_type: "VHS_VideoCombine", inputs: { filename_prefix: "original" } } }, additionalOutputs: [] });
const video = { filename: "result.mp4", subfolder: "infinite-canvas/task", type: "output" as const };

describe("native RunningHub result field compatibility", () => {
  it("recovers the real RH images/mp4 receipt for a saved VHS gifs mapping without modifying it", () => {
    const definition = workflow(), saved = structuredClone(definition);
    const history: History = { status: { status_str: "success" }, outputs: { "4": { images: [{ ...video, bucket: "result", storageProvider: "tos", objectKey: "result-key" }] } } };
    const before = structuredClone(history), normalized = normalizeNativeRunningHubOutputFields(history, definition);
    const result = collectWorkflowOutputs(normalized, definition);
    expect(result.files).toEqual([video]);
    expect(result.fileKinds[outputKey(video)]).toBe("video");
    expect(normalized.status).toBe(history.status);
    expect(history).toEqual(before); expect(definition).toEqual(saved);
  });

  it.each(["videos", "video", "clips"])("accepts a unique same-node %s descriptor", field => {
    const history = { outputs: { "4": { [field]: video } } };
    expect(collectWorkflowOutputs(normalizeNativeRunningHubOutputFields(history, workflow()), workflow()).files).toEqual([video]);
  });

  it("preserves an already valid explicit field even when another video is present", () => {
    const history = { outputs: { "4": { gifs: [video], images: [{ ...video, filename: "other.mp4" }] } } };
    expect(normalizeNativeRunningHubOutputFields(history, workflow())).toBe(history);
    expect(collectWorkflowOutputs(history, workflow()).files).toEqual([video]);
  });

  it("can recover an empty mapped field but does not hide a present invalid field", () => {
    const empty = { outputs: { "4": { gifs: [], images: [video] } } };
    expect(collectWorkflowOutputs(normalizeNativeRunningHubOutputFields(empty, workflow()), workflow()).files).toEqual([video]);
    const malformed = { outputs: { "4": { gifs: { wrong: true }, images: [video] } } };
    expect(normalizeNativeRunningHubOutputFields(malformed, workflow())).toBe(malformed);
    expect(() => collectWorkflowOutputs(malformed, workflow())).toThrow("4.gifs");
  });

  it.each([
    { "9": { images: [video] } },
    { "4": { images: [{ ...video, filename: "poster.png" }] } },
    { "4": { images: [video, { ...video, filename: "poster.png" }] } },
    { "4": { unknown_results: [video] } },
  ])("does not borrow another node, a thumbnail, mixed media, or an unknown custom field", outputs => {
    const history = { outputs };
    expect(normalizeNativeRunningHubOutputFields(history, workflow())).toBe(history);
    expect(() => collectWorkflowOutputs(history, workflow())).toThrow("4.gifs");
  });

  it("does not guess between two valid alternate video fields", () => {
    const history = { outputs: { "4": { images: [video], videos: [{ ...video, filename: "other.mp4" }] } } };
    expect(() => normalizeNativeRunningHubOutputFields(history, workflow())).toThrow("多个候选视频字段");
  });

  it("does not borrow a field explicitly mapped to another output", () => {
    const definition = workflow(); definition.additionalOutputs = [{ nodeId: "4", field: "videos", kind: "video" }];
    const history = { outputs: { "4": { videos: [video] } } };
    expect(normalizeNativeRunningHubOutputFields(history, definition)).toBe(history);
    expect(() => collectWorkflowOutputs(history, definition)).toThrow("4.gifs");
  });

  it("does not satisfy two missing mapped outputs with the same alternate field", () => {
    const definition = workflow(); definition.additionalOutputs = [{ nodeId: "4", field: "videos", kind: "video" }];
    const history = { outputs: { "4": { images: [video] } } };
    expect(() => normalizeNativeRunningHubOutputFields(history, definition)).toThrow("多个输出映射对应同一视频字段");
  });

  it.each(["image", "text", "audio"] as const)("does not change %s mappings", kind => {
    const definition = workflow(); definition.output.kind = kind;
    const history = { outputs: { "4": { images: [video] } } };
    expect(normalizeNativeRunningHubOutputFields(history, definition)).toBe(history);
  });

  it.each([
    { ...video, filename: "../private.mp4" },
    { ...video, filename: "https://foreign.example/private.mp4" },
    { ...video, subfolder: "../private" },
    { ...video, type: "input" },
  ])("retains standard descriptor path and type validation", file => {
    const history = { outputs: { "4": { images: [file] } } };
    expect(() => normalizeNativeRunningHubOutputFields(history, workflow())).toThrow();
  });
});
