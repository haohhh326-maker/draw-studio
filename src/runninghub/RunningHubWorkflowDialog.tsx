import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { Modal } from "../components/ui";
import { RunningHubAccountSettings } from "../settings/RunningHubAccountSettings";
import { useStore } from "../stores/store";
import type { ApiWorkflow, MediaKind, RunningHubWorkflowMetadata, WorkflowDefinition } from "../types";
import type { ImportAnalysis, ImportMediaBinding, ImportOutputBinding } from "../workflow/import-analyzer";
import { detectWorkflowCredentials } from "../workflow/credentials";
import { generationParameterSurface } from "../generation/parameter-actions";
import { RunningHubClient, normalizeRunningHubBaseUrl } from "./client";
import { parseRunningHubReference, prepareRunningHubApp, runningHubAppOutputNode, runningHubWorkflowsForSite } from "./workflows";
import type { RunningHubAiApp } from "./client";
import { runningHubImportCredentialIdentities } from "./import-analysis";
import { applyRunningHubWorkflowMetadata } from "./workflow-metadata";
import { attachRunningHubExecutionContract } from "./execution-contract";
import { reviewRunningHubImportBindings } from "./import-review";
import { analyzeRunningHubUpstream, requireRunningHubReader, type RunningHubReaderResult } from "./upstream-reader";
import { RunningHubWorkflowLibrary } from "./RunningHubWorkflowLibrary";
import "./runninghub-workflows.css";

const outputLabels: Record<MediaKind, string> = { image: "图像", video: "视频", audio: "音频", text: "文本", file: "文件" };
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const fieldKey = (nodeId: string, field: string) => JSON.stringify([nodeId, field]);
const nativeWorkflowGuidance = "此链接是 RunningHub ComfyUI 工作流，请到「RunningHub 工作流」添加；这里仅添加 AI 应用。";

/** A bare ID is always an AI app here; never probe a workflow endpoint. */
export async function readRunningHubAiAppReference(client: Pick<RunningHubClient, "getAiApp">, value: string, baseUrl: string, signal?: AbortSignal) {
  let reference: ReturnType<typeof parseRunningHubReference>;
  try { reference = parseRunningHubReference(value, baseUrl); }
  catch (reason) {
    if (message(reason).includes("V2 工作流接口")) throw new Error(nativeWorkflowGuidance);
    throw new Error(message(reason).replace(/工作流/g, "AI 应用"));
  }
  if (reference.kind === "workflow") throw new Error(nativeWorkflowGuidance);
  return { reference, app: await client.getAiApp(reference.id, signal) };
}
type LoadedDraft = { graph: ApiWorkflow; reader: RunningHubReaderResult; id: string; name: string; promptKey: string; media: ImportMediaBinding[]; outputs: ImportOutputBinding[]; warnings: string[]; app: RunningHubAiApp; metadata?: RunningHubWorkflowMetadata; nameSource?: "platform" | "custom"; apiVersionSource?: "explicit" | "platform"; needsConfirmation: boolean; errors: string[] };

/** Ordinary binding lists contain recognized inputs and reviewed custom targets. */
export function runningHubBindingFieldChoices(graph: ApiWorkflow, analysis: ImportAnalysis, promptKey: string, media: ImportMediaBinding[], credentials: Set<string>, custom = false) {
  const strings = analysis.fields.filter(field => typeof field.value === "string" && !credentials.has(fieldKey(field.nodeId, field.field)));
  const prompts = new Set(analysis.prompts.map(field => field.nodeId + "." + field.field));
  const inputs = new Set([...analysis.inputs, ...media].map(field => fieldKey(field.nodeId, field.field)));
  const promptFields = strings.filter(field => custom || prompts.has(field.nodeId + "." + field.field) || field.nodeId + "." + field.field === promptKey);
  const nullableMedia = [...analysis.inputs, ...media].filter(field => graph[field.nodeId]?.inputs[field.field] === null
    && !credentials.has(fieldKey(field.nodeId, field.field))).map(field => ({ nodeId: field.nodeId, field: field.field, label: field.label || field.nodeId + "." + field.field, value: null }));
  const mediaFields = [...new Map<string, { nodeId: string; field: string; label: string; value: unknown }>([...strings.filter(field => custom || inputs.has(fieldKey(field.nodeId, field.field))), ...nullableMedia]
    .map(field => [fieldKey(field.nodeId, field.field), field] as const)).values()];
  return { promptFields, mediaFields };
}

