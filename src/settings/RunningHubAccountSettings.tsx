import { useEffect, useState } from "react";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { normalizeRunningHubBaseUrl } from "../runninghub/client";
import { runningHubKeyFingerprint } from "../runninghub/key-fingerprint";
import { useStore } from "../stores/store";
import type { Connection } from "../types";
import { checkRunningHubConnection, runningHubConnectionIdentity } from "./runninghub-connection-actions";
import "./compute-settings.css";

const sites = { cn: "https://www.runninghub.cn", ai: "https://www.runninghub.ai" };
type RunningHubSite = keyof typeof sites;
function selectedSite(connection: Connection): RunningHubSite {
  try { return normalizeRunningHubBaseUrl(connection.baseUrl) === sites.ai ? "ai" : "cn"; } catch { return "cn"; }
}

/** Saved credentials never become input values, including when the selected site changes. */
export function RunningHubAccountSettings({ sectionNumber }: { sectionNumber?: string }) {
  const profiles = useStore(state => state.runningHubConnections);
  const current = useStore(state => state.runningHubConnection);
  const [draft, setDraft] = useState<Record<RunningHubSite, string>>({ cn: "", ai: "" });
  const [feedback, setFeedback] = useState<Partial<Record<RunningHubSite, string>>>({});
  const [busy, setBusy] = useState(false);
  const [fingerprints, setFingerprints] = useState<Partial<Record<RunningHubSite, string>>>({});
  const activeSite = selectedSite(current);
  const changedSites = (Object.keys(sites) as RunningHubSite[]).filter(site => draft[site].trim());

  useEffect(() => {
    let active = true;
    setFingerprints({});
    void Promise.all((Object.keys(sites) as RunningHubSite[]).map(async site => {
      const fingerprint = await runningHubKeyFingerprint(profiles[site].token).catch(() => undefined);
      if (active && fingerprint) setFingerprints(previous => ({ ...previous, [site]: fingerprint }));
    }));
    return () => { active = false; };
  }, [profiles.cn.token, profiles.ai.token]);

  function saveKeys() {
    const updates = changedSites.map(site => {
      const profile = useStore.getState().runningHubConnections[site];
      const next = { ...profile, baseUrl: sites[site], token: draft[site].trim() };
      useStore.getState().setRunningHubSiteConnection(site, next);
      return { site, connection: next };
    });
    setDraft(previous => Object.fromEntries(Object.entries(previous).map(([site, value]) => [site, updates.some(update => update.site === site && update.connection.token === value.trim()) ? "" : value])) as Record<RunningHubSite, string>);
    return updates;
  }

  async function saveAndVerify() {
    if (busy) return;
    setBusy(true);
    const updates = saveKeys();
    const targets = updates.length ? updates : [{ site: activeSite, connection: useStore.getState().runningHubConnections[activeSite] }];
    try {
      for (const { site, connection } of targets) {
        if (!connection.token.trim()) { setFeedback(previous => ({ ...previous, [site]: "请填写本站 API Key。" })); continue; }
        setFeedback(previous => ({ ...previous, [site]: "正在验证…" }));
        const result = await checkRunningHubConnection(connection);
        // A replaced key must not inherit the verification result for an older key.
        if (runningHubConnectionIdentity(connection) === runningHubConnectionIdentity(useStore.getState().runningHubConnections[site]))
          setFeedback(previous => ({ ...previous, [site]: result ?? "" }));
      }
    } finally { setBusy(false); }
  }

  return <section className="rh-account-settings" aria-label="连接 RunningHub 账号">
    <header className="rh-section-heading">{sectionNumber && <span className="rh-section-number">{sectionNumber}</span>}<div><h3>连接 RunningHub 账号</h3><p>CN 和 AI 站的 API Key 分别保存在本机，留空会保留已保存的 Key。</p></div></header>
    <div className="rh-account-key-grid">{(Object.keys(sites) as RunningHubSite[]).map(site => <div className="rh-account-key" key={site}>
      <div className="rh-account-key-heading"><label htmlFor={`rh-account-key-${site}`}>{site === "cn" ? "CN 国内站 API Key" : "AI 海外站 API Key"}</label><a href={sites[site] + "/call-api/bill-task?tab=keys&type=consumer"} target="_blank" rel="noreferrer">获取消费级会员 Key <ExternalLink size={13} aria-hidden="true" /></a></div>
      <input id={`rh-account-key-${site}`} type="password" aria-label={site === "cn" ? "RunningHub CN 国内站 API Key" : "RunningHub AI 海外站 API Key"} autoComplete="new-password" spellCheck={false} disabled={busy} value={draft[site]} placeholder={profiles[site].token ? "已保存，仅更换时输入新 Key" : `输入 runninghub.${site} API Key`} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, [site]: value })); setFeedback(previous => ({ ...previous, [site]: "" })); }} />
      <div className="rh-account-key-state"><small role="status">{feedback[site] || (profiles[site].token ? "已保存在本机" : "尚未配置")}</small>{profiles[site].token && <button type="button" className="rh-account-clear" disabled={busy} onClick={() => { const profile = useStore.getState().runningHubConnections[site]; useStore.getState().setRunningHubSiteConnection(site, { ...profile, token: "" }); setDraft(previous => ({ ...previous, [site]: "" })); setFeedback(previous => ({ ...previous, [site]: "已清除本站 Key。" })); }} aria-label={`清除 RunningHub ${site.toUpperCase()} Key`}>清除</button>}</div>
      {fingerprints[site] && <div className="rh-account-key-state"><small aria-label={`RunningHub ${site.toUpperCase()} 已保存Key指纹`}>已保存 Key 指纹：{fingerprints[site]}</small></div>}
    </div>)}</div>
    <div className="rh-account-actions"><span>当前站点：{activeSite.toUpperCase()}</span><button type="button" disabled={busy || (!changedSites.length && !profiles[activeSite].token)} onClick={() => { saveKeys(); setFeedback(previous => ({ ...previous, ...Object.fromEntries(changedSites.map(site => [site, "已保存到本机。未发起验证。"] )) })); }}>保存到本机</button><button type="button" className="primary" disabled={busy || (!changedSites.length && !profiles[activeSite].token)} onClick={() => void saveAndVerify()}>{busy && <LoaderCircle size={15} className="compute-check-spin" aria-hidden="true" />}{busy ? "验证中…" : "保存并验证"}</button></div>
  </section>;
}
