import { ApiError, ComfyUIClient } from "../comfyui/client";
import type { Connection } from "../types";
import { isRunningHubNativeConnection } from "../runninghub/native-connection";
import { apiWorkflowSourceGraph } from "./import-api";
import { prepareWorkflowImport, type PreparedWorkflowImport } from "./import-pipeline";
import { loadImportSchema } from "./import-schema";
import type { WorkflowImportDiagnostic } from "./import-pending";
import { withImportEnvironmentCapabilities } from "./import-environment-diagnostics";
import { discoverOnlineManagerPlugins } from "./manager-online-discovery";
import type { PublishedWorkflowPrompt } from "./automatic-prompt-binding";
import {
  collectMissingManagerNodes, repairMissingManagerPlugins,
  type ManagerRepairResult,
} from "./manager-plugins";

type Progress = (message: string) => void;
type ImportSchema = Awaited<ReturnType<typeof loadImportSchema>>;
export type AutomaticImportOptions = { installMissingPlugins?: boolean; publishedPrompt?: PublishedWorkflowPrompt };
export type AutomaticWorkflowImport = {
  prepared: PreparedWorkflowImport;
  warnings: string[];
  schema: ImportSchema;
  manager?: ManagerRepairResult;
};

/** Installation is an import operation. Submitting a generation never invokes it. */
export async function prepareAutomaticWorkflowImport(
  source: unknown, filename: string, connection: Connection,
  signal: AbortSignal, onProgress?: Progress, options: AutomaticImportOptions = {},
): Promise<AutomaticWorkflowImport> {
  signal.throwIfAborted();
  onProgress?.("正在读取工作站节点定义…");
  const loadedSchema = await loadImportSchema(connection, signal);
  const nativePlatform = isRunningHubNativeConnection(connection);
  const schema: ImportSchema = nativePlatform ? { ...loadedSchema, catalogScope: "platform" } : loadedSchema;
  signal.throwIfAborted();
  let prepared = await prepareWorkflowImport(source, filename, schema.info, undefined, signal, options.publishedPrompt);
  signal.throwIfAborted();

  // Cached contracts remain useful for parsing during an outage, but cannot
  // establish that a plugin is currently missing from the remote workstation.
  if (nativePlatform || !schema.info || !Object.keys(schema.info).length || schema.warnings.length) {
    return finish(prepared, schema);
  }
  const missing = prepared.importState.diagnostics
    .filter(item => item.classType && !Object.hasOwn(schema.info!, item.classType))
    .map(item => ({ classType: item.classType!, nodeId: item.nodeId }));
  const graph = prepared.graph ?? (prepared.format === "api" ? apiWorkflowSourceGraph(source) : undefined);
  if (graph) for (const [nodeId, node] of Object.entries(graph)) {
    if (typeof node.class_type === "string" && !Object.hasOwn(schema.info, node.class_type)) {
      missing.push({ classType: node.class_type, nodeId });
    }
  }
  const nodes = collectMissingManagerNodes(source, missing);
  if (!nodes.length) return finish(prepared, schema);
  if (!options.installMissingPlugins) return finish(prepared, schema, {
    nodes: nodes.map(node => ({ ...node, status: "not-installed", message: "当前工作站缺少此节点；未安装，可勾选安装缺失插件后重新检查。" })),
    installedPackageIds: [], restartRequired: false, objectInfo: schema.info,
  });

  const client = new ComfyUIClient(connection);
  onProgress?.("正在通过 ComfyUI Manager 查找并补齐缺失插件…");
  let manager = await repairMissingManagerPlugins(client, nodes, {
    signal, onProgress, initialObjectInfo: schema.info, discoverOnline: discoverOnlineManagerPlugins,
  });
  signal.throwIfAborted();
  if (manager.restartRequired) manager = await completePluginRestart(client, manager, signal, onProgress);
  signal.throwIfAborted();
  const info = Object.keys(manager.objectInfo).length ? manager.objectInfo : schema.info;
  // Reparse exactly the original file. Installed node contracts may now recover
  // widget names/order; never construct a replacement workflow or lose metadata.
  prepared = await prepareWorkflowImport(source, filename, info, undefined, signal, options.publishedPrompt);
  signal.throwIfAborted();
  return finish(prepared, { ...schema, info }, manager);
}

