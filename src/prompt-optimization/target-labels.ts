import type { OptimizationTarget } from "./types";

const modelNames: Record<string, string> = {
  "minimax-h3": "MiniMax H3", "minimax-music3": "MiniMax Music3",
  "flux-2-klein": "FLUX.2 Klein", "flux-2": "FLUX.2", "flux-1": "FLUX.1",
  "qwen-image-2.1": "Qwen Image 2.1", "qwen-image-edit-2511": "Qwen Image Edit 2511",
  "qwen-image-2512": "Qwen Image 2512", "qwen-image": "Qwen Image",
  "krea-2": "Krea 2", "z-image": "Z-Image", "ltx-2.3": "LTX 2.3",
  "wan-2.2": "Wan 2.2", "wan-2.2-bernini": "Wan 2.2 Bernini", "wan-2.2-remix": "Wan 2.2 Remix",
  "wan-2.1-scail2": "SCAIL2", "voxcpm-2": "VoxCPM2", "gpt-image-2": "GPT Image 2",
  "nano-banana-pro": "Nano Banana Pro", "grok-video": "Grok Video", "wan-2.7": "Wan 2.7",
};
const taskNames: Record<string, string> = {
  "text": "文本润色", "text-tool": "文本润色", "text-to-image": "文生图",
  "image-to-image": "图像编辑", "style-transfer": "风格参考", "text-to-video": "文生视频",
  "image-to-video": "图生视频", "first-last-frame": "首尾帧视频", "last-frame": "尾帧视频",
  "multi-reference": "多素材参考", "reference-video": "视频参考", "video-to-video": "视频编辑",
  "motion-transfer": "动作参考", "audio-to-video": "音频驱动视频", "text-to-audio": "音乐描述",
  "audio-to-audio": "音频参考", "text-to-speech": "朗读正文", "audio-to-text": "音频转写",
  "camera-angle": "相机角度", "utility": "工具控制",
};
export const optimizationModelLabel = (target: OptimizationTarget) => modelNames[target.modelKey ?? ""] ?? target.modelKey ?? target.family ?? target.model;
export const optimizationTaskLabel = (target: OptimizationTarget) => target.promptContract === "verbatim" ? "朗读正文"
  : target.promptContract === "utility" ? "工具控制" : taskNames[target.mode] ?? target.mode;
