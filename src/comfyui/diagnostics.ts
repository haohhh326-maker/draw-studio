export const COMMUNICATION_LOG_LIMIT = 250;

export type CommunicationRecord = Readonly<{
  id: number;
  time: number;
  origin: string;
  transport: "HTTP" | "WS";
  stage: "request" | "response" | "error" | "connect" | "open" | "close" | "event";
  route: string;
  method?: string;
  status?: number;
  durationMs?: number;
  requestId?: number;
  eventType?: string;
  promptId?: string;
  nodeId?: string;
  value?: number;
  max?: number;
  queueRemaining?: number;
  errorKind?: string;
}>;

const listeners = new Set<() => void>();
let records: readonly CommunicationRecord[] = Object.freeze([]);
let sequence = 0;
const standardEvents = new Set(["status", "execution_start", "execution_cached", "executing", "executed", "progress", "progress_state", "execution_success", "execution_error", "execution_interrupted"]);
const routes = new Set(["/prompt", "/queue", "/interrupt", "/free", "/history", "/object_info", "/system_stats", "/upload/image", "/upload/mask", "/view", "/ws"]);
const runningHubRoutes = new Set(["/uc/openapi/accountStatus", "/openapi/v2/media/upload/binary", "/task/openapi/create", "/task/openapi/ai-app/run", "/task/openapi/status", "/task/openapi/outputs", "/task/openapi/cancel", "/openapi/v2/query"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): string | undefined => typeof value === "string" && /^[\w:-]{1,128}$/.test(value) ? value : undefined;
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function communicationOrigin(baseUrl: string): string {
  try { return new URL(baseUrl).origin; } catch { return "未知服务"; }
}

function routeName(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0];
  if (routes.has(pathname) || runningHubRoutes.has(pathname)) return pathname;
  if (/^\/openapi\/v2\/run\/ai-app\/\d{1,32}$/.test(pathname)) return "/openapi/v2/run/ai-app/:appId";
  if (/^\/history\/[^/]+$/.test(pathname)) return "/history/:promptId";
  if (/^\/api\/jobs\/[^/]+\/cancel$/.test(pathname)) return "/api/jobs/:promptId/cancel";
  return "/其他接口";
}

function append(value: Omit<CommunicationRecord, "id" | "time">): number {
  const entry = Object.freeze({ ...value, id: ++sequence, time: Date.now() });
  records = Object.freeze([...records.slice(-(COMMUNICATION_LOG_LIMIT - 1)), entry]);
  for (const notify of listeners) { try { notify(); } catch { /* Diagnostics cannot stop transport. */ } }
  return entry.id;
}

export function communicationSnapshot(): readonly CommunicationRecord[] { return records; }
export function subscribeCommunication(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function clearCommunicationLog(): void {
  records = Object.freeze([]);
  for (const notify of listeners) { try { notify(); } catch { /* Optional UI subscriber. */ } }
}

export function logHttp(baseUrl: string, path: string, method: string, stage: "request" | "response" | "error", details: { requestId?: number; status?: number; durationMs?: number; errorKind?: unknown } = {}): number {
  const safeMethod = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(method) ? method.toUpperCase() : "OTHER";
  const errorKind = ["AbortError", "TimeoutError", "TypeError", "ApiError"].includes(String(details.errorKind)) ? String(details.errorKind) : details.errorKind ? "Error" : undefined;
  // Never retain headers, query strings, bodies, arbitrary error messages or URLs.
  return append({ origin: communicationOrigin(baseUrl), transport: "HTTP", route: routeName(path), stage, method: safeMethod,
    ...(finite(details.requestId) !== undefined ? { requestId: details.requestId } : {}),
    ...(finite(details.status) !== undefined ? { status: details.status } : {}),
    ...(finite(details.durationMs) !== undefined ? { durationMs: Math.max(0, Math.round(details.durationMs!)) } : {}),
    ...(errorKind ? { errorKind } : {}) });
}

export function logWebSocket(baseUrl: string, stage: "connect" | "open" | "close" | "error" | "event", packet?: unknown): void {
  const event = record(packet) ? packet : {}, data = record(event.data) ? event.data : {};
  const status = record(data.status) ? data.status : {}, execution = record(status.exec_info) ? status.exec_info : {};
  const type = typeof event.type === "string" && standardEvents.has(event.type) ? event.type : "custom_event";
  const promptId = identifier(data.prompt_id), nodeId = identifier(data.node);
  const value = finite(data.value), max = finite(data.max), queueRemaining = finite(execution.queue_remaining);
  append({ origin: communicationOrigin(baseUrl), transport: "WS", route: "/ws", stage,
    ...(stage === "event" ? { eventType: type } : {}), ...(promptId ? { promptId } : {}), ...(nodeId ? { nodeId } : {}),
    ...(value !== undefined ? { value } : {}), ...(max !== undefined ? { max } : {}), ...(queueRemaining !== undefined ? { queueRemaining } : {}) });
}
