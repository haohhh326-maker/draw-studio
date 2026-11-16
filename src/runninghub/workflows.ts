import type { ApiWorkflow, WorkflowDefinition } from "../types";
import { validateDefinition } from "../workflow-adapter/adapter";
import type { ImportMediaBinding, ImportOutputBinding } from "../workflow/import-analyzer";
import { attachAifisherReadResult, type AifisherWorkflowReadResult } from "../workflow/aifisher-reader-client";
import { normalizeRunningHubBaseUrl, runningHubAppMediaEmptyValue, type RunningHubAiApp } from "./client";
import { selectRunningHubBindings } from "./selected-bindings";
import { analyzeRunningHubUpstream, buildRunningHubUpstream, requireRunningHubReader, type RunningHubReaderResult } from "./upstream-reader";

/** A shared URL is only an identifier; it never changes the configured API site. */
export function parseRunningHubWorkflowReference(value: string, baseUrl: string): string {
  const reference = parseRunningHubReference(value, baseUrl);
  if (reference.kind === "app") throw new Error("此链接是 RunningHub AI 应用，请使用 AI 应用读取方式。");
  return reference.id;
}

export function parseRunningHubReference(value: string, baseUrl: string): { id: string; kind?: "workflow" | "app"; apiVersion?: "v1" | "v2" } {
  const trimmed = value.trim();
  const configured = new URL(normalizeRunningHubBaseUrl(baseUrl));
  if (/^\d{1,32}$/.test(trimmed)) return { id: trimmed };
  let shared: URL;
  try { shared = new URL(trimmed); } catch { throw new Error("请填写 RunningHub 工作流 ID 或完整工作流分享链接。"); }
  if (shared.protocol !== "https:" || shared.username || shared.password) throw new Error("工作流分享链接必须使用 HTTPS，且不能包含账号信息。");
  let sharedSite: string;
  try { sharedSite = normalizeRunningHubBaseUrl(shared.origin); } catch { throw new Error("分享链接不是支持的 RunningHub 站点。"); }
  if (new URL(sharedSite).origin !== configured.origin) throw new Error("分享链接与当前 RunningHub API 站点不同，请先在算力设置中切换站点，再添加该工作流。中国站和国际站的工作流不会混用。");
  const pathname = shared.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, "");
  const match = pathname.match(/^\/(workflow|post|ai-detail|webapp)\/(\d{1,32})\/?$/i);
  const v2 = pathname.match(/^\/openapi\/v2\/run\/(ai-app|workflow)\/(\d{1,32})\/?$/i);
  const apiDetail = pathname.match(/^\/call-api\/api-detail\/(\d{1,32})\/?$/i);
  if (v2?.[1].toLowerCase() === "workflow") throw new Error("暂不支持 RunningHub V2 工作流接口，请使用工作流页面链接或 ID；不会自动改用 V1 提交。");
  if (v2) return { id: v2[2], kind: "app", apiVersion: "v2" };
  if (apiDetail && shared.searchParams.get("apiType") === "4") return { id: apiDetail[1], kind: "app" };
  const id = match?.[2] ?? (pathname.replace(/\/$/, "") === "/workflow" ? shared.searchParams.get("workflowId") : undefined) ?? (pathname.replace(/\/$/, "") === "/webapp" ? shared.searchParams.get("webappId") : undefined);
  if (!id || !/^\d{1,32}$/.test(id)) throw new Error("分享链接中没有可识别的工作流 ID，请从 RunningHub 工作流页面复制 ID。");
  return { id, kind: /^(?:workflow|post)$/i.test(match?.[1] ?? "") || pathname.replace(/\/$/, "") === "/workflow" ? "workflow" : "app" };
}

export function runningHubWorkflowId(baseUrl: string, workflowId: string): string {
  const site = normalizeRunningHubBaseUrl(baseUrl);
  const id = parseRunningHubWorkflowReference(workflowId, site);
  return "runninghub-" + encodeURIComponent(site) + "-" + id;
}

export function runningHubWorkflowsForSite(workflows: WorkflowDefinition[], baseUrl: string): WorkflowDefinition[] {
  const site = normalizeRunningHubBaseUrl(baseUrl);
  return workflows.filter(workflow => {
    if (!workflow.runninghub) return false;
    try { return normalizeRunningHubBaseUrl(workflow.runninghub.baseUrl) === site; } catch { return false; }
  });
}

/** The AI app entry excludes legacy API workflows without deleting their saved records. */
export function runningHubAppsForSite(workflows: WorkflowDefinition[], baseUrl: string): WorkflowDefinition[] {
  return runningHubWorkflowsForSite(workflows, baseUrl).filter(workflow => workflow.runninghub?.kind === "app");
}

export type RunningHubWorkflowOptions = {
  workflowId: string;
  baseUrl: string;
  name: string;
  promptKey?: string;
  mediaInputs?: ImportMediaBinding[];
  outputs?: ImportOutputBinding[];
  canvasParameterKeys?: string[];
  reader?: RunningHubReaderResult;
};

