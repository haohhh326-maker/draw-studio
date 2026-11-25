import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Check, FileJson, Link2, LoaderCircle, Upload, RefreshCw, X } from "lucide-react";
import { Modal } from "../components/ui";
import { useStore, activeCanvas } from "../stores/store";
import { findWorkflow } from "./catalog";
import { workflowSelectionPatch } from "../generation/workflow-selection";
import type { PreparedWorkflowImport } from "./import-pipeline";
import { detectWorkflowFormat } from "./import-editor";
import { loadImportSchema } from "./import-schema";
import { prepareAutomaticWorkflowImport } from "./automatic-import";
import { repairSavedWorkflowImport, saveAutomaticWorkflowImport } from "./automatic-import-client";
import { describeWorkflowImportError } from "./import-errors";
import type { WorkflowImportResult } from "./import-client";
import type { Kind } from "../types";
import { localized } from "./library-converter";
import { detectWorkflowCredentials } from "./credentials";
import "./workflow-import.css";
import { WorkflowBindingReview } from "./WorkflowBindingReview";
import { importReadiness } from "./import-review";
import { ImportEnvironmentReport } from "./ImportEnvironmentReport";
import { isRunningHubNativeConnection } from "../runninghub/native-connection";
import { readRunningHubWorkflowForComfyUI } from "../runninghub/native-workflow-import";
import { runningHubSite } from "../compute/providers";
import type { PublishedWorkflowPrompt } from "./automatic-prompt-binding";

type Format = "api" | "editor";
type ImportSource = ({ kind: "file"; file: File } | { kind: "runninghub"; name: string; reference: string }) & { format?: Format };
type LoadedWorkflow = { selection: ImportSource; filename: string; source: unknown; publishedPrompt?: PublishedWorkflowPrompt };
type Imported = { prepared: PreparedWorkflowImport; saved: WorkflowImportResult; warnings: string[]; liveSchema?: boolean };
const RunningHubRemoteWorkflowDialog = lazy(() => import("../runninghub/RunningHubRemoteWorkflowDialog").then(module => ({ default: module.RunningHubRemoteWorkflowDialog })));

export function WorkflowImportDialog() {
  const remote = useStore(state => isRunningHubNativeConnection(state.connection));
  return remote ? <Suspense fallback={null}><RunningHubRemoteWorkflowDialog onClose={() => useStore.setState({ modal: null })} /></Suspense> : <LocalWorkflowImportDialog />;
}

