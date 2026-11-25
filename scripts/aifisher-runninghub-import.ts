import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import nodeFetch from "node-fetch";
import { RunningHubWorkflowClient, normalizeRunningHubBaseUrl, assertRunningHubRemoteId } from "../vendor/aifisher/server/workflowRuntime/runningHubWorkflowClient.js";
import { RunningHubWebAppLibraryService } from "../vendor/aifisher/server/workflowRuntime/runningHubWebAppLibraryService.js";
import { WorkflowDefinitionStore } from "../vendor/aifisher/server/workflowRuntime/workflowDefinitionStore.js";
import { WorkflowConfigurationStore } from "../vendor/aifisher/server/workflowRuntime/workflowConfigurationStore.js";
import { WorkflowDeploymentService } from "../vendor/aifisher/server/workflowRuntime/workflowDeploymentService.js";
import { WorkflowCanvasNodeService } from "../vendor/aifisher/server/workflowRuntime/workflowCanvasNodeService.js";
import { createRunningHubWebAppProjection } from "../vendor/aifisher/server/workflowRuntime/runningHubWebApp.js";
import { analyzeWorkflow, parseWorkflowArtifact, normalizeApiWorkflow, sha256Json } from "../vendor/aifisher/server/workflowRuntime/workflowFormat.js";
import { deriveBindingCandidates, toBindingSetDto } from "../vendor/aifisher/server/workflowRuntime/workflowBindingCompiler.js";
import { isWorkflowCredentialFieldName } from "../src/workflow/credentials";
import { convertEditorWorkflow } from "../src/workflow/import-editor";

type Data = Record<string, any>;
type KeyedRunningHubRemote = { baseUrl: string; remoteId: string; apiKey: string; protocol?: "legacy-webapp-v1" | "ai-app-v2"; publicExport?: never };
type PublicRunningHubRemote = { baseUrl: string; remoteId: string; publicExport: true; apiKey?: never; protocol?: never };
export type AifisherRunningHubRemote = KeyedRunningHubRemote | PublicRunningHubRemote;
export type AifisherRunningHubImportRequest = { environment: "runninghub-workflow" | "runninghub-webapp"; source?: unknown; remoteId?: string; remote?: AifisherRunningHubRemote };
export type AifisherRunningHubImportOptions = { projectRoot?: string; fetcher?: typeof fetch; signal?: AbortSignal };

export class AifisherRunningHubImportError extends Error {
  constructor(message: string, public code = "AIFISHER_RUNNINGHUB_IMPORT", public status = 400) { super(message); this.name = "AifisherRunningHubImportError"; }
}
const record = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const WORKFLOW_EXPORT_TIMEOUT_MS = 30_000;
const defaultFetcher: typeof fetch = async (url, init) => {
  const response = await nodeFetch(String(url), init as any);
  const body = response.body && ![204, 205, 304].includes(response.status) ? Readable.toWeb(response.body as Readable) : null;
  return new Response(body as BodyInit | null, { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers) });
};
type WorkflowExportSource = "official-editor-export" | "official-api-export";
type ImportState = { rawInfo?: Data; projectedInfo?: Data; fieldAliases?: Map<string, string>; apiProtocol?: string; source?: Data; remote?: KeyedRunningHubRemote; workflowSnapshot?: Promise<Data>; workflowReadSource?: "official-api-format" | WorkflowExportSource; credentials: Map<string, Data>; secretValues: Set<string> };
const credentialName = (value: unknown) => isWorkflowCredentialFieldName(String(value ?? ""))
  || /^(?:secret|password|token)$/.test(String(value ?? "").trim().toLowerCase());
const publicFieldNameAllowed = (name: string) => /^[\p{L}\p{M}\p{N}._-]{1,160}$/u.test(name)
  && !/(?:^|\.)(?:__proto__|prototype|constructor)(?:\.|$)/.test(name);
