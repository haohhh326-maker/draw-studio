import { expect, it } from "vitest";
import { MissingWorkflowNodeDefinitionError } from "../src/workflow/import-editor";
import { describeWorkflowImportError } from "../src/workflow/import-errors";

const missing = () => new MissingWorkflowNodeDefinitionError("134", "TESpeedMiniMaxH3");

it("explains a confirmed missing remote node without requesting a second workflow or model", () => {
  const message = describeWorkflowImportError(missing(), { connectedAddress: true, info: { OtherNode: {} }, warnings: [] });
  expect(message).toContain("当前 ComfyUI 返回的节点定义中没有 TESpeedMiniMaxH3");
  expect(message).toContain("对应插件");
  expect(message).toContain("不需要补交另一份");
  expect(message).not.toContain("下载模型");
});

it("never claims that a failed request or stale cache proves the current plugin is absent", () => {
  const offline = describeWorkflowImportError(missing(), { connectedAddress: true, warnings: ["网络请求失败"] });
  expect(offline).toContain("未能读取");
  expect(offline).toContain("还不能判断");
  const cached = describeWorkflowImportError(missing(), { connectedAddress: true, info: { OtherNode: {} }, warnings: ["已使用此前读取的节点定义"] });
  expect(cached).toContain("此前缓存");
  expect(cached).not.toContain("当前 ComfyUI 返回");
});

it("distinguishes no engine configuration and incomplete existing definitions", () => {
  expect(describeWorkflowImportError(missing(), { connectedAddress: false, warnings: [] })).toContain("请先配置");
  const malformed = describeWorkflowImportError(missing(), { connectedAddress: true, info: { TESpeedMiniMaxH3: {} }, warnings: [] });
  expect(malformed).toContain("参数定义不完整");
  expect(malformed).not.toContain("中没有");
});

it("preserves other failures and explains malformed JSON", () => {
  const context = { connectedAddress: false, warnings: [] };
  expect(describeWorkflowImportError(new Error("目录不可写"), context)).toBe("目录不可写");
  expect(describeWorkflowImportError(new SyntaxError("invalid"), context)).toContain("有效 JSON");
});
