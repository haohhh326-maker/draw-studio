import { inferWorkflowFamily, inferWorkflowModelNames } from "./import-classification";

/** A Windows-safe readable directory component, never a source-supplied path. */
export function safeWorkflowFolderStem(value: string): string {
  const stem = value.normalize("NFKC").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ").replace(/-+/g, "-").replace(/^[. -]+|[. -]+$/g, "").slice(0, 96).replace(/[. ]+$/g, "");
  if (!stem) return "导入工作流";
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) || stem.startsWith(".canvas-import-") ? "工作流-" + stem : stem;
}

/** Only model fields on the executed generation branch contribute model names. */
export function workflowModelFolderStem(source: unknown, options: { name?: string; kind?: string; family?: string; outputNodeIds?: string[] } = {}): string {
  const models = inferWorkflowModelNames(source, options).map(model =>
    model.replace(/\\/g, "/").split("/").pop()!.replace(/\.(?:safetensors|gguf|pt|pth|ckpt|bin|onnx)$/i, ""));
  if (models.length) return safeWorkflowFolderStem([...new Set(models)].slice(0, 3).join(" + "));
  const inferred = inferWorkflowFamily(source, options);
  const family = options.family?.trim();
  const specific = family && !["通用工具", "图像工具", "视频工具", "音频工具", "文本工具", "图像生成", "图像编辑", "视频生成", "音频生成", "我的工作流", "自定义工作流"].includes(family) ? family : undefined;
  return safeWorkflowFolderStem(specific ?? (options.name?.trim() || inferred));
}
