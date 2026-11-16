import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunningHubAiApp } from "../src/runninghub/client";
import type { WorkflowDefinition } from "../src/types";

const saved = vi.hoisted(() => ({ workflows: [] as WorkflowDefinition[] }));
vi.mock("../src/stores/store", async importOriginal => {
  const original = await importOriginal<typeof import("../src/stores/store")>();
  const useStore = Object.assign((selector: (state: ReturnType<typeof original.useStore.getState>) => unknown) => selector({
    ...original.useStore.getInitialState(), runningHubWorkflows: saved.workflows,
  }), original.useStore);
  return { ...original, useStore };
});

import { readRunningHubAiAppReference, RunningHubAiAppManager, RunningHubWorkflowEditor } from "../src/runninghub/RunningHubWorkflowDialog";
import { RunningHubClient } from "../src/runninghub/client";

const site = "https://www.runninghub.cn", id = "2092444522851684354";
const app = { apiVersion: "v1", nodeInfoList: [] } as RunningHubAiApp;
const legacy = (kind: "workflow" | "app" | undefined): WorkflowDefinition => ({
  id: "saved-workflow", name: "Saved workflow", family: "Legacy", mode: "text-to-image", requiredInputs: [], parameters: [], mapping: [],
  template: { "2": { class_type: "SaveImage", inputs: {} } }, output: { nodeId: "2", field: "images", kind: "image" },
  runninghub: { workflowId: id, baseUrl: site, ...(kind ? { kind } : {}) },
});
afterEach(() => { saved.workflows = []; vi.restoreAllMocks(); });

describe("AI-app-only RunningHub imports", () => {
  it.each([id, `${site}/ai-detail/${id}`, `${site}/webapp/${id}`, `${site}/webapp?webappId=${id}`, `${site}/zh/ai-detail/${id}`, `${site}/call-api/api-detail/${id}?apiType=4`])("reads %s directly as an app with no workflow probe", async reference => {
    const getAiApp = vi.fn(async () => app), getWorkflow = vi.fn(), controller = new AbortController();
    const client = { getAiApp, getWorkflow };
    const result = await readRunningHubAiAppReference(client, reference, site, controller.signal);
    expect(result.reference.id).toBe(id); expect(result.app).toBe(app);
    expect(getAiApp).toHaveBeenCalledExactlyOnceWith(id, controller.signal); expect(getWorkflow).not.toHaveBeenCalled();
  });

  it("retains an explicit v2 app link for the editor's API-version choice", async () => {
    const getAiApp = vi.fn(async () => app);
    const result = await readRunningHubAiAppReference({ getAiApp }, `${site}/openapi/v2/run/ai-app/${id}`, site);
    expect(result.reference).toEqual({ id, kind: "app", apiVersion: "v2" });
    expect(getAiApp).toHaveBeenCalledOnce();
  });

  it.each([`${site}/workflow/${id}`, `${site}/post/${id}`, `${site}/workflow?workflowId=${id}`, `${site}/en/workflow/${id}`, `${site}/openapi/v2/run/workflow/${id}`])("rejects native workflow link %s before making any read request", async reference => {
    const client = { getAiApp: vi.fn(), getWorkflow: vi.fn(), getWorkflowMetadata: vi.fn() };
    await expect(readRunningHubAiAppReference(client, reference, site)).rejects.toThrow("RunningHub 工作流");
    for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled();
  });

  it.each([new Error("404 app not found"), new Error("authorization denied"), new Error("connection failed")])("never falls back to a workflow when app reading fails: %s", async reason => {
    const getAiApp = vi.fn(async () => { throw reason; }), getWorkflow = vi.fn();
    const client = { getAiApp, getWorkflow };
    await expect(readRunningHubAiAppReference(client, id, site)).rejects.toBe(reason);
    expect(getAiApp).toHaveBeenCalledOnce(); expect(getWorkflow).not.toHaveBeenCalled();
  });

  it("keeps site validation ahead of the app request and labels malformed input as an AI app", async () => {
    const getAiApp = vi.fn();
    await expect(readRunningHubAiAppReference({ getAiApp }, `https://www.runninghub.ai/ai-detail/${id}`, site)).rejects.toThrow("站点不同");
    await expect(readRunningHubAiAppReference({ getAiApp }, "not an app", site)).rejects.toThrow("AI 应用 ID");
    expect(getAiApp).not.toHaveBeenCalled();
  });
});

describe("RunningHub AI-app management and legacy preservation", () => {
  it("shows only the app importer without type selection or API JSON import", () => {
    const html = renderToStaticMarkup(createElement(RunningHubWorkflowEditor));
    expect(html).toContain("读取并添加 AI 应用"); expect(html).toContain("RunningHub AI 应用 ID 或分享链接");
    expect(html).not.toMatch(/读取类型|自动识别<\/option>|API JSON|type="file"|工作流 \/ 应用 ID/);
  });

  it("opens account settings, a direct app importer and the app library together", () => {
    const html = renderToStaticMarkup(createElement(RunningHubAiAppManager));
    expect(html).toContain("连接 RunningHub 账号"); expect(html).toContain("读取并添加 AI 应用"); expect(html).toContain("已添加的 AI 应用");
    expect(html).not.toContain('role="dialog"');
  });

  it.each(["workflow", undefined] as const)("renders a saved legacy kind %s as read-only without converting, deleting or fetching it", kind => {
    const entry = legacy(kind), before = structuredClone(entry); saved.workflows = [entry];
    const getWorkflow = vi.spyOn(RunningHubClient.prototype, "getWorkflow");
    const getAiApp = vi.spyOn(RunningHubClient.prototype, "getAiApp");
    const html = renderToStaticMarkup(createElement(RunningHubWorkflowEditor, { initialId: entry.id, refreshOnOpen: true }));
    expect(html).toContain("历史工作流（只读）"); expect(html).toContain("不会转换为 AI 应用");
    expect(html).not.toMatch(/<input|<form|<button|保存 AI 应用/);
    expect(saved.workflows).toEqual([before]); expect(getWorkflow).not.toHaveBeenCalled(); expect(getAiApp).not.toHaveBeenCalled();
  });

  it("keeps existing app editing on the app form", () => {
    saved.workflows = [legacy("app")];
    const html = renderToStaticMarkup(createElement(RunningHubWorkflowEditor, { initialId: saved.workflows[0].id }));
    expect(html).toContain("RunningHub AI 应用 ID 或分享链接"); expect(html).not.toContain("历史工作流（只读）");
    expect(saved.workflows[0].runninghub?.kind).toBe("app");
  });
});
