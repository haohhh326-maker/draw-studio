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
import { analyzeWorkflow, parseWorkflowArtifact, normalizeApiWorkflow } from "../vendor/aifisher/server/workflowRuntime/workflowFormat.js";
import { deriveBindingCandidates, toBindingSetDto } from "../vendor/aifisher/server/workflowRuntime/workflowBindingCompiler.js";
import { isWorkflowCredentialFieldName } from "../src/workflow/credentials";
import { convertEditorWorkflow } from "../src/workflow/import-editor";

type Data = Record<string, any>;
export type AifisherRunningHubRemote = { baseUrl: string; remoteId: string; apiKey: string; protocol?: "legacy-webapp-v1" | "ai-app-v2" };
export type AifisherRunningHubImportRequest = { environment: "runninghub-workflow" | "runninghub-webapp"; source?: unknown; remoteId?: string; remote?: AifisherRunningHubRemote };
export type AifisherRunningHubImportOptions = { projectRoot?: string; fetcher?: typeof fetch; signal?: AbortSignal };

export class AifisherRunningHubImportError extends Error {
  constructor(message: string, public code = "AIFISHER_RUNNINGHUB_IMPORT", public status = 400) { super(message); this.name = "AifisherRunningHubImportError"; }
}
const record = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const defaultFetcher: typeof fetch = async (url, init) => {
  const response = await nodeFetch(String(url), init as any);
  const body = response.body && ![204, 205, 304].includes(response.status) ? Readable.toWeb(response.body as Readable) : null;
  return new Response(body as BodyInit | null, { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers) });
};
type ImportState = { rawInfo?: Data; apiProtocol?: string; source?: Data; remote?: AifisherRunningHubRemote; workflowFallback?: Promise<Data>; workflowReadSource?: "official-api-format" | "official-editor-export" | "official-api-export"; credentials: Map<string, Data>; secretValues: Set<string> };
const credentialName = (value: unknown) => isWorkflowCredentialFieldName(String(value ?? ""))
  || /^(?:secret|password|token)$/.test(String(value ?? "").trim().toLowerCase());
