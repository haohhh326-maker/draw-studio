import { isTauri } from "@tauri-apps/api/core";
import { ApiError, ComfyUIClient, ExecutionError, type History } from "../comfyui/client";
import { checkedOutput, fileName, relativePath } from "../comfyui/files";
import { logHttp } from "../comfyui/diagnostics";
import { detectWorkflowCredentials, isWorkflowCredentialFieldName } from "../workflow/credentials";
import { readableRunningHubError } from "./error-message";
import { validateRunningHubExecutionGraph, validateRunningHubPublicSchema, validateRunningHubRemoteWorkflow } from "./execution-contract";
import { normalizeRunningHubInstanceType } from "./instance-types";
import type { ApiWorkflow, Connection, MediaKind, RemoteFile, RunningHubInstanceType, RunningHubWorkflowMetadata, TaskState, UploadedInput, WorkflowDefinition } from "../types";
import type { RunningHubReaderResult } from "./upstream-reader";
import { readAifisherWorkflow, type AifisherWorkflowReadResult } from "../workflow/aifisher-reader-client";
export type { RunningHubWorkflowMetadata } from "../types";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined;
const submittedTasks = new Map<string, string>();
const pending = new Set(["QUEUED", "PENDING", "RUNNING", "PROCESSING"]);
const failed = new Set(["FAILED", "ERROR", "CANCELLED", "CANCELED"]);
// Only these fixed messages may cross from the local download proxy into diagnostics.
const downloadProxyErrors = new Map([
  ["结果下载地址无效。", 400],
  ["结果下载仅支持公开 HTTPS 地址。", 400],
  ["结果下载地址不允许访问本地网络。", 400],
  ["结果下载地址不允许访问本地或保留网络。", 400],
  ["结果下载仅接受一个结果地址。", 400],
  ["RunningHub 请求路径无效。", 400],
  ["RunningHub 代理仅允许画布同源访问。", 403],
  ["结果下载只接受 GET。", 405],
  ["RunningHub 官方结果域名解析暂时失败，请稍后恢复原任务。", 502],
]);

function browserApi(path: string, baseUrl: string) {
  if (isTauri() || typeof window === "undefined") return { url: baseUrl + path, headers: {} as Record<string, string> };
  return { url: new URL(import.meta.env.BASE_URL + "api/runninghub" + path, window.location.origin).toString(), headers: { "X-RunningHub-Base-Url": baseUrl } };
}

function requestFailureMessage(path: string): string {
  if (path === "/openapi/v2/media/upload/binary")
    return "RunningHub 素材上传连接中断，尚未提交生成任务。";
  if (path === "/uc/openapi/accountStatus")
    return "RunningHub 账户检测连接中断，请重新检测连接。";
  if (["/task/openapi/create", "/task/openapi/ai-app/run"].includes(path) || /^\/openapi\/v2\/run\/ai-app\/\d{1,32}$/.test(path))
    return "RunningHub 提交请求连接中断，是否已接受任务尚未确认。请查询原任务，不要重复提交。";
  if (["/task/openapi/status", "/task/openapi/outputs", "/openapi/v2/query"].includes(path))
    return "RunningHub 任务查询连接中断，可恢复查询原任务。";
  if (path === "/task/openapi/cancel")
    return "RunningHub 取消请求连接中断，尚未确认任务是否已取消，请查询原任务状态。";
  return "RunningHub 请求连接中断，请检查 RunningHub 连接。";
}

export function normalizeRunningHubBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("请选择有效的 RunningHub 站点。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port || !["", "/"].includes(url.pathname) || !["runninghub.cn", "www.runninghub.cn", "runninghub.ai", "www.runninghub.ai"].includes(url.hostname))
    throw new Error("RunningHub 站点需使用 https://www.runninghub.cn 或 https://www.runninghub.ai。");
  return "https://www." + url.hostname.replace(/^www\./, "");
}

function workflowId(value: string): string {
  if (!/^\d{1,32}$/.test(value)) throw new Error("RunningHub 工作流 ID 无效，请填写工作流页面中的数字 ID。");
  return value;
}

export type RunningHubNodeInfo = { nodeId: string; fieldName: string; fieldValue: string | number | boolean | null };
export type RunningHubAppField = RunningHubNodeInfo & {
  nodeName?: string; fieldType?: string; description?: string; fieldData?: unknown;
  required?: boolean; secret?: boolean; min?: number; max?: number; step?: number;
  defaultValuePresent?: boolean;
  /** Present only when the source advertises an actual empty-media value. */
  mediaEmptyValue?: string | null;
};
export type RunningHubAiApp = {
  nodeInfoList: RunningHubAppField[]; name?: string; outputKind?: MediaKind;
  apiVersion: "v1" | "v2"; generationModels?: string[]; diagnostics?: string[];
  /** Public schema and presentation only; authentication keys are never retained here. */
  rawInfo?: Record<string, unknown>;
  reader?: RunningHubReaderResult;
};
export type RunningHubAccountStatus = {
  valid: true; currency?: string; apiType?: string;
  remainCoins?: string; remainMoney?: string; currentTaskCounts?: string;
};

