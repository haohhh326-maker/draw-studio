import type { WorkflowDefinition, ApiWorkflow } from "../types";

// The mirror's Music3 advanced recipe, with caption/lyrics exposed directly to
// the canvas. Keep its tuning helper, shared seed, duration link and audio saver.
const template: ApiWorkflow = {
  model: { class_type: "UNETLoader", inputs: { unet_name: "minimax_music3_dit_fp16.safetensors", weight_dtype: "default" } },
  clip: { class_type: "CLIPLoader", inputs: { clip_name: "minimax_music3_text_encoder_pruned_int8_convrot.safetensors", type: "minimax", device: "default" } },
  vae: { class_type: "VAELoader", inputs: { vae_name: "minimax_music3_dav.safetensors" } },
  lyrics: { class_type: "VRGDG_Music3LyricsPrepare", inputs: { lyrics: "", normalise_headers: true, remove_metadata_lines: true } },
  tuning: { class_type: "VRGDG_Music3TuningPreset", inputs: { preset: "Balanced Quality" } },
  seed: { class_type: "VRGDG_Music3SeedBank", inputs: { base_seed: 58, spacing: 101 } },
  encode: { class_type: "MiniMaxMusic3TextEncode", inputs: { clip: ["clip", 0], caption: "", lyrics: ["lyrics", 0], seed: ["seed", 0], max_duration: 30, cfg_scale: ["tuning", 0], top_k: ["tuning", 1] } },
  strength: { class_type: "VRGDG_Music3ConditioningStrength", inputs: { conditioning: ["encode", 0], strength: ["tuning", 4] } },
  latent: { class_type: "EmptyMiniMaxMusic3LatentAudio", inputs: { seconds: ["encode", 1], batch_size: 1 } },
  negative: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["strength", 0] } },
  sampler: { class_type: "KSampler", inputs: { model: ["model", 0], seed: ["seed", 0], steps: ["tuning", 3], cfg: ["tuning", 2], sampler_name: "euler", scheduler: "simple", denoise: 1, positive: ["strength", 0], negative: ["negative", 0], latent_image: ["latent", 0] } },
  decode: { class_type: "VAEDecodeAudio", inputs: { samples: ["sampler", 0], vae: ["vae", 0] } },
  save: { class_type: "SaveAudioMP3", inputs: { audio: ["decode", 0], filename_prefix: "canvas/music3", quality: "V0" } },
};

export const musicWorkflows: WorkflowDefinition[] = [{
  id: "music3-song", family: "MiniMax Music3", name: "Music3 音乐与歌曲",
  description: "描述音乐风格，在歌词栏填写歌词；可选择镜像内置的音乐调校预设。",
  mode: "text-to-audio", requiredInputs: [], optionalInputs: ["prompt"],
  parameters: [
    { key: "duration", label: "最长时长 / 秒", type: "number", default: 30, min: 1, max: 360, step: 1 },
    { key: "seed", label: "种子 · -1 随机", type: "number", default: -1, min: -1, max: 2147483647, step: 1 },
    { key: "lyrics", label: "歌词（可含 [Verse] / [Chorus]）", type: "text", default: "", advanced: true, multiline: true },
    { key: "tuning", label: "音乐调校", type: "select", default: "Balanced Quality", options: ["Balanced / Built-in Baseline", "Balanced Quality", "Raw Live Rock", "Lyrics + Structure Focus", "Creative Variations", "Intimate + Dry", "Aggressive + Dense", "Conservative / Stable", "Strict Lyrics", "Strong Song Structure", "Creative Melody", "Maximum Arrangement Variation", "Stable / Low Artifact", "Strong Acoustic Plan", "Loose Acoustic Plan", "Detailed Rendering", "Long-Song Stability", "Fast Draft", "High-Energy / Dense", "Soft / Restrained"], advanced: true },
  ],
  mapping: [
    { semantic: "prompt", nodeId: "encode", field: "caption" },
    { semantic: "lyrics", nodeId: "lyrics", field: "lyrics" },
    { semantic: "duration", nodeId: "encode", field: "max_duration" },
    { semantic: "seed", nodeId: "seed", field: "base_seed" },
    { semantic: "tuning", nodeId: "tuning", field: "preset" },
  ],
  output: { kind: "audio", nodeId: "save", field: "audio" }, template,
}];
