import { afterEach, expect, it, vi } from "vitest";
import { cancelMuseJob, MuseApiError, uploadMuseReference } from "../src/muse/client";

afterEach(() => vi.unstubAllGlobals());

it("uploads the original Blob directly and safely encodes the filename header", async () => {
  const fetcher = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({
    uploadId: "upload-1", name: "参考 视频.mp4", mime: "video/mp4",
  }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
  const blob = new Blob(["original bytes"], { type: "video/mp4" }), signal = new AbortController().signal;
  const read = vi.spyOn(blob, "arrayBuffer");
  expect(await uploadMuseReference("task-123456", blob, "参考 视频.mp4", signal)).toMatchObject({ uploadId: "upload-1" });
  expect(read).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[0]).toEqual(["/api/muse/jobs/task-123456/references", expect.objectContaining({
    method: "POST", body: blob, signal, headers: { "Content-Type": "video/mp4", "X-Muse-Name": encodeURIComponent("参考 视频.mp4") },
  })]);
});

it("stops a job through one job-scoped POST and returns the server cancellation state", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({
    id: "task-123456", status: "cancelled", message: "已停止本机队列任务",
  }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  expect(await cancelMuseJob("task-123456", signal)).toEqual({
    id: "task-123456", status: "cancelled", message: "已停止本机队列任务",
  });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/muse/jobs/task-123456/cancel", expect.objectContaining({
    method: "POST", body: "{}", signal, credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" },
  }));
});

it("does not retry or claim cancellation when the local service rejects stopping", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: "未能停止本机队列任务" }), {
    status: 503, headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetcher);
  await expect(cancelMuseJob("task-123456")).rejects.toMatchObject({ name: "MuseApiError", status: 503, message: "未能停止本机队列任务" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not treat an HTML fallback page as confirmation that a job stopped", async () => {
  const fetcher = vi.fn(async () => new Response("<html>App</html>", { headers: { "content-type": "text/html" } }));
  vi.stubGlobal("fetch", fetcher);
  await expect(cancelMuseJob("task-123456")).rejects.toBeInstanceOf(MuseApiError);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
