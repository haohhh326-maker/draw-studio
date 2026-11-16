import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ApiWorkflow } from "../src/types";
import { prepareApiWorkflow } from "../src/workflow/import-api";
import { analyzeWorkflowImport, buildWorkflowImport, validateImportGraph } from "../src/workflow/import-analyzer";
import { convertEditorWorkflow, workflowImportInputSchema } from "../src/workflow/import-editor";
import { prepareForServer } from "../src/workflow-adapter/preflight";

// SaveVideo's real object_info contract captured from the connected ComfyUI.
// The legacy inputs below reproduce MiniMax-H3-I2V-Cloud's SaveVideo node 92.
const captured = JSON.parse(readFileSync(new URL("./fixtures/save-video-dynamic.object-info.json", import.meta.url), "utf8"));
const schema = {
  ...captured,
  VideoSource: { input: { required: {} }, output: ["VIDEO"] },
};
function graph(inputs: Record<string, unknown> = { format: "auto", codec: "auto" }): ApiWorkflow {
  return {
    "132": { class_type: "VideoSource", inputs: {} },
    "92": { class_type: "SaveVideo", inputs: { filename_prefix: "DFCIne/H3I2V", video: ["132", 0], ...inputs } },
  };
}

describe("SaveVideo codec schema compatibility", () => {
  it.each(["auto", "h264", "av1"])("imports the saved legacy root codec %s without changing a value or adding guessed inputs", codec => {
    const original = graph({ format: "auto", codec });
    const before = structuredClone(original);
    const result = prepareApiWorkflow(original, schema);
    expect(result.errors).toEqual([]);
    expect(result.repairs).toEqual([]);
    expect(result.graph).toEqual(before);
    expect(original).toEqual(before);
    expect(validateImportGraph(original, schema).errors).toEqual([]);
    expect(prepareForServer(original, "92", schema)).toEqual(before);
    expect(analyzeWorkflowImport(original, schema).errors).toEqual([]);
    expect(buildWorkflowImport(original, { id: "video", name: "Video", family: "MiniMax H3" }, schema).graph).toEqual(before);
    const expanded = workflowImportInputSchema(original["92"], schema.SaveVideo);
    expect(expanded.required).not.toHaveProperty("format.codec");
    expect(expanded.optional).toHaveProperty("codec");
  });

  it.each(["auto", "h264", "av1"])("accepts a current nested codec %s without requiring the hidden legacy selector or optional encoding mode", codec => {
    const original = graph({ format: "mp4", "format.codec": codec });
    const result = prepareApiWorkflow(original, schema);
    expect(result.errors).toEqual([]);
    expect(result.graph).toEqual(original);
    expect(prepareForServer(original, "92", schema)).toEqual(original);
    expect(result.graph["92"].inputs).not.toHaveProperty("codec");
    expect(result.graph["92"].inputs).not.toHaveProperty("format.codec.encoding");
  });

  it("preserves explicit re-encode settings on either supported input layout", () => {
    for (const prefix of ["codec", "format.codec"]) {
      const original = graph({ format: "mp4", [prefix]: "h264", [prefix + ".encoding"]: "re-encode", [prefix + ".encoding.crf"]: 21 });
      expect(prepareApiWorkflow(original, schema)).toMatchObject({ errors: [], repairs: [], graph: original });
    }
  });

  it("retains distinct modern and legacy values so ComfyUI's nested codec precedence is unchanged", () => {
    const original = graph({ format: "auto", "format.codec": "av1", codec: "h264" });
    expect(prepareApiWorkflow(original, schema)).toMatchObject({ errors: [], repairs: [], graph: original });
  });

  it.each([
    { format: "auto" },
    { format: "auto", codec: "unknown" },
    { format: "webm", codec: "h264" },
    { format: "auto", codec: "auto", "format.codec.encoding": "re-encode" },
  ])("does not invent a branch for missing, invalid, incompatible or partial codec data %j", inputs => {
    const original = graph(inputs);
    const result = prepareApiWorkflow(original, schema);
    expect(result.errors.some(error => error.includes("没有唯一分支"))).toBe(true);
    expect(result.graph).toEqual(original);
    expect(result.repairs).toEqual([]);
  });

  it("requires the server's explicit hidden compatibility input and a unique matching branch", () => {
    const noCompatibility = structuredClone(schema);
    delete noCompatibility.SaveVideo.input.optional.codec;
    noCompatibility.SaveVideo.input_order.optional = [];
    expect(prepareApiWorkflow(graph(), noCompatibility).errors.some(error => error.includes("format.codec"))).toBe(true);
    const duplicate = structuredClone(schema);
    const choices = duplicate.SaveVideo.input.optional.codec[1].options;
    choices.push(structuredClone(choices[0]));
    expect(prepareApiWorkflow(graph(), duplicate).errors.some(error => error.includes("没有唯一分支"))).toBe(true);
    expect(prepareApiWorkflow({ ...graph(), "92": { ...graph()["92"], class_type: "OtherSaveVideo" } }, { ...schema, OtherSaveVideo: schema.SaveVideo }).errors.some(error => error.includes("format.codec"))).toBe(true);
  });

  it("rejects orphaned optional dynamic children instead of silently ignoring them", () => {
    const original = graph({ format: "mp4", "format.codec": "h264", "format.codec.encoding.crf": 21 });
    expect(prepareApiWorkflow(original, schema).errors.some(error => error.includes("缺少选择值"))).toBe(true);
    expect(prepareApiWorkflow(original, schema).graph).toEqual(original);
  });

  it.each([
    { filename_prefix: "DFCIne/H3I2V", format: "auto", codec: "auto" },
    { filename_prefix: "DFCIne/H3I2V", format: "mp4", "format.codec": "h264" },
  ])("also converts named editor widgets without mistaking omitted optional selectors for malformed branches", widgets_values => {
    const source = {
      nodes: [
        { id: 132, type: "VideoSource", inputs: [], outputs: [{ type: "VIDEO" }], widgets_values: [] },
        { id: 92, type: "SaveVideo", inputs: [{ name: "video", type: "VIDEO", link: 1 }], outputs: [{ type: "VIDEO" }], widgets_values },
      ],
      links: [[1, 132, 0, 92, 0, "VIDEO"]],
    };
    expect(convertEditorWorkflow(source, schema).graph["92"].inputs).toEqual({ ...widgets_values, video: ["132", 0] });
  });

  it.each(["auto", "h264", "av1"])("maps anonymous editor codec %s using the actual declared order", codec => {
    const source = {
      nodes: [
        { id: 132, type: "VideoSource", inputs: [], outputs: [{ type: "VIDEO" }], widgets_values: [] },
        { id: 92, type: "SaveVideo", inputs: [{ name: "video", type: "VIDEO", link: 1 }], widgets_values: ["DFCIne/H3I2V", "auto", codec] },
      ],
      links: [[1, 132, 0, 92, 0, "VIDEO"]],
    };
    expect(convertEditorWorkflow(source, schema).graph["92"].inputs).toEqual({ filename_prefix: "DFCIne/H3I2V", format: "auto", "format.codec": codec, video: ["132", 0] });
  });
});
