import type { Mode, WorkflowDefinition } from "../types";
import originalConfigs from "./original-configs.json" with { type: "json" };
import { originalExecution } from "./original-execution.ts";

export type CanvasCategory = "music" | "image" | "video" | "text" | "pending";
type Entry = { key: string; name: string; mode: Mode; sharedKey?: string };
type Series = { id: string; name: string; workflows: Entry[] };
type DirectoryCanvas = {
  id: Exclude<CanvasCategory, "pending">;
  name: string;
  outputKind: "audio" | "image" | "video";
  series: Series[];
};

// The user's 2026-09-27 list is the only source of catalog membership and order.
// Names establish directory entries, not an executable API graph. Bindings must
// be verified against the matching original JSON; never infer them from a name.
export const dfcineDirectory: DirectoryCanvas[] = [
  {
    id: "music", name: "音乐画布", outputKind: "audio", series: [
      { id: "minimax-music", name: "MiniMax Music", workflows: [
        { key: "music3", name: "MiniMax Music 3", mode: "text-to-audio" },
      ] },
      { id: "voxcpm", name: "VoxCPM", workflows: [
        { key: "clone", name: "Vox 声音克隆", mode: "audio-to-audio" },
        { key: "design", name: "Vox 声音设计", mode: "text-to-audio" },
      ] },
    ],
  },
  {
    id: "image", name: "图像画布", outputKind: "image", series: [
      { id: "image-tools", name: "图像工具", workflows: [
        { key: "klein-upscale", name: "Klein 高清放大", mode: "image-to-image", sharedKey: "klein-upscale" },
        { key: "stitch", name: "图像拼接", mode: "image-to-image" },
        { key: "camera", name: "多视角相机", mode: "image-to-image" },
        { key: "seed-upscale", name: "Seed 高清放大", mode: "image-to-image" },
      ] },
      { id: "klein", name: "Klein 系列", workflows: [
        { key: "single-edit", name: "Klein 单图编辑", mode: "image-to-image" },
        { key: "double-edit", name: "Klein 双图编辑", mode: "image-to-image" },
        { key: "text", name: "Klein 文生图", mode: "text-to-image" },
        { key: "upscale", name: "Klein 高清放大", mode: "image-to-image", sharedKey: "klein-upscale" },
      ] },
      { id: "krea2", name: "Krea2", workflows: [
        { key: "dual-lora", name: "Krea2 双 LoRA", mode: "text-to-image" },
        { key: "high-quality", name: "Krea2 文生图高质量", mode: "text-to-image" },
        { key: "custom-lora", name: "Krea2 自定义 LoRA", mode: "text-to-image" },
        { key: "text", name: "Krea2 文生图", mode: "text-to-image" },
      ] },
      { id: "qwen", name: "Qwen 图像", workflows: [
        { key: "custom-single", name: "千问单图自定义", mode: "image-to-image" },
        { key: "single-edit", name: "千问单图编辑", mode: "image-to-image" },
        { key: "double-edit", name: "千问双图编辑", mode: "image-to-image" },
        { key: "triple-edit", name: "千问三图编辑", mode: "image-to-image" },
        { key: "cinematic", name: "千问电影艺术照片", mode: "text-to-image" },
        { key: "character-views", name: "千问角色三视图", mode: "image-to-image" },
      ] },
      { id: "zimage", name: "Zimage", workflows: [
        { key: "text", name: "Zimage 文生图", mode: "text-to-image" },
        { key: "japanese", name: "Zimage 日本风格", mode: "text-to-image" },
        { key: "lora", name: "Zimage LoRA", mode: "text-to-image" },
        { key: "lighting", name: "Zimage 写实光影", mode: "text-to-image" },
      ] },
    ],
  },
  {
    id: "video", name: "视频画布", outputKind: "video", series: [
      { id: "bernini", name: "Bernini", workflows: [
        { key: "double-edit-autodl", name: "Bernini 双图视频编辑（AutoDL）", mode: "reference-video" },
        { key: "image", name: "Bernini 图生视频", mode: "image-to-video" },
        { key: "single-edit-autodl", name: "Bernini 单图视频编辑（AutoDL）", mode: "reference-video" },
        { key: "image-edit", name: "Bernini 图像视频编辑", mode: "reference-video" },
        { key: "video-edit-autodl", name: "Bernini 纯视频编辑（AutoDL）", mode: "reference-video" },
        { key: "video-edit", name: "Bernini 视频编辑", mode: "reference-video" },
      ] },
      { id: "video-upscale", name: "视频超分工具", workflows: [
        { key: "flashvsr", name: "FlashVSR 视频超分", mode: "reference-video" },
        { key: "seedvr2-7b", name: "SEEDVR2 视频超分（标准 7B）", mode: "reference-video" },
        { key: "seedvr2-3b", name: "SEEDVR2 视频超分（简化 3B）", mode: "reference-video" },
      ] },
      { id: "ltx-msr", name: "LTX MSR", workflows: [
        { key: "two-images", name: "LTX MSR 多参双图", mode: "multi-reference" },
        { key: "audio-three-images", name: "LTX MSR 声音 3 图多参", mode: "multi-reference" },
        { key: "three-images", name: "LTX MSR 多参 3 图", mode: "multi-reference" },
        { key: "four-images", name: "LTX MSR 多参 4 图", mode: "multi-reference" },
      ] },
      { id: "ltx23", name: "LTX2.3", workflows: [
        { key: "first-middle-last", name: "LTX2.3 首中尾帧", mode: "multi-reference" },
        { key: "four-images", name: "LTX2.3 多参 4 图", mode: "multi-reference" },
        { key: "redraw", name: "LTX2.3 视频转绘", mode: "reference-video" },
        { key: "image", name: "LTX2.3 图生视频基础", mode: "image-to-video" },
        { key: "audio-driven", name: "LTX2.3 单人音频驱动", mode: "multi-reference" },
        { key: "remove-subtitles", name: "LTX2.3 去字幕", mode: "reference-video" },
        { key: "frames-audio", name: "LTX2.3 首尾帧 + 音频", mode: "first-last-frame" },
        { key: "frames", name: "LTX2.3 首尾帧", mode: "first-last-frame" },
      ] },
      { id: "remix", name: "Remix", workflows: [
        { key: "image", name: "Remix 图生视频", mode: "image-to-video" },
        { key: "frames", name: "Remix 首尾帧", mode: "first-last-frame" },
      ] },
      { id: "scail", name: "Scail", workflows: [
        { key: "three-images", name: "Scail 三图迁移", mode: "multi-reference" },
        { key: "character", name: "Scail 角色替换", mode: "reference-video" },
        { key: "motion", name: "Scail 动作迁移", mode: "reference-video" },
      ] },
      { id: "h3-standard", name: "MiniMax H3 标准", workflows: [
        { key: "image", name: "H3 图生视频（标准）", mode: "image-to-video" },
        { key: "references", name: "H3 多参视频（标准）", mode: "multi-reference" },
        { key: "frames", name: "H3 首尾帧视频（标准）", mode: "first-last-frame" },
        { key: "text", name: "H3 文生视频（标准）", mode: "text-to-video" },
        { key: "avatar-dual", name: "H3 数字人（双人）", mode: "multi-reference" },
        { key: "avatar-single", name: "H3 数字人（单人）", mode: "multi-reference" },
      ] },
      { id: "h3-accelerated", name: "MiniMax H3 加速", workflows: [
        { key: "image", name: "H3 图生视频（加速）", mode: "image-to-video" },
        { key: "references", name: "H3 多参视频（加速）", mode: "multi-reference" },
        { key: "frames", name: "H3 首尾帧视频（加速）", mode: "first-last-frame" },
        { key: "text", name: "H3 文生视频（加速）", mode: "text-to-video" },
      ] },
      { id: "h3-fast", name: "MiniMax H3 极速", workflows: [
        { key: "image", name: "H3 图生视频（8 步）", mode: "image-to-video" },
        { key: "references", name: "H3 多参视频（4 步）", mode: "multi-reference" },
        { key: "frames", name: "H3 首尾帧视频（8 步）", mode: "first-last-frame" },
        { key: "text", name: "H3 文生视频（8 步）", mode: "text-to-video" },
      ] },
    ],
  },
];

