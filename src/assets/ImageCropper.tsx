import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Crop, RotateCcw, X } from "lucide-react";
import type { Asset } from "../types";
import { getBlob } from "../projects/storage";
import { importAsset } from "./assets";
import { clampImageCrop, cropImagePng, fittedCropImage, fullImageCrop, imageCropFromPoints, imageCropPixels, imageCropPoint, moveImageCrop, resizeImageCrop, type CropHandle, type CropPoint, type CropRect, type CropSize } from "./image-crop";
import "./image-cropper.css";

export type ImageCropperProps = { asset: Asset; onClose: () => void; onApply: (asset: Asset) => Promise<void> | void };
type Drag = { id: number; mode: CropHandle | "move" | "create"; start: CropPoint; rect: CropRect };
const handles: { key: CropHandle; label: string; left: string; top: string }[] = [
  { key: "nw", label: "调整左上角", left: "0%", top: "0%" }, { key: "n", label: "调整上边", left: "50%", top: "0%" },
  { key: "ne", label: "调整右上角", left: "100%", top: "0%" }, { key: "e", label: "调整右边", left: "100%", top: "50%" },
  { key: "se", label: "调整右下角", left: "100%", top: "100%" }, { key: "s", label: "调整下边", left: "50%", top: "100%" },
  { key: "sw", label: "调整左下角", left: "0%", top: "100%" }, { key: "w", label: "调整左边", left: "0%", top: "50%" },
];

