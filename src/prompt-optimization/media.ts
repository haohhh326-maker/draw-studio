/** Browser-side adapters read local media bytes; URLs and filenames never stand in for vision inputs. */
export const optimizationMediaLimits = {
  images: 16,
  requestBytes: 20 * 1024 * 1024,
  imageFileBytes: 64 * 1024 * 1024,
  videoFileBytes: 256 * 1024 * 1024,
  longestEdge: 1600,
} as const;

const aborted = () => new DOMException("素材读取已取消。", "AbortError");
export function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw aborted();
}

export function representativeVideoTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取参考视频时长。");
  return [...new Set([0, duration / 2, duration - Math.min(0.001, duration / 2)])].sort((a, b) => a - b);
}

function frameSize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error("素材没有可读取的图像尺寸。");
  const scale = Math.min(1, optimizationMediaLimits.longestEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function encodeCanvas(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal);
  const blob = await new Promise<Blob>((resolve, reject) => {
    let settled = false;
    const cleanup = () => { signal?.removeEventListener("abort", cancel); };
    const cancel = () => { if (!settled) { settled = true; cleanup(); reject(aborted()); } };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    try {
      canvas.toBlob(value => {
        if (settled) return;
        settled = true; cleanup();
        if (signal?.aborted) reject(aborted());
        else if (value) resolve(value);
        else reject(new Error("参考图片编码失败。"));
      }, "image/jpeg", 0.88);
    } catch (error) { if (!settled) { settled = true; cleanup(); reject(error); } }
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assertNotAborted(signal);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return "data:" + blob.type + ";base64," + btoa(binary);
}

function renderFrame(source: CanvasImageSource, width: number, height: number) {
  const canvas = document.createElement("canvas");
  const size = frameSize(width, height);
  canvas.width = size.width; canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建参考图像。");
  // JPEG has no alpha. An explicit white background preserves transparent source visibility.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function decodeImage(blob: Blob, signal?: AbortSignal): Promise<HTMLImageElement> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function")
    throw new Error("当前环境不能读取图片内容。");
  const image = document.createElement("img");
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        image.removeEventListener("load", loaded); image.removeEventListener("error", failed);
        signal?.removeEventListener("abort", cancel);
      };
      const loaded = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); image.removeAttribute("src"); reject(new Error("参考图片无法解码，请检查素材格式。")); };
      const cancel = () => { cleanup(); image.removeAttribute("src"); reject(aborted()); };
      image.addEventListener("load", loaded); image.addEventListener("error", failed);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      else image.src = url;
    });
    return image;
  } finally { URL.revokeObjectURL(url); }
}

export async function imageVisionInput(blob: Blob, options: { signal?: AbortSignal } = {}): Promise<string> {
  assertNotAborted(options.signal);
  if (!blob.size || blob.size > optimizationMediaLimits.imageFileBytes)
    throw new Error("参考图片为空或超过 64 MiB，请压缩后重试。");
  const image = await decodeImage(blob, options.signal);
  let canvas: HTMLCanvasElement | undefined;
  try {
    assertNotAborted(options.signal);
    canvas = renderFrame(image, image.naturalWidth, image.naturalHeight);
    return await encodeCanvas(canvas, options.signal);
  } finally { image.removeAttribute("src"); if (canvas) { canvas.width = 0; canvas.height = 0; } }
}

/** First, middle and last decoded frames are a sampled visual context, not full video/audio understanding. */
export async function videoVisionInputs(
  blob: Blob,
  options: { signal?: AbortSignal } = {},
): Promise<{ dataUrl: string; timeSeconds: number }[]> {
  assertNotAborted(options.signal);
  if (!blob.size || blob.size > optimizationMediaLimits.videoFileBytes)
    throw new Error("参考视频为空或超过 256 MiB，请剪短或压缩后重试。");
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function")
    throw new Error("当前环境不支持参考视频帧提取。");
  const video = document.createElement("video");
  const url = URL.createObjectURL(blob);
  video.preload = "auto"; video.muted = true; video.playsInline = true;
  const waitFor = (events: string[], ready: () => boolean): Promise<void> => {
    assertNotAborted(options.signal);
    if (video.error) return Promise.reject(new Error("参考视频无法解码，请检查素材格式。"));
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        for (const event of events) video.removeEventListener(event, check);
        video.removeEventListener("error", failed); options.signal?.removeEventListener("abort", cancel);
      };
      const check = () => { if (ready()) { cleanup(); resolve(); } };
      const failed = () => { cleanup(); reject(new Error("参考视频无法解码，请检查素材格式。")); };
      const cancel = () => { cleanup(); reject(aborted()); };
      for (const event of events) video.addEventListener(event, check);
      video.addEventListener("error", failed); options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel(); else check();
    });
  };
  try {
    video.src = url;
    await waitFor(["loadedmetadata"], () => video.readyState >= 1);
    const times = representativeVideoTimes(video.duration);
    const result: { dataUrl: string; timeSeconds: number }[] = [];
    for (const time of times) {
      assertNotAborted(options.signal);
      if (time !== video.currentTime) video.currentTime = time;
      await waitFor(["seeked", "loadeddata", "canplay"], () => !video.seeking && video.readyState >= 2);
      const canvas = renderFrame(video, video.videoWidth, video.videoHeight);
      try { result.push({ dataUrl: await encodeCanvas(canvas, options.signal), timeSeconds: time }); }
      finally { canvas.width = 0; canvas.height = 0; }
    }
    return result;
  } finally {
    video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
  }
}