type RunningHubWorkflowEditorProps = {
  initialId?: string;
  refreshOnOpen?: boolean;
  onWorkflowAdded?: (workflow: WorkflowDefinition) => void;
  sectionNumber?: string;
};

export function RunningHubWorkflowDialog({ onClose, initialId, refreshOnOpen, onWorkflowAdded }: Omit<RunningHubWorkflowEditorProps, "sectionNumber"> & { onClose: () => void }) {
  const initial = useStore(state => initialId ? state.runningHubWorkflows.find(workflow => workflow.id === initialId) : undefined);
  const layer = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    layer.current?.querySelector<HTMLInputElement>('input:not([type="hidden"]):not(:disabled)')?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || useStore.getState().credentialWorkflow) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...layer.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex]:not([tabindex="-1"])') ?? []].filter(control => control.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      const outside = !layer.current?.contains(document.activeElement);
      if (event.shiftKey && (outside || document.activeElement === first)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (outside || document.activeElement === last)) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return createPortal(<div className="rh-workflow-dialog-layer" ref={layer} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <Modal title={initial?.runninghub && initial.runninghub.kind !== "app" ? "历史工作流（只读）" : initialId ? "调整 AI 应用" : "管理 AI 应用"} wide onClose={onClose}>
      <div className="runninghub-workflows">{initialId
        ? <RunningHubWorkflowEditor initialId={initialId} refreshOnOpen={refreshOnOpen} onWorkflowAdded={onWorkflowAdded} />
        : <RunningHubAiAppManager onWorkflowAdded={onWorkflowAdded} />}</div>
    </Modal>
  </div>, document.body);
}

export function RunningHubAiAppManager({ onWorkflowAdded }: Pick<RunningHubWorkflowEditorProps, "onWorkflowAdded">) {
  const [editing, setEditing] = useState<{ id: string; refresh?: boolean }>();
  if (editing) return <>
    <button type="button" onClick={() => setEditing(undefined)}>返回 AI 应用列表</button>
    <RunningHubWorkflowEditor key={editing.id} initialId={editing.id} refreshOnOpen={editing.refresh} onWorkflowAdded={onWorkflowAdded} />
  </>;
  return <>
    <RunningHubAccountSettings />
    <RunningHubWorkflowEditor onWorkflowAdded={onWorkflowAdded} />
    <RunningHubWorkflowLibrary onEdit={workflow => setEditing({ id: workflow.id })} onRefresh={workflow => setEditing({ id: workflow.id, refresh: true })} />
  </>;
}

export function RunningHubWorkflowEditor(props: RunningHubWorkflowEditorProps) {
  const saved = useStore(state => props.initialId ? state.runningHubWorkflows.find(workflow => workflow.id === props.initialId) : undefined);
  if (saved?.runninghub && saved.runninghub.kind !== "app") return <section className="rh-workflow-editor" aria-label="历史 RunningHub 工作流（只读）">
    <header className="rh-section-heading"><div><h3>历史工作流（只读）</h3><p>{saved.name}</p></div></header>
    <p className="rh-workflow-muted">此记录使用旧版工作流执行方式，原数据和已有任务均保留，不会转换为 AI 应用。</p>
    <p className="rh-workflow-muted">如需添加或重新读取 ComfyUI 工作流，请到「RunningHub 工作流」添加。此处仅管理 AI 应用。</p>
  </section>;
  return <RunningHubAiAppEditor key={props.initialId ?? "new"} {...props} />;
}

