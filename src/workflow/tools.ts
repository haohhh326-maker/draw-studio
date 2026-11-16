import type { WorkflowDefinition } from "../types";

export const toolWorkflows: WorkflowDefinition[] = [
  {
    id: "dataset-pack", family: "数据集", name: "图片与标注打包",
    description: "按连接顺序打包原图、对应 TXT 标注和清单；提示词作为统一标注，也可在高级参数逐行填写不同标注。",
    mode: "dataset", promptRequired: false, requiredInputs: ["images"], optionalInputs: ["prompt"],
    parameters: [{ key: "captions", label: "逐图标注（每行对应一张图片）", type: "text", default: "", multiline: true, advanced: true }],
    mapping: [
      { semantic: "images", nodeId: "dataset", field: "image_paths", serialization: "json-paths", maxItems: 64 },
      { semantic: "prompt", nodeId: "dataset", field: "caption" },
      { semantic: "captions", nodeId: "dataset", field: "captions" },
    ],
    output: { kind: "file", nodeId: "dataset", field: "files" },
    template: { dataset: { class_type: "CanvasDatasetBundle", inputs: { image_paths: "[]", caption: "", captions: "", filename_prefix: "canvas/dataset" } } },
  },
  {
    id: "transcribe-timestamped", family: "音频工具", name: "歌词转写 · 时间戳",
    description: "先提取人声，再生成带时间戳的歌词 JSON；提示词可填写已知歌词作为对齐参考。首次运行可能下载分离及转写模型。",
    mode: "audio-to-text", promptRequired: false, requiredInputs: ["referenceAudio"], optionalInputs: ["prompt"],
    parameters: [
      { key: "language", label: "语言", type: "select", default: "english", options: ["english", "chinese", "japanese", "korean", "french", "german", "spanish"] },
      { key: "model", label: "转写模型", type: "select", default: "large-v3", options: ["tiny", "base", "small", "medium", "large-v3"], advanced: true },
    ],
    mapping: [
      { semantic: "referenceAudio", nodeId: "audio", field: "audio" },
      { semantic: "prompt", nodeId: "transcribe", field: "reference_lyrics" },
      { semantic: "language", nodeId: "transcribe", field: "language" },
      { semantic: "model", nodeId: "transcribe", field: "model_name" },
    ],
    output: { nodeId: "text", field: "text", kind: "text" },
    template: {
      audio: { class_type: "LoadAudio", inputs: { audio: "" } },
      stems: { class_type: "VRGDG_GetStems", inputs: { model_name: "htdemucs_ft", device: "auto", audio_file_path: "", audio: ["audio", 0] } },
      transcribe: { class_type: "VRGDG_TimestampedLyricsExtractor", inputs: { reference_lyrics: "", model_name: "large-v3", language: "english", segment_mode: "reference_lines", include_instrumental_gaps: "[instrumental]", instrumental_text: "instrumental", min_gap_seconds: 1, audio: ["stems", 0] } },
      text: { class_type: "VRGDG_ShowText", inputs: { text: ["transcribe", 0] } },
    },
  },
  {
    id: "lyrics-prepare", family: "文本工具", name: "歌词整理",
    description: "规范歌词段落标题，移除风格和乐器等说明行；结果可连接到后续生成节点。",
    mode: "text-tool", requiredInputs: [], optionalInputs: ["prompt"],
    parameters: [
      { key: "headers", label: "规范段落标题", type: "boolean", default: true },
      { key: "metadata", label: "移除描述行", type: "boolean", default: true },
    ],
    mapping: [
      { semantic: "prompt", nodeId: "prepare", field: "lyrics" },
      { semantic: "headers", nodeId: "prepare", field: "normalise_headers" },
      { semantic: "metadata", nodeId: "prepare", field: "remove_metadata_lines" },
    ],
    output: { nodeId: "text", field: "text", kind: "text" },
    template: {
      prepare: { class_type: "VRGDG_Music3LyricsPrepare", inputs: { lyrics: "", normalise_headers: true, remove_metadata_lines: true } },
      text: { class_type: "VRGDG_ShowText", inputs: { text: ["prepare", 0] } },
    },
  },
];
