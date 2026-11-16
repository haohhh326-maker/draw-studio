import type { Connection, GenerationTask, Project } from "../types";
import { normalizeRunningHubNativeConnection } from "../runninghub/native-connection";

type TaskConnection = GenerationTask["connection"];
const invalidSnapshot = () => new Error("任务连接地址无效，无法安全保存或导出。请修正连接记录后重试。");

/** Also recognize malformed/encoded legacy proxy addresses so they cannot pass through as ordinary cloud URLs. */
function nativeAddressCandidate(baseUrl: string): boolean {
  let decoded = baseUrl;
  for (let pass = 0; pass < 4; pass++) {
    try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; }
    catch { break; }
  }
  if (!/[\/\\]proxy(?:-plus)?(?:[\/\\?#]|$)/i.test(decoded)) return false;
  try { return /^(?:www\.)?runninghub\.(?:cn|ai)\.?$/i.test(new URL(baseUrl).hostname); }
  catch { return /(?:^|[/:])(?:www\.)?runninghub\.(?:cn|ai)(?=[/:?#\\]|$)/i.test(decoded); }
}

/** Only connection metadata crosses into a task receipt; saved account credentials never do. */
export function taskConnectionSnapshot(connection: TaskConnection | Connection): TaskConnection {
  if (!connection || typeof connection !== "object" || Array.isArray(connection) || typeof connection.baseUrl !== "string") throw invalidSnapshot();
  let snapshot: TaskConnection = {
    name: connection.name,
    baseUrl: connection.baseUrl,
    authHeader: connection.authHeader,
    authPrefix: connection.authPrefix,
    timeoutMinutes: connection.timeoutMinutes,
  };
  if (nativeAddressCandidate(snapshot.baseUrl)) {
    try {
      // An old snapshot may contain two different leaked keys. Neither is
      // needed to retain the endpoint, so discard the standalone token first.
      const normalized = normalizeRunningHubNativeConnection({ ...snapshot, token: "" });
      snapshot = { ...snapshot, baseUrl: normalized.baseUrl, authHeader: normalized.authHeader, authPrefix: normalized.authPrefix };
    } catch { throw invalidSnapshot(); }
  }
  return snapshot;
}

/** Export copies only receipt connections, leaving task status, workflow inputs and the live project untouched. */
export function projectWithSafeConnectionSnapshots(project: Project): Project {
  return { ...project, tasks: Object.fromEntries(Object.entries(project.tasks ?? {}).map(([id, task]) =>
    [id, { ...task, connection: taskConnectionSnapshot(task.connection) }])) };
}
