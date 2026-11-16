import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Crop, Download, Gauge, Maximize2, Minimize2, MoreHorizontal, Pause, Play, Repeat, Volume2, VolumeX, X } from "lucide-react";
import type { Asset } from "../types";
import { useAssetUrl } from "./AssetPreview";
import { useVideoPlayback } from "./video-playback";
import { initialMediaZoom, mediaWheelPixels, panMediaBy, zoomMediaAtPoint } from "./media-zoom";
import "./media-viewer.css";

export type MediaViewportProps = {
  children: ReactNode;
  className?: string;
  zoomKey?: string | number;
};

export function MediaViewport({ children, className = "", zoomKey }: MediaViewportProps) {
  const container = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(initialMediaZoom);
  const [panning, setPanning] = useState(false);
  const suppressClick = useRef(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let current = { ...initialMediaZoom };
    let drag: { pointerId: number; startX: number; startY: number; x: number; y: number; moved: boolean } | undefined;
    const update = (next: typeof current) => { current = next; setZoom(next); };
    update({ ...initialMediaZoom });
    setPanning(false);
    suppressClick.current = false;
    const finishPan = () => {
      const previous = drag;
      drag = undefined;
      setPanning(false);
      if (previous && element.hasPointerCapture(previous.pointerId)) element.releasePointerCapture(previous.pointerId);
    };
    // Native non-passive handling also keeps the React Flow canvas from zooming.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      finishPan();
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const size = { width: element.clientWidth, height: element.clientHeight };
      const point = {
        x: (event.clientX - rect.left) * size.width / rect.width,
        y: (event.clientY - rect.top) * size.height / rect.height,
      };
      update(zoomMediaAtPoint(current, mediaWheelPixels(event.deltaY, event.deltaMode, size.height), point, size));
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType !== "mouse" || !event.isPrimary) return;
      suppressClick.current = false;
      if (current.scale <= 1) return;
      event.preventDefault();
      event.stopPropagation();
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false };
      setPanning(true);
    };
    const pointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!(event.buttons & 1)) { finishPan(); return; }
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 3) return;
        drag.moved = true;
        suppressClick.current = true;
        // Capture only after dragging begins, preserving ordinary video clicks.
        element.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      event.stopPropagation();
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height) {
        const size = { width: element.clientWidth, height: element.clientHeight };
        // React Flow can scale the node; translate screen movement into its local pixels.
        update(panMediaBy(current, {
          x: (event.clientX - drag.x) * size.width / rect.width,
          y: (event.clientY - drag.y) * size.height / rect.height,
        }, size));
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
    };
    const pointerEnd = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) finishPan(); };
    const resize = new ResizeObserver(() => {
      const next = panMediaBy(current, { x: 0, y: 0 }, { width: element.clientWidth, height: element.clientHeight });
      if (next.x !== current.x || next.y !== current.y) { finishPan(); update(next); }
    });
    resize.observe(element);
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("pointerdown", pointerDown);
    element.addEventListener("lostpointercapture", pointerEnd);
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerEnd);
    window.addEventListener("pointercancel", pointerEnd);
    window.addEventListener("blur", finishPan);
    return () => {
      resize.disconnect();
      finishPan();
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("pointerdown", pointerDown);
      element.removeEventListener("lostpointercapture", pointerEnd);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerEnd);
      window.removeEventListener("pointercancel", pointerEnd);
      window.removeEventListener("blur", finishPan);
    };
  }, [zoomKey]);
  return <div ref={container} className={`media-viewport nowheel ${zoom.scale > 1 ? "is-zoomed nodrag nopan" : ""} ${panning ? "is-panning" : ""} ${className}`}
    onClickCapture={(event) => {
      if (suppressClick.current && event.detail > 0) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick.current = false;
      }
    }}>
    <div className="media-viewport-content" style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}>
      {children}
    </div>
  </div>;
}

export type MediaViewerProps = {
  asset: Asset;
  onClose: () => void;
  onFrame?: (frame: "first" | "last") => void;
  frameBusy?: boolean;
  onCrop?: () => void;
  cropDisabled?: boolean;
};

