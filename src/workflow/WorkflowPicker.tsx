import { isRunningHubProvider } from "../compute/providers";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, Minus, Plus, Settings, Trash2, X } from "lucide-react";
import type { ComputeProvider, WorkflowDefinition } from "../types";
import { useStore } from "../stores/store";
import { categoryForKind, type CanvasCategory } from "./dfcine-directory";
import { workflowVisibilityGroups } from "./visibility";
import { deleteWorkflowLibraryWorkflow } from "./import-client";
import { WorkflowSettingsMenu } from "../generation/WorkflowSettingsMenu";
import { useRunningHubWorkflowMetadata } from "../runninghub/use-workflow-metadata";
import { RunningHubWorkflowCover } from "../runninghub/RunningHubWorkflowCover";
import { availableSeriesId, buildDirectoryView, categoryForWorkflow, filterDirectoryWorkflows, workflowExecutionStatus, workflowSeriesId } from "./directory-view";
import "./workflow-picker.css";

export type WorkflowPickerMode = "select" | "edit" | "manage";
const runningHubSourceLabel = (workflow: WorkflowDefinition) => workflow.runninghub
  ? (workflow.runninghub.kind === "app" ? "AI 应用" : "工作流") + " · ID " + workflow.runninghub.workflowId
  : undefined;
