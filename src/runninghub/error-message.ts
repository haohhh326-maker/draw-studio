export function isRunningHubBalanceError(message: string): boolean {
  return /RunningHub/i.test(message) && /\bNOT_ENOUGH_BALANCE\b|[（(]\s*605\s*[）)]|RunningHub\s+(?:返回|提示)账户余额不足/i.test(message);
}

/** Keep raw diagnostics separately; the rejection does not identify the deficient balance. */
export function readableRunningHubError(message: string): string {
  if ((/RunningHub/i.test(message) || /^WORKFLOW_NOT_SAVED_OR_NOT_RUNNING$/i.test(message))
    && /\bWORKFLOW_NOT_SAVED_OR_NOT_RUNNING\b|[（(]\s*810\s*[）)]/i.test(message)) {
    const guidance = "未能取得这份 RunningHub 云端工作流的执行结构，请重新读取。";
    return message.includes(guidance) ? message : `${message}\n${guidance}`;
  }
  if (!isRunningHubBalanceError(message)) return message;
  const code = /[（(]\s*605\s*[）)]/.test(message) ? "（605）" : "";
  return `RunningHub 提示账户余额不足${code}。RH 币与钱包分开计费，请核对运行密钥的类型。`;
}
