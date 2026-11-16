import type { OptimizationContext, OptimizationModel, OptimizationResult, OptimizationSettings, OptimizationTarget, SkillStatus } from "./types";
import { OPTIMIZATION_CONTEXT_TOKEN_LIMITS } from "./types";
import { useStore } from "../stores/store";
import { createOptimizationReadCache } from "./read-cache";
import { syncNativeServiceAuth } from "../services/service-auth";
import type { ComputeProvider, Connection } from "../types";

export type OptimizationRoute = { computeProvider: ComputeProvider; connection: Connection };

export class OptimizationError extends Error {
  constructor(message: string, public code?: string, public textOnlyAllowed = false) { super(message); this.name = "OptimizationError"; }
}
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const sameHost = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  const response = await fetch(`${desktop && !sameHost ? "http://127.0.0.1:1420" : ""}/__canvas/prompt-optimization/${path}`, {
    method: body === undefined ? "GET" : "POST", signal,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new OptimizationError("本地优化服务尚未启动，请重新启动本地画布服务。", "SERVICE_UNAVAILABLE");
  const result = await response.json();
  if (!response.ok) throw new OptimizationError(result.error || `优化服务返回 HTTP ${response.status}。`, result.code, !!result.textOnlyAllowed);
  return result as T;
}
const DEFAULT_SKILL_DIRECTORY = "E:/123/DFCine/DFCine0.26/workflows/prompt";
function normalizeSettings(settings: OptimizationSettings): OptimizationSettings {
  const { templateDirectory: legacyDirectory, ...current } = settings;
  return { ...current, contextTokens: typeof current.contextTokens === "number" ? current.contextTokens : OPTIMIZATION_CONTEXT_TOKEN_LIMITS.default,
    skillDirectory: typeof current.skillDirectory === "string" ? current.skillDirectory
    : typeof legacyDirectory === "string" ? legacyDirectory : DEFAULT_SKILL_DIRECTORY };
}
type ModelInventory = { models: OptimizationModel[]; mmprojModels?: string[]; warning?: string };
const settingsReads = createOptimizationReadCache<OptimizationSettings>(2);
const modelReads = createOptimizationReadCache<ModelInventory>(1);
const skillReads = createOptimizationReadCache<SkillStatus>();
let settingsSnapshot: OptimizationSettings | undefined;
let settingsRevision = 0;
let connectionSnapshot: ReturnType<typeof currentConnection> | undefined;

const modelSettingsKey = (settings?: OptimizationSettings) => settings && JSON.stringify([
  settings.provider, settings.connectionSource, settings.baseUrl,
  settings.authHeader, settings.authPrefix, settings.keyConfigured,
]);
function acceptSettings(settings: OptimizationSettings, credentialChanged = false) {
  if (credentialChanged || modelSettingsKey(settingsSnapshot) !== modelSettingsKey(settings)) modelReads.clear();
  if (settingsSnapshot?.skillDirectory !== settings.skillDirectory) skillReads.clear();
  settingsSnapshot = structuredClone(settings);
}
function connectionForRead() {
  const connection = currentConnection();
  if (!connectionSnapshot || (Object.keys(connection) as (keyof typeof connection)[]).some(key => connection[key] !== connectionSnapshot![key])) {
    // Credentials remain in memory only. They are never serialized into a cache
    // key, persisted, or shared across two cloud connections.
    modelReads.clear(); skillReads.clear(); connectionSnapshot = connection;
  }
  return connection;
}
/** Explicit invalidation for a restarted local service or an uncertain settings write. */
export function resetOptimizationReadCaches() {
  settingsRevision++; settingsSnapshot = undefined; connectionSnapshot = undefined;
  settingsReads.clear(); modelReads.clear(); skillReads.clear();
}
export const optimizationClient = {
  settings: (signal?: AbortSignal, provider = useStore.getState().computeProvider) => settingsReads.read(provider === "comfyui" ? "settings:comfyui" : "settings:deepseek", async sharedSignal => {
    const revision = settingsRevision;
    let settings = normalizeSettings(await request<OptimizationSettings>("settings", undefined, sharedSignal));
    // ComfyUI shares the cloud button's connection. Migrate the former separate
    // connection before either model discovery or optimization runs.
    if (provider === "comfyui" && settings.provider === "comfyui" && settings.connectionSource !== "canvas") {
      settings = normalizeSettings(await request<OptimizationSettings>("settings", { connectionSource: "canvas", baseUrl: "" }, sharedSignal));
    }
    sharedSignal.throwIfAborted();
    if (revision !== settingsRevision) return settingsSnapshot ?? settings;
    acceptSettings(settings);
    return settings;
  }, signal),
  saveSettings: async (settings: Partial<OptimizationSettings> & { apiKey?: string }, signal?: AbortSignal) => {
    try {
      const saved = normalizeSettings(await request<OptimizationSettings>("settings", settings, signal));
      signal?.throwIfAborted();
      settingsRevision++; acceptSettings(saved, settings.apiKey !== undefined);
      settingsReads.prime("settings:comfyui", saved);
      settingsReads.prime("settings:deepseek", saved);
      return structuredClone(saved);
    } catch (cause) {
      // A cancelled POST may have committed on the service. Do not present a
      // stale snapshot as the saved settings on the next open.
      if (signal?.aborted) resetOptimizationReadCaches();
      throw cause;
    }
  },
  models: (signal?: AbortSignal, refresh = false) => {
    const connection = connectionForRead();
    return modelReads.read("models", sharedSignal => request<ModelInventory>("models", { connection }, sharedSignal), signal, refresh,
      found => !(found.warning && !found.models.length));
  },
  skills: (target: OptimizationTarget, refresh = false, signal?: AbortSignal) => {
    connectionForRead();
    const copiedTarget = structuredClone(target);
    const key = JSON.stringify([settingsSnapshot?.skillDirectory ?? null, copiedTarget]);
    return skillReads.read(key, sharedSignal => request<SkillStatus>("skills", { target: copiedTarget, refresh }, sharedSignal), signal, refresh, status => !status.error);
  },
  optimize: async (context: OptimizationContext, textOnly = false, signal?: AbortSignal, route?: OptimizationRoute) => {
    const provider = route?.computeProvider ?? useStore.getState().computeProvider;
    const { baseUrl, token, authHeader, authPrefix } = route?.connection ?? useStore.getState().connection;
    if (provider !== "comfyui") await syncNativeServiceAuth("deepseek", signal);
    return request<OptimizationResult>("optimize", provider === "comfyui"
      ? { context, textOnly, connection: { baseUrl, token, authHeader, authPrefix } }
      : { context, textOnly: true, engine: "deepseek-web" }, signal);
  },
};
function currentConnection() {
  const { baseUrl, token, authHeader, authPrefix } = useStore.getState().connection;
  return { baseUrl, token, authHeader, authPrefix };
}
