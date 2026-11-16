import { FolderOpen, RefreshCw } from "lucide-react";
import { useStore } from "../stores/store";
import { useEffect, useRef, useState } from "react";
import { isImportPluginDiagnostic, repairSavedWorkflowImport, saveAutomaticWorkflowImport } from "./automatic-import-client";
import type { Connection } from "../types";
import type { PreparedWorkflowImport } from "./import-pipeline";
import { WorkflowBindingReview } from "./WorkflowBindingReview";
import { importReadiness } from "./import-review";
import { ImportEnvironmentReport } from "./ImportEnvironmentReport";
import { readImportEnvironmentReport, withImportEnvironmentCapabilities, type ImportEnvironmentReport as EnvironmentReport } from "./import-environment-diagnostics";
import { readWorkflowImportSource } from "./import-client";

/** Older local services can omit advisory fields from directory DTOs. Read their saved report without rerunning import. */
function SavedEnvironmentReport({ workflowId, report, diagnostics }: {
  workflowId: string;
  report?: EnvironmentReport;
  diagnostics?: { message: string }[];
}) {
  const [saved, setSaved] = useState<EnvironmentReport>();
  useEffect(() => {
    setSaved(undefined);
    if (report) return;
    const abort = new AbortController();
    void readWorkflowImportSource(workflowId, abort.signal).then(result => {
      const state = result.config.importState;
      const raw = state && typeof state === "object" && !Array.isArray(state) ? (state as Record<string, unknown>).environmentReport : undefined;
      if (!abort.signal.aborted) setSaved(readImportEnvironmentReport(raw));
    }).catch(() => { /* Existing diagnostics remain available during a service interruption. */ });
    return () => abort.abort();
  }, [workflowId, report]);
  const current = report ?? saved;
  return current ? <ImportEnvironmentReport report={withImportEnvironmentCapabilities(current, current.capabilities === "platform" ? "platform" : "cached")} />
    : <ul>{diagnostics?.map((item, index) => <li key={index}>{item.message}</li>)}</ul>;
}

const connectionIdentity = (connection: Connection) => JSON.stringify([connection.baseUrl, connection.authHeader, connection.authPrefix, connection.token]);
const withoutToken = (message: string, connection: Connection) => connection.token ? message.replaceAll(connection.token, "[认证已隐藏]") : message;

