import { isTauri } from "@tauri-apps/api/core";
import type {
  Connection,
  ApiWorkflow,
  TaskState,
  WorkflowDefinition,
  RemoteFile,
  UploadedInput,
  MediaKind,
} from "../types";
import { relativePath, fileName, checkedOutput, outputKey } from "./files";
import { logHttp, logWebSocket } from "./diagnostics";
import { recoverNativeRunningHubOutput } from "../runninghub/native-results";
import { savedOutputContracts } from "../workflow/output-contracts";
import { getNativeRunningHubEndpoint, isRunningHubNativeConnection, NativeRunningHubAccountError, nativeRunningHubBrowserUrl, nativeRunningHubUpstreamUrl, normalizeRunningHubNativeConnection, redactNativeRunningHubText, requestNativeRunningHub, sanitizeNativeRunningHubValue, validateNativeRunningHubAccount } from "../runninghub/native-connection";
export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
    public body?: string,
  ) {
    super(message);
  }
}
export class ExecutionError extends Error {
  constructor(
    message: string,
    public status: "failed" | "cancelled" = "failed",
    public details?: string,
    public execution?: TaskState["execution"],
  ) {
    super(message);
  }
}
export type OutputFile = RemoteFile;
export type History = {
  outputs: Record<string, Record<string, unknown>>;
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
  runningHubTiming?: { providerDurationSeconds?: number };
};
type Event = {
  type: string;
  data: {
    prompt_id?: string;
    node?: string | null;
    value?: number;
    max?: number;
    exception_message?: string;
    [key: string]: unknown;
  };
};
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nodeIdentifier = (value: unknown) => typeof value === "string" && value ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
function executionNode(value: unknown, workflow?: ApiWorkflow, explicitType?: unknown, displayId?: unknown): NonNullable<TaskState["execution"]> {
  const nodeId = nodeIdentifier(value), display = nodeIdentifier(displayId);
  const definition = nodeId ? workflow?.[nodeId] ?? (display ? workflow?.[display] : undefined) : undefined;
  const nodeType = typeof explicitType === "string" ? explicitType : definition?.class_type;
  return { nodeId, nodeType, nodeTitle: definition?._meta?.title || nodeType };
}
function serverExecutionError(data: Record<string, unknown>, workflow?: ApiWorkflow, cancelled = false) {
  const message = typeof data.exception_message === "string" ? data.exception_message : cancelled ? "任务已被服务器中断。" : JSON.stringify(data);
  const type = typeof data.exception_type === "string" ? data.exception_type : "";
  return new ExecutionError(type ? type + ": " + message : message, cancelled ? "cancelled" : "failed", JSON.stringify(data, null, 2), executionNode(data.node_id ?? data.node, workflow, data.node_type, data.display_node_id));
}
const queueRemovalListeners = new Set<(endpoint: string, promptId: string) => void>();
const confirmedQueueRemovals = new Map<string, number>();
function queueRemovalKey(endpoint: string, promptId: string) { return endpoint + "\0" + promptId; }
function confirmQueueRemoval(endpoint: string, promptId: string) {
  const key = queueRemovalKey(endpoint, promptId);
  confirmedQueueRemovals.delete(key);
  confirmedQueueRemovals.set(key, Date.now());
  while (confirmedQueueRemovals.size > 250) confirmedQueueRemovals.delete(confirmedQueueRemovals.keys().next().value!);
  for (const listener of queueRemovalListeners) { try { listener(endpoint, promptId); } catch { /* Observers cannot undo confirmed server deletion. */ } }
}
export class ComfyUIClient {
  readonly clientId: string;
  private closeSocket?: () => void;
  private listeners = new Set<(e: Event) => void>();
  private events: Event[] = [];
  private wsAlive = false;
  private realtimeRequested = false;
  constructor(
    readonly connection: Connection,
    clientId: string = crypto.randomUUID(),
  ) {
    this.clientId = clientId;
    if (isRunningHubNativeConnection(connection)) this.connection = normalizeRunningHubNativeConnection(connection);
  }
  url(path: string) {
    let base: URL;
    try {
      base = new URL(this.connection.baseUrl);
    } catch {
      throw new Error("请在设置中填写有效的 ComfyUI 地址。");
    }
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error("服务地址需使用 HTTP 或 HTTPS；凭据请填入 Token。");
    return base.toString().replace(/\/$/, "") + "/" + path.replace(/^\//, "");
  }
  headers() {
    return this.connection.token
      ? {
          [this.connection.authHeader || "Authorization"]:
            this.connection.authPrefix + this.connection.token,
        }
      : {};
  }
  async request(path: string, init: RequestInit = {}, timeout: number | null = 30000) {
    if (isRunningHubNativeConnection(this.connection)) {
      if (path.split("?", 1)[0] === "/prompt" && (init.method ?? "GET").toUpperCase() === "POST") {
        await validateNativeRunningHubAccount(this.connection, init.signal ?? undefined);
        if (init.signal?.aborted) throw new NativeRunningHubAccountError("已取消 RunningHub 账户校验，未提交任务。", true);
      }
      const started = Date.now(), method = init.method ?? "GET";
      const trace = logHttp(this.connection.baseUrl, path, method, "request");
      let response: Response;
      try { response = await requestNativeRunningHub(this.connection, path, init); }
      catch (reason) {
        logHttp(this.connection.baseUrl, path, method, "error", { requestId: trace, durationMs: Date.now() - started, errorKind: reason instanceof Error ? reason.name : "Error" });
        throw reason;
      }
      logHttp(this.connection.baseUrl, path, method, "response", { requestId: trace, status: response.status, durationMs: Date.now() - started });
      if (!response.ok) {
        const body = await response.text();
        throw new ApiError("RunningHub 原生服务器返回 " + response.status + "：" + body.slice(0, 4000), response.status, body);
      }
      return response;
    }
    const url = this.url(path);
    const fetcher = isTauri()
      ? (await import("@tauri-apps/plugin-http")).fetch
      : fetch;
    const signal = timeout === null ? init.signal : init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout);
    const started = Date.now(), method = init.method ?? "GET";
    const trace = logHttp(this.connection.baseUrl, path, method, "request");
    let response: Response;
    try { response = await fetcher(url, {
      ...init,
      signal,
      redirect: "error",
      headers: { ...this.headers(), ...init.headers },
    }); } catch (reason) {
      logHttp(this.connection.baseUrl, path, method, "error", { requestId: trace, durationMs: Date.now() - started, errorKind: reason instanceof Error ? reason.name : "Error" });
      throw reason;
    }
    logHttp(this.connection.baseUrl, path, method, "response", { requestId: trace, status: response.status, durationMs: Date.now() - started });
    if (!response.ok) {
      const body = await response.text();
      throw new ApiError(
        "服务器返回 " +
          response.status +
          "：" +
          body.slice(0, 4000),
        response.status,
        body,
      );
    }
    return response;
  }
  async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.request(path, init)).json();
  }
  getSystemStats() {
    return this.json<{
      system?: { comfyui_version?: string };
      devices?: unknown[];
    }>("/system_stats");
  }
  getQueue(signal?: AbortSignal) {
    return this.json<{
      queue_running: unknown[][];
      queue_pending: unknown[][];
    }>("/queue", signal ? { signal } : undefined);
  }
  getHistory(id: string, signal?: AbortSignal) {
    return this.json<Record<string, History>>(
      "/history/" + encodeURIComponent(id),
      signal ? { signal } : undefined,
    );
  }
  getObjectInfo() {
    return this.json<Record<string, unknown>>("/object_info");
  }
  async uploadAsset(
    blob: Blob,
    name: string,
    subfolder: string,
    signal?: AbortSignal,
  ): Promise<UploadedInput> {
    fileName(name);
    relativePath(subfolder);
    const form = new FormData();
    form.append("image", blob, name);
    form.append("overwrite", "false");
    form.append("type", "input");
    form.append("subfolder", subfolder);
    const response = await this.request(
      "/upload/image",
      { method: "POST", body: form, signal },
      300000,
    );
    const value = (await response.json()) as {
      name?: unknown;
      subfolder?: unknown;
      type?: unknown;
    };
    const uploadedName = fileName(value.name);
    const native = isRunningHubNativeConnection(this.connection);
    const uploadedFolder = relativePath(value.subfolder, native);
    if ((!native && uploadedFolder !== subfolder) || value.type !== "input")
      throw new Error("服务器未将素材保存到本次任务的 input 目录。");
    return {
      name: uploadedName,
      subfolder: uploadedFolder,
      type: "input",
      inputName: (uploadedFolder ? uploadedFolder + "/" : "") + uploadedName,
    };
  }
  async queuePrompt(prompt: ApiWorkflow, requestId: string, signal?: AbortSignal) {
    let r: { prompt_id: string; node_errors?: unknown };
    try { r = await this.json<{ prompt_id: string; node_errors?: unknown }>(
      "/prompt",
      {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          prompt_id: requestId,
          client_id: this.clientId,
          extra_data: { infinite_canvas: { requestId } },
        }),
      },
    ); } catch (error) {
      if (error instanceof ApiError && error.body) {
        let data: unknown;
        try { data = JSON.parse(error.body); } catch { /* Retain a non-JSON HTTP error. */ }
        if (isRecord(data) && (isRecord(data.error) || isRecord(data.node_errors))) {
          const messages: string[] = [], root = isRecord(data.error) ? data.error : {};
          if (typeof root.message === "string") messages.push(root.message);
          if (typeof root.details === "string" && root.details) messages.push(root.details);
          let execution: TaskState["execution"];
          if (isRecord(data.node_errors)) for (const [nodeId, issue] of Object.entries(data.node_errors)) {
            if (!isRecord(issue)) continue;
            execution ??= executionNode(nodeId, prompt, issue.class_type);
            if (Array.isArray(issue.errors)) for (const item of issue.errors) {
              if (!isRecord(item)) continue;
              messages.push(["节点 " + nodeId, typeof issue.class_type === "string" ? issue.class_type : "", typeof item.message === "string" ? item.message : "", typeof item.details === "string" ? item.details : ""].filter(Boolean).join(" · "));
            }
          }
          throw new ExecutionError(messages.join("\n") || error.message, "failed", JSON.stringify(data, null, 2), execution);
        }
      }
      throw error;
    }
    if (typeof r?.prompt_id !== "string" || !r.prompt_id.trim())
      throw new Error(
        "提交响应缺少有效 prompt_id，无法确认是否入队；请恢复查询原任务。",
      );
    confirmedQueueRemovals.delete(queueRemovalKey(this.url("/queue"), r.prompt_id));
    return r.prompt_id;
  }
  /** Global workstation stop, deliberately separate from safe cancel(id). */
  async interruptCurrent() {
    const queue = await this.getQueue();
    if (!queue.queue_running.length) throw new Error("当前没有正在执行的任务。");
    await this.request("/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  }
  /** Standard deletion only touches a pending prompt and verifies the server state. */
  async deleteQueuedPrompt(id: string) {
    if (typeof id !== "string" || !id.trim()) throw new Error("排队任务缺少 promptId。");
    const queue = await this.getQueue();
    if (queue.queue_running.some(item => item[1] === id)) throw new Error("任务已经开始执行，不能作为排队任务删除。");
    if (!queue.queue_pending.some(item => item[1] === id)) throw new Error("该任务已不在排队列表中。");
    await this.request("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [id] }) });
    const after = await this.getQueue();
    if (after.queue_running.some(item => item[1] === id)) throw new Error("任务在删除期间开始执行，删除尚未确认。");
    if (after.queue_pending.some(item => item[1] === id)) throw new Error("服务器尚未删除该排队任务。");
    if ((await this.getHistory(id))[id]) throw new Error("任务已在删除期间执行结束，不能标记为已删除。");
    confirmQueueRemoval(this.url("/queue"), id);
  }
  async freeMemory(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const queue = await this.getQueue(signal);
    signal?.throwIfAborted();
    if (!queue || !Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error("工作站返回的执行队列格式无效，未发送清理请求。");
    if (queue.queue_running.length || queue.queue_pending.length) throw new Error("请等待执行队列清空后再清理内存和显存。");
    await this.request("/free", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal });
  }
  async findSubmittedPrompt(requestId: string, signal?: AbortSignal): Promise<string | null> {
    const direct = await this.getHistory(requestId, signal);
    if (direct[requestId]) return requestId;
    const q = await this.getQueue(signal);
    const item = [...q.queue_running, ...q.queue_pending].find(
      (x) =>
        x[1] === requestId ||
        (x[3] as { client_id?: string })?.client_id === this.clientId,
    );
    if (item) return String(item[1]);
    const recent = await this.json<
      Record<string, History & { prompt?: unknown[] }>
    >("/history?max_items=200", signal ? { signal } : undefined);
    return (
      Object.entries(recent).find(
        ([, h]) =>
          (h.prompt?.[3] as { client_id?: string })?.client_id ===
          this.clientId,
      )?.[0] ?? null
    );
  }
  async getOutput(file: OutputFile, signal?: AbortSignal, context?: { promptId: string; onlyOutput: boolean }) {
    file = checkedOutput(file);
    const q = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder ?? "",
      type: file.type ?? "output",
    });
    try { return await (await this.request("/view?" + q, { signal }, 300000)).blob(); }
    catch (reason) {
      if (!isRunningHubNativeConnection(this.connection)) throw reason;
      if (context && reason instanceof ApiError && [404, 502].includes(reason.status)) {
        signal?.throwIfAborted();
        const recovered = await recoverNativeRunningHubOutput(this.connection, file, context, signal);
        if (recovered) return recovered;
      }
      const message = redactNativeRunningHubText(reason instanceof Error ? reason.message : String(reason), this.connection);
      if (reason instanceof DOMException && reason.name === "AbortError") throw new DOMException(message, "AbortError");
      if (reason instanceof ApiError) throw reason;
      throw new Error(message);
    }
  }
  async cancel(id: string) {
    try {
      // Optional native ComfyUI route, not a Bridge API requirement.
      const result = await this.json<{ cancelled: boolean }>(
        "/api/jobs/" + encodeURIComponent(id) + "/cancel",
        { method: "POST" },
      );
      if (!result.cancelled)
        throw new Error("服务器未取消该任务，任务可能已结束；请恢复查询结果。");
      return;
    } catch (e) {
      if (!(e instanceof ApiError) || ![404, 405].includes(e.status)) throw e;
    }
    const queue = await this.getQueue();
    if (queue.queue_running.some((item) => item[1] === id))
      throw new Error(
        "服务器版本不支持安全的单任务取消。请在工作站停止该任务；本软件继续接收结果。",
      );
    if (!queue.queue_pending.some((item) => item[1] === id))
      throw new Error("原任务已不在队列中，请恢复查询结果。");
    await this.request("/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [id] }),
    });
    const after = await this.getQueue();
    if (after.queue_running.some((item) => item[1] === id))
      throw new Error("任务已经开始运行，服务器不支持安全的单任务取消。");
    if (after.queue_pending.some((item) => item[1] === id))
      throw new Error("服务器未移除该排队任务，请稍后重试取消。");
    const history = await this.getHistory(id);
    if (history[id])
      throw new Error("任务已在取消期间执行结束，请恢复查询结果。");
  }
  async connect(signal?: AbortSignal) {
    this.disconnect();
    this.realtimeRequested = true;
    if (isRunningHubNativeConnection(this.connection)) {
      signal?.throwIfAborted();
      if (!signal) return this.connectNativeRunningHub();
      let abort: (() => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => { this.disconnect(); reject(new DOMException("连接已取消", "AbortError")); };
        signal.addEventListener("abort", abort, { once: true });
      });
      try { await Promise.race([this.connectNativeRunningHub(), cancelled]); }
      finally { if (abort) signal.removeEventListener("abort", abort); }
      return;
    }
    const raw = this.url("/ws").replace(/^http/, "ws");
    const url = new URL(raw);
    if (!["ws:", "wss:"].includes(url.protocol))
      throw new Error("WebSocket 地址需使用 ws 或 wss。");
    const base = new URL(this.connection.baseUrl);
    if (this.connection.token && url.host !== base.host)
      throw new Error("带鉴权的 WebSocket 必须与服务地址使用相同主机和端口。");
    url.searchParams.set("clientId", this.clientId);
    const receive = (text: string) => {
      try {
        const e = JSON.parse(text) as Event;
        if (!e?.type || !e.data) return;
        logWebSocket(this.connection.baseUrl, "event", e);
        this.events.push(e);
        if (this.events.length > 500) this.events.shift();
        this.listeners.forEach((fn) => fn(e));
      } catch {
        /* Binary previews are not task completion events. */
      }
    };
    if (isTauri()) {
      const { default: Socket } = await import("@tauri-apps/plugin-websocket");
      logWebSocket(this.connection.baseUrl, "connect");
      const ws = await Socket.connect(url.toString(), {
        headers: this.headers(),
      }).catch(reason => { logWebSocket(this.connection.baseUrl, "error"); throw reason; });
      const unlisten = ws.addListener((e) => {
        if (e.type === "Text") receive(e.data);
        if (e.type === "Close") { this.wsAlive = false; logWebSocket(this.connection.baseUrl, "close"); }
      });
      this.closeSocket = () => {
        unlisten();
        void ws.disconnect();
      };
      this.wsAlive = true;
      logWebSocket(this.connection.baseUrl, "open");
    } else {
      // ComfyUI and the optimizer may share an address while only the optimizer
      // needs the configured token. Let the server decide whether this socket
      // is allowed; never put a secret in a WebSocket URL or subprotocol.
      const ws = new WebSocket(url);
      logWebSocket(this.connection.baseUrl, "connect");
      this.closeSocket = () => ws.close();
      ws.onmessage = (e) => {
        if (typeof e.data === "string") receive(e.data);
      };
      ws.onclose = () => {
        this.wsAlive = false;
        logWebSocket(this.connection.baseUrl, "close");
      };
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          ws.close();
          logWebSocket(this.connection.baseUrl, "error");
          reject(new Error("WebSocket 连接超时"));
        }, 8000);
        ws.onopen = () => {
          clearTimeout(t);
          this.wsAlive = true;
          logWebSocket(this.connection.baseUrl, "open");
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(t);
          logWebSocket(this.connection.baseUrl, "error");
          reject(new Error("WebSocket 连接失败"));
        };
      });
    }
  }
  private async connectNativeRunningHub() {
    const endpoint = getNativeRunningHubEndpoint(this.connection);
    const receive = (text: string) => {
      try {
        const e = sanitizeNativeRunningHubValue(JSON.parse(text) as Event, this.connection);
        if (!e?.type || !e.data) return;
        logWebSocket(this.connection.baseUrl, "event", e);
        this.events.push(e);
        if (this.events.length > 500) this.events.shift();
        this.listeners.forEach(fn => fn(e));
      } catch { /* Binary previews and invalid messages are not completion events. */ }
    };
    logWebSocket(this.connection.baseUrl, "connect");
    if (isTauri()) {
      const url = new URL(nativeRunningHubUpstreamUrl(endpoint, "/ws").replace(/^http/, "ws"));
      url.searchParams.set("clientId", this.clientId);
      let cancelled = false;
      const cancelPending = () => { cancelled = true; };
      this.closeSocket = cancelPending;
      try {
        const { default: Socket } = await import("@tauri-apps/plugin-websocket");
        if (cancelled) throw new DOMException("连接已取消", "AbortError");
        const ws = await Socket.connect(url.toString());
        if (cancelled) { await ws.disconnect(); throw new DOMException("连接已取消", "AbortError"); }
        const close = () => { unlisten(); void ws.disconnect().catch(() => { /* Native disconnect errors may contain its upstream URL. */ }); };
        const unlisten = ws.addListener(e => {
          if (this.closeSocket !== close) return;
          if (e.type === "Text") receive(e.data);
          if (e.type === "Close") { this.wsAlive = false; logWebSocket(this.connection.baseUrl, "close"); }
        });
        this.closeSocket = close;
        this.wsAlive = true;
        logWebSocket(this.connection.baseUrl, "open");
      } catch (reason) {
        if (this.closeSocket === cancelPending) this.closeSocket = undefined;
        logWebSocket(this.connection.baseUrl, "error");
        const message = redactNativeRunningHubText(reason instanceof Error ? reason.message : String(reason), this.connection);
        if (reason instanceof DOMException && reason.name === "AbortError") throw new DOMException(message, "AbortError");
        throw new Error("RunningHub 原生实时连接失败：" + message);
      }
      return;
    }
    const url = new URL(nativeRunningHubBrowserUrl("/ws"));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("clientId", this.clientId);
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      let settled = false, ready = false;
      const fail = (message: string) => {
        if (!settled) { settled = true; reject(new Error(redactNativeRunningHubText(message, this.connection))); }
        if (this.closeSocket === close) this.wsAlive = false;
      };
      const close = () => {
        fail("RunningHub 原生实时连接已取消。");
        ws.onopen = null; ws.onmessage = null; ws.onerror = null;
        ws.close();
      };
      this.closeSocket = close;
      ws.onopen = () => {
        try { ws.send(JSON.stringify({ type: "authenticate", endpoint: endpoint.baseUrl, token: endpoint.token })); }
        catch { fail("RunningHub 原生实时连接鉴权失败。"); ws.close(); }
      };
      ws.onmessage = event => {
        if (typeof event.data !== "string") return;
        let packet: unknown;
        try { packet = JSON.parse(event.data); } catch { return; }
        if (isRecord(packet) && packet.type === "rh_native_error") {
          fail(typeof packet.message === "string" ? packet.message : "RunningHub 原生实时连接失败。");
          ws.close(); return;
        }
        if (!ready) {
          if (isRecord(packet) && packet.type === "rh_native_ready") {
            ready = true; settled = true; this.wsAlive = true;
            logWebSocket(this.connection.baseUrl, "open"); resolve();
          }
          return;
        }
        receive(event.data);
      };
      ws.onerror = () => {
        logWebSocket(this.connection.baseUrl, "error");
        fail("RunningHub 原生实时连接失败。"); ws.close();
      };
      ws.onclose = () => {
        const current = this.closeSocket === close;
        fail("RunningHub 原生实时连接在就绪前已关闭。");
        if (current) this.closeSocket = undefined;
        ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
        logWebSocket(this.connection.baseUrl, "close");
      };
    });
  }
  disconnect() {
    this.realtimeRequested = false;
    this.closeSocket?.();
    this.closeSocket = undefined;
    this.wsAlive = false;
  }
  async waitForCompletion(
    id: string,
    onState: (state: Partial<TaskState>) => void,
    signal: AbortSignal,
    workflow?: ApiWorkflow,
  ): Promise<History> {
    const started = Date.now();
    const native = isRunningHubNativeConnection(this.connection);
    let failure: ExecutionError | undefined;
    let socketNotice = false;
    let observing = true, historyRefresh = false, wakePoll: (() => void) | undefined;
    let reconnecting: Promise<void> | undefined, reconnected = false;
    const reconnectAbort = new AbortController();
    const reconnectSignal = AbortSignal.any([signal, reconnectAbort.signal]);
    const lastState: { status: TaskState["status"] } = { status: "loading" };
    let execution: NonNullable<TaskState["execution"]> = {};
    const cached = new Set<string>(), completed = new Set<string>();
    const publish = (state: Partial<TaskState>) => {
      if (state.status) lastState.status = state.status;
      onState({ ...state, execution: { ...execution, cachedNodes: [...cached], completedNodes: [...completed] } });
    };
    const selectNode = (value: unknown, type?: unknown, displayId?: unknown) => {
      const next = executionNode(value, workflow, type, displayId);
      if (!next.nodeId) return;
      execution = { ...execution, ...next, ...(execution.nodeId !== next.nodeId ? { value: undefined, max: undefined } : {}) };
    };
    const progress = (value: unknown, max: unknown) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || typeof max !== "number" || !Number.isFinite(max) || max <= 0) return;
      execution = { ...execution, value, max };
      publish({ status: "generating", progress: Math.max(0, Math.min(100, Math.round(value / max * 100))) });
    };
    const nextPoll = (ms: number) => {
      if (historyRefresh) { historyRefresh = false; return Promise.resolve(); }
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (wakePoll === wake) wakePoll = undefined;
          if (error) reject(error); else resolve();
        };
        const wake = () => { historyRefresh = false; finish(); };
        const abort = () => finish(new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(() => finish(), ms);
        wakePoll = wake;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    };
    const reconnect = () => {
      if (!native || !observing || this.wsAlive || !this.realtimeRequested || reconnecting || reconnectSignal.aborted) return;
      reconnected = true;
      // A pending handshake must never block history/queue recovery, nor spawn
      // another handshake on the next poll. The observation owns its lifetime.
      const attempt = this.connect(reconnectSignal).then(() => {
        if (!observing || !this.wsAlive) return;
        socketNotice = false;
        publish({ details: undefined });
      }).catch(() => { /* Continue observing the accepted task over HTTP. */ });
      reconnecting = attempt;
      void attempt.finally(() => { if (reconnecting === attempt) reconnecting = undefined; });
    };
    const endpoint = this.url("/queue");
    const removed = (removedEndpoint: string, promptId: string) => {
      if (removedEndpoint === endpoint && promptId === id) failure = new ExecutionError("排队任务已从服务器删除。", "cancelled");
    };
    queueRemovalListeners.add(removed);
    if (confirmedQueueRemovals.has(queueRemovalKey(endpoint, id))) removed(endpoint, id);
    const listener = (e: Event) => {
      if (e.data.prompt_id !== id) return;
      if (e.type === "execution_success") {
        // Success is a reason to fetch its receipt immediately, not to invent
        // outputs or wait for the normal polling interval to expire.
        historyRefresh = true;
        wakePoll?.();
      }
      if (e.type === "execution_error" || e.type === "execution_interrupted") {
        failure = serverExecutionError(e.data, workflow, e.type === "execution_interrupted");
        selectNode(e.data.node_id ?? e.data.node, e.data.node_type, e.data.display_node_id);
        publish({ status: failure.status, error: failure.message, details: failure.details, progress: undefined });
      }
      if (e.type === "execution_start") {
        execution = {}; cached.clear(); completed.clear();
        publish({ status: "loading", progress: undefined });
      }
      if (e.type === "execution_cached" && Array.isArray(e.data.nodes)) {
        e.data.nodes.forEach(value => { const nodeId = nodeIdentifier(value); if (nodeId) cached.add(nodeId); });
        publish({});
      }
      if (e.type === "executing") {
        if (e.data.node) {
          const previousNode = execution.nodeId;
          selectNode(e.data.node, e.data.node_type, e.data.display_node_id);
          publish({ status: "generating", ...(previousNode !== execution.nodeId ? { progress: undefined } : {}) });
        } else {
          execution = { ...execution, nodeId: undefined, nodeType: undefined, nodeTitle: undefined, value: undefined, max: undefined };
          publish({ progress: undefined });
        }
      }
      if (e.type === "executed") {
        const nodeId = nodeIdentifier(e.data.node); if (nodeId) completed.add(nodeId);
        publish({});
      }
      if (e.type === "progress") {
        selectNode(e.data.node ?? e.data.node_id ?? execution.nodeId, e.data.node_type, e.data.display_node_id);
        progress(e.data.value, e.data.max);
      }
      if (e.type === "progress_state" && isRecord(e.data.nodes)) {
        let running: [string, Record<string, unknown>] | undefined;
        for (const [key, state] of Object.entries(e.data.nodes)) {
          if (!isRecord(state) || state.prompt_id !== undefined && state.prompt_id !== id) continue;
          const nodeId = nodeIdentifier(state.node_id) ?? key;
          if (state.state === "finished") completed.add(nodeId);
          if (state.state === "running" && (!running || execution.nodeId === nodeId)) running = [nodeId, state];
        }
        if (running) {
          selectNode(running[0], running[1].node_type, running[1].display_node_id ?? running[1].real_node_id);
          publish({ status: "generating", progress: undefined });
          progress(running[1].value, running[1].max);
        } else publish({});
      }
    };
    this.events.forEach(listener);
    this.listeners.add(listener);
    try {
      let misses = 0;
      while (native || Date.now() - started < this.connection.timeoutMinutes * 60000) {
        signal.throwIfAborted();
        if (failure) throw failure;
        if (!this.wsAlive && !socketNotice) {
          socketNotice = true;
          publish({
            details: "实时通道不可用，正在通过历史与队列查询恢复状态。",
          });
        }
        reconnect();
        let history: Record<string, History>;
        try {
          history = await this.getHistory(id, signal);
          misses = 0;
        } catch (e) {
          if (++misses >= 5) throw e;
          await nextPoll(2000);
          continue;
        }
        signal.throwIfAborted();
        if (failure) throw failure;
        const h = history[id];
        for (const message of h?.status?.messages ?? []) {
          if (Array.isArray(message) && ["execution_error", "execution_interrupted"].includes(message[0]) && isRecord(message[1])) {
            listener({ type: message[0], data: { ...message[1], prompt_id: typeof message[1].prompt_id === "string" ? message[1].prompt_id : message[1].prompt_id === undefined ? id : undefined } });
          }
        }
        if (failure) throw failure;
        if (h?.status?.status_str === "error") {
          throw new ExecutionError(
            JSON.stringify(h.status.messages ?? h.status),
            "failed", JSON.stringify(h.status, null, 2), execution,
          );
        }
        if (
          h?.status?.completed ||
          (native && h?.status?.status_str === "success") ||
          (h && h.status === undefined && Object.keys(h.outputs ?? {}).length)
        )
          return h;
        if (!this.wsAlive) {
          const q = await this.getQueue(signal);
          const running = q.queue_running.some((item) => item[1] === id);
          const pending = q.queue_pending.some((item) => item[1] === id);
          if (native && !running && !pending) {
            // Leaving the queue is not evidence that a task is queued again.
            execution = { ...execution, queueRemaining: undefined };
            publish({ status: lastState.status === "queued" ? "loading" : lastState.status, details: "平台队列中未找到该任务，正在查询原任务结果。" });
          } else if (running) {
            // A queue snapshot has no per-node progress. Do not erase the last
            // real event merely because realtime transport is reconnecting.
            execution = { ...execution, queueRemaining: undefined };
            publish({ status: "generating" });
          } else {
            execution = { ...execution, queueRemaining: q.queue_pending.length, nodeId: undefined, nodeType: undefined, nodeTitle: undefined, value: undefined, max: undefined };
            publish({ status: "queued", progress: undefined });
          }
        }
        await nextPoll(1500);
      }
      throw new Error(
        "等待生成结果超时。任务可能仍在服务器运行，可在任务面板恢复查询。",
      );
    } finally {
      observing = false;
      reconnectAbort.abort();
      if (reconnected) this.disconnect();
      this.listeners.delete(listener);
      queueRemovalListeners.delete(removed);
    }
  }
}
export function outputFiles(
  history: History,
  w: WorkflowDefinition,
): OutputFile[] {
  const output = history.outputs?.[w.output.nodeId];
  const files = output?.[w.output.field];
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.some((f) => typeof f.filename !== "string")
  )
    throw new Error(
      "工作流已执行，但没有找到输出文件。请检查输出节点与输出字段映射。",
    );
  return files.map(checkedOutput);
}
export function outputText(history: History, w: WorkflowDefinition): string {
  const value = history.outputs?.[w.output.nodeId]?.[w.output.field];
  const lines = typeof value === "string" ? [value] : value;
  if (!Array.isArray(lines) || !lines.length || lines.some(v => typeof v !== "string"))
    throw new Error("工作流已执行，但没有返回有效的文本结果。");
  const text = lines.join("\n");
  if (!text.trim()) throw new Error("工作流返回了空文本结果。");
  return text;
}
export function collectWorkflowOutputs(history: History, w: WorkflowDefinition): {
  files: RemoteFile[];
  text?: string;
  fileKinds: Record<string, MediaKind>;
  fileSources: Record<string, Pick<RemoteFile, "sourceNodeId" | "sourceField">>;
  textFirst: boolean;
  automaticFiles: string[];
  warnings: string[];
} {
  const files: RemoteFile[] = [], text: string[] = [];
  const fileKinds: Record<string, MediaKind> = {};
  const fileSources: Record<string, Pick<RemoteFile, "sourceNodeId" | "sourceField">> = {};
  const descriptors = new Set<string>(), seenFiles = new Map<string, RemoteFile>();
  const automaticFiles: string[] = [], warnings: string[] = [];
  const outputs = [w.output, ...(w.additionalOutputs ?? [])];
  const fallbackNodes = new Set<string>();
  const inputOnlyNodes = new Set(["LoadImage", "LoadImageMask", "LoadVideo", "LoadAudio", "VHS_LoadVideo", "VHS_LoadVideoPath", "VHS_LoadAudio", "VHS_LoadImages"]);
  let firstResult: "text" | "file" | undefined;
  const addText = (value: string) => { if (value.trim()) { firstResult ??= "text"; text.push(value); } };
  const addFile = (value: RemoteFile, kind: MediaKind, output: WorkflowDefinition["output"], automatic = false, field?: string) => {
    if (value.type === "input") {
      warnings.push("输出 " + output.nodeId + "." + (field ?? output.field) + " 指向 input 目录；生成结果必须来自 output 或 temp 目录，已跳过。");
      return false;
    }
    const realPublisher = !!w.template?.[output.nodeId] &&
      output.nodeId !== "__rh_app_output" && output.nodeId !== "fisherai_webapp_output";
    const file = checkedOutput(value), key = outputKey(file), existing = seenFiles.get(key);
    const sourceNodeId = value.sourceNodeId ?? (realPublisher ? output.nodeId : undefined);
    const sourceField = value.sourceField ?? (realPublisher && (!automatic || output.field === "*")
      ? field ?? (output.field === "*" ? undefined : output.field) : undefined);
    if (sourceNodeId) fileSources[key] ??= { sourceNodeId, ...(sourceField ? { sourceField } : {}) };
    if (existing) {
      // A second published field can identify the same file more precisely.
      for (const name of ["sourceNodeId", "sourceField", "width", "height"] as const)
        if (existing[name] === undefined && file[name] !== undefined) Object.assign(existing, { [name]: file[name] });
      return true;
    }
    firstResult ??= "file"; seenFiles.set(key, file); files.push(file); fileKinds[key] = kind;
    if (automatic) automaticFiles.push(key);
    return true;
  };
  const detectedKind = (filename: string): MediaKind => {
    const ext = filename.split(".").at(-1)?.toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif", "svg", "heic", "ico"].includes(ext ?? "")) return "image";
    if (["mp4", "webm", "mov", "avi", "mkv", "m4v", "flv", "mpeg", "mpg"].includes(ext ?? "")) return "video";
    if (["mp3", "wav", "ogg", "flac", "opus", "m4a", "aac", "wma"].includes(ext ?? "")) return "audio";
    if (["txt", "srt", "vtt", "csv", "md", "markdown", "log", "html", "xml"].includes(ext ?? "")) return "text";
    return "file";
  };
  const metadata = /^(?:progress|percent(?:age)?|max|min|total|current|steps?|seed|execution_time|duration|fps|frame_rate|width|height|format|type|subfolder|filename|file_name|filename_prefix|prefix|node_id|prompt_id|status|completed|success|errors?|exception(?:_message)?|traceback|warnings?|metadata|meta|settings|config(?:uration)?|parameters?|params|display_name|name|label|paths?|file_path|urls?|download_url)$/i;
  const textKey = /text|content|body|caption|transcript|lyrics|response|answer|message|reply|translation|markdown|summary|description|document/i;
  const mediaKey = /^(?:images?|videos?|clips?|audio|sound|files?|gifs?|attachments?|previews?)$/i;
  const previewKey = /(?:^|_)(?:previews?|thumbnails?|thumbs?|posters?)(?:_|$)/i;
  function automaticNode(value: unknown, output: WorkflowDefinition["output"]) {
    const visited = new WeakSet<object>();
    const before = files.length + text.length;
    const previewTrees: { value: unknown; key: string; body: boolean; depth: number; field: string }[] = [];
    let foundMedia = false;
    let count = 0;
    function scan(value: unknown, key = "", body = false, depth = 0, field = "", includePreview = false) {
      if (++count > 100000 || depth > 40) throw new Error("工作流返回的结果结构过大或嵌套过深，无法安全读取。");
      const keyName = key.replace(/[-\s]/g, "_");
      if (metadata.test(keyName)) return;
      if (!includePreview && previewKey.test(keyName.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))) {
        previewTrees.push({ value, key, body, depth, field });
        return;
      }
      const textual = body || textKey.test(keyName);
      const readableString = (value: string) => value.trim() && (textual || (!mediaKey.test(keyName) && !/^(?:[a-z][a-z0-9+.-]*:\/\/|data:|blob:|[a-z]:[\\/]|\/|\.{1,2}[\\/])/i.test(value.trim())));
      if (typeof value === "string") { if (readableString(value)) addText(value); return; }
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (!Array.isArray(value) && "filename" in value) {
        const file = value as RemoteFile;
        if (addFile(file, typeof file.filename === "string" ? detectedKind(file.filename) : "file", output, true, field || key)) foundMedia = true;
        return;
      }
      if (Array.isArray(value)) {
        if (value.every(item => typeof item === "string")) {
          const lines = value.filter(readableString); if (lines.length) addText(lines.join("\n"));
        } else for (const item of value) scan(item, key, textual, depth + 1, field, includePreview);
      } else for (const [childKey, child] of Object.entries(value)) scan(child, childKey, textual, depth + 1, field || childKey, includePreview);
    }
    scan(value);
    // A publisher can return both the finished media and display-only posters.
    // Read preview subtrees only when this node has no actual media receipt.
    if (!foundMedia) for (const tree of previewTrees) scan(tree.value, tree.key, tree.body, tree.depth, tree.field, true);
    // Detection and tool nodes can return numbers or structured JSON rather than media.
    // Preserve that actual body only when this node supplied no file or text result.
    if (!foundMedia && files.length + text.length === before) {
      const jsonVisited = new WeakSet<object>();
      function jsonBody(value: unknown, key = "", body = false, depth = 0): unknown {
        if (depth > 40) return undefined;
        const keyName = key.replace(/[-\s]/g, "_");
        if (metadata.test(keyName)) return undefined;
        const textual = body || textKey.test(keyName);
        if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
        if (typeof value === "boolean") return value;
        if (typeof value === "string") return value.trim() && (textual || (!mediaKey.test(keyName) && !/^(?:[a-z][a-z0-9+.-]*:\/\/|data:|blob:|[a-z]:[\\/]|\/|\.{1,2}[\\/])/i.test(value.trim()))) ? value : undefined;
        if (!value || typeof value !== "object" || jsonVisited.has(value) || (!Array.isArray(value) && "filename" in value)) return undefined;
        jsonVisited.add(value);
        if (Array.isArray(value)) { const result = value.map(item => jsonBody(item, key, textual, depth + 1)).filter(item => item !== undefined); return result.length ? result : undefined; }
        const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [childKey, child] of Object.entries(value)) { const converted = jsonBody(child, childKey, textual, depth + 1); if (converted !== undefined) result[childKey] = converted; }
        return Object.keys(result).length ? result : undefined;
      }
      const body = jsonBody(value);
      if (body !== undefined) addText(JSON.stringify(body, null, 2));
    }
    return foundMedia || files.length + text.length > before;
  }
  // Older saved definitions can list only the normal image while retaining
  // another genuine SaveImage publisher for the enlarged image in their graph.
  // Recover only exact known save contracts with a same-node file receipt.
  const declaredNodes = new Set(outputs.map(output => output.nodeId));
  const previewClasses = new Set(["PreviewImage", "PreviewAny", "easy showAnything"]);
  function hasGeneratedFile(value: unknown): boolean {
    const pending = [value], visited = new WeakSet<object>();
    while (pending.length) {
      const current = pending.pop();
      if (!current || typeof current !== "object" || visited.has(current)) continue;
      visited.add(current);
      if (!Array.isArray(current) && "filename" in current) {
        try { checkedOutput(current as RemoteFile); return true; } catch { continue; }
      }
      if (Array.isArray(current)) for (const child of current) pending.push(child);
      else for (const [key, child] of Object.entries(current)) {
        const keyName = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]/g, "_");
        if (!metadata.test(keyName) && !previewKey.test(keyName)) pending.push(child);
      }
    }
    return false;
  }
  for (const [nodeId, node] of Object.entries(w.template ?? {})) {
    if (declaredNodes.has(nodeId) || previewClasses.has(node.class_type) ||
      !Object.hasOwn(savedOutputContracts, node.class_type) || !Object.hasOwn(history.outputs ?? {}, nodeId)) continue;
    if (hasGeneratedFile(history.outputs[nodeId])) outputs.push({ nodeId, field: "*", kind: savedOutputContracts[node.class_type].kind });
  }
  for (const output of outputs) {
    const descriptor = JSON.stringify([output.nodeId, output.field, output.kind]);
    if (descriptors.has(descriptor)) continue;
    descriptors.add(descriptor);
    if (inputOnlyNodes.has(w.template?.[output.nodeId]?.class_type ?? "")) {
      warnings.push("节点 " + output.nodeId + " 是素材加载节点，已跳过错误的输出绑定。");
      continue;
    }
    if (output.field === "*") {
      if (!automaticNode(history.outputs?.[output.nodeId], output)) warnings.push("输出节点 " + output.nodeId + " 未返回新的可识别媒体或正文。");
      continue;
    }
    const row = history.outputs?.[output.nodeId];
    let value = row?.[output.field];
    // RunningHub V1 may identify a genuine publisher without identifying its
    // several UI fields. Keep that node's verified receipt once, without
    // pretending that a normal result belongs to the upscale field (or vice versa).
    const unmappedFiles = row?.files;
    if (value === undefined && w.runninghub && new Set(outputs.filter(item => item.nodeId === output.nodeId).map(item => item.field)).size > 1 &&
      Array.isArray(unmappedFiles) && unmappedFiles.length && unmappedFiles.every(file => file && typeof file === "object" &&
        typeof file.filename === "string" && file.sourceNodeId === output.nodeId && file.sourceField === undefined)) {
      if (!fallbackNodes.has(output.nodeId)) {
        fallbackNodes.add(output.nodeId);
        warnings.push("输出节点 " + output.nodeId + " 的回执未标注具体字段，已保留该节点的全部实际结果。");
        for (const file of unmappedFiles) addFile(file as RemoteFile, detectedKind(file.filename), output, true);
      }
      continue;
    }
    if (output.kind === "text" && (typeof value === "string" || (Array.isArray(value) && value.every(item => typeof item === "string")))) {
      addText(outputText(history, { ...w, output }));
      continue;
    }
    // Custom nodes may return one descriptor or a descriptor list under their UI field.
    const entries = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : undefined;
    if (!entries?.length || entries.some(entry => !entry || typeof entry !== "object" || typeof entry.filename !== "string"))
      throw new Error("工作流已执行，但没有找到输出 " + output.nodeId + "." + output.field + " 的有效结果。");
    for (const entry of entries) {
      addFile(entry as RemoteFile, output.kind, output);
    }
  }
  if (!files.length && !text.length) throw new Error("工作流已执行，但没有可读取的生成结果。未发现有效文件描述或文本正文，请检查输出节点返回的 history 数据。" + (warnings.length ? "\n" + warnings.join("\n") : ""));
  return { files, fileKinds, fileSources, textFirst: firstResult === "text", automaticFiles, warnings, ...(text.length ? { text: text.join("\n\n") } : {}) };
}
export function friendlyError(e: unknown) {
  if (e instanceof NativeRunningHubAccountError) return { error: e.message, details: e.message };
  if (e instanceof ExecutionError) return { error: e.message, details: e.details ?? e.message };
  if (e instanceof ApiError) return { error: e.message, details: e.body ?? e.message };
  if (e instanceof DOMException && e.name === "AbortError") return { error: "已取消", details: undefined };
  const detail = e instanceof Error ? e.message : String(e);
  if (/out of memory|CUDA.*memory|VRAM/i.test(detail))
    return { error: "显存不足，请降低分辨率、时长或帧数。", details: detail };
  if (/Failed to fetch|network|fetch failed/i.test(detail))
    return {
      error: "无法连接工作站，请检查服务地址、隧道或跨域设置。",
      details: detail,
    };
  if (/class_type|not exist|not found in.*list/i.test(detail))
    return {
      error: "服务器缺少工作流所需的节点或模型，请检查工作站配置。",
      details: detail,
    };
  return { error: detail.slice(0, 240), details: detail };
}
