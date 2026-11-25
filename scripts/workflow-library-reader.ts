import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createDecipheriv, createHash } from "node:crypto";
import { convertLibraryWorkflow, createLibraryRegistration, localized, type LibraryConversionSource } from "../src/workflow/library-converter";
import { isLegacyImportFamily } from "../src/workflow/import-category";
import type { WorkflowDefinition } from "../src/types";
import { serializedWorkflowLibraryRoot } from "./workflow-library-queue";

export type WorkflowLibrarySnapshot = {
  sourcePath: string;
  loadedAt: number;
  workflows: WorkflowDefinition[];
  issues: { folder: string; message: string }[];
  scanned: number;
};
const MAX_CONFIG = 1024 * 1024;
const MAX_EXECUTION = 32 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes: Buffer) => JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")) as unknown;
function within(root: string, file: string) {
  const relative = path.relative(root, file);
  return !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
}

async function confinedFile(root: string, folder: string, name: unknown, maximum: number) {
  if (typeof name !== "string" || !name.trim() || path.isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw new Error("配置文件路径必须位于工作流目录内。");
  const candidate = path.resolve(folder, name);
  if (!within(folder, candidate) || !within(root, candidate)) throw new Error("配置文件路径超出工作流目录。");
  const resolved = await realpath(candidate);
  if (!within(folder, resolved) || !within(root, resolved)) throw new Error("文件链接超出工作流目录。");
  const info = await stat(resolved);
  if (!info.isFile() || info.size > maximum) throw new Error("文件类型或大小超出读取范围。");
  return readFile(resolved);
}

/** Extract only the installed default reader constant. Never use account/private keys or env overrides. */
async function installedDefaultKey(sourcePath: string): Promise<Buffer> {
  const appPath = path.resolve(sourcePath, "..", "..");
  const asar = await readFile(path.join(appPath, "resources", "app.asar"));
  if (asar.length < 16) throw new Error("无法识别本机客户端容器读取格式。");
  const headerSize = asar.readUInt32LE(12);
  if (headerSize > 16 * 1024 * 1024 || 16 + headerSize > asar.length) throw new Error("客户端资源索引无效。");
  const index = JSON.parse(asar.subarray(16,16 + headerSize).toString()) as {files?:Record<string,unknown>};
  const entry = ((index.files?.["dist-electron"] as {files?:Record<string,unknown>})?.files?.main as {files?:Record<string,unknown>})?.files?.["index.js"] as {offset?:string;size?:number} | undefined;
  if (!entry || !Number.isSafeInteger(Number(entry.offset)) || !Number.isSafeInteger(entry.size)) throw new Error("未找到已识别的默认客户端读取器。");
  const start = 8 + asar.readUInt32LE(4) + Number(entry.offset);
  if (start < 0 || Number(entry.size) < 1 || start + Number(entry.size) > asar.length) throw new Error("客户端资源偏移无效。");
  const loader = asar.subarray(start,start + Number(entry.size)).toString();
  const cipherIndex = loader.indexOf('createDecipheriv("aes-256-cbc"');
  if (cipherIndex < 0) throw new Error("未识别默认容器算法。");
  // Both verified client versions resolve their built-in key with Buffer.from(CONSTANT,"base64").
  const readerContext = loader.slice(Math.max(0,cipherIndex - 4500), cipherIndex);
  const constants = [...readerContext.matchAll(/return Buffer\.from\(([A-Za-z_$][\w$]*),"base64"\)/g)];
  const variable = constants.at(-1)?.[1];
  if (!variable) throw new Error("本机默认容器读取器不受支持；未尝试私钥。");
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const literal = loader.match(new RegExp("(?:^|[,;\\s])" + escaped + '\\s*=\\s*"([A-Za-z0-9+/=]+)"'))?.[1];
  const key = literal ? Buffer.from(literal,"base64") : undefined;
  if (key?.length !== 32) throw new Error("默认容器读取器常量无效；未尝试私钥。");
  return key;
}

function decodeDefaultContainer(bytes: Buffer, key: Buffer) {
  const text = bytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(text)) throw new Error("执行容器不是有效 Base64。");
  const payload = Buffer.from(text,"base64");
  if (payload.length <= 16 || (payload.length - 16) % 16 !== 0) throw new Error("执行容器大小无效。");
  try {
    const decipher = createDecipheriv("aes-256-cbc",key,payload.subarray(0,16));
    return json(Buffer.concat([decipher.update(payload.subarray(16)),decipher.final()]));
  } catch { throw new Error("默认容器读取失败，此文件可能使用了其他格式或私钥。"); }
}

