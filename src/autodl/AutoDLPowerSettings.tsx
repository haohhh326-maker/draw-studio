import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "../stores/store";
import type { Connection } from "../types";
import { checkAutoDLSettings, getAutoDLStatus, retryAutoDLShutdown, saveAutoDLSettings } from "./client";
import { sameAutoDLEndpoint } from "./endpoint";
import type { AutoDLPowerStatus } from "./types";
import "./AutoDLPowerSettings.css";

const phaseLabels = { disabled: "未启用", unknown: "尚未检测实例状态", off: "实例已关机", starting: "正在开机", ready: "实例已就绪", stopping: "正在关机", error: "操作未完成" };

function errorText(cause: unknown, token = "") {
  const text = cause instanceof Error ? cause.message : "AutoDL 操作失败，请重试。";
  return token ? text.split(token).join("[已隐藏]") : text;
}

function bindSavedSettings(status: AutoDLPowerStatus) {
  const current = useStore.getState().connection;
  if (!sameAutoDLEndpoint(current.baseUrl, status.settings.endpoint)) return;
  useStore.setState({ connection: { ...current,
    autodl: status.settings.enabled ? { instanceUuid: status.settings.instanceUuid } : undefined } });
}

export function AutoDLPowerSettings({ connection, connectionChanged }: { connection: Connection; connectionChanged: boolean }) {
  const headingId = useId();
  const [status, setStatus] = useState<AutoDLPowerStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [instanceUuid, setInstanceUuid] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "stop" | null>(null);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const mounted = useRef(false), operation = useRef(false), initialized = useRef(false), revision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let disposed = false, reading = false;
    const refresh = async () => {
      if (reading || operation.current) return;
      reading = true;
      const observed = revision.current;
      try {
        const next = await getAutoDLStatus();
        if (disposed || observed !== revision.current) return;
        setStatus(next); setReadError("");
        if (!initialized.current) {
          setEnabled(next.settings.enabled); setInstanceUuid(next.settings.instanceUuid);
          initialized.current = true;
        }
      } catch (cause) {
        if (!disposed && observed === revision.current) { setReadError(errorText(cause)); initialized.current = true; }
      } finally {
        reading = false;
        if (!disposed) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { disposed = true; mounted.current = false; window.clearInterval(timer); };
  }, []);

  async function save() {
    if (operation.current) return;
    if (connectionChanged) { setError("请先保存上方远程连接，再保存自动开关机配置。"); return; }
    const current = useStore.getState().connection;
    if (!sameAutoDLEndpoint(current.baseUrl, connection.baseUrl)) { setError("远程连接已变更，请重新打开设置后保存。"); return; }
    if (!current.baseUrl.trim()) { setError("请先保存远程连接地址。"); return; }
    if (enabled && !instanceUuid.trim()) { setError("请填写 AutoDL 实例 ID。"); return; }
    const token = apiToken.trim();
    if (enabled && !token && !status?.settings.tokenConfigured) { setError("请填写 AutoDL 开发者 Token。"); return; }
    operation.current = true; ++revision.current;
    setBusy("save"); setError(""); setReadError("");
    try {
      const saved = await saveAutoDLSettings({ enabled, endpoint: current.baseUrl, instanceUuid: instanceUuid.trim(), ...(token ? { apiToken: token } : {}) });
      bindSavedSettings(saved);
      if (mounted.current) {
        setStatus(saved); setEnabled(saved.settings.enabled); setInstanceUuid(saved.settings.instanceUuid); setApiToken("");
      }
      if (enabled) {
        const checked = await checkAutoDLSettings();
        bindSavedSettings(checked);
        if (mounted.current) setStatus(checked);
      }
    } catch (cause) { if (mounted.current) setError(errorText(cause, token)); }
    finally {
      ++revision.current; operation.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  async function retryStop() {
    if (operation.current) return;
    operation.current = true; ++revision.current;
    setBusy("stop"); setError(""); setReadError("");
    try {
      const next = await retryAutoDLShutdown();
      if (mounted.current) setStatus(next);
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally {
      ++revision.current; operation.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  const shownError = error || readError || status?.error;
  const differentEndpoint = status?.settings.enabled && !sameAutoDLEndpoint(status.settings.endpoint, connection.baseUrl);
  const changed = status && (enabled !== status.settings.enabled || instanceUuid.trim() !== status.settings.instanceUuid || !!apiToken.trim());
  const powerChangingBlocked = (status?.activeTasks ?? 0) > 0 || !!status?.pendingStop;
  return <section className="autodl-power-settings" aria-labelledby={headingId}>
    <header><h3 id={headingId}>AutoDL 自动开关机</h3><label className="autodl-power-enable">
      <input type="checkbox" aria-label="启用 AutoDL 自动开关机" checked={enabled} disabled={loading || !!busy || powerChangingBlocked}
        title={powerChangingBlocked ? "请等待所有任务结束并确认关机后再更改。" : undefined}
        onChange={event => { setEnabled(event.target.checked); setError(""); }} />启用
    </label></header>
    <p className="autodl-power-description">点击生成时自动开机，结果全部保存后立即关机。同一实例有多个任务时，最后一个任务结束才关机。</p>
    <div className="autodl-power-fields">
      <label>实例 ID<input aria-label="AutoDL 实例 ID" autoComplete="off" spellCheck={false} value={instanceUuid} disabled={loading || !!busy || !enabled}
        onChange={event => { setInstanceUuid(event.target.value); setError(""); }} /></label>
      <label><span className="autodl-power-token-heading">开发者 Token<a href="https://www.autodl.com/console/center/settings/token" target="_blank" rel="noreferrer">获取开发者 Token</a></span>
        <input type="password" aria-label="AutoDL 开发者 Token" autoComplete="new-password" spellCheck={false} value={apiToken} disabled={loading || !!busy || !enabled}
          placeholder={status?.settings.tokenConfigured ? "已保存，留空保留" : "输入 AutoDL 开发者 Token"}
          onChange={event => { setApiToken(event.target.value); setError(""); }} />
      </label>
    </div>
    <p className="autodl-power-hint">开发者 Token 仅保存在本机服务，留空会保留已保存的 Token。校验不会开机。</p>
    {changed && <p className="autodl-power-hint">配置已修改，保存后生效。</p>}
    {connectionChanged ? <p className="autodl-power-hint">请先保存上方远程连接，再保存自动开关机配置。</p>
      : differentEndpoint && <p className="autodl-power-hint">AutoDL 配置尚未绑定当前远程连接，保存后生效。</p>}
    <div className="autodl-power-footer">
      <p role="status" aria-label="AutoDL 电源状态">{loading ? "正在读取 AutoDL 状态…" : status ? <>
        <strong>{status.pendingStop ? "关机尚未确认" : phaseLabels[status.phase]}</strong>{status.message && <span>{status.message}</span>}
        {status.activeTasks > 0 && <span>{status.activeTasks} 个任务正在使用此实例</span>}
      </> : "尚未读取到 AutoDL 状态。"}</p>
      <div className="autodl-power-actions">
        {(status?.pendingStop || status?.phase === "error") && <button type="button" disabled={loading || !!busy} onClick={() => void retryStop()}>{busy === "stop" ? "正在重试关机…" : "重试关机"}</button>}
        <button type="button" className="primary" disabled={loading || !!busy || connectionChanged} onClick={() => void save()}>{busy === "save" ? enabled ? "正在保存并校验…" : "正在保存设置…" : enabled ? "保存并校验" : "保存设置"}</button>
      </div>
    </div>
    {shownError && <p className="autodl-power-error" role="alert">{shownError}</p>}
  </section>;
}
