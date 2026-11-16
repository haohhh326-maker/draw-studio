// Schema source: AIMixer/ComfyUI_MiniMaxH3_Director @
// 4c6245e518dd8a494f3afc4f3cccd53f22d82d10, nodes/director_common.py and nodes/director.py.
// Sampler/scheduler enums come from the remote ComfyUI runtime, never a guessed list.
export type DirectorNativeOptions = {
  samplerOptions?: readonly string[];
  schedulerOptions?: readonly string[];
  linkedInputs?: readonly string[];
};
type BaseSetting = {
  key: string;
  label: string;
  group: "sample" | "advanced" | "performance";
  help?: string;
  requiresInput?: string;
};
type NumberSetting = BaseSetting & {
  kind: "number";
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  upstreamMaximum?: string;
};
type SelectSetting = BaseSetting & {
  kind: "select";
  defaultValue: string;
  options?: readonly string[];
};
type BooleanSetting = BaseSetting & { kind: "boolean"; defaultValue: boolean };
type TextSetting = BaseSetting & { kind: "text"; defaultValue: string };
export type DirectorNativeSetting =
  NumberSetting | SelectSetting | BooleanSetting | TextSetting;

export const DIRECTOR_NATIVE_SETTINGS: readonly DirectorNativeSetting[] = [
  {
    key: "seed",
    label: "种子",
    group: "sample",
    kind: "number",
    defaultValue: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    integer: true,
    step: 1,
    upstreamMaximum: "18446744073709551615",
    help: "当前画布以 JSON 数字提交种子，可精确输入 0–9007199254740991。",
  },
  {
    key: "cfg",
    label: "CFG",
    group: "sample",
    kind: "number",
    defaultValue: 1,
    min: 0,
    max: 30,
    step: 0.01,
  },
  {
    key: "steps",
    label: "步数",
    group: "advanced",
    kind: "number",
    defaultValue: 25,
    min: 1,
    max: 200,
    integer: true,
    step: 1,
  },
  {
    key: "sampler",
    label: "采样器",
    group: "advanced",
    kind: "select",
    defaultValue: "res_multistep",
  },
  {
    key: "scheduler",
    label: "调度器",
    group: "advanced",
    kind: "select",
    defaultValue: "simple",
  },
  {
    key: "shift_video",
    label: "视频偏移",
    group: "advanced",
    kind: "number",
    defaultValue: 12,
    min: 0.01,
    max: 100,
    step: 0.01,
  },
  {
    key: "shift_audio",
    label: "音频偏移",
    group: "advanced",
    kind: "number",
    defaultValue: 3,
    min: 0.01,
    max: 100,
    step: 0.01,
  },
  {
    key: "clear_vram_between_segments",
    label: "段间清理显存",
    group: "performance",
    kind: "boolean",
    defaultValue: true,
    help: "每段结束后卸载模型并清空 CUDA 缓存。",
  },
  {
    key: "clear_vram_before_refine",
    label: "二采前清理显存",
    group: "performance",
    kind: "boolean",
    defaultValue: false,
    requiresInput: "refine",
  },
  {
    key: "clear_vram_before_face_refine",
    label: "修脸前清理显存",
    group: "performance",
    kind: "boolean",
    defaultValue: false,
    requiresInput: "face_refine",
  },
  {
    key: "cache_frames_codec",
    label: "帧缓存",
    group: "performance",
    kind: "select",
    defaultValue: "raw",
    options: ["raw", "ffv1"],
    help: "raw 读写较快；ffv1 无损压缩，节省磁盘但增加编解码。",
  },
  {
    key: "cache_name",
    label: "缓存名称",
    group: "performance",
    kind: "text",
    defaultValue: "",
    help: "留空使用原节点默认缓存目录。",
  },
];

export function directorNativeSettings(
  options: DirectorNativeOptions = {},
): readonly DirectorNativeSetting[] {
  return DIRECTOR_NATIVE_SETTINGS.filter(
    (field) =>
      !field.requiresInput ||
      options.linkedInputs?.includes(field.requiresInput),
  );
}

export function directorNativeSettingDisabled(
  field: DirectorNativeSetting,
  options: DirectorNativeOptions = {},
): string | undefined {
  if (
    (field.key === "steps" || field.key === "scheduler") &&
    options.linkedInputs?.includes("sigmas")
  )
    return "已连接外部 sigmas，步数和调度器由外部噪声表决定。";
}

export function directorNativeChoices(
  field: SelectSetting,
  value: unknown,
  options: DirectorNativeOptions = {},
): readonly string[] {
  if (field.options) return field.options;
  const runtime =
    field.key === "sampler" ? options.samplerOptions : options.schedulerOptions;
  const current =
    typeof value === "string" && value.trim() ? value : field.defaultValue;
  return [
    ...new Set([
      current,
      ...(runtime ?? []).filter(
        (item) => typeof item === "string" && item.trim(),
      ),
    ]),
  ];
}

export function directorNativeSettingPatch(
  key: string,
  raw: unknown,
  values: Record<string, unknown>,
  options: DirectorNativeOptions = {},
): Record<string, string | number | boolean> {
  const field = directorNativeSettings(options).find(
    (item) => item.key === key,
  );
  if (!field) throw new Error("此项不是当前工作流可编辑的原生参数。");
  const disabled = directorNativeSettingDisabled(field, options);
  if (disabled) throw new Error(disabled);
  if (field.kind === "number") {
    if (
      (typeof raw !== "number" && typeof raw !== "string") ||
      (typeof raw === "string" && !raw.trim())
    )
      throw new Error("请输入数值。");
    const value = Number(raw);
    if (
      !Number.isFinite(value) ||
      value < field.min ||
      value > field.max ||
      (field.integer && !Number.isSafeInteger(value))
    )
      throw new Error(
        `${field.label}须为 ${field.min}–${field.max} 范围内的${field.integer ? "整数" : "数值"}。`,
      );
    return { [key]: value };
  }
  if (field.kind === "boolean") {
    if (typeof raw !== "boolean") throw new Error("请选择开启或关闭。");
    return { [key]: raw };
  }
  if (typeof raw !== "string") throw new Error("请输入文本值。");
  if (
    field.kind === "select" &&
    !directorNativeChoices(field, values[key], options).includes(raw)
  )
    throw new Error("请选择工作流提供的有效选项。");
  return { [key]: raw };
}
