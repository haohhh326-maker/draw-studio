import { afterEach, expect, it, vi } from "vitest";
import { readWorkflowImportSource, saveWorkflowImport, WorkflowImportConflict } from "../src/workflow/import-client";
const saved = { folder: "Custom-0123456789abcdef", path: "/library/Custom-0123456789abcdef", workflowId: "custom.0123456789abcdef", updated: false, reused: true };
const request = { filename: "test.json", source: {}, graph: {}, config: {}, requirements: {}, reuseExisting: true };
afterEach(() => vi.unstubAllGlobals());

it("sends a single source with idempotent mode and returns an existing valid package", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(saved))); vi.stubGlobal("fetch", fetcher);
  expect(await saveWorkflowImport(request)).toEqual(saved);
  const init = fetcher.mock.calls[0][1] as RequestInit;
  expect(JSON.parse(init.body as string)).toEqual(request);
});

it("preserves the specific server error when an existing import package is broken", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "导入包缺少有效的执行文件，已保留目录。", existing: saved }), { status: 409 })));
  await expect(saveWorkflowImport(request)).rejects.toThrow("缺少有效的执行文件");
  try { await saveWorkflowImport(request); } catch (error) { expect(error).toBeInstanceOf(WorkflowImportConflict); }
});

it("combines dialog cancellation with the save timeout", async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
    throw new DOMException("Cancelled", "AbortError");
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(saveWorkflowImport(request, controller.signal)).rejects.toThrow("Cancelled");
});

it("reads a managed workflow's source by stable ID without sending a file path", async () => {
  const source = { source: { nodes: [{ id: 1, type: "OwnNode", widgets_values: [4] }], links: [] }, filename: "author.json", config: { id: saved.workflowId, nameLabel: "Keep this title", primaryCategoryLabel: "Keep this family" } };
  const fetcher = vi.fn(async (_url: unknown, _init: RequestInit) => new Response(JSON.stringify(source))); vi.stubGlobal("fetch", fetcher);
  expect(await readWorkflowImportSource(saved.workflowId)).toEqual(source);
  expect(String(fetcher.mock.calls[0][0])).toContain("/__canvas/workflow-library/source");
  const init = fetcher.mock.calls[0][1];
  expect(init.method).toBe("POST"); expect(JSON.parse(init.body as string)).toEqual({ workflowId: saved.workflowId });
});

it("rejects escaped source IDs and mismatched or malformed source responses", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(readWorkflowImportSource("../../outside")).rejects.toThrow("ID");
  expect(fetcher).not.toHaveBeenCalled();
  for (const result of [null, {}, { source: {}, filename: "author.json", config: { id: "custom.aaaaaaaaaaaaaaaa" } }]) {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(result)));
    await expect(readWorkflowImportSource(saved.workflowId)).rejects.toThrow("匹配");
  }
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: "原始文件与导入记录不一致" }), { status: 409 }));
  await expect(readWorkflowImportSource(saved.workflowId)).rejects.toThrow("导入记录不一致");
});

it("keeps source reads cancellable while the automatic import flow is dismissed", async () => {
  const controller = new AbortController();
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    controller.abort(); expect(init.signal?.aborted).toBe(true); throw new DOMException("Cancelled", "AbortError");
  }));
  await expect(readWorkflowImportSource(saved.workflowId, controller.signal)).rejects.toThrow("Cancelled");
});