function finish(prepared: PreparedWorkflowImport, schema: ImportSchema, manager?: ManagerRepairResult): AutomaticWorkflowImport {
  const environmentReport = prepared.importState.environmentReport ? withImportEnvironmentCapabilities(prepared.importState.environmentReport,
    schema.info && Object.keys(schema.info).length ? schema.catalogScope === "platform" ? "platform" : schema.warnings.length ? "cached" : "live" : "unavailable") : undefined;
  const diagnostics: WorkflowImportDiagnostic[] = manager?.nodes
    .filter(node => node.status !== "available")
    .map(node => ({
      code: "manager-plugin-" + node.status,
      classType: node.classType,
      ...(node.nodeId ? { nodeId: node.nodeId } : {}),
      message: node.message,
    })) ?? [];
  if (manager?.managerError && !diagnostics.length) diagnostics.push({ code: "manager-plugin-failed", message: manager.managerError });
  const warnings = [...new Set([
    ...schema.warnings, ...prepared.warnings,
    ...diagnostics.map(item => item.message),
    ...(manager?.managerError ? [manager.managerError] : []),
  ])];
  const importState = {
    ...prepared.importState,
    ...(environmentReport ? { environmentReport } : {}),
    diagnostics: [...prepared.importState.diagnostics.filter(item =>
      !(["missing-node-definition", "node-definition-not-in-snapshot", "MISSING_NODE_TYPE"].includes(item.code)
        && diagnostics.some(managerItem => item.classType && managerItem.classType === item.classType)))
      .map(item => environmentReport?.issues.find(issue => issue.code === item.code && issue.nodeId === item.nodeId && issue.field === item.field) ?? item), ...diagnostics],
    warnings,
  };
  return {
    prepared: { ...prepared, config: { ...prepared.config, importState }, importState, warnings },
    warnings, schema, ...(manager ? { manager } : {}),
  };
}

