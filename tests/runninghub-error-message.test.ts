import { expect, it } from "vitest";
import { isRunningHubBalanceError, readableRunningHubError } from "../src/runninghub/error-message";

it("explains a persisted RunningHub insufficient-balance rejection without altering its record", () => {
  const stored = "RunningHub 提交 AI 应用失败（605）：NOT_ENOUGH_BALANCE";
  const displayed = readableRunningHubError(stored);
  expect(displayed).toContain("账户余额不足（605）");
  expect(displayed).toContain("RH 币");
  expect(displayed).toContain("钱包");
  expect(displayed).toContain("运行密钥");
  expect(isRunningHubBalanceError(stored)).toBe(true);
  expect(isRunningHubBalanceError(displayed)).toBe(true);
  expect(stored).toContain("NOT_ENOUGH_BALANCE");
  expect(readableRunningHubError(displayed)).toBe(displayed);
});

it("explains the known upstream enum without inventing a numeric code", () => {
  const displayed = readableRunningHubError("RunningHub 提交 AI 应用失败：NOT_ENOUGH_BALANCE");
  expect(displayed).toContain("账户余额不足");
  expect(displayed).not.toContain("605");
  expect(isRunningHubBalanceError(displayed)).toBe(true);
  expect(readableRunningHubError(displayed)).toBe(displayed);
});

it("preserves a workflow read rejection with a retry message", () => {
  const stored = "RunningHub 读取工作流失败（810）：WORKFLOW_NOT_SAVED_OR_NOT_RUNNING";
  const displayed = readableRunningHubError(stored);
  expect(displayed).toContain(stored);
  expect(displayed).toContain("云端工作流的执行结构");
  expect(displayed).toContain("重新读取");
  expect(displayed).not.toContain("手动保存并运行");
  expect(readableRunningHubError(displayed)).toBe(displayed);
  expect(isRunningHubBalanceError(displayed)).toBe(false);
});

it("explains the bare workflow export error returned by the original client", () => {
  const displayed = readableRunningHubError("WORKFLOW_NOT_SAVED_OR_NOT_RUNNING");
  expect(displayed).toContain("RunningHub 云端工作流");
  expect(readableRunningHubError(displayed)).toBe(displayed);
});

it.each(["其他服务（605）：NOT_ENOUGH_BALANCE", "RunningHub 原始错误代码 1605", "其他服务（810）：WORKFLOW_NOT_SAVED_OR_NOT_RUNNING", "RunningHub 原始错误代码 1810", "CUDA out of memory"])("preserves unrelated failures: %s", message => {
  expect(readableRunningHubError(message)).toBe(message);
  expect(isRunningHubBalanceError(message)).toBe(false);
});
