import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../src/types";
import { availableSeriesId, buildDirectoryView, categoryForWorkflow, filterDirectoryWorkflows, workflowExecutionStatus, workflowSeriesId, workflowSeriesName } from "../src/workflow/directory-view";

function workflow(id: string, name: string, family: string, kind: "image" | "audio" | "video" | "text" | "file", directory?: WorkflowDefinition["directory"]): WorkflowDefinition {
  return { id, name, family, directory, description: "", mode: "text-to-image", requiredInputs: [], optionalInputs: [], parameters: [], mapping: [], output: { kind, nodeId: "out", field: "images" } };
}

describe("workflow directory views", () => {
  it("keeps an app with no typed output pending despite upstream video metadata", () => {
    const entry = workflow("runninghub-video", "MiniMax H3_电影质感V2", "图像工具", "file");
    entry.output.field = "*";
    entry.runninghub = { workflowId: "2092444522851684354", baseUrl: "https://www.runninghub.cn", kind: "app", platformCategory: "video" };
    entry.directory = { version: 2, canvas: "image", seriesId: "old", bindingKey: "old", bindingStatus: "bound" };
    const before = structuredClone(entry);
    expect(categoryForWorkflow(entry)).toBe("pending");
    expect(workflowSeriesName(entry)).toBe("待确认输出");
    expect(buildDirectoryView([entry]).find(canvas => canvas.id === "pending")).toEqual(expect.objectContaining({ name: "待确认输出", workflows: [entry] }));
    expect(entry).toEqual(before);
  });

  it("does not let a preview image hide another declared video output", () => {
    const entry = workflow("mixed", "mixed outputs", "通用工具", "image");
    entry.additionalOutputs = [{ nodeId: "video", field: "gifs", kind: "video" }];
    expect(categoryForWorkflow(entry)).toBe("video");
  });

  it("counts discovered series and workflows, including video tools and entries without directory metadata", () => {
    const entries = [
      workflow("song", "我的音乐", "音乐工具", "audio"),
      workflow("image", "图像编辑", "图像工具", "image"),
      workflow("video", "视频生成", "视频工具", "video"),
      workflow("deep", "视频转深度", "视频转换", "video", { version: 2, canvas: "video", seriesId: "video-convert", bindingKey: "deep", bindingStatus: "bound" }),
    ];
    const views = buildDirectoryView(entries);
    expect(views.map((canvas) => [canvas.id, canvas.workflows.length, canvas.series.length])).toEqual([["music", 1, 1], ["image", 1, 1], ["video", 2, 2], ["text", 0, 0]]);
    expect(views.flatMap((canvas) => canvas.workflows)).toHaveLength(entries.length);
    expect(views[2].series.map((series) => series.name)).toEqual(["视频工具", "视频转换"]);
    expect(filterDirectoryWorkflows(views[2], "", "深度").map((item) => item.id)).toEqual(["deep"]);
  });

  it("keeps category metadata authoritative and groups matching families in input order", () => {
    const image = workflow("one", "编辑 1", "My Model", "image");
    const second = workflow("two", "编辑 2", "My Model", "image");
    const assigned = workflow("three", "辅助音频", "My Model", "audio", { version: 2, canvas: "image", seriesId: "model", bindingKey: "audio", bindingStatus: "bound" });
    expect(categoryForWorkflow(assigned)).toBe("image");
    const canvas = buildDirectoryView([image, second, assigned])[1];
    expect(canvas.series.map((series) => series.workflows)).toEqual([3]);
    expect(filterDirectoryWorkflows(canvas, workflowSeriesId(image), "MODEL").map((item) => item.id)).toEqual(["one", "two", "three"]);
  });

  it("merges bundled and imported categories across every media canvas without changing workflow data", () => {
    const entries = [
      ["Qwen 图像", "image", "image"],
      ["Klein 系列", "image", "image"],
      ["Krea2", "image", "image"],
      ["Zimage", "image", "image"],
      ["MiniMax Music", "audio", "music"],
      ["VoxCPM", "audio", "music"],
      ["LTX2.3", "video", "video"],
      ["视频生成", "video", "video"],
      ["文本工具", "text", "text"],
      ["手工分类", "image", "image"],
    ] as const;
    for (const [family, kind, canvasId] of entries) {
      const original = workflow("bundled-" + family, "原有工作流", family, kind, { version: 2, canvas: canvasId, seriesId: "bundled", bindingKey: "original", bindingStatus: "bound" });
      const imported = workflow("custom-" + family, "添加工作流", family, kind, { version: 2, canvas: canvasId, seriesId: "imported-model", bindingKey: "custom", bindingStatus: "bound" });
      const before = JSON.stringify([original, imported]);
      const canvas = buildDirectoryView([original, imported]).find(item => item.id === canvasId)!;
      expect(canvas.series).toEqual([{ id: workflowSeriesId(original), name: family, workflows: 2 }]);
      expect(workflowSeriesId(imported)).toBe(workflowSeriesId(original));
      const filtered = filterDirectoryWorkflows(canvas, workflowSeriesId(imported), "");
      expect(filtered[0]).toBe(original);
      expect(filtered[1]).toBe(imported);
      expect(JSON.stringify([original, imported])).toBe(before);
    }
  });

  it("normalizes casing, spacing and full-width names while retaining a stable known label", () => {
    const qwen = ["Qwen 图像", "qwen图像", " QWEN  图像 ", "Ｑｗｅｎ　图像", "Qwen Image"]
      .map((family, index) => workflow("qwen-" + index, "编辑 " + index, family, "image"));
    const zimage = ["Zimage", "z Image"].map((family, index) => workflow("zimage-" + index, "文生图", family, "image"));
    const canvas = buildDirectoryView([...qwen, ...zimage])[1];
    expect(canvas.series.map(item => [item.name, item.workflows])).toEqual([["Qwen 图像", 5], ["Zimage", 2]]);
    expect(filterDirectoryWorkflows(canvas, workflowSeriesId(qwen[0]), "图像")).toEqual(qwen);
    expect(workflowSeriesName(qwen[3])).toBe("Qwen 图像");
  });

  it("keeps model variants, versions and meaningful manual categories separate", () => {
    const families = ["MiniMax H3 标准", "minimax h3 标准", "MiniMax H3 加速", "MiniMaxH3极速", "LTX2.3", "LTX 2.5", "My Model", " my  model ", "MyModel", "My Model V2", "Qwen 图像 / 人像", "Qwen 图像 / 风景"];
    const entries = families.map((family, index) => workflow("entry-" + index, "工作流", family, "video"));
    const canvas = buildDirectoryView(entries)[2];
    expect(canvas.series.map(item => [item.name, item.workflows])).toEqual([
      ["MiniMax H3 标准", 2], ["MiniMax H3 加速", 1], ["MiniMax H3 极速", 1],
      ["LTX2.3", 1], ["LTX2.5", 1], ["My Model", 2], ["MyModel", 1],
      ["My Model V2", 1], ["Qwen 图像 / 人像", 1], ["Qwen 图像 / 风景", 1],
    ]);
    expect(filterDirectoryWorkflows(canvas, workflowSeriesId(entries[0]), "").map(item => item.id)).toEqual(["entry-0", "entry-1"]);
  });

  it("groups the real source library labels with inferred import families without changing the source", () => {
    const groups = [
      ["image", "Klein 系列", ["Klein图像", "Klein Image", "Klein 系列"]],
      ["video", "视频超分工具", ["视频超分", "Video Upscale", "视频超分工具"]],
      ["video", "MiniMax H3 标准", ["MiniMax H3 Standard", "MiniMax H3 标准"]],
      ["video", "MiniMax H3 加速", ["MiniMax H3 Accelerated", "MiniMax H3 加速"]],
      ["video", "MiniMax H3 极速", ["MiniMax H3 Turbo", "MiniMax H3 极速"]],
    ] as const;
    const entries = groups.flatMap(([kind, , families]) => families.map((family, index) =>
      workflow(family + index, "工作流", family, kind)));
    const before = JSON.stringify(entries);
    const views = buildDirectoryView(entries);
    for (const [kind, label, families] of groups) {
      const canvas = views.find(item => item.id === kind)!;
      const expected = entries.filter(item => families.some(family => family === item.family));
      const series = canvas.series.find(item => item.name === label)!;
      expect(series.workflows).toBe(families.length);
      expect(filterDirectoryWorkflows(canvas, series.id, "")).toEqual(expected);
      expect(new Set(expected.map(workflowSeriesId)).size).toBe(1);
    }
    expect(views.find(item => item.id === "video")!.series).toHaveLength(4);
    expect(JSON.stringify(entries)).toBe(before);
  });

  it("does not collapse hand-named Klein or upscale subcategories into their model aliases", () => {
    const image = workflow("portrait", "人像", "Klein图像 / 人像", "image");
    const video = workflow("upscale", "自定义超分", "视频超分 / 测试", "video");
    expect(workflowSeriesName(image)).toBe(image.family);
    expect(workflowSeriesName(video)).toBe(video.family);
    expect(workflowSeriesId(image)).not.toBe(workflowSeriesId(workflow("auto", "导入", "Klein 系列", "image")));
    expect(workflowSeriesId(video)).not.toBe(workflowSeriesId(workflow("auto", "导入", "视频超分工具", "video")));
  });

  it("keeps equal family labels scoped to their media canvas and coalesces empty categories", () => {
    const image = workflow("image", "图像", "通用工具", "image");
    const video = workflow("video", "视频", "通用工具", "video");
    expect(workflowSeriesId(image)).not.toBe(workflowSeriesId(video));
    const first = workflow("first", "一", "", "image");
    const second = workflow("second", "二", "　", "image", { version: 2, canvas: "image", seriesId: "empty", bindingKey: "empty", bindingStatus: "bound" });
    expect(buildDirectoryView([first, second])[1].series).toEqual([{ id: workflowSeriesId(first), name: "其他工作流", workflows: 2 }]);
  });

  it("places text outputs in the text canvas even when cached metadata still says image", () => {
    const cached = workflow("qwen-reverse", "Qwen3.5 提示词反推", "文本工具", "text", { version: 2, canvas: "image", seriesId: "text-tools", bindingKey: "reverse", bindingStatus: "bound" });
    const plain = workflow("plain-text", "文本改写", "文本工具", "text");
    expect(categoryForWorkflow(cached)).toBe("text");
    const views = buildDirectoryView([cached, plain]);
    expect(views.find((canvas) => canvas.id === "image")?.workflows).toHaveLength(0);
    const text = views.find((canvas) => canvas.id === "text")!;
    expect(text.workflows).toHaveLength(2);
    expect(filterDirectoryWorkflows(text, "", "反推")).toEqual([cached]);
  });

  it("returns to all series after a rescan removes the selected series", () => {
    const deleted = workflow("old", "旧工作流", "旧系列", "video");
    const newEntry = workflow("new", "视频转深度", "视频转换", "video");
    const activeSeries = workflowSeriesId(deleted);
    const rescanned = buildDirectoryView([newEntry])[2];
    expect(availableSeriesId(rescanned, activeSeries)).toBe("");
    expect(filterDirectoryWorkflows(rescanned, activeSeries, "")).toEqual([newEntry]);
    expect(buildDirectoryView([]).every((canvas) => !canvas.workflows.length && !canvas.series.length)).toBe(true);
  });

  it("registers unadapted workflows without losing their metadata or claiming execution is connected", () => {
    const entry = workflow("tool", "自定义视频转换", "视频转换", "video");
    entry.library = { sourcePath: "E:/library", folder: "VideoTool", runnerType: "python", executionIssue: "Python 执行方式尚未接入" };
    entry.parameters = [{ key: "resolution", label: "分辨率", type: "number", default: 704 }];
    entry.inputSlots = [{ semantic: "slot:video", label: "输入视频", kind: "video", required: true }];
    const canvas = buildDirectoryView([entry])[2];
    expect(canvas.workflows).toEqual([entry]);
    expect(canvas.series[0].workflows).toBe(1);
    expect(filterDirectoryWorkflows(canvas, workflowSeriesId(entry), "转换")[0]).toBe(entry);
    expect(filterDirectoryWorkflows(canvas, "", "自定义")[0].parameters).toBe(entry.parameters);
    expect(workflowExecutionStatus(entry)).toBe("执行待接入");
    entry.template = { save: { class_type: "Save", inputs: {} } };
    expect(workflowExecutionStatus(entry)).toBe("执行待接入");
    entry.library = { sourcePath: "E:/library", folder: "VideoTool", runnerType: "comfyui" };
    expect(workflowExecutionStatus(entry)).toBe("已读取并接入标准 ComfyUI 执行");
  });
});
