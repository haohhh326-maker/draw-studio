import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Download, RefreshCw } from "lucide-react";
import { version as buildVersion } from "../../package.json";
import { Modal } from "../components/ui";
import { softwareUpdateMessage, updateIsActive, type SoftwareUpdateStatus, type SoftwareUpdateView } from "./software-update-client";
import "./software-update.css";

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function SoftwareUpdateProgress({ status }: { status: SoftwareUpdateStatus | null }) {
  const percent = typeof status?.percent === "number" && Number.isFinite(status.percent) ? Math.max(0, Math.min(100, status.percent)) : undefined;
  return <div className="software-update-progress">
    <progress aria-label="安装包下载进度" max={100} value={percent} />
    <div>
      <span>{typeof status?.downloadedBytes === "number" ? formatBytes(status.downloadedBytes) : "正在获取下载进度"}{status?.totalBytes ? ` / ${formatBytes(status.totalBytes)}` : ""}</span>
      <strong>{percent === undefined ? "" : `${Math.floor(percent)}%`}</strong>
    </div>
  </div>;
}

export function SoftwareUpdateDialog({ onClose, native, view, onCheck, onDownload }: {
  onClose: () => void;
  native: boolean;
  view: SoftwareUpdateView;
  onCheck: () => void;
  onDownload: () => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const { status, checking, pending, preparing, error, feedback } = view;
  const busy = checking || pending || updateIsActive(status);
  const phase = status?.phase || "idle";
  const shownError = error || status?.error;
  const progressVisible = preparing || pending || ["downloading", "verifying", "saving", "installing"].includes(phase);

  useEffect(() => {
    const previous = document.activeElement;
    layer.current?.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return createPortal(<div className="software-update-layer nodrag nopan nowheel" ref={layer}
    onPointerDown={event => event.stopPropagation()} onPaste={event => event.stopPropagation()}
    onDrop={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const buttons = Array.from(layer.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <Modal title="软件更新" onClose={onClose}>
      <div className="software-update-body">
        <dl className="software-update-versions">
          <div><dt>当前版本</dt><dd>{status?.currentVersion || buildVersion}</dd></div>
          {status?.latestVersion && <div><dt>最新版本</dt><dd>{status.latestVersion}</dd></div>}
        </dl>
        <p className={feedback ? "software-update-status software-update-feedback" : "software-update-status"} role="status" aria-busy={busy}>{softwareUpdateMessage(view, native)}</p>
        {progressVisible && <>
          <SoftwareUpdateProgress status={status} />
          <p className="software-update-hint">关闭此窗口后，下载进度会显示在右下角。</p>
        </>}
        {status?.releaseNotes && <section className="software-update-notes" aria-label="更新内容"><h3>更新内容</h3><p>{status.releaseNotes}</p></section>}
        {shownError && <p className="software-update-error" role="alert">{shownError}</p>}
        <div className="software-update-actions">
          <button type="button" disabled={!native || busy} onClick={onCheck}><RefreshCw size={15} aria-hidden="true" />{checking || phase === "checking" ? "检查中…" : "检查更新"}</button>
          {native && status?.configured && status.available && <button type="button" className="primary" disabled={busy} onClick={onDownload}><Download size={15} aria-hidden="true" />{busy && !checking ? "正在更新…" : shownError || phase === "error" ? "重试更新" : "下载并更新"}</button>}
        </div>
      </div>
    </Modal>
  </div>, document.body);
}
