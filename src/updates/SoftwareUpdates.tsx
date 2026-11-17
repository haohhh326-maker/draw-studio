import { useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import { hasNativeWebview } from "../services/native-webview-bridge";
import { useStore } from "../stores/store";
import { SoftwareUpdateDialog, SoftwareUpdateProgress } from "./SoftwareUpdateDialog";
import { checkSoftwareUpdates, downloadSoftwareUpdate, initializeSoftwareUpdates, openSoftwareUpdate,
  refreshSoftwareUpdateStatus, softwareUpdateMessage, softwareUpdateOpenEvent, updateIsActive, useSoftwareUpdateView } from "./software-update-client";

async function saveBeforeUpdate() {
  if (window.drawStudioSaveBeforeExit) await window.drawStudioSaveBeforeExit();
  else {
    const state = useStore.getState();
    if (state.ready && state.projectOpen) await state.save(true);
  }
}

export function SoftwareUpdates() {
  const [native] = useState(hasNativeWebview);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const view = useSoftwareUpdateView();
  const { status, pending, preparing, actionStarted, error } = view;
  const active = pending || updateIsActive(status);
  const transferVisible = preparing || pending || ["downloading", "verifying", "saving", "installing"].includes(status?.phase || "")
    || actionStarted && (!!error || status?.phase === "error");

  useEffect(() => {
    const show = () => {
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDismissed(true); setOpen(true);
      if (native) void refreshSoftwareUpdateStatus().then(() => {
        const current = useSoftwareUpdateView.getState();
        if (!current.error && current.status?.phase !== "error") return checkSoftwareUpdates();
      }).catch(() => {});
    };
    window.addEventListener(softwareUpdateOpenEvent, show);
    if (native) void initializeSoftwareUpdates().catch(() => { /* A manual check exposes startup errors. */ });
    return () => window.removeEventListener(softwareUpdateOpenEvent, show);
  }, [native]);

  useEffect(() => {
    if (!native || !active || preparing) return;
    void refreshSoftwareUpdateStatus().catch(() => {});
    const timer = window.setInterval(() => void refreshSoftwareUpdateStatus().catch(() => {}), 500);
    return () => window.clearInterval(timer);
  }, [native, active, preparing, status?.phase]);

  function close() {
    setOpen(false);
    requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus();
      else document.querySelector<HTMLButtonElement>(".software-update-button")?.focus();
    });
  }

  return <>
    {native && transferVisible && !open && <aside className="software-update-notice software-update-transfer" aria-label="软件更新进度" data-error={!!error || status?.phase === "error"}>
      <div className="software-update-transfer-status" role={error || status?.phase === "error" ? "alert" : "status"}>
        <Download size={18} aria-hidden="true" />
        <div><strong>{status?.latestVersion ? `更新至 ${status.latestVersion}` : "软件更新"}</strong><span>{softwareUpdateMessage(view)}</span></div>
      </div>
      <button type="button" className="primary" onClick={openSoftwareUpdate}>查看进度</button>
      <SoftwareUpdateProgress status={status} />
    </aside>}
    {native && status?.configured && status.available && !active && !transferVisible && !dismissed && !open && <aside className="software-update-notice" aria-label="发现软件更新">
      <div role="status"><Download size={18} aria-hidden="true" /><span>发现新版本 {status.latestVersion}</span></div>
      <button type="button" className="primary" onClick={openSoftwareUpdate}>查看更新</button>
      <button type="button" className="software-update-dismiss" aria-label="稍后提醒" onClick={() => setDismissed(true)}><X size={16} aria-hidden="true" /></button>
    </aside>}
    {open && <SoftwareUpdateDialog native={native} view={view} onClose={close}
      onCheck={() => void checkSoftwareUpdates().catch(() => {})}
      onDownload={() => void downloadSoftwareUpdate(saveBeforeUpdate)} />}
  </>;
}