function RunningHubAiAppEditor({ initialId, refreshOnOpen = false, onWorkflowAdded, sectionNumber }: RunningHubWorkflowEditorProps) {
  const connection = useStore(state => state.runningHubConnection);
  const [reference, setReference] = useState("");
  const [name, setName] = useState("");
  const [loadedMetadata, setLoadedMetadata] = useState<RunningHubWorkflowMetadata>();
  const [nameSource, setNameSource] = useState<"platform" | "custom">("platform");
  const [loadedApp, setLoadedApp] = useState<RunningHubAiApp>();
  const [apiVersionSource, setApiVersionSource] = useState<"explicit" | "platform">("platform");
  const [bindingOpen, setBindingOpen] = useState(false);
  const [loadedId, setLoadedId] = useState("");
  const [graph, setGraph] = useState<ApiWorkflow>();
  const [reader, setReader] = useState<RunningHubReaderResult>();
  const [promptKey, setPromptKey] = useState("");
  const [media, setMedia] = useState<ImportMediaBinding[]>([]);
  const [outputs, setOutputs] = useState<ImportOutputBinding[]>([]);
  const [customBindings, setCustomBindings] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const revision = useRef(0);
  const pending = useRef<AbortController | undefined>(undefined);
  const connectionKey = JSON.stringify([connection.baseUrl, connection.token, connection.authHeader, connection.authPrefix]);
  const site = useMemo(() => {
    try { return { baseUrl: normalizeRunningHubBaseUrl(connection.baseUrl), error: "" }; }
    catch (reason) { return { baseUrl: "", error: message(reason) }; }
  }, [connection.baseUrl]);
  const analysis = useMemo(() => graph && reader ? analyzeRunningHubUpstream(reader, loadedApp?.outputKind) : undefined, [graph, reader, loadedApp?.outputKind]);
  const credentialIdentities = useMemo(() => graph ? runningHubImportCredentialIdentities(graph, loadedApp) : new Set<string>(), [graph, loadedApp]);
  const { promptFields, mediaFields } = graph && analysis ? runningHubBindingFieldChoices(graph, analysis, promptKey, media, credentialIdentities, customBindings) : { promptFields: [], mediaFields: [] };
  const outputNodes = graph ? Object.entries(graph).filter(([id]) => loadedApp ? id === runningHubAppOutputNode : customBindings || outputs.some(output => output.nodeId === id) || analysis?.outputs.some(output => output.nodeId === id)) : [];
  const unknownOutputs = outputs.filter(output => output.kind === "file" && output.field === "*");
  const activeSite = site.baseUrl === "https://www.runninghub.ai" ? "ai" : "cn";
  const candidateWorkflow = useMemo(() => {
    if (!graph || !loadedApp || !loadedId || !name.trim() || !outputs.length) return;
    try {
      if (!reader) return;
      const options = { workflowId: loadedId, baseUrl: connection.baseUrl, name, promptKey, mediaInputs: media, outputs, reader };
      return prepareRunningHubApp(loadedApp, options).workflow;
    } catch { /* Incomplete bindings are reviewed below before saving. */ }
  }, [graph, loadedId, name, connection.baseUrl, promptKey, media, outputs, loadedApp, reader]);
  const parameterSurface = candidateWorkflow ? generationParameterSurface(candidateWorkflow) : undefined;
  const adjustableParameters = parameterSurface ? new Set([...parameterSurface.basic, ...parameterSurface.advanced, ...parameterSurface.other].map(parameter => parameter.key)).size : undefined;

  useEffect(() => () => { revision.current++; pending.current?.abort(); }, []);
  useEffect(() => {
    revision.current++; pending.current?.abort(); pending.current = undefined;
    setGraph(undefined); setLoadedApp(undefined); setLoadedMetadata(undefined); setBindingOpen(false); setLoadedId(""); setCustomBindings(false); setBusy(""); setError(""); setNotice(""); setWarnings([]);
  }, [connectionKey]);

  function setLoaded(source: unknown, id: string, suggestedName: string, upstream: RunningHubReaderResult, saved?: WorkflowDefinition, app?: RunningHubAiApp, metadata?: RunningHubWorkflowMetadata, origin?: "platform" | "custom", versionOrigin?: "explicit" | "platform"): LoadedDraft {
    if (!app) throw new Error("AI 应用读取结果缺失，请重新读取应用。");
    const parsed = structuredClone(requireRunningHubReader(upstream).workflow!), analyzed = analyzeRunningHubUpstream(upstream, app?.outputKind);
    setReader(upstream);
    const presentation = metadata ?? (saved?.runninghub ? { name: saved.runninghub.platformName, coverUrl: saved.runninghub.coverUrl, coverMediaType: saved.runninghub.coverMediaType } : undefined);
    const sourceName = origin ?? saved?.runninghub?.nameSource ?? (presentation?.name === suggestedName ? "platform" : "custom");
    setGraph(parsed); setLoadedId(id); setReference(id); setName(suggestedName);
    setLoadedMetadata(presentation); setNameSource(sourceName);
    setLoadedApp(app);
    const review = reviewRunningHubImportBindings(parsed, analyzed, saved);
    const mainKey = review.promptKey;
    setPromptKey(mainKey);
    const mediaInputs = review.media;
    const outputBindings = review.outputs;
    const sourceVersion = versionOrigin ?? saved?.runninghub?.apiVersionSource ?? "platform";
    setApiVersionSource(sourceVersion);
    setMedia(mediaInputs); setOutputs(outputBindings);
    setCustomBindings(false);
    const readWarnings = [...new Set([...analyzed.warnings, ...review.warnings])];
    setWarnings(readWarnings);
    if (analyzed.errors.length) setError(analyzed.errors.join("\n"));
    const needsConfirmation = !!saved || analyzed.prompts.length > 1 || !outputBindings.length || outputBindings.some(output => output.kind === "file" && output.field === "*") || analyzed.errors.length > 0;
    setBindingOpen(needsConfirmation);
    return { graph: parsed, reader: upstream, id, name: suggestedName, promptKey: mainKey, media: mediaInputs, outputs: outputBindings, app, metadata: presentation, nameSource: sourceName, apiVersionSource: sourceVersion, needsConfirmation, warnings: readWarnings, errors: analyzed.errors };
  }

  useEffect(() => {
    if (!initialId) return;
    const saved = site.baseUrl ? runningHubWorkflowsForSite(useStore.getState().runningHubWorkflows, site.baseUrl).find(workflow => workflow.id === initialId) : undefined;
    if (saved?.runninghub?.kind === "app") void readPlatformWorkflow(saved.runninghub.workflowId, saved.name, saved);
  // A later site/key change clears a loaded draft rather than reusing another site's graph.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialId, refreshOnOpen]);

  function buildDraft(draft: LoadedDraft) {
    const options = { workflowId: draft.id, baseUrl: connection.baseUrl, name: draft.name, promptKey: draft.promptKey, mediaInputs: draft.media, outputs: draft.outputs,
      reader: draft.reader };
    const result = prepareRunningHubApp(draft.app, options);
    const workflow = { ...result.workflow, runninghub: { ...result.workflow.runninghub!, nameSource: draft.nameSource ?? "custom", apiVersionSource: draft.apiVersionSource ?? "platform" } };
    return { ...result, workflow: applyRunningHubWorkflowMetadata(workflow, draft.metadata ?? {}) };
  }

  async function saveDraft(draft: LoadedDraft, current: number) {
    const result = buildDraft(draft);
    const versioned = await attachRunningHubExecutionContract(result.workflow, draft.app);
    // Commit the submitted snapshot even if the editor closes during preparation.
    await useStore.getState().saveRunningHubWorkflow(versioned);
    if (current !== revision.current) return;
    const saved = useStore.getState().runningHubWorkflows.find(workflow => workflow.id === result.workflow.id) ?? result.workflow;
    setWarnings([...new Set([...draft.warnings, ...result.warnings])]); setBindingOpen(false);
    setNotice(`已添加“${saved.name}” · ${saved.family} · ${outputLabels[saved.output.kind]}。可在画布的 RunningHub AI 应用列表中使用。`);
    onWorkflowAdded?.(saved);
    if (detectWorkflowCredentials(saved).length) useStore.getState().setCredentialWorkflow(saved);
  }

  async function readPlatformWorkflow(value = reference, displayName = name, saved?: WorkflowDefinition) {
    const current = ++revision.current;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setError(""); setNotice(""); setGraph(undefined); setLoadedApp(undefined); setBindingOpen(false); setLoadedId(""); setCustomBindings(false); setWarnings([]); setBusy("正在读取 RunningHub 输入、输出和参数…");
    try {
      const client = new RunningHubClient(connection);
      const { reference: parsed, app: readApp } = await readRunningHubAiAppReference(client, value, connection.baseUrl, controller.signal);
      const app = { ...readApp, apiVersion: parsed.apiVersion ?? (saved?.runninghub?.apiVersionSource === "explicit" ? saved.runninghub.apiVersion : undefined) ?? readApp.apiVersion };
      const upstream = app.reader;
      if (current !== revision.current) return;
      if (!upstream?.workflow) throw new Error("AIFISHER 未返回完整的原版读取结果。");
      const source = upstream.workflow;
      if (current !== revision.current) return;
      let metadata: RunningHubWorkflowMetadata | undefined;
      try { metadata = await client.getWorkflowMetadata(parsed.id, "app", controller.signal); }
      catch { /* A presentation lookup never blocks reading the complete execution graph. */ }
      if (current !== revision.current) return;
      const previous = saved && applyRunningHubWorkflowMetadata(saved, metadata ?? {});
      const suggestedName = previous?.name || displayName.trim() || metadata?.name || app?.name?.trim() || "RunningHub " + parsed.id;
      const draft = setLoaded(source, parsed.id, suggestedName, upstream, saved, app, metadata, previous?.runninghub?.nameSource ?? (displayName.trim() ? "custom" : "platform"), parsed.apiVersion || saved?.runninghub?.apiVersionSource === "explicit" ? "explicit" : "platform");
      if (!draft.needsConfirmation) {
        setBusy("正在添加到画布 AI 应用…");
        await saveDraft(draft, current);
      } else if (!draft.errors.length) setNotice("已读取。请确认下方尚未明确的提示词或输出绑定，再保存。");
    } catch (reason) { if (current === revision.current) setError(message(reason)); }
    finally { if (current === revision.current) { setBusy(""); pending.current = undefined; } }
  }

  async function save() {
    if (busy) return;
    const current = revision.current;
    setError(""); setNotice("");
    setBusy("正在保存 AI 应用…");
    try {
      if (!graph || !loadedId || !reader || !loadedApp) throw new Error("请先读取 RunningHub AI 应用。");
      await saveDraft({ graph, reader, id: loadedId, name, promptKey, media, outputs, app: loadedApp, metadata: loadedMetadata, nameSource, apiVersionSource, warnings, errors: [], needsConfirmation: false }, current);
    } catch (reason) { if (current === revision.current) setError(message(reason)); }
    finally { if (current === revision.current) setBusy(""); }
  }

  function changeOutputs(next: ImportOutputBinding[]) {
    setOutputs(next); setError(""); setNotice("");
  }

  return <section className="rh-workflow-editor" aria-label="添加或编辑 RunningHub AI 应用">
          <header className="rh-section-heading">{sectionNumber && <span className="rh-section-number">{sectionNumber}</span>}<div><h3>读取并添加 AI 应用</h3><p>粘贴 RunningHub AI 应用链接或应用 ID，读取公开输入、输出和参数，添加后即可在画布使用。</p></div></header>
          <form className="rh-workflow-add-row" onSubmit={event => { event.preventDefault(); if (!busy && reference.trim()) void readPlatformWorkflow(); }}>
            <div className="rh-site-toggle" role="group" aria-label="RunningHub AI 应用站点">{(["cn", "ai"] as const).map(value => <button type="button" key={value} aria-pressed={activeSite === value} disabled={!!busy} onClick={() => { if (activeSite !== value) { useStore.getState().setRunningHubSite(value); setReference(""); setName(""); } }}>{value.toUpperCase()}</button>)}</div>
            <input aria-label="RunningHub AI 应用 ID 或分享链接" value={reference} disabled={!!busy} placeholder="粘贴 AI 应用链接或输入应用 ID" onChange={event => { setReference(event.target.value); setName(""); setGraph(undefined); setLoadedApp(undefined); setBindingOpen(false); setLoadedId(""); setCustomBindings(false); setNotice(""); setError(""); }} />
            <span className="rh-workflow-auto-category">分类自动识别</span>
            <button type="submit" className="primary rh-workflow-read" disabled={!!busy || !reference.trim() || !!site.error}><Download size={15} />读取并添加 AI 应用</button>
          </form>
          <details className="rh-workflow-advanced"><summary>应用命名</summary>
            <label>名称<input aria-label="RunningHub AI 应用名称" value={name} disabled={!!busy} maxLength={120} placeholder="留空时使用读取的应用名称" onChange={event => { setName(event.target.value); setNameSource("custom"); setNotice(""); }} /></label>
          </details>
          {busy && <p className="rh-workflow-status" role="status"><LoaderCircle size={16} className="spin" />{busy}</p>}
          {(site.error || error) && <pre className="rh-workflow-error" role="alert">{site.error || error}</pre>}
          {graph && <section className="rh-workflow-read-summary" aria-label="输入、输出与参数读取结果">
            <strong>已读取 AI 应用公开的输入、输出和参数</strong>
            <dl><div><dt>输入</dt><dd>{[...(promptKey ? ["提示词"] : []), ...media.map(input => outputLabels[input.kind] + (input.required === false ? "（可选）" : ""))].join("、") || "无"}</dd></div><div><dt>输出</dt><dd>{outputs.length ? outputs.map(output => output.kind === "file" && output.field === "*" ? "待确认" : outputLabels[output.kind]).join("、") : "待确认"}</dd></div><div><dt>可调参数</dt><dd>{adjustableParameters === undefined ? "确认绑定后显示" : `${adjustableParameters} 项`}</dd></div></dl>
          </section>}
          {graph && <details className="rh-workflow-binding-details" open={bindingOpen} onToggle={event => setBindingOpen(event.currentTarget.open)}><summary>{bindingOpen ? "输入、输出与参数设置" : "调整输入、输出与参数"}</summary><div className="rh-workflow-bindings">
            <p className="rh-workflow-muted">{loadedApp ? "已识别的素材按应用公开的类型和必填要求保留，可调整其他画布输入和输出。" : "保留已识别的素材输入，选择主提示词和实际输出。"}</p>
            <label>画布主提示词<select aria-label="RunningHub 主提示词绑定" value={promptKey} disabled={!!busy} onChange={event => { setPromptKey(event.target.value); setNotice(""); }}><option value="">不绑定主提示词</option>{promptFields.map(field => <option key={fieldKey(field.nodeId, field.field)} value={field.nodeId + "." + field.field}>{field.label}</option>)}</select></label>
            <div className="rh-workflow-section-heading"><h4>素材输入</h4><button type="button" disabled={!!busy || !mediaFields.some(field => !media.some(input => input.nodeId === field.nodeId && input.field === field.field) && field.nodeId + "." + field.field !== promptKey)} onClick={() => { const next = mediaFields.find(field => !media.some(input => input.nodeId === field.nodeId && input.field === field.field) && field.nodeId + "." + field.field !== promptKey); if (next) { const declared = analysis?.inputs.find(input => input.nodeId === next.nodeId && input.field === next.field); setMedia([...media, { nodeId: next.nodeId, field: next.field, kind: declared?.kind ?? "image", required: declared?.required !== false, label: next.label }]); } }}><Plus size={14} />添加输入</button></div>
            {!media.length && <p className="rh-workflow-muted">无素材输入</p>}
            {media.map((input, index) => {
              const declared = !!analysis?.inputs.some(field => field.nodeId === input.nodeId && field.field === input.field);
              return <div className="rh-workflow-binding-row" key={index}>
              <select aria-label={"素材输入字段 " + (index + 1)} value={fieldKey(input.nodeId, input.field)} disabled={!!busy || declared} onChange={event => { const field = mediaFields.find(item => fieldKey(item.nodeId, item.field) === event.target.value); if (field) setMedia(media.map((item, at) => at === index ? { ...item, nodeId: field.nodeId, field: field.field, label: field.label } : item)); }}>{mediaFields.map(field => <option key={fieldKey(field.nodeId, field.field)} value={fieldKey(field.nodeId, field.field)}>{field.label}</option>)}</select>
              <select aria-label={"素材类型 " + (index + 1)} value={input.kind} disabled={!!busy || !!loadedApp && declared} onChange={event => setMedia(media.map((item, at) => at === index ? { ...item, kind: event.target.value as ImportMediaBinding["kind"] } : item))}>{(["image", "video", "audio"] as const).map(kind => <option key={kind} value={kind}>{outputLabels[kind]}</option>)}</select>
              <label className="rh-workflow-checkbox"><input type="checkbox" checked={input.required !== false} disabled={!!busy || !!loadedApp && declared} onChange={event => setMedia(media.map((item, at) => at === index ? { ...item, required: event.target.checked } : item))} />必填</label>
              <button type="button" className="rh-workflow-icon" aria-label={"移除素材绑定 " + (index + 1)} disabled={!!busy || declared} title={declared ? "保留 AI 应用声明的素材输入" : "移除自定义素材绑定"} onClick={() => setMedia(media.filter((_, at) => at !== index))}><Trash2 size={14} /></button>
            </div>;
            })}
            {media.some(input => input.required === false) && <p className="rh-workflow-muted">{loadedApp ? "未连接的可选素材仅使用平台明确声明的空值；未声明空值时需要连接素材。" : "未连接的可选素材保留原工作流中的值。"}</p>}
            <div className="rh-workflow-section-heading"><h4>输出</h4>{!loadedApp && <button type="button" disabled={!!busy || !outputNodes.some(([id]) => !outputs.some(output => output.nodeId === id))} onClick={() => { const next = outputNodes.find(([id]) => !outputs.some(output => output.nodeId === id)); if (next) { const declared = analysis?.outputs.find(output => output.nodeId === next[0]); changeOutputs([...outputs, { nodeId: next[0], field: declared?.field ?? "*", kind: declared?.kind ?? "file" }]); } }}><Plus size={14} />添加输出</button>}</div>
            {!!unknownOutputs.length && <div className="rh-workflow-output-review" role="status">
              <p>以下输出的类型尚未明确：{unknownOutputs.map(output => (graph[output.nodeId]?._meta?.title || graph[output.nodeId]?.class_type || "自定义输出") + " · " + output.nodeId).join("、")}。</p>
              <p>保存后将根据实际结果自动识别类型，也可在下方选择输出类型和字段。</p>
            </div>}
            {outputs.map((output, index) => <div className="rh-workflow-binding-row rh-workflow-output-row" key={index}>
              <select aria-label={"输出节点 " + (index + 1)} value={output.nodeId} disabled={!!busy || !!loadedApp} onChange={event => changeOutputs(outputs.map((item, at) => at === index ? { ...item, nodeId: event.target.value } : item))}>{outputNodes.map(([id, node]) => <option key={id} value={id}>{node._meta?.title || node.class_type} · {id}</option>)}</select>
              <select aria-label={"输出类型 " + (index + 1)} value={output.kind} onChange={event => changeOutputs(outputs.map((item, at) => at === index ? { ...item, kind: event.target.value as MediaKind, ...(loadedApp ? { field: event.target.value === "text" ? "text" : "files" } : {}) } : item))}>{Object.entries(outputLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select>
              <input aria-label={"输出字段 " + (index + 1)} value={output.field} placeholder="*" onChange={event => changeOutputs(outputs.map((item, at) => at === index ? { ...item, field: event.target.value } : item))} />
              {!loadedApp && <button type="button" className="rh-workflow-icon" aria-label={"移除输出绑定 " + (index + 1)} onClick={() => changeOutputs(outputs.filter((_, at) => at !== index))}><Trash2 size={14} /></button>}
            </div>)}
            <div className="rh-workflow-custom-binding">
              <button type="button" aria-pressed={customBindings} disabled={!!busy} onClick={() => setCustomBindings(value => !value)}>{customBindings ? "收起自定义绑定字段" : "自定义字段绑定"}</button>
              {customBindings && <p className="rh-workflow-muted">输入和输出下拉现已显示其他可绑定字段。已保存的自定义绑定会一直保留在常规列表中。</p>}
            </div>
            {loadedApp && <p className="rh-workflow-muted">应用公开的参数均会保留在画布“参数设置”中。</p>}
            <p className="rh-workflow-muted">AI 应用的提示词示例不会自动填入画布。</p>
            {!!warnings.length && <details className="rh-workflow-notes"><summary>读取提示（{warnings.length}）</summary><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
            <button type="button" className="primary rh-workflow-save" disabled={!!busy || !outputs.length || !name.trim()} onClick={() => void save()}>{busy ? "正在保存…" : "保存 AI 应用"}</button>
          </div></details>}
          {notice && <p className="rh-workflow-success" role="status">{notice}</p>}
        </section>;
}
