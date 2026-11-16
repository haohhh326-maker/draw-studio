import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, Canvas, CanvasNode, Role, WorkflowDefinition } from "../src/types";
import { encodePromptMention } from "../src/semantic/mentions";
import { collectOptimizationContext, describeOptimizationTarget, optimizationWorkflowMode, optimizationContextIdentity, optimizationPromptField, optimizationPromptPatch, readOptimizationPrompt } from "../src/prompt-optimization/context";
import { getBlob } from "../src/projects/storage";
import { imageVisionInput, videoVisionInputs } from "../src/prompt-optimization/media";
import { museWorkflows } from "../src/muse/catalog";

vi.mock("../src/projects/storage", () => ({ getBlob: vi.fn() }));
vi.mock("../src/prompt-optimization/media", async importOriginal => {
  const real = await importOriginal<typeof import("../src/prompt-optimization/media")>();
  return { ...real, imageVisionInput: vi.fn(), videoVisionInputs: vi.fn() };
});
function source(id: string, assetId = id): CanvasNode {
  return { id, position: { x: 0, y: 0 }, data: { title: "素材 " + id, kind: "reference", assetId } };
}
function target(): CanvasNode {
  return { id: "target", position: { x: 0, y: 0 }, data: { title: "视频生成", kind: "video", generation: {
    prompt: "人物向前走", negativePrompt: "不要变装", workflowId: "h3", taskId: null, params: { generationModel: "model.gguf", password: "never-send" },
  } } };
}
function workflow(patch: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return { id: "h3", family: "MiniMax H3", name: "H3 多图参考", description: "", mode: "multi-reference",
    requiredInputs: ["referenceImages"], optionalInputs: [], parameters: [], mapping: [{ semantic: "referenceImages", nodeId: "api", field: "images" }],
    output: { nodeId: "api", field: "videos", kind: "video" }, ...patch };
}
function canvas(nodes: CanvasNode[] = [], roles: Role[] = []): Canvas {
  return { id: "canvas", name: "画布", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [...nodes, target()],
    edges: nodes.map((node, index) => ({ id: "edge-" + node.id, source: node.id, target: "target", data: { role: roles[index] ?? "auto", order: index } })) };
}
function asset(id: string, kind: Asset["kind"] = "image"): Asset {
  return { id, name: id + "." + kind, kind, mime: kind === "video" ? "video/mp4" : "image/png", size: 9, createdAt: 1 };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getBlob).mockImplementation(async id => new Blob(["bytes:" + id]));
  vi.mocked(imageVisionInput).mockResolvedValue("data:image/jpeg;base64,aW1hZ2U=");
  vi.mocked(videoVisionInputs).mockResolvedValue([
    { dataUrl: "data:image/jpeg;base64,Zmlyc3Q=", timeSeconds: 0 },
    { dataUrl: "data:image/jpeg;base64,bWlkZGxl", timeSeconds: 5 },
    { dataUrl: "data:image/jpeg;base64,bGFzdA==", timeSeconds: 9.999 },
  ]);
});