/** Keep exact decimal strings from the account API, without coercing missing values to zero. */
function accountDecimal(value: unknown): string | undefined {
  if (typeof value === "string") {
    const decimal = value.trim();
    return decimal.length <= 200 && /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(decimal) && Number.isFinite(Number(decimal)) ? decimal : undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  const decimal = String(value);
  if (!/[eE]/.test(decimal)) return decimal;
  // Expand the number's own decimal representation, avoiding an extra precision-losing round trip.
  const negative = decimal.startsWith("-");
  const [coefficient, exponent] = (negative ? decimal.slice(1) : decimal).toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = whole + fraction, point = whole.length + Number(exponent);
  return (negative ? "-" : "") + (point <= 0 ? "0." + "0".repeat(-point) + digits
    : point >= digits.length ? digits + "0".repeat(point - digits.length)
    : digits.slice(0, point) + "." + digits.slice(point));
}

/** Public detail records carry the published title and cover, not API-format graphs. */
export function parseRunningHubWorkflowMetadata(value: unknown, expectedId: string): RunningHubWorkflowMetadata {
  if (!record(value)) throw new Error("RunningHub 工作流详情格式无效。");
  const data = record(value.data) ? value.data : value;
  if (identifier(data.id) !== expectedId) throw new Error("RunningHub 返回的详情与工作流 ID 不一致。");
  const name = typeof data.name === "string" ? data.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240) : "";
  const coverUrl = (raw: unknown) => {
    if (typeof raw !== "string" || raw.length > 4000) return;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) return;
      if (!["runninghub.cn", "runninghub.ai", "xiaoyaoyou.com"].some(host => url.hostname === host || url.hostname.endsWith("." + host))
        && url.hostname !== "rh-images-1252422369.cos.ap-beijing.myqcloud.com") return;
      return url.toString();
    } catch { return; }
  };
  const covers = [data.covers, data.chineseCovers, data.englishCovers].flatMap(items => Array.isArray(items) ? items.slice(0, 20) : []);
  for (const item of covers) {
    if (!record(item)) continue;
    const source = coverUrl(item.url), thumbnail = coverUrl(item.thumbnailUri);
    // The platform's video thumbnailUri can still return video/mp4 even with
    // an imageMogr2 query. Keep it as video instead of rendering a broken img.
    const video = !!source && /\.(?:mp4|webm|mov|m4v)$/i.test(new URL(source).pathname);
    const selected = video ? source : thumbnail ?? source;
    if (selected) return { ...(name ? { name } : {}), coverUrl: selected, coverMediaType: video ? "video" : "image" };
  }
  return name ? { name } : {};
}
export function isRunningHubAppCredentialField(field: Pick<RunningHubAppField, "fieldName" | "description" | "fieldType" | "secret">): boolean {
  return field.secret === true || isWorkflowCredentialFieldName(field.fieldName)
    || isWorkflowCredentialFieldName(field.description ?? "")
    || /^(?:PASSWORD|SECRET|API_KEY|ACCESS_TOKEN)$/i.test(field.fieldType ?? "");
}

/** This container copies original projection fields; it does not parse or infer a schema. */
export function runningHubAppFromRead(reader: AifisherWorkflowReadResult): RunningHubAiApp {
  const snapshot = reader.projection?.snapshot as { appName: string; fields: Record<string, unknown>[] } | undefined;
  if (reader.environment !== "runninghub-webapp" || !snapshot || !reader.workflow) throw new Error("AIFISHER 未返回完整 AI 应用读取结果。");
  const rawInfo = reader.runninghubSource?.rawInfo;
  const rawFields = Array.isArray(rawInfo?.nodeInfoList) ? rawInfo.nodeInfoList.filter(record) : [];
  const nodeInfoList = snapshot.fields.map((field): RunningHubAppField => {
    const raw = rawFields.find(item => String(item.nodeId) === String(field.nodeId) && String(item.fieldName) === String(field.fieldName));
    const value = field.value;
    if (!(value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value))) throw new Error("AIFISHER 返回的公开字段不是可提交的标量。");
    const secret = reader.credentialTargets?.some(item => item.nodeId === field.nodeId && item.fieldName === field.fieldName) === true;
    const input = record(field.mediaInput) ? field.mediaInput : undefined;
    return {
      ...(raw ?? {}), nodeId: String(field.nodeId), fieldName: String(field.fieldName),
      fieldValue: secret ? "" : value, fieldType: String(field.fieldType), description: String(field.description ?? ""),
      required: field.required === true, ...(secret ? { secret: true } : {}),
      ...(input && Object.hasOwn(input, "emptyValue") ? { mediaEmptyValue: input.emptyValue as string | null } : {}),
    };
  });
  return { nodeInfoList, name: snapshot.appName, apiVersion: reader.runninghubSource?.apiProtocol === "ai-app-v2" ? "v2" : "v1",
    rawInfo, reader: reader as unknown as RunningHubReaderResult };
}

const emptyMediaValue = (value: unknown): value is string | null => value === null || typeof value === "string" && (value === "" || /^(?:none|null)$/i.test(value));
/** Source mediaInput contract is already resolved by the original projection. */
export function runningHubAppMediaEmptyValue(field: RunningHubAppField): { emptyValue?: string | null } {
  return Object.hasOwn(field, "mediaEmptyValue") ? { emptyValue: field.mediaEmptyValue! } : {};
}

/** Validate all upload contracts before creating a remote task or uploading any file. */
export function validateRunningHubMediaInputs(workflow: WorkflowDefinition, graph: ApiWorkflow): void {
  if (workflow.runninghub?.kind !== "app") return;
  for (const field of workflow.runninghub.mediaInputs ?? []) {
    const value = graph[field.nodeId]?.inputs[field.field];
    if (!emptyMediaValue(value) && typeof value === "string" && value.trim()) continue;
    if (field.required) throw new Error(`请连接必需素材：${field.nodeId}.${field.field}。`);
    if (!Object.hasOwn(field, "emptyValue")) throw new Error(`可选素材 ${field.nodeId}.${field.field} 未公开空值规则，请连接素材或重新读取应用后运行。`);
    if (!Object.is(value, field.emptyValue)) throw new Error(`可选素材 ${field.nodeId}.${field.field} 的空值与平台声明不一致，请重新读取应用。`);
  }
}

