import type { WorkflowDefinition, ApiWorkflow } from "../types";

// VoxCPM2 node contract from the running mirror; voice inputs use the standard
// upload API and LoadAudio. The final saver scopes the downloaded result by task.
function speech(mode: string, label: string): WorkflowDefinition {
  const needsAudio = ["controllable_clone", "ultimate_clone", "prompt_continuation"].includes(mode);
  const needsTranscript = ["ultimate_clone", "prompt_continuation"].includes(mode);
  const template: ApiWorkflow = {
    speech: { class_type: "VRGDG_VoxCPM2Generate", inputs: {
      text: "", mode, device: "auto", cfg_value: 2, inference_timesteps: 10,
      load_denoiser: false, normalize_text: false, retry_badcase: true,
      retry_badcase_max_times: 3, retry_badcase_ratio_threshold: 6,
      min_len: 2, max_len: 4096, save_filename_prefix: "canvas/voxcpm2",
      prompt_text: "", reference_audio_path: "", prompt_audio_path: "",
    } },
    save: { class_type: "SaveAudioMP3", inputs: { audio: ["speech", 0], filename_prefix: "canvas/voxcpm2", quality: "V0" } },
  };
  if (needsAudio) {
    template.audio = { class_type: "LoadAudio", inputs: { audio: "" } };
    template.speech.inputs[mode === "prompt_continuation" ? "prompt_audio" : "reference_audio"] = ["audio", 0];
    if (mode === "ultimate_clone") template.speech.inputs.prompt_audio = ["audio", 0];
  }
  return {
    id: "voxcpm2-" + mode, family: "VoxCPM2", name: label,
    description: needsTranscript ? "连接参考音频并填写其准确转写；提示词中输入新文本。" : needsAudio ? "连接单人参考音频，在提示词中输入要朗读的新文本。" : "输入要朗读的文本；首次运行需要云端已缓存或可下载 VoxCPM2 模型。",
    mode: needsAudio ? "audio-to-audio" : "text-to-audio",
    requiredInputs: needsAudio ? ["referenceAudio"] : [], optionalInputs: ["prompt"],
    parameters: [
      { key: "steps", label: "步数", type: "number", default: 10, min: 1, max: 200, step: 1 },
      { key: "cfg", label: "语音引导强度", type: "number", default: 2, min: 0, max: 20, step: 0.1 },
      ...(needsTranscript ? [{ key: "transcript", label: "参考音频准确转写", type: "text" as const, default: "", multiline: true, required: true }] : []),
      { key: "normalize", label: "规范数字与日期读法", type: "boolean", default: false, advanced: true },
      { key: "maxLength", label: "最大语音 token 数", type: "number", default: 4096, min: 32, max: 16384, step: 1, advanced: true },
    ],
    mapping: [
      { semantic: "prompt", nodeId: "speech", field: "text" },
      { semantic: "steps", nodeId: "speech", field: "inference_timesteps" },
      { semantic: "cfg", nodeId: "speech", field: "cfg_value" },
      { semantic: "normalize", nodeId: "speech", field: "normalize_text" },
      { semantic: "maxLength", nodeId: "speech", field: "max_len" },
      ...(needsTranscript ? [{ semantic: "transcript", nodeId: "speech", field: "prompt_text" }] : []),
      ...(needsAudio ? [{ semantic: "referenceAudio", nodeId: "audio", field: "audio" }] : []),
    ],
    output: { kind: "audio", nodeId: "save", field: "audio", prefix: { nodeId: "save", field: "filename_prefix" } }, template,
  };
}
export const speechWorkflows = [
  speech("text_to_speech", "VoxCPM2 文本朗读"),
  speech("voice_design", "VoxCPM2 声音设计"),
  speech("controllable_clone", "VoxCPM2 参考声音"),
  speech("prompt_continuation", "VoxCPM2 语音续写"),
  speech("ultimate_clone", "VoxCPM2 精细声音复刻"),
];
