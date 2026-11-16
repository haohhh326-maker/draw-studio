import { hasNativeWebview, nativeWebviewInvoke } from "./native-webview-bridge";

type Service = "muse" | "deepseek";
type Cookie = { name: string; value: string; domain: string; path: string; expires?: number;
  httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None" };
type Storage = { origin: string; localStorage: { name: string; value: string }[] };
export type ServiceAuthSnapshot = { cookies: Cookie[]; origins: Storage[] };

const primed = new Set<Service>();
const priming = new Map<Service, Promise<void>>();

function route(service: Service, operation: "import" | "export" | "session") {
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const sameHost = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  const prefix = service === "muse" ? "/api/muse" : "/__canvas/deepseek";
  return (desktop && !sameHost ? "http://127.0.0.1:1420" : "") + prefix + "/session" + (operation === "session" ? "" : "/" + operation);
}

function snapshot(value: unknown): ServiceAuthSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !Array.isArray((value as ServiceAuthSnapshot).cookies) || !Array.isArray((value as ServiceAuthSnapshot).origins))
    throw new Error("登录状态格式无效。");
  return value as ServiceAuthSnapshot;
}

function loginCredential(service: Service, value: ServiceAuthSnapshot) {
  const cookieNames = service === "muse" ? ["hatch_sess"] : ["ds_session_id"];
  const storageNames = service === "muse" ? [] : ["userToken"];
  const now = Date.now() / 1000;
  const cookie = value.cookies.find(item => cookieNames.includes(item.name) && !!item.value &&
    (item.expires === undefined || item.expires < 0 || item.expires > now));
  if (cookie) return cookie.name + ":" + cookie.value;
  const storage = value.origins.flatMap(origin => origin.localStorage ?? [])
    .find(item => storageNames.includes(item.name) && !!item.value);
  return storage ? storage.name + ":" + storage.value : undefined;
}

async function backendConnected(service: Service) {
  const response = await fetch(route(service, "session"), { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`${service === "muse" ? "Muse" : "DeepSeek"} 登录状态查询失败（HTTP ${response.status}）。`);
  const state = await response.json() as { status?: string };
  return state.status === "connected";
}

async function backendAuth(service: Service, operation: "import" | "export", value?: ServiceAuthSnapshot, signal?: AbortSignal) {
  const response = await fetch(route(service, operation), {
    method: operation === "export" ? "GET" : "POST", signal,
    credentials: "same-origin", cache: "no-store",
    ...(operation === "import" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }
      : { headers: { "X-Canvas-Session": "1" } }),
  });
  if (!response.ok) throw new Error(`${service === "muse" ? "Muse" : "DeepSeek"} 登录同步失败（HTTP ${response.status}）。`);
  return operation === "export" ? snapshot(await response.json()) : undefined;
}

function primeFailure(stage: string, cause: unknown): Error {
  const raw = String(cause);
  const known = [
    "Browser storage cannot be read", "Browser storage is unavailable", "Browser storage response is invalid",
    "Browser storage is not on the expected site", "Browser cookie cannot be imported",
    "Browser session reload failed", "Browser cookies are unavailable", "Browser session is invalid",
    "Browser cookie is invalid", "Browser cookie SameSite is invalid", "Browser cookie expiration is invalid",
    "Browser storage origin is invalid",
  ].find(reason => raw.includes(reason));
  const http = raw.match(/HTTP (\d{3})/);
  return new Error(`登录同步在${stage}时失败${known ? `：${known}` : http ? `：HTTP ${http[1]}` : ""}。`);
}

/** On the first panel open, preserve an existing signed-in Playwright profile. */
export function primeNativeServiceAuth(service: Service): Promise<void> {
  if (!hasNativeWebview() || primed.has(service)) return Promise.resolve();
  const ongoing = priming.get(service);
  if (ongoing) return ongoing;
  const operation = (async () => {
    let native: ServiceAuthSnapshot;
    try { native = snapshot(await nativeWebviewInvoke("export_service_webview_auth", service)); }
    catch (cause) { throw primeFailure("读取内置浏览器", cause); }
    if (loginCredential(service, native)) { primed.add(service); return; }
    let connected: boolean;
    try { connected = await backendConnected(service); }
    catch (cause) { throw primeFailure("检查后台登录", cause); }
    if (connected) {
      let previous: ServiceAuthSnapshot | undefined;
      try { previous = await backendAuth(service, "export"); }
      catch (cause) { throw primeFailure("读取后台登录", cause); }
      if (previous && loginCredential(service, previous)) {
        try { await nativeWebviewInvoke("import_service_webview_auth", service, { snapshot: previous }); }
        catch (cause) { throw primeFailure("写入内置浏览器", cause); }
        primed.add(service);
      }
    }
  })();
  priming.set(service, operation);
  void operation.finally(() => { if (priming.get(service) === operation) priming.delete(service); }).catch(() => {});
  return operation;
}

/** Before a canvas operation, transfer the current native login to its backend automation page. */
export async function syncNativeServiceAuth(service: Service, signal?: AbortSignal): Promise<void> {
  if (!hasNativeWebview()) return;
  signal?.throwIfAborted();
  let native: ServiceAuthSnapshot | null;
  try { native = await nativeWebviewInvoke<ServiceAuthSnapshot | null>("export_service_webview_auth", service); }
  catch (cause) {
    // An unopened native page has no newer login; the existing backend session remains valid.
    if (/browser is not open|webview is not open|网页未打开|浏览器未打开/i.test(String(cause))) return;
    throw new Error(`${service === "muse" ? "Muse" : "DeepSeek"} 内置浏览器登录状态读取失败。`);
  }
  signal?.throwIfAborted();
  if (native === null || !loginCredential(service, snapshot(native))) return;
  const previous = await backendAuth(service, "export", undefined, signal);
  if (previous && loginCredential(service, previous) === loginCredential(service, native)) return;
  await backendAuth(service, "import", native, signal);
  signal?.throwIfAborted();
}