/** Only a definite HTTP missing-resource response permits a different read-only identifier probe. */
export function isRunningHubReferenceNotFound(error: unknown): boolean {
  return error instanceof Error && "status" in error && [404, 410].includes(Number(error.status));
}
/** Linked/structured inputs travel in workflow; nodeInfoList carries editable scalar overrides. */
export function runningHubNodeInfoList(prompt: ApiWorkflow, definition: WorkflowDefinition): RunningHubNodeInfo[] {
  const required = new Set(definition.mapping.map(item => JSON.stringify([item.nodeId, item.field])));
  const selected = definition.runninghub?.bindingMode === "selected" && definition.runninghub.kind !== "app";
  const remoteMedia = definition.runninghub?.billingMode === "consumer" && selected
    ? new Set(definition.mapping.filter(mapping => definition.inputSlots?.some(slot => slot.semantic === mapping.semantic))
      .map(mapping => JSON.stringify([mapping.nodeId, mapping.field]))) : undefined;
  if (selected) for (const field of detectWorkflowCredentials(definition)) required.add(JSON.stringify([field.nodeId, field.field]));
  const list: RunningHubNodeInfo[] = [];
  for (const [nodeId, node] of Object.entries(prompt)) for (const [fieldName, value] of Object.entries(node.inputs)) {
    if (!["string", "number", "boolean"].includes(typeof value)) continue;
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("RunningHub 参数不是有限数值：" + nodeId + "." + fieldName);
    const original = definition.template?.[nodeId]?.inputs[fieldName];
    // An unconnected slot leaves the platform's own template default intact.
    // Do not submit an authored sample filename as if the user uploaded it.
    if (remoteMedia?.has(JSON.stringify([nodeId, fieldName])) && Object.is(original, value)) continue;
    if (required.has(JSON.stringify([nodeId, fieldName])) || !selected && original !== value)
      list.push({ nodeId, fieldName, fieldValue: value as string | number | boolean });
  }
  return list;
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const page = typeof document === "undefined" ? undefined : document;
    const browser = typeof window === "undefined" ? undefined : window;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      page?.removeEventListener?.("visibilitychange", visible);
      browser?.removeEventListener?.("focus", wake);
      browser?.removeEventListener?.("online", wake);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new DOMException("Aborted", "AbortError"));
    const wake = () => finish();
    const visible = () => { if (page?.visibilityState === "visible") wake(); };
    const timer = setTimeout(wake, ms);
    // Background-tab timers may be delayed by the browser. Recheck the same
    // accepted task immediately when the user returns or the network recovers.
    page?.addEventListener?.("visibilitychange", visible);
    browser?.addEventListener?.("focus", wake);
    browser?.addEventListener?.("online", wake);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function resultUrl(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new Error("RunningHub 返回的结果下载地址无效。"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("RunningHub 结果下载地址需使用 HTTP 或 HTTPS，且不能包含账号密码。");
  return url.toString();
}

function outputFilename(url: string, item: Record<string, unknown>, index: number) {
  const raw = new URL(url).pathname.split("/").at(-1);
  let name = "";
  try { name = decodeURIComponent(raw || ""); } catch { /* Use the fallback below. */ }
  const type = typeof item.fileType === "string" ? item.fileType : typeof item.outputType === "string" ? item.outputType : "";
  const extension = type.replace(/^.*\//, "").replace(/^\./, "").toLowerCase();
  if (!name) name = "result-" + (index + 1) + (/^[a-z0-9]{1,10}$/.test(extension) ? "." + extension : ".bin");
  return fileName(name);
}

function outputDimension(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value.trim()))) return;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function outputStorageType(item: Record<string, unknown>, url: string): RemoteFile["type"] {
  // A returned input URL is not a generated result, even when a provider puts
  // it in the results array. Preserve this evidence for output validation.
  const types = [item.type, new URL(url).searchParams.get("type")];
  return types.includes("input") ? "input" : types.includes("temp") ? "temp" : "output";
}

export class RunningHubClient extends ComfyUIClient {
  private readonly definition?: WorkflowDefinition;
  private readonly base: string;
  private readonly selectedInstanceType?: RunningHubInstanceType;
  private initialStatus = new Map<string, string>();

  constructor(connection: Connection, clientId?: string, workflow?: WorkflowDefinition, instanceType?: RunningHubInstanceType) {
    const base = normalizeRunningHubBaseUrl(connection.baseUrl);
    super({ ...connection, baseUrl: base, authHeader: "Authorization", authPrefix: "Bearer " }, clientId);
    this.base = base;
    this.definition = workflow;
    // Keep a corrupt saved selection inert for read-only recovery. Submission
    // validates it inside queuePrompt, where the pipeline handles rejection.
    this.selectedInstanceType = instanceType;
  }

  override url(path: string) { return this.base + "/" + path.replace(/^\//, ""); }
  override headers(): Record<string, string> { return this.connection.token ? { Authorization: "Bearer " + this.connection.token } : {}; }

  private redact(value: string) {
    let safe = value;
    for (const secret of [this.connection.token, encodeURIComponent(this.connection.token)]) if (secret) safe = safe.split(secret).join("[已隐藏]");
    return safe.replace(/("?(?:apiKey|apikey|authorization|token)"?\s*[:=]\s*)"?[^\s,}"\n]+"?/gi, "$1[已隐藏]").replace(/Bearer\s+[^\s,}"\n]+/gi, "Bearer [已隐藏]");
  }