function rememberCredential(state: ImportState, nodeId: string, fieldName: string, values: unknown[], required = true) {
  state.credentials.set(JSON.stringify([nodeId, fieldName]), { nodeId, fieldName, required, secret: true });
  for (const value of values) if (typeof value === "string" && value) state.secretValues.add(value);
}
function normalizePublishedField(field: Data): Data {
  const type = String(field.fieldType ?? field.valueType ?? "").trim().toUpperCase();
  let config: unknown = field.fieldData;
  if (typeof config === "string" && config.length <= 64 * 1024) {
    try { config = JSON.parse(config); }
    catch { config = undefined; }
  }
  if (/^(?:LIST|COMBO|SELECT|ENUM)$/.test(type) && Array.isArray(config)
    && ![field.options, field.choices, field.values, field.list].some(Array.isArray)
    && config.some(option => record(option) && Object.hasOwn(option, "index"))) {
    // RunningHub publishes flat menu records whose index is the submitted value.
    // Expose those choices in the original projector's explicit options shape.
    const options = config.flatMap(option => {
      const value = record(option) ? option.index ?? option.value ?? option.id : option;
      return typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? [value] : [];
    });
    if (options.length) field.options = options;
  }
  if (/^(?:BOOLEAN|BOOL|TOGGLE)$/.test(type)) {
    const value = field.fieldValue ?? field.defaultValue ?? field.value;
    if (typeof value === "string" && /^(?:true|false)$/i.test(value.trim())) field.fieldValue = value.trim().toLowerCase() === "true";
  }
  if (/^(?:INT|INTEGER|FLOAT|DOUBLE|NUMBER)$/.test(type) && Array.isArray(config) && config[0] === type && record(config[1])) {
    for (const key of ["min", "max", "step"] as const) {
      const bound = config[1][key];
      if (field[key] === undefined && typeof bound === "number" && Number.isFinite(bound)) field[key] = bound;
    }
  }
  return field;
}
function publicAppInfo(info: Data, state: ImportState): Data {
  const result = Object.fromEntries(Object.entries(info).filter(([key]) => !credentialName(key) && !/^(?:curl|auth|headers|requestHeaders)$/i.test(key)));
  if (Array.isArray(info.nodeInfoList)) result.nodeInfoList = info.nodeInfoList.map((raw: unknown) => {
    // Keep malformed slots in the count used by the upstream field limit.
    if (!record(raw) || !publicFieldNameAllowed(String(raw.fieldName ?? "").trim())) return null;
    const field = structuredClone(raw);
    const isSecret = field.secret === true || credentialName(field.fieldName) || credentialName(field.label ?? field.description)
      || /^(?:PASSWORD|SECRET|API_KEY|ACCESS_TOKEN)$/i.test(String(field.fieldType ?? field.valueType ?? ""));
    if (!isSecret) return normalizePublishedField(field);
    rememberCredential(state, String(field.nodeId), String(field.fieldName), [field.fieldValue, field.defaultValue, field.value, field.default], field.required !== false);
    field.secret = true;
    for (const name of ["fieldValue", "defaultValue", "value", "default"]) if (Object.hasOwn(field, name)) field[name] = "";
    field.fieldValue = "";
    for (const name of ["fieldData", "options", "choices", "values", "list"]) delete field[name];
    return field;
  });
  let clean: Data = result;
  for (const secret of state.secretValues) clean = redactAuthentication(clean, secret);
  return clean;
}

function projectAppFieldNames(info: Data, state: ImportState): Data {
  const ascii = /^[A-Za-z0-9._-]+$/;
  state.fieldAliases = undefined;
  if (!Array.isArray(info.nodeInfoList) || !info.nodeInfoList.some(field => record(field) && !ascii.test(String(field.fieldName).trim()))) return info;
  const aliases = new Map<string, string>(), byName = new Map<string, string>();
  const source = JSON.stringify(info);
  const fields = info.nodeInfoList.map((field: unknown) => {
    if (!record(field)) return field;
    const name = String(field.fieldName ?? "").trim();
    if (ascii.test(name)) return field;
    let alias = byName.get(name);
    if (!alias) {
      const base = "rh_field_" + sha256Json(name).slice(0, 24);
      alias = base;
      for (let index = 2; source.includes(alias) || aliases.has(alias); index++) alias = base + "_" + index;
      byName.set(name, alias);
      aliases.set(alias, name);
    }
    return { ...field, fieldName: alias, label: field.label || field.name || field.description || name };
  });
  // Keep the pinned projector's ASCII field contract and restore exact public
  // field names before the canvas persists or submits its execution graph.
  state.fieldAliases = aliases;
  return { ...info, nodeInfoList: fields };
}

function restoreAppFieldNames<T>(value: T, aliases: ReadonlyMap<string, string>): T {
  function restore(item: unknown): unknown {
    if (typeof item === "string") return aliases.get(item) ?? item;
    if (Array.isArray(item)) return item.map(restore);
    if (record(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [aliases.get(key) ?? key, restore(child)]));
    return item;
  }
  return restore(value) as T;
}

