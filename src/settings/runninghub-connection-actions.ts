import { RunningHubClient } from "../runninghub/client";
import { runningHubAccountSummary } from "../runninghub/account-status";
import { useStore } from "../stores/store";
import type { Connection } from "../types";

export const runningHubConnectionIdentity = (connection: Connection) => JSON.stringify([
  connection.baseUrl, connection.token, connection.authHeader, connection.authPrefix,
]);

let revision = 0;
let pending: AbortController | undefined;

/** Explicit checks share cancellation across settings and the compute switcher. */
export async function checkRunningHubConnection(connection: Connection): Promise<string | undefined> {
  const current = ++revision;
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  const expected = runningHubConnectionIdentity(connection);
  const isActive = () => expected === runningHubConnectionIdentity(useStore.getState().runningHubConnection);
  const stillCurrent = () => current === revision && isActive();
  const stillSaved = () => current === revision && (isActive()
    || Object.values(useStore.getState().runningHubConnections).some(profile => expected === runningHubConnectionIdentity(profile)));
  if (stillCurrent()) useStore.setState({ runningHubConnectionState: "connecting", runningHubConnectionInfo: "正在检测 RunningHub…" });
  try {
    if (!connection.token.trim()) throw new Error("请先在算力设置中填写本站 RunningHub API Key。");
    const account = await new RunningHubClient(connection).validateKey(controller.signal);
    const summary = runningHubAccountSummary(account);
    if (stillCurrent()) useStore.setState({ runningHubConnectionState: "connected", runningHubConnectionInfo: "RunningHub API Key 检测通过。" + summary });
    return stillSaved() ? "API Key 验证通过。" + summary : undefined;
  } catch (reason) {
    let message = reason instanceof Error ? reason.message : "请检查服务地址和 API Key。";
    if (connection.token) message = message.replaceAll(connection.token, "[已隐藏]");
    const result = "连接失败：" + message.slice(0, 800);
    if (stillCurrent()) useStore.setState({ runningHubConnectionState: "offline", runningHubConnectionInfo: result });
    return stillSaved() ? result : undefined;
  } finally {
    if (current === revision) pending = undefined;
  }
}
