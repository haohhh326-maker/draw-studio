import { afterEach, expect, it, vi } from "vitest";
import { deleteWorkflowLibraryWorkflow } from "../src/workflow/import-client";
import type { WorkflowDefinition } from "../src/types";
const workflow = { id: "alias", name: "Qwen", original: { id: "vendor.qwen", configSha256: "a".repeat(64) }, library: { folder: "Qwen-Image", sourcePath: "private/local/path" } } as WorkflowDefinition;
afterEach(() => vi.unstubAllGlobals());
it("sends only folder and snapshot identity, never the client-provided root or alias ID", async () => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ workflowId: "vendor.qwen", folder: "Qwen-Image", deleted: true })));
  vi.stubGlobal("fetch", fetcher); await deleteWorkflowLibraryWorkflow(workflow);
  expect(fetcher.mock.calls[0][0]).toBe("/__canvas/workflow-library/delete");
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ workflowId: "vendor.qwen", folder: "Qwen-Image", configSha256: "a".repeat(64) });
});
it("reports stale snapshot errors and rejects mismatched deletion results", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "工作流文件已经变化" }), { status: 409 })));
  await expect(deleteWorkflowLibraryWorkflow(workflow)).rejects.toThrow("工作流文件已经变化");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ workflowId: "wrong", folder: "Qwen-Image", deleted: true }))));
  await expect(deleteWorkflowLibraryWorkflow(workflow)).rejects.toThrow("匹配");
});
it("refuses entries without a directory snapshot before sending a deletion request", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(deleteWorkflowLibraryWorkflow({ ...workflow, original: undefined })).rejects.toThrow("没有可删除");
  expect(fetcher).not.toHaveBeenCalled();
});