function publicApiGraph(graph: Data, state: ImportState): Data {
  let clean: Data = structuredClone(graph);
  for (const [nodeId, node] of Object.entries(clean)) {
    if (!record(node) || !record(node.inputs)) continue;
    for (const [fieldName, value] of Object.entries(node.inputs)) {
      const titledSecret = /^(?:value|text|string)$/i.test(fieldName) && credentialName(node._meta?.title);
      if (!credentialName(fieldName) && !titledSecret) continue;
      if (Array.isArray(value)) {
        // A connected port is a graph edge. Only an explicit string primitive
        // proves which source value holds the credential; keep the edge intact.
        if (value.length === 2 && typeof value[0] === "string" && value[1] === 0) {
          const source = clean[value[0]];
          if (record(source) && /^PrimitiveString(?:Multiline)?$/.test(source.class_type) && record(source.inputs) && typeof source.inputs.value === "string") {
            rememberCredential(state, value[0], "value", [source.inputs.value]);
            source.inputs.value = "";
          }
        }
        continue;
      }
      rememberCredential(state, nodeId, fieldName, [value]);
      node.inputs[fieldName] = "";
    }
  }
  for (const secret of state.secretValues) clean = redactAuthentication(clean, secret);
  return clean;
}

function sourceObject(source: unknown): Data {
  if (typeof source === "string") {
    try { source = JSON.parse(source.replace(/^\uFEFF/, "")); }
    catch { throw new AifisherRunningHubImportError("工作流来源不是有效 JSON。", "AIFISHER_READER_JSON"); }
  }
  if (!record(source)) throw new AifisherRunningHubImportError("工作流来源必须为 JSON 对象。", "AIFISHER_READER_INVALID_REQUEST");
  return source;
}
function remoteReference(input: AifisherRunningHubImportRequest): AifisherRunningHubRemote | undefined {
  if (!input.remote) return;
  if (input.source !== undefined || !record(input.remote)) throw new AifisherRunningHubImportError("远程读取和本地来源不能同时提供。", "AIFISHER_READER_SOURCE_CONFLICT");
  const baseUrl = normalizeRunningHubBaseUrl(input.remote.baseUrl);
  if (new URL(baseUrl).port) throw new AifisherRunningHubImportError("RunningHub 地址必须使用官方 HTTPS 端口。");
  const remoteId = assertRunningHubRemoteId(input.remote.remoteId);
  if (input.remote.publicExport !== undefined) {
    if (input.remote.publicExport !== true || input.environment !== "runninghub-workflow" || input.remote.apiKey !== undefined || input.remote.protocol !== undefined || !/^[1-9]\d{0,31}$/.test(remoteId))
      throw new AifisherRunningHubImportError("官网公开导出仅接受 RunningHub 工作流 ID。", "RUNNINGHUB_WORKFLOW_PUBLIC_EXPORT_INVALID");
    return { baseUrl, remoteId, publicExport: true };
  }
  if (typeof input.remote.apiKey !== "string" || !input.remote.apiKey.trim()) throw new AifisherRunningHubImportError("请先配置 RunningHub API Key。", "RUNNINGHUB_CREDENTIAL_NOT_CONFIGURED", 409);
  const protocol = input.remote.protocol;
  if (protocol !== undefined && protocol !== "legacy-webapp-v1" && protocol !== "ai-app-v2") throw new AifisherRunningHubImportError("RunningHub 读取协议无效。");
  return { baseUrl, remoteId, apiKey: input.remote.apiKey.trim(), ...(protocol ? { protocol } : {}) };
}
function safeReadTarget(value: string | URL, method = "GET") {
  const url = new URL(value);
  const official = ["www.runninghub.cn", "runninghub.cn", "www.runninghub.ai", "runninghub.ai"].includes(url.hostname);
  const asset = ["xiaoyaoyou.com", "rh-images-1252422369.cos.ap-beijing.myqcloud.com", "runninghub.cn", "runninghub.ai"].some(host => url.hostname === host || url.hostname.endsWith("." + host));
  if (url.protocol !== "https:" || url.username || url.password || url.port || !asset) throw new AifisherRunningHubImportError("工作流读取拒绝访问非 RunningHub 地址。", "AIFISHER_READ_TARGET", 400);
  if (method === "POST" && official && ["/api/openapi/getJsonApiFormat", "/api/webapp/detail", "/api/workflow/getDetail", "/api/workflow/export"].includes(url.pathname)) return;
  if (method === "GET" && !/^\/(?:task\/openapi|openapi\/v2\/run)\//.test(url.pathname)) return;
  throw new AifisherRunningHubImportError("工作流读取不能提交生成任务。", "AIFISHER_READ_ONLY", 400);
}

function workflowNodeTypes(workflow: Data): string[] {
  const types = new Set<string>();
  const pending: unknown[] = [workflow];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
      continue;
    }
    if (!record(value)) continue;
    if (Array.isArray(value.nodes)) for (const node of value.nodes) {
      if (record(node) && typeof node.type === "string" && node.type) types.add(node.type);
    }
    for (const child of Object.values(value)) pending.push(child);
  }
  return [...types];
}

