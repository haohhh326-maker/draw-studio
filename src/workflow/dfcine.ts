import type { ApiWorkflow, WorkflowDefinition } from "../types";
import standardOne from "./dfcine/standard-1image.json" with { type: "json" };
import standardTwo from "./dfcine/standard-2image.json" with { type: "json" };
import turboOne from "./dfcine/turbo-1image.json" with { type: "json" };
import turboTwo from "./dfcine/turbo-2image.json" with { type: "json" };

// Derived from successful MP4 API graphs audited on 2026-09-21.
// Keep model, sampler, resolution, frame alignment and SaveVideo links intact.
export const dfcineWorkflows: WorkflowDefinition[] = [
  standardOne,
  standardTwo,
  turboOne,
  turboTwo,
].map((source, i) => {
  const fast = i >= 2,
    two = i % 2 === 1;
  const template = source as ApiWorkflow;
  const refs = template["136"].inputs;
  const loaders = [0, ...(two ? [1] : [])].map(
    (index) => (refs["ref_images.ref_image_" + index] as [string, number])[0],
  );
  return {
    id: `preset-${fast ? 1 : 0}-${two ? 3 : 1}`,
    family: fast ? "MiniMax H3 加速" : "MiniMax H3 标准",
    name: `H3 ${two ? "双图参考" : "单图参考"} · ${fast ? 4 : 20} 步`,
    description: `${two ? "连接两张" : "连接一张"}图片和文本，生成 9:16 视频；沿用 DFCine 成片配方。`,
    mode: two ? "multi-reference" : "image-to-video",
    requiredInputs: [two ? "referenceImages" : "image"],
    optionalInputs: ["prompt"],
    parameters: [
      {
        key: "duration",
        label: "时长 / 秒（按模型帧数对齐）",
        type: "number",
        default: template["132"].inputs.value as number,
        min: 1,
        max: 15,
        step: 1,
      },
      {
        key: "seed",
        label: "种子 · -1 随机",
        type: "number",
        default: -1,
        min: -1,
        max: 2147483647,
        step: 1,
      },
      {
        key: "megapixels",
        label: "分辨率 / 百万像素",
        type: "number",
        default: template["115"].inputs.megapixels as number,
        min: 0.6,
        max: 1,
        step: 0.1,
        advanced: true,
      },
    ],
    mapping: [
      { semantic: "prompt", nodeId: "138", field: "value" },
      { semantic: "duration", nodeId: "132", field: "value" },
      { semantic: "seed", nodeId: "129", field: "noise_seed" },
      { semantic: "megapixels", nodeId: "115", field: "megapixels" },
      ...loaders.map((nodeId, index) => ({
        semantic: two ? "referenceImages" : "image",
        nodeId,
        field: "image_path",
        ...(two ? { index } : {}),
        pathMode: "comfy-input" as const,
      })),
    ],
    output: {
      nodeId: "92",
      field: "images",
      kind: "video",
      prefix: { nodeId: "92", field: "filename_prefix" },
    },
    template,
  };
});
