import { inferWorkflowFamily } from "./import-classification";

export function isLegacyImportFamily(family: string) {
  return !family.trim() || ["我的工作流", "自定义工作流", "图像生成", "图像编辑", "视频生成", "音频生成",
    "图像工具", "视频工具", "音频工具", "文本工具", "通用工具",
    "图像工作流", "视频工作流", "音频工作流", "文本工作流", "其他工作流"].includes(family.trim());
}

/** Reclassify the old automatic import bucket without replacing an explicit series. */
export function resolveWorkflowImportFamily(family: string, id: string, source?: unknown,
  options: { name?: string; kind?: string; models?: { name: string }[] } = {}) {
  if (!/^custom\.[a-f0-9]{16,64}$/.test(id) || !isLegacyImportFamily(family)) return family || "自定义工作流";
  // Registration/cache entries may have only verified weight references, not a graph.
  const evidence = source ?? Object.fromEntries((options.models ?? []).map((model, index) =>
    [String(index), { class_type: "ModelLoader", inputs: { model: model.name } }]));
  const inferred = inferWorkflowFamily(evidence, options);
  // An earlier automatic fallback is not a manually chosen model series. Upgrade
  // it when the graph identifies a model, but do not turn a saved generation
  // category into an unrelated generic tool bucket when evidence is unavailable.
  return family.trim() && !["我的工作流", "自定义工作流"].includes(family.trim()) && isLegacyImportFamily(inferred) ? family : inferred;
}
