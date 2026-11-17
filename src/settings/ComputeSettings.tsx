import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cloud, FolderOpen, FolderSync, LoaderCircle, Server } from "lucide-react";
import { Modal } from "../components/ui";
import { normalizeRunningHubBaseUrl } from "../runninghub/client";
import { isRunningHubNativeConnection } from "../runninghub/native-connection";
import { RunningHubWorkflowLibrary } from "../runninghub/RunningHubWorkflowLibrary";
import { useStore } from "../stores/store";
import { RunningHubAccountSettings } from "./RunningHubAccountSettings";
import type { Connection, ComputeProvider } from "../types";
import { connectionDraft, saveConnectionDraft, updateConnectionDraft, type ConnectionDraft } from "./ConnectionPopover";
import { cancelWorkstationCheck, connectWorkstation } from "./connection-actions";
import "./compute-settings.css";
import { MuseSettings } from "../muse/MuseSettings";
import { useMuseSession } from "../muse/session";
import { AutoDLPowerSettings } from "../autodl/AutoDLPowerSettings";


const RunningHubWorkflowDialog = lazy(() => import("../runninghub/RunningHubWorkflowDialog").then(module => ({ default: module.RunningHubWorkflowDialog })));
const RunningHubWorkflowEditor = lazy(() => import("../runninghub/RunningHubWorkflowDialog").then(module => ({ default: module.RunningHubWorkflowEditor })));
const RunningHubRemoteWorkflowManager = lazy(() => import("../runninghub/RunningHubRemoteWorkflowDialog").then(module => ({ default: module.RunningHubRemoteWorkflowManager })));
const CloudFileTransferPanel = lazy(() => import("./CloudFileTransferPanel"));
const sites = { cn: "https://www.runninghub.cn", ai: "https://www.runninghub.ai" };
type RunningHubSite = keyof typeof sites;
function selectedSite(connection: Connection): RunningHubSite {
  try { return normalizeRunningHubBaseUrl(connection.baseUrl) === sites.ai ? "ai" : "cn"; } catch { return "cn"; }
}

function statusText(status: "offline" | "connecting" | "connected") {
  return status === "connected" ? "已连接" : status === "connecting" ? "检测中…" : "未连接";
}

