import type { WorkflowDefinition, ApiWorkflow } from "../types";

// Adapted from UsedForUIDoNotTouch/Krea2_API.json. This mirror actually has the
// BF16 Qwen3-VL 4B encoder, not the recipe's FP8 encoder. Keep Krea2's sampler.
const template: ApiWorkflow = {
  model: { class_type: "UNETLoader", inputs: { unet_name: "krea2_turbo_fp8_scaled.safetensors", weight_dtype: "default" } },
  clip: { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_4b_bf16.safetensors", type: "krea2", device: "default" } },
  vae: { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
  positive: { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["clip", 0] } },
  negative: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["positive", 0] } },
  latent: { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  sampler: { class_type: "KSampler", inputs: { seed: 58, steps: 10, cfg: 1.2, sampler_name: "euler_ancestral_cfg_pp", scheduler: "beta", denoise: 1, model: ["model", 0], positive: ["positive", 0], negative: ["negative", 0], latent_image: ["latent", 0] } },
  decode: { class_type: "VAEDecode", inputs: { samples: ["sampler", 0], vae: ["vae", 0] } },
  save: { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: "canvas/krea2" } },
};
export const imageWorkflows: WorkflowDefinition[] = [{
  id: "krea2-text", family: "Krea2", name: "Krea2 文生图",
  description: "使用镜像内的 Krea2 Turbo 与 BF16 文本编码器，输出保存到原图像节点。",
  mode: "text-to-image", requiredInputs: [], optionalInputs: ["prompt"],
  parameters: [
    { key: "width", label: "宽度", type: "number", default: 1024, min: 256, max: 2048, step: 16 },
    { key: "height", label: "高度", type: "number", default: 1024, min: 256, max: 2048, step: 16 },
    { key: "seed", label: "种子 · -1 随机", type: "number", default: -1, min: -1, max: 2147483647, step: 1 },
    { key: "steps", label: "步数", type: "number", default: 10, min: 1, max: 50, step: 1, advanced: true },
    { key: "cfg", label: "CFG", type: "number", default: 1.2, min: 0, max: 10, step: 0.1, advanced: true },
  ],
  mapping: [
    { semantic: "prompt", nodeId: "positive", field: "text" },
    { semantic: "width", nodeId: "latent", field: "width" },
    { semantic: "height", nodeId: "latent", field: "height" },
    { semantic: "seed", nodeId: "sampler", field: "seed" },
    { semantic: "steps", nodeId: "sampler", field: "steps" },
    { semantic: "cfg", nodeId: "sampler", field: "cfg" },
  ],
  output: { kind: "image", nodeId: "save", field: "images" }, template,
}];
