import { useEffect, useRef } from "react";
import { Check, CircleX, LoaderCircle, PlugZap, RefreshCw } from "lucide-react";
import { IconButton } from "../components/ui";
import { useStore } from "../stores/store";
import { connectWorkstation } from "./connection-actions";
import type { Connection } from "../types";
import "./remote-connection.css";

export function ConnectionCheckButton({ getConnection, showLabel = false, refreshIcon = false }: { getConnection?: () => Connection; showLabel?: boolean; refreshIcon?: boolean } = {}) {
  const connection = useStore(state => state.connection), status = useStore(state => state.connectionState), info = useStore(state => state.connectionInfo);
  const checking = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function check() {
    const state = useStore.getState();
    if (checking.current || state.connectionState === "connecting") return;
    const snapshot = { ...(getConnection?.() ?? state.connection) };
    const expected = JSON.stringify([snapshot.baseUrl, snapshot.token, snapshot.authHeader, snapshot.authPrefix]);
    checking.current = true;
    try {
      await connectWorkstation(snapshot);
      const current = useStore.getState();
      if (!mounted.current || expected !== JSON.stringify([current.connection.baseUrl, current.connection.token, current.connection.authHeader, current.connection.authPrefix])) return;
      if (current.connectionState === "connected") current.notify("连接检测通过。" + current.connectionInfo);
      else if (current.connectionState === "offline") current.notify(current.connectionInfo || "连接检测失败，请检查远程地址。");
    } finally { checking.current = false; }
  }
  const title = status === "connecting" ? "正在检测连接" : status === "connected" ? "连接检测通过（本次检测） · " + info : info.startsWith("连接失败：") ? info : "检测连接";
  return <IconButton title={title} aria-label="检测连接" data-connection-check className={"icon-button connection-check-button " + status + (showLabel ? " with-label" : "") + (refreshIcon ? " refresh-control" : "")}
    disabled={status === "connecting" || (!getConnection && !connection.baseUrl.trim())} aria-busy={status === "connecting"} onClick={() => void check()}>
    {status === "connecting" ? <LoaderCircle size={refreshIcon ? 21 : 18} className="connection-spin" /> : refreshIcon ? <RefreshCw size={21} /> : status === "connected" ? <Check size={18} /> : info.startsWith("连接失败：") ? <CircleX size={18} /> : <PlugZap size={18} />}
    {showLabel && <span>{status === "connecting" ? "检测中…" : "检测连接"}</span>}
  </IconButton>;
}
