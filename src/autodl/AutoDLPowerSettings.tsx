import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "../stores/store";
import type { Connection } from "../types";
import { checkAutoDLSettings, getAutoDLInstances, getAutoDLSession, getAutoDLStatus, openAutoDLAccount, retryAutoDLShutdown, saveAutoDLSettings } from "./client";
import { autoDLInstanceUuidFromEndpoint, sameAutoDLEndpoint } from "./endpoint";
import type { AutoDLAccountSession, AutoDLInstanceSummary, AutoDLPowerStatus } from "./types";
import "./AutoDLPowerSettings.css";

const phaseLabels = { disabled: "未启用", unknown: "尚未检测实例状态", off: "实例已关机", starting: "正在开机", ready: "实例已就绪", stopping: "正在关机", error: "操作未完成" };
const sessionLabels = { disconnected: "未连接 AutoDL", "login-required": "等待官网登录", connected: "已连接 AutoDL", error: "官网连接异常" };
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "AutoDL 操作失败，请重试。";

function bindSavedSettings(status: AutoDLPowerStatus) {
  const current = useStore.getState().connection;
  if (!sameAutoDLEndpoint(current.baseUrl, status.settings.endpoint)) return;
  useStore.setState({ connection: { ...current,
    autodl: status.settings.enabled ? { instanceUuid: status.settings.instanceUuid } : undefined } });
}