  override async request(path: string, init: RequestInit = {}, timeout: number | null = 30000): Promise<Response> {
    if (!this.connection.token.trim()) throw new Error("请先在算力设置中填写 RunningHub API Key。");
    const fetcher = isTauri() ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
    const unlimited = this.definition?.runninghub?.billingMode === "consumer" && this.definition.runninghub.kind !== "app";
    const signal = unlimited || timeout === null ? init.signal : init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    const started = Date.now(), method = init.method ?? "GET", trace = logHttp(this.base, path, method, "request");
    try {
      const target = browserApi(path, this.base);
      const response = await fetcher(target.url, { ...init, headers: { ...this.headers(), ...init.headers, ...target.headers }, signal, redirect: "error" });
      logHttp(this.base, path, method, "response", { requestId: trace, status: response.status, durationMs: Date.now() - started });
      if (!response.ok) {
        const body = this.redact((await response.text()).slice(0, 12000));
        throw new ApiError("RunningHub 返回 HTTP " + response.status + "：" + body.slice(0, 2000), response.status, body);
      }
      return response;
    } catch (error) {
      logHttp(this.base, path, method, "error", { requestId: trace, durationMs: Date.now() - started, errorKind: error instanceof Error ? error.name : "Error" });
      if (error instanceof ApiError || error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) throw error;
      // Status 0 means no HTTP rejection was confirmed. In particular, a lost
      // submission response must stay recoverable and must not become a retry.
      throw new ApiError(requestFailureMessage(path), 0, this.redact(error instanceof Error ? error.message : String(error)));
    }
  }

  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal, includeApiKey = true): Promise<Record<string, unknown>> {
    const response = await this.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(includeApiKey ? { apiKey: this.connection.token, ...body } : body), signal });
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error("RunningHub 返回了无法解析的响应，原任务可能仍在运行，请查询原任务，不要重复提交。"); }
    if (!record(value)) throw new Error("RunningHub 返回的响应格式无效，请查询原任务，不要重复提交。");
    return value;
  }

  private success(result: Record<string, unknown>, operation: string) {
    if (result.code !== 0 && result.code !== "0") {
      const code = result.code === undefined ? "未知" : String(result.code);
      const reason = typeof result.msg === "string" && result.msg ? result.msg : typeof result.message === "string" ? result.message : "请求失败";
      throw new ExecutionError(readableRunningHubError("RunningHub " + operation + "失败（" + code + "）：" + this.redact(reason)), "failed", this.redact(JSON.stringify(result)));
    }
    return result;
  }

  async validateKey(signal?: AbortSignal): Promise<RunningHubAccountStatus> {
    const response = await this.request("/uc/openapi/accountStatus", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apikey: this.connection.token }), signal });
    let result: unknown;
    try { result = await response.json(); } catch { throw new Error("RunningHub 账户响应不是有效 JSON。"); }
    if (!record(result)) throw new Error("RunningHub 账户响应格式无效。");
    this.success(result, "验证 API Key");
    const data = record(result.data) ? result.data : {};
    const status: RunningHubAccountStatus = { valid: true, ...(typeof data.currency === "string" ? { currency: data.currency } : {}), ...(typeof data.apiType === "string" ? { apiType: data.apiType } : {}) };
    for (const field of ["remainCoins", "remainMoney", "currentTaskCounts"] as const) {
      const decimal = accountDecimal(data[field]);
      if (decimal !== undefined) status[field] = decimal;
    }
    return status;
  }

  async getWorkflow(id: string, signal?: AbortSignal): Promise<ApiWorkflow> {
    const reader = await readAifisherWorkflow({ environment: "runninghub-workflow", remote: {
      baseUrl: this.base, remoteId: workflowId(id), apiKey: this.connection.token,
    } }, signal);
    if (!reader.workflow) throw new Error("AIFISHER 未返回可执行的 RunningHub 工作流。");
    return reader.workflow;
  }

  /** Read only the public published card. Account credentials are never sent. */
  async getWorkflowMetadata(id: string, kind: "workflow" | "app" = "workflow", signal?: AbortSignal): Promise<RunningHubWorkflowMetadata> {
    const expectedId = workflowId(id), path = kind === "app" ? "/api/webapp/detail" : "/api/workflow/getDetail";
    const target = browserApi(path, this.base);
    const fetcher = isTauri() ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
    const response = await fetcher(target.url, {
      method: "POST", headers: { "Content-Type": "application/json", ...target.headers },
      body: JSON.stringify(kind === "app" ? { webappId: expectedId } : { workflowId: expectedId }),
      signal, redirect: "error", credentials: "omit",
    });
    if (!response.ok) throw new ApiError("RunningHub 暂时无法读取工作流名称和封面。", response.status, "");
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error("RunningHub 工作流详情超过大小限制。");
    let result: unknown;
    try { result = JSON.parse(text); } catch { throw new Error("RunningHub 工作流详情不是有效 JSON。"); }
    if (!record(result)) throw new Error("RunningHub 工作流详情格式无效。");
    this.success(result, "读取名称和封面");
    return parseRunningHubWorkflowMetadata(result, expectedId);
  }

  async getAiApp(id: string, signal?: AbortSignal, _readPresentation = false): Promise<RunningHubAiApp> {
    const reader = await readAifisherWorkflow({ environment: "runninghub-webapp", remote: {
      baseUrl: this.base, remoteId: workflowId(id), apiKey: this.connection.token,
    } }, signal);
    return runningHubAppFromRead(reader);
  }

  override async connect(): Promise<void> {
    const workflow = this.definition;
    if (!workflow?.runninghub) return;
    try {
      await validateRunningHubExecutionGraph(workflow);
      if (workflow.runninghub.kind === "app" && workflow.runninghub.executionContract?.publicSchema) {
        const current = await this.getAiApp(workflow.runninghub.workflowId);
        await validateRunningHubPublicSchema(workflow, current);
      } else if (workflow.runninghub.kind !== "app" && workflow.runninghub.bindingMode === "selected" && workflow.runninghub.includeWorkflowJson !== true) {
        const current = await this.getWorkflow(workflow.runninghub.workflowId);
        await validateRunningHubRemoteWorkflow(workflow, current);
      }
    } catch (reason) {
      throw new ExecutionError("RunningHub 运行前检查失败，尚未提交任务：" + this.redact(reason instanceof Error ? reason.message : "应用公开字段无法确认。"), "failed");
    }
  }
  override disconnect(): void { /* Pending requests are controlled by their task AbortSignal. */ }

  override async uploadAsset(blob: Blob, name: string, _subfolder: string, signal?: AbortSignal): Promise<UploadedInput> {
    fileName(name);
    if (!blob.size) throw new Error("不能上传空的 RunningHub 素材。");
    const form = new FormData();
    form.append("file", blob, name);
    const response = await this.request("/openapi/v2/media/upload/binary", { method: "POST", body: form, signal }, null);
    let result: unknown;
    try { result = await response.json(); } catch { throw new Error("RunningHub 上传响应不是有效 JSON。"); }
    if (!record(result)) throw new Error("RunningHub 上传响应无效。");
    this.success(result, "上传素材");
    const data = record(result.data) ? result.data : {};
    const inputName = relativePath(data.fileName);
    const parts = inputName.split("/"), uploadedName = fileName(parts.pop());
    return { name: uploadedName, subfolder: parts.join("/"), type: "input", inputName };
  }

  override async queuePrompt(prompt: ApiWorkflow, requestId: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    let instanceType: RunningHubInstanceType;
    try { instanceType = normalizeRunningHubInstanceType(this.selectedInstanceType); }
    catch { throw new ExecutionError("RunningHub 运行模式无效，尚未提交任务，请重新选择运行模式。", "failed"); }
    const definition = this.definition;
    if (!definition?.runninghub) throw new ExecutionError("请选择并添加 RunningHub 工作流后再生成。");
    if (normalizeRunningHubBaseUrl(definition.runninghub.baseUrl) !== this.base) throw new ExecutionError("此 RunningHub 工作流属于另一个站点，请切换到对应的算力配置。");
    try {
      if (definition.runninghub.kind !== "app" && definition.runninghub.apiVersion === "v2") throw new Error("暂不支持 RunningHub V2 工作流接口，不会自动改用 V1 提交。");
      await validateRunningHubExecutionGraph(definition, prompt);
      validateRunningHubMediaInputs(definition, prompt);
    } catch (reason) {
      throw new ExecutionError("RunningHub 执行契约检查失败，尚未提交任务：" + this.redact(reason instanceof Error ? reason.message : "工作流绑定已变化。"), "failed");
    }
    const id = workflowId(definition.runninghub.workflowId);
    if (!Object.keys(prompt).length) throw new ExecutionError("RunningHub 执行工作流为空。");
    const app = definition.runninghub.kind === "app", v2 = app && definition.runninghub.apiVersion === "v2";
    const nodeInfoList = app ? Object.entries(definition.template ?? {}).flatMap(([nodeId, node]) => {
      if (nodeId === "__rh_app_output" || nodeId === "fisherai_webapp_output") return [];
      return Object.keys(node.inputs).map(fieldName => {
        const fieldValue = prompt[nodeId]?.inputs[fieldName];
        const nullableMedia = fieldValue === null && definition.runninghub!.mediaInputs?.some(field => field.nodeId === nodeId && field.field === fieldName && Object.hasOwn(field, "emptyValue") && field.emptyValue === null);
        if (!nullableMedia && !["string", "number", "boolean"].includes(typeof fieldValue) || typeof fieldValue === "number" && !Number.isFinite(fieldValue)) throw new ExecutionError("RunningHub 应用参数无效：" + nodeId + "." + fieldName);
        return { nodeId, fieldName, fieldValue };
      });
    }) : runningHubNodeInfoList(prompt, definition);
    if (!app && definition.runninghub.billingMode === "consumer") {
      let account: RunningHubAccountStatus;
      try { account = await this.validateKey(signal); }
      catch (reason) {
        signal?.throwIfAborted();
        throw new ExecutionError("RunningHub RH 币 / 钱包账户校验未完成，尚未提交任务：" + this.redact(reason instanceof Error ? reason.message : "账户不可用。"), "failed");
      }
      if (account.apiType !== "NORMAL")
        throw new ExecutionError("当前 RunningHub API Key 不是 NORMAL（RH 币及钱包）账户，尚未提交任务。请使用消费级会员 Key。", "failed");
    }
    signal?.throwIfAborted();
    const result = v2
      ? await this.post("/openapi/v2/run/ai-app/" + id, { nodeInfoList, instanceType }, signal, false)
      : app ? await this.post("/task/openapi/ai-app/run", { webappId: id, nodeInfoList, instanceType }, signal)
      : await this.post("/task/openapi/create", { workflowId: id, nodeInfoList,
        ...(definition.runninghub.bindingMode !== "selected" || definition.runninghub.includeWorkflowJson === true ? { workflow: JSON.stringify(prompt) } : {}), instanceType }, signal);
    // An accepted task ID is the sole safe recovery handle, even if later metadata is malformed.
    const data = v2 ? result : record(result.data) ? result.data : {};
    const taskId = identifier(data.taskId);
    if (taskId) {
      submittedTasks.set(JSON.stringify([this.base, this.clientId, requestId]), taskId);
      while (submittedTasks.size > 500) submittedTasks.delete(submittedTasks.keys().next().value!);
      this.initialStatus.set(taskId, String(data.taskStatus || data.status || "QUEUED").toUpperCase());
    }
    if (Number(result.code) === 804) {
      if (taskId) return taskId;
      throw new Error("RunningHub 提示任务已在运行，无法确认原任务 ID；请在 RunningHub 任务记录中查询，不会自动重新提交。");
    }
    if (v2) this.v2Success(result, "提交 AI 应用");
    else this.success(result, app ? "提交 AI 应用" : "提交工作流");
    if (!taskId) throw new Error("RunningHub 提交响应缺少 taskId，无法确认是否已入队；请在 RunningHub 任务记录中查询，不会自动重新提交。");
    return taskId;
  }

  override async findSubmittedPrompt(requestId: string): Promise<string | null> {
    // RH has no documented lookup by our requestId/clientId. Never create another paid task to recover.
    return submittedTasks.get(JSON.stringify([this.base, this.clientId, requestId])) ?? null;
  }

  private executionFailure(result: Record<string, unknown>, graph?: ApiWorkflow): ExecutionError {
    const data = record(result.data) ? result.data : {};
    let detail: unknown = data.failedReason ?? result.failedReason ?? data.error ?? result;
    if (typeof detail === "string") { try { detail = JSON.parse(detail); } catch { /* Preserve plain backend messages. */ } }
    const issue = record(detail) ? detail : {};
    const nodeId = identifier(issue.node_id ?? issue.nodeId ?? data.nodeId);
    const node = nodeId ? graph?.[nodeId] : undefined;
    const reason = typeof detail === "string" ? detail : identifier(issue.exception_message ?? issue.errorMessage ?? issue.message ?? data.errorMessage ?? result.errorMessage ?? result.msg) ?? "工作流执行失败";
    const cancelled = /CANCELLED|CANCELED/.test(String(data.status ?? data.taskStatus ?? result.status));
    return new ExecutionError(readableRunningHubError("RunningHub：" + this.redact(reason)), cancelled ? "cancelled" : "failed", this.redact(JSON.stringify(detail, null, 2)), nodeId ? { nodeId, nodeType: node?.class_type, nodeTitle: node?._meta?.title || node?.class_type } : undefined);
  }

  private v2Success(result: Record<string, unknown>, operation: string) {
    const code = result.errorCode ?? result.code;
    if (code !== undefined && code !== null && code !== "" && String(code) !== "0" || failed.has(String(result.status ?? "").toUpperCase())) {
      const reason = identifier(result.errorMessage ?? result.message ?? result.msg) ?? "请求失败";
      throw new ExecutionError(readableRunningHubError("RunningHub " + operation + "失败" + (String(code) === "605" ? "（605）" : "") + "：" + this.redact(reason)), "failed", this.redact(JSON.stringify(result)));
    }
  }

  private history(outputs: unknown[], usage?: unknown): History {
    const history: History = { outputs: Object.create(null) as History["outputs"], status: { completed: true, status_str: "success" } };
    // Official RH client renders taskCostTime with an "s" suffix; outputs can repeat this task-level value.
    let duration: number | undefined;
    for (const item of [...outputs, usage]) {
      if (!record(item)) continue;
      const raw = item.taskCostTime;
      if (typeof raw !== "number" && (typeof raw !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()))) continue;
      const value = Number(raw);
      if (Number.isFinite(value) && value >= 0) duration = Math.max(duration ?? 0, value);
    }
    if (duration !== undefined) history.runningHubTiming = { providerDurationSeconds: duration };
    const declared = this.definition ? [this.definition.output, ...(this.definition.additionalOutputs ?? [])] : [];
    const descriptors = [...new Map(declared.map(item => [JSON.stringify([item.nodeId, item.field, item.kind]), item])).values()];
    const outputNodes = [...new Set(descriptors.map(item => item.nodeId))];
    // AI-app APIs expose one virtual result contract; V2's documented results
    // can omit nodeId entirely. Only that virtual contract may aggregate rows
    // from several underlying publishers. Real workflow output IDs stay intact.
    const appOutput = this.definition?.runninghub?.kind === "app"
      ? descriptors.find(item => item.nodeId === "fisherai_webapp_output" || item.nodeId === "__rh_app_output")
      : undefined;
    outputs.forEach((value, index) => {
      if (!record(value)) throw new Error("RunningHub 返回的结果条目无效。");
      const sourceNodeId = identifier(value.nodeId ?? value.node_id);
      const sourceField = identifier(value.fieldName ?? value.field_name ?? value.outputField ?? value.output_field ?? value.field);
      const nodeId = sourceNodeId && outputNodes.includes(sourceNodeId) ? sourceNodeId
        : appOutput?.nodeId ?? sourceNodeId ?? (outputNodes.length === 1 ? outputNodes[0] : undefined);
      if (!nodeId) throw new Error("RunningHub 结果缺少输出节点 ID，无法确定对应的画布结果。");
      const nodeDescriptors = descriptors.filter(item => item.nodeId === nodeId);
      const descriptor = appOutput?.nodeId === nodeId ? appOutput
        : sourceField ? nodeDescriptors.find(item => item.field === sourceField || item.field === "*")
        : nodeDescriptors.length === 1 ? nodeDescriptors[0] : undefined;
      const target = history.outputs[nodeId] ??= Object.create(null) as Record<string, unknown>;
      const text = typeof value.text === "string" ? value.text : typeof value.content === "string" ? value.content : undefined;
      const rawUrl = value.fileUrl ?? value.url ?? value.downloadUrl;
      if (text?.trim()) {
        const field = descriptor?.kind === "text" && descriptor.field !== "*" ? descriptor.field : "text";
        (target[field] as string[] | undefined ?? (target[field] = []) as string[]).push(text);
      }
      if (typeof rawUrl === "string" && rawUrl) {
        // A text output may include both its body and a TXT download. Keep its mapped field textual.
        if (text?.trim() && descriptor?.kind === "text" && descriptor.field !== "*") return;
        const url = resultUrl(rawUrl), width = outputDimension(value.width), height = outputDimension(value.height);
        const file: RemoteFile = { filename: outputFilename(url, value, index), subfolder: "", type: outputStorageType(value, url), url,
          ...(sourceNodeId ? { sourceNodeId } : {}), ...(sourceField ? { sourceField } : {}),
          ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
        const field = descriptor && descriptor.field !== "*" ? descriptor.field
          : sourceField ?? "files";
        (target[field] as RemoteFile[] | undefined ?? (target[field] = []) as RemoteFile[]).push(file);
      } else if (!text?.trim()) throw new Error("RunningHub 输出节点 " + nodeId + " 未返回文件地址或文本正文。");
    });
    if (!outputs.length) throw new Error("RunningHub 任务已结束，但没有返回任何生成结果。");
    return history;
  }

  /** Read timing for one accepted task without polling, downloading or submitting work. */
  async readTaskTiming(id: string, signal?: AbortSignal): Promise<History["runningHubTiming"]> {
    const taskId = identifier(id);
    if (!taskId) throw new Error("RunningHub 任务缺少 taskId。");
    const v2 = this.definition?.runninghub?.kind === "app" && this.definition.runninghub.apiVersion === "v2";
    const result = await this.post(v2 ? "/openapi/v2/query" : "/task/openapi/outputs", { taskId }, signal, !v2);
    if (v2) {
      const state = String(result.status ?? "").toUpperCase();
      if (failed.has(state)) throw this.executionFailure({ ...result, data: { status: state, errorMessage: result.errorMessage } });
      this.v2Success(result, "查询结果");
      if (!["SUCCESS", "COMPLETED"].includes(state)) return;
      if (!Array.isArray(result.results)) throw new Error("RunningHub 任务已结束，但没有返回有效结果。");
      return this.history(result.results, result.usage).runningHubTiming;
    }
    const code = Number(result.code), data = record(result.data) ? result.data : {};
    const state = String(data.taskStatus ?? data.status ?? result.taskStatus ?? result.status ?? "").toUpperCase();
    if (code === 805 || failed.has(state) || data.failedReason || result.failedReason) throw this.executionFailure(result);
    if (code === 804 || code === 813 || pending.has(state)) return;
    this.success(result, "查询结果");
    const outputs = Array.isArray(result.data) ? result.data : Array.isArray(data.outputs) ? data.outputs : Array.isArray(data.results) ? data.results : undefined;
    return outputs ? this.history(outputs, result.usage ?? data.usage).runningHubTiming : undefined;
  }

  override async waitForCompletion(id: string, onState: (state: Partial<TaskState>) => void, signal: AbortSignal, workflow?: ApiWorkflow): Promise<History> {
    const unlimited = this.definition?.runninghub?.billingMode === "consumer" && this.definition.runninghub.kind !== "app";
    const deadline = unlimited ? Infinity : Date.now() + this.connection.timeoutMinutes * 60000;
    let misses = 0, waitingForOutputs = false;
    const awaitPublishedOutputs = () => {
      const immediateRefresh = !waitingForOutputs;
      waitingForOutputs = true;
      onState({ status: "saving", progress: undefined,
        details: "RunningHub 已报告任务完成，正在等待结果地址；原任务可恢复查询。" });
      // Completion can precede publication of output URLs. Keep observing the
      // original paid task until results arrive or the caller stops polling.
      return immediateRefresh;
    };
    onState({ status: this.initialStatus.get(id) === "RUNNING" ? "generating" : "queued", progress: undefined });
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      let result: Record<string, unknown>;
      const v2 = this.definition?.runninghub?.kind === "app" && this.definition.runninghub.apiVersion === "v2";
      try { result = await this.post(v2 ? "/openapi/v2/query" : "/task/openapi/outputs", { taskId: id }, signal, !v2); misses = 0; }
      catch (error) {
        signal.throwIfAborted();
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 || ++misses >= 5) throw error;
        await pause(2000, signal); continue;
      }
      signal.throwIfAborted();
      if (v2) {
        const status = String(result.status ?? "").toUpperCase();
        if (failed.has(status)) throw this.executionFailure({ ...result, data: { status, errorMessage: result.errorMessage } }, workflow);
        this.v2Success(result, "查询结果");
        if (["SUCCESS", "COMPLETED"].includes(status)) {
          if (Array.isArray(result.results) && result.results.length) return this.history(result.results, result.usage);
          if (awaitPublishedOutputs()) continue;
          await pause(3000, signal);
          continue;
        }
        if (!pending.has(status)) throw new Error("RunningHub 返回未知任务状态，可恢复查询原任务；不会自动重新提交。");
        waitingForOutputs = false;
        onState({ status: status === "QUEUED" || status === "PENDING" ? "queued" : "generating", progress: undefined });
        await pause(3000, signal);
        continue;
      }
      const code = Number(result.code), data = record(result.data) ? result.data : {};
      const state = String(data.taskStatus ?? data.status ?? result.taskStatus ?? result.status ?? "").toUpperCase();
      if (code === 805 || failed.has(state) || data.failedReason || result.failedReason) throw this.executionFailure(result, workflow);
      if (code === 804 || code === 813 || pending.has(state)) {
        waitingForOutputs = false;
        onState({ status: code === 813 || state === "QUEUED" || state === "PENDING" ? "queued" : "generating", progress: undefined });
      } else {
        this.success(result, "查询结果");
        const outputs = Array.isArray(result.data) ? result.data : Array.isArray(data.outputs) ? data.outputs : Array.isArray(data.results) ? data.results : undefined;
        if (outputs?.length) return this.history(outputs, result.usage ?? data.usage);
        // Legacy status endpoint remains useful when outputs did not include taskStatus.
        let statusValue = state;
        if (!["SUCCESS", "COMPLETED"].includes(state)) {
          const status = this.success(await this.post("/task/openapi/status", { taskId: id }, signal), "查询状态");
          const statusData = record(status.data) ? status.data : {};
          statusValue = String(typeof status.data === "string" ? status.data : statusData.taskStatus ?? statusData.status ?? "").toUpperCase();
          if (failed.has(statusValue)) throw this.executionFailure({ ...status, data: { ...statusData, status: statusValue } }, workflow);
        }
        const terminal = ["SUCCESS", "COMPLETED"].includes(statusValue);
        if (terminal) {
          if (awaitPublishedOutputs()) continue;
        } else if (pending.has(statusValue)) {
          waitingForOutputs = false;
          onState({ status: statusValue === "RUNNING" || statusValue === "PROCESSING" ? "generating" : "queued", progress: undefined });
        } else throw new Error("RunningHub 结果和状态接口返回未知任务状态。原任务 ID 已保留，可恢复查询；不会重新提交。");
      }
      await pause(3000, signal);
    }
    throw new Error("等待 RunningHub 结果超时。任务可能仍在运行，可恢复查询原任务；不会自动重新提交。");
  }

  override async getOutput(file: RemoteFile, signal?: AbortSignal,
    context?: { promptId: string; onlyOutput: boolean } | ((received: number, total?: number) => void)): Promise<Blob> {
    checkedOutput(file);
    const url = resultUrl(file.url);
    const fetcher = isTauri() ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
    // Output URLs are signed by storage providers. Never forward the API Key, cookies or auth headers.
    const localProxy = !isTauri() && typeof window !== "undefined";
    const target = localProxy ? new URL(import.meta.env.BASE_URL + "api/runninghub-result?url=" + encodeURIComponent(url), window.location.origin).toString() : url;
    const cancellation = signal ?? new AbortController().signal;
    const onProgress = typeof context === "function" ? context : undefined;
    let parts: Blob[] = [], received = 0, total: number | undefined, validator: string | undefined, mime = "";
    let lastProgress = -Infinity;
    const progress = (force = false) => {
      if (force || Date.now() - lastProgress >= 250) {
        lastProgress = Date.now();
        onProgress?.(received, total);
      }
    };
    const reset = () => { parts = []; received = 0; total = undefined; validator = undefined; };
    // Like AIFISHER's localizer, retry only this idempotent result GET. A CDN
    // object or DNS route can become readable just after RH reports completion.
    for (let attempt = 0; attempt < 3; attempt++) {
      cancellation.throwIfAborted();
      try {
        // Resume only when the storage server identifies the same original object.
        // If it ignores Range or If-Range, a full 200 response replaces the partial data.
        const offset = validator ? received : 0;
        const response = await fetcher(target, { method: "GET", credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow", signal: cancellation,
          ...(offset ? { headers: { Range: `bytes=${offset}-`, "If-Range": validator! } } : {}),
        });
        if (!response.ok) {
          let detail: string | undefined;
          if (localProxy) {
            try {
              const value: unknown = await response.json();
              if (record(value) && typeof value.error === "string" && downloadProxyErrors.get(value.error) === response.status) detail = value.error;
            } catch { /* Never expose arbitrary storage errors, signed URLs or response bodies. */ }
          }
          await response.body?.cancel().catch(() => {});
          throw new ApiError("RunningHub 结果下载失败（HTTP " + response.status + "）" + (detail ? "，本地下载代理：" + detail : "，") + "可恢复查询原任务。", response.status, detail);
        }
        const etag = response.headers.get("etag");
        const modified = response.headers.get("last-modified");
        const nextValidator = etag && /^"[^\r\n]*"$/.test(etag) ? etag
          : modified && Number.isFinite(Date.parse(modified)) ? modified : undefined;
        const encoded = response.headers.get("content-encoding");
        const byteLength = response.headers.get("content-length");
        const length = byteLength && /^\d+$/.test(byteLength) && Number.isSafeInteger(Number(byteLength)) ? Number(byteLength) : undefined;
        const identityEncoding = !encoded || encoded === "identity";
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
          if (!offset || !identityEncoding || !range || Number(range[1]) !== offset ||
            !Number.isSafeInteger(Number(range[3])) || Number(range[2]) < offset || Number(range[2]) >= Number(range[3]) ||
            (total !== undefined && total !== Number(range[3])) || (nextValidator && nextValidator !== validator)) {
            reset();
            await response.body?.cancel().catch(() => {});
            throw new ApiError("RunningHub 结果续传响应不一致，正在重新下载原结果。", 502);
          }
          total = Number(range[3]);
        } else {
          reset();
          total = identityEncoding ? length : undefined;
          validator = identityEncoding ? nextValidator : undefined;
          mime = response.headers.get("content-type") ?? "";
        }
        progress(true);
        if (!response.body) {
          const blob = await response.blob();
          cancellation.throwIfAborted();
          parts.push(blob); received += blob.size;
        } else {
          const reader = response.body.getReader();
          let chunks: Uint8Array<ArrayBuffer>[] = [], chunkBytes = 0;
          const flush = () => {
            if (chunkBytes) parts.push(new Blob(chunks));
            chunks = []; chunkBytes = 0;
          };
          const abortRead = () => { void reader.cancel().catch(() => {}); };
          cancellation.addEventListener("abort", abortRead, { once: true });
          try {
            cancellation.throwIfAborted();
            while (true) {
              const chunk = await reader.read();
              cancellation.throwIfAborted();
              if (chunk.done) break;
              chunks.push(chunk.value); chunkBytes += chunk.value.byteLength; received += chunk.value.byteLength;
              // Keep chunks in Blob storage without making one file-sized ArrayBuffer.
              if (chunkBytes >= 4 * 1024 * 1024) flush();
              progress();
            }
          } finally {
            flush();
            cancellation.removeEventListener("abort", abortRead);
            reader.releaseLock();
          }
        }
        if (total !== undefined && received !== total)
          throw new ApiError("RunningHub 结果文件接收不完整，可恢复查询原任务。", 502);
        progress(true);
        return new Blob(parts, { type: mime });
      } catch (reason) {
        cancellation.throwIfAborted();
        if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
        if (validator && total !== undefined && received === total && received > 0) {
          progress(true);
          return new Blob(parts, { type: mime });
        }
        if (!validator) reset();
        const error = reason instanceof ApiError ? reason : new ApiError("RunningHub 结果下载连接中断，可恢复查询原任务。", 502);
        if (attempt === 2 || ![408, 425, 429, 500, 502, 503, 504].includes(error.status)) throw error;
        await pause(400 * 2 ** attempt, cancellation);
      }
    }
    throw new Error("RunningHub 结果下载失败，可恢复查询原任务。");
  }

  override async cancel(id: string): Promise<void> {
    if (!identifier(id)) throw new Error("RunningHub 任务缺少 taskId。");
    this.success(await this.post("/task/openapi/cancel", { taskId: id }), "取消任务");
  }
}
