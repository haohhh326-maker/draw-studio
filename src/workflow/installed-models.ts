import type { ApiWorkflow, Parameter, WorkflowDefinition } from "../types";

// Explicit adaptations for weights present in the audited image. These graphs
// have not been executed; the source-workflow library is retained separately.
const seed: Parameter = {
  key: "seed",
  label: "种子 · -1 随机",
  type: "number",
  default: -1,
  min: -1,
  max: 2147483647,
  advanced: true,
};
const dimensions: Parameter[] = [
  {
    key: "width",
    label: "宽度",
    type: "number",
    default: 832,
    min: 64,
    max: 4096,
    step: 32,
  },
  {
    key: "height",
    label: "高度",
    type: "number",
    default: 480,
    min: 64,
    max: 4096,
    step: 32,
  },
];
const node = (class_type: string, inputs: Record<string, unknown>) => ({
  class_type,
  inputs,
});

function wan(
  profile: "bernini" | "bernini-r",
  frames: 0 | 1 | 2,
): WorkflowDefinition {
  const accelerated = profile === "bernini-r";
  const graph: ApiWorkflow = {
    high: node("UNETLoader", {
      unet_name: accelerated
        ? "wan2.2_bernini_r_high_noise_fp8_scaled.safetensors"
        : "Wan22_Bernini_HIGH_fp8_e4m3fn_scaled.safetensors",
      weight_dtype: "default",
    }),
    low: node("UNETLoader", {
      unet_name: accelerated
        ? "wan2.2_bernini_r_low_noise_fp8_scaled.safetensors"
        : "Wan22_Bernini_LOW_fp8_e4m3fn_scaled.safetensors",
      weight_dtype: "default",
    }),
    clip: node("CLIPLoader", {
      clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
      type: "wan",
      device: "default",
    }),
    vae: node("VAELoader", { vae_name: "Wan2_1_VAE_bf16.safetensors" }),
    positive: node("CLIPTextEncode", { clip: ["clip", 0], text: "" }),
    negative: node("CLIPTextEncode", { clip: ["clip", 0], text: "" }),
    high_shift: node("ModelSamplingSD3", {
      model: [accelerated ? "high_lora" : "high", 0],
      shift: 8,
    }),
    low_shift: node("ModelSamplingSD3", {
      model: [accelerated ? "low_lora" : "low", 0],
      shift: 8,
    }),
    latent: node(
      frames === 2 ? "WanFirstLastFrameToVideo" : "WanImageToVideo",
      {
        positive: ["positive", 0],
        negative: ["negative", 0],
        vae: ["vae", 0],
        width: 832,
        height: 480,
        length: 81,
        batch_size: 1,
      },
    ),
    first_pass: node("KSamplerAdvanced", {
      model: ["high_shift", 0],
      positive: ["latent", 0],
      negative: ["latent", 1],
      latent_image: ["latent", 2],
      add_noise: "enable",
      noise_seed: 0,
      steps: accelerated ? 8 : 20,
      cfg: accelerated ? 1 : 4,
      sampler_name: "euler",
      scheduler: "simple",
      start_at_step: 0,
      end_at_step: accelerated ? 4 : 10,
      return_with_leftover_noise: "enable",
    }),
    second_pass: node("KSamplerAdvanced", {
      model: ["low_shift", 0],
      positive: ["latent", 0],
      negative: ["latent", 1],
      latent_image: ["first_pass", 0],
      add_noise: "disable",
      noise_seed: 0,
      steps: accelerated ? 8 : 20,
      cfg: accelerated ? 1 : 4,
      sampler_name: "euler",
      scheduler: "simple",
      start_at_step: accelerated ? 4 : 10,
      end_at_step: accelerated ? 8 : 20,
      return_with_leftover_noise: "disable",
    }),
    decode: node("VAEDecode", { samples: ["second_pass", 0], vae: ["vae", 0] }),
    video: node("CreateVideo", { images: ["decode", 0], fps: 16 }),
    save: node("SaveVideo", {
      video: ["video", 0],
      filename_prefix: "canvas/wan",
      format: "auto",
      codec: "auto",
    }),
  };
  if (accelerated) {
    graph.high_lora = node("LoraLoaderModelOnly", {
      model: ["high", 0],
      lora_name: "Bernini-R_LightX2V_high_noise.safetensors",
      strength_model: 1,
    });
    graph.low_lora = node("LoraLoaderModelOnly", {
      model: ["low", 0],
      lora_name: "Bernini-R_LightX2V_low_noise.safetensors",
      strength_model: 1,
    });
  }
  const mapping: WorkflowDefinition["mapping"] = [
    { semantic: "prompt", nodeId: "positive", field: "text" },
    { semantic: "negativePrompt", nodeId: "negative", field: "text" },
    { semantic: "seed", nodeId: "first_pass", field: "noise_seed" },
    { semantic: "seed", nodeId: "second_pass", field: "noise_seed" },
    { semantic: "width", nodeId: "latent", field: "width" },
    { semantic: "height", nodeId: "latent", field: "height" },
    { semantic: "frames", nodeId: "latent", field: "length" },
    { semantic: "fps", nodeId: "video", field: "fps" },
    ...["first_pass", "second_pass"].flatMap((nodeId) => [
      { semantic: "steps", nodeId, field: "steps" },
      { semantic: "cfg", nodeId, field: "cfg" },
    ]),
    { semantic: "switchStep", nodeId: "first_pass", field: "end_at_step" },
    { semantic: "switchStep", nodeId: "second_pass", field: "start_at_step" },
    { semantic: "steps", nodeId: "second_pass", field: "end_at_step" },
  ];
  if (frames) {
    graph.first = node("LoadImage", { image: "" });
    graph.latent.inputs.start_image = ["first", 0];
    mapping.push({
      semantic: frames === 2 ? "firstFrame" : "image",
      nodeId: "first",
      field: "image",
    });
  }
  if (frames === 2) {
    graph.last = node("LoadImage", { image: "" });
    graph.latent.inputs.end_image = ["last", 0];
    mapping.push({ semantic: "lastFrame", nodeId: "last", field: "image" });
  }
  return {
    id: `wan22-${profile}-${frames}`,
    family: "Wan 2.2 Bernini",
    name: `${accelerated ? "Bernini-R" : "Bernini"} · ${["文生视频", "图生视频", "首尾帧"][frames]}`,
    description:
      "镜像已有权重的原生双模型采样适配；支持高低噪声切换，尚未试跑。",
    verification: "not-run",
    mode:
      frames === 2
        ? "first-last-frame"
        : frames
          ? "image-to-video"
          : "text-to-video",
    requiredInputs:
      frames === 2 ? ["firstFrame", "lastFrame"] : frames ? ["image"] : [],
    optionalInputs: ["prompt", "negativePrompt"],
    parameters: [
      ...dimensions,
      seed,
      {
        key: "frames",
        label: "帧数 · 4n+1",
        type: "number",
        default: 81,
        min: 5,
        max: 401,
        step: 4,
      },
      {
        key: "fps",
        label: "FPS",
        type: "number",
        default: 16,
        min: 1,
        max: 60,
        advanced: true,
      },
      {
        key: "steps",
        label: "总步数",
        type: "number",
        default: accelerated ? 8 : 20,
        min: 2,
        max: 100,
        advanced: true,
      },
      {
        key: "switchStep",
        label: "高低噪声切换步",
        type: "number",
        default: accelerated ? 4 : 10,
        min: 1,
        max: 99,
        advanced: true,
      },
      {
        key: "cfg",
        label: "引导强度",
        type: "number",
        default: accelerated ? 1 : 4,
        min: 0,
        max: 20,
        step: 0.1,
        advanced: true,
      },
    ],
    mapping,
    template: graph,
    output: { nodeId: "save", field: "images", kind: "video" },
  };
}

