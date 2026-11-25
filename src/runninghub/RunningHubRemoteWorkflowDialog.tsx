import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link2, LoaderCircle, PencilLine, RefreshCw, Trash2 } from "lucide-react";
import { Modal } from "../components/ui";
import { useStore, activeCanvas } from "../stores/store";
import type { Kind, WorkflowDefinition } from "../types";
import { workflowSelectionPatch } from "../generation/workflow-selection";
import { detectWorkflowCredentials } from "../workflow/credentials";
import { RunningHubAccountSettings } from "../settings/RunningHubAccountSettings";
import { runningHubSite } from "../compute/providers";
import { RunningHubClient, normalizeRunningHubBaseUrl } from "./client";
import { readRunningHubRemoteWorkflow, prepareRunningHubRemoteWorkflow, remoteWorkflowPromptChoices, type RemoteRunningHubDraft } from "./remote-workflow";
import { runningHubFieldKey } from "./import-review";
import "./runninghub-workflows.css";
import "./runninghub-remote-workflow.css";

const kinds = { image: "图像", video: "视频", audio: "音频", text: "文本", file: "文件" } as const;

export function RunningHubRemoteWorkflowDialog({ onClose }: { onClose: () => void }) {
  const layer = useRef<HTMLDivElement>(null), close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    layer.current?.querySelector<HTMLInputElement>("#rh-remote-reference")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || useStore.getState().credentialWorkflow) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close.current(); return; }
      if (event.key !== "Tab") return;
      const controls = [...layer.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href]') ?? []].filter(control => control.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !layer.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !layer.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("keydown", keydown, true); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div ref={layer} className="rh-workflow-dialog-layer" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <Modal title="RunningHub ComfyUI 工作流" wide onClose={onClose}><RunningHubRemoteWorkflowManager onClose={onClose} /></Modal>
  </div>, document.body);
}

