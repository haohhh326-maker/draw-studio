import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "../src/types";

const storage = vi.hoisted(() => ({ blobs: new Map<string, Blob>() }));
vi.mock("../src/projects/storage", () => ({
  getBlob: vi.fn(async (id: string) => {
    const blob = storage.blobs.get(id);
    if (!blob) throw new Error("Missing local blob");
    return blob;
  }),
  putBlob: vi.fn(async (id: string, blob: Blob) => { storage.blobs.set(id, blob); }),
}));
import { acquireAssetUrl, acquireVideoPosterUrl, rememberVideoPoster, setCanvasAssetInteraction } from "../src/assets/assets";
import { getBlob } from "../src/projects/storage";

const image = (id: string): Asset => ({ id, name: id + ".png", kind: "image", mime: "image/png", size: 10, createdAt: 1, width: 4096, height: 2048 });
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => {
  setCanvasAssetInteraction(false);
  storage.blobs.clear();
  vi.clearAllMocks();
  vi.spyOn(URL, "createObjectURL").mockImplementation(blob => "blob:" + blob.type + ":" + crypto.randomUUID());
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal("document", {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn(), clearRect: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }) }),
      toBlob: (done: (blob: Blob) => void) => done(new Blob(["preview"], { type: "image/webp" })) }),
  });
});
afterEach(() => { setCanvasAssetInteraction(false); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("canvas thumbnail workload", () => {
  it("defers missing previews during interaction while cached previews and explicit originals stay available", async () => {
    const assets = Array.from({ length: 6 }, (_, index) => image("interaction-preview-" + index));
    for (const asset of assets) storage.blobs.set(asset.id, new Blob([asset.id], { type: "image/png" }));
    const cached = image("interaction-cached"), full = image("interaction-full");
    storage.blobs.set("thumb-" + cached.id, new Blob(["preview"], { type: "image/webp" }));
    storage.blobs.set(full.id, new Blob(["original"], { type: "image/png" }));
    const decode = vi.fn(async (_blob: Blob, options: ImageBitmapOptions) => ({ width: options.resizeWidth, height: options.resizeHeight, close: vi.fn() }));
    vi.stubGlobal("createImageBitmap", decode);
    setCanvasAssetInteraction(true);
    setCanvasAssetInteraction(true);
    const pending = Promise.all(assets.map(asset => acquireAssetUrl(asset)));
    await nextTurn();
    expect(vi.mocked(getBlob).mock.calls.filter(([id]) => assets.some(asset => asset.id === id))).toHaveLength(0);
    expect(decode).not.toHaveBeenCalled();
    const available = await Promise.all([acquireAssetUrl(cached), acquireAssetUrl(full, true)]);
    expect(available[0].url).toContain("image/webp");
    expect(available[1].url).toContain("image/png");
    setCanvasAssetInteraction(false);
    setCanvasAssetInteraction(false);
    const previews = await pending;
    expect(decode).toHaveBeenCalledTimes(6);
    [...available, ...previews].forEach(item => item.release());
  });

  it("rechecks interaction after original reads and decoding before drawing the thumbnail", async () => {
    const asset = image("interaction-between-stages");
    storage.blobs.set(asset.id, new Blob(["original"], { type: "image/png" }));
    let read!: () => void, decoded!: () => void;
    const originalRead = async (id: string) => {
      const blob = storage.blobs.get(id);
      if (!blob) throw new Error("Missing local blob");
      return blob;
    };
    vi.mocked(getBlob).mockImplementation(async id => {
      if (id === asset.id) await new Promise<void>(resolve => { read = resolve; });
      return originalRead(id);
    });
    const draw = vi.fn();
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: draw }),
      toBlob: (done: BlobCallback) => done(new Blob(["preview"], { type: "image/webp" })) }) });
    const decode = vi.fn(async () => {
      await new Promise<void>(resolve => { decoded = resolve; });
      return { width: 512, height: 256, close: vi.fn() };
    });
    vi.stubGlobal("createImageBitmap", decode);
    try {
      const pending = acquireAssetUrl(asset);
      await nextTurn();
      setCanvasAssetInteraction(true);
      read();
      await nextTurn();
      expect(decode).not.toHaveBeenCalled();
      setCanvasAssetInteraction(false);
      await nextTurn();
      expect(decode).toHaveBeenCalledOnce();
      setCanvasAssetInteraction(true);
      decoded();
      await nextTurn();
      expect(draw).not.toHaveBeenCalled();
      setCanvasAssetInteraction(false);
      const item = await pending;
      expect(draw).toHaveBeenCalledOnce();
      item.release();
    } finally {
      setCanvasAssetInteraction(false);
      read?.(); decoded?.();
      vi.mocked(getBlob).mockImplementation(originalRead);
    }
  });

  it("reuses persisted previews without reading or decoding the full image", async () => {
    const asset = image("persisted-preview");
    storage.blobs.set("thumb-" + asset.id, new Blob(["preview"], { type: "image/webp" }));
    const decode = vi.fn(); vi.stubGlobal("createImageBitmap", decode);
    const item = await acquireAssetUrl(asset);
    expect(item.url).toContain("image/webp");
    expect(getBlob).toHaveBeenCalledExactlyOnceWith("thumb-" + asset.id, "image/webp");
    expect(decode).not.toHaveBeenCalled();
    item.release();
  });

  it("reads only the two originals being decoded and stores only separate previews", async () => {
    const assets = Array.from({ length: 6 }, (_, index) => image("queued-preview-" + index));
    for (const asset of assets) storage.blobs.set(asset.id, new Blob([asset.id], { type: "image/png" }));
    const originals = new Map(storage.blobs);
    const releases: (() => void)[] = [];
    const close = vi.fn();
    let active = 0, peak = 0;
    const decode = vi.fn(async (_blob: Blob, options: ImageBitmapOptions) => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      return { width: options.resizeWidth, height: options.resizeHeight, close };
    });
    vi.stubGlobal("createImageBitmap", decode);
    const pending = Promise.all(assets.map(asset => acquireAssetUrl(asset)));
    await nextTurn();
    expect(decode).toHaveBeenCalledTimes(2);
    const originalReads = () => vi.mocked(getBlob).mock.calls.filter(([id]) => assets.some(asset => asset.id === id));
    expect(originalReads()).toHaveLength(2);
    for (let index = 0; index < 3; index++) {
      releases.splice(0).forEach(release => release());
      await nextTurn();
      expect(originalReads()).toHaveLength(Math.min(6, (index + 2) * 2));
    }
    const urls = await pending;
    expect(peak).toBe(2);
    expect(close).toHaveBeenCalledTimes(6);
    expect(decode).toHaveBeenCalledWith(expect.any(Blob), { resizeWidth: 512, resizeHeight: 256, resizeQuality: "high" });
    for (const asset of assets) {
      expect(storage.blobs.get(asset.id)).toBe(originals.get(asset.id));
      expect(storage.blobs.get("thumb-" + asset.id)?.type).toBe("image/webp");
    }
    urls.forEach(item => item.release());
  });

  it("bounds pending original-file reads before any decode can begin", async () => {
    const assets = Array.from({ length: 6 }, (_, index) => image("queued-read-" + index));
    for (const asset of assets) storage.blobs.set(asset.id, new Blob([asset.id], { type: "image/png" }));
    const originalRead = async (id: string) => {
      const blob = storage.blobs.get(id);
      if (!blob) throw new Error("Missing local blob");
      return blob;
    };
    const releases: (() => void)[] = [];
    let active = 0, peak = 0, started = 0;
    vi.mocked(getBlob).mockImplementation(async id => {
      if (assets.some(asset => asset.id === id)) {
        started++; active++; peak = Math.max(peak, active);
        await new Promise<void>(resolve => releases.push(resolve));
        active--;
      }
      return originalRead(id);
    });
    vi.stubGlobal("createImageBitmap", vi.fn(async (_blob: Blob, options: ImageBitmapOptions) => ({ width: options.resizeWidth, height: options.resizeHeight, close: vi.fn() })));
    try {
      const pending = Promise.all(assets.map(asset => acquireAssetUrl(asset)));
      await nextTurn();
      expect(started).toBe(2);
      for (let index = 0; index < 3; index++) {
        releases.splice(0).forEach(release => release());
        await nextTurn();
        expect(started).toBe(Math.min(6, (index + 2) * 2));
      }
      const urls = await pending;
      expect(peak).toBe(2);
      urls.forEach(item => item.release());
    } finally {
      releases.splice(0).forEach(release => release());
      vi.mocked(getBlob).mockImplementation(originalRead);
    }
  });

  it("releases slots after missing originals and preserves original fallback after decode failure", async () => {
    const assets = Array.from({ length: 6 }, (_, index) => image("queue-error-" + index));
    for (const asset of assets.slice(2)) storage.blobs.set(asset.id, new Blob([asset.id], { type: "image/png" }));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { throw new Error("decode unavailable"); }));
    const results = await Promise.allSettled(assets.map(asset => acquireAssetUrl(asset)));
    expect(results.slice(0, 2)).toEqual([
      { status: "rejected", reason: new Error("Missing local blob") },
      { status: "rejected", reason: new Error("Missing local blob") },
    ]);
    for (const result of results.slice(2)) {
      expect(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") {
        expect(result.value.url).toContain("image/png");
        result.value.release();
      }
    }
    vi.stubGlobal("createImageBitmap", undefined);
    const fallback = image("queue-no-decoder");
    storage.blobs.set(fallback.id, new Blob(["original"], { type: "image/png" }));
    const item = await acquireAssetUrl(fallback);
    expect(item.url).toContain("image/png");
    item.release();
  });

  it("separates the enlarged canvas preview from both the small preview and original", async () => {
    const asset = image("quality-preview");
    storage.blobs.set(asset.id, new Blob(["original"], { type: "image/png" }));
    const close = vi.fn();
    const decode = vi.fn(async (_blob: Blob, options: ImageBitmapOptions) => ({ width: options.resizeWidth, height: options.resizeHeight, close }));
    vi.stubGlobal("createImageBitmap", decode);
    const large = await acquireAssetUrl(asset, false, 1024);
    const original = await acquireAssetUrl(asset, true);
    expect(large.url).not.toBe(original.url);
    expect(storage.blobs.get("thumb-1024-" + asset.id)?.type).toBe("image/webp");
    expect(storage.blobs.has("thumb-" + asset.id)).toBe(false);
    expect(decode).toHaveBeenCalledExactlyOnceWith(expect.any(Blob), { resizeWidth: 1024, resizeHeight: 512, resizeQuality: "high" });
    large.release(); original.release();
  });

  it("persists a reusable video poster and reads it without reading the original video", async () => {
    const asset: Asset = { ...image("poster-video"), kind: "video", mime: "video/mp4" };
    const original = new Blob(["video-source"], { type: "video/mp4" });
    storage.blobs.set(asset.id, original);
    const video = { readyState: 2, videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;
    expect(await Promise.all([rememberVideoPoster(asset, video), rememberVideoPoster(asset, video)])).toEqual([true, true]);
    expect(storage.blobs.get("thumb-" + asset.id)?.type).toBe("image/webp");
    expect(storage.blobs.get(asset.id)).toBe(original);
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 512, height: 288, close })));
    const poster = await acquireVideoPosterUrl(asset);
    expect(poster.url).toContain("image/webp");
    expect(getBlob).toHaveBeenCalledExactlyOnceWith("thumb-" + asset.id, "image/webp");
    expect(close).toHaveBeenCalledOnce();
    poster.release();
  });

  it("leaves videos available when no decoded frame or thumbnail encoder is available", async () => {
    const asset: Asset = { ...image("poster-fallback"), kind: "video", mime: "video/mp4" };
    const original = new Blob(["video-source"], { type: "video/mp4" });
    storage.blobs.set(asset.id, original);
    expect(await rememberVideoPoster(asset, { readyState: 1, videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement)).toBe(false);
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0,
      getContext: () => ({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }) }), toBlob: (done: BlobCallback) => done(null) }) });
    expect(await rememberVideoPoster(asset, { readyState: 2, videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement)).toBe(false);
    expect(storage.blobs.get(asset.id)).toBe(original);
    expect(storage.blobs.has("thumb-" + asset.id)).toBe(false);
    const source = await acquireAssetUrl(asset);
    expect(source.url).toContain("video/mp4");
    source.release();
  });

  it("waits for a presented first frame when loadeddata still draws transparent pixels", async () => {
    const asset: Asset = { ...image("presented-frame"), kind: "video", mime: "video/mp4" };
    const context = { drawImage: vi.fn(), clearRect: vi.fn(), getImageData: vi.fn()
      .mockReturnValueOnce({ data: new Uint8ClampedArray([0, 0, 0, 0]) })
      .mockReturnValue({ data: new Uint8ClampedArray([100, 176, 239, 255]) }) };
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => context,
      toBlob: (done: BlobCallback) => done(new Blob(["visible-poster"], { type: "image/webp" })) }) });
    let presented!: VideoFrameRequestCallback;
    const video = Object.assign(new EventTarget(), { readyState: 2, videoWidth: 1920, videoHeight: 1080, src: "blob:original", currentSrc: "blob:original",
      requestVideoFrameCallback: vi.fn((callback: VideoFrameRequestCallback) => { presented = callback; return 7; }), cancelVideoFrameCallback: vi.fn() }) as unknown as HTMLVideoElement;
    const pending = rememberVideoPoster(asset, video);
    expect(storage.blobs.has("thumb-" + asset.id)).toBe(false);
    expect(video.requestVideoFrameCallback).toHaveBeenCalledOnce();
    presented(0, {} as VideoFrameCallbackMetadata);
    expect(await pending).toBe(true);
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect(storage.blobs.get("thumb-" + asset.id)?.type).toBe("image/webp");
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(7);
  });

  it.each(["emptied", "error"])("releases a pending poster when the video reports %s", async event => {
    const asset: Asset = { ...image("stopped-frame-" + event), kind: "video", mime: "video/mp4" };
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }) }) }) });
    const video = Object.assign(new EventTarget(), { readyState: 2, videoWidth: 1920, videoHeight: 1080, src: "blob:original", currentSrc: "blob:original",
      requestVideoFrameCallback: vi.fn(() => 3), cancelVideoFrameCallback: vi.fn() }) as unknown as HTMLVideoElement;
    const pending = rememberVideoPoster(asset, video);
    video.dispatchEvent(new Event(event));
    expect(await pending).toBe(false);
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(3);
    expect(storage.blobs.has("thumb-" + asset.id)).toBe(false);
  });

  it("rejects an old transparent cached poster so its original video can rebuild it", async () => {
    const asset: Asset = { ...image("transparent-cache"), kind: "video", mime: "video/mp4" };
    storage.blobs.set("thumb-" + asset.id, new Blob(["empty-old-poster"], { type: "image/webp" }));
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 512, height: 288, close })));
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }) }) }) });
    await expect(acquireVideoPosterUrl(asset)).rejects.toThrow("no decoded pixels");
    expect(getBlob).toHaveBeenCalledExactlyOnceWith("thumb-" + asset.id, "image/webp");
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["changed source", "transparent frame"])("does not persist a %s after a frame callback", async reason => {
    const asset: Asset = { ...image("invalid-presented-frame-" + reason), kind: "video", mime: "video/mp4" };
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn(), clearRect: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }) }) }) });
    let presented!: VideoFrameRequestCallback;
    const video = Object.assign(new EventTarget(), { readyState: 2, videoWidth: 1920, videoHeight: 1080, src: "blob:original", currentSrc: "blob:original",
      requestVideoFrameCallback: vi.fn((callback: VideoFrameRequestCallback) => { presented = callback; return 7; }), cancelVideoFrameCallback: vi.fn() }) as unknown as HTMLVideoElement;
    const pending = rememberVideoPoster(asset, video);
    if (reason === "changed source") Object.defineProperty(video, "currentSrc", { value: "blob:next-asset" });
    presented(0, {} as VideoFrameCallbackMetadata);
    expect(await pending).toBe(false);
    expect(storage.blobs.has("thumb-" + asset.id)).toBe(false);
  });
});
