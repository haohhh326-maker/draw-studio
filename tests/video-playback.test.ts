import { afterEach, expect, it, vi } from "vitest";
import type { Asset } from "../src/types";
const blobs = vi.hoisted(() => new Map<string, Blob>());
vi.mock("../src/projects/storage", () => ({ getBlob: async (id: string) => { const blob = blobs.get(id); if (!blob) throw new Error("missing"); return blob; }, putBlob: async (id: string, blob: Blob) => { blobs.set(id, blob); } }));
import { compatibleVideo } from "../src/assets/video-playback";
afterEach(() => { blobs.clear(); vi.unstubAllGlobals(); });
const asset: Asset = { id: "video", name: "original.mp4", kind: "video", mime: "video/mp4", size: 8, createdAt: 0 };
it("keeps the original, deduplicates concurrent compatibility requests and reuses the persistent copy", async () => {
  const original = new Blob(["original"], { type: "video/mp4" }); blobs.set(asset.id, original);
  const fetcher = vi.fn(async () => new Response(new Blob(["converted"]), { headers: { "Content-Type": "video/mp4" } })); vi.stubGlobal("fetch", fetcher);
  const [a, b] = await Promise.all([compatibleVideo(asset), compatibleVideo(asset)]);
  expect(fetcher).toHaveBeenCalledTimes(1); expect(a).toBe(b); expect(await a.text()).toBe("converted");
  expect(blobs.get(asset.id)).toBe(original); expect(await compatibleVideo(asset)).toBe(a);
  expect(fetcher.mock.calls[0]).toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("does not cache error pages or corrupt the source and permits a later retry", async () => {
  const original = new Blob(["original"]); blobs.set(asset.id, original);
  const fetcher = vi.fn(async () => new Response("<html>not a video</html>", { headers: { "Content-Type": "text/html" } })); vi.stubGlobal("fetch", fetcher);
  await expect(compatibleVideo(asset)).rejects.toThrow("不可用");
  await expect(compatibleVideo(asset)).rejects.toThrow("不可用");
  expect(fetcher).toHaveBeenCalledTimes(2); expect(blobs.size).toBe(1); expect(blobs.get(asset.id)).toBe(original);
});
