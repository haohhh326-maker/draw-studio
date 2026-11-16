import { isTauri } from "@tauri-apps/api/core";
import type { Connection } from "../types";

const nativeSite = "https://www.runninghub.cn" as const;
const hidden = "[已隐藏]";
export type NativeRunningHubEndpoint = {
  baseUrl: string;
  site: typeof nativeSite;
  tier: "proxy" | "proxy-plus";
  token: string;
};
export type NativeRunningHubAccountStatus = {
  valid: true;
  apiType: "NORMAL";
  currency?: string;
  remainCoins?: string;
  remainMoney?: string;
  currentTaskCounts?: string;
};
/** A rejected read-only preflight proves that no prompt request was sent. */
export class NativeRunningHubAccountError extends Error {
  constructor(message: string, readonly aborted = false) {
    super(message);
    this.name = "NativeRunningHubAccountError";
  }
}

/** Recognize the official route even when its suffix still needs validation. */
export function isRunningHubNativeConnection(connection: Pick<Connection, "baseUrl">): boolean {
  try {
    const url = new URL(connection.baseUrl);
    return ["www.runninghub.cn", "runninghub.cn"].includes(url.hostname) && /^\/proxy(?:-plus)?(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

/** Split a pasted official address before it can enter a URL field or task snapshot. */
export function normalizeRunningHubNativeConnection<T extends Connection>(connection: T): T {
  let url: URL;
  if (/[\u0000-\u001f\u007f]/.test(connection.baseUrl)) throw new Error("RunningHub 原生地址包含无效字符。");
  try { url = new URL(connection.baseUrl.trim()); } catch { throw new Error("RunningHub 原生地址无效。请选择官方标准版或高配版地址。"); }
  if (url.protocol !== "https:" || !["www.runninghub.cn", "runninghub.cn"].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash)
    throw new Error("RunningHub 原生连接仅支持中国站官方 HTTPS 代理地址。");
  const parts = url.pathname.replace(/\/$/, "").split("/");
  if (parts.length < 2 || parts.length > 3 || !["proxy", "proxy-plus"].includes(parts[1]))
    throw new Error("RunningHub 原生地址只能使用 /proxy 或 /proxy-plus，可粘贴包含 API Key 的官方地址。");
  let pasted = "";
  try { pasted = parts[2] ? decodeURIComponent(parts[2]) : ""; } catch { throw new Error("RunningHub 原生地址中的 API Key 无效。"); }
  const token = connection.token.trim();
  if ([pasted, token].some(value => value && (!/^[A-Za-z0-9._~-]+$/.test(value) || value === "." || value === "..")))
    throw new Error("RunningHub API Key 格式无效，请仅填写密钥本身。");
  if (pasted && token && pasted !== token)
    throw new Error("地址中的 API Key 与单独填写的密钥不一致，请保留同一把密钥。");
  return { ...connection, baseUrl: nativeSite + "/" + parts[1], token: pasted || token, authHeader: "Authorization", authPrefix: "Bearer " };
}

export function getNativeRunningHubEndpoint(connection: Connection): NativeRunningHubEndpoint {
  const normalized = normalizeRunningHubNativeConnection(connection);
  if (!normalized.token) throw new Error("请先填写 RunningHub 原生连接的 API Key。");
  return { baseUrl: normalized.baseUrl, site: nativeSite, tier: normalized.baseUrl.endsWith("/proxy-plus") ? "proxy-plus" : "proxy", token: normalized.token };
}

export function redactNativeRunningHubText(value: string, connection: Connection): string {
  let safe = value;
  const secrets = new Set<string>();
  if (connection.token) {
    secrets.add(connection.token);
    secrets.add(encodeURIComponent(connection.token));
    for (const tier of ["proxy", "proxy-plus"]) for (const scheme of ["https", "wss"]) {
      const url = scheme + "://www.runninghub.cn/" + tier + "/" + connection.token;
      secrets.add(url); secrets.add(encodeURIComponent(url)); secrets.add(encodeURIComponent(encodeURIComponent(url)));
    }
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) safe = safe.split(secret).join(hidden);
  return safe
    .replace(/(?:https?|wss?):\/\/(?:www\.)?runninghub\.cn\/proxy(?:-plus)?\/[^\s/"'<>?#\\]+/gi, "https://www.runninghub.cn/proxy/" + hidden)
    .replace(/Bearer\s+[^\s,}"'\n]+/gi, "Bearer " + hidden);
}

export function sanitizeNativeRunningHubValue<T>(value: T, connection: Connection): T {
  if (typeof value === "string") return redactNativeRunningHubText(value, connection) as T;
  if (Array.isArray(value)) return value.map(item => sanitizeNativeRunningHubValue(item, connection)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactNativeRunningHubText(key, connection), sanitizeNativeRunningHubValue(item, connection)])) as T;
  return value;
}

export function nativeRunningHubBrowserUrl(path: string): string {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(import.meta.env.BASE_URL + "api/runninghub-comfy" + path, origin).toString();
}

/** Only native plugins receive a credential-bearing upstream URL. */
export function nativeRunningHubUpstreamUrl(endpoint: NativeRunningHubEndpoint, path: string): string {
  if (!/^\/(?!\/)/.test(path) || path.includes("#") || /[\r\n\\]/.test(path)) throw new Error("RunningHub 原生请求路径无效。");
  return endpoint.baseUrl + "/" + encodeURIComponent(endpoint.token) + path;
}

/** No generated timeout: cancellation belongs to the caller, including long uploads. */
export async function requestNativeRunningHub(connection: Connection, path: string, init: RequestInit = {}): Promise<Response> {
  connection = normalizeRunningHubNativeConnection(connection);
  const endpoint = getNativeRunningHubEndpoint(connection);
  const headers = new Headers(init.headers);
  headers.delete("X-RunningHub-Native-Endpoint");
  headers.delete("Authorization");
  let response: Response;
  try {
    if (isTauri()) {
      const { fetch: nativeFetch } = await import("@tauri-apps/plugin-http");
      const account = path === "/account";
      const resultTask = /^\/task-outputs\/(\d{1,32})$/.exec(path)?.[1];
      if (account || resultTask) headers.set("Content-Type", "application/json");
      response = await nativeFetch(account ? endpoint.site + "/uc/openapi/accountStatus" : resultTask ? endpoint.site + "/task/openapi/outputs" : nativeRunningHubUpstreamUrl(endpoint, path), {
        ...init, headers, redirect: "error", maxRedirections: 0,
        ...(account ? { method: "POST", body: JSON.stringify({ apikey: endpoint.token }) } : {}),
        ...(resultTask ? { method: "POST", body: JSON.stringify({ apiKey: endpoint.token, taskId: resultTask }) } : {}),
      });
    } else {
      // Validate path even though the browser only receives the key-free local URL.
      nativeRunningHubUpstreamUrl(endpoint, path);
      headers.set("Authorization", "Bearer " + endpoint.token);
      headers.set("X-RunningHub-Native-Endpoint", endpoint.baseUrl);
      response = await fetch(nativeRunningHubBrowserUrl(path), { ...init, headers, redirect: "error" });
    }
    const safeHeaders = new Headers();
    response.headers.forEach((value, key) => { if (key.toLowerCase() !== "content-length") safeHeaders.set(key, redactNativeRunningHubText(value, connection)); });
    const contentType = response.headers.get("content-type") ?? "";
    const text = !response.ok || !path.startsWith("/view?") || /json|text|xml|javascript/i.test(contentType);
    let body: BodyInit | null = null;
    if (![204, 205, 304].includes(response.status) && init.method !== "HEAD") {
      if (text) {
        const raw = await response.text();
        try { body = JSON.stringify(sanitizeNativeRunningHubValue(JSON.parse(raw), connection)); }
        catch { body = redactNativeRunningHubText(raw, connection); }
      } else body = response.body;
    }
    // Rewrap so native Response.url/statusText cannot retain a private upstream URL.
    return new Response(body, { status: response.status, statusText: redactNativeRunningHubText(response.statusText, connection), headers: safeHeaders });
  } catch (reason) {
    const message = redactNativeRunningHubText(reason instanceof Error ? reason.message : String(reason), connection);
    if (reason instanceof DOMException && reason.name === "AbortError") throw new DOMException(message, "AbortError");
    const error = new Error("RunningHub 原生请求未完成：" + message);
    error.name = reason instanceof Error && ["AbortError", "TypeError"].includes(reason.name) ? reason.name : "Error";
    throw error;
  }
}

function accountDecimal(value: unknown): string | undefined {
  if (typeof value === "string") {
    const decimal = value.trim();
    return decimal.length <= 200 && /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(decimal) && Number.isFinite(Number(decimal)) ? decimal : undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  const decimal = String(value);
  if (!/[eE]/.test(decimal)) return decimal;
  const negative = decimal.startsWith("-");
  const [coefficient, exponent] = (negative ? decimal.slice(1) : decimal).toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = whole + fraction, point = whole.length + Number(exponent);
  return (negative ? "-" : "") + (point <= 0 ? "0." + "0".repeat(-point) + digits : point >= digits.length ? digits + "0".repeat(point - digits.length) : digits.slice(0, point) + "." + digits.slice(point));
}

/** Read-only billing gate, repeated before every prompt; it never switches account mode. */
export async function validateNativeRunningHubAccount(connection: Connection, signal?: AbortSignal): Promise<NativeRunningHubAccountStatus> {
  try {
    signal?.throwIfAborted();
    const response = await requestNativeRunningHub(connection, "/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal });
    signal?.throwIfAborted();
    if (!response.ok) throw new NativeRunningHubAccountError("RunningHub 账户校验失败（HTTP " + response.status + "），未提交任务。");
    let value: unknown;
    try { value = await response.json(); } catch { throw new NativeRunningHubAccountError("RunningHub 账户响应格式无效，未提交任务。"); }
    signal?.throwIfAborted();
    if (!value || typeof value !== "object" || !("code" in value) || ![0, "0"].includes(value.code as string | number) || !("data" in value) || !value.data || typeof value.data !== "object")
      throw new NativeRunningHubAccountError("RunningHub API Key 或账户校验失败，未提交任务。");
    const data = value.data as Record<string, unknown>;
    if (data.apiType !== "NORMAL") throw new NativeRunningHubAccountError("当前 RunningHub API Key 不是 NORMAL（RH 币及钱包）账户，未提交任务。请在 RunningHub 官方设置中确认计费类型。");
    const status: NativeRunningHubAccountStatus = { valid: true, apiType: "NORMAL" };
    if (typeof data.currency === "string" && /^(?:CNY|USD)$/.test(data.currency)) status.currency = data.currency;
    for (const field of ["remainCoins", "remainMoney", "currentTaskCounts"] as const) {
      const decimal = accountDecimal(data[field]);
      if (decimal !== undefined) status[field] = decimal;
    }
    return status;
  } catch (reason) {
    const aborted = signal?.aborted || reason instanceof Error && reason.name === "AbortError";
    if (aborted) throw new NativeRunningHubAccountError("已取消 RunningHub 账户校验，未提交任务。", true);
    if (reason instanceof NativeRunningHubAccountError) throw reason;
    throw new NativeRunningHubAccountError("RunningHub 账户校验未完成，未提交任务：" + redactNativeRunningHubText(reason instanceof Error ? reason.message : String(reason), connection));
  }
}
