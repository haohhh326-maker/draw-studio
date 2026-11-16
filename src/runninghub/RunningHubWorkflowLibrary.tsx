import { useEffect, useState } from "react";
import { FolderOpen, LoaderCircle, PencilLine, RefreshCw, Trash2 } from "lucide-react";
import { useStore } from "../stores/store";
import type { WorkflowDefinition } from "../types";
import { detectWorkflowCredentials } from "../workflow/credentials";
import { normalizeRunningHubBaseUrl } from "./client";
import { runningHubAppsForSite } from "./workflows";
import { useRunningHubWorkflowMetadata } from "./use-workflow-metadata";
import { RunningHubWorkflowCover } from "./RunningHubWorkflowCover";
import { runningHubSourceSummary } from "./source-summary";
import { runningHubWorkflowClassification } from "./workflow-metadata";
import "./runninghub-workflows.css";

/** The saved catalog belongs to settings; editing opens a separate, dismissible dialog. */
export function RunningHubWorkflowLibrary({ onEdit, onRefresh }: {
  onEdit: (workflow: WorkflowDefinition) => void;
  onRefresh: (workflow: WorkflowDefinition) => void;
}) {
  const connection = useStore(state => state.runningHubConnection);
  const workflows = useStore(state => state.runningHubWorkflows);
  const [removing, setRemoving] = useState("");
  const [renaming, setRenaming] = useState("");
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [error, setError] = useState("");
  let baseUrl = "";
  try { baseUrl = normalizeRunningHubBaseUrl(connection.baseUrl); } catch { /* No catalog for an invalid site. */ }
  const currentWorkflows = baseUrl ? runningHubAppsForSite(workflows, baseUrl) : [];
  const metadata = useRunningHubWorkflowMetadata(currentWorkflows);
  const site = baseUrl === "https://www.runninghub.ai" ? "AI" : "CN";
  useEffect(() => { setError(""); setRenaming(""); }, [baseUrl]);
  const busy = !!removing || savingName;

  async function rename(id: string) {
    if (busy) return;
    setSavingName(true); setError("");
    try {
      await useStore.getState().renameRunningHubWorkflow(id, name);
      setRenaming("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "重命名失败，请重试。"); }
    finally { setSavingName(false); }
  }

  async function remove(workflow: WorkflowDefinition) {
    if (busy) return;
    setRemoving(workflow.id); setError("");
    try { await useStore.getState().removeRunningHubWorkflow(workflow.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "移除失败，请重试。"); }
    finally { setRemoving(""); }
  }

  return <section className="runninghub-workflows rh-workflow-library" aria-label="已添加的 RunningHub AI 应用">
    <header className="rh-workflow-library-heading"><h3>已添加的 AI 应用 <span>{currentWorkflows.length}</span></h3><div className="rh-workflow-library-tools"><small>{site} · {baseUrl ? new URL(baseUrl).hostname : "请先配置站点"}</small>{!!currentWorkflows.length && <button type="button" className="rh-workflow-icon" aria-label="同步 AI 应用名称和封面" title="同步 AI 应用名称和封面" disabled={metadata.busy} onClick={metadata.refresh}>{metadata.busy ? <LoaderCircle size={15} className="compute-check-spin" /> : <RefreshCw size={15} />}</button>}</div></header>
    {metadata.error && <p className="rh-workflow-muted" role="status">{metadata.error}</p>}
    {error && <p className="rh-workflow-error" role="alert">{error}</p>}
    {!currentWorkflows.length ? <div className="rh-workflow-empty"><FolderOpen size={30} aria-hidden="true" /><strong>还没有 RunningHub AI 应用</strong><p>在上方输入 AI 应用链接或 ID，读取后即可搭配画布使用。</p></div> : <div className="rh-workflow-cards">{currentWorkflows.map(workflow => {
      const readSummary = runningHubSourceSummary(workflow);
      const classification = runningHubWorkflowClassification(workflow);
      return <article className="rh-workflow-item" key={workflow.id}>
      <button type="button" className="rh-workflow-cover-button" aria-label={"查看 AI 应用：" + workflow.name} disabled={busy} onClick={() => onEdit(workflow)}><RunningHubWorkflowCover workflow={workflow} /></button>
      {renaming === workflow.id ? <form className="rh-workflow-rename" onSubmit={event => { event.preventDefault(); void rename(workflow.id); }}>
        <label>AI 应用名称<input autoFocus aria-label="AI 应用新名称" value={name} maxLength={120} required disabled={savingName} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Escape" && !savingName) { event.preventDefault(); setRenaming(""); } }} /></label>
        <div><button type="submit" className="primary" disabled={savingName || !name.trim()}>{savingName ? "正在保存…" : "保存名称"}</button><button type="button" disabled={savingName} onClick={() => setRenaming("")}>取消</button></div>
      </form> : <button type="button" className="rh-workflow-item-name" disabled={busy} onClick={() => onEdit(workflow)}><strong title={workflow.name}>{workflow.name}</strong><small>{classification.family} · {classification.label}</small><small title={"AI 应用 · ID " + workflow.runninghub?.workflowId}>AI 应用 · ID {workflow.runninghub?.workflowId}</small><small title={readSummary?.version ? "读取版本 " + readSummary.version : undefined}>{readSummary?.label}{readSummary?.version ? " · 已记录版本" : ""}</small></button>}
      <div className="rh-workflow-card-actions">
        <button type="button" disabled={busy} onClick={() => onEdit(workflow)}>调整绑定</button>
        <button type="button" disabled={busy || renaming === workflow.id} aria-label={"重命名：" + workflow.name} onClick={() => { setRenaming(workflow.id); setName(workflow.name); setError(""); }}><PencilLine size={14} />重命名</button>
        {!!detectWorkflowCredentials(workflow).length && <button type="button" disabled={busy} onClick={() => useStore.getState().setCredentialWorkflow(workflow)}>填写 API Key</button>}
        <button type="button" className="rh-workflow-icon" aria-label={"重新读取：" + workflow.name} title="从 RunningHub 重新读取" disabled={busy} onClick={() => onRefresh(workflow)}><RefreshCw size={15} /></button>
        <button type="button" className="rh-workflow-icon" aria-label={"移除：" + workflow.name} title="从画布 AI 应用列表移除" disabled={busy} onClick={() => void remove(workflow)}><Trash2 size={15} /></button>
      </div>
    </article>;
    })}</div>}
  </section>;
}
