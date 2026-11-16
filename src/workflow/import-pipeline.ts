import { workflowImportId } from "./import-client";
import { pendingWorkflowPackage, type WorkflowImportState } from "./import-pending";
import { readAifisherWorkflow, type AifisherWorkflowReadRequest, type AifisherWorkflowReadResult } from "./aifisher-reader-client";
import { aifisherReaderProvenance, buildAifisherImportPackage } from "./aifisher-import-adapter";
import { buildImportEnvironmentDiagnostics } from "./import-environment-diagnostics";

export type PreparedWorkflowImport = Awaited<ReturnType<typeof prepareWorkflowImport>>;

/** Both entry points build the same package from exactly one source file. */
export async function prepareWorkflowImport(source: unknown, filename: string, info?: Record<string, unknown>,
  reader: (request: AifisherWorkflowReadRequest, signal?: AbortSignal) => Promise<AifisherWorkflowReadResult> = readAifisherWorkflow,
  signal?: AbortSignal) {
  signal?.throwIfAborted();
  const name = filename.replace(/\.json$/i, "").replace(/(?:[_. -]api)$/i, "").trim().slice(0, 120) || "导入工作流";
  const id = await workflowImportId(source);
  let read: AifisherWorkflowReadResult | undefined;
  try {
  signal?.throwIfAborted();
  read = await reader({ environment: "comfyui", source, ...(info ? { objectInfo: info } : {}) }, signal);
  signal?.throwIfAborted();
  const format = read.format === "comfy-api" ? "api" as const : "editor" as const;
  const built = buildAifisherImportPackage(read, id, name);
  const mainPrompt = built.config.prompt as { binding: { nodeId: string; path: string } } | undefined;
  const prompt = mainPrompt ? built.graph[mainPrompt.binding.nodeId]?.inputs[mainPrompt.binding.path.slice("inputs.".length)] : undefined;
  const warnings = [...new Set([...built.warnings,
    ...(format === "api" && !Object.keys(info ?? {}).length ? ["已保留 API 文件中的节点类型、命名输入和连线；当前未读取服务端节点定义，插件和模型可用性尚未确认。"] : [])])];
  const environmentReport = buildImportEnvironmentDiagnostics(read, { source, objectInfo: info });
  const missingDefinitions = info && Object.keys(info).length ? Object.entries(built.graph)
    .filter(([, node]) => !Object.hasOwn(info, node.class_type))
    .map(([nodeId, node]) => ({ code: "node-definition-not-in-snapshot", nodeId, classType: node.class_type,
      message: "导入时读取的节点定义快照未包含 " + node.class_type + "（节点 " + nodeId + "）；需在执行工作站安装/加载对应插件。" })) : [];
  const diagnostics = [...environmentReport.issues, ...missingDefinitions.filter(item => !environmentReport.issues.some(issue => issue.nodeId === item.nodeId && issue.category === "missing-node"))];
  const importState: WorkflowImportState = { status: "ready", format, diagnostics, warnings, environmentReport };
  built.config.importState = importState;
  return { ...built, source, filename, format, name, importState,
    prompt: typeof prompt === "string" ? prompt : "",
    warnings };
  } catch (reason) {
    signal?.throwIfAborted();
    if (reason instanceof Error && reason.name === "AbortError") throw reason;
    const pending = pendingWorkflowPackage(source, id, name, info, reason);
    if (read) {
      pending.config.importReader = aifisherReaderProvenance(read);
      const environmentReport = buildImportEnvironmentDiagnostics(read, { source, objectInfo: info });
      pending.importState.environmentReport = environmentReport;
      const warnings = environmentReport.issues;
      const explicit = reason && typeof reason === "object" && "diagnostics" in reason && Array.isArray(reason.diagnostics)
        ? reason.diagnostics.filter((item): item is typeof warnings[number] => !!item && typeof item === "object" && typeof item.message === "string") : [];
      if (warnings.length || explicit.length) {
        pending.importState.diagnostics = [...warnings, ...explicit.filter(item => !warnings.some(warning => warning.code === item.code && warning.nodeId === item.nodeId && warning.field === item.field))];
        pending.analysis.errors = pending.importState.diagnostics.map(item => item.message);
      }
    }
    return { ...pending, source, filename, format: pending.importState.format, name, prompt: "" };
  }
}