describe("prompt optimization canvas context", () => {
  it("optimizes a plain text note with no generation workflow or image requirement", async () => {
    const note: CanvasNode = { id: "note", position: { x: 0, y: 0 }, data: { kind: "text", title: "文本 1", text: "人物站在车站等待朋友" } };
    const current = { ...canvas(), nodes: [note] };
    const result = await collectOptimizationContext(current, "note", undefined, {}, { promptField: "text" });
    expect(result).toMatchObject({ prompt: note.data.text, references: [], inputTexts: [], negativePrompt: "",
      target: { kind: "text", mode: "text-tool", workflowId: "", workflowName: "文本提示词" } });
    expect(getBlob).not.toHaveBeenCalled();
    expect(optimizationPromptField(note)).toBe("text");
    expect(optimizationPromptPatch(note, "优化文本")).toEqual({ text: "优化文本" });
    expect(note.data).not.toHaveProperty("generation");
    expect(optimizationPromptPatch(note, "不可创建生成状态", "generation")).toBeNull();
  });
  it("reads the explicit canvas text editor even when a text node also has an empty generation prompt", async () => {
    const note = target();
    note.data.kind = "text"; note.data.text = "改写故事的核心人物与动作";
    note.data.generation!.prompt = "";
    note.data.generation!.workflowId = "";
    const current = { ...canvas(), nodes: [note] };
    const result = await collectOptimizationContext(current, "target", undefined, {}, { promptField: "text" });
    expect(result.prompt).toBe(note.data.text);
    expect(result.target.kind).toBe("text");
    expect(getBlob).not.toHaveBeenCalled();
    expect(readOptimizationPrompt(note, "generation")).toBe("");
    expect(optimizationPromptPatch(note, "优化后的故事", "text")).toEqual({ text: "优化后的故事" });
    expect(note.data.generation!.prompt).toBe("");
  });
  it("keeps a text workflow's positive input separate from its editable canvas output", async () => {
    const note = target(); note.data.kind = "text"; note.data.text = "上一次生成的文本";
    const w = workflow({ mode: "text-tool", requiredInputs: ["prompt"], optionalInputs: [],
      output: { nodeId: "out", field: "text", kind: "text" }, mapping: [{ semantic: "prompt", nodeId: "input", field: "text" }] });
    const current = { ...canvas(), nodes: [note] };
    const result = await collectOptimizationContext(current, "target", w, {}, { promptField: "generation" });
    expect(result).toMatchObject({ prompt: "人物向前走", references: [], target: { mode: "text-tool", kind: "text" } });
    expect(optimizationPromptField(note)).toBe("generation");
    const generation = structuredClone(note.data.generation!);
    const patch = optimizationPromptPatch(note, "新的输入提示词", "generation");
    expect(patch).toEqual({ generation: { ...generation, prompt: "新的输入提示词" } });
    expect({ ...note.data, ...patch }).toMatchObject({ text: "上一次生成的文本", generation: {
      negativePrompt: generation.negativePrompt, params: generation.params, workflowId: generation.workflowId, taskId: generation.taskId,
    } });
    expect(note.data.generation).toEqual(generation);
    expect(getBlob).not.toHaveBeenCalled();
  });
  it("supports a prompt without images even when generation requires images", async () => {
    const result = await collectOptimizationContext(canvas(), "target", workflow(), {});
    expect(result.prompt).toBe("人物向前走"); expect(result.negativePrompt).toBe("不要变装");
    expect(result.references).toEqual([]); expect(getBlob).not.toHaveBeenCalled();
    expect(result.target).toMatchObject({ family: "MiniMax H3", mode: "multi-reference", kind: "video" });
  });
  it("reads connected images as optimization context for text-to-image workflows with no generation image slots", async () => {
    const current = canvas([source("a")]);
    const w = workflow({ mode: "text-to-image", requiredInputs: ["prompt"], optionalInputs: [], mapping: [{ semantic: "prompt", nodeId: "text", field: "prompt" }] });
    const result = await collectOptimizationContext(current, "target", w, { a: asset("a") });
    expect(result.target.mode).toBe("text-to-image"); expect(result.references[0].role).toBe("reference");
    expect(result.references[0].images).toHaveLength(1); expect(getBlob).toHaveBeenCalledTimes(1);
  });
  it("reads every direct image's actual stored bytes in connection order and ignores unrelated nodes", async () => {
    const current = canvas([source("a"), source("b"), source("c")]);
    current.nodes.push(source("unrelated"));
    current.edges[0].data!.order = 5;
    const result = await collectOptimizationContext(current, "target", workflow(), { a: asset("a"), b: asset("b"), c: asset("c"), unrelated: asset("unrelated") });
    expect(result.references.map(reference => reference.nodeId)).toEqual(["b", "c", "a"]);
    expect(result.references.every(reference => reference.role === "referenceImages")).toBe(true);
    expect(getBlob).toHaveBeenCalledTimes(3);
    expect(getBlob).not.toHaveBeenCalledWith("unrelated", expect.anything());
    expect(await vi.mocked(imageVisionInput).mock.calls[0][0].text()).toBe("bytes:b");
    expect(result.references.flatMap(reference => reference.images ?? [])).toHaveLength(3);
  });
  it("preserves character and scene semantics even when the generation resolver groups references", async () => {
    const result = await collectOptimizationContext(canvas([source("a"), source("b")], ["characterReference", "sceneReference"]), "target", workflow(), { a: asset("a"), b: asset("b") });
    expect(result.references.map(reference => [reference.role, reference.roleLabel])).toEqual([
      ["characterReference", "角色参考"], ["sceneReference", "场景参考"],
    ]);
  });
  it("preserves first/last frame roles with an incomplete imported workflow and reserves explicit slots", async () => {
    const w = workflow({ mode: "first-last-frame", inputSlots: [
      { semantic: "slot:start", label: "First Frame", kind: "image", required: true },
      { semantic: "slot:end", label: "Last Frame", kind: "image", required: true },
    ] });
    const one = await collectOptimizationContext(canvas([source("a")], ["firstFrame"]), "target", w, { a: asset("a") });
    expect(one.references[0].role).toBe("firstFrame"); expect(one.references[0].roleLabel).toContain("首帧");
    const both = await collectOptimizationContext(canvas([source("a"), source("b")], ["auto", "lastFrame"]), "target", w, { a: asset("a"), b: asset("b") });
    expect(both.references.map(reference => reference.role)).toEqual(["slot:start", "lastFrame"]);
  });
  it("keeps required-before-optional AUTO preference when required slots are missing", async () => {
    const w = workflow({ inputSlots: [
      { semantic: "slot:optional", label: "Style", kind: "image", required: false },
      { semantic: "slot:required", label: "Main Image", kind: "image", required: true },
      { semantic: "slot:other", label: "Scene", kind: "image", required: true },
    ] });
    const result = await collectOptimizationContext(canvas([source("a")]), "target", w, { a: asset("a") });
    expect(result.references[0].role).toBe("slot:required");
  });
  it("keeps dynamic multiple image references distinct from image-to-video first frames", async () => {
    const w = workflow({ dynamicReferences: { binding: { targetNodeId: "api" }, constraints: { minTotal: 3 }, routes: {
      image: { maxItems: 10, prototypeNodeIds: [], pathBinding: { nodeId: "api", path: "images" }, targetInputPrefix: "ref" },
    } } });
    const result = await collectOptimizationContext(canvas([source("a")]), "target", w, { a: asset("a") });
    expect(result.references[0].role).toBe("dynamic:image"); expect(result.references[0].roleLabel).toBe("多图参考");
    expect(result.target.mode).toBe("multi-reference");
  });
  it("labels connected independent inputText fields without merging them into the editable prompt", async () => {
    const nodes: CanvasNode[] = ["positive", "negative"].map(id => ({ id, position: { x: 0, y: 0 }, data: { kind: "text", title: id, text: id + " original" } }));
    const w = workflow({ parameters: [
      { key: "positive", label: "正向输入", type: "text", default: "", inputText: true },
      { key: "negative", label: "负向输入", type: "text", default: "", inputText: true },
    ] });
    const result = await collectOptimizationContext(canvas(nodes), "target", w, {});
    expect(result.prompt).toBe("人物向前走");
    expect(result.references.map(reference => [reference.role, reference.text])).toEqual([
      ["inputText:positive", "positive original"], ["inputText:negative", "negative original"],
    ]);
    expect(getBlob).not.toHaveBeenCalled();
  });
  it("includes manually filled independent fields, with connected fields taking precedence, without sending secrets", async () => {
    const current = canvas([{ id: "text", position: { x: 0, y: 0 }, data: { kind: "text", title: "参考文本", text: "connected original" } }]);
    current.nodes.find(node => node.id === "target")!.data.generation!.params = { first: "ignored widget", second: "manual original", password: "never-send" };
    const w = workflow({ parameters: [
      { key: "first", label: "连接字段", type: "text", default: "", inputText: true },
      { key: "second", label: "独立字段", type: "text", default: "", inputText: true },
      { key: "password", label: "密钥", type: "text", default: "", secret: true },
    ] });
    const result = await collectOptimizationContext(current, "target", w, {});
    expect(result.inputTexts).toEqual([
      { key: "first", label: "连接字段", text: "connected original", connected: true },
      { key: "second", label: "独立字段", text: "manual original", connected: false },
    ]);
    expect(result.prompt).toBe("人物向前走"); expect(JSON.stringify(result)).not.toContain("never-send");
  });
  it("protects atomic mentions, preserves repeated identity and avoids placeholder collisions", async () => {
    const current = canvas([source("a")]);
    const mention = encodePromptMention("a", "人物");
    current.nodes.at(-1)!.data.generation!.prompt = "__DRAW_MENTION_0__ " + mention + " follows " + mention;
    const result = await collectOptimizationContext(current, "target", workflow(), { a: asset("a") }, { textOnly: true });
    expect(result.prompt).toBe("__DRAW_MENTION_0__ __DRAW_MENTION_1__ follows __DRAW_MENTION_1__");
    expect(result.mentions).toEqual({ __DRAW_MENTION_1__: mention });
  });
  it("rejects disconnected mentions before reading media", async () => {
    const current = canvas(); current.nodes[0].data.generation!.prompt = encodePromptMention("missing", "素材");
    await expect(collectOptimizationContext(current, "target", workflow(), {})).rejects.toThrow("已断开");
    expect(getBlob).not.toHaveBeenCalled();
  });
  it("reads ordered reference video samples and keeps audio as unanalysed metadata", async () => {
    const w = workflow({ requiredInputs: [], mapping: [
      { semantic: "referenceVideos", nodeId: "api", field: "video" }, { semantic: "audio", nodeId: "api", field: "audio" },
    ] });
    const result = await collectOptimizationContext(canvas([source("clip"), source("sound")]), "target", w, { clip: asset("clip", "video"), sound: asset("sound", "audio") });
    expect(result.references[0].role).toBe("referenceVideos");
    expect(result.references[0].images?.map(frame => frame.timeSeconds)).toEqual([0, 5, 9.999]);
    expect(result.references[1].images).toBeUndefined(); expect(getBlob).toHaveBeenCalledTimes(1);
    expect(await vi.mocked(videoVisionInputs).mock.calls[0][0].text()).toBe("bytes:clip");
  });
  it("keeps legacy Muse image roles and new video/audio references available to prompt optimization", async () => {
    const current = canvas([source("still"), source("clip"), source("sound")], ["slot:muse-image-1", "auto", "auto"]);
    const result = await collectOptimizationContext(current, "target", museWorkflows[1], {
      still: asset("still"), clip: asset("clip", "video"), sound: asset("sound", "audio"),
    });
    expect(result.references.map(reference => [reference.kind, reference.roleLabel])).toEqual([
      ["image", "参考图片"], ["video", "参考视频"], ["audio", "参考音频"],
    ]);
    expect(getBlob).toHaveBeenCalledTimes(2);
  });
  it("requires an explicit text-only choice for unavailable connected media", async () => {
    const current = canvas([source("missing")]);
    await expect(collectOptimizationContext(current, "target", workflow(), {})).rejects.toThrow("尚未准备好");
    const result = await collectOptimizationContext(current, "target", workflow(), {}, { textOnly: true });
    expect(result.references[0].images).toBeUndefined(); expect(getBlob).not.toHaveBeenCalled();
  });
  it("does not silently discard images when exceeding the visual limit", async () => {
    const nodes = Array.from({ length: 17 }, (_, index) => source(String(index)));
    await expect(collectOptimizationContext(canvas(nodes), "target", workflow(), Object.fromEntries(nodes.map(node => [node.id, asset(node.id)])))).rejects.toThrow("超过 16");
  });
  it("propagates missing actual file errors and aborts before reads", async () => {
    const current = canvas([source("a")]); const assets = { a: asset("a") };
    vi.mocked(getBlob).mockRejectedValue(new Error("本地素材丢失"));
    await expect(collectOptimizationContext(current, "target", workflow(), assets)).rejects.toThrow("本地素材丢失");
    vi.mocked(getBlob).mockClear();
    const controller = new AbortController(); controller.abort();
    await expect(collectOptimizationContext(current, "target", workflow(), assets, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(getBlob).not.toHaveBeenCalled();
  });
  it("describes generation models separately, never includes secret parameters", () => {
    const node = target();
    const w = workflow({ parameters: [
      { key: "generationModel", label: "生成模型", type: "text", default: "", model: true },
      { key: "password", label: "Secret", type: "text", default: "", model: true, secret: true },
    ] });
    expect(describeOptimizationTarget(node, w).model).toBe("MiniMax H3; 生成模型: model.gguf");
    expect(describeOptimizationTarget(node, w).modelIds).toEqual(["model.gguf"]);
    const text: CanvasNode = { id: "text", position: { x: 0, y: 0 }, data: { kind: "text", title: "文本", text: "草稿" } };
    expect(describeOptimizationTarget(text)).toMatchObject({ mode: "text-tool", kind: "text", workflowName: "文本提示词" });
  });
  it("carries the explicitly bound video duration and updates when the generation parameter changes", () => {
    const node = target();
    node.data.generation!.params.duration = 8;
    const w = workflow({ parameters: [{ key: "duration", label: "时长 / 秒", type: "number", default: 5, min: 1, max: 15 }], mapping: [
      { semantic: "referenceImages", nodeId: "api", field: "images" },
      { semantic: "duration", nodeId: "api", field: "value" },
    ] });
    expect(describeOptimizationTarget(node, w).durationSeconds).toBe(8);
    node.data.generation!.params.duration = 12;
    expect(describeOptimizationTarget(node, w).durationSeconds).toBe(12);
  });
  it("reads the explicit MiniMax H3 V3 duration_seconds contract without relying on its label", () => {
    const node = target();
    const key = "input:185:duration_seconds";
    node.data.generation!.params[key] = 7;
    const v3 = workflow({ parameters: [{ key, label: "任意展示名称", type: "number", default: 7, min: 1, max: 15 }], mapping: [
      { semantic: "referenceImages", nodeId: "api", field: "images" },
      { semantic: key, nodeId: "185", field: "duration_seconds" },
    ], template: {
      "185": { class_type: "MiniMaxH3IntegrationGH", inputs: { duration_seconds: 7 } },
    } });
    expect(describeOptimizationTarget(node, v3).durationSeconds).toBe(7);
    node.data.generation!.params[key] = 10;
    expect(describeOptimizationTarget(node, v3).durationSeconds).toBe(10);
  });
  it("does not infer a duration from labels, images, or a noncanonical numeric setting", () => {
    const node = target();
    node.data.generation!.params.clipLength = 8;
    const unboundVideo = workflow({ parameters: [{ key: "clipLength", label: "视频时长 / 秒", type: "number", default: 5 }], mapping: [
      { semantic: "referenceImages", nodeId: "api", field: "images" },
      { semantic: "clipLength", nodeId: "api", field: "length" },
    ] });
    expect(describeOptimizationTarget(node, unboundVideo)).not.toHaveProperty("durationSeconds");
    const unmappedDuration = workflow({ parameters: [{ key: "duration", label: "时长 / 秒", type: "number", default: 8 }], mapping: [
      { semantic: "referenceImages", nodeId: "api", field: "images" },
    ] });
    node.data.generation!.params.duration = 8;
    expect(describeOptimizationTarget(node, unmappedDuration)).not.toHaveProperty("durationSeconds");
    const foreignDurationSeconds = workflow({ parameters: [{ key: "input:185:duration_seconds", label: "时长 / 秒", type: "number", default: 7 }], mapping: [
      { semantic: "input:185:duration_seconds", nodeId: "185", field: "duration_seconds" },
    ], template: {
      "185": { class_type: "UnrelatedVideoGenerator", inputs: { duration_seconds: 7 } },
    } });
    node.data.generation!.params["input:185:duration_seconds"] = 7;
    expect(describeOptimizationTarget(node, foreignDurationSeconds)).not.toHaveProperty("durationSeconds");
    const image = workflow({ mode: "text-to-image", output: { nodeId: "api", field: "images", kind: "image" }, parameters: [
      { key: "duration", label: "时长 / 秒", type: "number", default: 8 },
    ], mapping: [{ semantic: "duration", nodeId: "api", field: "duration" }] });
    node.data.generation!.params.duration = 8;
    expect(describeOptimizationTarget(node, image)).not.toHaveProperty("durationSeconds");
  });
  it("guards target/input edits, changed roles and asset replacement while ignoring canvas motion/unrelated nodes", () => {
    const current = canvas([source("a")]); const assets = { a: asset("a") }; const w = workflow();
    const snapshot = optimizationContextIdentity(current, "target", w, assets);
    current.viewport.zoom = 2; current.nodes[0].position.x = 500;
    current.nodes.push(source("unrelated"));
    expect(optimizationContextIdentity(current, "target", w, assets)).toBe(snapshot);
    current.edges[0].data!.role = "styleReference";
    expect(optimizationContextIdentity(current, "target", w, assets)).not.toBe(snapshot);
    current.edges[0].data!.role = "auto"; assets.a.createdAt = 2;
    expect(optimizationContextIdentity(current, "target", w, assets)).not.toBe(snapshot);
    assets.a.createdAt = 1; current.nodes.at(-2)!.data.generation!.negativePrompt = "changed";
    expect(optimizationContextIdentity(current, "target", w, assets)).not.toBe(snapshot);
  });
});


describe("optimization target task contracts", () => {
  function keyframeWorkflow(first: boolean, last: boolean): WorkflowDefinition {
    return workflow({ mode: "multi-reference", inputSlots: [
      { semantic: "slot:input1", label: "arbitrary label A", kind: "image", required: true },
      { semantic: "slot:input2", label: "arbitrary label B", kind: "image", required: true },
    ], mapping: [{ semantic: "prompt", nodeId: "133", field: "prompt" },
      { semantic: "slot:input1", nodeId: "136", field: "image_path" },
      { semantic: "slot:input2", nodeId: "137", field: "image_path" }],
    template: {
      api: { class_type: "SaveVideo", inputs: { images: ["133", 0] } },
      "133": { class_type: "MiniMaxH3ImageToVideo", inputs: { prompt: "", ...(first ? { first_frame: ["136", 0] } : {}), ...(last ? { last_frame: ["137", 0] } : {}) } },
      "136": { class_type: "LoadImage", inputs: { image_path: "" } },
      "137": { class_type: "LoadImage", inputs: { image_path: "" } },
    } });
  }
  function integratedWorkflow(fields: Record<string, unknown> = {}): WorkflowDefinition {
    const defaults = { main_mode: "text_keyframes", task_type: "auto", first_frame: "", last_frame: "", gh_state_json: "", ...fields };
    return workflow({ mode: "text-to-video", requiredInputs: [], parameters: Object.entries(defaults).map(([key, value]) => ({ key: "saved:" + key, label: "display-only", type: "text" as const, default: String(value) })),
      mapping: [{ semantic: "prompt", nodeId: "185", field: "prompt" }, ...Object.keys(defaults).map(field => ({ semantic: "saved:" + field, nodeId: "185", field }))],
      template: { api: { class_type: "SaveVideo", inputs: { images: ["185", 0] } }, "185": { class_type: "MiniMaxH3IntegrationGH", inputs: defaults } } });
  }
  it.each([
    [false, false, "text-to-video"], [true, false, "image-to-video"], [false, true, "last-frame"], [true, true, "first-last-frame"],
  ])("uses H3 first/last input contracts instead of opaque slot count: %s %s", (first, last, expected) => {
    const node = target(), selected = keyframeWorkflow(first, last), snapshot = structuredClone(selected);
    expect(describeOptimizationTarget(node, selected).mode).toBe(expected);
    expect(selected).toEqual(snapshot);
  });
  it("does not classify a two-image reference workflow as first/last frame", () => {
    const selected = keyframeWorkflow(true, true);
    selected.template!["133"] = { class_type: "OtherReferenceGenerator", inputs: { first_frame: ["136", 0], last_frame: ["137", 0] } };
    expect(optimizationWorkflowMode(target(), selected)).toBe("multi-reference");
    selected.mode = "reference-video";
    expect(optimizationWorkflowMode(target(), selected)).toBe("reference-video");
    // An unrelated H3 node outside the selected output branch must not win.
    selected.template!.unrelated = { class_type: "MiniMaxH3ImageToVideo", inputs: { first_frame: ["136", 0], last_frame: ["137", 0] } };
    expect(optimizationWorkflowMode(target(), selected)).toBe("reference-video");
  });
  it("keeps H3 Ref2VA references distinct from keyframes even with video and audio routes", () => {
    const selected = workflow({ mode: "image-to-video", mapping: [], template: {
      api: { class_type: "MiniMaxH3ReferenceToVideo", inputs: { "ref_images.ref_image_0": ["load", 0], "ref_videos.ref_video_0": ["clip", 0] } },
      load: { class_type: "LoadImage", inputs: { image: "" } }, clip: { class_type: "VHS_LoadVideo", inputs: { video: "" } },
    } });
    expect(optimizationWorkflowMode(target(), selected)).toBe("multi-reference");
  });
  it.each([
    [{}, "text-to-video"],
    [{ first_frame: "first.png" }, "image-to-video"],
    [{ last_frame: "last.png" }, "last-frame"],
    [{ first_frame: "first.png", last_frame: "last.png" }, "first-last-frame"],
    [{ main_mode: "all_reference", ref_image_1: "reference.png" }, "multi-reference"],
    [{ main_mode: "all_reference", ref_video_1: "reference.mp4" }, "multi-reference"],
  ])("resolves GH's mapped current task without using canvas image counts: %j", (fields, expected) => {
    const selected = integratedWorkflow(fields), node = target();
    expect(describeOptimizationTarget(node, selected).mode).toBe(expected);
    node.data.generation!.params["saved:main_mode"] = "all_reference";
    expect(describeOptimizationTarget(node, selected).mode).toBe("multi-reference");
  });
  it("honors GH serialized mode/media as execution does, including removals and ignored task_type", () => {
    const node = target(), selected = integratedWorkflow({ first_frame: "stale-first.png", last_frame: "stale-last.png", task_type: "fl2va" });
    node.data.generation!.params["saved:gh_state_json"] = JSON.stringify({ mode: "text_keyframes", media: [] });
    expect(describeOptimizationTarget(node, selected).mode).toBe("text-to-video");
    node.data.generation!.params["saved:gh_state_json"] = JSON.stringify({ mode: "text_keyframes", media: [["last_frame", { name: "end.png" }]] });
    expect(describeOptimizationTarget(node, selected).mode).toBe("last-frame");
    node.data.generation!.params["saved:gh_state_json"] = JSON.stringify({ mode: "all_reference", media: [["ref_video_1", { name: "clip.mp4" }], ["first_frame", { name: "inactive-first.png" }]] });
    expect(describeOptimizationTarget(node, selected).mode).toBe("multi-reference");
    node.data.generation!.params["saved:main_mode"] = "text_keyframes";
    // Merely editing a hidden field cannot override GH's serialized state.
    expect(describeOptimizationTarget(node, selected).mode).toBe("multi-reference");
    node.data.generation!.params["saved:gh_state_json"] = "invalid JSON";
    expect(describeOptimizationTarget(node, selected).mode).toBe("first-last-frame");
    selected.template!["185"].class_type = "UnknownIntegration";
    expect(describeOptimizationTarget(node, selected).mode).toBe("text-to-video");
  });
  it("recognizes Qwen2.1's dynamic edit contract without inferring edit mode from attached images", () => {
    const selected = workflow({ mode: "text-to-image", output: { nodeId: "api", field: "images", kind: "image" }, mapping: [{ semantic: "prompt", nodeId: "encode", field: "prompt" }],
      dynamicReferences: { binding: { targetNodeId: "encode" }, constraints: { minTotal: 1, minimumByType: { image: 1 } }, routes: {
        image: { maxItems: 16, prototypeNodeIds: ["load"], pathBinding: { nodeId: "load", path: "inputs.image_path" }, output: { nodeId: "load", index: 0 }, targetInputPrefix: "images.image_", targetInputStartIndex: 1 },
      } }, template: { api: { class_type: "SaveImage", inputs: { images: ["encode", 0] } }, encode: { class_type: "TextEncodeQwenImage21", inputs: { prompt: "" } }, load: { class_type: "LoadImage", inputs: { image_path: "" } } } });
    expect(describeOptimizationTarget(target(), selected).mode).toBe("image-to-image");
    selected.dynamicReferences = undefined;
    expect(describeOptimizationTarget(target(), selected).mode).toBe("text-to-image");
    selected.template!.encode.class_type = "UnrelatedTextEncoder";
    expect(describeOptimizationTarget(target(), selected).mode).toBe("text-to-image");
  });
});
