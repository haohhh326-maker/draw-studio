import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, RefreshCw } from "lucide-react";
import { version as buildVersion } from "../../package.json";
import { Modal } from "../components/ui";
import { hasNativeWebview } from "../services/native-webview-bridge";
import { useStore } from "../stores/store";
import { updateInvoke, updateIsActive, type SoftwareUpdateAction, type SoftwareUpdateStatus } from "./software-update-client";
import "./software-update.css";

const phaseLabels = { idle: "", checking: "正在检查更新…", downloading: "正在下载安装包…", verifying: "正在校验安装包…", saving: "正在保存项目，准备安装更新…", installing: "正在启动新版安装程序…", error: "软件更新未完成，请重试。" };
function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function SoftwareUpdateDialog({ onClose }: { onClose: () => void }) {
  const [native] = useState(hasNativeWebview);
  const [status, setStatus] = useState<SoftwareUpdateStatus | null>(null);
  const [checking, setChecking] = useState(native);
  const [requestPending, setRequestPending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const layer = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const busy = checking || requestPending || updateIsActive(status);

  async function check() {
    setChecking(true); setError(""); setFeedback("");
    try {
      const next = await updateInvoke<SoftwareUpdateStatus>("check_software_update");
      if (mounted.current) setStatus(next);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "检查更新失败，请重试。");
    } finally {
      if (mounted.current) setChecking(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    layer.current?.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')?.focus();
    let live = true;
    if (native) void updateInvoke<SoftwareUpdateStatus>("get_software_update_status").then(next => {
      if (!live) return;
      setStatus(next);
      if (updateIsActive(next) || next.phase === "error") setChecking(false);
      else void check();
    }).catch(cause => {
      if (live) { setChecking(false); setError(cause instanceof Error ? cause.message : "无法读取更新状态，请重试。"); }
    });
    return () => {
      live = false; mounted.current = false;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [native]);

  useEffect(() => {
    if (!native || !(requestPending || updateIsActive(status))) return;
    let live = true, reading = false;
    async function refresh() {
      if (reading) return;
      reading = true;
      try {
        const next = await updateInvoke<SoftwareUpdateStatus>("get_software_update_status");
        if (live) setStatus(next);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : "无法读取更新进度，请重试。");
      } finally { reading = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => { live = false; window.clearInterval(timer); };
  }, [native, requestPending, status?.phase]);

  async function downloadAndUpdate() {
    if (busy) return;
    setRequestPending(true); setPreparing(true); setError(""); setFeedback("");
    try {
      if (window.drawStudioSaveBeforeExit) await window.drawStudioSaveBeforeExit();
      else {
        const state = useStore.getState();
        if (state.ready && state.projectOpen) await state.save(true);
      }
      if (mounted.current) setPreparing(false);
      const result = await updateInvoke<SoftwareUpdateAction | undefined>("open_software_update");
      if (mounted.current) {
        setFeedback(result?.message || "已启动新版安装程序。");
        setStatus(previous => previous && ({ ...previous, phase: "installing", message: "已启动新版安装程序。", error: undefined }));
      }
    } catch (cause) {
      if (mounted.current) {
        const message = cause instanceof Error ? cause.message : "更新失败，请重试。";
        setError(message);
        setStatus(previous => previous && ({ ...previous, phase: "error", message, error: message }));
      }
    } finally {
      if (mounted.current) { setRequestPending(false); setPreparing(false); }
    }
  }

  const phase = status?.phase || "idle";
  const progressVisible = ["downloading", "verifying", "saving", "installing"].includes(phase);
  const percent = typeof status?.percent === "number" && Number.isFinite(status.percent) ? Math.max(0, Math.min(100, status.percent)) : undefined;
  const message = !native ? "请从桌面版使用软件更新。"
    : preparing ? "正在保存当前项目…"
    : checking ? "正在检查更新…"
    : status && !status.configured ? "软件更新服务尚未启用，请稍后检查。"
    : status?.message || phaseLabels[phase] || (status?.available ? "有新版本可供下载。" : status ? "当前已是最新版本。" : "点击检查更新，获取最新版本。");
  const shownError = error || status?.error;

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
        <p className="software-update-status" role="status" aria-busy={busy}>{message}</p>
        {progressVisible && <div className="software-update-progress">
          <progress aria-label="安装包下载进度" max={100} value={percent} />
          <div><span>{typeof status?.downloadedBytes === "number" ? formatBytes(status.downloadedBytes) : "正在获取下载进度"}{status?.totalBytes ? ` / ${formatBytes(status.totalBytes)}` : ""}</span><strong>{percent === undefined ? "" : `${Math.floor(percent)}%`}</strong></div>
          <p>更新将在当前项目保存后启动安装，关闭此窗口仍会继续下载。</p>
        </div>}
        {status?.releaseNotes && <section className="software-update-notes" aria-label="更新内容"><h3>更新内容</h3><p>{status.releaseNotes}</p></section>}
        {shownError && <p className="software-update-error" role="alert">{shownError}</p>}
        {feedback && <p className="software-update-feedback">{feedback}</p>}
        <div className="software-update-actions">
          <button type="button" disabled={!native || busy} onClick={() => void check()}><RefreshCw size={15} aria-hidden="true" />{checking || phase === "checking" ? "检查中…" : "检查更新"}</button>
          {native && status?.configured && status.available && <button type="button" className="primary" disabled={busy} onClick={() => void downloadAndUpdate()}><Download size={15} aria-hidden="true" />{busy && !checking ? "正在更新…" : phase === "error" ? "重试更新" : "下载并更新"}</button>}
        </div>
      </div>
    </Modal>
  </div>, document.body);
}