export function MediaViewer({ asset, onClose, onFrame, frameBusy = false, onCrop, cropDisabled = false }: MediaViewerProps) {
  const url = useAssetUrl(asset, true);
  const playback = useVideoPlayback(asset, url);
  const frame = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  const [rate, setRate] = useState(1);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const isVideo = asset.kind === "video";
  const isFull = fullscreen || expanded;

  useEffect(() => {
    const previous = document.activeElement;
    const element = frame.current;
    closeButton.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === frame.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.target instanceof Node && !frame.current?.contains(event.target)) {
        // Keep canvas shortcuts inactive if a disappearing menu item released focus.
        event.preventDefault();
        event.stopPropagation();
        closeButton.current?.focus();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (document.fullscreenElement === frame.current) void document.exitFullscreen().catch(() => {});
        else if (expanded) setExpanded(false);
        else if (menu) { setMenu(false); menuButton.current?.focus(); }
        else onClose();
      } else if (event.key === "Tab") {
        const controls = frame.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)');
        if (!controls?.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  }, [expanded, menu, onClose]);
  useEffect(() => {
    if (!menu) return;
    menuElement.current?.querySelector<HTMLElement>('a,button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!menuElement.current?.contains(event.target) && !menuButton.current?.contains(event.target)) setMenu(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [menu]);
  const toggleFullscreen = async () => {
    setMenu(false);
    if (document.fullscreenElement === frame.current) { await document.exitFullscreen().catch(() => {}); return; }
    if (expanded) { setExpanded(false); return; }
    if (frame.current?.requestFullscreen) {
      try { await frame.current.requestFullscreen(); } catch { setExpanded(true); }
    } else setExpanded(true);
  };
  const togglePlaying = () => {
    if (!video.current) return;
    if (video.current.paused) void video.current.play().catch(() => {});
    else video.current.pause();
  };
  const cycleRate = () => {
    const rates = [0.5, 1, 1.25, 1.5, 2];
    const next = rates[(rates.indexOf(rate) + 1) % rates.length];
    if (video.current) video.current.playbackRate = next;
    setRate(next);
  };

  return createPortal(
    <div className="media-viewer-overlay nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={frame} className={`media-viewer ${isVideo ? "is-video" : ""} ${isFull ? "is-fullscreen" : ""}`} role="dialog" aria-modal="true" aria-label="放大预览"
        onKeyDown={(event) => event.stopPropagation()} onPaste={(event) => event.stopPropagation()}>
        <button ref={closeButton} type="button" className="media-viewer-icon media-viewer-close" aria-label="关闭预览" onClick={onClose}><X size={21} /></button>
        {!isVideo && onCrop && <button type="button" className="media-viewer-icon media-viewer-crop" title="裁切图片" aria-label="裁切图片"
          disabled={cropDisabled} onClick={(event) => { event.stopPropagation(); onCrop(); }}><Crop size={20} /></button>}
        {isVideo && onFrame && <div className="media-viewer-frames">
          <button type="button" className="media-viewer-icon" aria-label="添加首帧到画布" disabled={frameBusy} onClick={() => onFrame("first")}>S</button>
          <button type="button" className="media-viewer-icon" aria-label="添加尾帧到画布" disabled={frameBusy} onClick={() => onFrame("last")}>N</button>
        </div>}
        <MediaViewport zoomKey={asset.id} className="media-viewer-stage">
          {url ? isVideo ? <video ref={video} src={playback.url} controls={false} playsInline preload="auto" muted={muted} loop={loop} draggable={false}
            onError={event => playback.failed(event.currentTarget)} onLoadedData={event => playback.inspect(event.currentTarget)} onCanPlay={event => playback.inspect(event.currentTarget)}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
            onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
            onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
            onClick={togglePlaying} /> : <img src={url} alt="" draggable={false} /> : <span className="media-viewer-loading" role="status" aria-label="正在载入素材" />}
        </MediaViewport>
        {isVideo && (playback.preparing || playback.error) && <div className="video-playback-status" role={playback.error ? "alert" : "status"}>{playback.error || "正在本机准备兼容视频…"}</div>}
        {isVideo && <footer className="media-viewer-controls" data-media-controls>
          <button type="button" className="media-viewer-icon" aria-label={playing ? "暂停" : "播放"} onClick={togglePlaying}>{playing ? <Pause size={19} /> : <Play size={19} />}</button>
          <input type="range" className="media-viewer-progress" min="0" max={duration || 1} step="0.01" value={Math.min(time, duration || 1)} disabled={!duration}
            aria-label="视频进度" aria-valuetext={`${time.toFixed(1)} / ${duration.toFixed(1)} 秒`}
            onChange={(event) => { const next = Number(event.target.value); if (video.current) video.current.currentTime = next; setTime(next); }} />
          <button type="button" className="media-viewer-icon" aria-label={muted ? "开启声音" : "静音"} onClick={() => setMuted(!muted)}>{muted ? <VolumeX size={19} /> : <Volume2 size={19} />}</button>
          <div className="media-viewer-menu-anchor">
            <button ref={menuButton} type="button" className="media-viewer-icon" aria-label="视频选项" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(!menu)}><MoreHorizontal size={21} /></button>
          </div>
          <button type="button" className="media-viewer-icon media-viewer-fullscreen" aria-label={isFull ? "退出全屏" : "全屏预览"} onClick={() => void toggleFullscreen()}>{isFull ? <Minimize2 size={20} /> : <Maximize2 size={20} />}</button>
          {menu && <div ref={menuElement} className="media-viewer-menu" role="menu" aria-label="视频选项" onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
              const current = items.indexOf(document.activeElement as HTMLElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
              items[next]?.focus();
            }}>
              <a role="menuitem" className="media-viewer-icon" href={url || undefined} download={asset.name} aria-label="下载视频" onClick={() => { setMenu(false); menuButton.current?.focus(); }}><Download size={19} /></a>
              <button type="button" role="menuitemcheckbox" aria-checked={loop} className={`media-viewer-icon ${loop ? "is-active" : ""}`} aria-label="循环播放" onClick={() => setLoop(!loop)}><Repeat size={19} /></button>
              <button type="button" role="menuitem" className={`media-viewer-icon ${rate !== 1 ? "is-active" : ""}`} aria-label={`播放速度 ${rate} 倍，点击切换`} onClick={cycleRate}><Gauge size={19} /></button>
          </div>}
        </footer>}
        {!isVideo && <button type="button" className="media-viewer-icon media-viewer-fullscreen" aria-label={isFull ? "退出全屏" : "全屏预览"} onClick={() => void toggleFullscreen()}>{isFull ? <Minimize2 size={20} /> : <Maximize2 size={20} />}</button>}
      </div>
    </div>, document.body,
  );
}
