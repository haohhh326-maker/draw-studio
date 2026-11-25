import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NodeExecutionView } from "../src/nodes/NodeExecutionView";
import type { TaskState } from "../src/types";

const render = (task: TaskState) => renderToStaticMarkup(createElement(NodeExecutionView, { task }));

describe("canvas node execution feedback", () => {
  it("fills water from reported progress, keeps unknown progress indeterminate and fills completely while saving", () => {
    expect(render({status:"generating",execution:{value:3,max:12}})).toContain('--water-level:25%');
    expect(render({status:"generating",progress:62})).toContain('--water-level:62%');
    expect(render({status:"generating"})).toContain('is-indeterminate');
    expect(render({status:"generating"})).toContain('等待平台进度');
    expect(render({status:"saving",execution:{value:3,max:12}})).toContain('--water-level:100%');
    expect(render({status:"saving"})).toContain('生成 100%');
  });
  it("hides legacy local abort and internal recovery markers while keeping server failures", () => {
    const cancelled = render({ status: "cancelled", error: "Aborted", details: "AbortError: Aborted" });
    expect(cancelled).toContain("已取消");
    expect(cancelled).not.toContain("Aborted");
    expect(render({ status: "failed", error: "disk full", details: "not-submitted" })).not.toContain("not-submitted");
    expect(render({ status: "generating", details: "实时通道暂不可用" })).toContain("任务详情");
  });
  it("shows the executing ComfyUI node and its exact step values", () => {
    const html = render({ status: "generating", execution: {
      nodeId: "92", nodeTitle: "视频采样", nodeType: "KSampler", value: 3, max: 12,
    } });
    expect(html).toContain("视频采样");
    expect(html).toContain("#92 · KSampler");
    expect(html).toContain('value="3" max="12"');
    expect(html).toContain("3 / 12 · 25%");
    expect(html).toContain("node-water");
  });
  it("does not invent a percentage while queueing or loading a model", () => {
    const html = render({ status: "queued", progress: 75, execution: { queueRemaining: 2 } });
    expect(html).toContain("排队中");
    expect(html).toContain("队列剩余 2");
    expect(html).not.toContain("<progress");
    expect(html).not.toContain("75%");
  });
  it("shows AutoDL startup verification on the card while the generation is waiting", () => {
    const details = "正在核对 AutoDL 开机状态，等待平台更新。";
    const html = render({ status: "uploading", details });
    expect(html).toContain('role="status"');
    expect(html).toContain("核对 AutoDL 开机状态</strong>");
    expect(html).toContain(details);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("生成失败");
  });
  it("keeps zero progress valid and ignores invalid maxima", () => {
    expect(render({ status: "generating", execution: { value: 0, max: 20 } })).toContain("0 / 20 · 0%");
    expect(render({ status: "generating", execution: { value: 2, max: 0 } })).not.toContain("<progress");
    expect(render({ status: "generating", execution: { value: NaN, max: 10 } })).not.toContain("<progress");
  });
  it("renders the actual failure and expandable traceback as escaped text", () => {
    const html = render({ status: "failed", error: "CUDA out of memory", details: "Traceback:\n<unsafe>" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("CUDA out of memory");
    expect(html).toContain("<details");
    expect(html).toContain("Traceback:\n&lt;unsafe&gt;");
    expect(html).not.toContain("node-water");
  });
  it.each(["cancelled", "interrupted"] as const)("does not label %s as a system failure", (status) => {
    const html = render({ status, error: "任务已停止" });
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("生成失败");
    expect(html).not.toContain("node-water");
  });
  it("counts cached and executed node IDs without double counting", () => {
    const html = render({ status: "generating", execution: { cachedNodes: ["1", "2"], completedNodes: ["2", "3"] } });
    expect(html).toContain("已执行 / 缓存 3 个节点");
  });
});