export function WorkflowPicker({ workflows, current, kind, anchorRef, onSelect, onClose, mode: requestedMode = "select", onModeChange, onImport, provider }: {
  workflows: WorkflowDefinition[];
  current?: WorkflowDefinition;
  kind: string;
  anchorRef: RefObject<HTMLElement | null>;
  onSelect: (w: WorkflowDefinition) => void;
  onClose: () => void;
  mode?: WorkflowPickerMode;
  onModeChange?: (mode: WorkflowPickerMode) => void;
  onImport?: () => void;
  provider?: ComputeProvider;
}) {
  const [localMode, setLocalMode] = useState<WorkflowPickerMode>();
  const fallbackProvider = useStore(state => state.computeProvider);
  const computeProvider = provider ?? fallbackProvider;
  const itemLabel = computeProvider === "muse" ? "生成类型" : computeProvider === "runninghub" ? "AI 应用" : "工作流";
  useRunningHubWorkflowMetadata(isRunningHubProvider(computeProvider) ? workflows : []);
  const mode = localMode ?? requestedMode;
  useEffect(() => { setLocalMode(undefined); }, [requestedMode]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(false), settingsButtonRef = useRef<HTMLButtonElement>(null), settingsMenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { settingsOpenRef.current = settingsOpen; }, [settingsOpen]);
  const category = categoryForKind(kind);
  const hiddenKeys = useStore(state => state.hiddenWorkflowKeys);
  const filtered = useMemo(() => workflowVisibilityGroups(workflows, hiddenKeys), [workflows, hiddenKeys]);
  const choices = mode === "manage" ? filtered.hidden : filtered.visible;
  const canvases = useMemo(() => buildDirectoryView(choices), [choices]);
  const currentEntry = choices.find((workflow) => workflow.id === current?.id);
  const defaultSeriesId = currentEntry && categoryForWorkflow(currentEntry) === category ? workflowSeriesId(currentEntry) : "";
  const [selection, setSelection] = useState({ category, seriesId: defaultSeriesId });
  const requestedCategory = mode === "select" ? category : selection.category;
  const activeCategory = canvases.some(canvas => canvas.id === requestedCategory) ? requestedCategory : category;
  const seriesId = selection.category === activeCategory ? selection.seriesId : defaultSeriesId;
  const [saving, setSaving] = useState("");
  const savingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const [position, setPosition] = useState({ left: 16, top: 16, ready: false });
  useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const anchor = anchorRef.current;
    if (!dialog || !anchor) return;
    const place = () => {
      const trigger = anchor.getBoundingClientRect();
      const { width, height } = dialog.getBoundingClientRect();
      const margin = 16, gap = 8;
      const maxLeft = Math.max(margin, window.innerWidth - width - margin);
      const maxTop = Math.max(margin, window.innerHeight - height - margin);
      const above = trigger.top - height - gap;
      const below = trigger.bottom + gap;
      const preferredTop = above >= margin ? above : below <= maxTop ? below : above;
      const left = Math.max(margin, Math.min(trigger.left, maxLeft));
      const top = Math.max(margin, Math.min(preferredTop, maxTop));
      setPosition((previous) => previous.ready && previous.left === left && previous.top === top ? previous : { left, top, ready: true });
    };
    place();
    const frame = requestAnimationFrame(place);
    const resize = new ResizeObserver(place);
    resize.observe(dialog);
    resize.observe(anchor);
    const movement = new MutationObserver(place);
    const container = anchor.closest(".generation-floating, .generation-anchor") ?? anchor.parentElement;
    if (container) movement.observe(container, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      movement.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef]);
  useLayoutEffect(() => {
    // Focus only after visibility becomes visible; hidden elements reject focus.
    if (position.ready) dialogRef.current?.focus({ preventScroll: true });
  }, [position.ready]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const trigger = anchorRef.current ?? previous;
    if (computeProvider === "comfyui") void useStore.getState().refreshWorkflowLibrary();
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !dialogRef.current?.contains(target) && !settingsMenuRef.current?.contains(target) && !anchorRef.current?.contains(target)) closeRef.current();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (settingsOpenRef.current) setSettingsOpen(false);
        else closeRef.current();
      }
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [anchorRef, computeProvider]);
  const canvas = canvases.find((c) => c.id === activeCategory)!;
  const activeSeriesId = availableSeriesId(canvas, seriesId) || canvas.series[0]?.id || "";
  useEffect(() => {
    if (selection.category !== activeCategory || selection.seriesId !== activeSeriesId) setSelection({ category: activeCategory, seriesId: activeSeriesId });
  }, [selection, activeCategory, activeSeriesId]);
  const selectSeries = (seriesId: string) => setSelection({ category: activeCategory, seriesId });
  async function changeVisibility(workflow: WorkflowDefinition) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(workflow.id);
    try { await useStore.getState().setWorkflowHidden(workflow, mode !== "manage"); }
    catch { /* The store reports storage failures without changing the list. */ }
    finally { savingRef.current = false; setSaving(""); }
  }
  async function deleteWorkflow(workflow: WorkflowDefinition) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(workflow.id);
    try {
      await deleteWorkflowLibraryWorkflow(workflow);
      // A deleted import may later be re-added with the same identity; restore its visibility preference.
      const related = [workflow, ...useStore.getState().workflows.filter(item => item.library?.sourcePath === workflow.library?.sourcePath && item.library?.folder === workflow.library?.folder && item.id !== workflow.id)];
      let visibilityFailed = false;
      for (const item of related) {
        try { await useStore.getState().forgetWorkflowVisibility(item); }
        catch { visibilityFailed = true; }
      }
      await useStore.getState().refreshWorkflowLibrary({ afterWrite: true });
      const store = useStore.getState();
      store.notify("已删除工作流文件夹「" + workflow.library?.folder + "」。" + (store.libraryError ? "列表刷新失败，请点击更新。" : visibilityFailed ? "显示设置保存失败。" : ""));
    } catch (error) {
      useStore.getState().notify("删除失败：" + (error instanceof Error ? error.message : String(error)));
    } finally { savingRef.current = false; setSaving(""); }
  }
  const visible = filterDirectoryWorkflows(canvas, activeSeriesId, "");
  return createPortal(
    <div ref={dialogRef} tabIndex={-1} className={"workflow-selector directory-picker directory-picker-compact directory-popover nodrag nopan nowheel" + (mode === "select" ? "" : " directory-picker-management")} role="dialog" aria-label={mode === "edit" ? "编辑" + itemLabel : mode === "manage" ? "管理" + itemLabel : "选择" + canvas.name + itemLabel}
      style={{ position: "fixed", left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); settingsOpen ? setSettingsOpen(false) : onClose(); }
      }}>
      <header className="directory-header">
        {mode !== "select" && <strong>{(mode === "edit" ? "编辑" : "管理") + itemLabel}</strong>}
        <div className="workflow-picker-header-actions">
          {computeProvider !== "muse" && <button ref={settingsButtonRef} className="icon-button workflow-picker-settings" aria-label={itemLabel + "设置"} title={itemLabel + "设置"}
            aria-haspopup="menu" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Settings size={16} /></button>}
          <button className="icon-button" aria-label="关闭选择器" onClick={onClose}><X size={16} /></button>
        </div>
      </header>
      {settingsOpen && <WorkflowSettingsMenu anchorRef={settingsButtonRef} menuRef={settingsMenuRef} placement="below" align="end" itemLabel={itemLabel}
        onClose={() => setSettingsOpen(false)} onAction={action => {
          setSettingsOpen(false);
          if (action === "add") { onClose(); if (onImport) onImport(); else useStore.setState({ modal: computeProvider === "runninghub-workflow" ? "runninghub-remote-workflows" : computeProvider === "runninghub" ? "runninghub-workflows" : "workflow-import" }); }
          else if (onModeChange) onModeChange(action);
          else setLocalMode(action);
        }} />}
      {mode !== "select" && <nav className="workflow-management-categories" aria-label="画布类型">
        {canvases.map(item => <button key={item.id} className={item.id === activeCategory ? "active" : ""}
          aria-pressed={item.id === activeCategory} onClick={() => setSelection({ category: item.id as CanvasCategory, seriesId: "" })}>
          {item.name.replace("画布", "")}<span>{item.workflows.length}</span>
        </button>)}
      </nav>}
      <div className="directory-body">
        <nav className="directory-series" aria-label="模型 / 工具系列">
          {canvas.series.map((series) => <button key={series.id}
            className={activeSeriesId === series.id ? "active" : ""} aria-pressed={activeSeriesId === series.id} onClick={() => selectSeries(series.id)}>
            {series.name}<span>{series.workflows}</span>
          </button>)}
        </nav>
        <div className="directory-results">
          <div className="directory-result-heading">{canvas.series.find((s) => s.id === activeSeriesId)?.name ?? canvas.name}<span>{visible.length} 项</span></div>
          {visible.map((w) => <div className={"directory-workflow workflow-management-row " + (w.id === current?.id ? "selected" : "")}
            key={w.id} title={w.library?.importStatus === "pending" ? w.library.diagnostics?.map(item => item.message).join("\n") || "原始工作流已保留，请在工作流配置中补齐输入输出" : undefined}>
            {mode === "manage" ? <div className="workflow-management-name"><strong>{w.name}</strong><small>{w.family}</small>{w.runninghub && <small title={runningHubSourceLabel(w)}>{runningHubSourceLabel(w)}</small>}</div>
              : <button className="workflow-management-select" onClick={() => onSelect(w)}>{w.runninghub?.coverUrl && <RunningHubWorkflowCover workflow={w} />}<div><strong>{w.name}</strong><small>{w.family}</small>{w.runninghub && <small title={runningHubSourceLabel(w)}>{runningHubSourceLabel(w)}</small>}</div>{w.id === current?.id && <Check size={16} />}</button>}
            {mode !== "select" && <button className="workflow-management-action" disabled={!!saving}
              aria-label={(mode === "manage" ? "恢复 " : "移入管理 ") + w.name}
              title={mode === "manage" ? "恢复到工作流列表" : "移入管理列表"}
              onClick={() => void changeVisibility(w)}>{mode === "manage" ? <Plus size={17} /> : <Minus size={17} />}</button>}
            {mode === "manage" && w.library && w.original?.configSha256 && <button className="workflow-management-action workflow-management-delete" disabled={!!saving}
              aria-label={"删除 " + w.name} title={"删除工作流文件夹：" + w.library.folder}
              onClick={() => void deleteWorkflow(w)}><Trash2 size={15} /></button>}
          </div>)}
          {!visible.length && <p className="directory-empty">{mode === "manage" ? "没有移入管理的工作流。" : "暂无工作流。"}</p>}
        </div>
      </div>
    </div>, document.body
  );
}

