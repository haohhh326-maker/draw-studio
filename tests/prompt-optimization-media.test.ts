import { afterEach, describe, expect, it, vi } from "vitest";
import { imageVisionInput, optimizationMediaLimits, representativeVideoTimes, videoVisionInputs } from "../src/prompt-optimization/media";

class DecodedImage extends EventTarget {
  naturalWidth = 3200; naturalHeight = 2400; decode = true; url = "";
  removeAttribute = vi.fn();
  get src() { return this.url; }
  set src(value: string) { this.url = value; if (this.decode) queueMicrotask(() => this.dispatchEvent(new Event("load"))); }
}
class DecodedVideo extends EventTarget {
  preload = ""; muted = false; playsInline = false; readyState = 0; seeking = false;
  duration = 10; videoWidth = 1920; videoHeight = 1080; error = null; decode = true; url = ""; time = 0;
  pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn();
  get src() { return this.url; }
  set src(value: string) {
    this.url = value;
    if (this.decode) queueMicrotask(() => {
      this.readyState = 1; this.dispatchEvent(new Event("loadedmetadata"));
      this.readyState = 2; this.dispatchEvent(new Event("loadeddata"));
    });
  }
  get currentTime() { return this.time; }
  set currentTime(value: number) {
    this.time = value; this.seeking = true; this.readyState = 1;
    queueMicrotask(() => { this.seeking = false; this.readyState = 2; this.dispatchEvent(new Event("seeked")); });
  }
}
function environment(image = new DecodedImage(), video = new DecodedVideo(), encode: boolean | ((callback: BlobCallback, type: string) => void) = true) {
  const drawImage = vi.fn(), fillRect = vi.fn();
  const canvases: { width: number; height: number; toBlob: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal("document", { createElement: (type: string) => {
    if (type === "img") return image;
    if (type === "video") return video;
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage, fillRect, fillStyle: "" }),
      toBlob: vi.fn((callback: BlobCallback, type: string) => typeof encode === "function" ? encode(callback, type) : callback(encode ? new Blob(["decoded actual pixels"], { type }) : null)) };
    canvases.push(canvas); return canvas;
  } });
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:local-bytes");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { image, video, canvases, drawImage, fillRect, create, revoke };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bounded local visual input adapter", () => {
  it("decodes the passed original blob and transfers encoded pixel bytes, preserving aspect ratio", async () => {
    const env = environment(); const original = new Blob(["actual image bytes"], { type: "image/png" });
    const url = await imageVisionInput(original);
    expect(env.create).toHaveBeenCalledWith(original);
    expect(env.drawImage).toHaveBeenCalledWith(env.image, 0, 0, 1600, 1200);
    expect(env.fillRect).toHaveBeenCalledWith(0, 0, 1600, 1200);
    expect(url).toBe("data:image/jpeg;base64," + btoa("decoded actual pixels"));
    expect(env.canvases[0].toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.88);
    expect(env.revoke).toHaveBeenCalledWith("blob:local-bytes"); expect(env.image.removeAttribute).toHaveBeenCalledWith("src");
    expect(env.canvases[0].width).toBe(0);
  });
  it("does not enlarge small input images", async () => {
    const env = environment(); env.image.naturalWidth = 400; env.image.naturalHeight = 300;
    await imageVisionInput(new Blob(["image"]));
    expect(env.drawImage).toHaveBeenCalledWith(env.image, 0, 0, 400, 300);
  });
  it("rejects an empty or oversized image before decoding", async () => {
    const env = environment();
    await expect(imageVisionInput(new Blob())).rejects.toThrow("64 MiB");
    await expect(imageVisionInput({ size: optimizationMediaLimits.imageFileBytes + 1 } as Blob)).rejects.toThrow("64 MiB");
    expect(env.create).not.toHaveBeenCalled();
  });
  it("keeps decoding an image as the clock advances until the decoder returns", async () => {
    vi.useFakeTimers(); const image = new DecodedImage(); image.decode = false; const env = environment(image);
    const result = imageVisionInput(new Blob(["image"])); let settled = false;
    void result.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(settled).toBe(false); expect(env.revoke).not.toHaveBeenCalled(); expect(env.drawImage).not.toHaveBeenCalled();
    image.dispatchEvent(new Event("load"));
    await expect(result).resolves.toContain("data:image/jpeg;base64,");
    expect(env.revoke).toHaveBeenCalledOnce(); expect(env.canvases[0].width).toBe(0);
  });
  it("keeps waiting for image encoding without a local deadline", async () => {
    vi.useFakeTimers(); let finish!: BlobCallback, encodingStarted!: () => void;
    const encoding = new Promise<void>(resolve => { encodingStarted = resolve; });
    const env = environment(new DecodedImage(), new DecodedVideo(), callback => { finish = callback; encodingStarted(); });
    const result = imageVisionInput(new Blob(["image"])); let settled = false;
    void result.then(() => { settled = true; }, () => { settled = true; });
    await encoding; await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(settled).toBe(false); expect(env.canvases[0].width).toBe(1600);
    finish(new Blob(["encoded after waiting"], { type: "image/jpeg" }));
    await expect(result).resolves.toBe("data:image/jpeg;base64," + btoa("encoded after waiting"));
    expect(env.canvases[0].width).toBe(0);
  });
  it("cancels pending image decode", async () => {
    const image = new DecodedImage(); image.decode = false; const env = environment(image); const controller = new AbortController();
    const result = imageVisionInput(new Blob(["image"]), { signal: controller.signal }); controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" }); expect(env.revoke).toHaveBeenCalledOnce();
  });
  it("cancels pending encoding, releases its canvas and ignores a late encoder callback", async () => {
    let finish!: BlobCallback, encodingStarted!: () => void;
    const encoding = new Promise<void>(resolve => { encodingStarted = resolve; });
    const env = environment(new DecodedImage(), new DecodedVideo(), callback => { finish = callback; encodingStarted(); });
    const controller = new AbortController(), result = imageVisionInput(new Blob(["image"]), { signal: controller.signal });
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await encoding; controller.abort(); await rejection;
    expect(env.canvases[0].width).toBe(0); expect(env.image.removeAttribute).toHaveBeenCalledWith("src");
    expect(env.revoke).toHaveBeenCalledOnce();
    finish(new Blob(["late encoded pixels"], { type: "image/jpeg" }));
    await Promise.resolve(); expect(env.canvases[0].width).toBe(0);
  });
  it("reports a real image decoder error and releases its source", async () => {
    const image = new DecodedImage(); image.decode = false; const env = environment(image);
    const result = imageVisionInput(new Blob(["image"])); image.dispatchEvent(new Event("error"));
    await expect(result).rejects.toThrow("无法解码");
    expect(env.revoke).toHaveBeenCalledOnce(); expect(image.removeAttribute).toHaveBeenCalledWith("src");
  });
  it("reports invalid image dimensions and failed encoding", async () => {
    const env = environment(); env.image.naturalWidth = 0;
    await expect(imageVisionInput(new Blob(["image"]))).rejects.toThrow("图像尺寸");
    expect(env.image.removeAttribute).toHaveBeenCalledWith("src");
    environment(new DecodedImage(), new DecodedVideo(), false);
    await expect(imageVisionInput(new Blob(["image"]))).rejects.toThrow("编码失败");
  });
  it("samples first, middle, and just inside the final frame in chronological order", () => {
    expect(representativeVideoTimes(10)).toEqual([0, 5, 9.999]);
    expect(representativeVideoTimes(0.0005)).toEqual([0, 0.00025]);
    expect(() => representativeVideoTimes(0)).toThrow("时长");
    expect(() => representativeVideoTimes(Infinity)).toThrow("时长");
  });
  it("extracts actual original video's ordered decoded frames with bounded resolution and releases decoder", async () => {
    const env = environment(); const original = new Blob(["actual video bytes"], { type: "video/mp4" });
    const result = await videoVisionInputs(original);
    expect(env.create).toHaveBeenCalledWith(original); expect(result.map(frame => frame.timeSeconds)).toEqual([0, 5, 9.999]);
    expect(result.every(frame => frame.dataUrl.startsWith("data:image/jpeg;base64,"))).toBe(true);
    expect(env.drawImage).toHaveBeenCalledTimes(3);
    expect(env.drawImage).toHaveBeenNthCalledWith(1, env.video, 0, 0, 1600, 900);
    expect(env.video.currentTime).toBe(9.999); expect(env.video.pause).toHaveBeenCalledOnce(); expect(env.video.load).toHaveBeenCalledOnce();
    expect(env.revoke).toHaveBeenCalledOnce(); expect(env.canvases.every(canvas => canvas.width === 0)).toBe(true);
  });
  it("preserves video cancellation and source file size bounds", async () => {
    const video = new DecodedVideo(); video.decode = false; const env = environment(new DecodedImage(), video);
    const controller = new AbortController(); const result = videoVisionInputs(new Blob(["video"]), { signal: controller.signal }); controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" }); expect(env.revoke).toHaveBeenCalledOnce();
    await expect(videoVisionInputs({ size: optimizationMediaLimits.videoFileBytes + 1 } as Blob)).rejects.toThrow("256 MiB");
  });
  it("keeps waiting for video metadata as the clock advances and then extracts the frames", async () => {
    vi.useFakeTimers(); const video = new DecodedVideo(); video.decode = false; const env = environment(new DecodedImage(), video);
    const result = videoVisionInputs(new Blob(["video"])); let settled = false;
    void result.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(settled).toBe(false); expect(env.revoke).not.toHaveBeenCalled();
    video.readyState = 1; video.dispatchEvent(new Event("loadedmetadata"));
    video.readyState = 2; video.dispatchEvent(new Event("loadeddata"));
    await expect(result).resolves.toHaveLength(3);
    expect(env.video.pause).toHaveBeenCalledOnce(); expect(env.revoke).toHaveBeenCalledOnce();
    expect(env.canvases.every(canvas => canvas.width === 0)).toBe(true);
  });
  it("reports a real video decoder error and releases the decoder", async () => {
    const video = new DecodedVideo(); video.decode = false; const env = environment(new DecodedImage(), video);
    const result = videoVisionInputs(new Blob(["video"])); video.dispatchEvent(new Event("error"));
    await expect(result).rejects.toThrow("无法解码");
    expect(video.pause).toHaveBeenCalledOnce(); expect(video.load).toHaveBeenCalledOnce(); expect(env.revoke).toHaveBeenCalledOnce();
  });
  it("does not leave a decoder alive when metadata or frame encoding fails", async () => {
    const env = environment(); env.video.duration = Infinity;
    await expect(videoVisionInputs(new Blob(["video"]))).rejects.toThrow("时长"); expect(env.revoke).toHaveBeenCalledOnce();
    const next = environment(new DecodedImage(), new DecodedVideo(), false);
    await expect(videoVisionInputs(new Blob(["video"]))).rejects.toThrow("编码失败"); expect(next.video.pause).toHaveBeenCalledOnce();
  });
});
