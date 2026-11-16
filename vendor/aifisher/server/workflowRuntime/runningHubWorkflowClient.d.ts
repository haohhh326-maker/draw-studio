// Application boundary types; the adjacent complete upstream JavaScript is unchanged.
export class RunningHubWorkflowClientError extends Error { code: string; status: number; retryable: boolean }
export function normalizeRunningHubBaseUrl(value: unknown): string;
export function assertRunningHubRemoteId(value: unknown, label?: string): string;
export const RUNNINGHUB_WEBAPP_PROTOCOLS: { legacy: string; aiAppV2: string };
export class RunningHubWorkflowClient {
  constructor(options: Record<string, any>);
  baseUrl: string;
  apiKey: string;
  fetchWithTimeout(url: string | URL, init?: RequestInit, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Response>;
  getWorkflowApiFormat(id: string, options?: { signal?: AbortSignal }): Promise<Record<string, any>>;
  getWebAppInfoForProtocol(id: string, protocol: string, options?: { signal?: AbortSignal }): Promise<Record<string, any>>;
  resolveWebAppInfo(id: string, options?: { signal?: AbortSignal }): Promise<{ apiProtocol: string; info: Record<string, any> }>;
  getWebAppCover(id: string): Promise<string | null>;
}
