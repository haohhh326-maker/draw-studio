import { describe, expect, it } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { runningHubAppFromRead } from "../src/runninghub/client";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";
import { analyzeRunningHubUpstream, type RunningHubReaderResult } from "../src/runninghub/upstream-reader";
import { prepareRunningHubApp, prepareRunningHubWorkflowCandidates } from "../src/runninghub/workflows";
import { categoryForWorkflow } from "../src/workflow/directory-view";
import { runningHubWorkflowClassification } from "../src/runninghub/workflow-metadata";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import type { CanvasNode } from "../src/types";

// Public detail of the user's misclassified app; no credentials or sample media.
const publicApp = {
  appName: "MiniMax H3_电影质感V2", category: null,
  tags: [{ name: "文生视频", nameEn: "Text-to-Video" }, { name: "图生视频", nameEn: "Image-to-Video" }],
  nodeInfoList: [
    { nodeId: "199", fieldName: "image", fieldType: "IMAGE", fieldValue: "" },
    { nodeId: "188", fieldName: "image", fieldType: "IMAGE", fieldValue: "" },
    { nodeId: "228", fieldName: "aspect_ratio", fieldType: "LIST", fieldValue: "16:9", fieldData: ["16:9", "9:16"] },
    { nodeId: "228", fieldName: "megapixels", fieldType: "FLOAT", fieldValue: 0.7 },
    { nodeId: "227", fieldName: "value", fieldType: "FLOAT", fieldValue: 15 },
    { nodeId: "166", fieldName: "strength_model", fieldType: "FLOAT", fieldValue: 1 },
    { nodeId: "238", fieldName: "value", fieldType: "STRING", fieldValue: "" },
  ],
};

