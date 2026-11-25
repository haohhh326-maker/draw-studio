import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { apiGraph, convertLibraryWorkflow, createLibraryRegistration, localized, workflowReaderProvenance } from "../src/workflow/library-converter";
import { pendingWorkflowPackage, validatePendingWorkflowSource, type WorkflowImportDiagnostic } from "../src/workflow/import-pending";
import { prepareWorkflowImport } from "../src/workflow/import-pipeline";
import { readAIFisherWorkflow } from "./aifisher-workflow-reader";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";
import { isLegacyImportFamily, resolveWorkflowImportFamily } from "../src/workflow/import-category";
import { workflowModelFolderStem } from "../src/workflow/import-folder-name";
import { readImportEnvironmentReport } from "../src/workflow/import-environment-diagnostics";
import { readPublishedWorkflowPrompt } from "../src/workflow/automatic-prompt-binding";
import { serializedWorkflowLibraryRoot } from "./workflow-library-queue";

type JsonObject = Record<string, unknown>;
function retainSavedPresentation(target: JsonObject, saved: JsonObject) {
  for (const key of ["nameLabel", "primaryCategoryLabel", "description", "docs", "promptPlaceholder"]) {
    if (saved[key] === undefined) continue;
    if (key === "primaryCategoryLabel" && /^custom\.[a-f0-9]{16,64}$/.test(String(saved.id)) && isLegacyImportFamily(localized(saved[key]))) continue;
    target[key] = structuredClone(saved[key]);
  }
}
export type WorkflowImportRequest = {
  filename: string;
  source: unknown;
  graph?: unknown;
  config: JsonObject;
  requirements: unknown;
  overwrite?: boolean;
  reuseExisting?: boolean;
};
export type WorkflowImportResult = { folder: string; path: string; workflowId: string; updated: boolean; reused?: boolean; status?: "pending" | "ready"; diagnostics?: WorkflowImportDiagnostic[] };
export type WorkflowImportSource = { source: unknown; filename: string; config: JsonObject };
export class WorkflowImportError extends Error {
  constructor(message: string, public readonly status = 400, public readonly existing?: Omit<WorkflowImportResult, "updated">) { super(message); }
}

