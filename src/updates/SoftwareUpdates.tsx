import { useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import { hasNativeWebview } from "../services/native-webview-bridge";
import { SoftwareUpdateDialog } from "./SoftwareUpdateDialog";
import { openSoftwareUpdate, softwareUpdateOpenEvent, updateInvoke, updateIsActive, type SoftwareUpdateStatus } from "./software-update-client";

let startupCheck: Promise<SoftwareUpdateStatus> | undefined;
function checkAtStartup() {
  return startupCheck ??= updateInvoke<SoftwareUpdateStatus>("get_software_update_status")
    .then(status => updateIsActive(status) && status.phase !== "checking" ? status : updateInvoke<SoftwareUpdateStatus>("check_software_update"));
}

export function SoftwareUpdates() {
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState<SoftwareUpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const show = () => {
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDismissed(true); setOpen(true);
    };
    window.addEventListener(softwareUpdateOpenEvent, show);
    let live = true;
    if (hasNativeWebview()) void checkAtStartup().then(status => {
      if (live && status.configured && status.available && !updateIsActive(status)) setAvailable(status);
    }).catch(() => { /* A manual check shows actionable errors without interrupting startup. */ });
    return () => { live = false; window.removeEventListener(softwareUpdateOpenEvent, show); };
  }, []);
  function close() {
    setOpen(false);
    requestAnimationFrame(() => { if (trigger.current?.isConnected) trigger.current.focus(); });
  }
  return <>
    {available && !dismissed && !open && <aside className="software-update-notice" aria-label="发现软件更新">
      <div role="status"><Download size={18} aria-hidden="true" /><span>发现新版本 {available.latestVersion}</span></div>
      <button type="button" className="primary" onClick={openSoftwareUpdate}>查看更新</button>
      <button type="button" className="software-update-dismiss" aria-label="稍后提醒" onClick={() => setDismissed(true)}><X size={16} aria-hidden="true" /></button>
    </aside>}
    {open && <SoftwareUpdateDialog onClose={close} />}
  </>;
}
