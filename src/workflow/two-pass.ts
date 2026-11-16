import type { ApiWorkflow, WorkflowDefinition } from "../types";
import zimage from "./dfcine/zimage-two-pass.json" with { type: "json" };
import krea from "./dfcine/krea2-two-pass.json" with { type: "json" };

// Compile the mirror's fixed switch branches explicitly, so unused image
// placeholders are never validated or uploaded for text-only generation.
function recipe(isKrea: boolean, fromImage: boolean): WorkflowDefinition {
  const g = structuredClone(isKrea ? krea : zimage) as ApiWorkflow;
  const id = isKrea ? {
    save: "216", positive: "228", negative: "229", first: "231", second: "230",
    schedule: "227", image: "249", encode: "244", latent: "240", upscale: "226",
  } : {
    save: "975", positive: "971", negative: "970", first: "964", second: "966",
    schedule: "968", image: "979", encode: "980", latent: "965", upscale: "967",
  };
  g[id.first].inputs.latent_image = [fromImage ? id.encode : id.latent, 0];
  g[id.schedule].inputs.start_at_step = fromImage ? 5 : 0;
  g[id.save].class_type = "SaveImage";
  g[id.save].inputs.filename_prefix = "canvas/two-pass";
  g[id.positive].inputs.text = "";
  g[id.negative].inputs.text = "";
  g[id.upscale].inputs.width = 1536;
  g[id.upscale].inputs.height = 1536;
  g[id.latent].inputs.width = 1024;
  g[id.latent].inputs.height = 1024;
  if (isKrea) g["233"].inputs.clip_name = "qwen3vl_4b_bf16.safetensors";
  const keep = new Set<string>();
  function visit(key: string) {
    if (keep.has(key)) return;
    if (!g[key]) throw new Error("Missing recipe node: " + key);
    keep.add(key);
    for (const value of Object.values(g[key].inputs))
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") visit(value[0]);
  }
  visit(id.save);
  const family = isKrea ? "Krea2" : "Z-Image";
  return {
    id: (isKrea ? "krea2" : "zimage") + (fromImage ? "-image-two-pass" : "-text-two-pass"),
    family, name: `${family} ${fromImage ? "图生图" : "文生图"} · 两阶段`,
    description: "沿用镜像的两阶段采样与潜空间放大流程；第二阶段细化到指定输出尺寸。",
    mode: fromImage ? "image-to-image" : "text-to-image", requiredInputs: fromImage ? ["image"] : [], optionalInputs: ["prompt", "negativePrompt"],
    parameters: [
      ...(!fromImage ? [
        { key: "width", label: "初始宽度", type: "number" as const, default: 1024, min: 256, max: 2048, step: 16 },
        { key: "height", label: "初始高度", type: "number" as const, default: 1024, min: 256, max: 2048, step: 16 },
      ] : []),
      { key: "outputWidth", label: "输出宽度", type: "number", default: 1536, min: 256, max: 4096, step: 16 },
      { key: "outputHeight", label: "输出高度", type: "number", default: 1536, min: 256, max: 4096, step: 16 },
      { key: "seed", label: "种子 · -1 随机", type: "number", default: -1, min: -1, max: 2147483647, step: 1 },
    ],
    mapping: [
      { semantic: "prompt", nodeId: id.positive, field: "text" },
      { semantic: "negativePrompt", nodeId: id.negative, field: "text" },
      { semantic: "seed", nodeId: id.first, field: "noise_seed" },
      { semantic: "seed", nodeId: id.second, field: "noise_seed" },
      { semantic: "outputWidth", nodeId: id.upscale, field: "width" },
      { semantic: "outputHeight", nodeId: id.upscale, field: "height" },
      ...(fromImage ? [{ semantic: "image", nodeId: id.image, field: "image" }] : [
        { semantic: "width", nodeId: id.latent, field: "width" },
        { semantic: "height", nodeId: id.latent, field: "height" },
      ]),
    ],
    output: { kind: "image", nodeId: id.save, field: "images" },
    template: Object.fromEntries(Object.entries(g).filter(([key]) => keep.has(key))),
  };
}
export const twoPassWorkflows = [false, true].flatMap(krea => [false, true].map(image => recipe(krea, image)));
