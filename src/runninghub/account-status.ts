import type { RunningHubAccountStatus } from "./client";

/** Independent balances describe the account; neither one is a generation gate. */
export function runningHubAccountSummary(status: RunningHubAccountStatus): string {
  const parts: string[] = [];
  if (status.remainCoins !== undefined) parts.push("RH 币：" + status.remainCoins);
  if (status.remainMoney !== undefined) parts.push("钱包：" + status.remainMoney + (status.currency ? " " + status.currency : ""));
  if (status.apiType) {
    const types: Record<string, string> = { NORMAL: "消费级会员", SHARED: "企业级共享", EXCLUSIVE: "企业级独占" };
    parts.push("接口返回类型：" + (types[status.apiType] ? `${types[status.apiType]}（${status.apiType}）` : status.apiType));
  }
  return parts.length ? " · " + parts.join(" · ") : "";
}
