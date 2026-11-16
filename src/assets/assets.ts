import { putBlob, getBlob } from "../projects/storage";
import type { Asset, MediaKind } from "../types";
import { validMediaDimensions, type MediaDimensions } from "../nodes/media-layout";
import { AssetUrlCache } from "./asset-url-cache";

export async function readMediaDimensions(file: Blob, kind: MediaKind): Promise<MediaDimensions | undefined> {
  if (kind !== "image" && kind !== "video") return undefined;
  if (kind === "image" && typeof createImageBitmap !== "undefined") {
    try {
      const bitmap = await createImageBitmap(file);
      const dimensions = {width:bitmap.width,height:bitmap.height};
      bitmap.close();
      if (validMediaDimensions(dimensions.width,dimensions.height)) return dimensions;
    } catch { /* Formats not supported by ImageBitmap can still load in an image element. */ }
  }
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return undefined;
  const url = URL.createObjectURL(file);
  const media = document.createElement(kind === "image" ? "img" : "video");
  try {
    return await new Promise<MediaDimensions | undefined>(resolve => {
      let settled = false;
      const finish = (dimensions?: MediaDimensions) => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        resolve(dimensions && validMediaDimensions(dimensions.width,dimensions.height) ? dimensions : undefined);
      };
      const timeout = setTimeout(() => finish(),5000);
      media.onerror = () => finish();
      if (media instanceof HTMLImageElement) {
        media.onload = () => finish({width:media.naturalWidth,height:media.naturalHeight});
      } else {
        media.preload = "metadata";
        media.onloadedmetadata = () => finish({width:media.videoWidth,height:media.videoHeight});
      }
      media.src = url;
    });
  } finally {
    media.onload = null; media.onerror = null;
    if (media instanceof HTMLVideoElement) media.onloadedmetadata = null;
    media.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}
export async function importAsset(file: Blob, name: string, kindHint?: "file"): Promise<Asset> {
  const filename = name.split(/[\\/]/).pop() ?? name;
  const extensionIndex = filename.lastIndexOf(".");
  const ext = extensionIndex > 0 ? filename.slice(extensionIndex + 1).toLowerCase() : "";
  const inferred: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
    avif: "image/avif",
    svg: "image/svg+xml",
    heic: "image/heic",
    ico: "image/x-icon",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    m4v: "video/mp4",
    flv: "video/x-flv",
    mpeg: "video/mpeg",
    mpg: "video/mpeg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    opus: "audio/ogg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    wma: "audio/x-ms-wma",
    txt: "text/plain",
    srt: "text/plain",
    vtt: "text/vtt",
    md: "text/markdown",
    markdown: "text/markdown",
    log: "text/plain",
    xml: "text/xml",
    zip: "application/zip",
    json: "application/json",
    pdf: "application/pdf",
    csv: "text/csv",
    html: "text/html",
  };
  const declaredMime = file.type.split(";", 1)[0].trim().toLowerCase();
  const genericMime = !declaredMime || [
    "application/octet-stream", "binary/octet-stream", "application/binary", "application/x-binary",
  ].includes(declaredMime);
  // A concrete MIME type takes precedence over a misleading filename. Unknown
  // formats remain downloadable files, even when the browser cannot preview them.
  const extensionMime = Object.hasOwn(inferred, ext) ? inferred[ext] : undefined;
  const mime = genericMime ? extensionMime ?? (file.type || "application/octet-stream") : file.type;
  const mediaType = mime.split("/", 1)[0];
  const kind: MediaKind = kindHint === "file" ? "file"
    : mediaType === "image" || mediaType === "video" || mediaType === "audio" || mediaType === "text"
      ? mediaType : "file";
  const dimensions = await readMediaDimensions(file,kind);
  const asset: Asset = {
    id: crypto.randomUUID(),
    name,
    kind,
    mime,
    size: file.size,
    createdAt: Date.now(),
    inLibrary: false,
    ...dimensions,
    ...(kind === "text" ? { text: await file.text() } : {}),
  };
  await putBlob(asset.id, new Blob([file], { type: mime }));
  return asset;
}
const urls = new AssetUrlCache();
let activeThumbnailJobs = 0;
const thumbnailQueue: (() => void)[] = [];
let canvasAssetInteraction = false;
const interactionWaiters = new Set<() => void>();

/** Let pointer movement finish before starting missing-preview work. Cached
 * previews and explicit full-size viewing never wait on this gate. */
export function setCanvasAssetInteraction(active: boolean) {
  if (canvasAssetInteraction === active) return;
  canvasAssetInteraction = active;
  if (!active) {
    const waiting = [...interactionWaiters];
    interactionWaiters.clear();
    waiting.forEach(resolve => resolve());
  }
}

async function waitForCanvasAssetIdle() {
  while (canvasAssetInteraction) await new Promise<void>(resolve => interactionWaiters.add(resolve));
}