export function WorkflowLibraryStatus() {
  const library = useStore(s => s.workflowLibrary);
  const state = useStore(s => s.libraryState);
  const error = useStore(s => s.libraryError);
  const connection = useStore(s => s.connection);
  const [checking, setChecking] = useState("");
  const [selected, setSelected] = useState("");
  const [installMissingPlugins, setInstallMissingPlugins] = useState(false);
  const [review, setReview] = useState<{ prepared: PreparedWorkflowImport; liveSchema: boolean }>();
  const [checkMessage, setCheckMessage] = useState("");
  const [progress, setProgress] = useState("");
  const controller = useRef<AbortController | undefined>(undefined);
  const identity = connectionIdentity(connection);
  useEffect(() => {
    controller.current?.abort();
    setChecking(""); setCheckMessage(""); setProgress(""); setReview(undefined); setInstallMissingPlugins(false);
    return () => controller.current?.abort();
  }, [identity]);
  function startCheck(key: string) {
    controller.current?.abort(); const pending = new AbortController(); controller.current = pending;
    const snapshot = useStore.getState().connection;
    setChecking(key); setCheckMessage(""); setProgress("正在读取原始工作流…");
    return { pending, snapshot, isCurrent: () => !pending.signal.aborted && controller.current === pending && connectionIdentity(useStore.getState().connection) === connectionIdentity(snapshot) };
  }
  async function recheck(id: string) {
    const { pending, snapshot, isCurrent } = startCheck(id);
    setReview(undefined);
    try {
      const automatic = await repairSavedWorkflowImport(id, snapshot, pending.signal,
        message => { if (isCurrent()) setProgress(withoutToken(message, snapshot)); }, { installMissingPlugins });
      const result = automatic.saved;
      if (isCurrent()) setReview({ prepared: automatic.prepared, liveSchema: !!automatic.schema.info && !automatic.schema.warnings.length });
      if (!isCurrent()) return;
      await useStore.getState().refreshWorkflowLibrary({ afterWrite: true });
      const current = useStore.getState(), workflow = current.workflowLibrary?.workflows.find(item => item.original?.id === id || item.id === id);
      if (isCurrent()) setCheckMessage(withoutToken((current.libraryState !== "loaded" || !workflow
        ? "处理结果已保存，目录更新失败：" + (current.libraryError || "工作流暂未重新读取。") + " 请点击更新目录重试。"
        : result.status === "ready" && workflow.template ? "工作流已自动读取，可回到画布使用。云端生成与模型可用性尚未验证。"
        : "自动处理结果：" + (workflow.library?.diagnostics?.map(item => item.message).join("；") || workflow.library?.executionIssue || "未读取到完整的执行信息。")) + (automatic.schema.warnings.length ? " " + automatic.schema.warnings.join(" ") : ""), snapshot));
    } catch (reason) { if (isCurrent()) setCheckMessage(withoutToken(reason instanceof Error ? reason.message : String(reason), snapshot)); }
    finally { if (isCurrent()) { setChecking(""); setProgress(""); } }
  }
  async function saveBindings(prepared: PreparedWorkflowImport) {
    const { pending, isCurrent } = startCheck(String(prepared.config.id));
    try {
      const saved = await saveAutomaticWorkflowImport(prepared, pending.signal);
      if (!isCurrent()) return;
      setReview(previous => ({ prepared: saved.prepared, liveSchema: previous?.liveSchema ?? false }));
      await useStore.getState().refreshWorkflowLibrary({ afterWrite: true });
      if (isCurrent()) setCheckMessage("绑定已保存。重新读取会保留确认结果；源工作流未改写。");
    } finally { if (isCurrent()) { setChecking(""); setProgress(""); } }
  }
  const readiness = review && importReadiness(review.prepared, review.liveSchema);
  return <section className="workflow-library-status" aria-label="本地工作流目录">
    <div className="workflow-library-heading"><h3><FolderOpen size={17} />本地工作流目录</h3>
      <button disabled={state === "loading"} onClick={() => void useStore.getState().refreshWorkflowLibrary()}>
        <RefreshCw size={14} />{state === "loading" ? "更新中…" : "更新目录"}
      </button>
    </div>
    {library ? <>
      <p className="workflow-library-path">{library.sourcePath}</p>
      <label className="workflow-import-install-option"><input type="checkbox" checked={installMissingPlugins} disabled={!!checking} onChange={event => setInstallMissingPlugins(event.target.checked)} />安装缺失插件（可能需要重启）</label>
      <div className="workflow-import-actions">
        <select aria-label="选择要检查的云端工作流" value={selected} disabled={!!checking} onChange={event => setSelected(event.target.value)}>
          <option value="">选择已导入工作流</option>
          {library.workflows.filter(workflow => workflow.original?.id?.startsWith("custom.")).map(workflow => <option key={workflow.id} value={workflow.original!.id}>{workflow.name}</option>)}
        </select>
        <button disabled={!!checking || !selected} onClick={() => void recheck(selected)}>重新读取</button>
      </div>
      {review && readiness && <><dl className="workflow-import-readiness"><div><dt>读取</dt><dd>{readiness.read}</dd></div><div><dt>绑定</dt><dd>{readiness.bindings}</dd></div><div><dt>执行检查</dt><dd>{readiness.execution}</dd></div></dl>{review.prepared.importState.environmentReport && <ImportEnvironmentReport report={review.prepared.importState.environmentReport} />}<WorkflowBindingReview prepared={review.prepared} busy={!!checking} onSave={saveBindings} /></>}
      {library.workflows.some(workflow => workflow.library?.importStatus === "pending") && <div className="workflow-library-pending">
        <h4>待完成的自动处理</h4>
        {library.workflows.filter(workflow => workflow.library?.importStatus === "pending").map(workflow => <details key={workflow.id} open>
          <summary>{workflow.name} · {workflow.family}</summary>
          <p>原始文件已保留。重新检查使用当前云端节点定义；只有勾选安装缺失插件后才会下载、安装。参数顺序不明确时请导出 API JSON。</p>
          {review?.prepared.config.id !== workflow.original?.id && <SavedEnvironmentReport workflowId={workflow.original?.id ?? workflow.id} report={workflow.library?.environmentReport} diagnostics={workflow.library?.diagnostics} />}
          <button disabled={!!checking} onClick={() => void recheck(workflow.original?.id ?? workflow.id)}><RefreshCw size={14} />{checking === (workflow.original?.id ?? workflow.id) ? "自动处理中…" : "重新检查"}</button>
        </details>)}
      </div>}
      {library.workflows.some(workflow => workflow.library?.importStatus !== "pending" && workflow.library?.diagnostics?.some(isImportPluginDiagnostic)) && <div className="workflow-library-pending">
        <h4>插件自动补齐结果</h4>
        {library.workflows.filter(workflow => workflow.library?.importStatus !== "pending" && workflow.library?.diagnostics?.some(isImportPluginDiagnostic)).map(workflow => <details key={workflow.id}>
          <summary>{workflow.name}</summary>
          <p>以下为上次自动处理记录。插件搜索、下载或加载未完成的原因会分别说明，可重新检查，或勾选安装缺失插件后补齐。</p>
          <ul>{workflow.library!.diagnostics!.filter(isImportPluginDiagnostic).map((item, index) => <li key={index}>{item.classType && <strong>{item.classType}： </strong>}{item.message}</li>)}</ul>
          {workflow.original?.id?.startsWith("custom.") && <button disabled={!!checking} onClick={() => void recheck(workflow.original!.id!)}><RefreshCw size={14} />{checking === workflow.original.id ? "自动处理中…" : "重新检查插件"}</button>}
        </details>)}
      </div>}
      {!!library.issues.length && <details><summary>{library.issues.length} 项读取或执行适配提示</summary>
        <ul>{library.issues.map((issue, index) => <li key={index}><strong>{issue.folder}</strong>：{issue.message}</li>)}</ul>
      </details>}
    </> : <p>等待本机服务读取已配置的工作流目录。</p>}
    {!!error && <p role="status">{error}</p>}
    {!!progress && <p role="status">{progress} <button onClick={() => {
      controller.current?.abort(); setChecking(""); setProgress("");
      setCheckMessage(installMissingPlugins ? "已停止等待。如果已提交 Manager 安装，云端安装可能继续，可稍后重新检查。" : "已停止检查，未请求安装插件。");
    }}>停止等待</button></p>}
    {!!checkMessage && <p role="status">{checkMessage}</p>}
  </section>;
}