export function AutoDLPowerSettings({ connection, connectionChanged }: { connection: Connection; connectionChanged: boolean }) {
  const headingId = useId();
  const [status, setStatus] = useState<AutoDLPowerStatus | null>(null);
  const [session, setSession] = useState<AutoDLAccountSession | null>(null);
  const [instances, setInstances] = useState<AutoDLInstanceSummary[]>([]);
  const [loginError, setLoginError] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [instanceUuid, setInstanceUuid] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "stop" | "login" | "instances" | null>(null);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const mounted = useRef(false), operation = useRef(false), initialized = useRef(false), revision = useRef(0), instancesLoaded = useRef(false);
  const instanceEdited = useRef(false), explicitlyDisabled = useRef(false);
  const refreshSession = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    mounted.current = true;
    let disposed = false, reading = false;
    const refresh = async () => {
      if (reading || operation.current) return;
      reading = true;
      const observed = revision.current;
      try {
        const [power, account] = await Promise.allSettled([getAutoDLStatus(), getAutoDLSession()]);
        if (disposed || observed !== revision.current) return;
        if (power.status === "fulfilled") {
          setStatus(power.value); setReadError("");
          if (!initialized.current) {
            setEnabled(power.value.settings.enabled); setInstanceUuid(power.value.settings.instanceUuid); initialized.current = true;
          }
        } else { setReadError(errorText(power.reason)); initialized.current = true; }
        if (account.status === "fulfilled") {
          setSession(account.value);
          if (account.value.status === "connected") {
            if (!instancesLoaded.current) {
              try {
                const result = await getAutoDLInstances();
                if (!disposed && observed === revision.current) { setInstances(result.instances); instancesLoaded.current = true; }
              } catch (cause) {
                if (!disposed && observed === revision.current) { setInstances([]); setSession({ status: "error", message: errorText(cause) }); }
              }
            }
          } else { instancesLoaded.current = false; setInstances([]); }
        } else { instancesLoaded.current = false; setInstances([]); setSession({ status: "error", message: errorText(account.reason) }); }
      } finally {
        reading = false;
        if (!disposed && observed === revision.current) setLoading(false);
      }
    };
    refreshSession.current = refresh;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { disposed = true; mounted.current = false; refreshSession.current = async () => {}; window.clearInterval(timer); };
  }, []);

  async function openAccount() {
    if (operation.current) return;
    operation.current = true; ++revision.current;
    setBusy("login"); setLoginError("");
    try {
      const account = await openAutoDLAccount();
      instancesLoaded.current = false;
      if (mounted.current) {
        setSession(account);
        if (account.status !== "connected") setInstances([]);
      }
    } catch (cause) { if (mounted.current) setLoginError(errorText(cause)); }
    finally {
      ++revision.current; operation.current = false;
      if (mounted.current) { setBusy(null); void refreshSession.current(); }
    }
  }

  async function refreshInstances() {
    if (operation.current) return;
    operation.current = true; ++revision.current;
    setBusy("instances"); setError("");
    try {
      const account = await getAutoDLSession();
      if (mounted.current) setSession(account);
      if (account.status !== "connected") { instancesLoaded.current = false; if (mounted.current) setInstances([]); return; }
      const result = await getAutoDLInstances();
      instancesLoaded.current = true;
      if (mounted.current) { setInstances(result.instances); setLoginError(""); }
    } catch (cause) {
      instancesLoaded.current = false;
      if (mounted.current) { setInstances([]); setSession({ status: "error", message: errorText(cause) }); }
    } finally { ++revision.current; operation.current = false; if (mounted.current) setBusy(null); }
  }

  async function save() {
    if (operation.current) return;
    if (connectionChanged) { setError("请先保存上方远程连接，再保存自动开关机配置。"); return; }
    const current = useStore.getState().connection;
    if (!sameAutoDLEndpoint(current.baseUrl, connection.baseUrl)) { setError("远程连接已变更，请重新打开设置后保存。"); return; }
    if (enabled && session?.status !== "connected") { setError("请先在独立窗口登录 AutoDL.Art。"); return; }
    if (enabled && !instances.some(instance => instance.instanceUuid === instanceUuid)) { setError("请选择当前账号的 AutoDL 实例。"); return; }
    operation.current = true; ++revision.current;
    setBusy("save"); setError(""); setReadError("");
    try {
      const saved = await saveAutoDLSettings({ enabled, endpoint: current.baseUrl, instanceUuid });
      if (mounted.current) { setStatus(saved); setEnabled(saved.settings.enabled); setInstanceUuid(saved.settings.instanceUuid); }
      if (enabled) {
        const checked = await checkAutoDLSettings();
        if (mounted.current) setStatus(checked);
        if (checked.phase === "error" || checked.error) throw new Error(checked.error || checked.message || "AutoDL 配置校验未通过，请重试。");
        bindSavedSettings(checked);
      } else bindSavedSettings(saved);
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { ++revision.current; operation.current = false; if (mounted.current) setBusy(null); }
  }

  async function retryStop() {
    if (operation.current) return;
    operation.current = true; ++revision.current;
    setBusy("stop"); setError(""); setReadError("");
    try { const next = await retryAutoDLShutdown(); if (mounted.current) setStatus(next); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { ++revision.current; operation.current = false; if (mounted.current) setBusy(null); }
  }

  const shownError = error || readError || status?.error;
  const differentEndpoint = status?.settings.enabled && !sameAutoDLEndpoint(status.settings.endpoint, connection.baseUrl);
  const changed = status && (enabled !== status.settings.enabled || instanceUuid !== status.settings.instanceUuid);
  const powerChangingBlocked = (status?.activeTasks ?? 0) > 0 || !!status?.pendingStop;
  const connected = session?.status === "connected";
  const selectedInstance = instances.some(instance => instance.instanceUuid === instanceUuid);
  const endpointInstanceUuid = autoDLInstanceUuidFromEndpoint(connection.baseUrl);
  const matchingInstances = endpointInstanceUuid ? instances.filter(instance => instance.instanceUuid === endpointInstanceUuid) : [];
  const matchedInstance = matchingInstances.length === 1 ? matchingInstances[0] : undefined;

  useEffect(() => {
    if (!status || loading || busy || !connected || connectionChanged || powerChangingBlocked || !matchedInstance
      || instanceUuid || instanceEdited.current || explicitlyDisabled.current
      || status.settings.instanceUuid && status.settings.instanceUuid !== matchedInstance.instanceUuid) return;
    setInstanceUuid(matchedInstance.instanceUuid);
  }, [status, loading, busy, connected, connectionChanged, powerChangingBlocked, matchedInstance, instanceUuid, enabled]);

  return <section className="autodl-power-settings" aria-labelledby={headingId}>
    <header><h3 id={headingId}>AutoDL 自动开关机</h3><label className="autodl-power-enable">
      <input type="checkbox" aria-label="启用 AutoDL 自动开关机" checked={enabled} disabled={loading || !!busy || powerChangingBlocked}
        title={powerChangingBlocked ? "请等待所有任务结束并确认关机后再更改。" : undefined}
        onChange={event => { explicitlyDisabled.current = !event.target.checked; setEnabled(event.target.checked); setError(""); }} />启用
    </label></header>
    <p className="autodl-power-description">点击生成时自动开机。同一实例上的任务全部结束、结果保存后立即关机。</p>
    <div className="autodl-browser-account">
      <p role="status" aria-label="AutoDL 浏览器连接状态"><strong>{session ? sessionLabels[session.status] : "正在读取 AutoDL 登录状态…"}{session?.accountName ? ` · ${session.accountName}` : ""}</strong>{session?.message && <span>{session.message}</span>}</p>
      <div className="autodl-browser-actions">
        <button type="button" disabled={!!busy} onClick={() => void openAccount()}>{busy === "login" ? "正在打开官网…" : connected ? "打开官网窗口" : "连接 AutoDL"}</button>
      </div>
      {!connected && <p className="autodl-power-hint">在打开的 AutoDL.Art 官网窗口登录。完成后，画布会自动读取实例列表。</p>}
      {loginError && <p className="autodl-power-error" role="alert" aria-label="AutoDL 官网连接错误">{loginError}</p>}
    </div>
    <div className="autodl-instance-row"><label>已有实例<select aria-label="AutoDL 已有实例" value={instanceUuid} disabled={loading || !!busy || !enabled || powerChangingBlocked || !connected}
      title={powerChangingBlocked ? "请等待所有任务结束并确认关机后再更改。" : undefined}
      onChange={event => { instanceEdited.current = true; setInstanceUuid(event.target.value); setError(""); }}>
      <option value="">{connected ? instancesLoaded.current && !instances.length ? "当前账号没有可用实例" : "选择 AutoDL 实例" : "登录官网后读取实例"}</option>
      {instanceUuid && !selectedInstance && <option value={instanceUuid}>已保存实例 {instanceUuid}（未在当前列表中）</option>}
      {instances.map(instance => <option key={instance.instanceUuid} value={instance.instanceUuid}>{instance.name || instance.instanceUuid} · {instance.status} · {instance.instanceUuid}</option>)}
    </select></label><button type="button" disabled={!connected || !!busy} onClick={() => void refreshInstances()}>{busy === "instances" ? "正在读取…" : "刷新实例"}</button></div>
    {connected && !connectionChanged && matchedInstance && !explicitlyDisabled.current && <p className="autodl-power-hint">
      {instanceUuid === matchedInstance.instanceUuid
        ? `已匹配当前远程连接的实例“${matchedInstance.name || matchedInstance.instanceUuid}”。${enabled ? "点击“保存并校验”即可完成设置。" : "需要自动开关机时，勾选“启用”并点击“保存并校验”。"}`
        : instanceUuid ? `当前远程连接对应“${matchedInstance.name || matchedInstance.instanceUuid}”，已保留你选择的实例，请确认后保存。` : "已识别当前远程连接对应的实例，请确认实例选择后保存。"}
    </p>}
    {connected && !connectionChanged && endpointInstanceUuid && instancesLoaded.current && !matchingInstances.length && <p className="autodl-power-hint">当前账号列表中未找到与远程连接对应的实例，请确认浏览器账号或刷新实例。</p>}
    <p className="autodl-power-hint">连接与校验只读取账号和实例状态，不会开机。</p>
    {changed && <p className="autodl-power-hint">配置已修改，保存后生效。</p>}
    {connectionChanged ? <p className="autodl-power-hint">请先保存上方远程连接，再保存自动开关机配置。</p>
      : differentEndpoint && <p className="autodl-power-hint">AutoDL 配置尚未绑定当前远程连接，保存后生效。</p>}
    <div className="autodl-power-footer">
      <p role="status" aria-label="AutoDL 电源状态">{loading ? "正在读取 AutoDL 状态…" : status ? <>
        <strong>{status.pendingStop ? "关机尚未确认" : phaseLabels[status.phase]}</strong>{status.message && <span>{status.message}</span>}
        {status.activeTasks > 0 && <span>{status.activeTasks} 个任务正在使用此实例</span>}
      </> : "尚未读取到 AutoDL 状态。"}</p>
      <div className="autodl-power-actions">
        {status?.pendingStop && <button type="button" disabled={loading || !!busy} onClick={() => void retryStop()}>{busy === "stop" ? "正在重试关机…" : "重试关机"}</button>}
        <button type="button" className="primary" disabled={loading || !!busy || connectionChanged || enabled && (!connected || !selectedInstance)} onClick={() => void save()}>{busy === "save" ? enabled ? "正在保存并校验…" : "正在保存设置…" : enabled ? "保存并校验" : "保存设置"}</button>
      </div>
    </div>
    {shownError && <p className="autodl-power-error" role="alert">{shownError}</p>}
  </section>;
}
