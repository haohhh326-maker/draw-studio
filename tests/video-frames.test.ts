import { afterEach, describe, expect, it, vi } from "vitest";
import { captureVideoFrame, videoFrameTime } from "../src/assets/video-frames";

class DecodedVideo extends EventTarget {
  preload = ""; muted = false; playsInline = false; readyState = 0; seeking = false;
  duration = 10; videoWidth = 1920; videoHeight = 1080; error = null;
  current = 0; decode = true; url = "";
  pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn();
  get src() { return this.url; }
  set src(value: string) {
    this.url = value;
    if (this.decode) queueMicrotask(() => {
      this.readyState = 1; this.dispatchEvent(new Event("loadedmetadata"));
      this.readyState = 2; this.dispatchEvent(new Event("loadeddata"));
    });
  }
  get currentTime() { return this.current; }
  set currentTime(value: number) {
    this.current = value; this.seeking = true; this.readyState = 1;
    queueMicrotask(() => { this.seeking = false; this.readyState = 2; this.dispatchEvent(new Event("seeked")); });
  }
}

function environment(video = new DecodedVideo(), encode = true) {
  const drawImage = vi.fn();
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }),
    toBlob: vi.fn((callback: BlobCallback) => callback(encode ? new Blob(["PNG"], { type: "image/png" }) : null)),
  };
  vi.stubGlobal("document", { createElement: (type: string) => type === "video" ? video : canvas });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:local-video");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { video, canvas, drawImage, revoke };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("local video frame decoding", () => {
  it("uses the beginning and seeks just inside the final duration", () => {
    expect(videoFrameTime(10, "first")).toBe(0);
    expect(videoFrameTime(10, "last")).toBe(9.999);
    expect(videoFrameTime(0.0005, "last")).toBe(0.00025);
    expect(() => videoFrameTime(Infinity, "last")).toThrow("视频时长");
  });
  it.each(["first", "last"] as const)("captures a decoded %s frame at full source resolution and releases the decoder", async frame => {
    const { video, drawImage, canvas, revoke } = environment();
    const captured = await captureVideoFrame(new Blob(["video"], { type: "video/mp4" }), frame);
    expect(captured.width).toBe(1920); expect(captured.height).toBe(1080);
    expect(captured.time).toBe(frame === "first" ? 0 : 9.999);
    expect(captured.blob.type).toBe("image/png");
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080);
    expect(video.currentTime).toBe(captured.time);
    expect(video.pause).toHaveBeenCalledOnce(); expect(video.load).toHaveBeenCalledOnce();
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
    expect(revoke).toHaveBeenCalledWith("blob:local-video");
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
  });
  it("rejects videos without a duration and still releases their object URL", async () => {
    const { video, revoke, drawImage } = environment(); video.duration = Infinity;
    await expect(captureVideoFrame(new Blob(), "last")).rejects.toThrow("视频时长");
    expect(drawImage).not.toHaveBeenCalled(); expect(revoke).toHaveBeenCalledOnce();
  });
  it("rejects image encoding failure instead of creating an empty asset", async () => {
    const { revoke } = environment(new DecodedVideo(), false);
    await expect(captureVideoFrame(new Blob(), "first")).rejects.toThrow("无法保存");
    expect(revoke).toHaveBeenCalledOnce();
  });
  it("stops stalled media decoding at a bounded timeout", async () => {
    vi.useFakeTimers();
    const video = new DecodedVideo(); video.decode = false;
    const { revoke } = environment(video);
    const capture = captureVideoFrame(new Blob(), "first", { timeoutMs: 20 });
    const rejected = expect(capture).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(20); await rejected;
    expect(revoke).toHaveBeenCalledOnce(); expect(video.load).toHaveBeenCalledOnce();
  });
  it("cancels pending decoding without waiting for the timeout", async () => {
    const video = new DecodedVideo(); video.decode = false;
    const { revoke } = environment(video);
    const controller = new AbortController();
    const capture = captureVideoFrame(new Blob(), "first", { signal: controller.signal });
    controller.abort();
    await expect(capture).rejects.toMatchObject({ name: "AbortError" });
    expect(revoke).toHaveBeenCalledOnce();
  });
});