function qwen(count: number): WorkflowDefinition {
  const graph: ApiWorkflow = {
    model: node("UNETLoader", {
      unet_name: "qwen_image_edit_2511_fp8mixed.safetensors",
      weight_dtype: "default",
    }),
    lora: node("LoraLoaderModelOnly", {
      model: ["model", 0],
      lora_name: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
      strength_model: 1,
    }),
    shift: node("ModelSamplingAuraFlow", { model: ["lora", 0], shift: 3.1 }),
    clip: node("CLIPLoader", {
      clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
      type: "qwen_image",
      device: "default",
    }),
    vae: node("VAELoader", { vae_name: "qwen_image_vae.safetensors" }),
    positive: node("TextEncodeQwenImageEditPlus", {
      clip: ["clip", 0],
      vae: ["vae", 0],
      prompt: "",
    }),
    negative: node("ConditioningZeroOut", { conditioning: ["positive", 0] }),
    latent: node("VAEEncode", { pixels: ["scale1", 0], vae: ["vae", 0] }),
    sample: node("KSampler", {
      model: ["shift", 0],
      positive: ["positive", 0],
      negative: ["negative", 0],
      latent_image: ["latent", 0],
      seed: 0,
      steps: 4,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
    }),
    decode: node("VAEDecode", { samples: ["sample", 0], vae: ["vae", 0] }),
    save: node("SaveImage", {
      images: ["decode", 0],
      filename_prefix: "canvas/qwen-edit",
    }),
  };
  const mapping: WorkflowDefinition["mapping"] = [
    { semantic: "prompt", nodeId: "positive", field: "prompt" },
    { semantic: "seed", nodeId: "sample", field: "seed" },
    { semantic: "steps", nodeId: "sample", field: "steps" },
  ];
  for (let i = 1; i <= count; i++) {
    graph["image" + i] = node("LoadImage", { image: "" });
    graph["scale" + i] = node("ImageScaleToTotalPixels", {
      image: ["image" + i, 0],
      upscale_method: "lanczos",
      megapixels: 1,
      resolution_steps: 32,
    });
    graph.positive.inputs["image" + i] = ["scale" + i, 0];
    mapping.push(
      {
        semantic: "referenceImages",
        index: i - 1,
        nodeId: "image" + i,
        field: "image",
      },
      { semantic: "megapixels", nodeId: "scale" + i, field: "megapixels" },
    );
  }
  return {
    id: `qwen-edit-2511-${count}`,
    family: "Qwen Image Edit",
    name: `Qwen 2511 · ${count} 图编辑`,
    description:
      "镜像已有 Qwen 2511 与 4 步 LoRA，按连线顺序读取参考图；尚未试跑。",
    verification: "not-run",
    mode: "image-to-image",
    requiredInputs: ["referenceImages"],
    optionalInputs: ["prompt"],
    parameters: [
      seed,
      {
        key: "megapixels",
        label: "输入百万像素",
        type: "number",
        default: 1,
        min: 0.1,
        max: 4,
        step: 0.1,
      },
      {
        key: "steps",
        label: "步数",
        type: "number",
        default: 4,
        min: 1,
        max: 50,
        advanced: true,
      },
    ],
    mapping,
    template: graph,
    output: { nodeId: "save", field: "images", kind: "image" },
  };
}