export function RunningHubRemoteWorkflowManager({ onClose, inline = false }: { onClose?: () => void; inline?: boolean }) {
  const connection = useStore(state => state.runningHubConnection);
  const all = useStore(state => state.runningHubWorkflows);
  const [reference, setReference] = useState("");
  const [draft, setDraft] = useState<RemoteRunningHubDraft>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [renaming, setRenaming] = useState("");
  const [newName, setNewName] = useState("");
  const pending = useRef<AbortController | undefined>(undefined);
  const revision = useRef(0);
  const key = JSON.stringify([connection.baseUrl, connection.token, connection.authHeader, connection.authPrefix]);
  const activeSite = runningHubSite(connection.baseUrl);
  const workflows = useMemo(() => {
    try { const site = normalizeRunningHubBaseUrl(connection.baseUrl); return all.filter(workflow => workflow.runninghub && workflow.runninghub.kind !== "app" && normalizeRunningHubBaseUrl(workflow.runninghub.baseUrl) === site); }
    catch { return []; }
  }, [all, connection.baseUrl]);
  useEffect(() => () => { revision.current++; pending.current?.abort(); }, []);
  useEffect(() => { revision.current++; pending.current?.abort(); setDraft(undefined); setError(""); setNotice(""); setBusy(""); }, [key]);

  async function read(value = reference, saved?: WorkflowDefinition) {
    if (busy || !value.trim()) return;
    const current = ++revision.current;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setBusy("正在读取远端工作流…"); setError(""); setNotice(""); setDraft(undefined);
    try {
      const result = await readRunningHubRemoteWorkflow(new RunningHubClient(connection), value, connection.baseUrl, controller.signal, saved);
      if (current !== revision.current) return;
      setReference(result.sourceUrl); setDraft(result);
      if (inline) {
        setBusy("正在添加工作流…");
        await saveDraft(result, current);
      }
    } catch (reason) { if (current === revision.current) setError(reason instanceof Error ? reason.message : "读取失败，请重试。"); }
    finally { if (current === revision.current) setBusy(""); }
  }

  function useWorkflow(workflow: WorkflowDefinition) {
    const state = useStore.getState();
    if (state.navigating) return;
    state.setComputeProvider("runninghub-workflow");
    const current = useStore.getState(), canvas = activeCanvas(current);
    const bounds = document.querySelector(".canvas-shell")?.getBoundingClientRect();
    const position = bounds ? { x: (bounds.width / 2 - canvas.viewport.x) / canvas.viewport.zoom - 160, y: (bounds.height / 2 - canvas.viewport.y) / canvas.viewport.zoom - 110 } : undefined;
    const kind: Kind = workflow.output.kind === "image" ? "image-generation" : workflow.output.kind === "file" ? "tool" : workflow.output.kind;
    const id = current.addNode(kind, position);
    const node = activeCanvas(useStore.getState()).nodes.find(item => item.id === id);
    if (node?.data.generation) current.patchNode(id, workflowSelectionPatch({ ...node.data.generation, prompt: "", negativePrompt: "" }, workflow));
    onClose?.();
    if (detectWorkflowCredentials(workflow).length) useStore.getState().setCredentialWorkflow(workflow);
  }

  async function saveDraft(value: RemoteRunningHubDraft, current: number, use = false) {
    const workflow = await prepareRunningHubRemoteWorkflow(value);
    // Once saving starts, closing the dialog must not discard the accepted draft.
    await useStore.getState().saveRunningHubWorkflow(workflow);
    if (current !== revision.current) return;
    setNotice("已添加远端工作流引用，可直接搭配画布使用。");
    if (use) useWorkflow(workflow);
    else if (detectWorkflowCredentials(workflow).length) useStore.getState().setCredentialWorkflow(workflow);
  }

  async function add(use = false) {
    if (!draft || busy) return;
    const current = revision.current;
    setBusy("正在添加到画布…"); setError(""); setNotice("");
    try {
      await saveDraft(draft, current, use);
    } catch (reason) { if (current === revision.current) setError(reason instanceof Error ? reason.message : "添加失败，请重试。"); }
    finally { if (current === revision.current) setBusy(""); }
  }

  async function remove(workflow: WorkflowDefinition) {
    if (busy) return;
    setBusy("正在移除引用…"); setError("");
    try { await useStore.getState().removeRunningHubWorkflow(workflow.id); setNotice("已从画布列表移除引用，RunningHub 原工作流仍保留。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "移除失败。"); }
    finally { setBusy(""); }
  }
  async function rename(workflow: WorkflowDefinition) {
    if (busy || !newName.trim()) return;
    setBusy("正在保存名称…"); setError("");
    try { await useStore.getState().renameRunningHubWorkflow(workflow.id, newName); setRenaming(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "重命名失败。"); }
    finally { setBusy(""); }
  }

  return <div className={"rh-remote-workflows" + (inline ? " rh-remote-inline runninghub-workflows" : "")}>
    {!inline && <><RunningHubAccountSettings /><p className="rh-remote-intro">粘贴已有工作流链接，读取输入、输出和参数。运行时使用 RunningHub 上的工作流 ID，由画布提交本次输入并接收结果。</p></>}
    {inline && <header className="rh-section-heading"><div><h3>读取并添加工作流</h3></div></header>}
    <form onSubmit={event => { event.preventDefault(); void read(); }} className={inline ? "rh-workflow-add-row rh-remote-inline-add" : "rh-remote-link"}>
      {inline ? <div className="rh-site-toggle" role="group" aria-label="RunningHub 工作流站点">{(["cn", "ai"] as const).map(site => <button type="button" key={site} aria-pressed={activeSite === site} disabled={!!busy} onClick={() => {
        if (site === activeSite) return;
        useStore.getState().setRunningHubSite(site);
        setReference("");
      }}>{site.toUpperCase()}</button>)}</div> : <label htmlFor="rh-remote-reference">ComfyUI 工作流链接或 ID</label>}
      {inline ? <>
        <input id="rh-remote-reference" aria-label="RunningHub 工作流 ID 或分享链接" autoComplete="off" spellCheck={false} placeholder="粘贴工作流链接或输入工作流 ID" value={reference} disabled={!!busy} onChange={event => { setReference(event.target.value); setDraft(undefined); setError(""); setNotice(""); }} />
        <span className="rh-workflow-auto-category">分类自动识别</span>
        <button type="submit" className="primary rh-workflow-read" disabled={!!busy || !reference.trim()}><Link2 size={15} />读取并添加工作流</button>
      </> : <div><input id="rh-remote-reference" autoComplete="off" spellCheck={false} placeholder="https://www.runninghub.cn/workflow/…" value={reference} disabled={!!busy} onChange={event => setReference(event.target.value)} /><button type="submit" className="primary" disabled={!!busy || !reference.trim()}><Link2 size={15} />读取工作流</button></div>}
    </form>
    {!!busy && <p role="status"><LoaderCircle size={15} className="compute-check-spin" />{busy}</p>}
    {!!error && <p className="rh-remote-error" role="alert">{error}</p>}
    {!!notice && <p role="status">{notice}</p>}
    {draft && <section className="rh-remote-draft" aria-label="远端工作流读取结果">
      <label>画布显示名称<input value={draft.name} maxLength={120} disabled={!!busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <p>工作流 ID {draft.workflowId} · {Object.keys(draft.graph).length} 个节点 · {draft.reader.bindingCandidates.filter(field => field.mediaKind).length} 个素材输入 · {draft.outputs.length} 个输出</p>
      <label>主提示词<select value={draft.promptKey} disabled={!!busy} onChange={event => setDraft({ ...draft, promptKey: event.target.value })}>
        <option value="">不绑定主提示词</option>
        {remoteWorkflowPromptChoices(draft.reader).map(field => {
          const key = runningHubFieldKey(field.nodeId, field.field);
          return <option key={key} value={key}>{field.label} · {field.nodeId} / {field.field}</option>;
        })}
      </select></label>
      <div className="rh-remote-outputs">{draft.outputs.map((output, index) => <label key={output.nodeId + "." + output.field}>输出 {output.nodeId} · {draft.graph[output.nodeId]?.class_type}<select value={output.kind} disabled={!!busy} onChange={event => setDraft({ ...draft, outputs: draft.outputs.map((item, itemIndex) => itemIndex === index ? { ...item, kind: event.target.value as typeof item.kind } : item) })}>{Object.entries(kinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>)}</div>
      {!!draft.warnings.length && <details><summary>读取提示 {draft.warnings.length} 项</summary><ul>{draft.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <div className="rh-remote-actions"><button type="button" disabled={!!busy || !draft.name.trim() || !draft.outputs.length} onClick={() => void add()}>{busy ? "正在保存…" : inline ? "保存调整" : "添加到画布列表"}</button><button type="button" className="primary" disabled={!!busy || !draft.name.trim() || !draft.outputs.length} onClick={() => void add(true)}>{inline ? "在画布中使用" : "添加并在画布中使用"}</button></div>
    </section>}
    <section aria-label="已引用的 RunningHub ComfyUI 工作流"><h3>已引用的工作流 <small>{workflows.length}</small></h3>
      {!workflows.length ? <p>粘贴工作流链接后即可读取使用。</p> : <div className="rh-remote-list">{workflows.map(workflow => <article key={workflow.id}>
        {renaming === workflow.id ? <form onSubmit={event => { event.preventDefault(); void rename(workflow); }}><input aria-label="工作流新名称" maxLength={120} value={newName} onChange={event => setNewName(event.target.value)} /><button disabled={!!busy || !newName.trim()}>保存名称</button><button type="button" onClick={() => setRenaming("")}>取消</button></form> : <div><strong>{workflow.name}</strong><small>ID {workflow.runninghub?.workflowId} · {kinds[workflow.output.kind]}</small></div>}
        <div className="rh-remote-actions"><button disabled={!!busy} onClick={() => useWorkflow(workflow)}>在画布中使用</button><button disabled={!!busy} aria-label={"重命名：" + workflow.name} onClick={() => { setNewName(workflow.name); setRenaming(workflow.id); }}><PencilLine size={14} />重命名</button><button disabled={!!busy} aria-label={"重新读取：" + workflow.name} onClick={() => void read(workflow.runninghub!.workflowId, workflow)}><RefreshCw size={14} />重新读取</button><button disabled={!!busy} aria-label={"移除引用：" + workflow.name} onClick={() => void remove(workflow)}><Trash2 size={14} />移除引用</button></div>
      </article>)}</div>}
    </section>
  </div>;
}
