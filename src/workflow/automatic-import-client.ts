import type { Connection } from "../types";
import { prepareAutomaticWorkflowImport, type AutomaticImportOptions } from "./automatic-import";
import { applyImportReview, restorePublishedImportPrompt, type ImportBindingReview } from "./import-review";
import { readPublishedWorkflowPrompt } from "./automatic-prompt-binding";
import { readWorkflowImportSource, saveWorkflowImport, type WorkflowImportSource } from "./import-client";
import type { PreparedWorkflowImport } from "./import-pipeline";
import { isLegacyImportFamily } from "./import-category";
import { localized } from "./library-converter";

const automaticOutputCategories = new Set(["其他工作流", "图像工作流", "视频工作流", "音频工作流", "文本工作流"]);

function retainPresentation(prepared: PreparedWorkflowImport, saved: WorkflowImportSource) {
  const legacyId = typeof saved.config.id === "string" && /^custom\.[a-f0-9]{16,63}$/.test(saved.config.id);
  if (saved.config.id !== prepared.config.id && !(legacyId && JSON.stringify(saved.source) === JSON.stringify(prepared.source))) throw new Error("原始工作流 ID 不一致，停止更新。");
  const config = { ...prepared.config };
  if (saved.config.importBindingReview && prepared.importState.status !== "ready")
    throw new Error("此次读取未完成转换，已保留原工作流和已确认绑定，请补齐节点定义或使用 API JSON 后重试。");
  config.id = saved.config.id;
  const savedReader = saved.config.importReader as { repository?: unknown } | undefined;
  const currentReader = prepared.config.importReader as { repository?: unknown } | undefined;
  const savedCategory = localized(saved.config.primaryCategoryLabel).trim();
  const refreshLegacyCategory = isLegacyImportFamily(savedCategory) && !automaticOutputCategories.has(savedCategory);
  const refreshAutomaticCategory = !saved.config.importBindingReview
    && typeof savedReader?.repository === "string" && savedReader.repository === currentReader?.repository
    && automaticOutputCategories.has(savedCategory);
  for (const key of ["nameLabel", "primaryCategoryLabel", "description", "docs", "promptPlaceholder"]) {
    if (saved.config[key] === undefined || key === "primaryCategoryLabel" && /^custom\.[a-f0-9]{16,64}$/.test(String(saved.config.id))
      && (refreshLegacyCategory || refreshAutomaticCategory)) continue;
    config[key] = structuredClone(saved.config[key]);
  }
  let retained = { ...prepared, config };
  const savedPrompt = readPublishedWorkflowPrompt(saved.config.importPublishedPrompt);
  if (savedPrompt && !readPublishedWorkflowPrompt(config.importPublishedPrompt)) {
    if (prepared.importState.status === "pending") config.importPublishedPrompt = savedPrompt;
    else retained = restorePublishedImportPrompt(retained, savedPrompt);
  }
  const review = prepared.config.importBindingReview ?? saved.config.importBindingReview;
  return review && prepared.importState.status === "ready" ? applyImportReview(retained, review as ImportBindingReview) : retained;
}

/** An identical import can receive new plugin results without losing its title. */
export async function saveAutomaticWorkflowImport(prepared: PreparedWorkflowImport, signal: AbortSignal, existing?: WorkflowImportSource) {
  signal.throwIfAborted();
  if (!existing) {
    const saved = await saveWorkflowImport({ ...prepared, reuseExisting: true }, signal);
    signal.throwIfAborted();
    if (!saved.reused) return { prepared, saved };
    existing = await readWorkflowImportSource(saved.workflowId, signal);
    signal.throwIfAborted();
  }
  prepared = retainPresentation(prepared, existing);
  const saved = await saveWorkflowImport({ ...prepared, overwrite: true }, signal);
  signal.throwIfAborted();
  return { prepared, saved };
}

/** Retry the verified original source, keeping all remote mutations in import. */
export async function repairSavedWorkflowImport(id: string, connection: Connection, signal: AbortSignal, onProgress?: (message: string) => void, options?: AutomaticImportOptions) {
  const existing = await readWorkflowImportSource(id, signal);
  signal.throwIfAborted();
  const publishedPrompt = readPublishedWorkflowPrompt(options?.publishedPrompt) ?? readPublishedWorkflowPrompt(existing.config.importPublishedPrompt);
  const automatic = await prepareAutomaticWorkflowImport(existing.source, existing.filename, connection, signal, onProgress,
    publishedPrompt ? { ...options, publishedPrompt } : options);
  signal.throwIfAborted();
  const saved = await saveAutomaticWorkflowImport(automatic.prepared, signal, existing);
  return { ...automatic, ...saved };
}

export const isImportPluginDiagnostic = (item: { code: string }) => item.code === "node-definition-not-in-snapshot" || item.code.startsWith("manager-plugin-");
