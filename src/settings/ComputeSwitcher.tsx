import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, Cloud, FolderOpen, LoaderCircle, RefreshCw, Server, Settings, X } from "lucide-react";
import { computeEndpoint, isRunningHubProvider, nodeComputeState } from "../compute/providers";
import { canvasPopoverBounds } from "../components/topbar-popover";
import { IconButton } from "../components/ui";
import { activeCanvas, useStore } from "../stores/store";
import type { ComputeProvider } from "../types";
import { connectWorkstation } from "./connection-actions";
import { checkRunningHubConnection } from "./runninghub-connection-actions";
import type { ComputeSwitcherTarget } from "./compute-switcher-trigger";
import "./compute-settings.css";
import { useMuseSession, refreshMuseSession } from "../muse/session";

export function ComputeSwitcher({ anchorRef, target, onClose, onOpenSettings, onManageRunningHubWorkflows }: {
  anchorRef: RefObject<HTMLElement | null>;
  target?: ComputeSwitcherTarget;
  onClose: () => void;
  onOpenSettings: () => void;
  onManageRunningHubWorkflows: () => void;
}) {
  const scopedState = (state: ReturnType<typeof useStore.getState>) => target?.nodeId ? nodeComputeState(state, target.canvasId, target.nodeId) : state;
  const provider = useStore(state => scopedState(state).computeProvider);
  const canvas = useStore(activeCanvas);
  const scopeLabel = useStore(state => target?.nodeId
    ? state.project.canvases.find(item => item.id === target.canvasId)?.nodes.find(node => node.id === target.nodeId)?.data.title ?? "当前节点"
    : "新建节点默认算力");
  const runningHubMode = provider === "runninghub-workflow" ? "runninghub-workflow" : "runninghub";
  const runningHubSelected = isRunningHubProvider(provider);
  const muse = useMuseSession(state => state.session), museChecking = useMuseSession(state => state.checking);
  useEffect(() => { void refreshMuseSession(); }, []);
  const cloud = useStore(state => state.connection);
  const cloudState = useStore(state => state.connectionState);
  const cloudInfo = useStore(state => state.connectionInfo);
  const rhState = useStore(state => state.runningHubConnectionState);
  const rhInfo = useStore(state => state.runningHubConnectionInfo);
  const count = useStore(state => state.runningHubWorkflows.filter(workflow => workflow.runninghub?.kind === "app" && computeEndpoint(workflow.runninghub.baseUrl) === computeEndpoint(scopedState(state).runningHubConnection.baseUrl)).length);
  const workflowCount = useStore(state => state.runningHubWorkflows.filter(workflow => workflow.runninghub && workflow.runninghub.kind !== "app" && computeEndpoint(workflow.runninghub.baseUrl) === computeEndpoint(scopedState(state).runningHubConnection.baseUrl)).length);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 80, left: 16, width: 385, ready: false });
  const [lastRefresh, setLastRefresh] = useState<ComputeProvider | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const openingCanvasId = useRef(canvas.id);
  useEffect(() => {
    if (canvas.id !== openingCanvasId.current) closeRef.current();
  }, [canvas.id]);
  function focusAnchor() {
    const anchor = anchorRef.current;
    (anchor instanceof HTMLButtonElement ? anchor : anchor?.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
  }
  function closeAndFocus() { onClose(); focusAnchor(); }
  function chooseProvider(next: ComputeProvider) {
    const state = useStore.getState();
    if (target?.nodeId) state.setNodeComputeProvider(target.canvasId, target.nodeId, next);
    else state.setComputeProvider(next);
  }
  async function refreshConnection(next: ComputeProvider) {
    if (next === "muse") { setLastRefresh(next); await refreshMuseSession(); return; }
    const state = scopedState(useStore.getState());
    if ((isRunningHubProvider(next) ? state.runningHubConnectionState : state.connectionState) === "connecting") return;
    setLastRefresh(next);
    if (isRunningHubProvider(next)) await checkRunningHubConnection({ ...state.runningHubConnection });
    else await connectWorkstation({ ...state.connection });
  }
  useLayoutEffect(() => {
    const panel = panelRef.current, trigger = anchorRef.current, canvas = document.querySelector(".canvas-shell");
    if (!panel || !trigger) return;
    const generationPanel = trigger.closest(".generation-floating, .generation-anchor");
    const place = () => {
      let { left, top, width, margin } = canvasPopoverBounds(385, canvas?.getBoundingClientRect());
      if (generationPanel) {
        const minTop = Math.max(margin, (document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0) + margin);
        panel.style.maxHeight = Math.max(0, window.innerHeight - minTop - margin) + "px";
        const anchor = trigger.getBoundingClientRect(), height = panel.getBoundingClientRect().height;
        const maxTop = Math.max(minTop, window.innerHeight - height - margin);
        const above = anchor.top - height - 8, below = anchor.bottom + 8;
        left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));
        top = Math.max(minTop, Math.min(above >= minTop ? above : below <= maxTop ? below : above, maxTop));
      } else {
        panel.style.maxHeight = Math.max(0, window.innerHeight - top - margin) + "px";
      }
      setPosition(previous => previous.ready && previous.left === left && previous.top === top && previous.width === width ? previous : { top, left, width, ready: true });
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(trigger); observer.observe(panel); if (canvas) observer.observe(canvas);
    const movement = new MutationObserver(place);
    if (generationPanel) { observer.observe(generationPanel); movement.observe(generationPanel, { attributes: true, attributeFilter: ["style"] }); }
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); movement.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchorRef]);
  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !anchorRef.current?.contains(event.target)) closeRef.current(); };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); closeRef.current(); focusAnchor(); } };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", keydown, true); };
  }, [anchorRef]);
  const label = (status: "offline" | "connecting" | "connected") => status === "connected" ? "已连接" : status === "connecting" ? "检测中…" : "未连接";
  return createPortal(<div ref={panelRef} id="compute-switcher" role="dialog" aria-label="选择算力" className="compute-switcher nodrag nopan nowheel"
    style={{ top: position.top, left: position.left, width: position.width, visibility: position.ready ? "visible" : "hidden" }} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <header><div className="compute-switcher-heading"><strong>选择算力</strong><small>{scopeLabel}</small></div><IconButton title="关闭算力选择" onClick={closeAndFocus}><X size={16} /></IconButton></header>
    <div role="radiogroup" aria-label="当前算力" className="compute-provider-options">
      <div className={"compute-provider-option" + (provider === "comfyui" ? " selected" : "")}>
        <button type="button" role="radio" aria-checked={provider === "comfyui"} className="compute-provider-select" onClick={() => { chooseProvider("comfyui"); closeAndFocus(); }}>
          <Cloud size={21} aria-hidden="true" /><span className="compute-provider-label"><strong>{cloud.name || "云端 ComfyUI"}</strong><small>ComfyUI 工作流</small></span><span className={`compute-status ${cloudState}`} title={cloudInfo}>{label(cloudState)}</span><span className="compute-provider-check">{provider === "comfyui" && <Check size={16} aria-hidden="true" />}</span>
        </button>
        <IconButton title={cloudState === "connecting" ? "正在检测连接" : "刷新云端连接"} aria-label="刷新云端连接" className="compute-provider-refresh" disabled={cloudState === "connecting"} aria-busy={cloudState === "connecting"} onClick={() => void refreshConnection("comfyui")}>
          {cloudState === "connecting" ? <LoaderCircle size={16} className="compute-check-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
        </IconButton>
      </div>
      <div className={"compute-provider-option compute-runninghub-option" + (runningHubSelected ? " selected" : "")}>
        <button type="button" role="radio" aria-checked={runningHubSelected} className="compute-provider-select" onClick={() => { chooseProvider(runningHubMode); closeAndFocus(); }}>
          <Server size={21} aria-hidden="true" />
          <span className="compute-provider-label">
            <strong>RunningHub 工作站</strong>
            <small>{runningHubMode === "runninghub-workflow" ? `${workflowCount} 个远端工作流` : `${count} 个 AI 应用`}</small>
          </span>
          <span className="compute-provider-check">{runningHubSelected && <Check size={16} aria-hidden="true" />}</span>
        </button>
        <div className="compute-runninghub-controls">
          <div className="compute-runninghub-mode" role="group" aria-label="RunningHub 工作站模式">
            <button type="button" aria-pressed={runningHubMode === "runninghub"} onClick={() => chooseProvider("runninghub")}>AI 应用</button>
            <button type="button" aria-pressed={runningHubMode === "runninghub-workflow"} onClick={() => chooseProvider("runninghub-workflow")}>工作流</button>
          </div>
          <div className="compute-runninghub-status">
            <span className={`compute-status ${rhState}`} title={rhInfo}>{label(rhState)}</span>
            <IconButton title={rhState === "connecting" ? "正在检测连接" : "刷新 RunningHub 连接"} aria-label="刷新 RunningHub 连接" className="compute-provider-refresh" disabled={rhState === "connecting"} aria-busy={rhState === "connecting"} onClick={() => void refreshConnection(runningHubMode)}>
              {rhState === "connecting" ? <LoaderCircle size={16} className="compute-check-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
            </IconButton>
          </div>
        </div>
      </div>
      <div className={"compute-provider-option" + (provider === "muse" ? " selected" : "")}>
        <button type="button" role="radio" aria-checked={provider === "muse"} className="compute-provider-select" onClick={() => { chooseProvider("muse"); closeAndFocus(); }}>
          <Cloud size={21} /><span className="compute-provider-label"><strong>Muse</strong><small>网页账号 · 图片 / 视频</small></span><span className={`compute-status ${muse.status === "connected" ? "connected" : "offline"}`}>{muse.status === "connected" ? "已连接" : "未连接"}</span><span className="compute-provider-check">{provider === "muse" && <Check size={16} />}</span>
        </button>
        <IconButton title="刷新 Muse 连接" disabled={museChecking} onClick={() => void refreshConnection("muse")}><RefreshCw size={16} /></IconButton>
      </div>
    </div>
    {lastRefresh && <p className="compute-refresh-feedback" role="status">{lastRefresh === "muse" ? muse.message : isRunningHubProvider(lastRefresh) ? rhInfo : cloudInfo}</p>}
    <footer>
      <button type="button" onClick={onOpenSettings}><Settings size={15} aria-hidden="true" />算力设置</button>
      <button type="button" className="compute-runninghub-manage" onClick={() => {
        if (runningHubMode === "runninghub-workflow") useStore.setState({ modal: "runninghub-remote-workflows" });
        else onManageRunningHubWorkflows();
      }}><FolderOpen size={15} aria-hidden="true" />{runningHubMode === "runninghub-workflow" ? "添加 / 管理远端工作流" : "添加 / 管理 AI 应用"}</button>
    </footer>
  </div>, document.body);
}