describe("RunningHub unchanged AIFISHER reader adapter", () => {
  it("keeps a Unicode main prompt separate from a dotted non-text field with the same flattened key", async () => {
    const source = {
      "镜头": { class_type: "ImageSource", inputs: { "配置.prompt": 42 } },
      "镜头.配置": { class_type: "PromptText", inputs: { prompt: "原作者提示词" } },
      save: { class_type: "SaveImage", inputs: { images: ["镜头", 0] } },
    };
    const reader = await readAIFisherWorkflow({ environment: "runninghub-workflow", source }) as unknown as RunningHubReaderResult;
    expect(analyzeRunningHubUpstream(reader).prompts).toEqual([
      expect.objectContaining({ nodeId: "镜头.配置", field: "prompt" }),
    ]);
    const { workflow } = prepareRunningHubWorkflowCandidates(source, {
      workflowId: "123", baseUrl: "https://www.runninghub.cn", name: "独立字段", reader,
      promptKey: "镜头.配置.prompt", outputs: [{ nodeId: "save", kind: "image", field: "images" }],
    });
    expect(workflow.mapping.filter(target => target.semantic === "prompt")).toEqual([
      { semantic: "prompt", nodeId: "镜头.配置", field: "prompt" },
    ]);
    const canvas = { data: { generation: { prompt: "用户的提示词", params: {} } } } as CanvasNode;
    const expected = structuredClone(source);
    expected["镜头.配置"].inputs.prompt = "用户的提示词";
    expect(buildWorkflow(workflow, canvas, [], {}).workflow).toEqual(expected);
    expect(workflow.template).toEqual(source);
  });

  it("keeps platform tags but classifies the actual IMAGE-input app only after confirming video output", async () => {
    const read = await readAIFisherWorkflow({ environment: "runninghub-webapp", remoteId: "2092444522851684354", source: publicApp });
    const app = runningHubAppFromRead(read as unknown as AifisherWorkflowReadResult);
    expect(app.rawInfo?.tags).toEqual(publicApp.tags);
    const reader = read as unknown as RunningHubReaderResult;
    expect(reader.category).toBe("video");
    expect(analyzeRunningHubUpstream(reader).inputs).toHaveLength(2);
    const options = { workflowId: "2092444522851684354", baseUrl: "https://www.runninghub.cn", name: publicApp.appName, reader };
    const unconfirmed = prepareRunningHubApp({ ...app, reader }, options).workflow;
    expect(unconfirmed.output).toMatchObject({ nodeId: "fisherai_webapp_output", field: "*", kind: "file" });
    expect(categoryForWorkflow(unconfirmed)).toBe("pending");
    const { workflow } = prepareRunningHubApp({ ...app, reader }, { ...options,
      outputs: [{ nodeId: "fisherai_webapp_output", field: "files", kind: "video" }],
    });
    expect(categoryForWorkflow(workflow)).toBe("video");
    expect(workflow.output.nodeId).toBe("fisherai_webapp_output");
    expect(workflow.template).toEqual(reader.workflow);
    expect(workflow.parameters).toHaveLength(4);
    expect(workflow.importReader?.revision).toBe("bdcf3bec054594fcab591952a8c5acef858d6de4");
  });

  it("keeps unknown original output types pending until the user confirms image and video outputs", async () => {
    const source = { "1": { class_type: "ImageSource", inputs: { value: 1 } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } }, "3": { class_type: "VHS_VideoCombine", inputs: { images: ["1", 0], frame_rate: 24, save_output: false } } };
    const reader = await readAIFisherWorkflow({ environment: "runninghub-workflow", source }) as unknown as RunningHubReaderResult;
    const analysis = analyzeRunningHubUpstream(reader);
    expect(analysis.outputs).toHaveLength(2);
    expect(analysis.outputs).toEqual([
      expect.objectContaining({ nodeId: "2", kind: "file", field: "*", needsBinding: true }),
      expect.objectContaining({ nodeId: "3", kind: "file", field: "*", needsBinding: true }),
    ]);
    const { workflow } = prepareRunningHubWorkflowCandidates(source, { workflowId: "123", baseUrl: "https://www.runninghub.cn", name: "混合输出", reader,
      outputs: [{ nodeId: "2", kind: "image", field: "images" }, { nodeId: "3", kind: "video", field: "gifs" }] });
    expect(workflow.template).toEqual(reader.workflow);
    expect(workflow.importReader?.environment).toBe("runninghub-workflow");
    expect(workflow.additionalOutputs).toHaveLength(1);
    expect(categoryForWorkflow(workflow)).toBe("video");
    expect(runningHubWorkflowClassification(workflow)).toEqual({ family: "视频工具", label: "视频" });
    expect(workflow.template?.["3"].inputs.save_output).toBe(false);
  });

  it.each([
    ["SaveImage", "image", "images", "image", "图像工具", "图像"],
    ["PreviewImage", "image", "images", "image", "图像工具", "图像"],
    ["SaveAudio", "audio", "audio", "music", "音频工具", "音频"],
    ["SaveAudioMP3", "audio", "audio", "music", "音频工具", "音频"],
    ["SaveAudioAdvanced", "audio", "audio", "music", "音频工具", "音频"],
    ["SaveVideo", "video", "images", "video", "视频工具", "视频"],
    ["VHS_VideoCombine", "video", "gifs", "video", "视频工具", "视频"],
  ] as const)("requires an explicit output type for %s instead of deriving it from a class whitelist", async (classType, kind, field, category, family, label) => {
    const source = { "1": { class_type: "SourceData", inputs: {} }, "2": { class_type: classType, _meta: { title: "自定义节点标题" }, inputs: { source: ["1", 0] } } };
    const before = structuredClone(source);
    const reader = await readAIFisherWorkflow({ environment: "runninghub-workflow", source }) as unknown as RunningHubReaderResult;
    const analysis = analyzeRunningHubUpstream(reader);
    expect(analysis.outputs).toEqual([expect.objectContaining({ nodeId: "2", kind: "file", field: "*", needsBinding: true })]);
    const { workflow } = prepareRunningHubWorkflowCandidates(source, { workflowId: "123", baseUrl: "https://www.runninghub.cn", name: "无媒介提示名称", reader, outputs: [{ nodeId: "2", kind, field }] });
    expect(categoryForWorkflow(workflow)).toBe(category);
    expect(runningHubWorkflowClassification(workflow)).toEqual({ family, label });
    expect(workflow.output).toEqual({ nodeId: "2", kind, field });
    expect(workflow.template).toEqual(reader.workflow);
    expect(source).toEqual(before);
  });

  it("leaves unknown custom outputs pending even when their names resemble known video savers", async () => {
    const source = { "1": { class_type: "ImageSource", inputs: { value: "input.png" } },
      "2": { class_type: "CommunitySaveVideoV2", _meta: { title: "SaveVideo MP4 视频导出" }, inputs: { source: ["1", 0] } } };
    const reader = await readAIFisherWorkflow({ environment: "runninghub-workflow", source }) as unknown as RunningHubReaderResult;
    const analysis = analyzeRunningHubUpstream(reader);
    expect(analysis.outputs).toEqual([expect.objectContaining({ nodeId: "2", kind: "file", field: "*", needsBinding: true })]);
    const { workflow } = prepareRunningHubWorkflowCandidates(source, { workflowId: "123", baseUrl: "https://www.runninghub.cn", name: "video.mp4 视频", reader });
    expect(categoryForWorkflow(workflow)).toBe("pending");
    expect(runningHubWorkflowClassification(workflow)).toEqual({ family: "待确认输出", label: "待确认" });
    expect(workflow.template).toEqual(reader.workflow);
  });

  it("does not let a preview image hide a completed audio output", async () => {
    const source = { "1": { class_type: "SourceData", inputs: {} },
      "2": { class_type: "PreviewImage", inputs: { images: ["1", 0] } },
      "3": { class_type: "SaveAudio", inputs: { audio: ["1", 0] } } };
    const reader = await readAIFisherWorkflow({ environment: "runninghub-workflow", source }) as unknown as RunningHubReaderResult;
    const { workflow } = prepareRunningHubWorkflowCandidates(source, { workflowId: "123", baseUrl: "https://www.runninghub.cn", name: "无媒介提示名称", reader,
      outputs: [{ nodeId: "3", field: "audio", kind: "audio" }] });
    expect(workflow.output).toMatchObject({ nodeId: "3", kind: "audio" });
    expect(workflow.additionalOutputs).toBeUndefined();
    expect(reader.analysis.candidateOutputs?.map(output => output.nodeId)).toEqual(["2", "3"]);
    expect(categoryForWorkflow(workflow)).toBe("music");
    expect(runningHubWorkflowClassification(workflow)).toEqual({ family: "音频工具", label: "音频" });
    expect(workflow.template).toEqual(reader.workflow);
  });

  it("does not apply the RunningHub class-contract adapter to the ComfyUI reader environment", async () => {
    const source = { "1": { class_type: "PreviewImage", inputs: {} } };
    const reader = await readAIFisherWorkflow({ environment: "comfyui", source }) as unknown as RunningHubReaderResult;
    expect(() => analyzeRunningHubUpstream(reader)).toThrow("AIFISHER 原版读取结果");
  });

  it("retains structured internal settings in the complete API graph without forcing them into text controls", async () => {
    const source = {
      "1": { class_type: "ImageGenerator", inputs: { prompt: "[sanitized source prompt]", iterations: 6,
        settings: { strength: 0.35, enabled: true, sampler: { stages: [1, 2, 3] } }, schedule: [0.1, 0.2, 0.3] } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
    };
    const before = structuredClone(source);
    const reader = await readAIFisherWorkflow({ environment: "runninghub-workflow", source }) as unknown as RunningHubReaderResult;
    const { workflow, warnings } = prepareRunningHubWorkflowCandidates(source, { workflowId: "123", baseUrl: "https://www.runninghub.cn", name: "structured internal settings", reader });
    expect(workflow.template).toEqual(before);
    expect(workflow.mapping.some(mapping => mapping.nodeId === "1" && ["settings", "schedule"].includes(mapping.field))).toBe(false);
    expect(workflow.parameters.some(parameter => parameter.label.includes("settings") || parameter.label.includes("schedule"))).toBe(false);
    expect(warnings.some(warning => /settings|schedule|结构化|JSON/.test(warning))).toBe(true);
    const iterations = workflow.mapping.find(mapping => mapping.nodeId === "1" && mapping.field === "iterations")!;
    expect(iterations).toBeDefined();
    const node = { data: { generation: { prompt: "[user prompt]", negativePrompt: "", workflowId: workflow.id,
      params: { [iterations.semantic]: 8 }, taskId: null } } } as CanvasNode;
    const built = buildWorkflow(workflow, node, [], {});
    expect(built.workflow["1"].inputs.settings).toEqual(source["1"].inputs.settings);
    expect(built.workflow["1"].inputs.schedule).toEqual(source["1"].inputs.schedule);
    expect(built.workflow["1"].inputs.iterations).toBe(8);
    expect(built.workflow["1"].inputs.prompt).toBe("[user prompt]");
    expect(source).toEqual(before);
    expect(workflow.template).toEqual(before);
  });

  it("retains the original wire schema for upstream while stripping credential examples", async () => {
    const rawInfo = { appName: "视频", tags: ["视频"], nodeInfoList: [
      { nodeId: "1", fieldName: "steps", fieldType: "INT", fieldValue: "12" },
      { nodeId: "2", fieldName: "api_key", fieldType: "STRING", fieldValue: "credential-example", description: "API Key credential-example" },
    ] };
    const read = await readAIFisherWorkflow({ environment: "runninghub-webapp", remoteId: "12", source: rawInfo });
    const app = runningHubAppFromRead(read as unknown as AifisherWorkflowReadResult);
    expect((app.rawInfo?.nodeInfoList as Record<string, unknown>[])[0].fieldValue).toBe("12");
    expect(JSON.stringify(app.rawInfo)).not.toContain("credential-example");
    const reader = read as unknown as RunningHubReaderResult;
    const { workflow } = prepareRunningHubApp({ ...app, reader }, { workflowId: "12", baseUrl: "https://www.runninghub.cn", name: "视频", reader });
    expect(workflow.parameters.find(parameter => parameter.secret)?.default).toBe("");
    expect(JSON.stringify(workflow)).not.toContain("credential-example");
  });
});