function readSignal(...sources: (AbortSignal | null | undefined)[]) {
  const signals = [...new Set(sources.filter((signal): signal is AbortSignal => !!signal))];
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

function workflowExportBudget(...sources: (AbortSignal | undefined)[]) {
  const deadline = AbortSignal.timeout(WORKFLOW_EXPORT_TIMEOUT_MS);
  return {
    signal: readSignal(...sources, deadline),
    throwIfInterrupted() {
      for (const signal of sources) signal?.throwIfAborted();
      if (deadline.aborted) throw new AifisherRunningHubImportError("读取 RunningHub 官网工作流超时，请重试。", "RUNNINGHUB_WORKFLOW_EXPORT_TIMEOUT", 504);
    },
  };
}

async function fetchRunningHubRead(url: string | URL, init: RequestInit, host: AifisherRunningHubImportOptions, requestSignal?: AbortSignal) {
  safeReadTarget(url, String(init.method ?? "GET").toUpperCase());
  const signal = readSignal(host.signal, requestSignal, init.signal);
  signal?.throwIfAborted();
  try { return await (host.fetcher ?? defaultFetcher)(String(url), { ...init, redirect: "manual", signal }); }
  catch {
    signal?.throwIfAborted();
    throw new AifisherRunningHubImportError("无法连接 RunningHub 工作流读取服务。", "RUNNINGHUB_UNAVAILABLE", 502);
  }
}

async function readPublicJson(baseUrl: string, endpoint: string, init: RequestInit, host: AifisherRunningHubImportOptions, signal?: AbortSignal): Promise<Data> {
  const target = new URL(endpoint, baseUrl);
  const read = () => fetchRunningHubRead(target, { ...init, credentials: "omit" }, host, signal);
  const response = await read().catch(error => {
    if (!(error instanceof AifisherRunningHubImportError) || error.code !== "RUNNINGHUB_UNAVAILABLE") throw error;
    return read();
  });
  if (!response.ok) throw new AifisherRunningHubImportError(`RunningHub 官网工作流读取失败（HTTP ${response.status}）。`, "RUNNINGHUB_WORKFLOW_EXPORT_UNAVAILABLE", 502);
  const text = await response.text();
  host.signal?.throwIfAborted();
  signal?.throwIfAborted();
  let result: unknown;
  try { result = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new AifisherRunningHubImportError("RunningHub 官网未返回有效的工作流 JSON。", "RUNNINGHUB_WORKFLOW_EXPORT_INVALID", 502); }
  if (!record(result) || (Object.hasOwn(result, "code") && Number(result.code) !== 0)) throw new AifisherRunningHubImportError("RunningHub 官网未提供可读取的工作流内容。", "RUNNINGHUB_WORKFLOW_EXPORT_UNAVAILABLE", 409);
  return result;
}

function workflowReadRequest(id: string): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", accept: "*/*" },
    body: JSON.stringify({ workflowId: assertRunningHubRemoteId(id) }) };
}

async function requirePublishedWorkflow(remote: PublicRunningHubRemote, host: AifisherRunningHubImportOptions) {
  const detail = await readPublicJson(remote.baseUrl, "/api/workflow/getDetail", workflowReadRequest(remote.remoteId), host);
  const workflow = detail.data;
  const id = record(workflow) && (typeof workflow.id === "string" || Number.isSafeInteger(workflow.id)) ? String(workflow.id) : undefined;
  const access = record(workflow) && record(workflow.publishAccess) ? workflow.publishAccess : undefined;
  if ((detail.code !== 0 && detail.code !== "0") || id !== remote.remoteId || workflow?.workflowState !== 1
    || access?.granted !== true || access.encrypted !== false || access.needPassword !== false) {
    throw new AifisherRunningHubImportError("此 RunningHub 工作流未开放公开导出。", "RUNNINGHUB_WORKFLOW_PUBLIC_ACCESS_REQUIRED", 403);
  }
}

async function readWorkflowExport(baseUrl: string, id: string, host: AifisherRunningHubImportOptions, signal?: AbortSignal) {
  const source = await readPublicJson(baseUrl, "/api/workflow/export", workflowReadRequest(id), host, signal);
  return parseWorkflowArtifact(JSON.stringify(source));
}

async function prepareWorkflowExport(artifact: ReturnType<typeof parseWorkflowArtifact>, baseUrl: string, host: AifisherRunningHubImportOptions, signal?: AbortSignal): Promise<{ graph: Data; readSource: WorkflowExportSource }> {
  if (artifact.format === "comfy-api") return { graph: normalizeApiWorkflow(artifact.workflow), readSource: "official-api-export" };
  // Per-class queries fetch only the contracts used by this exported graph.
  const definitions = Object.create(null) as Data;
  const types = workflowNodeTypes(artifact.workflow);
  for (let offset = 0; offset < types.length; offset += 8) {
    await Promise.all(types.slice(offset, offset + 8).map(async classType => {
      try {
        const catalog = await readPublicJson(baseUrl, "/object_info/" + encodeURIComponent(classType), { method: "GET", headers: { accept: "application/json" } }, host, signal);
        const nodes = record(catalog.nodes_info) ? catalog.nodes_info : catalog;
        if (Object.hasOwn(nodes, classType) && record(nodes[classType])) definitions[classType] = nodes[classType];
      } catch (error) {
        host.signal?.throwIfAborted();
        signal?.throwIfAborted();
        if (!(error instanceof AifisherRunningHubImportError) || error.code === "AIFISHER_READ_TARGET" || error.code === "AIFISHER_READ_ONLY") throw error;
        // A frontend-only node or a saved named schema can still be resolved
        // without this catalog entry. The converter checks all active ports.
      }
    }));
  }
  const converted = convertEditorWorkflow(artifact.workflow, definitions);
  return { graph: normalizeApiWorkflow(converted.graph), readSource: "official-editor-export" };
}

/** Upstream services retain their API-format entry point; the host also reads the official editor export when its API snapshot is absent. */
class HostRunningHubClient extends RunningHubWorkflowClient {
  constructor(options: Data, private host: AifisherRunningHubImportOptions, private state: ImportState) {
    super({ ...options, fetcher: host.fetcher ?? defaultFetcher });
  }
  override async fetchWithTimeout(url: string | URL, init: RequestInit = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Response> {
    if (!this.state.remote) throw new AifisherRunningHubImportError("离线工作流读取不访问网络。", "AIFISHER_OFFLINE_NETWORK_DISABLED");
    safeReadTarget(url, String(init.method ?? "GET").toUpperCase());
    const signal = readSignal(this.host.signal, options.signal, init.signal);
    return super.fetchWithTimeout(String(url), init, { ...options, signal });
  }
  override async getWorkflowApiFormat(id: string, options: { signal?: AbortSignal } = {}) {
    this.host.signal?.throwIfAborted();
    options.signal?.throwIfAborted();
    const remote = this.state.remote;
    if (!remote) return publicApiGraph(this.state.source!, this.state);
    // The definition and deployment verifier must see the same graph snapshot.
    this.state.workflowSnapshot ??= this.readRemoteWorkflow(id, remote.baseUrl, options.signal);
    return publicApiGraph(await this.state.workflowSnapshot, this.state);
  }
  private async readRemoteWorkflow(id: string, baseUrl: string, signal?: AbortSignal) {
    try {
      const graph = normalizeApiWorkflow(await super.getWorkflowApiFormat(id, { signal: this.host.signal ?? signal }));
      this.state.workflowReadSource = "official-api-format";
      return graph;
    } catch (error) {
      if (!(error instanceof Error) || !/\bWORKFLOW_NOT_SAVED_OR_NOT_RUNNING\b/.test(error.message)) throw error;
      const budget = workflowExportBudget(this.host.signal, signal);
      let artifact: Awaited<ReturnType<typeof readWorkflowExport>> | undefined;
      try {
        artifact = await readWorkflowExport(baseUrl, id, this.host, budget.signal);
        const { graph, readSource } = await prepareWorkflowExport(artifact, baseUrl, this.host, budget.signal);
        budget.throwIfInterrupted();
        this.state.workflowReadSource = readSource;
        return graph;
      } catch (cause) {
        budget.throwIfInterrupted();
        if (!artifact || artifact.format === "comfy-api") throw cause;
        throw new AifisherRunningHubImportError(cause instanceof Error ? cause.message : "工作流需要在目标 ComfyUI 节点定义下转换。", "RUNNINGHUB_WORKFLOW_EDITOR_CONVERSION_REQUIRED", 409);
      }
    }
  }
  override async getWebAppInfoForProtocol(id: string, protocol: string, options: { signal?: AbortSignal } = {}) {
    this.host.signal?.throwIfAborted();
    const raw = this.state.remote ? await super.getWebAppInfoForProtocol(id, protocol, { ...options, signal: this.host.signal ?? options.signal }) : this.state.source!;
    const info = publicAppInfo(raw, this.state);
    this.state.rawInfo = info;
    this.state.projectedInfo = projectAppFieldNames(info, this.state);
    return this.state.projectedInfo;
  }
  override async resolveWebAppInfo(id: string, options: { signal?: AbortSignal } = {}) {
    const resolved = this.state.remote?.protocol
      ? { apiProtocol: this.state.remote.protocol, info: await this.getWebAppInfoForProtocol(id, this.state.remote.protocol, options) }
      : await super.resolveWebAppInfo(id, options);
    this.state.apiProtocol = resolved.apiProtocol;
    return resolved;
  }
  override async getWebAppCover(id: string) { return this.state.remote ? super.getWebAppCover(id) : null; }
}

function redactAuthentication(value: any, key: string): any {
  if (typeof value === "string") {
    if (!key) return value;
    let result = value;
    for (const variant of new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])) if (variant) result = result.split(variant).join("[已隐藏密钥]");
    return result;
  }
  if (Array.isArray(value)) return value.map(item => redactAuthentication(item, key));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactAuthentication(item, key)]));
  return value;
}

