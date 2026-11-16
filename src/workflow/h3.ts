import type { ApiWorkflow, WorkflowDefinition } from "../types";
import { dfcineWorkflows } from "./dfcine";

// Native H3 task conditioning and the image's existing reference-media loader.
// Input slots are never inferred from file names or a client-side filesystem path.
function prune(graph: ApiWorkflow, output: string) {
  const keep = new Set<string>();
  function visit(id: string) {
    if (keep.has(id)) return;
    const node = graph[id];
    if (!node) throw new Error("工作流连接不存在：" + id);
    keep.add(id);
    for (const v of Object.values(node.inputs))
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string")
        visit(v[0]);
  }
  visit(output);
  return Object.fromEntries(
    Object.entries(graph).filter(([id]) => keep.has(id)),
  );
}
function base(fast: boolean): WorkflowDefinition {
  const w = structuredClone(dfcineWorkflows[fast ? 2 : 0]);
  w.parameters.find((p) => p.key === "duration")!.default = 5;
  w.mapping = w.mapping.filter(
    (m) => !["image", "referenceImages"].includes(m.semantic),
  );
  w.parameters.push({
    key: "aspectRatio",
    label: "画幅",
    type: "select",
    default: "9:16 (Portrait Widescreen)",
    options: [
      "9:16 (Portrait Widescreen)",
      "16:9 (Widescreen)",
      "1:1 (Square)",
    ],
  });
  w.mapping.push({
    semantic: "aspectRatio",
    nodeId: "115",
    field: "aspect_ratio",
  });
  return w;
}
function frames(fast: boolean, count: number): WorkflowDefinition {
  const w = base(fast),
    graph = w.template!;
  const original = graph["136"].inputs;
  graph["136"] = {
    class_type: "MiniMaxH3ImageToVideo",
    inputs: Object.fromEntries(
      ["clip", "vae", "prompt", "width", "height", "length"].map((key) => [
        key,
        original[key],
      ]),
    ),
  };
  graph["127"].inputs.unet_name =
    "minimax_h3_fl2va_pruned_int8_convrot.safetensors";
  if (fast) {
    graph["153"].inputs.lora_name =
      "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors";
    graph["124"].inputs.steps = 8;
  }
  for (let i = 0; i < count; i++) {
    const id = "frame" + i;
    graph[id] = { class_type: "LoadImage", inputs: { image: "" } };
    graph["136"].inputs[i ? "last_frame" : "first_frame"] = [id, 0];
    w.mapping.push({
      semantic: count === 1 ? "image" : i ? "lastFrame" : "firstFrame",
      nodeId: id,
      field: "image",
    });
  }
  w.id =
    count === 1
      ? `h3-${fast ? "turbo" : "standard"}-first-frame`
      : `preset-${fast ? 1 : 0}-${count === 0 ? 0 : 2}`;
  w.mode =
    count === 0
      ? "text-to-video"
      : count === 1
        ? "image-to-video"
        : "first-last-frame";
  w.requiredInputs =
    count === 0 ? [] : count === 1 ? ["image"] : ["firstFrame", "lastFrame"];
  w.name = `H3 ${["文生视频", "首帧图生视频", "首尾帧视频"][count]} · ${fast ? 8 : 20} 步`;
  w.description =
    count === 0
      ? "文本生成画面和声音"
      : count === 1
        ? "以连接图片作为第一帧，生成后续画面"
        : "用两张图片分别固定视频的首帧与尾帧";
  w.template = prune(graph, "92");
  return w;
}
function references(
  fast: boolean,
  kind: "mixed" | "video" | "audio" | "driven",
): WorkflowDefinition {
  const w = base(fast),
    graph = w.template!;
  for (const key of Object.keys(graph["136"].inputs))
    if (key.startsWith("ref_") && key !== "ref_image_size")
      delete graph["136"].inputs[key];
  graph.media = {
    class_type: "VRGDG_MiniMaxH3ReferenceMediaFromPaths",
    inputs: { image_paths: "[]", video_references: "[]" },
  };
  for (let i = 0; i < 9; i++)
    graph["136"].inputs["ref_images.ref_image_" + i] = ["media", i];
  for (let i = 0; i < 3; i++)
    graph["136"].inputs["ref_videos.ref_video_" + i] = ["media", 9 + i];
  w.mapping.push(
    {
      semantic: "referenceImages",
      nodeId: "media",
      field: "image_paths",
      serialization: "json-paths",
      maxItems: 9,
    },
    {
      semantic: "referenceVideos",
      nodeId: "media",
      field: "video_references",
      serialization: "json-paths",
      maxItems: 3,
    },
  );
  w.requiredInputs =
    kind === "video"
      ? ["referenceVideos"]
      : kind === "mixed"
        ? ["references"]
        : ["referenceAudio"];
  w.optionalInputs = ["prompt", "referenceImages", "referenceVideos"];
  w.mode = kind === "video" ? "reference-video" : "multi-reference";
  if (kind === "audio" || kind === "driven") {
    graph.audio = { class_type: "LoadAudio", inputs: { audio: "" } };
    w.mapping.push({
      semantic: "referenceAudio",
      nodeId: "audio",
      field: "audio",
    });
    if (kind === "audio")
      graph["136"].inputs["ref_audios.ref_audio_0"] = ["audio", 0];
    else {
      graph.drive = {
        class_type: "VRGDG_MiniMaxH3AudioDrive",
        inputs: {
          av_latent: ["136", 1],
          source_audio: ["audio", 0],
          audio_vae: ["120", 0],
        },
      };
      graph["125"].inputs.latent_image = ["drive", 0];
      graph["130"].inputs.audio = ["drive", 1];
    }
  }
  w.id =
    kind === "video"
      ? `preset-${fast ? 1 : 0}-4`
      : `h3-${fast ? "turbo" : "standard"}-${kind}`;
  w.name = `H3 ${{ mixed: "多参考视频", video: "视频参考", audio: "音频参考视频", driven: "音频驱动视频" }[kind]} · ${fast ? 4 : 20} 步`;
  w.description = `${kind === "driven" ? "保留上传音轨并驱动画面；" : kind === "audio" ? "用上传音频作为声音参考；" : ""}最多 9 张图片、3 段参考视频，按连接顺序引用`;
  w.template = prune(graph, "92");
  return w;
}
export const h3Workflows: WorkflowDefinition[] = [false, true].flatMap(
  (fast) => [
    ...[0, 1, 2].map((count) => frames(fast, count)),
    ...(["mixed", "video", "audio", "driven"] as const).map((kind) =>
      references(fast, kind),
    ),
  ],
);