const MAX_CONFIG = 1024 * 1024;
const MAX_GRAPH = 32 * 1024 * 1024;
const ID = /^custom\.([a-f0-9]{16,64})$/;
const PACKAGE_FILES = ["source.json", "execution.api.json", "workflow.config.json", "model.requirements.json", "import.meta.json"];
const IMPORTER = "clearframe-canvas";
type ImportMetadata = { schemaVersion: 1; importer: string; workflowId: string; sourceSha256: string; originalFilename: string; importedAt: number; updatedAt: number };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowImportError(label + " 必须是 JSON 对象。");
  return value as JsonObject;
}
function jsonText(value: unknown, label: string, maximum: number) {
  let text: string;
  try { text = JSON.stringify(value, null, 2) + "\n"; } catch { throw new WorkflowImportError(label + " 不是有效 JSON。"); }
  if (text === "undefined\n" || Buffer.byteLength(text) > maximum) throw new WorkflowImportError(label + " 超出文件大小限制。", 413);
  return text;
}
function within(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function samePath(a: string, b: string) {
  return process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}
async function safeDirectory(root: string, candidate: string) {
  if (!within(root, candidate) || samePath(root, candidate)) throw new WorkflowImportError("目标目录超出工作流库。", 403);
  const info = await lstat(candidate);
  const resolved = await realpath(candidate);
  if (!info.isDirectory() || info.isSymbolicLink() || !within(root, resolved) || !samePath(resolved, candidate)) throw new WorkflowImportError("工作流目录包含链接或超出工作流库，不能写入。", 403);
}
async function safeFile(root: string, folder: string, name: string, maximum: number) {
  await safeDirectory(root, folder);
  const candidate = path.join(folder, name);
  const info = await lstat(candidate);
  const resolved = await realpath(candidate);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || !within(folder, resolved) || !samePath(resolved, candidate)) throw new WorkflowImportError("导入包包含文件链接或文件大小异常，不能覆盖。", 403);
  return readFile(candidate, "utf8");
}
async function importMetadata(root: string, folder: string): Promise<ImportMetadata> {
  if (!samePath(path.dirname(folder), root)) throw new WorkflowImportError("只能管理工作流库中的直接子目录。", 403);
  const metadata = object(JSON.parse(await safeFile(root, folder, "import.meta.json", MAX_CONFIG)), "导入记录");
  const suffix = typeof metadata.workflowId === "string" ? ID.exec(metadata.workflowId)?.[1] : undefined;
  if (metadata.schemaVersion !== 1 || metadata.importer !== IMPORTER || !suffix || !/^[a-f0-9]{64}$/.test(String(metadata.sourceSha256)) || typeof metadata.importedAt !== "number" || !Number.isFinite(metadata.importedAt) || typeof metadata.originalFilename !== "string") {
    throw new WorkflowImportError("此目录不是画布管理的自定义工作流，不能覆盖。", 409);
  }
  return metadata as ImportMetadata;
}
async function existingPackage(root: string, folder: string, validateExecution = false): Promise<ImportMetadata> {
  const metadata = await importMetadata(root, folder);
  const config = object(JSON.parse(await safeFile(root, folder, "workflow.config.json", MAX_CONFIG)), "现有工作流配置");
  if (config.id !== metadata.workflowId) throw new WorkflowImportError("现有工作流 ID 与导入记录不一致，不能覆盖。", 409);
  const names = await readdir(folder);
  if (names.length !== PACKAGE_FILES.length || PACKAGE_FILES.some(name => !names.includes(name))) throw new WorkflowImportError("自定义目录文件缺失或包含额外文件，保留目录并停止覆盖。", 409);
  for (const name of PACKAGE_FILES) await safeFile(root, folder, name, name === "source.json" || name === "execution.api.json" ? MAX_GRAPH : MAX_CONFIG);
  const source = JSON.parse(await safeFile(root, folder, "source.json", MAX_GRAPH)) as unknown;
  if (hash(JSON.stringify(source)) !== metadata.sourceSha256) throw new WorkflowImportError("现有原始文件与导入记录不一致，不能覆盖。", 409);
  if (validateExecution) {
    try {
      const execution = object(config.execution, "现有执行配置");
      if (execution.file !== "execution.api.json" || execution.modelRequirementsFile !== "model.requirements.json") throw new Error("执行文件路径与导入包不一致。");
      const graphText = await safeFile(root, folder, "execution.api.json", MAX_GRAPH);
      const requirements = object(JSON.parse(await safeFile(root, folder, "model.requirements.json", MAX_CONFIG)), "现有模型需求");
      if (!Array.isArray(requirements.items)) throw new Error("模型需求 items 必须是数组。");
      if (importState(config).status === "pending") {
        validatePendingWorkflowSource(source);
        const marker = JSON.parse(graphText) as JsonObject;
        if (marker.canvasImportState !== "pending" || marker.workflowId !== metadata.workflowId) throw new Error("导入执行记录无效。");
        createLibraryRegistration(config, requirements, { sourcePath: root, folder: path.basename(folder), configSha256: hash(JSON.stringify(config)), executionSha256: hash(graphText), executionStatus: "missing" });
        return metadata;
      }
      convertLibraryWorkflow(config, JSON.parse(graphText), requirements, {
        sourcePath: root, folder: path.basename(folder), configSha256: hash(JSON.stringify(config)), executionSha256: hash(graphText), executionStatus: "plain",
      });
    } catch (error) {
      if (error instanceof WorkflowImportError && error.status === 403) throw error;
      throw new WorkflowImportError("已有导入包无效，保留目录：" + (error instanceof Error ? error.message : "执行配置无法读取。"), 409);
    }
  }
  return metadata;
}
async function present(candidate: string) {
  try { await lstat(candidate); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
const identity = (folder: string, id: string) => ({ folder: path.basename(folder), path: folder, workflowId: id });
const importState = (config: JsonObject): JsonObject => config.importState && typeof config.importState === "object" && !Array.isArray(config.importState) ? config.importState as JsonObject : {};
const resultState = (config: JsonObject) => {
  const state = importState(config);
  if (state.status !== "pending" && state.status !== "ready") return {};
  const diagnostics = Array.isArray(state.diagnostics) ? state.diagnostics.filter(item =>
    !!item && typeof item === "object" && typeof (item as JsonObject).message === "string") as WorkflowImportDiagnostic[] : undefined;
  return { status: state.status, ...(state.status === "pending" || diagnostics?.length ? { diagnostics } : {}) };
};
const boundOutputIds = (config: JsonObject): string[] => {
  const execution = config.execution && typeof config.execution === "object" ? config.execution as JsonObject : {};
  const outputs = Array.isArray(execution.outputs) ? execution.outputs : [execution.output];
  return outputs.filter((output): output is JsonObject => !!output && typeof output === "object").map(output => String(output.nodeId ?? "")).filter(Boolean);
};

async function configuredRoot(requestedRoot: string): Promise<string> {
  try {
    const root = await realpath(requestedRoot);
    if (!(await lstat(root)).isDirectory()) throw new Error();
    return root;
  } catch { throw new WorkflowImportError("无法读取配置的工作流库。", 500); }
}
const temporaryFolder = (name: string) => /^\.canvas-(?:import-(?:backup-)?|delete-)[a-f0-9-]+$/.test(name);

/** Resolve an exact stable ID regardless of the package's readable directory name. */
export async function findManagedWorkflowImportFolder(requestedRoot: string, workflowId: string): Promise<string> {
  if (!ID.test(workflowId)) throw new WorkflowImportError("自定义工作流 ID 格式无效。");
  const root = await configuredRoot(requestedRoot), candidates: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (temporaryFolder(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const folder = path.join(root, entry.name);
    let match = entry.name === "Custom-" + workflowId.slice("custom.".length);
    try {
      const config = object(JSON.parse(await safeFile(root, folder, "workflow.config.json", MAX_CONFIG)), "工作流配置");
      match ||= config.id === workflowId;
    } catch (error) { if (match && error instanceof WorkflowImportError && error.status === 403) throw error; }
    try { match ||= (await importMetadata(root, folder)).workflowId === workflowId; } catch { /* Matching config/legacy identities still require validation below. */ }
    if (match) candidates.push(folder);
  }
  if (!candidates.length) throw new WorkflowImportError("未找到此自定义工作流目录。", 404);
  if (candidates.length !== 1) throw new WorkflowImportError("工作流 ID 被多个目录使用，无法确定管理目录。", 409);
  const metadata = await existingPackage(root, candidates[0], true);
  if (metadata.workflowId !== workflowId) throw new WorkflowImportError("工作流 ID 与导入记录不一致。", 409);
  return candidates[0];
}

export async function validateManagedWorkflowImport(requestedRoot: string, folder: string): Promise<{ workflowId: string; sourceSha256: string }> {
  const root = await configuredRoot(requestedRoot);
  const metadata = await existingPackage(root, path.resolve(folder), true);
  return { workflowId: metadata.workflowId, sourceSha256: metadata.sourceSha256 };
}

function availableFolderName(stem: string, workflowId: string, occupied: Set<string>): string {
  const key = (name: string) => process.platform === "win32" ? name.toLowerCase() : name;
  if (!occupied.has(key(stem))) return stem;
  const suffix = workflowId.slice("custom.".length);
  for (const length of [8, 16, 32, 64]) {
    const name = stem + "-" + suffix.slice(0, length);
    if (!occupied.has(key(name))) return name;
  }
  throw new WorkflowImportError("模型工作流目录名称冲突，请检查已有目录。", 409);
}

export type WorkflowImportFolderMigration = { workflowId: string; from: string; to: string; changed: boolean };
/** Preview by default. A committed rename changes no package bytes, IDs or timestamps. */
export async function migrateManagedWorkflowImportFolders(requestedRoot: string, options: { dryRun?: boolean } = {}): Promise<WorkflowImportFolderMigration[]> {
  const root = await configuredRoot(requestedRoot);
  return serializedWorkflowLibraryRoot(root, async () => {
    const entries = await readdir(root, { withFileTypes: true });
    const occupied = new Set(entries.map(entry => process.platform === "win32" ? entry.name.toLowerCase() : entry.name));
    const plans: (WorkflowImportFolderMigration & { sourceSha256: string })[] = [];
    for (const entry of entries) {
      const suffix = /^Custom-([a-f0-9]{16,64})$/.exec(entry.name)?.[1];
      if (!suffix) continue;
      const from = path.join(root, entry.name), workflowId = "custom." + suffix;
      const metadata = await existingPackage(root, from, true);
      if (metadata.workflowId !== workflowId || !samePath(await findManagedWorkflowImportFolder(root, workflowId), from)) throw new WorkflowImportError("旧目录身份不一致，未迁移。", 409);
      const config = object(JSON.parse(await safeFile(root, from, "workflow.config.json", MAX_CONFIG)), "工作流配置");
      const input = JSON.parse(await safeFile(root, from, importState(config).status === "pending" ? "source.json" : "execution.api.json", MAX_GRAPH));
      const stem = workflowModelFolderStem(input, { name: localized(config.nameLabel), family: localized(config.primaryCategoryLabel), kind: String(config.nodeKind), outputNodeIds: boundOutputIds(config) });
      const name = availableFolderName(stem, workflowId, occupied);
      occupied.add(process.platform === "win32" ? name.toLowerCase() : name);
      plans.push({ workflowId, from, to: path.join(root, name), changed: false, sourceSha256: metadata.sourceSha256 });
    }
    if (options.dryRun === false) {
      const moved: typeof plans = [];
      try {
        for (const plan of plans) {
          const current = await existingPackage(root, plan.from, true);
          if (current.workflowId !== plan.workflowId || current.sourceSha256 !== plan.sourceSha256 || await present(plan.to)) throw new WorkflowImportError("目录已变化，停止迁移。", 409);
          await rename(plan.from, plan.to); plan.changed = true; moved.push(plan);
        }
      } catch (error) {
        for (const plan of moved.reverse()) {
          await existingPackage(root, plan.to, true);
          if (await present(plan.from)) throw new WorkflowImportError("迁移回滚目录冲突，工作流保留在 " + plan.to, 500);
          await rename(plan.to, plan.from);
        }
        throw error;
      }
    }
    return plans.map(({ sourceSha256: _sourceSha256, ...plan }) => plan);
  });
}

/** Only this server's configured library is a write root; all filenames are fixed. */
export async function writeWorkflowLibraryImport(requestedRoot: string, request: WorkflowImportRequest): Promise<WorkflowImportResult> {
  let root: string;
  try { root = await realpath(requestedRoot); if (!(await lstat(root)).isDirectory()) throw new Error(); }
  catch { throw new WorkflowImportError("无法写入配置的本地工作流库目录。", 500); }
  // Serialize mutations to each root so two simultaneous imports cannot race an update.
  return serializedWorkflowLibraryRoot(root, () => writePackage(root, request));
}

/** Read only the immutable source in a verified managed import package. */
export async function readWorkflowLibraryImportSource(requestedRoot: string, workflowId: string): Promise<WorkflowImportSource> {
  if (typeof workflowId !== "string" || !ID.test(workflowId)) throw new WorkflowImportError("自定义工作流 ID 格式无效。");
  const root = await configuredRoot(requestedRoot);
  return serializedWorkflowLibraryRoot(root, async () => {
    const folder = await findManagedWorkflowImportFolder(root, workflowId);
    const metadata = await existingPackage(root, folder, true);
    const source = JSON.parse(await safeFile(root, folder, "source.json", MAX_GRAPH)) as unknown;
    if (hash(JSON.stringify(source)) !== metadata.sourceSha256) throw new WorkflowImportError("原始文件与导入记录不一致，停止读取。", 409);
    const config = object(JSON.parse(await safeFile(root, folder, "workflow.config.json", MAX_CONFIG)), "工作流配置");
    if (metadata.workflowId !== workflowId || config.id !== workflowId) throw new WorkflowImportError("工作流 ID 与导入记录不一致。", 409);
    return { source, filename: metadata.originalFilename, config };
  });
}

/** Recheck only a managed source under the fixed library; ready packages stay untouched. */
export async function resolveWorkflowLibraryImport(requestedRoot: string, rawRequest: unknown): Promise<WorkflowImportResult> {
  const request = object(rawRequest, "重新检查请求");
  const suffix = typeof request.workflowId === "string" ? ID.exec(request.workflowId)?.[1] : undefined;
  if (!suffix) throw new WorkflowImportError("自定义工作流 ID 格式无效。");
  if (request.objectInfo !== undefined) object(request.objectInfo, "ComfyUI 节点定义");
  let root: string;
  try { root = await realpath(requestedRoot); if (!(await lstat(root)).isDirectory()) throw new Error(); } catch { throw new WorkflowImportError("无法读取配置的工作流库。", 500); }
  return serializedWorkflowLibraryRoot(root, async () => {
  const folder = await findManagedWorkflowImportFolder(root, String(request.workflowId));
  const metadata = await existingPackage(root, folder, true);
  const config = object(JSON.parse(await safeFile(root, folder, "workflow.config.json", MAX_CONFIG)), "工作流配置");
  if (importState(config).status !== "pending") return { ...identity(folder, metadata.workflowId), updated: false, reused: true, ...resultState(config) };
  const source = JSON.parse(await safeFile(root, folder, "source.json", MAX_GRAPH)) as unknown;
  if (hash(JSON.stringify(source)) !== metadata.sourceSha256) throw new WorkflowImportError("原始文件已发生变化，请重新添加。", 409);
  const prepared = await prepareWorkflowImport(source, metadata.originalFilename, request.objectInfo as JsonObject | undefined,
    async input => await readAIFisherWorkflow(input) as unknown as AifisherWorkflowReadResult, undefined,
    readPublishedWorkflowPrompt(config.importPublishedPrompt));
  prepared.config.id = metadata.workflowId;
  retainSavedPresentation(prepared.config, config);
  return writePackage(root, { filename: metadata.originalFilename, source, graph: prepared.graph, config: prepared.config,
    requirements: prepared.requirements, overwrite: true });
  });
}

async function writePackage(root: string, rawRequest: WorkflowImportRequest): Promise<WorkflowImportResult> {
  const request = object(rawRequest, "导入请求");
  if (typeof request.filename !== "string" || !request.filename.trim() || request.filename.length > 255 || /[\u0000-\u001f]/.test(request.filename) || !/\.json$/i.test(request.filename)) throw new WorkflowImportError("请选择有效的 JSON 工作流文件。");
  if (request.overwrite !== undefined && typeof request.overwrite !== "boolean") throw new WorkflowImportError("覆盖选项必须是布尔值。");
  if (request.reuseExisting !== undefined && typeof request.reuseExisting !== "boolean") throw new WorkflowImportError("复用选项必须是布尔值。");
  const source = object(request.source, "原始工作流");
  let config = structuredClone(object(request.config, "工作流配置"));
  const publishedPrompt = readPublishedWorkflowPrompt(config.importPublishedPrompt);
  if (publishedPrompt) config.importPublishedPrompt = publishedPrompt;
  else delete config.importPublishedPrompt;
  const suffix = typeof config.id === "string" ? ID.exec(config.id)?.[1] : undefined;
  if (!suffix) throw new WorkflowImportError("自定义工作流 ID 格式无效。");
  let requirements = object(request.requirements, "模型需求");
  if (!Array.isArray(requirements.items)) throw new WorkflowImportError("模型需求 items 必须是数组。");
  const pending = importState(config).status === "pending";
  let graph: unknown;
  if (pending) {
    if (request.graph !== undefined && request.graph !== null) throw new WorkflowImportError("未完成转换的导入记录不能包含伪造的可执行 API 工作流。");
    if (config.id !== "custom." + hash(JSON.stringify(source))) throw new WorkflowImportError("导入工作流 ID 必须匹配原始文件哈希。");
    try {
      const verified = pendingWorkflowPackage(source, String(config.id), String(config.nameLabel || "导入工作流"), undefined, undefined);
      const diagnosis = importState(config).diagnostics;
      // Conversion findings carry no execution authority. A validated source and
      // server-created pending marker remain mandatory regardless of this text.
      const reported: WorkflowImportDiagnostic[] = [];
      if (Array.isArray(diagnosis)) for (const item of diagnosis.slice(0, 1000)) if (item && typeof item === "object" && typeof (item as JsonObject).message === "string") {
        const value = item as JsonObject;
        reported.push({ code: typeof value.code === "string" ? value.code.slice(0, 100) : "conversion-check", message: String(value.message).slice(0, 2000), ...(typeof value.nodeId === "string" ? { nodeId: value.nodeId.slice(0, 200) } : {}), ...(typeof value.classType === "string" ? { classType: value.classType.slice(0, 200) } : {}), ...(typeof value.field === "string" ? { field: value.field.slice(0, 200) } : {}) });
      }
      if (reported.length) verified.importState.diagnostics = reported;
      const environmentReport = readImportEnvironmentReport(importState(config).environmentReport);
      if (environmentReport) verified.importState.environmentReport = environmentReport;
      if (workflowReaderProvenance(config)) verified.config.importReader = workflowReaderProvenance(config);
      if (publishedPrompt) verified.config.importPublishedPrompt = publishedPrompt;
      retainSavedPresentation(verified.config, config);
      config = verified.config;
      requirements = verified.requirements;
      graph = { schemaVersion: 1, canvasImportState: "pending", workflowId: config.id };
    } catch (error) { throw new WorkflowImportError(error instanceof Error ? error.message : "普通工作流结构无效。"); }
  } else {
    try { graph = apiGraph(request.graph); } catch (error) { throw new WorkflowImportError(error instanceof Error ? error.message : "API 工作流无效。"); }
  }
  // Keep the analyzer's explicit output contract while pinning every read path.
  config.execution = { ...(config.execution === undefined ? {} : object(config.execution, "执行配置")), file: "execution.api.json", modelRequirementsFile: "model.requirements.json" };
  const family = localized(config.primaryCategoryLabel, localized(config.primaryCategory));
  if (isLegacyImportFamily(family)) config.primaryCategoryLabel = resolveWorkflowImportFamily(family, String(config.id), pending ? source : graph,
    { name: localized(config.nameLabel), kind: String(config.nodeKind) });
  const workflowId = String(config.id);
  const stem = workflowModelFolderStem(pending ? source : graph, { name: localized(config.nameLabel), family: localized(config.primaryCategoryLabel), kind: String(config.nodeKind), outputNodeIds: boundOutputIds(config) });
  let folderName = stem;
  let destination = path.join(root, folderName);
  let configText = jsonText(config, "工作流配置", MAX_CONFIG);
  const graphText = jsonText(graph, "API 工作流", MAX_GRAPH);
  const sourceText = jsonText(source, "原始工作流", MAX_GRAPH);
  const requirementsText = jsonText(requirements, "模型需求", MAX_CONFIG);
  try {
    const metadata = { sourcePath: root, folder: folderName, configSha256: hash(configText), executionSha256: hash(graphText), executionStatus: pending ? "missing" as const : "plain" as const };
    if (pending) createLibraryRegistration(config, requirements, metadata, source);
    else convertLibraryWorkflow(config, graph, requirements, metadata);
  }
  catch (error) { throw new WorkflowImportError(error instanceof Error ? error.message : "工作流配置无效。"); }
  const sourceSha256 = hash(JSON.stringify(source));
  let old: ImportMetadata | undefined;
  let automaticUpgrade = false;
  let reused: WorkflowImportResult | undefined;
  const existingIds = new Map<string, string[]>();
  const recordIdentity = (id: unknown, folder: string) => { if (typeof id === "string") existingIds.set(id, [...(existingIds.get(id) ?? []), folder]); };
  const reusePackage = async (candidate: string, id: string) => {
    try { await existingPackage(root, candidate, true); }
    catch (error) { throw new WorkflowImportError(error instanceof Error ? error.message : "已有导入包无效，保留目录。", error instanceof WorkflowImportError && error.status === 403 ? 403 : 409, identity(candidate, id)); }
    if (reused && !samePath(reused.path, candidate)) throw new WorkflowImportError("此来源存在多个导入目录，请检查目录后重试。", 409, identity(candidate, id));
    const savedConfig = object(JSON.parse(await safeFile(root, candidate, "workflow.config.json", MAX_CONFIG)), "已有工作流配置");
    reused = { ...identity(candidate, id), updated: false, reused: true, ...resultState(savedConfig) };
  };
  const entries = await readdir(root, { withFileTypes: true });
  const occupied = new Set(entries.map(entry => process.platform === "win32" ? entry.name.toLowerCase() : entry.name));
  // Detect identities across the whole library, including renamed packages and originals.
  for (const entry of entries) {
    if (temporaryFolder(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink() && samePath(candidate, path.join(root, stem))) throw new WorkflowImportError("同名模型目录包含链接，保留目录并停止导入。", 403, identity(candidate, workflowId));
    const legacyId = /^Custom-([a-f0-9]{16,64})$/.exec(entry.name)?.[1];
    let savedConfig: JsonObject | undefined, managed: ImportMetadata | undefined;
    try { savedConfig = object(JSON.parse(await safeFile(root, candidate, "workflow.config.json", MAX_CONFIG)), "现有工作流配置"); }
    catch (error) {
      if (legacyId === suffix && error instanceof WorkflowImportError && error.status === 403) throw error;
    }
    try { managed = await importMetadata(root, candidate); } catch { /* Identity and actual source checks below protect damaged imports. */ }
    recordIdentity(savedConfig?.id ?? managed?.workflowId, candidate);
    const matchingId = savedConfig?.id === workflowId || managed?.workflowId === workflowId || legacyId === suffix;
    if (matchingId) {
      if (old) throw new WorkflowImportError("工作流 ID 被多个目录使用，不能覆盖。", 409, identity(candidate, workflowId));
      try {
        old = await existingPackage(root, candidate);
        if (old.workflowId !== workflowId) throw new WorkflowImportError("工作流 ID 与导入记录不一致。", 409);
      }
      catch (error) {
        throw new WorkflowImportError(error instanceof WorkflowImportError ? error.message : "目录没有有效的画布导入记录，保留原目录并停止覆盖。", error instanceof WorkflowImportError ? error.status : 409, identity(candidate, workflowId));
      }
      destination = candidate; folderName = entry.name;
      // A stale recheck/import cannot replace a package that has become ready.
      if (pending && importState(savedConfig!).status !== "pending" && old.sourceSha256 === sourceSha256) await reusePackage(candidate, old.workflowId);
      if (request.reuseExisting === true && old.sourceSha256 === sourceSha256) {
        // Let the client revalidate a saved publisher locator before upgrading.
        if (!pending && importState(savedConfig!).status === "pending"
          && (publishedPrompt || !readPublishedWorkflowPrompt(savedConfig!.importPublishedPrompt))) {
          await existingPackage(root, candidate, true);
          automaticUpgrade = true;
          retainSavedPresentation(config, savedConfig!);
          configText = jsonText(config, "工作流配置", MAX_CONFIG);
        }
        else await reusePackage(candidate, old.workflowId);
      }
      continue;
    }
    if (managed?.sourceSha256 === sourceSha256) {
      if (request.reuseExisting === true) await reusePackage(candidate, managed.workflowId);
      else { await existingPackage(root, candidate); throw new WorkflowImportError("此文件已经导入，请更新已有工作流。", 409, identity(candidate, managed.workflowId)); }
    } else if (request.reuseExisting === true) {
      let actualSourceSha256: string | undefined;
      try { actualSourceSha256 = hash(JSON.stringify(JSON.parse(await safeFile(root, candidate, "source.json", MAX_GRAPH)))); } catch { /* Unreadable or unrelated sources remain untouched. */ }
      if (actualSourceSha256 === sourceSha256) {
        const id = managed?.workflowId ?? (typeof savedConfig?.id === "string" ? savedConfig.id : legacyId ? "custom." + legacyId : workflowId);
        throw new WorkflowImportError("已有来源的导入记录无效，保留目录并停止复用。", 409, identity(candidate, id));
      }
    }
  }
  if (!old) { folderName = availableFolderName(stem, workflowId, occupied); destination = path.join(root, folderName); }
  if (!old && await present(destination)) throw new WorkflowImportError("目标目录已存在且不属于画布导入包，不能覆盖。", 409, identity(destination, workflowId));
  // Automatic imports never use overwrite, even if a caller supplies both flags.
  if (old && request.reuseExisting === true && old.sourceSha256 !== sourceSha256) throw new WorkflowImportError("已有工作流来源不同，自动添加不会覆盖，请使用新的来源 ID。", 409, identity(destination, workflowId));
  if (reused) {
    if ((existingIds.get(reused.workflowId)?.length ?? 0) > 1) throw new WorkflowImportError("已有工作流 ID 被多个目录使用，未复用。", 409, identity(reused.path, reused.workflowId));
    return reused;
  }
  if ((existingIds.get(workflowId)?.length ?? 0) > 1) throw new WorkflowImportError("工作流 ID 被多个目录使用，未更新。", 409, identity(destination, workflowId));
  if (old && request.overwrite !== true && !automaticUpgrade) throw new WorkflowImportError("此工作流已经导入，确认后可更新。", 409, identity(destination, workflowId));
  const now = Date.now();
  const metadata: ImportMetadata = { schemaVersion: 1, importer: IMPORTER, workflowId, sourceSha256, originalFilename: request.filename, importedAt: old?.importedAt ?? now, updatedAt: now };
  const files: Record<string, string> = { "source.json": sourceText, "execution.api.json": graphText, "workflow.config.json": configText, "model.requirements.json": requirementsText, "import.meta.json": jsonText(metadata, "导入记录", MAX_CONFIG) };
  const stage = path.join(root, ".canvas-import-" + randomUUID());
  const backup = path.join(root, ".canvas-import-backup-" + randomUUID());
  let staged = false, backedUp = false, committed = false;
  try {
    await mkdir(stage, { mode: 0o700 }); staged = true;
    for (const [name, text] of Object.entries(files)) {
      await safeDirectory(root, stage);
      await writeFile(path.join(stage, name), text, { flag: "wx", mode: 0o600 });
      await safeFile(root, stage, name, name === "source.json" || name === "execution.api.json" ? MAX_GRAPH : MAX_CONFIG);
    }
    await safeDirectory(root, stage);
    if (old) {
      await existingPackage(root, destination);
      if (await present(backup)) throw new WorkflowImportError("导入临时目录冲突，请重试。", 409);
      await rename(destination, backup); backedUp = true;
    } else if (await present(destination)) throw new WorkflowImportError("目标目录已被其他操作创建，请重新读取。", 409, identity(destination, workflowId));
    await rename(stage, destination); staged = false; committed = true;
    if (backedUp) { await safeDirectory(root, backup); await rm(backup, { recursive: true }); backedUp = false; }
    return { folder: folderName, path: destination, workflowId, updated: Boolean(old), ...resultState(config) };
  } catch (error) {
    if (backedUp && !committed) {
      if (await present(destination)) throw new WorkflowImportError("更新中断，原工作流保留在 " + backup + "；请检查目录后重试。", 500);
      await safeDirectory(root, backup);
      await rename(backup, destination); backedUp = false;
    }
    if (committed) return { folder: folderName, path: destination, workflowId, updated: Boolean(old), ...resultState(config) };
    throw error;
  } finally {
    if (staged && await present(stage)) { await safeDirectory(root, stage); await rm(stage, { recursive: true }); }
  }
}