/** Full upstream stores/services work in an owned temporary library, never the user's library. */
export async function readUpstreamRunningHubImport(input: AifisherRunningHubImportRequest, options: AifisherRunningHubImportOptions = {}) {
  const reference = remoteReference(input);
  const remote = reference?.publicExport ? undefined : reference;
  let source = reference ? undefined : sourceObject(input.source);
  if (source && input.environment === "runninghub-workflow") {
    const parsed = parseWorkflowArtifact(JSON.stringify(source));
    if (parsed.format !== "comfy-api") throw new AifisherRunningHubImportError("RunningHub 工作流接口需要返回 API Format。", "AIFISHER_RUNNINGHUB_API_REQUIRED");
    source = normalizeApiWorkflow(parsed.workflow);
  }
  const id = reference?.remoteId ?? assertRunningHubRemoteId(input.remoteId ?? "offline-import");
  const baseUrl = reference?.baseUrl ?? "https://www.runninghub.cn";
  const credentialRef = new URL(baseUrl).hostname.endsWith(".ai") ? "runninghub-global" : "runninghub-cn";
  const state: ImportState = { source, remote, credentials: new Map(), secretValues: new Set() };
  if (reference?.publicExport) {
    const budget = workflowExportBudget(options.signal);
    const readOptions = { ...options, signal: budget.signal };
    let artifact: Awaited<ReturnType<typeof readWorkflowExport>>;
    try {
      await requirePublishedWorkflow(reference, readOptions);
      artifact = await readWorkflowExport(baseUrl, id, readOptions);
    } catch (error) {
      budget.throwIfInterrupted();
      throw error;
    }
    try {
      const { graph, readSource } = await prepareWorkflowExport(artifact, baseUrl, readOptions);
      state.source = graph;
      state.workflowReadSource = readSource;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (artifact.format === "comfy-api") throw error;
      // The linked AutoDL instance can retry conversion using its own node definitions.
      return { format: artifact.format, workflow: null, editorWorkflow: artifact.workflow, analysis: {},
        nodeDefinitions: {}, bindingCandidates: [], runninghubSource: { workflowReadSource: "official-editor-export" as const } };
    }
  }
  const cacheRoot = path.resolve(options.projectRoot ?? process.cwd(), ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const temporary = path.join(cacheRoot, "aifisher-read-" + randomUUID());
  await mkdir(temporary);
  try {
    options.signal?.throwIfAborted();
    const libraryDirectory = path.join(temporary, "library"), storageDirectory = path.join(temporary, "private");
    const definitionStore = new WorkflowDefinitionStore({ libraryDirectory, storageDirectory });
    const configurationStore = new WorkflowConfigurationStore({ libraryDirectory, storageDirectory });
    const clientFactory = (settings: Data) => new HostRunningHubClient(settings, options, state);
    const credentialResolver = async () => remote?.apiKey ?? "offline-import";
    const deploymentService = new WorkflowDeploymentService({ definitionStore, configurationStore, credentialResolver, runningHubClientFactory: clientFactory });
    let definitionId: string;
    let projection: ReturnType<typeof createRunningHubWebAppProjection> | undefined;
    if (input.environment === "runninghub-webapp") {
      const library = new RunningHubWebAppLibraryService({ definitionStore, configurationStore, deploymentService, credentialResolver, clientFactory });
      const app = await library.createApp({ webAppId: id, credentialRef });
      definitionId = app.definitionId;
      projection = createRunningHubWebAppProjection(id, state.projectedInfo!);
    } else {
      const client = clientFactory({ baseUrl, apiKey: await credentialResolver() });
      const graph = await client.getWorkflowApiFormat(id);
      const definition = await definitionStore.createDefinition({ content: JSON.stringify(graph), originalFilename: "runninghub-workflow.json", origin: "runninghub-workflow" });
      definitionId = definition.id;
      const deployed = await deploymentService.createDeployment(definitionId, { runner: "runninghub-workflow", baseUrl, credentialRef, remoteWorkflowId: id, includeWorkflowJson: false });
      await deploymentService.createBindingSet(definitionId, { deploymentId: deployed.dto.id, name: "RunningHub 工作流字段", bindings: deployed.candidates.map((candidate: Data) => ({ candidateId: candidate.id })) });
    }
    options.signal?.throwIfAborted();
    const plan = await definitionStore.readExecutionPlan(definitionId);
    const deployments = await configurationStore.listDeployments(definitionId), bindingSets = await configurationStore.listBindingSets(definitionId);
    const deployment = deployments[deployments.length - 1], bindingSet = bindingSets[bindingSets.length - 1];
    const canvasService = new WorkflowCanvasNodeService({ definitionStore, configurationStore, deploymentService });
    const blueprint = await canvasService.createBlueprint(definitionId, { deploymentId: deployment.id, bindingSetId: bindingSet.id });
    const nodeDefinitions = deployment.relevantCapabilities;
    const analysis = analyzeWorkflow(plan.apiJson, "comfy-api", { objectInfo: nodeDefinitions });
    const upstream = { format: "comfy-api", workflow: plan.apiJson, analysis, nodeDefinitions,
      bindingCandidates: deriveBindingCandidates({ executionPlan: plan.apiJson, nodeDefinitions }), parameterBindings: bindingSet.bindings, parameterBindingDto: toBindingSetDto(bindingSet),
      canvasBlueprint: { ...blueprint, coverUrl: null },
      ...(projection ? { projection, category: projection.snapshot.categoryId } : {}),
      credentialTargets: [...state.credentials.values()],
      runninghubSource: { ...(state.rawInfo ? { rawInfo: state.rawInfo } : {}), ...(state.apiProtocol ? { apiProtocol: state.apiProtocol } : {}), ...(state.workflowReadSource ? { workflowReadSource: state.workflowReadSource } : {}), credentialTargets: [...state.credentials.values()] },
    };
    const aliases = state.fieldAliases;
    const result = aliases?.size ? restoreAppFieldNames(upstream, aliases) : upstream;
    if (aliases?.size && result.projection) {
      result.projection.schemaHash = sha256Json(result.projection.snapshot);
      result.projection.executionPlanHash = sha256Json(result.projection.executionPlan);
    }
    return redactAuthentication(result, remote?.apiKey ?? "");
  } finally {
    const relative = path.relative(cacheRoot, path.resolve(temporary));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(temporary).startsWith("aifisher-read-")) throw new AifisherRunningHubImportError("临时读取目录越界，已保留现场。", "AIFISHER_READER_TEMP_BOUNDARY", 500);
    await rm(temporary, { recursive: true, force: true });
  }
}
