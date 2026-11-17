import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Minus, Plus, RefreshCw, X } from "lucide-react";
import { hasNativeWebview, nativeWebviewInvoke } from "./native-webview-bridge";
import { primeNativeServiceAuth } from "./service-auth";
import { openSoftwareUpdate, softwareUpdateMessage, updateIsActive, useSoftwareUpdateView } from "../updates/software-update-client";
import "./canvas-service-panel.css";

export type CanvasService = "muse" | "deepseek";
type Position = { left: number; top: number };
type Bounds = { x: number; y: number; width: number; height: number };
const owners = new Map<CanvasService, symbol>();

function boundsOf(element: HTMLElement): Bounds {
  const rect = element.getBoundingClientRect();
  return { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
}
function panelTopInset(parentBounds: DOMRect) {
  const toolbarBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? parentBounds.top;
  return Math.max(8, toolbarBottom - parentBounds.top + 8);
}
function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
}

/** The desktop runtime hosts a real child WebView2 inside this panel. */
export function NativeCanvasServicePanel({ service, onClose }: { service: CanvasService; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const syncBounds = useRef<() => void>(() => {});
  const [position, setPosition] = useState<Position | null>(null);
  const [status, setStatus] = useState<"loading" | "connected" | "error">("loading");
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const desktop = hasNativeWebview();
  const name = service === "muse" ? "Muse" : "DeepSeek";
  const update = useSoftwareUpdateView();
  const updatePhase = update.status?.phase;
  const updateVisible = update.pending || updateIsActive(update.status) && updatePhase !== "checking"
    || update.actionStarted && (!!update.error || updatePhase === "error");
  const updatePercent = typeof update.status?.percent === "number" && Number.isFinite(update.status.percent)
    ? Math.max(0, Math.min(100, update.status.percent)) : undefined;
  const updateLabel = update.preparing || updatePhase === "saving" ? "保存中"
    : updatePhase === "verifying" ? "校验中" : updatePhase === "installing" ? "安装中"
    : update.error || updatePhase === "error" ? "失败" : updatePercent === undefined ? "下载中" : `${Math.floor(updatePercent)}%`;

  useEffect(() => {
    const element = surface.current;
    if (!desktop || !element) return;
    const owner = Symbol(service);
    owners.set(service, owner);
    let disposed = false;
    let opened = false;
    let raf = 0;
    let pending: Bounds | null = null;
    let sending = false;
    let lastSent = "";
    const flush = async () => {
      if (!opened || sending || disposed) return;
      sending = true;
      try {
        while (pending && !disposed && owners.get(service) === owner) {
          const next = pending;
          pending = null;
          const signature = JSON.stringify(next);
          if (signature !== lastSent) {
            await nativeWebviewInvoke("set_service_webview_bounds", service, next);
            lastSent = signature;
          }
        }
      } catch (cause) {
        if (!disposed) { setStatus("error"); setError(message(cause, name + " 网页位置调整失败。")); }
      } finally {
        sending = false;
        if (pending && !disposed) void flush();
      }
    };
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; pending = boundsOf(element); void flush(); });
    };
    syncBounds.current = schedule;
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const show = nativeWebviewInvoke("show_service_webview", service, boundsOf(element))
      .then(() => {
        opened = true;
        if (disposed || owners.get(service) !== owner) return;
        setStatus("connected"); setError(""); schedule();
        void primeNativeServiceAuth(service).catch(cause => {
          if (!disposed && owners.get(service) === owner)
            setError(name + " 已打开，但" + message(cause, "登录同步失败。"));
        });
      })
      .catch(cause => {
        if (disposed || owners.get(service) !== owner) return;
        setStatus("error"); setError(message(cause, name + " 内置浏览器启动失败。"));
      });
    return () => {
      disposed = true;
      if (owners.get(service) === owner) owners.delete(service);
      syncBounds.current = () => {};
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (raf) cancelAnimationFrame(raf);
      // A StrictMode effect replay must not hide the replacement view.
      void show.finally(() => { if (!owners.has(service)) void nativeWebviewInvoke("hide_service_webview", service).catch(() => {}); });
    };
  }, [desktop, name, service]);

  useLayoutEffect(() => { syncBounds.current(); }, [position]);
  useEffect(() => {
    const element = panel.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const keepVisible = () => {
      const parentBounds = parent.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const minimumTop = panelTopInset(parentBounds);
      setPosition(current => {
        if (!current) return current;
        const left = Math.max(8, Math.min(current.left, Math.max(8, parentBounds.width - rect.width - 8)));
        const top = Math.max(minimumTop, Math.min(current.top, Math.max(minimumTop, parentBounds.height - rect.height - 8)));
        return left === current.left && top === current.top ? current : { left, top };
      });
      syncBounds.current();
    };
    const observer = new ResizeObserver(keepVisible);
    observer.observe(element); observer.observe(parent);
    window.addEventListener("resize", keepVisible);
    return () => { observer.disconnect(); window.removeEventListener("resize", keepVisible); };
  }, []);

  const dragStart = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { x: event.clientX - rect.left, y: event.clientY - rect.top, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const dragMove = (event: PointerEvent<HTMLElement>) => {
    if (!drag.current || !panel.current) return;
    const parent = panel.current.parentElement?.getBoundingClientRect();
    const rect = panel.current.getBoundingClientRect();
    if (!parent) return;
    const minimumTop = panelTopInset(parent);
    const left = Math.max(8, Math.min(event.clientX - parent.left - drag.current.x, parent.width - rect.width - 8));
    const top = Math.max(minimumTop, Math.min(event.clientY - parent.top - drag.current.y, parent.height - rect.height - 8));
    // Keep the child WebView tracking the pointer without a React render per move.
    panel.current.style.left = `${left}px`;
    panel.current.style.top = `${top}px`;
    drag.current.moved = true;
    syncBounds.current();
  };
  const dragEnd = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.moved && panel.current) {
      setPosition({ left: parseFloat(panel.current.style.left), top: parseFloat(panel.current.style.top) });
    }
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const reload = useCallback(async () => {
    if (!desktop) return;
    try {
      setStatus("loading");
      await nativeWebviewInvoke("reload_service_webview", service);
      setStatus("connected"); setError("");
    } catch (cause) { setStatus("error"); setError(message(cause, name + " 页面刷新失败。")); }
  }, [desktop, name, service]);
  const changeZoom = async (next: number) => {
    if (!desktop) return;
    try {
      await nativeWebviewInvoke("set_service_webview_zoom", service, { zoom: next });
      setZoom(next); setError("");
    } catch (cause) { setError(message(cause, name + " 页面缩放失败。")); }
  };

  return <section id="canvas-service-panel" ref={panel} className="canvas-service-panel nodrag nopan nowheel"
    role="dialog" aria-modal="false" aria-label={name + " 原聊天窗口"} style={position ?? undefined}
    onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
    <header className="canvas-service-panel-header" onPointerDown={dragStart} onPointerMove={dragMove}
      onPointerUp={dragEnd} onPointerCancel={dragEnd}>
      <div className="canvas-service-panel-title">
        <img src={service === "muse" ? "/brands/muse.svg" : "/brands/deepseek.ico"} alt="" aria-hidden="true" />
        <strong>{name}</strong><small>内置浏览器</small>
        <span className={"canvas-service-status-dot " + status}
          aria-label={status === "connected" ? "网页视图已打开" : status === "loading" ? "正在打开网页视图" : "网页视图打开失败"} />
        {error && <span className="canvas-service-header-error" role="alert" title={error}>{error}</span>}
      </div>
      <div className="canvas-service-panel-tools">
        {updateVisible && <button type="button" className="canvas-service-update" aria-label="查看软件更新进度"
          title={softwareUpdateMessage(update)} data-error={!!update.error || updatePhase === "error"} onClick={openSoftwareUpdate}>
          <span>软件更新 {updateLabel}</span>
          <progress aria-label="软件更新下载进度" max={100} value={update.preparing ? undefined : updatePercent} />
        </button>}
        <button type="button" className="icon-button canvas-service-zoom-button" title="缩小网页" aria-label="缩小网页"
          disabled={zoom <= 0.5} onClick={() => void changeZoom(Math.max(0.5, Number((zoom - 0.25).toFixed(2))))}><Minus size={17} /></button>
        <span className="canvas-service-zoom-label">{Math.round(zoom * 100)}%</span>
        <button type="button" className="icon-button canvas-service-zoom-button" title="放大网页" aria-label="放大网页"
          disabled={zoom >= 2.5} onClick={() => void changeZoom(Math.min(2.5, Number((zoom + 0.25).toFixed(2))))}><Plus size={17} /></button>
        <button type="button" className="icon-button" title="刷新网页" aria-label="刷新网页" onClick={() => void reload()}><RefreshCw size={17} /></button>
        <button type="button" className="icon-button" title="关闭聊天窗口" aria-label="关闭聊天窗口" onClick={onClose}><X size={18} /></button>
      </div>
    </header>
    <div ref={surface} className="canvas-service-view canvas-service-native-view" role="application" aria-label={name + " 网页视图"}>
      {!desktop && <div className="canvas-service-native-message" role="status">高清实时网页视图需要在 Draw studio 桌面版中打开。</div>}
      {desktop && status === "loading" && <div className="canvas-service-native-message" role="status">正在打开 {name} 网页…</div>}
      {error && <div className="canvas-service-view-error" role="alert">{error}</div>}
    </div>
  </section>;
}
