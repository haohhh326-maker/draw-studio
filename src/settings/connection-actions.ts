import { ComfyUIClient, friendlyError } from "../comfyui/client";
import { useStore } from "../stores/store";
import type { Connection } from "../types";
import { isRunningHubNativeConnection, normalizeRunningHubNativeConnection, validateNativeRunningHubAccount, type NativeRunningHubAccountStatus } from "../runninghub/native-connection";

let revision = 0;
let pending: AbortController | undefined;
const engineIdentity = (value: Connection) => JSON.stringify([value.baseUrl, value.token, value.authHeader, value.authPrefix]);

export function cancelWorkstationCheck() {
  pending?.abort();
}

export function nativeAccountSummary(account: NativeRunningHubAccountStatus): string {
  return ["NORMAL（RH 币 / 钱包）已确认", account.remainCoins !== undefined ? "RH 币余额 " + account.remainCoins : "",
    account.remainMoney !== undefined ? "钱包余额 " + account.remainMoney + (account.currency ? " " + account.currency : "") : ""].filter(Boolean).join(" · ");
}

/** Connection checks may finish after their popover closes; newer addresses always win. */
export async function connectWorkstation(connection: Connection): Promise<void> {
  const current = ++revision;
  pending?.abort();
  const controller = new AbortController(); pending = controller;
  const native = isRunningHubNativeConnection(connection);
  try { if (native) connection = normalizeRunningHubNativeConnection(connection); }
  catch {
    useStore.setState({ connectionState: "offline", connectionInfo: "连接失败：RunningHub 原生地址或 Key 无效，请在算力设置中重新填写。" });
    if (current === revision) pending = undefined;
    return;
  }
  const client = new ComfyUIClient(connection);
  const disconnect = () => client.disconnect();
  controller.signal.addEventListener("abort", disconnect, { once: true });
  const stillCurrent = () => current === revision && engineIdentity(useStore.getState().connection) === engineIdentity(connection);
  useStore.setState({ connection: { ...connection }, connectionState: "connecting", connectionInfo: "正在连接…" });
  const unsubscribe = useStore.subscribe?.(() => { if (!stillCurrent()) controller.abort(); });
  try {
    const account = native ? await validateNativeRunningHubAccount(connection, controller.signal) : undefined;
    controller.signal.throwIfAborted();
    const [stats, queue] = await Promise.all([
      client.request("/system_stats", { signal: controller.signal }, native ? null : 8000).then(response => response.json()) as Promise<{ system?: { comfyui_version?: string } }>,
      client.request("/queue", { signal: controller.signal }, native ? null : 8000).then(response => response.json()) as Promise<{ queue_pending?: unknown[]; queue_running?: unknown[] }>,
    ]);
    if (!stillCurrent()) return;
    if (!stats || typeof stats !== "object" || !Array.isArray(queue?.queue_pending) || !Array.isArray(queue?.queue_running)) throw new Error("服务没有返回有效的 ComfyUI 状态和队列。");
    let progress = "支持实时进度";
    try { await client.connect(controller.signal); } catch { controller.signal.throwIfAborted(); progress = "HTTP 已连接，使用查询进度"; }
    if (!stillCurrent()) return;
    useStore.setState({ connectionState: "connected", connectionInfo: (account ? nativeAccountSummary(account) + " · " : "") + progress + " · " + (stats.system?.comfyui_version ?? "版本未知") + " · 排队 " + queue.queue_pending.length });
  } catch (reason) {
    if (stillCurrent()) useStore.setState({ connectionState: "offline", connectionInfo: controller.signal.aborted ? "连接检测已取消。" : "连接失败：" + friendlyError(reason).error });
  } finally {
    unsubscribe?.();
    controller.signal.removeEventListener("abort", disconnect);
    client.disconnect();
    if (current === revision) pending = undefined;
  }
}
