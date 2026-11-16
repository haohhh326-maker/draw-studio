import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Cloud, ExternalLink } from "lucide-react";
import { useStore } from "../stores/store";
import { canvasPopoverBounds, CONNECTION_POPOVER_HEIGHT, CONNECTION_POPOVER_WIDTH } from "../components/topbar-popover";
import { connectWorkstation } from "./connection-actions";
import { ConnectionCheckButton } from "./ConnectionCheckButton";
import type { Connection } from "../types";
import { isRunningHubNativeConnection, normalizeRunningHubNativeConnection } from "../runninghub/native-connection";
import "./settings.css";

export type ConnectionDraft = Pick<Connection, "name" | "baseUrl" | "token" | "authHeader" | "authPrefix">;

export function connectionDraft(connection: Connection): ConnectionDraft {
  if (isRunningHubNativeConnection(connection)) connection = normalizeRunningHubNativeConnection(connection);
  return {
    name: connection.name,
    baseUrl: connection.baseUrl,
    token: connection.token,
    authHeader: connection.authHeader,
    authPrefix: connection.authPrefix,
  };
}

/** A pasted official URL is split before React renders it in a visible field. */
export function updateConnectionDraft(draft: ConnectionDraft, field: keyof ConnectionDraft, value: string): ConnectionDraft {
  if ((field === "baseUrl" || field === "token") && isRunningHubNativeConnection({ baseUrl: value })) {
    const native = isRunningHubNativeConnection(draft);
    const parsed = normalizeRunningHubNativeConnection({ ...draft, name: native ? draft.name : "RunningHub 原生 ComfyUI", baseUrl: value, token: "", timeoutMinutes: 60 });
    if (native && !parsed.token) parsed.token = draft.token;
    return connectionDraft(parsed);
  }
  return { ...draft, [field]: value };
}

export function saveConnectionDraft(current: Connection, draft: ConnectionDraft) {
  let connection: Connection = {
    ...current,
    name: draft.name.trim() || "ComfyUI",
    baseUrl: draft.baseUrl.trim(),
    token: draft.token.trim(),
    authHeader: draft.authHeader.trim() || "Authorization",
    // An empty prefix is a valid configuration for services that expect a raw token.
    authPrefix: draft.authPrefix,
  };
  if (isRunningHubNativeConnection(connection)) connection = normalizeRunningHubNativeConnection(connection);
  return {
    connection,
    endpointChanged: current.baseUrl !== connection.baseUrl,
    authenticationChanged: current.token !== connection.token
      || current.authHeader !== connection.authHeader
      || current.authPrefix !== connection.authPrefix,
  };
}

