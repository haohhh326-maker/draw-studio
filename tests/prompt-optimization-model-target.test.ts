import { describe, expect, it } from "vitest";
import type { Asset, Canvas, CanvasNode, WorkflowDefinition } from "../src/types";
import { collectOptimizationContext, describeCanvasOptimizationTarget, describeOptimizationTarget, optimizationWorkflowMode } from "../src/prompt-optimization/context";
import { resolveOptimizationModelKey } from "../src/prompt-optimization/model-target";

const node = (): CanvasNode => ({ id: "n", position: { x: 0, y: 0 }, data: { kind: "image-generation", title: "任意名称", generation: { workflowId: "renamed", prompt: "原文", negativePrompt: "", params: {}, taskId: null } } });
const workflow = (patch: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({ id: "renamed", name: "与模型无关的标题", family: "图像生成", description: "", mode: "text-to-image", requiredInputs: [], optionalInputs: [], parameters: [], mapping: [{ semantic: "prompt", nodeId: "encode", field: "text" }], output: { nodeId: "save", field: "images", kind: "image" }, ...patch });
const imageAsset: Asset = { id: "image", name: "image", kind: "image", mime: "image/png", size: 1, createdAt: 1 };

describe("model-driven prompt Skill context", () => {
  it.each([
    ["qwen_image_2.1_int8_convrot.safetensors", "qwen-image-2.1"],
    ["qwen_image_edit_2511_fp8mixed.safetensors", "qwen-image-edit-2511"],
    ["qwen_image_2512_fp8_e4m3fn.safetensors", "qwen-image-2512"],
    ["Qwen-Rapid-AIO-NSFW-v19_Q6_K.gguf", "qwen-image"],
    ["flux-2-klein-9b-fp8.safetensors", "flux-2-klein"],
    ["krea2_raw.safetensors", "krea-2"],
    ["ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors", "ltx-2.3"],
    ["Wan22_Bernini_HIGH_fp8_e4m3fn_scaled.safetensors", "wan-2.2-bernini"],
    ["Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors", "wan-2.2-remix"],
    ["wan2.1_14B_SCAIL_2_fp8_scaled.safetensors", "wan-2.1-scail2"],
    ["Wan2.2-I2V-A14B-HighNoise-Q6_K.gguf", "wan-2.2"],
    ["gemini-3-pro-image-preview", "nano-banana-pro"],
  ])("identifies actual model %s independently of directory names", (id, key) => {
    expect(resolveOptimizationModelKey([id], "API", "image")).toBe(key);
  });
  it("does not identify an image model from an LLM, VAE or mmproj", () => {
    expect(resolveOptimizationModelKey(["qwen3vl_8b_int8_convrot.safetensors", "qwen_image_2.1_vae_bf16.safetensors", "mmproj-Qwen3.5-9B.gguf"], "API", "image")).toBeUndefined();
    expect(resolveOptimizationModelKey([], "视频生成", "video")).toBeUndefined();
    expect(resolveOptimizationModelKey(["qwen_image_2.1.safetensors", "krea2_raw.safetensors"], "Qwen图像", "image")).toBeUndefined();
  });
  it("follows guider model connections, current bound model parameters and selected output only", () => {
    const w = workflow({ parameters: [{ key: "weights", label: "任意标签", type: "text", default: "flux-2-klein-9b-fp8.safetensors", model: true }], mapping: [{ semantic: "prompt", nodeId: "encode", field: "text" }, { semantic: "weights", nodeId: "model", field: "unet_name" }], template: {
      model: { class_type: "UNETLoader", inputs: { unet_name: "flux-2-klein-9b-fp8.safetensors" } },
      encode: { class_type: "CLIPTextEncode", inputs: { text: "" } },
      guider: { class_type: "CFGGuider", inputs: { model: ["model", 0], positive: ["encode", 0] } },
      sampler: { class_type: "SamplerCustomAdvanced", inputs: { guider: ["guider", 0] } },
      save: { class_type: "SaveImage", inputs: { images: ["sampler", 0] } },
      unrelated: { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2512.safetensors" } },
    } });
    const current = node(), snapshot = structuredClone(w);
    expect(describeOptimizationTarget(current, w)).toMatchObject({ modelKey: "flux-2-klein", modelIds: ["flux-2-klein-9b-fp8.safetensors"] });
    current.data.generation!.params.weights = "krea2_raw.safetensors";
    expect(describeOptimizationTarget(current, w)).toMatchObject({ modelKey: "krea-2", modelIds: ["krea2_raw.safetensors"] });
    expect(w).toEqual(snapshot);
  });
  it("uses a merged main checkpoint rather than misreading adapter names or a stale family", () => {
    const w = workflow({ family: "Qwen图像", template: {
      model: { class_type: "UNETLoader", inputs: { unet_name: "flux-2-klein-9b-Lightning-LoRA-merged.safetensors" } },
      adapter: { class_type: "LoraLoaderModelOnly", inputs: { model: ["model", 0], lora_name: "qwen_image_edit_2511_Lightning_lora.safetensors", strength_model: 1 } },
      sampler: { class_type: "KSampler", inputs: { model: ["adapter", 0] } },
      save: { class_type: "SaveImage", inputs: { images: ["sampler", 0] } },
    } });
    expect(describeOptimizationTarget(node(), w)).toMatchObject({ modelKey: "flux-2-klein", modelIds: ["flux-2-klein-9b-Lightning-LoRA-merged.safetensors"] });
  });
  it("retains known API model identity and selects edit only from actual optional API inputs", () => {
    const w = workflow({ generationModels: ["gpt-image-2"], family: "API", library: { sourcePath: "test", folder: "test", runnerType: "api" }, inputSlots: [{ semantic: "slot:image", label: "可选图片", kind: "image", required: false }], mode: "image-to-image", mapping: [] });
    const current = node(), canvas: Canvas = { id: "c", name: "c", sceneId: "s", nodes: [current], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    expect(describeCanvasOptimizationTarget(canvas, current, w, {})).toMatchObject({ modelKey: "gpt-image-2", mode: "text-to-image" });
    canvas.nodes.push({ id: "reference", position: { x: 0, y: 0 }, data: { kind: "reference", title: "reference", assetId: "image" } });
    canvas.edges.push({ id: "e", source: "reference", target: "n", data: { order: 0, role: "auto" } });
    expect(describeCanvasOptimizationTarget(canvas, current, w, { image: imageAsset }).mode).toBe("image-to-image");
    w.library!.runnerType = "comfyui"; w.mode = "text-to-image";
    expect(describeCanvasOptimizationTarget(canvas, current, w, { image: imageAsset }).mode).toBe("text-to-image");
  });
  it("derives camera syntax from an active LoRA, without matching workflow names", () => {
    const w = workflow({ template: {
      model: { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_edit_2511.safetensors" } },
      lora: { class_type: "LoraLoaderModelOnly", inputs: { model: ["model", 0], lora_name: "qwen-image-edit-2511-multiple-angles-lora.safetensors", strength_model: 1 } },
      encode: { class_type: "TextEncodeQwenImageEditPlus", inputs: { prompt: "", image1: ["image", 0] } },
      image: { class_type: "LoadImage", inputs: { image: "" } },
      sampler: { class_type: "KSampler", inputs: { model: ["lora", 0], positive: ["encode", 0] } },
      save: { class_type: "SaveImage", inputs: { images: ["sampler", 0] } },
    } });
    expect(describeOptimizationTarget(node(), w)).toMatchObject({ modelKey: "qwen-image-edit-2511", features: expect.arrayContaining(["camera-angle", "ordered-image-edit"]), promptContract: "fixed-vocabulary" });
    w.template!.lora.inputs.strength_model = 0;
    expect(describeOptimizationTarget(node(), w).features).not.toContain("camera-angle");
    w.template!.lora.inputs.strength_model = 1; w.template!.sampler.inputs.model = ["model", 0];
    expect(describeOptimizationTarget(node(), w).features).not.toContain("camera-angle");
  });
  it("adds optional audio conditioning only when that actual media is connected", () => {
    const current = node(), w = workflow({ inputSlots: [{ semantic: "slot:audio", label: "参考声音", kind: "audio", required: false }] });
    const canvas: Canvas = { id: "c", name: "c", sceneId: "s", nodes: [current], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    expect(describeCanvasOptimizationTarget(canvas, current, w, {}).features).not.toContain("audio-conditioned");
    canvas.nodes.push({ id: "sound", position: { x: 0, y: 0 }, data: { kind: "reference", title: "声音", assetId: "sound" } });
    canvas.edges.push({ id: "e", source: "sound", target: "n", data: { role: "auto", order: 0 } });
    expect(describeCanvasOptimizationTarget(canvas, current, w, { sound: { ...imageAsset, id: "sound", kind: "audio", mime: "audio/wav" } }).features).toContain("audio-conditioned");
  });
  it("identifies MSR, audio and Prompt Relay contracts without workflow-specific profiles", () => {
    const w = workflow({ output: { nodeId: "save", field: "videos", kind: "video" }, inputSlots: [{ semantic: "slot:audio", label: "任意", kind: "audio", required: true }], mapping: [{ semantic: "prompt", nodeId: "relay", field: "global_prompt" }], template: {
      model: { class_type: "UNETLoader", inputs: { unet_name: "ltx-2.3-22b-distilled.safetensors" } },
      msr: { class_type: "LiconMSR", inputs: {} },
      relay: { class_type: "PromptRelayEncode", inputs: { global_prompt: "原文", model: ["model", 0], guide: ["msr", 0] } },
      save: { class_type: "SaveVideo", inputs: { images: ["relay", 0] } },
    } });
    expect(describeOptimizationTarget(node(), w)).toMatchObject({ modelKey: "ltx-2.3", features: expect.arrayContaining(["msr-v2", "audio-conditioned", "prompt-relay-global"]) });
  });
  it("keeps Vox speech verbatim and classifies promptless utilities independently of their weights", () => {
    const w = workflow({ family: "VoxCPM", output: { nodeId: "save", field: "audio", kind: "audio" }, mapping: [{ semantic: "prompt", nodeId: "speech", field: "text" }], template: {
      model: { class_type: "RunningHub_VoxCPM_LoadModel", inputs: { model_name: "VoxCPM2" } },
      speech: { class_type: "RunningHub_VoxCPM_Generate", inputs: { text: "保留说话原文", control_instruction: "开心", model: ["model", 0] } },
      save: { class_type: "SaveAudio", inputs: { audio: ["speech", 0] } },
    } });
    expect(describeOptimizationTarget(node(), w)).toMatchObject({ modelKey: "voxcpm-2", promptContract: "verbatim" });
    w.mapping = [];
    expect(describeOptimizationTarget(node(), w).promptContract).toBe("utility");
  });
  it("treats a canvas text editor independently of its speech or utility generation workflow", async () => {
    const current = node(); current.data.kind = "text"; current.data.text = "帮我润色这段故事"; current.data.generation!.negativePrompt = "生成流程的负向输入";
    const w = workflow({ family: "VoxCPM", parameters: [{ key: "other", label: "其他输入", type: "text", inputText: true, default: "生成专属字段" }], output: { nodeId: "save", field: "audio", kind: "audio" }, mapping: [{ semantic: "prompt", nodeId: "speech", field: "text" }], template: {
      model: { class_type: "RunningHub_VoxCPM_LoadModel", inputs: { model_name: "VoxCPM2" } },
      speech: { class_type: "RunningHub_VoxCPM_Generate", inputs: { text: "需要逐字朗读", model: ["model", 0] } },
      save: { class_type: "SaveAudio", inputs: { audio: ["speech", 0] } },
    } });
    const canvas: Canvas = { id: "c", name: "c", sceneId: "s", nodes: [current], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    expect(describeCanvasOptimizationTarget(canvas, current, w, {}, "generation")).toMatchObject({ modelKey: "voxcpm-2", promptContract: "verbatim" });
    expect(describeCanvasOptimizationTarget(canvas, current, w, {}, "text")).toMatchObject({ kind: "text", mode: "text-tool", promptContract: "creative", workflowId: "", modelIds: [] });
    expect(describeCanvasOptimizationTarget(canvas, current, w, {}, "text")).not.toHaveProperty("modelKey");
    const context = await collectOptimizationContext(canvas, "n", w, {}, { promptField: "text", textOnly: true });
    expect(context).toMatchObject({ prompt: "帮我润色这段故事", negativePrompt: "", inputTexts: [], target: { kind: "text", mode: "text-tool", promptContract: "creative" } });
    expect(JSON.stringify(context)).not.toContain("生成专属字段");
    w.mapping = [];
    expect(describeCanvasOptimizationTarget(canvas, current, w, {}, "generation").promptContract).toBe("utility");
    expect(describeCanvasOptimizationTarget(canvas, current, w, {}, "text").promptContract).toBe("creative");
  });
  it("uses Bernini source video and Wan frame ports rather than material counts", () => {
    const w = workflow({ mode: "multi-reference", output: { nodeId: "save", field: "videos", kind: "video" }, template: {
      save: { class_type: "SaveVideo", inputs: { images: ["condition", 0] } },
      condition: { class_type: "BerniniConditioning", inputs: { source_video: ["media", 0], "reference_images.reference_image_0": ["media", 0] } },
      media: { class_type: "LoadImage", inputs: { image: "" } },
    } });
    expect(optimizationWorkflowMode(node(), w)).toBe("video-to-video");
    delete w.template!.condition.inputs.source_video;
    expect(optimizationWorkflowMode(node(), w)).toBe("image-to-video");
    w.template!.condition = { class_type: "WanFirstLastFrameToVideo", inputs: { start_image: ["media", 0], end_image: ["media", 0] } };
    expect(optimizationWorkflowMode(node(), w)).toBe("first-last-frame");
  });
  it("recognizes LTX endpoint pairs even when a missing middle image still has an index", () => {
    const w = workflow({ mode: "multi-reference", output: { nodeId: "save", field: "videos", kind: "video" }, template: {
      save: { class_type: "SaveVideo", inputs: { images: ["guide", 0] } },
      guide: { class_type: "LTXVImgToVideoInplaceKJ", inputs: { num_images: "3", "num_images.image_1": ["image", 0], "num_images.index_1": 0, "num_images.index_2": 24, "num_images.image_3": ["image", 0], "num_images.index_3": -1 } },
      image: { class_type: "LoadImage", inputs: { image: "" } },
    } });
    expect(optimizationWorkflowMode(node(), w)).toBe("first-last-frame");
    delete w.template!.guide.inputs["num_images.image_3"];
    expect(optimizationWorkflowMode(node(), w)).toBe("multi-reference");
  });
});
