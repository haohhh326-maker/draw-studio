import { describe, expect, it } from "vitest";
import { prepareForServer } from "../src/workflow-adapter/preflight";
import { buildWorkflowImport } from "../src/workflow/import-analyzer";
import { convertLibraryWorkflow } from "../src/workflow/library-converter";
import { buildWorkflow } from "../src/workflow-adapter/adapter";

describe("imported workflow generation checks", () => {
  it("preflights the ancestor union of two custom outputs and ignores unrelated branches", () => {
    const graph = {
      shared: { class_type: "CustomProducer", inputs: { seed: 123 } },
      image: { class_type: "CustomImageSaver", inputs: { value: ["shared", 0] } },
      audio: { class_type: "CustomAudioSaver", inputs: { value: ["shared", 1] } },
      unused: { class_type: "MissingPlugin", inputs: {} },
    };
    const info = { CustomProducer: { input: { required: { seed: ["INT"] } }, output: ["IMAGE", "AUDIO"] }, CustomImageSaver: { input: { required: { value: ["IMAGE"] } }, output_node: true }, CustomAudioSaver: { input: { required: { value: ["AUDIO"] } }, output_node: true } };
    expect(Object.keys(prepareForServer(graph, ["image", "audio"], info))).toEqual(["shared", "image", "audio"]);
    expect(() => prepareForServer(graph, ["image", "missing"], info)).toThrow("连接不存在");
    expect(() => prepareForServer(graph, [], info)).toThrow("输出节点");
    const incomplete = { ...graph, audio: { ...graph.audio, inputs: {} } };
    expect(() => prepareForServer(incomplete, ["image", "audio"], info)).toThrow("缺少必填输入");
  });
  it("preserves numeric and boolean enums from import through execution", () => {
    const graph = { "1": { class_type: "ExampleImage", inputs: { quality: 2, enabled: true } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } } };
    const info = { ExampleImage: { input: { required: { quality: [[1, 2, 3]], enabled: [[true, false]] } }, output: ["IMAGE"] }, SaveImage: { input: { required: { images: ["IMAGE"] } } } };
    const built = buildWorkflowImport(graph, { id: "custom.example", name: "Example", family: "Custom" }, info);
    const definition = convertLibraryWorkflow(built.config, built.graph, built.requirements, { sourcePath: "test", folder: "test", configSha256: "", executionSha256: "", executionStatus: "plain" });
    const node = { id: "test", position: { x: 0, y: 0 }, data: { kind: "image-generation" as const, title: "Test", generation: { prompt: "", negativePrompt: "", workflowId: definition.id, params: { quality: 3, enabled: false }, taskId: null } } };
    const execution = buildWorkflow(definition, node, [], {});
    expect(execution.workflow["1"].inputs).toEqual({ quality: 3, enabled: false });
    expect(() => buildWorkflow(definition, { ...node, data: { ...node.data, generation: { ...node.data.generation, params: { quality: "3", enabled: false } } } }, [], {})).toThrow("参数选项无效");
  });
  it("rejects missing required inputs before uploads or prompt submission", () => {
    const graph = { "1": { class_type: "ExampleTransform", inputs: {} }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } } };
    const info = { ExampleTransform: { input: { required: { image: ["IMAGE"] } }, output: ["IMAGE"] }, SaveImage: { input: { required: { images: ["IMAGE"] } } } };
    expect(() => prepareForServer(graph, "2", info)).toThrow("缺少必填输入");
  });
  it("checks only the selected branch and accepts a complete graph", () => {
    const graph = { "1": { class_type: "LoadImage", inputs: { image: "task/reference.png" } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } }, ignored: { class_type: "MissingPlugin", inputs: {} } };
    const info = { LoadImage: { input: { required: { image: ["STRING"] } }, output: ["IMAGE", "MASK"] }, SaveImage: { input: { required: { images: ["IMAGE"] } } } };
    const prepared = prepareForServer(graph, "2", info);
    expect(Object.keys(prepared)).toEqual(["1", "2"]);
    expect(graph.ignored).toBeDefined();
  });
});