export function WorkflowSourceDetails({ workflow }: { workflow: WorkflowDefinition }) {
  const original = workflow.original;
  const library = workflow.library;
  const libraryDetails = library ? <>
    <p>来源目录：{library.sourcePath} / {library.folder}</p>
    {library.runnerType && <p>执行方式：{library.runnerType}</p>}
    {library.executionIssue && <p>执行待接入：{library.executionIssue}</p>}
  </> : null;
  if (!original) {
    const reference = workflow.publicReference;
    return reference || library ? <details className="workflow-source-details directory-source-details">
      <summary>{library ? "工作流来源与执行状态" : "官方说明与模型需求 · 原始配置待补齐"}</summary>
      {libraryDetails}
      {library && !library.executionIssue && <p>执行状态：{workflowExecutionStatus(workflow)}。</p>}
      {reference && <><p>{reference.note}</p>
      <p>官方说明列出的模型目录：{reference.modelDirectory}。不代表云端安装状态。</p>
      <ul>{reference.modelNames.map((name) => <li key={name}>{name}</li>)}</ul>
      <a href={reference.url} target="_blank" rel="noreferrer">查看官方工作流说明 ↗</a></>}
    </details> : null;
  }
  const kinds: Record<string, string> = { image: "图像", video: "视频", audio: "音频", text: "文本" };
  return <details className="workflow-source-details directory-source-details">
    <summary>输入要求与模型 · {original.inputs.length} 个输入 · {original.models.length} 个模型文件</summary>
    {original.inputs.length ? <ol>{original.inputs.map((input) => <li key={input.id}>
      {input.description || input.name} · {kinds[input.dataType] ?? input.dataType} · {input.required ? "必需" : "可选"}
    </li>)}</ol> : <p>无需连接上游素材。</p>}
    <p>以下为工作流声明的模型需求，不代表云端安装状态。</p>
    <ul>{original.models.map((model, index) => <li key={index}>
      <strong>{model.name}</strong>{model.required === false && "（可选）"}<small>{model.relativePath}</small>
    </li>)}</ul>
    <p>配置版本 {original.version} · {original.configFile}</p>
    {libraryDetails}
    <p>原始执行文件：{original.executionFile || "未指定"}（{workflowExecutionStatus(workflow)}）。</p>
    {original.docsUrl.startsWith("https://") && <a href={original.docsUrl} target="_blank" rel="noreferrer">查看原工作流说明 ↗</a>}
  </details>;
}
