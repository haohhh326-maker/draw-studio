import { memo, useCallback, useEffect, useRef, useState } from "react";
import { acquireAssetUrl, acquireVideoPosterUrl, rememberVideoPoster } from "./assets";
import type { Asset } from "../types";
import { validMediaDimensions } from "../nodes/media-layout";
import { useVideoPlayback } from "./video-playback";
export function useAssetUrl(asset?: Asset, full = false, previewSize = 512) {
  const [current, setCurrent] = useState({ assetId: "", url: "" });
  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    if (!asset) setCurrent({ assetId: "", url: "" });
    else
      void acquireAssetUrl(asset, full, previewSize)
        .then((item) => {
          release = item.release;
          if (active) setCurrent({ assetId: asset.id, url: item.url });
          else release();
        })
        .catch(() => {});
    return () => {
      active = false;
      release?.();
    };
  }, [asset?.id, full, previewSize]);
  return asset?.id === current.assetId ? current.url : "";
}
export const AssetPreview = memo(function AssetPreview({
  asset,
  full = false,
  previewSize = 512,
  onDimensions,
}: {
  asset: Asset;
  full?: boolean;
  previewSize?: number;
  onDimensions?: (width:number,height:number) => void;
}) {
  const placeholder = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const videoRef = useCallback((element: HTMLVideoElement | null) => {
    const previous = video.current;
    video.current = element;
    if (previous && previous !== element) {
      queueMicrotask(() => {
        if (video.current === previous) return;
        previous.pause();
        previous.removeAttribute("src");
        previous.load();
      });
    }
  }, []);
  const [visibleAsset, setVisibleAsset] = useState("");
  const [hovered, setHovered] = useState(false);
  const [interacting, setInteracting] = useState(false);
  useEffect(() => {
    if (full || asset.kind !== "video") return;
    const shell = placeholder.current?.closest(".canvas-shell") ?? video.current?.closest(".canvas-shell");
    if (!shell) return;
    const pausePreview = () => {
      setInteracting(true);
      setHovered(false);
      video.current?.pause();
    };
    const resumePreview = () => setInteracting(false);
    shell.addEventListener("canvas-interaction-start", pausePreview);
    shell.addEventListener("canvas-interaction-end", resumePreview);
    if (shell.getAttribute("data-interacting") === "true") pausePreview();
    else resumePreview();
    return () => {
      shell.removeEventListener("canvas-interaction-start", pausePreview);
      shell.removeEventListener("canvas-interaction-end", resumePreview);
    };
  }, [asset.id, asset.kind, full]);
  const [posterRevision, setPosterRevision] = useState(0);
  const [poster, setPoster] = useState({ assetId: "", url: "", checked: false });
  const visible = full || visibleAsset === asset.id || typeof IntersectionObserver === "undefined";
  useEffect(() => {
    if (full) { setVisibleAsset(asset.id); return; }
    if (asset.kind === "text") return;
    const target = placeholder.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisibleAsset(asset.id);
        observer.disconnect();
      }
    }, { rootMargin: "160px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [asset.id, asset.kind, full]);
  const needsPoster = visible && asset.kind === "video" && !full;
  useEffect(() => {
    if (!needsPoster) return;
    let active = true;
    let release: (() => void) | undefined;
    void acquireVideoPosterUrl(asset).then(item => {
      release = item.release;
      if (active) setPoster({ assetId: asset.id, url: item.url, checked: true });
      else release();
    }).catch(() => { if (active) setPoster({ assetId: asset.id, url: "", checked: true }); });
    return () => { active = false; release?.(); };
  }, [asset.id, needsPoster, posterRevision]);
  const currentPoster = poster.assetId === asset.id ? poster : { url: "", checked: false };
  const loadVideo = full || !interacting && currentPoster.checked && (!currentPoster.url || hovered);
  // Legacy images lack original dimensions; load the original once instead of measuring a 512px thumbnail.
  const url = useAssetUrl(visible && asset.kind !== "text" && (asset.kind !== "video" || loadVideo) ? asset : undefined,
    full || (asset.kind === "image" && !!onDimensions && !validMediaDimensions(asset.width,asset.height)), previewSize);
  const playback = useVideoPlayback(asset, url);
  useEffect(() => {
    if (asset.kind !== "video" || !currentPoster.url || loadVideo || !video.current) return;
    video.current.pause();
    video.current.removeAttribute("src");
    video.current.load();
  }, [asset.kind, currentPoster.url, loadVideo]);
  const reportDimensions = (width:number,height:number) => {
    if (validMediaDimensions(width,height)) onDimensions?.(width,height);
  };
  if (asset.kind === "text")
    return <pre className="text-result nodrag nowheel">{asset.text ?? ""}</pre>;
  if (!url && !(asset.kind === "video" && currentPoster.url)) return <div ref={placeholder} className="asset-loading">载入素材…</div>;
  if (asset.kind === "file") return <a className="file-result nodrag nopan" href={url} download={asset.name}>{asset.name}<small>下载文件 · {(asset.size / 1024).toFixed(1)} KB</small></a>;
  if (asset.kind === "image")
    return <img src={url} alt={asset.name} loading="lazy" decoding="async" draggable={false}
      onLoad={(event) => {
        if (validMediaDimensions(asset.width,asset.height)) reportDimensions(asset.width!,asset.height!);
        else reportDimensions(event.currentTarget.naturalWidth,event.currentTarget.naturalHeight);
      }} />;
  if (asset.kind === "audio")
    return <audio src={url} controls className="nodrag nowheel" />;
  return (
    <>
    <video
      ref={videoRef}
      data-asset-id={asset.id}
      aria-label={asset.name}
      src={playback.url || undefined}
      poster={currentPoster.url || undefined}
      muted={!full}
      controls={full}
      playsInline
      preload={loadVideo ? "metadata" : "none"}
      autoPlay={!full && hovered}
      loop={!full}
      draggable={false}
      onLoadedMetadata={(event) => reportDimensions(event.currentTarget.videoWidth,event.currentTarget.videoHeight)}
      onLoadedData={(event) => {
        const element = event.currentTarget;
        playback.inspect(element);
        if (!full && !currentPoster.url) void rememberVideoPoster(asset, element).then(saved => {
          if (saved && video.current?.dataset.assetId === asset.id) setPosterRevision(value => value + 1);
        });
      }}
      onCanPlay={(event) => playback.inspect(event.currentTarget)}
      onError={event => playback.failed(event.currentTarget)}
      onMouseEnter={() => {
        if (!full && video.current?.closest(".canvas-shell")?.getAttribute("data-interacting") !== "true") setHovered(true);
      }}
      onMouseLeave={(e) => {
        if (!full) { setHovered(false); e.currentTarget.pause(); }
      }}
      className={full ? "nodrag" : "media-video-preview"}
    />
    {(playback.preparing || playback.error) && <div className="video-playback-status nodrag nopan" role={playback.error ? "alert" : "status"}>{playback.error || "正在本机准备兼容视频…"}</div>}
    </>
  );
});