async function completePluginRestart(
  client: ComfyUIClient, manager: ManagerRepairResult,
  signal: AbortSignal, onProgress?: Progress,
): Promise<ManagerRepairResult> {
  const pending = manager.nodes.filter(node => node.status === "installed-pending-restart");
  if (!pending.length) return manager;
  const retainPending = (message: string): ManagerRepairResult => ({
    ...manager,
    nodes: manager.nodes.map(node => node.status === "installed-pending-restart" ? { ...node, message } : node),
  });
  try {
    const queue = await (await client.request("/queue", { signal }, null)).json();
    signal.throwIfAborted();
    if (!Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending)) {
      return retainPending("自动安装完成，但工作站队列状态无效；未自动重启，请确认任务结束后重启完成接入。");
    }
    if (queue.queue_running.length || queue.queue_pending.length) {
      return retainPending("自动安装完成，工作站有任务运行，需任务结束后重启完成接入。");
    }
  } catch (reason) {
    signal.throwIfAborted();
    return retainPending("自动安装完成，但无法确认工作站队列；未自动重启。" + errorMessage(reason));
  }

  // Another user may have started a Manager installation after our own queue
  // completed. Recheck immediately before reboot without clearing their queue.
  try {
    const state: unknown = await (await client.request("/manager/queue/status", { signal }, null)).json();
    signal.throwIfAborted();
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return retainPending("自动安装完成，但 Manager 安装队列状态无效；未自动重启，请确认安装任务结束后重启完成接入。");
    }
    const queue = state as Record<string, unknown>;
    if (typeof queue.is_processing !== "boolean" || ![queue.total_count, queue.done_count, queue.in_progress_count].every(value => Number.isInteger(value) && Number(value) >= 0)) {
      return retainPending("自动安装完成，但 Manager 安装队列状态无效；未自动重启，请确认安装任务结束后重启完成接入。");
    }
    if (queue.is_processing || Number(queue.in_progress_count) !== 0 || Number(queue.done_count) < Number(queue.total_count)) {
      return retainPending("自动安装完成，ComfyUI Manager 仍有安装任务，需安装结束后重启完成接入。");
    }
  } catch (reason) {
    signal.throwIfAborted();
    return retainPending("自动安装完成，但无法确认 Manager 安装队列；未自动重启。" + errorMessage(reason));
  }

  onProgress?.("插件已安装，正在重启空闲工作站并加载节点…");
  try {
    await client.request("/manager/reboot", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
    }, null);
  } catch (reason) {
    signal.throwIfAborted();
    // os.execv can close this request while restarting; an explicit refusal is
    // different and must not be interpreted as successful restart acceptance.
    if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500) {
      return retainPending("自动安装完成，但 ComfyUI Manager 拒绝重启；需在工作站重启完成接入。" + errorMessage(reason));
    }
  }
  let objectInfo = manager.objectInfo;
  const failedPackages = new Map<string, string>();
  while (true) {
    await pause(1000, signal);
    signal.throwIfAborted();
    try {
      const info: unknown = await (await client.request("/object_info", { signal }, null)).json();
      signal.throwIfAborted();
      if (info && typeof info === "object" && !Array.isArray(info) && Object.keys(info).length) {
        objectInfo = info as Record<string, unknown>;
        if (pending.every(node => Object.hasOwn(objectInfo, node.classType) || (node.packageId && failedPackages.has(node.packageId)))) break;
        const unresolved = pending.filter(node => !Object.hasOwn(objectInfo, node.classType) && node.packageId && !failedPackages.has(node.packageId));
        if (unresolved.length) {
          try {
            const catalog: unknown = await (await client.request("/customnode/getlist?mode=local&skip_update=true", { signal }, null)).json();
            signal.throwIfAborted();
            const packs = record(catalog) && record(catalog.node_packs) ? catalog.node_packs : {};
            for (const packageId of new Set(unresolved.map(node => node.packageId!))) {
              const pack = packs[packageId];
              if (!record(pack) || pack["import-fail"] !== true) continue;
              let detail = "";
              try {
                const info: unknown = await (await client.request("/customnode/import_fail_info", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ cnr_id: packageId }), signal,
                }, null)).json();
                signal.throwIfAborted();
                if (record(info) && typeof info.msg === "string") detail = info.msg.trim().slice(0, 8000);
              } catch { signal.throwIfAborted(); }
              if (client.connection.token) detail = detail.replaceAll(client.connection.token, "[已隐藏]");
              failedPackages.set(packageId, "Manager 确认插件 " + packageId + " 导入失败。" + (detail ? "\n" + detail : "请检查该插件的依赖与启动日志。"));
            }
          } catch { signal.throwIfAborted(); }
          if (pending.every(node => Object.hasOwn(objectInfo, node.classType) || (node.packageId && failedPackages.has(node.packageId)))) break;
        }
      }
    } catch (reason) {
      signal.throwIfAborted();
      if (reason instanceof ApiError && [401, 403].includes(reason.status)) {
        const message = "插件已安装，但重启后读取节点定义被拒绝，无法确认节点是否加载。" + errorMessage(reason);
        return { ...manager, objectInfo, restartRequired: false, managerError: message,
          nodes: manager.nodes.map(node => node.status === "installed-pending-restart" ? { ...node, status: "installed-unavailable", message } : node) };
      }
    }
  }
  const nodes = manager.nodes.map(node => {
    if (Object.hasOwn(objectInfo, node.classType)) return { ...node, status: "available" as const, message: "插件已加载：" + node.classType };
    if (node.status !== "installed-pending-restart") return node;
    return { ...node, status: "installed-unavailable" as const, message: "插件已安装，但节点 " + node.classType + " 尚未注册。" + (node.packageId ? failedPackages.get(node.packageId) : "") };
  });
  return { ...manager, objectInfo, nodes, restartRequired: false };
}

function errorMessage(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function pause(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