export function ConnectionPopover({ anchorRef, onClose }: { anchorRef: RefObject<HTMLElement | null>; onClose: () => void }) {
  const connection = useStore(s => s.connection), status = useStore(s => s.connectionState), info = useStore(s => s.connectionInfo);
  const [draft, setDraft] = useState<ConnectionDraft>(() => connectionDraft(connection));
  const native = isRunningHubNativeConnection(draft);
  const [addressOpen, setAddressOpen] = useState(false);
  const [position, setPosition] = useState({ top: 80, left: 16, width: CONNECTION_POPOVER_WIDTH, ready: false });
  const panel = useRef<HTMLDivElement>(null);
  const addressButton = useRef<HTMLButtonElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const closeRef = useRef(() => {});
  function save() {
    const current = useStore.getState().connection;
    const { connection: next, endpointChanged, authenticationChanged } = saveConnectionDraft(current, draft);
    if (endpointChanged || authenticationChanged) {
      useStore.setState({ connection: next, connectionState: "offline", connectionInfo: endpointChanged && authenticationChanged ? "远程地址和认证已更改，等待检测。" : endpointChanged ? "远程地址已更改，等待检测。" : "连接认证已更改，等待检测。" });
    } else if (current.name !== next.name) useStore.setState({ connection: next });
    return next;
  }
  useLayoutEffect(() => { closeRef.current = () => { save(); onClose(); }; });
  useEffect(() => { addressButton.current?.focus(); }, []);
  useEffect(() => { if (addressOpen) addressInput.current?.focus(); }, [addressOpen]);
  useLayoutEffect(() => {
    const trigger = anchorRef.current, dialog = panel.current, canvas = document.querySelector(".canvas-shell");
    if (!trigger || !dialog) return;
    const place = () => {
      const { left, top, width, margin } = canvasPopoverBounds(CONNECTION_POPOVER_WIDTH, canvas?.getBoundingClientRect());
      const availableHeight = Math.max(0, window.innerHeight - top - margin);
      dialog.style.maxHeight = availableHeight + "px";
      dialog.style.minHeight = Math.min(CONNECTION_POPOVER_HEIGHT, availableHeight) + "px";
      setPosition(previous => previous.ready && previous.top === top && previous.left === left && previous.width === width
        ? previous : { top, left, width, ready: true });
    };
    place();
    const resize = new ResizeObserver(place); resize.observe(trigger); resize.observe(dialog); if (canvas) resize.observe(canvas);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { resize.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchorRef]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchorRef.current?.contains(event.target)) closeRef.current();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); anchorRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); } };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [anchorRef]);
  return createPortal(<div ref={panel} id="connection-popover" className={"connection-popover nodrag nopan" + (addressOpen ? " address-open" : "")} role="dialog" aria-label="连接设置"
    style={{ left: position.left, top: position.top, width: position.width, visibility: position.ready ? "visible" : "hidden" }}>
    <div className="connection-popover-actions">
      <div className="connection-card-identity">
        <span className="connection-card-selected" aria-hidden="true" />
        <Cloud size={18} aria-hidden="true" />
        <strong title={connection.name || "ComfyUI"}>{connection.name || "ComfyUI"}</strong>
      </div>
      <span className={"connection-card-status " + status} role="status"><i aria-hidden="true" />{status === "connected" ? "已连接" : status === "connecting" ? "连接中" : "未连接"}</span>
      <button type="button" ref={addressButton} className="connection-address-toggle" aria-expanded={addressOpen} aria-controls="connection-address-fields"
        onClick={() => { if (addressOpen) save(); setAddressOpen(!addressOpen); }}><ExternalLink size={16} aria-hidden="true" />连接设置</button>
      <ConnectionCheckButton getConnection={save} refreshIcon />
    </div>
    {addressOpen && native ? <div id="connection-address-fields" className="connection-address-fields">
      <p>RunningHub 原生 ComfyUI · {draft.baseUrl.endsWith("/proxy-plus") ? "高配版 48G" : "标准版 24G"}</p>
      <p>消费级会员 Key · RH 币 / 钱包</p>
      <button type="button" onClick={() => { save(); onClose(); useStore.setState({ modal: "settings" }); }}>管理原生连接与 Key</button>
    </div> : addressOpen && <div id="connection-address-fields" className="connection-address-fields">
      <label>连接名称<input aria-label="连接名称" value={draft.name} onChange={event => setDraft(d => ({ ...d, name: event.target.value }))}
        onBlur={save} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); save(); } }} /></label>
      <label>远程地址<div className="connection-address-input"><input ref={addressInput} aria-label="远程地址" placeholder="http://127.0.0.1:8188"
        value={draft.baseUrl} onChange={event => {
          try { setDraft(updateConnectionDraft(draft, "baseUrl", event.target.value)); }
          catch { useStore.getState().notify("RunningHub 原生地址无效，请在算力设置中选择版本并填写 Key。"); }
        }} onBlur={save}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void connectWorkstation(save()); } }} />
        </div></label>
      <label>访问令牌<input type="password" aria-label="访问令牌" autoComplete="off" spellCheck={false} placeholder="保存到本机，刷新后自动恢复"
        value={draft.token} onChange={event => setDraft(d => ({ ...d, token: event.target.value }))} onBlur={save}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void connectWorkstation(save()); } }} /></label>
      <details className="connection-auth-details">
        <summary>认证方式（可选）</summary>
        <label>认证头<input aria-label="认证头" autoComplete="off" spellCheck={false} placeholder="Authorization"
          value={draft.authHeader} onChange={event => setDraft(d => ({ ...d, authHeader: event.target.value }))} onBlur={save} /></label>
        <label>认证前缀<input aria-label="认证前缀" autoComplete="off" spellCheck={false} placeholder="Bearer "
          value={draft.authPrefix} onChange={event => setDraft(d => ({ ...d, authPrefix: event.target.value }))} onBlur={save} /></label>
      </details>
    </div>}
    {status === "offline" && info.startsWith("连接失败：") && <p className="connection-popover-error" role="status">{info}</p>}
  </div>, document.body);
}