function LocalWorkflowImportDialog() {
  const library = useStore(s => s.workflowLibrary);
  const libraryState = useStore(s => s.libraryState);
  const connection = useStore(s => s.connection);
  const [busy, setBusy] = useState("");
  const [installMissingPlugins, setInstallMissingPlugins] = useState(false);
  const [error, setError] = useState("");
  const [hovered, setHovered] = useState<Format>();
  const [result, setResult] = useState<Imported>();
  const [registered, setRegistered] = useState(false);
  const [selectedSource, setSelectedSource] = useState<ImportSource>();
  const [runningHubLink, setRunningHubLink] = useState("");
  const [schemaWarnings, setSchemaWarnings] = useState<string[]>([]);
  const inputs = { api: useRef<HTMLInputElement>(null), editor: useRef<HTMLInputElement>(null) };
  const revision = useRef(0);
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { revision.current++; pending.current?.abort(); }, []);
  const connectionKey = JSON.stringify([connection.baseUrl, connection.authHeader, connection.authPrefix, connection.token]);
  useEffect(() => {
    revision.current++; pending.current?.abort(); pending.current = undefined;
    setBusy("");
    setInstallMissingPlugins(false);
    setResult(previous => previous ? { ...previous, liveSchema: false } : previous);
  }, [connectionKey]);

  function clearSource() {
    revision.current++;
    pending.current?.abort(); pending.current = undefined;
    setSelectedSource(undefined); setRunningHubLink(""); setResult(undefined); setRegistered(false);
    setBusy(""); setError(""); setSchemaWarnings([]); setHovered(undefined);
    for (const input of Object.values(inputs)) if (input.current) input.current.value = "";
  }

  function confirmRegistration(saved: WorkflowImportResult) {
    const state = useStore.getState();
    const workflow = state.workflowLibrary?.workflows.find(w => w.original?.id === saved.workflowId || w.id === saved.workflowId);
    const added = state.libraryState === "loaded" && !!workflow;
    if (workflow && detectWorkflowCredentials(workflow).length) state.setCredentialWorkflow(workflow);
    setRegistered(added);
    if (!added) setError("文件已保存，" + (state.libraryError || "工作流目录暂未完成读取。") + " 可点击刷新目录重试。");
    return added ? workflow : undefined;
  }

  async function readFile(file?: File) {
    if (!file) return;
    const selection = { kind: "file", file } as const;
    await readWorkflow(async () => {
      if (file.size > 32 * 1024 * 1024) throw new Error("工作流文件不能超过 32 MB。");
      return { selection, filename: file.name, source: JSON.parse((await file.text()).replace(/^\uFEFF/, "")) as unknown };
    }, "正在读取工作流…", selection);
  }

  async function readRunningHubLink(value: string) {
    const reference = value.trim();
    if (!reference) return;
    const { runningHubConnections, runningHubConnection } = useStore.getState();
    await readWorkflow(async signal => {
      const { source, name, fileName, publishedPrompt } = await readRunningHubWorkflowForComfyUI(reference, runningHubConnections,
        runningHubSite(runningHubConnection.baseUrl), signal);
      return { selection: { kind: "runninghub", name, reference }, filename: fileName, source, publishedPrompt };
    }, "正在读取 RunningHub 工作流…");
  }

  async function readWorkflow(load: (signal: AbortSignal) => Promise<LoadedWorkflow>, readingMessage: string, selection?: ImportSource) {
    const current = ++revision.current;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setSelectedSource(selection);
    setResult(undefined); setRegistered(false); setError(""); setSchemaWarnings([]); setHovered(undefined); setBusy(readingMessage);
    const connection = useStore.getState().connection;
    let schema: Awaited<ReturnType<typeof loadImportSchema>> = { warnings: [] };
    try {
      const { source, filename, selection: loaded, publishedPrompt } = await load(controller.signal);
      controller.signal.throwIfAborted();
      const format = detectWorkflowFormat(source);
      if (current !== revision.current) return;
      setSelectedSource({ ...loaded, format });
      setBusy("正在自动识别节点、输入、输出和分类…");
      const automatic = await prepareAutomaticWorkflowImport(source, filename, connection, controller.signal,
        message => { if (current === revision.current) setBusy(message); }, { installMissingPlugins, publishedPrompt });
      schema = automatic.schema;
      if (current !== revision.current) return;
      setSchemaWarnings(schema.warnings);
      setBusy("正在自动生成文件并添加…");
      const { prepared, saved } = await saveAutomaticWorkflowImport(automatic.prepared, controller.signal);
      if (current !== revision.current) return;
      setResult({ prepared, saved, warnings: automatic.warnings, liveSchema: !!schema.info && !schema.warnings.length });
      setBusy("正在更新画布工作流…");
      await useStore.getState().refreshWorkflowLibrary({ afterWrite: true, revealWorkflowId: saved.workflowId });
      if (current !== revision.current) return;
      const added = confirmRegistration(saved);
      if (added) useStore.getState().notify("工作流已添加到「" + added.family + "」。");
    } catch (reason) {
      if (current === revision.current) setError(describeWorkflowImportError(reason, { connectedAddress: !!connection.baseUrl.trim(), ...schema }));
    } finally { if (current === revision.current) setBusy(""); }
  }

  async function refreshSaved() {
    if (!result) return;
    const current = revision.current;
    setError(""); setBusy("正在刷新目录…");
    try {
      await useStore.getState().refreshWorkflowLibrary({ afterWrite: true, revealWorkflowId: result.saved.workflowId });
      if (current === revision.current) confirmRegistration(result.saved);
    } finally { if (current === revision.current) setBusy(""); }
  }

  async function recheckSaved() {
    if (!result) return;
    const current = ++revision.current;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setError(""); setBusy("正在重新读取并检查…");
    setResult(previous => previous ? { ...previous, liveSchema: false } : previous);
    try {
      const { saved, prepared, warnings, schema } = await repairSavedWorkflowImport(result.saved.workflowId, useStore.getState().connection, controller.signal,
        message => { if (current === revision.current) setBusy(message); }, { installMissingPlugins });
      if (current !== revision.current) return;
      setResult({ saved, prepared, warnings, liveSchema: !!schema.info && !schema.warnings.length });
      await useStore.getState().refreshWorkflowLibrary({ afterWrite: true, revealWorkflowId: saved.workflowId });
      if (current === revision.current) confirmRegistration(saved);
    } catch (reason) { if (current === revision.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (current === revision.current) setBusy(""); }
  }

  function useImportedWorkflow() {
    if (!result || !registered) return;
    const previous = useStore.getState();
    if (previous.navigating) return;
    const workflow = findWorkflow(previous.workflows, result.saved.workflowId) ?? previous.workflows.find(w => w.original?.id === result.saved.workflowId);
    if (!workflow) { setRegistered(false); setError("工作流已从目录移除，请重新读取目录。"); return; }
    previous.setComputeProvider("comfyui");
    const state = useStore.getState();
    const kind: Kind = workflow.output.kind === "image" ? "image-generation" : workflow.output.kind === "file" ? "tool" : workflow.output.kind;
    const canvas = activeCanvas(state);
    const bounds = document.querySelector(".canvas-shell")?.getBoundingClientRect();
    const position = bounds ? { x: (bounds.width / 2 - canvas.viewport.x) / canvas.viewport.zoom - 160, y: (bounds.height / 2 - canvas.viewport.y) / canvas.viewport.zoom - 110 } : undefined;
    const id = state.addNode(kind, position);
    const node = activeCanvas(useStore.getState()).nodes.find(n => n.id === id)!;
    state.patchNode(id, workflowSelectionPatch(node.data.generation!, workflow));
    useStore.setState({ modal: null });
  }

  async function saveBindings(prepared: PreparedWorkflowImport) {
    const current = ++revision.current;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setBusy("正在保存绑定…"); setError("");
    try {
      const saved = await saveAutomaticWorkflowImport(prepared, controller.signal);
      if (current !== revision.current) return;
      setResult(previous => previous ? { ...previous, ...saved } : previous);
      await useStore.getState().refreshWorkflowLibrary({ afterWrite: true, revealWorkflowId: saved.saved.workflowId });
      if (current === revision.current) confirmRegistration(saved.saved);
    } finally { if (current === revision.current) setBusy(""); }
  }

  const pendingResult = result?.saved.status === "pending";
  const diagnostics = result?.saved.diagnostics ?? result?.prepared.importState.diagnostics ?? [];
  const addedWorkflow = result && library?.workflows.find(w => w.original?.id === result.saved.workflowId || w.id === result.saved.workflowId);
  const family = addedWorkflow?.family ?? localized(result?.prepared.config.primaryCategoryLabel);
  const readiness = result && importReadiness(result.prepared, result.liveSchema);
  const environmentReport = result?.prepared.importState.environmentReport;
  const additionalDiagnostics = diagnostics.filter(item => !environmentReport?.issues.some(issue => issue.code === item.code && issue.nodeId === item.nodeId && issue.field === item.field));
  const selectedFile = selectedSource?.kind === "file" ? selectedSource.file : undefined;
  const linked = selectedSource?.kind === "runninghub" ? selectedSource : undefined;
  return <Modal title="添加工作流" wide onClose={() => useStore.setState({ modal: null })}>
    <div className="workflow-import-content">
      {!selectedSource && <form className="workflow-import-link" onSubmit={event => {
        event.preventDefault();
        if (!busy) void readRunningHubLink(runningHubLink);
      }}>
        <label htmlFor="workflow-import-runninghub-link">RunningHub 链接</label>
        <div>
          <input id="workflow-import-runninghub-link" placeholder="粘贴工作流或 AI 应用链接" value={runningHubLink} disabled={!!busy}
            autoComplete="off" spellCheck={false} onChange={event => setRunningHubLink(event.target.value)} />
          <button className="primary" type="submit" disabled={!!busy || !runningHubLink.trim()}><Link2 size={16} aria-hidden="true" />读取并添加</button>
        </div>
      </form>}
      {!selectedSource && <p className="workflow-import-intro">也可以拖入 JSON 工作流，自动识别提示词、素材和参数。</p>}
      <label className="workflow-import-install-option"><input type="checkbox" checked={installMissingPlugins} disabled={!!busy} onChange={event => setInstallMissingPlugins(event.target.checked)} />安装缺失插件（通过 ComfyUI Manager，可能需要重启）</label>
      {selectedSource ? <section className="workflow-import-selection" aria-label={linked ? "已读取的 RunningHub 工作流" : "已选择的工作流文件"}>
        {linked ? <Link2 size={24} aria-hidden="true" /> : <FileJson size={24} aria-hidden="true" />}
        <div><strong>{linked?.name ?? selectedFile?.name}</strong><span>
          {linked ? "RunningHub 工作流" : selectedSource.format === "api" ? "API JSON" : selectedSource.format === "editor" ? "普通 JSON" : "JSON 文件"}
          {selectedFile && " · " + (selectedFile.size < 1024 * 1024 ? Math.max(1, Math.round(selectedFile.size / 1024)) + " KB" : (selectedFile.size / 1024 / 1024).toFixed(1) + " MB")}
        </span>{result && <small>已添加的工作流保留在目录中</small>}</div>
        <button type="button" className="workflow-import-clear" aria-label={linked ? "清除所选工作流链接" : "清除所选工作流文件"} title="清除工作流选择" onClick={clearSource}><X size={19} /></button>
      </section> : <div className="workflow-import-zones">
        {(["api", "editor"] as const).map(format => <div key={format}
          className={"workflow-import-zone " + (hovered === format ? "dragging" : "")}
          onDragOver={event => { event.preventDefault(); event.stopPropagation(); if (!busy) setHovered(format); }}
          onDragLeave={() => setHovered(undefined)}
          onDrop={event => { event.preventDefault(); event.stopPropagation(); setHovered(undefined); if (!busy) {
            if (event.dataTransfer.files.length !== 1) setError("请拖入一个文件；API JSON 或普通 JSON 均可单独添加。");
            else void readFile(event.dataTransfer.files[0]);
          } }}>
          <button type="button" disabled={!!busy} onClick={() => inputs[format].current?.click()}>
            {format === "api" ? <FileJson size={27} /> : <Upload size={27} />}
            <strong>{format === "api" ? "API 工作流" : "普通 ComfyUI 工作流"}</strong>
            <span>{format === "api" ? "拖入 API JSON，自动添加" : "拖入普通 JSON，自动转换并添加"}</span>
            <small>也可以点击选择文件</small>
          </button>
          <input hidden type="file" accept=".json,application/json" aria-label={format === "api" ? "选择 API 工作流文件" : "选择普通工作流文件"}
            ref={inputs[format]} onChange={event => { void readFile(event.target.files?.[0]); event.target.value = ""; }} />
        </div>)}
      </div>}
      {busy && <p className="workflow-import-progress" role="status"><LoaderCircle size={16} className="spin" />{busy}</p>}
      {error && <p className="workflow-import-error" role="alert">{error}</p>}
      {!result && !!error && !!schemaWarnings.length && <details className="workflow-import-notes"><summary>云端检查详情</summary><ul>{schemaWarnings.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
      {result && <section className="workflow-import-success" role="status"><Check size={22} /><strong>
        {registered ? "已添加" : "文件已保存"}
      </strong>
        <p>{result.prepared.name}</p>
        {readiness && <dl className="workflow-import-readiness"><div><dt>读取</dt><dd>{readiness.read}</dd></div><div><dt>绑定</dt><dd>{readiness.bindings}</dd></div><div><dt>执行检查</dt><dd>{linked && !result.liveSchema ? "待校验 · 实例可用后再检查节点和模型" : readiness.execution}</dd></div></dl>}
        {family && <p>已归类到：{family}</p>}
        <p>{pendingResult ? "原始 JSON 已完整保留。若参数顺序无法确定，请从对应 ComfyUI 导出 API JSON；缺少插件时可勾选安装后重新检查。" :
          (result.prepared.format === "editor" ? "普通 JSON 已自动转换" : "已读取 API JSON") + " · " + result.prepared.analysis.outputs.length + " 个输出"}</p>
        {!pendingResult && <p>{result.prepared.analysis.prompts.length} 个提示词字段 · {result.prepared.analysis.inputs.length} 个素材输入</p>}
        <p className="workflow-import-path">{result.saved.path}</p>
        {environmentReport && <ImportEnvironmentReport report={environmentReport} />}
        {!!additionalDiagnostics.length && <div className="workflow-import-notes"><strong>{pendingResult ? "其他待处理事项" : "插件处理结果"}（{additionalDiagnostics.length}）</strong><ul>{additionalDiagnostics.map((item, index) => <li key={index}>{item.code.startsWith("manager-plugin-") && item.classType && <strong>{item.classType}： </strong>}{item.message}</li>)}</ul></div>}
        {!!result.warnings.length && <details className="workflow-import-notes"><summary>导入提示（{result.warnings.length}）</summary><ul>{result.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
        {!pendingResult && <details className="workflow-import-bindings"><summary>查看自动识别的输入和输出</summary>
          {!!result.prepared.analysis.prompts.length && <ul>{result.prepared.analysis.prompts.map(field => <li key={field.nodeId + "." + field.field}>{field.label} · 文本</li>)}</ul>}
          <ul>{result.prepared.analysis.inputs.map(input => <li key={input.nodeId + "." + input.field}>{input.label} · {input.required === false ? "可选素材" : "素材输入"}</li>)}</ul>
          <ul>{result.prepared.analysis.outputs.map(output => <li key={output.nodeId + "." + output.field}>{output.label} · {output.field === "*" ? "自动识别返回结果" : output.field}</li>)}</ul>
          <p className="workflow-import-binding-hint">在画布的生成面板中填写提示词和其他文本输入。</p>
        </details>}
        <div className="workflow-import-actions">
          {!registered && <button className="primary" disabled={!!busy || libraryState === "loading"} onClick={() => void refreshSaved()}><RefreshCw size={16} />刷新目录</button>}
          {registered && <button disabled={!!busy} onClick={() => void recheckSaved()}><RefreshCw size={16} />重新读取并检查</button>}
          {registered && <button className="primary" disabled={!!busy} onClick={useImportedWorkflow}>在画布中使用</button>}
        </div>
        {registered && <WorkflowBindingReview prepared={result.prepared} busy={!!busy} onSave={saveBindings} />}
      </section>}
      {!!error && !result && selectedSource && !busy && <button className="primary" onClick={() => {
        if (linked) void readRunningHubLink(linked.reference);
        else void readFile(selectedFile);
      }}>重试添加</button>}
      <p className="workflow-import-destination">保存到：{library?.sourcePath || "当前配置的本地工作流目录"}</p>
    </div>
  </Modal>;
}
