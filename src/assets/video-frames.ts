export type VideoFrame = "first" | "last";
export type CapturedVideoFrame = { blob: Blob; width: number; height: number; time: number };

/** Seek just inside the duration so the browser decodes the final frame rather than the ended state. */
export function videoFrameTime(duration: number, frame: VideoFrame): number {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取视频时长。");
  return frame === "first" ? 0 : Math.max(0, duration - Math.min(0.001, duration / 2));
}

function abortError() {
  return new DOMException("视频帧提取已取消。", "AbortError");
}

/** Decode a local video independently of the visible player, leaving its playback position unchanged. */
export async function captureVideoFrame(
  blob: Blob,
  frame: VideoFrame,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CapturedVideoFrame> {
  if (options.signal?.aborted) throw abortError();
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function")
    throw new Error("当前环境不支持视频帧提取。");
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  const url = URL.createObjectURL(blob);
  const deadline = Date.now() + (options.timeoutMs ?? 15000);
  const remaining = () => Math.max(0, deadline - Date.now());
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  const waitFor = (events: string[], ready: () => boolean): Promise<void> => {
    if (options.signal?.aborted) return Promise.reject(abortError());
    if (video.error) return Promise.reject(new Error("视频无法解码，请检查文件格式。"));
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        for (const name of events) video.removeEventListener(name, check);
        video.removeEventListener("error", failed);
        options.signal?.removeEventListener("abort", cancelled);
      };
      const check = () => { if (ready()) { cleanup(); resolve(); } };
      const failed = () => { cleanup(); reject(new Error("视频无法解码，请检查文件格式。")); };
      const cancelled = () => { cleanup(); reject(abortError()); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("视频帧提取超时，请重试。")); }, remaining());
      for (const name of events) video.addEventListener(name, check);
      video.addEventListener("error", failed);
      options.signal?.addEventListener("abort", cancelled, { once: true });
      check();
    });
  };

  try {
    video.src = url;
    await waitFor(["loadedmetadata"], () => video.readyState >= 1);
    const time = videoFrameTime(video.duration, frame);
    if (video.videoWidth <= 0 || video.videoHeight <= 0) throw new Error("视频没有可提取的画面。");
    if (time !== video.currentTime) {
      video.currentTime = time;
      await waitFor(["seeked", "loadeddata", "canplay"], () => !video.seeking && video.readyState >= 2);
    } else {
      await waitFor(["loadeddata", "canplay"], () => video.readyState >= 2);
    }
    if (options.signal?.aborted) throw abortError();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建视频帧图像。");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = await new Promise<Blob>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", cancelled); };
      const cancelled = () => { cleanup(); reject(abortError()); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("视频帧保存超时，请重试。")); }, remaining());
      options.signal?.addEventListener("abort", cancelled, { once: true });
      try {
        canvas.toBlob(result => {
          cleanup();
          if (options.signal?.aborted) reject(abortError());
          else if (result) resolve(result);
          else reject(new Error("无法保存视频帧图像。"));
        }, "image/png");
      } catch (error) { cleanup(); reject(error); }
    });
    return { blob: image, width: video.videoWidth, height: video.videoHeight, time };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
    canvas.width = 0;
    canvas.height = 0;
  }
}