export const directoryCatalog: WorkflowDefinition[] = dfcineDirectory.flatMap((canvas) =>
  canvas.series.flatMap((series) => series.workflows.map((entry) => {
    const id = `dfcine-v2-${canvas.id}-${series.id}-${entry.key}`;
    const config = (originalConfigs as Record<string, Pick<WorkflowDefinition, "parameters" | "original">>)[id];
    const execution = originalExecution[id];
    return {
    id,
    name: entry.name,
    family: series.name,
    description: `${canvas.name} / ${series.name}`,
    directory: {
      version: 2,
      canvas: canvas.id,
      seriesId: series.id,
      bindingKey: entry.sharedKey ?? `${series.id}-${entry.key}`,
      bindingStatus: execution ? "bound" : "pending",
    },
    mode: entry.mode,
    requiredInputs: execution?.inputSlots?.filter(s => s.required).map(s => s.semantic) ?? [],
    optionalInputs: [],
    parameters: [...(config?.parameters ?? []), ...(execution?.textParameters ?? [])],
    original: config?.original,
    publicReference: entry.name === "FlashVSR 视频超分" ? {
      url: "https://www.digitfold.com/5464.html",
      note: "官方说明已找到，下载区需要登录。本机工作流包中未找到原始配置，参数和执行图待补齐。",
      modelDirectory: "models/FlashVSR-v1.1",
      modelNames: ["diffusion_pytorch_model_streaming_dmd.safetensors", "Wan2.1_VAE.pth", "LQ_proj_in.ckpt", "TCDecoder.ckpt"],
    } : undefined,
    mapping: execution?.mapping ?? [],
    template: execution?.template,
    inputSlots: execution?.inputSlots,
    dynamicReferences: execution?.dynamicReferences,
    promptRequired: execution?.promptRequired,
    output: execution?.output ?? { nodeId: "", field: canvas.outputKind === "audio" ? "audio" : "images", kind: canvas.outputKind },
    verification: "not-run",
  }; })),
);

export const directorySummary = dfcineDirectory.map((canvas) => ({
  id: canvas.id,
  name: canvas.name,
  series: canvas.series.length,
  workflows: canvas.series.reduce((sum, series) => sum + series.workflows.length, 0),
}));

export function categoryForKind(kind: string): CanvasCategory {
  return kind === "text" ? "text" : kind === "audio" ? "music" : kind === "image-generation" || kind === "tool" ? "image" : "video";
}

export function directoryEntryStatus(w: WorkflowDefinition) {
  if (w.library?.executionIssue) return "已加入目录 · 执行待接入";
  return w.template ? "原始工作流已绑定 · 未试跑" : w.original ? "配置已核对 · 执行图待接入" : "原始配置待补齐";
}