async function buildThumbnail(asset: Asset, thumbId: string, previewSize: number): Promise<Blob> {
  if (activeThumbnailJobs >= 2) await new Promise<void>(resolve => thumbnailQueue.push(resolve));
  else activeThumbnailJobs++;
  let original: Blob | undefined;
  let bitmap: ImageBitmap | undefined;
  try {
    // Limit original-file reads as well as decoding. A large visible canvas
    // must not load every full image into memory while waiting for these slots.
    await waitForCanvasAssetIdle();
    original = await getBlob(asset.id, asset.mime);
    if (typeof createImageBitmap === "undefined") return original;
    await waitForCanvasAssetIdle();
    const dimensions = validMediaDimensions(asset.width, asset.height) ? {
      resizeWidth: Math.max(1, Math.round(asset.width! * Math.min(1, previewSize / Math.max(asset.width!, asset.height!)))),
      resizeHeight: Math.max(1, Math.round(asset.height! * Math.min(1, previewSize / Math.max(asset.width!, asset.height!)))),
      resizeQuality: "high" as const,
    } : undefined;
    bitmap = await createImageBitmap(original, dimensions);
    await waitForCanvasAssetIdle();
    const scale = Math.min(1, previewSize / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const thumb = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Thumbnail failed")), "image/webp", 0.82));
    try { await putBlob(thumbId, thumb); } catch { /* The in-memory preview remains usable when the local cache is full. */ }
    return thumb;
  } catch (error) {
    if (!original) throw error;
    return original;
  } finally {
    bitmap?.close();
    const next = thumbnailQueue.shift();
    if (next) next();
    else activeThumbnailJobs--;
  }
}

async function previewBlob(asset: Asset, full: boolean, previewSize: number): Promise<Blob> {
  if (full || asset.kind !== "image") return getBlob(asset.id, asset.mime);
  const thumbId = (previewSize === 512 ? "thumb-" : `thumb-${previewSize}-`) + asset.id;
  try {
    return await getBlob(thumbId, "image/webp");
  } catch {
    /* Build missing thumbnails from the original asset. */
  }
  return buildThumbnail(asset, thumbId, previewSize);
}
export async function acquireAssetUrl(asset: Asset, full = false, previewSize = 512) {
  const key = asset.id + (full ? ":full" : previewSize === 512 ? ":preview" : `:preview:${previewSize}`);
  return urls.acquire(key, () => previewBlob(asset, full, previewSize));
}

function hasPosterPixels(canvas: HTMLCanvasElement): boolean {
  const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
  if (!pixels) return false;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) return true;
  return false;
}

export function acquireVideoPosterUrl(asset: Asset) {
  return urls.acquire(asset.id + ":poster", async () => {
    const blob = await getBlob("thumb-" + asset.id, "image/webp");
    if (!blob.type.startsWith("image/")) throw new Error("Video poster is unavailable");
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        if (!hasPosterPixels(canvas)) throw new Error("Video poster has no decoded pixels");
      } finally { bitmap.close(); }
    }
    return blob;
  });
}

const pendingVideoPosters = new Map<string, Promise<boolean>>();

function nextPresentedVideoFrame(video: HTMLVideoElement): Promise<boolean> {
  if (typeof video.requestVideoFrameCallback !== "function") return Promise.resolve(false);
  return new Promise(resolve => {
    const source = video.currentSrc || video.src;
    let callback: number | undefined;
    const finish = (presented: boolean) => {
      if (callback !== undefined) video.cancelVideoFrameCallback(callback);
      video.removeEventListener("emptied", stopped);
      video.removeEventListener("error", stopped);
      resolve(presented && (video.currentSrc || video.src) === source);
    };
    const stopped = () => finish(false);
    video.addEventListener("emptied", stopped, { once: true });
    video.addEventListener("error", stopped, { once: true });
    callback = video.requestVideoFrameCallback(() => finish(true));
  });
}

export async function rememberVideoPoster(asset: Asset, video: HTMLVideoElement): Promise<boolean> {
  const existing = pendingVideoPosters.get(asset.id);
  if (existing) return existing;
  if (video.readyState < 2 || !validMediaDimensions(video.videoWidth, video.videoHeight)) return false;
  const work = (async () => {
    try {
      const scale = Math.min(1, 512 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d")!;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      // loadeddata can precede the first compositor frame. Persist a poster
      // only after actual pixels are available, including for a paused video.
      if (!hasPosterPixels(canvas)) {
        if (!await nextPresentedVideoFrame(video) || video.readyState < 2) return false;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (!hasPosterPixels(canvas)) return false;
      }
      const poster = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", 0.82));
      if (!poster) return false;
      await putBlob("thumb-" + asset.id, poster);
      return true;
    } catch { return false; }
  })();
  pendingVideoPosters.set(asset.id, work);
  try { return await work; }
  finally { if (pendingVideoPosters.get(asset.id) === work) pendingVideoPosters.delete(asset.id); }
}