export function ImageCropper({ asset, onClose, onApply }: ImageCropperProps) {
  const dialog = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), frame = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const closeCallback = useRef(onClose); closeCallback.current = onClose;
  const drag = useRef<Drag | undefined>(undefined), mounted = useRef(true), operation = useRef<{ cancelled: boolean } | undefined>(undefined), busyRef = useRef(false);
  const [url, setUrl] = useState(""), [natural, setNatural] = useState<CropSize | undefined>(), [selection, setSelection] = useState<CropRect | undefined>();
  const [available, setAvailable] = useState<CropSize>({ width: 1, height: 1 }), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const close = useCallback(() => { if (busyRef.current) return; if (operation.current) operation.current.cancelled = true; closeCallback.current(); }, []);
  const finishDrag = useCallback(() => {
    const previous = drag.current; drag.current = undefined;
    if (previous && frame.current?.hasPointerCapture(previous.id)) frame.current.releasePointerCapture(previous.id);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (operation.current) operation.current.cancelled = true; };
  }, []);
  useEffect(() => { if (busy) dialog.current?.focus(); }, [busy]);
  useEffect(() => {
    let active = true, source = "";
    setUrl(""); setNatural(undefined); setSelection(undefined); setError(""); setLoading(true); finishDrag();
    void (async () => {
      if (asset.kind !== "image") throw new Error("裁切只支持图片素材。");
      const blob = await getBlob(asset.id, asset.mime);
      if (!active) return;
      source = URL.createObjectURL(blob); setUrl(source);
    })().catch(reason => { if (active) { setLoading(false); setError(reason instanceof Error ? reason.message : "无法载入原始图片。"); } });
    return () => { active = false; if (source) URL.revokeObjectURL(source); };
  }, [asset.id, asset.kind, asset.mime, finishDrag]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const update = () => setAvailable({ width: Math.max(1, element.clientWidth - 48), height: Math.max(1, element.clientHeight - 48) });
    update();
    const observer = new ResizeObserver(update); observer.observe(element);
    window.addEventListener("blur", finishDrag);
    return () => { observer.disconnect(); window.removeEventListener("blur", finishDrag); finishDrag(); };
  }, [finishDrag]);
  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
      const element = dialog.current;
      if (!element) return;
      if (event.key !== "Tab" && event.target instanceof Node && !element.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); element.focus(); return; }
      if (event.key === "Tab") {
        const focusable = [...element.querySelectorAll<HTMLElement>('button:not([disabled]),[tabindex="0"]')];
        const first = focusable[0], last = focusable.at(-1);
        if (!first || !last) { event.preventDefault(); element.focus(); }
        else if (!element.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const keepFocus = (event: FocusEvent) => { if (event.target instanceof Node && !dialog.current?.contains(event.target)) (busyRef.current ? dialog.current : closeButton.current)?.focus(); };
    document.addEventListener("keydown", keydown, true); document.addEventListener("focusin", keepFocus);
    return () => { document.removeEventListener("keydown", keydown, true); document.removeEventListener("focusin", keepFocus); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [close]);

  const display = natural ? fittedCropImage(natural, available) : { width: 1, height: 1 };
  const pixels = selection && natural ? imageCropPixels(selection, natural) : undefined;
  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (busy || !natural || !selection || event.button !== 0 || !event.isPrimary) return;
    const element = frame.current;
    if (!element) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.target as HTMLElement;
    const handle = target.closest<HTMLElement>("[data-crop-handle]")?.dataset.cropHandle as CropHandle | undefined;
    const mode = handle ?? (target.closest("[data-crop-selection]") ? "move" : "create");
    const start = imageCropPoint({ x: event.clientX, y: event.clientY }, element.getBoundingClientRect(), natural);
    drag.current = { id: event.pointerId, mode, start, rect: { ...selection } };
    if (mode === "create") setSelection(imageCropFromPoints(start, start, natural));
    element.setPointerCapture(event.pointerId);
    if (mode === "move") element.querySelector<HTMLElement>("[data-crop-selection]")?.focus();
    else if (handle) target.closest<HTMLElement>("[data-crop-handle]")?.focus();
  }
  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId || !natural || !frame.current) return;
    event.preventDefault(); event.stopPropagation();
    const point = imageCropPoint({ x: event.clientX, y: event.clientY }, frame.current.getBoundingClientRect(), natural);
    const delta = { x: point.x - current.start.x, y: point.y - current.start.y };
    setSelection(current.mode === "create" ? imageCropFromPoints(current.start, point, natural) : current.mode === "move" ? moveImageCrop(current.rect, delta, natural) : resizeImageCrop(current.rect, current.mode, delta, natural));
  }
  function adjustWithKey(event: ReactKeyboardEvent<HTMLElement>, handle?: CropHandle) {
    if (busy || !natural || !selection || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 10 : 1, delta = { x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0 };
    setSelection(handle ? resizeImageCrop(selection, handle, delta, natural) : moveImageCrop(selection, delta, natural));
  }
  async function apply() {
    if (busy || !selection || !natural || !image.current) return;
    finishDrag(); busyRef.current = true; setBusy(true); setError("");
    const current = { cancelled: false }; operation.current = current;
    try {
      const blob = await cropImagePng(image.current, clampImageCrop(selection, natural));
      if (current.cancelled || !mounted.current) return;
      const baseName = asset.name.replace(/\.[^.]+$/, "") || "图片";
      const cropped = await importAsset(blob, baseName + "-裁切.png");
      if (current.cancelled || !mounted.current) return;
      await onApply(cropped);
      if (!current.cancelled && mounted.current) { busyRef.current = false; close(); }
    } catch (reason) { if (!current.cancelled && mounted.current) setError(reason instanceof Error ? reason.message : "裁切失败，请重试。"); }
    finally { if (operation.current === current) operation.current = undefined; busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  return createPortal(<div className="image-crop-overlay nodrag nopan nowheel" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) close(); }} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onPaste={event => event.stopPropagation()} onDrop={event => { event.preventDefault(); event.stopPropagation(); }} onDragOver={event => { event.preventDefault(); event.stopPropagation(); }}>
    <div ref={dialog} className="image-cropper" role="dialog" aria-modal="true" aria-label="裁切图片" aria-busy={busy} tabIndex={-1} onKeyDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
      <header className="image-crop-header"><h2><Crop size={19} />裁切图片</h2><button ref={closeButton} className="image-crop-close" type="button" aria-label="关闭裁切" disabled={busy} onClick={close}><X size={20} /></button></header>
      <div ref={stage} className="image-crop-stage">
        {url && <div ref={frame} className={`image-crop-image ${busy ? "is-busy" : ""}`} style={{ width: display.width, height: display.height }} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={event => { if (drag.current?.id === event.pointerId) finishDrag(); }} onPointerCancel={finishDrag} onLostPointerCapture={() => { drag.current = undefined; }}>
          <img ref={image} src={url} alt="待裁切图片" draggable={false} onLoad={event => {
            const element = event.currentTarget, size = { width: element.naturalWidth, height: element.naturalHeight };
            if (size.width < 1 || size.height < 1) { setLoading(false); setError("图片尺寸无效。"); return; }
            setNatural(size); setSelection(fullImageCrop(size)); setLoading(false);
          }} onError={() => { setLoading(false); setError("无法解码原始图片，请使用 PNG、JPG 或 WEBP 图片。"); }} />
          {natural && selection && <>
            <div className="image-crop-shade" style={{ left: 0, top: 0, width: "100%", height: selection.y / natural.height * 100 + "%" }} />
            <div className="image-crop-shade" style={{ left: 0, top: (selection.y + selection.height) / natural.height * 100 + "%", width: "100%", bottom: 0 }} />
            <div className="image-crop-shade" style={{ left: 0, top: selection.y / natural.height * 100 + "%", width: selection.x / natural.width * 100 + "%", height: selection.height / natural.height * 100 + "%" }} />
            <div className="image-crop-shade" style={{ left: (selection.x + selection.width) / natural.width * 100 + "%", right: 0, top: selection.y / natural.height * 100 + "%", height: selection.height / natural.height * 100 + "%" }} />
            <div className="image-crop-selection" data-crop-selection tabIndex={busy ? -1 : 0} role="group" aria-label="裁切区域，方向键移动，Shift 加速" style={{ left: selection.x / natural.width * 100 + "%", top: selection.y / natural.height * 100 + "%", width: selection.width / natural.width * 100 + "%", height: selection.height / natural.height * 100 + "%" }} onKeyDown={event => adjustWithKey(event)}>
              <div className="image-crop-grid" aria-hidden="true" />
              {handles.map(handle => <button key={handle.key} data-crop-handle={handle.key} className={`image-crop-handle handle-${handle.key}`} style={{ left: handle.left, top: handle.top }} aria-label={handle.label} disabled={busy} type="button" onKeyDown={event => adjustWithKey(event, handle.key)} />)}
            </div>
          </>}
        </div>}
        {loading && <div className="image-crop-loading" role="status">正在载入图片…</div>}
      </div>
      <footer className="image-crop-footer"><div className="image-crop-meta"><span>{pixels ? `${pixels.width} × ${pixels.height} 像素` : ""}</span>{error && <p role="alert">{error}</p>}</div><div className="image-crop-actions"><button type="button" disabled={busy || !natural} onClick={() => { finishDrag(); if (natural) setSelection(fullImageCrop(natural)); }}><RotateCcw size={16} />重置</button><button type="button" disabled={busy} onClick={close}>取消</button><button type="button" className="image-crop-apply" disabled={busy || loading || !natural || !selection} onClick={() => void apply()}>{busy ? "正在裁切…" : "应用裁切"}</button></div></footer>
    </div>
  </div>, document.body);
}