function flux(reference: boolean): WorkflowDefinition {
  const graph: ApiWorkflow = {
    model: node("UNETLoader", {
      unet_name: "flux-2-klein-9b-fp8.safetensors",
      weight_dtype: "default",
    }),
    clip: node("CLIPLoader", {
      clip_name: "qwen_3_8b_fp8mixed.safetensors",
      type: "flux2",
      device: "default",
    }),
    vae: node("VAELoader", { vae_name: "flux2-vae.safetensors" }),
    positive: node("CLIPTextEncode", { clip: ["clip", 0], text: "" }),
    negative: node("ConditioningZeroOut", { conditioning: ["positive", 0] }),
    latent: node("EmptyFlux2LatentImage", {
      width: 1024,
      height: 1024,
      batch_size: 1,
    }),
    noise: node("RandomNoise", { noise_seed: 0 }),
    scheduler: node("Flux2Scheduler", { steps: 8, width: 1024, height: 1024 }),
    sampler: node("KSamplerSelect", { sampler_name: "euler" }),
    guider: node("CFGGuider", {
      model: ["model", 0],
      positive: [reference ? "references" : "positive", 0],
      negative: [reference ? "references" : "negative", reference ? 1 : 0],
      cfg: 1,
    }),
    sample: node("SamplerCustomAdvanced", {
      noise: ["noise", 0],
      guider: ["guider", 0],
      sampler: ["sampler", 0],
      sigmas: ["scheduler", 0],
      latent_image: ["latent", 0],
    }),
    decode: node("VAEDecode", { samples: ["sample", 0], vae: ["vae", 0] }),
    save: node("SaveImage", {
      images: ["decode", 0],
      filename_prefix: "canvas/flux-klein",
    }),
  };
  if (reference)
    graph.references = node("VRGDG_MultiReferenceConditioningFromPaths", {
      positive: ["positive", 0],
      negative: ["negative", 0],
      vae: ["vae", 0],
      image_paths: "[]",
      upscale_method: "lanczos",
      megapixels: 1,
      resolution_steps: 32,
    });
  return {
    id: "flux-klein-9b-" + (reference ? "reference" : "text"),
    family: "Flux Klein",
    name: "Klein 9B · " + (reference ? "多图参考" : "文生图"),
    description: "镜像已有 Klein 9B、Qwen 8B 编码器与 Flux2 VAE；尚未试跑。",
    verification: "not-run",
    mode: reference ? "image-to-image" : "text-to-image",
    requiredInputs: reference ? ["referenceImages"] : [],
    optionalInputs: ["prompt"],
    parameters: [
      ...dimensions.map((p) => ({ ...p, default: 1024 })),
      seed,
      {
        key: "steps",
        label: "步数",
        type: "number",
        default: 8,
        min: 1,
        max: 100,
        advanced: true,
      },
    ],
    mapping: [
      { semantic: "prompt", nodeId: "positive", field: "text" },
      { semantic: "seed", nodeId: "noise", field: "noise_seed" },
      { semantic: "steps", nodeId: "scheduler", field: "steps" },
      ...["latent", "scheduler"].flatMap((nodeId) => [
        { semantic: "width", nodeId, field: "width" },
        { semantic: "height", nodeId, field: "height" },
      ]),
      ...(reference
        ? [
            {
              semantic: "referenceImages",
              nodeId: "references",
              field: "image_paths",
              serialization: "json-paths" as const,
              maxItems: 9,
            },
          ]
        : []),
    ],
    template: graph,
    output: { nodeId: "save", field: "images", kind: "image" },
  };
}

export const installedModelWorkflows: WorkflowDefinition[] = [
  ...(["bernini", "bernini-r"] as const).flatMap((profile) =>
    ([0, 1, 2] as const).map((frames) => wan(profile, frames)),
  ),
  ...[1, 2, 3].map(qwen),
  flux(false),
  flux(true),
];