export function ComputeSettings({ onClose, initialProvider }: {
  onClose: () => void;
  initialProvider?: ComputeProvider;
}) {
  const provider = useStore(state => state.computeProvider);
  const muse = useMuseSession(state => state.session);
  const connection = useStore(state => state.connection);
  const cloudState = useStore(state => state.connectionState);
  const cloudInfo = useStore(state => state.connectionInfo);
  const runningHub = useStore(state => state.runningHubConnection);
  const runningHubState = useStore(state => state.runningHubConnectionState);
  const runningHubInfo = useStore(state => state.runningHubConnectionInfo);
  const [tab, setTab] = useState<ComputeProvider>(initialProvider ?? provider);
  const [cloudDraft, setCloudDraft] = useState<ConnectionDraft>(() => connectionDraft(connection));
  const [feedback, setFeedback] = useState("");
  const [cloudFilesOpen, setCloudFilesOpen] = useState(false);
  const [manager, setManager] = useState<{ initialId?: string; refreshOnOpen?: boolean } | null>(null);
  const managerOpen = useRef(false);
  managerOpen.current = manager !== null;
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const activeState = tab === "muse" ? (muse.status === "connected" ? "connected" : muse.status === "checking" ? "connecting" : "offline") : tab === "comfyui" ? cloudState : runningHubState;
  const activeInfo = tab === "comfyui" ? cloudInfo : runningHubInfo;
  const currentCloudDraft = connectionDraft(connection);
  const cloudChanged = JSON.stringify(cloudDraft) !== JSON.stringify(currentCloudDraft);
  const site = selectedSite(runningHub);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (managerOpen.current || useStore.getState().credentialWorkflow) return;
      if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? [])
        .filter(element => element.tabIndex !== -1 && element.getClientRects().length > 0);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("keydown", keydown, true); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  function changeTab(next: ComputeProvider) { setTab(next); setFeedback(""); }
  function saveCloud() {
    const current = useStore.getState().connection;
    const { connection: next, endpointChanged, authenticationChanged } = saveConnectionDraft(current, cloudDraft);
    if (isRunningHubNativeConnection(next)) throw new Error("请在“RunningHub 工作流”中添加工作流链接，云端 ComfyUI 仅用于自有云端连接。");
    if (endpointChanged || authenticationChanged) useStore.setState({ connection: next, connectionState: "offline", connectionInfo: "连接配置已更改，等待检测。" });
    else useStore.setState({ connection: next });
    setCloudDraft(connectionDraft(next));
    return next;
  }
  function save() {
    try { saveCloud(); setFeedback("已保存到本机。"); }
    catch (error) { setFeedback(error instanceof Error ? error.message : "连接配置无效，请检查远程地址与认证信息。"); }
  }
  async function saveAndCheck() {
    setFeedback("");
    try { await connectWorkstation(saveCloud()); }
    catch (error) { setFeedback(error instanceof Error ? error.message : "连接配置无效，请检查远程地址与认证信息。"); }
  }
  const cloudField = (key: keyof ConnectionDraft, value: string) => {
    try { setCloudDraft(updateConnectionDraft(cloudDraft, key, value)); setFeedback(""); }
    catch { setFeedback("连接配置无效，请检查远程地址与认证信息。"); }
  };

  return createPortal(<div className="compute-settings-layer" ref={panelRef} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <Modal title="算力设置" onClose={onClose}>
      <div className="compute-settings-tabs" role="tablist" aria-label="算力配置" onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const tabs: ComputeProvider[] = ["comfyui", "runninghub-workflow", "runninghub", "muse"];
        const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        changeTab(next);
        panelRef.current?.querySelector<HTMLButtonElement>(`#compute-tab-${next}`)?.focus();
      }}>
        <button type="button" id="compute-tab-comfyui" role="tab" aria-selected={tab === "comfyui"} aria-controls="compute-panel-comfyui" tabIndex={tab === "comfyui" ? 0 : -1} onClick={() => changeTab("comfyui")}><Cloud size={17} aria-hidden="true" />云端 ComfyUI</button>
        <button type="button" id="compute-tab-runninghub-workflow" role="tab" aria-selected={tab === "runninghub-workflow"} aria-controls="compute-panel-runninghub-workflow" tabIndex={tab === "runninghub-workflow" ? 0 : -1} onClick={() => changeTab("runninghub-workflow")}><Cloud size={17} aria-hidden="true" />RunningHub 工作流</button>
        <button type="button" id="compute-tab-runninghub" role="tab" aria-selected={tab === "runninghub"} aria-controls="compute-panel-runninghub" tabIndex={tab === "runninghub" ? 0 : -1} onClick={() => changeTab("runninghub")}><Server size={17} aria-hidden="true" />RunningHub AI 应用</button>
        <button type="button" id="compute-tab-muse" role="tab" aria-selected={tab === "muse"} aria-controls="compute-panel-muse" tabIndex={tab === "muse" ? 0 : -1} onClick={() => changeTab("muse")}>Muse 账号</button>
      </div>
      <div className="compute-settings-body" role="tabpanel" id={`compute-panel-${tab}`} aria-labelledby={`compute-tab-${tab}`}>
        <div className="compute-settings-summary"><strong>{tab === "muse" ? "Muse" : tab === "comfyui" ? "云端 ComfyUI" : tab === "runninghub-workflow" ? "RunningHub 工作流" : "RunningHub AI 应用"}</strong><span className={`compute-status ${activeState}`}>{statusText(activeState)}</span></div>
        {tab === "muse" ? <MuseSettings /> : tab === "comfyui" ? <div className="compute-settings-cloud">
          <div className="compute-cloud-sections" role="group" aria-label="云端设置功能">
            <button type="button" aria-pressed={!cloudFilesOpen} onClick={() => setCloudFilesOpen(false)}><Cloud size={15} aria-hidden="true" />连接设置</button>
            <button type="button" aria-pressed={cloudFilesOpen} onClick={() => setCloudFilesOpen(true)}><FolderSync size={15} aria-hidden="true" />文件传输</button>
          </div>
          {cloudFilesOpen ? <Suspense fallback={<p role="status">正在打开文件传输…</p>}><CloudFileTransferPanel /></Suspense> : <><div className="compute-settings-fields">
          <label>连接名称<input aria-label="云端连接名称" value={cloudDraft.name} onChange={event => cloudField("name", event.target.value)} /></label>
          <label>远程地址<input aria-label="云端远程地址" inputMode="url" autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:8188" value={cloudDraft.baseUrl} onChange={event => cloudField("baseUrl", event.target.value)} /></label>
          <label>访问令牌<input type="password" aria-label="云端访问令牌" autoComplete="off" spellCheck={false} value={cloudDraft.token} onChange={event => cloudField("token", event.target.value)} /></label>
          <details className="compute-auth-fields"><summary>认证方式（可选）</summary>
            <label>认证头<input aria-label="云端认证头" autoComplete="off" spellCheck={false} value={cloudDraft.authHeader} onChange={event => cloudField("authHeader", event.target.value)} /></label>
            <label>认证前缀<input aria-label="云端认证前缀" autoComplete="off" spellCheck={false} placeholder="Bearer " value={cloudDraft.authPrefix} onChange={event => cloudField("authPrefix", event.target.value)} /></label>
          </details>
        </div><AutoDLPowerSettings connection={connection} connectionChanged={cloudChanged} /></>}
        </div> : tab === "runninghub-workflow" ? <div className="compute-settings-fields runninghub-settings">
          <RunningHubAccountSettings />
          <Suspense fallback={<p role="status">正在打开工作流…</p>}><RunningHubRemoteWorkflowManager inline onClose={onClose} /></Suspense>
        </div> : <div className="compute-settings-fields runninghub-settings">
          <div className="runninghub-workflows rh-workflow-import"><Suspense fallback={null}><RunningHubWorkflowEditor /></Suspense></div>
          <div className="compute-rh-controls">
            <details className="compute-auth-fields"><summary>任务设置</summary><label className="compute-timeout-field">任务超时（分钟）<input type="number" min={1} max={1440} aria-label="RunningHub 任务超时（分钟）" value={runningHub.timeoutMinutes} onChange={event => useStore.getState().setRunningHubSiteConnection(site, { ...runningHub, timeoutMinutes: Math.max(1, Math.min(1440, Number(event.target.value) || 60)) })} /></label></details>
            <button type="button" onClick={() => setManager({})}><FolderOpen size={15} aria-hidden="true" />管理 AI 应用</button>
          </div>
          <RunningHubWorkflowLibrary onEdit={workflow => setManager({ initialId: workflow.id })} onRefresh={workflow => setManager({ initialId: workflow.id, refreshOnOpen: true })} />
        </div>}
        {tab === "comfyui" && !cloudFilesOpen && <p className="compute-settings-message" role="status">{feedback || (cloudChanged ? "配置已修改，保存后生效。" : activeInfo || "填写连接配置后可检测连接。")}</p>}
        {tab === "comfyui" && !cloudFilesOpen && <div className="compute-settings-footer"><small>连接配置保存在本机；点击“保存并检测”才会检测连接。</small><div>
          <button type="button" disabled={cloudChanged || activeState === "connecting"} title={cloudChanged ? "请先保存连接配置" : "添加或重新读取工作流"} onClick={() => { onClose(); useStore.setState({ modal: "workflow-library" }); }}><FolderOpen size={15} aria-hidden="true" />工作流目录</button>
          <button type="button" onClick={save}>保存到本机</button>
          {activeState === "connecting" ? <button type="button" onClick={cancelWorkstationCheck}><LoaderCircle size={15} className="compute-check-spin" aria-hidden="true" />取消检测</button> : <button type="button" className="primary" disabled={!cloudDraft.baseUrl.trim()} onClick={() => void saveAndCheck()}>保存并检测</button>}
        </div></div>}
      </div>
    </Modal>
    {manager && <Suspense fallback={null}><RunningHubWorkflowDialog initialId={manager.initialId} refreshOnOpen={manager.refreshOnOpen} onClose={() => setManager(null)} /></Suspense>}
  </div>, document.body);
}
