import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { serializedWorkflowLibraryRoot, WorkflowImportError } from "./workflow-library-writer";

export type WorkflowDeleteRequest = { workflowId: string; folder: string; configSha256: string };
export type WorkflowDeleteResult = { workflowId: string; folder: string; deleted: true };
const normalized = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (a: string, b: string) => normalized(a) === normalized(b);
const inside = (root: string, target: string) => {
  const relative = path.relative(normalized(root), normalized(target));
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};

function deleteRequest(raw: unknown): WorkflowDeleteRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WorkflowImportError("删除请求无效。");
  const request = raw as Record<string, unknown>;
  const { workflowId, folder, configSha256 } = request;
  if (typeof workflowId !== "string" || !workflowId.trim() || workflowId.length > 512 ||
      typeof folder !== "string" || !folder || folder.length > 255 || folder !== folder.trim() || /[\\/:<>"|?*\x00-\x1f]/.test(folder) ||
      folder === "." || folder === ".." || folder.endsWith(".") || folder.startsWith(".canvas-") ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(folder) ||
      typeof configSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(configSha256))
    throw new WorkflowImportError("删除请求缺少有效的工作流身份或目录信息。");
  return { workflowId, folder, configSha256: configSha256.toLowerCase() };
}

/** Refuse links anywhere in the package; recursive removal must stay in its verified directory. */
async function verifyTree(root: string, folder: string) {
  let count = 0;
  const visit = async (target: string, depth: number): Promise<void> => {
    if (++count > 20000 || depth > 64) throw new WorkflowImportError("工作流目录内容过多，无法安全删除。", 409);
    if (!inside(root, target) || (!samePath(target, folder) && !inside(folder, target))) throw new WorkflowImportError("工作流目录超出允许范围。", 409);
    const entry = await lstat(target);
    if (entry.isSymbolicLink() || !samePath(await realpath(target), target)) throw new WorkflowImportError("工作流目录包含链接，无法删除其关联目录。", 409);
    if (entry.isDirectory()) {
      for (const name of await readdir(target)) await visit(path.join(target, name), depth + 1);
    } else if (!entry.isFile()) throw new WorkflowImportError("工作流目录包含不支持的文件类型。", 409);
  };
  await visit(folder, 0);
}

export async function deleteWorkflowLibraryFolder(requestedRoot: string, raw: unknown): Promise<WorkflowDeleteResult> {
  const request = deleteRequest(raw);
  const root = await realpath(requestedRoot);
  if (!(await lstat(root)).isDirectory()) throw new WorkflowImportError("工作流库目录无效。");
  return serializedWorkflowLibraryRoot(root, async () => {
    const target = path.resolve(root, request.folder);
    if (!inside(root, target) || !samePath(path.dirname(target), root)) throw new WorkflowImportError("只能删除当前工作流库中的工作流目录。");
    let directory;
    try { directory = await lstat(target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkflowImportError("工作流目录已不存在，请刷新列表。", 409);
      throw error;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink() || !samePath(await realpath(target), target)) throw new WorkflowImportError("工作流目录不是普通目录，无法删除。", 409);
    const configPath = path.join(target, "workflow.config.json");
    const configStat = await lstat(configPath);
    if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.size > 1024 * 1024 || !samePath(await realpath(configPath), configPath))
      throw new WorkflowImportError("工作流配置文件无法验证。", 409);
    const bytes = await readFile(configPath);
    let config: Record<string, unknown>;
    try { config = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); }
    catch { throw new WorkflowImportError("工作流配置文件无效。", 409); }
    if (!config || config.id !== request.workflowId || createHash("sha256").update(bytes).digest("hex") !== request.configSha256)
      throw new WorkflowImportError("工作流文件已经变化，请刷新列表后再删除。", 409);
    await verifyTree(root, target);
    // Both absolute paths have been checked before moving or recursively removing anything.
    const staged = path.resolve(root, ".canvas-delete-" + randomUUID());
    if (!inside(root, staged) || !samePath(path.dirname(staged), root)) throw new WorkflowImportError("删除目录超出允许范围。");
    await rename(target, staged);
    try {
      await verifyTree(root, staged);
      await rm(staged, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      try {
        await lstat(target).then(() => { throw new Error("Original directory already exists"); }, missing => {
          if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
        });
        if ((await lstat(staged)).isDirectory() && samePath(await realpath(staged), staged)) await rename(staged, target);
      } catch { /* Preserve any remaining staged data when restoration is not possible. */ }
      throw new WorkflowImportError("工作流文件夹删除失败：" + (error instanceof Error ? error.message : String(error)), 500);
    }
    return { workflowId: request.workflowId, folder: request.folder, deleted: true };
  });
}