export async function readWorkflowLibrary(requestedSource: string): Promise<WorkflowLibrarySnapshot> {
  let root: string;
  try {
    root = await realpath(path.resolve(requestedSource));
    if (!(await stat(root)).isDirectory()) throw new Error("工作流库路径不是目录。");
  } catch { throw new Error("无法读取配置的本地工作流库目录。"); }
  // An overwrite briefly moves the old package to a hidden backup.
  return serializedWorkflowLibraryRoot(root, () => scanWorkflowLibrary(root));
}

async function scanWorkflowLibrary(root: string): Promise<WorkflowLibrarySnapshot> {
  const snapshot: WorkflowLibrarySnapshot = {sourcePath:root, loadedAt:Date.now(), workflows:[],issues:[],scanned:0};
  let key: Promise<Buffer> | undefined;
  const ids = new Map<string,string>();
  for (const entry of (await readdir(root,{withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
    if (/^\.canvas-(?:import-(?:backup-)?|delete-)[a-f0-9-]+$/.test(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const folder = entry.name;
    snapshot.scanned++;
    try {
      const dir = await realpath(path.join(root,folder));
      if (!within(root,dir) || !(await stat(dir)).isDirectory()) throw new Error("工作流目录链接超出库目录或不是目录。");
      const configBytes = await confinedFile(root,dir,"workflow.config.json",MAX_CONFIG);
      const config = json(configBytes) as Record<string,unknown>;
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("工作流配置必须是对象。");
      const source: LibraryConversionSource = {sourcePath:root,folder,configSha256:hash(configBytes),executionSha256:"",executionStatus:"missing"};
      let importSource: unknown;
      if (/^custom\.[a-f0-9]{16,64}$/.test(String(config.id)) && isLegacyImportFamily(localized(config.primaryCategoryLabel, localized(config.primaryCategory)))) {
        try { importSource = json(await confinedFile(root,dir,"source.json",MAX_EXECUTION)); }
        catch { /* Classification can still use the output contract and weight references. */ }
      }
      let workflow = createLibraryRegistration(config,undefined,source,importSource);
      const previous = ids.get(workflow.id);
      if (previous) {
        snapshot.workflows = snapshot.workflows.filter(item => item.id !== workflow.id);
        snapshot.issues = snapshot.issues.filter(issue => issue.folder !== previous);
        snapshot.issues.push({folder:previous,message:"工作流 ID 与目录 " + folder + " 重复，未加入目录。"});
        throw new Error("工作流 ID 与目录 " + previous + " 重复，未加入目录。");
      }
      ids.set(workflow.id,folder);
      const execution = config.execution as Record<string,unknown> | undefined;
      const file = execution?.file;
      let requirements: unknown;
      try {
        try {
          requirements = json(await confinedFile(root,dir,execution?.modelRequirementsFile ?? "model.requirements.json",MAX_CONFIG));
        } catch (error) {
          if (execution?.modelRequirementsFile !== undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (config.runnerType !== "comfyui") throw new Error("当前执行器尚不支持 runnerType=" + String(config.runnerType) + "。");
        const executionBytes = await confinedFile(root,dir,file,MAX_EXECUTION);
        source.executionSha256 = hash(executionBytes);
        if (workflow.library?.importStatus === "pending") {
          const marker = json(executionBytes) as Record<string, unknown>;
          if (!marker || marker.canvasImportState !== "pending" || marker.workflowId !== workflow.original?.id) throw new Error("导入执行记录无效；原始文件保留。");
          workflow = createLibraryRegistration(config,requirements,source,importSource);
          workflow.library!.executionIssue = "缺失项：" + (workflow.library!.diagnostics?.map(item => item.message).join("；") || "节点定义、参数或输出信息不完整。");
          snapshot.issues.push({folder,message:"已加入目录，" + workflow.library!.executionIssue});
          snapshot.workflows.push(workflow);
          continue;
        }
        let graph: unknown;
        if (typeof file === "string" && file.toLowerCase().endsWith(".dfenc")) {
          source.executionStatus = "encrypted";
          key ??= installedDefaultKey(root);
          graph = decodeDefaultContainer(executionBytes, await key);
        } else if (typeof file === "string" && file.toLowerCase().endsWith(".json")) {
          source.executionStatus = "plain";
          graph = json(executionBytes);
        } else throw new Error("只支持声明的 API JSON 或已识别的 .dfenc 执行文件。");
        workflow = convertLibraryWorkflow(config,graph,requirements,source);
      } catch (error) {
        workflow = createLibraryRegistration(config,requirements,source,importSource);
        const message = error instanceof Error ? error.message : "执行文件读取失败。";
        workflow.library!.executionIssue = "执行尚未就绪：" + message;
        snapshot.issues.push({folder,message:"已加入目录，" + workflow.library!.executionIssue});
      }
      snapshot.workflows.push(workflow);
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取失败。";
      snapshot.issues.push({folder,message});
    }
  }
  return snapshot;
}