function rememberCredential(state: ImportState, nodeId: string, fieldName: string, values: unknown[], required = true) {
  state.credentials.set(JSON.stringify([nodeId, fieldName]), { nodeId, fieldName, required, secret: true });
  for (const value of values) if (typeof value === "string" && value) state.secretValues.add(value);
}
function publicAppInfo(info: Data, state: ImportState): Data {
  const result = Object.fromEntries(Object.entries(info).filter(([key]) => !credentialName(key) && !/^(?:curl|auth|headers|requestHeaders)$/i.test(key)));
  if (Array.isArray(info.nodeInfoList)) result.nodeInfoList = info.nodeInfoList.map((raw: unknown) => {
    if (!record(raw)) return raw;
    const field = structuredClone(raw);
    const isSecret = field.secret === true || credentialName(field.fieldName) || credentialName(field.label ?? field.description)
      || /^(?:PASSWORD|SECRET|API_KEY|ACCESS_TOKEN)$/i.test(String(field.fieldType ?? field.valueType ?? ""));
    if (!isSecret) return field;
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
  if (method === "POST" && official && ["/api/openapi/getJsonApiFormat", "/api/webapp/detail", "/api/workflow/export"].includes(url.pathname)) return;
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

/** Upstream services retain their API-format entry point; the host also reads the official editor export when its API snapshot is absent. */
class HostRunningHubClient extends RunningHubWorkflowClient {
  constructor(options: Data, private host: AifisherRunningHubImportOptions, private state: ImportState) { super(options); }
  override async fetchWithTimeout(url: string | URL, init: RequestInit = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Response> {
    if (!this.state.remote) throw new AifisherRunningHubImportError("离线工作流读取不访问网络。", "AIFISHER_OFFLINE_NETWORK_DISABLED");
    safeReadTarget(url, String(init.method ?? "GET").toUpperCase());
    const signals = [...new Set([this.host.signal, options.signal, init.signal].filter((signal): signal is AbortSignal => !!signal))];
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    signal?.throwIfAborted();
    try { return await (this.host.fetcher ?? defaultFetcher)(String(url), { ...init, redirect: "manual", signal }); }
    catch (error) {
      signal?.throwIfAborted();
      throw new AifisherRunningHubImportError("无法连接 RunningHub 工作流读取服务。", "RUNNINGHUB_UNAVAILABLE", 502);
    }
  }
  override async getWorkflowApiFormat(id: string, options: { signal?: AbortSignal } = {}) {
    this.host.signal?.throwIfAborted();
    let graph = this.state.source!;
    if (this.state.remote) {
      if (this.state.workflowFallback) graph = await this.state.workflowFallback;
      else {
        try {
          graph = await super.getWorkflowApiFormat(id, { ...options, signal: this.host.signal ?? options.signal });
          this.state.workflowReadSource = "official-api-format";
        }
        catch (error) {
          if (!(error instanceof Error) || !/\bWORKFLOW_NOT_SAVED_OR_NOT_RUNNING\b/.test(error.message)) throw error;
          this.state.workflowFallback = this.readWorkflowExport(id, options.signal);
          graph = await this.state.workflowFallback;
        }
      }
    }
    return publicApiGraph(graph, this.state);
  }
  private async readPublicJson(endpoint: string, init: RequestInit, signal?: AbortSignal): Promise<Data> {
    const response = await this.fetchWithTimeout(new URL(endpoint, this.state.remote!.baseUrl), init, { signal });
    if (!response.ok) throw new AifisherRunningHubImportError(`RunningHub 官网工作流读取失败（HTTP ${response.status}）。`, "RUNNINGHUB_WORKFLOW_EXPORT_UNAVAILABLE", 502);
    const text = await response.text();
    this.host.signal?.throwIfAborted();
    signal?.throwIfAborted();
    let result: unknown;
    try { result = JSON.parse(text.replace(/^\uFEFF/, "")); }
    catch { throw new AifisherRunningHubImportError("RunningHub 官网未返回有效的工作流 JSON。", "RUNNINGHUB_WORKFLOW_EXPORT_INVALID", 502); }
    if (!record(result) || (Object.hasOwn(result, "code") && Number(result.code) !== 0)) throw new AifisherRunningHubImportError("RunningHub 官网未提供可读取的工作流内容。", "RUNNINGHUB_WORKFLOW_EXPORT_UNAVAILABLE", 409);
    return result;
  }
  private async readWorkflowExport(id: string, signal?: AbortSignal): Promise<Data> {
    // This is the website's read-only export operation. Public requests contain
    // neither the API key nor the caller's account headers.
    const source = await this.readPublicJson("/api/workflow/export", {
      method: "POST", headers: { "content-type": "application/json", accept: "*/*" },
      body: JSON.stringify({ workflowId: assertRunningHubRemoteId(id) }),
    }, signal);
    const artifact = parseWorkflowArtifact(JSON.stringify(source));
    if (artifact.format === "comfy-api") {
      this.state.workflowReadSource = "official-api-export";
      return normalizeApiWorkflow(artifact.workflow);
    }
    // A complete site catalog is tens of megabytes. ComfyUI's per-class route
    // supplies exactly the live contracts used by this exported graph, including subgraphs.
    const entries = await Promise.all(workflowNodeTypes(artifact.workflow).map(async classType => {
      const catalog = await this.readPublicJson("/object_info/" + encodeURIComponent(classType), { method: "GET", headers: { accept: "application/json" } }, signal);
      const definitions = record(catalog.nodes_info) ? catalog.nodes_info : catalog;
      return [classType, definitions[classType]] as const;
    }));
    const definitions = Object.fromEntries(entries.filter(([, definition]) => record(definition)));
    const converted = convertEditorWorkflow(artifact.workflow, definitions);
    this.state.workflowReadSource = "official-editor-export";
    return normalizeApiWorkflow(converted.graph);
  }
  override async getWebAppInfoForProtocol(id: string, protocol: string, options: { signal?: AbortSignal } = {}) {
    this.host.signal?.throwIfAborted();
    const raw = this.state.remote ? await super.getWebAppInfoForProtocol(id, protocol, { ...options, signal: this.host.signal ?? options.signal }) : this.state.source!;
    const info = publicAppInfo(raw, this.state);
    this.state.rawInfo = info;
    return info;
  }
  override async resolveWebAppInfo(id: string, options: { signal?: AbortSignal } = {}) {
    const resolved = this.state.remote?.protocol
      ? { apiProtocol: this.state.remote.protocol, info: await this.getWebAppInfoForProtocol(id, this.state.remote.protocol, options) }
      : await super.resolveWebAppInfo(id, options);
    this.state.rawInfo = resolved.info; this.state.apiProtocol = resolved.apiProtocol;
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
  const remote = remoteReference(input);
  let source = remote ? undefined : sourceObject(input.source);
  if (source && input.environment === "runninghub-workflow") {
    const parsed = parseWorkflowArtifact(JSON.stringify(source));
    if (parsed.format !== "comfy-api") throw new AifisherRunningHubImportError("RunningHub 工作流接口需要返回 API Format。", "AIFISHER_RUNNINGHUB_API_REQUIRED");
    source = normalizeApiWorkflow(parsed.workflow);
  }
  const id = remote?.remoteId ?? assertRunningHubRemoteId(input.remoteId ?? "offline-import");
  const baseUrl = remote?.baseUrl ?? "https://www.runninghub.cn";
  const credentialRef = new URL(baseUrl).hostname.endsWith(".ai") ? "runninghub-global" : "runninghub-cn";
  const state: ImportState = { source, remote, credentials: new Map(), secretValues: new Set() };
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
      projection = createRunningHubWebAppProjection(id, state.rawInfo!);
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
    return redactAuthentication({ format: "comfy-api", workflow: plan.apiJson, analysis, nodeDefinitions,
      bindingCandidates: deriveBindingCandidates({ executionPlan: plan.apiJson, nodeDefinitions }), parameterBindings: bindingSet.bindings, parameterBindingDto: toBindingSetDto(bindingSet),
      canvasBlueprint: { ...blueprint, coverUrl: null },
      ...(projection ? { projection, category: projection.snapshot.categoryId } : {}),
      credentialTargets: [...state.credentials.values()],
      runninghubSource: { ...(state.rawInfo ? { rawInfo: state.rawInfo } : {}), ...(state.apiProtocol ? { apiProtocol: state.apiProtocol } : {}), ...(state.workflowReadSource ? { workflowReadSource: state.workflowReadSource } : {}), credentialTargets: [...state.credentials.values()] },
    }, remote?.apiKey ?? "");
  } finally {
    const relative = path.relative(cacheRoot, path.resolve(temporary));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(temporary).startsWith("aifisher-read-")) throw new AifisherRunningHubImportError("临时读取目录越界，已保留现场。", "AIFISHER_READER_TEMP_BOUNDARY", 500);
    await rm(temporary, { recursive: true, force: true });
  }
}
