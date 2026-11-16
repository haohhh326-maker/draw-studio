import { useCallback, useEffect, useRef, useState } from "react";
import type { Asset } from "../types";
import { getBlob, putBlob } from "../projects/storage";

const cacheId = (asset: Asset) => "playback-h264-v1-" + asset.id;
const pending = new Map<string, Promise<Blob>>();
export async function compatibleVideo(asset: Asset): Promise<Blob> {
  try { return await getBlob(cacheId(asset), "video/mp4"); } catch { /* Original stays untouched. */ }
  const existing = pending.get(asset.id); if (existing) return existing;
  const job = (async () => {
    const original = await getBlob(asset.id, asset.mime);
    const response = await fetch("/__canvas/video-playback", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: original });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("video/mp4")) {
      let message = "本地视频兼容处理不可用，原文件仍可下载。";
      if (response.headers.get("content-type")?.includes("application/json")) { const result = await response.json(); if (typeof result.error === "string") message = result.error; }
      throw new Error(message);
    }
    const result = await response.blob();
    if (!result.size) throw new Error("视频兼容处理返回了空文件，原文件已保留。");
    await putBlob(cacheId(asset), result);
    return result;
  })();
  pending.set(asset.id, job);
  try { return await job; } finally { if (pending.get(asset.id) === job) pending.delete(asset.id); }
}

/** Only unsupported/undecodable video triggers a local compatibility copy. */
export function useVideoPlayback(asset: Asset, originalUrl: string) {
  const [replacement, setReplacement] = useState(""), [preparing, setPreparing] = useState(false), [error, setError] = useState("");
  const session = useRef<{ active: boolean; attempted: boolean; url?: string }>({ active: false, attempted: false });
  useEffect(() => {
    const current = { active: true, attempted: false, url: undefined as string | undefined }; session.current = current;
    setReplacement(""); setError(""); setPreparing(false);
    if (asset.kind === "video" && originalUrl) void getBlob(cacheId(asset), "video/mp4").then(blob => {
      if (!current.active || current.attempted) return;
      current.attempted = true; current.url = URL.createObjectURL(blob); setReplacement(current.url);
    }).catch(() => {});
    return () => { current.active = false; if (current.url) URL.revokeObjectURL(current.url); };
  }, [asset.id, asset.kind, originalUrl]);
  const repair = useCallback(() => {
    const current = session.current;
    if (asset.kind !== "video" || !originalUrl || !current.active) return;
    if (current.attempted) { if (current.url) setError("兼容视频仍无法显示，请下载原文件检查视频内容。"); return; }
    current.attempted = true; setPreparing(true); setError("");
    void compatibleVideo(asset).then(blob => {
      if (!current.active) return;
      current.url = URL.createObjectURL(blob); setReplacement(current.url);
    }).catch(cause => { if (current.active) setError(cause instanceof Error ? cause.message : "视频无法显示，原文件已保留。"); })
      .finally(() => { if (current.active) setPreparing(false); });
  }, [asset.id, asset.kind, originalUrl]);
  const failed = (video: HTMLVideoElement) => { if (!session.current.url || video.currentSrc === session.current.url) repair(); };
  const inspect = (video: HTMLVideoElement) => { if (video.readyState >= 2 && !(video.videoWidth > 0 && video.videoHeight > 0)) failed(video); };
  return { url: replacement || originalUrl, preparing, error, failed, inspect };
}