function workflowOptions(options: RunningHubWorkflowOptions, app = false) {
  const baseUrl = normalizeRunningHubBaseUrl(options.baseUrl), reference = parseRunningHubReference(options.workflowId, baseUrl), name = options.name.trim();
  if (!name || name.length > 120) throw new Error("请填写不超过 120 个字符的工作流名称。");
  if (app && reference.kind === "workflow") throw new Error("工作流链接不能作为 AI 应用添加。");
  if (!app && reference.kind === "app") throw new Error("AI 应用链接不能作为完整工作流添加。");
  return { baseUrl, reference, name };
}

function validateMediaBindings(reader: RunningHubReaderResult, selected: ImportMediaBinding[] | undefined) {
  const declared = analyzeRunningHubUpstream(reader).inputs;
  if (selected === undefined) return declared;
  const target = (item: { nodeId: string; field: string }) => JSON.stringify([item.nodeId, item.field]);
  const choices = new Map(selected.map(binding => [target(binding), binding]));
  if (choices.size !== selected.length || selected.some(binding => !declared.some(field => target(field) === target(binding))))
    throw new Error("素材输入必须来自 AIFISHER 公开的输入绑定。");
  const missing = declared.filter(binding => !choices.has(target(binding)));
  if (missing.length) throw new Error("AIFISHER 公开的素材输入不能取消绑定：" + missing.map(binding => binding.nodeId + "." + binding.field).join("、"));
  if (declared.some(binding => {
    const choice = choices.get(target(binding))!;
    return choice.kind !== binding.kind || (choice.required === true) !== (binding.required === true);
  })) throw new Error("公开素材的类型和必填要求不能修改，请按 AIFISHER 读取的输入契约保存。");
  return selected;
}

/** Build only from the unchanged AIFISHER reader result; source is retained by the read boundary. */
export function prepareRunningHubWorkflowCandidates(_source: unknown, options: RunningHubWorkflowOptions): { workflow: WorkflowDefinition; warnings: string[] } {
  const reader = requireRunningHubReader(options.reader), { baseUrl, reference, name } = workflowOptions(options);
  if (reader.environment !== "runninghub-workflow") throw new Error("请使用 AIFISHER 完整工作流读取环境。");
  const mediaInputs = validateMediaBindings(reader, options.mediaInputs);
  const workflow = buildRunningHubUpstream(reader, { ...options, name, mediaInputs, workflowId: reference.id, baseUrl, id: runningHubWorkflowId(baseUrl, reference.id) });
  validateDefinition(workflow);
  return { workflow, warnings: analyzeRunningHubUpstream(reader).warnings };
}

/** Explicit user selections may narrow source bindings; defaults retain every published parameter. */
export function prepareRunningHubWorkflow(source: unknown, options: RunningHubWorkflowOptions): { workflow: WorkflowDefinition; warnings: string[] } {
  const prepared = prepareRunningHubWorkflowCandidates(source, options);
  const workflow = selectRunningHubBindings(prepared.workflow, options.canvasParameterKeys);
  validateDefinition(workflow);
  return { ...prepared, workflow };
}

export const runningHubAppOutputNode = "fisherai_webapp_output";

export function runningHubAppMediaInputs(app: RunningHubAiApp): ImportMediaBinding[] {
  return analyzeRunningHubUpstream(requireRunningHubReader(app.reader)).inputs;
}

/** The adapter graph is the original WebApp projection, never a locally constructed replacement. */
export function runningHubAppGraph(app: RunningHubAiApp): ApiWorkflow {
  const reader = requireRunningHubReader(app.reader);
  if (reader.environment !== "runninghub-webapp") throw new Error("请使用 AIFISHER AI 应用读取环境。");
  return attachAifisherReadResult(structuredClone(reader.workflow!), reader as AifisherWorkflowReadResult);
}

export function prepareRunningHubApp(app: RunningHubAiApp, options: RunningHubWorkflowOptions): { workflow: WorkflowDefinition; warnings: string[] } {
  const reader = requireRunningHubReader(options.reader ?? app.reader), { baseUrl, reference, name } = workflowOptions(options, true);
  if (reader.environment !== "runninghub-webapp") throw new Error("请使用 AIFISHER AI 应用读取环境。");
  const mediaInputs = validateMediaBindings(reader, options.mediaInputs);
  const workflow = buildRunningHubUpstream(reader, { ...options, name, mediaInputs, workflowId: reference.id, baseUrl, id: "runninghub-app-" + encodeURIComponent(baseUrl) + "-" + reference.id, declaredAppOutputKind: app.outputKind });
  workflow.runninghub = { ...workflow.runninghub!, apiVersion: reference.apiVersion ?? app.apiVersion, apiVersionSource: reference.apiVersion ? "explicit" : "platform", mediaInputs: mediaInputs.map(binding => {
    const field = app.nodeInfoList.find(field => field.nodeId === binding.nodeId && field.fieldName === binding.field);
    return { nodeId: binding.nodeId, field: binding.field, required: binding.required === true, ...(field ? runningHubAppMediaEmptyValue(field) : {}) };
  }) };
  const selected = selectRunningHubBindings(workflow);
  validateDefinition(selected);
  return { workflow: selected, warnings: analyzeRunningHubUpstream(reader, app.outputKind).warnings };
}
