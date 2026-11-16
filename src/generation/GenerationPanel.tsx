import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  SlidersHorizontal,
  Play,
  Square,
  ArrowLeftRight,
  X,
  Check,
  Cloud,
  Maximize2,
  Clapperboard,
  ImageIcon,
  Music2,
  NotebookText,
  FolderOpen,
  Shuffle,
  RefreshCw,
  LoaderCircle,
  KeyRound,
} from "lucide-react";
import { useStore, activeCanvas, workflowCredentialValues } from "../stores/store";
import { detectWorkflowCredentials, missingWorkflowCredentials } from "../workflow/credentials";
import { activeWorkflows, executionWorkflows, activeConnection, isRunningHubProvider, nodeComputeState } from "../compute/providers";
import { resolvePrompt } from "../semantic/prompt";
import { getPromptMentionCandidates } from "../semantic/mentions";
import { resolveInputs, workflowInputRoleLabel } from "../semantic/resolver";
import { findWorkflow } from "../workflow/catalog";
import { WorkflowPicker, type WorkflowPickerMode } from "../workflow/WorkflowPicker";
import { GenerationContainer } from "./GenerationContainer";
import { GenerationSettingsPopover } from "./GenerationSettingsPopover";
import { workflowSelectionPatch } from "./workflow-selection";
import { closeGenerationPanelTarget, resolveGenerationPanelTarget, useGenerationPanelState } from "./generation-panel-state";
import { selectWorkflowOutput } from "../workflow/execution";
import { hasLoraModels, identifyLoraParameter, withServerLoraChoices } from "../workflow/lora-parameters";
import { useLoraModels } from "./use-lora-models";
import {
  busyPhases,
  idleTask,
  phaseLabels,
  type Role,
  type Parameter,
  type WorkflowDefinition,
} from "../types";
import { generate, cancelTask, resumeTask } from "./pipeline";
import { InputThumbnail } from "./InputThumbnail";
import { PromptEditor } from "./PromptEditor";
import { usePromptOptimization } from "../prompt-optimization/use-prompt-optimization";
import { OptimizationControls, OptimizationFeedback } from "../prompt-optimization/OptimizationControls";
import { IconButton } from "../components/ui";
import { computeSwitcherTarget, toggleComputeSwitcher } from "../settings/compute-switcher-trigger";
import { ratioParameterChoices } from "./ratio-parameter";
import { runningHubInstanceTypes } from "../runninghub/instance-types";
import { parameterOptionKey } from "../runninghub/parameter-contract";
import {
  applyParameterAction,
  parameterAction,
  parameterActionAvailable,
  parameterDisplay,
  dimensionRatioControls,
  dimensionRatioOptions,
  dimensionRatioPatch,
  dimensionRatioValue,
  generationParameterSurface,
  parameterRole,
} from "./parameter-actions";
import "./parameter-controls.css";
import "./workflow-management.css";

const runningHubModeParameter: Parameter = {
  key: "runningHubInstanceType",
  label: "运行模式",
  type: "select",
  default: "default",
  options: runningHubInstanceTypes.map(option => option.value),
  optionLabels: Object.fromEntries(runningHubInstanceTypes.map(option => [option.value, option.label])),
};

export function GenerationPanel() {
  const canvas = useStore(activeCanvas),
    projectId = useStore(s => s.project.id);
  const panelTarget = useGenerationPanelState(state => state.target);
  const node = resolveGenerationPanelTarget(panelTarget, projectId, canvas);
  const nodeId = node?.id ?? "";
  const workflows = useStore(s => activeWorkflows(nodeComputeState(s, canvas.id, nodeId))),
    savedWorkflows = useStore(s => executionWorkflows(nodeComputeState(s, canvas.id, nodeId))),
    computeProvider = useStore(s => nodeComputeState(s, canvas.id, nodeId).computeProvider),
    computeSwitcherOpen = useStore(s => s.modal === "compute-switcher" && computeSwitcherTarget.current?.canvasId === canvas.id && computeSwitcherTarget.current?.nodeId === nodeId),
    assets = useStore(s => s.project.assets),
    connection = useStore(s => activeConnection(nodeComputeState(s, canvas.id, nodeId)));
  const remoteLabel = computeProvider === "muse" ? "Muse" : computeProvider === "runninghub-workflow" ? "RunningHub 工作流" : "RunningHub AI 应用";
  const importModal = computeProvider === "muse" ? "settings" : computeProvider === "runninghub-workflow" ? "runninghub-remote-workflows" : computeProvider === "runninghub" ? "runninghub-workflows" : "workflow-import";
  const activeTask = useStore(
    (s) => s.project.tasks[node?.data.generation?.taskId ?? ""],
  );
  const task = activeTask ?? idleTask;
  const [selector, setSelector] = useState<WorkflowPickerMode | null>(null),
    [settingsOpen, setSettingsOpen] = useState(false),
    [settingsTab, setSettingsTab] = useState<"generation" | "nodes">("generation"),
    [parameterSearch, setParameterSearch] = useState(""),
    [expanded, setExpanded] = useState(false),
    [preparingNode, setPreparingNode] = useState("");
  const workflowButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setSelector(null); }, [node?.id, projectId, computeProvider]);
  useEffect(() => { setSettingsOpen(false); setSettingsTab("generation"); setParameterSearch(""); }, [node?.id, projectId, node?.data.generation?.workflowId]);
  const definition = findWorkflow(savedWorkflows, node?.data.generation?.workflowId ?? "");
  const branch = useMemo(() => definition ? selectWorkflowOutput(definition, node?.data.generation?.params ?? {}) : undefined,
    [definition, node?.data.generation?.params]);
  const hasLora = !!branch && hasLoraModels(branch);
  const loraModels = useLoraModels(computeProvider === "comfyui" && settingsOpen && hasLora && !busyPhases.includes(task.status), connection);
  const w = useMemo(() => {
    if (!branch || !hasLora || isRunningHubProvider(computeProvider)) return branch;
    // Authored enums may have been exported from another workstation. Display
    // available filenames only after reading this connection's loader contracts.
    const source = { ...branch, parameters: branch.parameters.map(parameter => {
      if (!identifyLoraParameter(parameter, branch).some(target => target.kind === "model")) return parameter;
      const { options: _options, optionLabels: _labels, optionValues: _values, ...rest } = parameter;
      return { ...rest, type: "text" as const, multiline: false };
    }) };
    return loraModels.info ? withServerLoraChoices(source, loraModels.info) : source;
  }, [branch, hasLora, loraModels.info, computeProvider]);
  const rawSurface = useMemo(() => w ? generationParameterSurface(w, w.runninghub ? node?.data.generation?.params : undefined) : { basic: [], advanced: [], other: [] }, [w, node?.data.generation?.params]);
  const mentionCandidates = useMemo(() => node ? getPromptMentionCandidates(canvas, node.id, assets) : [],
    [canvas.nodes, canvas.edges, node?.id, assets]);
  const optimization = usePromptOptimization({ canvas, nodeId: node?.id, workflow: branch, assets,
    disabled: busyPhases.includes(task.status), promptField: "generation" });
  if (!node?.data.generation) return null;
  const g = node.data.generation,
    busy = busyPhases.includes(task.status);
  const parameterSurface = { basic: rawSurface.basic.filter(p => !p.secret), advanced: rawSurface.advanced.filter(p => !p.secret), other: rawSurface.other.filter(p => !p.secret) };
  const inlineSourceParameters = w?.runninghub?.parameterSchemaVersion === 2;
  const stepParameters = inlineSourceParameters ? [] : parameterSurface.basic.filter(parameter => parameterRole(parameter, w) === "steps");
  const hasCoreSettings = parameterSurface.advanced.length > 0 || stepParameters.length > 0;
  const hasBoundRatio = !!w?.runninghub && parameterSurface.basic.some(parameter => parameterRole(parameter, w) === "ratio");
  const ratioControls = w && !hasBoundRatio && w.runninghub?.parameterSchemaVersion !== 2 ? dimensionRatioControls(w.runninghub ? { ...w, parameters: parameterSurface.basic } : w) : [];
  const ratioKeys = new Set(ratioControls.flatMap(control => [control.width.key, control.height.key]));
  const commonParameters = parameterSurface.basic.filter(parameter => inlineSourceParameters || (parameterRole(parameter, w) !== "steps" && (!!w?.runninghub || !ratioKeys.has(parameter.key))));
  const detailedParameters = parameterSurface.other;
  const hasSettings = hasCoreSettings || detailedParameters.length > 0;
  const activeSettingsTab = hasCoreSettings ? settingsTab : "nodes";
  const search = parameterSearch.trim().toLocaleLowerCase();
  const nodeParameters = detailedParameters.filter(parameter => !search || [parameter.label, parameter.key, parameter.group].some(value => value?.toLocaleLowerCase().includes(search)));
  const nodeParameterGroups = [...new Set(nodeParameters.map(parameter => parameter.group ?? "其他参数"))];
  const preparationKey = JSON.stringify([projectId, canvas.id, node.id]),
    starting = preparingNode === preparationKey,
    pendingImport = w?.library?.importStatus === "pending";
  const showRunningHubMode = isRunningHubProvider(computeProvider) && !!w?.runninghub;
  const credentialFields = w ? detectWorkflowCredentials(w) : [];
  const parameterCount = ratioControls.length + commonParameters.length;
  const parameterWidth = ratioControls.length * 84 + commonParameters.reduce((total, parameter) =>
    total + footerParameterWidth(parameter, g.params[parameter.key] ?? parameter.default, w), 0) + Math.max(0, parameterCount - 1) * 8;
  const actionWidth = 40 + Number(hasSettings) * 44 + Number(credentialFields.length > 0) * 44 + Number(showRunningHubMode) * 120 + Number(task.status === "interrupted" && activeTask?.executorType === "muse") * 44;
  const workflowControlWidth = w?.runninghub?.billingMode === "consumer" && w.runninghub.kind !== "app" ? 270 : 230;
  const panelWidth = Math.max(640, Math.min(1120, workflowControlWidth + parameterWidth + actionWidth + (parameterCount ? 20 : 10) + 42));
  const runningHubModeLocked = busy || starting || task.status === "interrupted";
  const runningHubInstanceType =
    (busy || task.status === "interrupted") && activeTask?.executorType === "runninghub"
      ? activeTask.runningHubInstanceType ?? "default"
      : g.runningHubInstanceType ?? "default";
  const pluginNotes = !pendingImport ? w?.library?.diagnostics?.filter(item => item.code === "node-definition-not-in-snapshot" || item.code.startsWith("manager-plugin-")) ?? [] : [];
  const inputs = canvas.edges
    .filter((e) => e.target === node.id)
    .sort((a, b) => (a.data?.order ?? 0) - (b.data?.order ?? 0));
  const resolved = resolvePrompt(canvas, node.id, g.prompt, w);
  const textInputs = busy ? (activeTask?.input.texts ?? []) : resolved.texts;
  const mediaInputs = inputs.filter(
    (e) => !textInputs.some((t) => t.edgeId === e.id),
  );
  const assignedInputRoles = new Map<string, string>();
  if (w?.inputSlots && !w.dynamicReferences) {
    try {
      for (const input of resolveInputs(canvas, node.id, w, assets)) assignedInputRoles.set(input.edgeId, input.semantic);
    } catch { /* Incomplete inputs keep the generic icon title until they can be routed. */ }
  }
  const removeInput = (edgeId: string) => {
    if (busy) return;
    const store = useStore.getState();
    store.editCanvas(
      (c) => ({ ...c, edges: c.edges.filter((e) => e.id !== edgeId) }),
      true,
    );
    if (store.selectedEdgeId === edgeId)
      useStore.setState({ selectedEdgeId: null });
  };
  const supportsMentions = node.data.kind === "image-generation" || node.data.kind === "video";
  const update = (patch: Partial<typeof g>) =>
    useStore.getState().patchNode(node.id, { generation: { ...g, ...patch } });
  const swap = () => {
    const edges = inputs.filter((e) => {
      const n = canvas.nodes.find((n) => n.id === e.source);
      return n?.data.assetId && assets[n.data.assetId]?.kind === "image";
    });
    if (edges.length !== 2) {
      useStore.getState().notify("首尾帧需要恰好两张图片。");
      return;
    }
    const imageSlots = w?.inputSlots?.filter(slot => slot.kind === "image") ?? [];
    const firstRole = imageSlots[0]?.semantic ?? "firstFrame";
    const lastRole = imageSlots.at(-1)?.semantic ?? "lastFrame";
    const first =
      edges.find((e) => e.data?.role === "firstFrame" || e.data?.role === firstRole) ??
      edges.find((e) => e.data?.role !== "lastFrame" && e.data?.role !== lastRole) ??
      edges[0];
    useStore.getState().editCanvas(
      (c) => ({
        ...c,
        edges: c.edges.map((e) =>
          edges.some((x) => x.id === e.id)
            ? {
                ...e,
                data: {
                  order: e.data?.order ?? 0,
                  role: (e.id === first.id ? lastRole : firstRole) as Role,
                },
              }
            : e,
        ),
      }),
      true,
    );
  };
  const generationButton = busy ? (
    <button
      type="button"
      className="generate-button"
      aria-label={activeTask?.executorType === "muse" ? "停止任务" : "取消生成"}
      title={phaseLabels[task.status] + (activeTask?.executorType === "muse" ? " · 停止本机队列任务；已经发送到 Muse 的任务可能仍会继续" : " · 取消生成") + (task.progress !== undefined ? " · " + task.progress + "%" : "")}
      onClick={() => void cancelTask(g.taskId!)}
    >
      <Square size={18} fill="currentColor" aria-hidden="true" />
    </button>
  ) : task.status === "interrupted" ? (
    <>
    <button
      type="button"
      className="generate-button"
      aria-label="恢复查询"
      title="恢复查询"
      onClick={() => void resumeTask(g.taskId!)}
    >
      <RefreshCw size={20} aria-hidden="true" />
    </button>
    {activeTask?.executorType === "muse" && <button
      type="button"
      className="generate-button"
      aria-label="停止任务"
      title="停止本机队列任务；已经发送到 Muse 的任务可能仍会继续"
      onClick={() => void cancelTask(g.taskId!)}
    >
      <Square size={18} fill="currentColor" aria-hidden="true" />
    </button>}
    </>
  ) : (
    <button
      type="button"
      className="generate-button"
      aria-label={starting ? "提交中" : "生成"}
      aria-busy={starting}
      disabled={
        starting || pendingImport || (!w?.template && !w?.muse) ||
        !!w.library?.executionIssue ||
        !!w.source?.issues.length
      }
      title={
        pendingImport ? "此工作流尚未完成自动转换" : w?.library?.executionIssue ??
        w?.source?.issues[0] ??
        (!w?.template && !w?.muse ? (computeProvider === "muse" ? "请选择 Muse 图片或视频" : isRunningHubProvider(computeProvider) ? "请选择 " + remoteLabel : "工作流尚未适配") : starting ? "提交中…" : "生成")
      }
      onClick={() => {
        setPreparingNode(preparationKey);
        void generate(canvas.id, node.id).finally(() => setPreparingNode(current => current === preparationKey ? "" : current));
      }}
    >
      {starting
        ? <LoaderCircle size={20} className="generation-submit-spinner" aria-hidden="true" />
        : <Play size={20} fill="currentColor" aria-hidden="true" />}
    </button>
  );
  return (
    <GenerationContainer key={node.id} nodeId={node.id}>
      <section
        aria-label={node.data.title + "生成面板"}
        className={
          "generation-panel nodrag nopan nowheel " +
          (isRunningHubProvider(computeProvider) ? "generation-panel-runninghub " : "") +
          (expanded ? "expanded" : "")
        }
        style={{ "--generation-panel-ideal-width": `${panelWidth}px` } as CSSProperties}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <header className="generation-header">
        {(mediaInputs.length > 0 || textInputs.length > 0) && (
          <div className="input-strip" aria-label="已连接的输入">
            {mediaInputs.map((e, i) => {
              const n = canvas.nodes.find((n) => n.id === e.source);
              const a = n?.data.assetId ? assets[n.data.assetId] : undefined;
              const kind = a?.kind ?? n?.data.kind;
              const InputIcon =
                kind === "video"
                  ? Clapperboard
                  : kind === "audio"
                    ? Music2
                    : kind === "reference"
                      ? FolderOpen
                      : ImageIcon;
              const status = !a
                ? n?.data.generation
                  ? "等待上游生成"
                  : "请先上传素材"
                : e.data?.role && e.data.role !== "auto"
                  ? workflowInputRoleLabel(w, e.data.role, a.kind)
                  : assignedInputRoles.has(e.id)
                    ? workflowInputRoleLabel(w, assignedInputRoles.get(e.id)!, a.kind)
                  : {
                      image: "图片参考",
                      video: "视频参考",
                      audio: "音频参考",
                      text: "文本参考",
                      file: "数据文件",
                    }[a.kind];
              const label =
                (n?.data.title ?? "素材 " + (i + 1)) + " · " + status;
              return (
                <div className="input-chip" key={e.id}>
                  <div className="input-icon-wrap">
                    <span
                      className={
                        "input-icon media-input-icon" + (!a ? " pending" : "")
                      }
                      role="img"
                      title={label}
                      aria-label={label}
                    >
                      <InputThumbnail
                        asset={a}
                        fallback={<InputIcon size={17} aria-hidden="true" />}
                      />
                    </span>
                    <button
                      type="button"
                      className="input-remove"
                      aria-label={
                        "移除连接：" + (n?.data.title ?? "素材 " + (i + 1))
                      }
                      title={busy ? "生成期间不能移除连接" : "移除这条连接"}
                      disabled={busy}
                      onClick={() => removeInput(e.id)}
                    >
                      <X size={10} />
                    </button>
                  </div>
                  {definition?.outputChoices &&
                    definition.outputChoices.length > 1 && (
                      <label className="output-choice">
                        输出结果
                        <select
                          aria-label="输出结果"
                          disabled={busy}
                          value={String(
                            g.params.__output ?? definition.output.nodeId,
                          )}
                          onChange={(e) => {
                            const output = definition.outputChoices!.find(
                              (o) => o.nodeId === e.target.value,
                            )!;
                            const kind =
                              output.kind === "image"
                                ? "image-generation"
                                : output.kind === "text"
                                  ? "text"
                                  : output.kind === "file"
                                    ? "tool"
                                    : (output.kind as "audio" | "video");
                            useStore.getState().patchNode(node.id, {
                              kind,
                              generation: {
                                ...g,
                                params: {
                                  ...g.params,
                                  __output: output.nodeId,
                                },
                              },
                            });
                          }}
                        >
                          {definition.outputChoices.map((o) => (
                            <option key={o.nodeId} value={o.nodeId}>
                              {o.label} · {o.kind}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                </div>
              );
            })}
            {textInputs.map((input) => (
              <div className="input-icon-wrap" key={input.edgeId}>
                <span
                  className={
                    "input-icon text-input-icon" +
                    (!input.text.trim() ? " pending" : "")
                  }
                  role="img"
                  aria-label={input.title + " · 提示词"}
                  title={input.title + " · 提示词"}
                >
                  <NotebookText size={17} aria-hidden="true" />
                </span>
                <button
                  type="button"
                  className="input-remove"
                  aria-label={"移除连接：" + input.title}
                  title={busy ? "生成期间不能移除连接" : "移除这条连接"}
                  disabled={busy}
                  onClick={() => removeInput(input.edgeId)}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            {w?.mode === "first-last-frame" && mediaInputs.length > 0 && (
              <IconButton title="交换首尾帧" disabled={busy} onClick={swap}>
                <ArrowLeftRight size={16} />
              </IconButton>
            )}
          </div>
        )}
          <div className="row generation-actions">
            <OptimizationControls controller={optimization} />
            <IconButton
              title="选择当前节点算力"
              className="generation-compute-trigger"
              aria-haspopup="dialog"
              aria-expanded={computeSwitcherOpen}
              aria-controls="compute-switcher"
              onClick={event => toggleComputeSwitcher(event.currentTarget, { canvasId: canvas.id, nodeId: node.id })}
            >
              <Cloud size={16} aria-hidden="true" />
            </IconButton>
            <IconButton title="展开面板" onClick={() => setExpanded(!expanded)}>
              <Maximize2 size={15} />
            </IconButton>
            <IconButton
              title="关闭生成面板"
              onClick={() => {
                closeGenerationPanelTarget();
                if (useStore.getState().selectedId === node.id) useStore.setState({ selectedId: null });
              }}
            >
              <X size={15} />
            </IconButton>
          </div>
        </header>
        <OptimizationFeedback controller={optimization} />
        {supportsMentions ? <PromptEditor value={g.prompt} candidates={mentionCandidates} disabled={busy}
          placeholder="" onChange={prompt => update({ prompt })} onSubmit={() => { void generate(canvas.id, node.id); }} /> : <textarea
          className="prompt"
          aria-label="提示词"
          disabled={busy}
          value={g.prompt}
          onChange={(e) => update({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter")
              void generate(canvas.id, node.id);
          }}
        />}
        {supportsMentions && resolved.missingMentions.length > 0 && <p className="prompt-mention-warning" role="status">
          引用素材已断开连接：{resolved.missingMentions.map(item => item.label).join("、")}。请重新连接素材或删除对应标签。
        </p>}
        <footer className="generation-footer">
          <div className="workflow-control">
            <button
              ref={workflowButtonRef}
              className="workflow-button"
              aria-haspopup="dialog"
              aria-expanded={!!selector}
              disabled={busy}
              onClick={() => {
                setSelector(selector ? null : "select");
              }}
            >
              <span className="workflow-mark">{computeProvider === "muse" ? "M" : "W"}</span>
              <span>
                <small>{w?.family ?? (computeProvider !== "comfyui" ? remoteLabel : "目录已更新")}</small>
                <strong>{w?.name ?? (computeProvider === "muse" ? "选择图片或视频" : isRunningHubProvider(computeProvider) ? "选择 " + remoteLabel : "重新选择工作流")}</strong>
              </span>
              <ChevronDown size={14} />
            </button>
            {selector && (
              <WorkflowPicker
                mode={selector}
                provider={computeProvider}
                workflows={workflows}
                current={definition}
                kind={node.data.kind}
                anchorRef={workflowButtonRef}
                onClose={() => setSelector(null)}
                onModeChange={setSelector}
                onImport={() => useStore.setState({ modal: importModal })}
                onSelect={(item) => {
                  useStore.getState().patchNode(node.id, workflowSelectionPatch(g, item));
                  setSelector(null);
                  if (missingWorkflowCredentials(item, workflowCredentialValues(useStore.getState(), item)).length)
                    useStore.getState().setCredentialWorkflow(item);
                }}
              />
            )}
          </div>
          <div className="basic-parameters" role="group" aria-label="生成参数">
            {ratioControls.map(control => {
              const value = dimensionRatioValue(control, g.params);
              const options = dimensionRatioOptions(control, g.params);
              return <label className="parameter parameter-ratio" key={control.key}>
                <span>{control.label}</span>
                <ParameterSelect parameter={{ key: control.key, label: control.label, type: "select", default: value, options: [...new Set([value, ...options])] }}
                  value={value} disabled={busy || !options.length} onChange={ratio => {
                    const patch = dimensionRatioPatch(control, ratio, g.params);
                    if (patch) update({ params: { ...g.params, ...patch } });
                  }} />
              </label>;
            })}
            {commonParameters
              .map((p) => (
                <ParameterInput
                  key={p.key}
                  p={p}
                  workflow={w}
                  value={g.params[p.key] ?? p.default}
                  disabled={busy}
                  onChange={(v) =>
                    update({ params: { ...g.params, [p.key]: v } })
                  }
                />
              ))}
          </div>
          <GenerationFooterActions>
          {hasSettings && <div className="generation-settings-control" ref={settingsButtonRef}>
            <IconButton title="生成设置" aria-expanded={settingsOpen} aria-haspopup="dialog"
              onClick={() => setSettingsOpen(!settingsOpen)}>
              <SlidersHorizontal size={19} />
            </IconButton>
            {settingsOpen && <GenerationSettingsPopover anchorRef={settingsButtonRef} onClose={() => setSettingsOpen(false)}>
              {hasCoreSettings && detailedParameters.length > 0 && <div className="generation-settings-tabs" role="tablist" aria-label="参数分类">
                <button type="button" role="tab" aria-selected={activeSettingsTab === "generation"} onClick={() => setSettingsTab("generation")}>LoRA 与步数</button>
                <button type="button" role="tab" aria-selected={activeSettingsTab === "nodes"} onClick={() => setSettingsTab("nodes")}>{w?.runninghub ? "参数设置" : "节点参数"} <span>{detailedParameters.length}</span></button>
              </div>}
              {activeSettingsTab === "generation" && <>
              {parameterSurface.advanced.length > 0 && <div className="lora-settings" role="region" aria-label="LoRA 设置">
                {hasLora && !isRunningHubProvider(computeProvider) && <div className="lora-model-toolbar">
                  <small role="status">{loraModels.message || "LoRA 模型来自当前工作站"}</small>
                  <button type="button" onClick={loraModels.refresh} disabled={busy || loraModels.loading || !connection.baseUrl.trim()}>
                    <RefreshCw size={13} className={loraModels.loading ? "spin" : undefined} aria-hidden="true" />刷新模型列表
                  </button>
                </div>}
                {[...new Set(parameterSurface.advanced.map(parameter => parameter.group ?? "LoRA"))].map(group => <details className="parameter-group" key={group} open={!w?.runninghub || new Set(parameterSurface.advanced.map(parameter => parameter.group)).size <= 2}>
                  <summary>{group}</summary>
                  <div>{parameterSurface.advanced.filter(parameter => (parameter.group ?? "LoRA") === group)
                    .sort((a, b) => Number(!!w && identifyLoraParameter(b, w).some(target => target.kind === "model")) - Number(!!w && identifyLoraParameter(a, w).some(target => target.kind === "model")))
                    .map(parameter => <ParameterInput key={parameter.key} p={parameter} workflow={w} compact
                      value={g.params[parameter.key] ?? parameter.default} disabled={busy}
                      onChange={value => update({ params: { ...g.params, [parameter.key]: value } })} />)}</div>
                </details>)}
              </div>}
              {stepParameters.length > 0 && <div className="parameter-settings-steps" role="group" aria-label="采样步数">
                {stepParameters.map(parameter => <ParameterInput key={parameter.key} p={parameter} workflow={w} compact
                  value={g.params[parameter.key] ?? parameter.default} disabled={busy}
                  onChange={value => update({ params: { ...g.params, [parameter.key]: value } })} />)}
              </div>}
              </>}
              {activeSettingsTab === "nodes" && <div className="workflow-node-settings" role="region" aria-label={w?.runninghub ? "可调参数" : "完整节点参数"}>
                <input className="node-parameter-search" type="search" aria-label={w?.runninghub ? "搜索可调参数" : "搜索节点参数"} placeholder={w?.runninghub ? "搜索可调参数" : "搜索参数或节点"} value={parameterSearch} onChange={event => setParameterSearch(event.target.value)} />
                <small role="status">{search ? `找到 ${nodeParameters.length} 项参数` : w?.runninghub ? `共 ${detailedParameters.length} 项可调参数` : `共 ${detailedParameters.length} 项参数，按节点分组`}</small>
                {nodeParameterGroups.map(group => <details className="parameter-group node-parameter-group" key={group} open={!!search}>
                  <summary>{group}<span>{nodeParameters.filter(parameter => (parameter.group ?? "其他参数") === group).length}</span></summary>
                  <div>{nodeParameters.filter(parameter => (parameter.group ?? "其他参数") === group).map(parameter => <ParameterInput key={parameter.key} p={parameter} workflow={w} compact
                    value={g.params[parameter.key] ?? parameter.default} disabled={busy}
                    onChange={value => update({ params: { ...g.params, [parameter.key]: value } })} />)}</div>
                </details>)}
                {!nodeParameterGroups.length && <p className="node-parameter-empty">没有匹配的参数</p>}
              </div>}
            </GenerationSettingsPopover>}
          </div>}
          {w && credentialFields.length > 0 && <IconButton title="工作流 API Key" onClick={() => useStore.getState().setCredentialWorkflow(w)}><KeyRound size={18} /></IconButton>}
          {showRunningHubMode ? <div className="generation-run-controls">
            <div className="runninghub-instance-control parameter">
              <span>运行模式</span>
              <ParameterSelect
                parameter={runningHubModeParameter}
                value={runningHubInstanceType}
                disabled={runningHubModeLocked}
                onChange={value => {
                  if (runningHubModeLocked) return;
                  const selected = runningHubInstanceTypes.find(option => option.value === value);
                  if (selected) update({ runningHubInstanceType: selected.value });
                }}
              />
            </div>
            {generationButton}
          </div> : generationButton}
          </GenerationFooterActions>
        </footer>
        {((!w?.template && !w?.muse) || pendingImport) && (
          <div className="availability-note">
            <i />
            {pendingImport ? "此工作流尚未完成自动转换，原始文件已完整保留。" : w
              ? (w.library?.executionIssue ??
                (w.original
                  ? "工作流已加入目录，执行适配待完成。"
                  : "尚未找到对应的原始配置与执行文件，暂时无法生成。"))
              : computeProvider === "muse" ? "请选择 Muse 图片或视频；在算力设置中登录 Muse 账号。" : isRunningHubProvider(computeProvider) ? "请选择已添加的 " + remoteLabel + "。" : "该工作流已从当前目录移除，请重新选择。已有素材与生成历史保留。"}
            {!w && isRunningHubProvider(computeProvider) && <button type="button" onClick={() => useStore.setState({ modal: importModal })}>添加 {remoteLabel}</button>}
            {pendingImport && <button type="button" onClick={() => useStore.setState({ modal: "workflow-library" })}>继续自动转换</button>}
          </div>
        )}
        {!!pluginNotes.length && <details className="workflow-source-details">
          <summary>插件自动补齐结果 · {pluginNotes.length} 项</summary>
          <p>以下为上次自动处理记录。可在工作流库中继续自动搜索、下载并安装缺失插件。</p>
          <ul>{pluginNotes.map((item, index) => <li key={index}>{item.code.startsWith("manager-plugin-") && item.classType && <strong>{item.classType}： </strong>}{item.message}</li>)}</ul>
        </details>}
      </section>
    </GenerationContainer>
  );
}
function GenerationFooterActions({ children }: { children: ReactNode }) {
  return <div className="generation-footer-actions">{children}</div>;
}
function parameterOptionDisplay(parameter: Parameter, option: string) {
  const label = parameter.optionLabels?.[option] ?? option;
  // Presentation only: preserve the original option key and submitted value.
  return label.replace(/^(\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?)\s*[（(][^()（）]*[）)]\s*$/, "$1");
}
function footerParameterWidth(parameter: Parameter, value: string | number | boolean, workflow?: WorkflowDefinition) {
  const action = parameterAction(parameter, workflow), role = parameterRole(parameter, workflow);
  if (workflow?.runninghub?.parameterSchemaVersion === 2) {
    const textWidth = (text: string) => [...text].reduce((width, character) => width + (/[^\x00-\x7f]/.test(character) ? 12 : 7), 0);
    const labelWidth = textWidth(parameter.label) + 8;
    if (parameter.type === "number") return Math.max(56, labelWidth, textWidth(parameterDisplay(value)) + 28 + (action ? 32 : 0));
    if (workflow.runninghub.billingMode === "consumer" && workflow.runninghub.kind !== "app" && role === "ratio") return Math.max(84, labelWidth);
    const option = parameterOptionKey(parameter, value);
    const display = parameterOptionDisplay(parameter, option);
    const valueWidth = parameter.type === "select" ? textWidth(display) + 36
      : parameter.type === "text" ? 144 : textWidth(parameterDisplay(value)) + 24 + (action ? 32 : 0);
    return Math.min(240, Math.max(72, labelWidth, valueWidth));
  }
  // Reserve space for every seed digit plus padding and the action button.
  if (action?.kind === "seed") return Math.max(78, Math.ceil(parameterDisplay(value).length * 7.5) + 48);
  if (role === "ratio") return 84;
  if (role === "width" || role === "height") return 68;
  if (action?.kind === "increment") return action.amount >= 1 ? 78 : 84;
  return parameter.type === "number" || parameter.type === "boolean" ? 72 : 100;
}
function ParameterInput({
  p,
  value,
  onChange,
  disabled,
  workflow,
  compact = false,
}: {
  p: Parameter;
  value: string | number | boolean;
  onChange: (v: string | number | boolean) => void;
  disabled: boolean;
  workflow?: WorkflowDefinition;
  compact?: boolean;
}) {
  const action = parameterAction(p, workflow);
  const modelSuggestionsId = useId();
  const sourceControl = workflow?.runninghub?.parameterSchemaVersion === 2 ? p.sourceControl : undefined;
  const [numberDraft, setNumberDraft] = useState<string>();
  const remoteWorkflow = workflow?.runninghub?.billingMode === "consumer" && workflow.runninghub.kind !== "app";
  const ratioControl = (!sourceControl || remoteWorkflow) && (p.type === "text" || p.type === "select") && parameterRole(p, workflow) === "ratio";
  const freeRatio = p.type === "text" && ratioControl;
  const loraModel = !sourceControl && workflow && identifyLoraParameter(p, workflow).some(target => target.kind === "model");
  const freeModel = loraModel && p.type === "text";
  const dimension = ["width", "height"].includes(parameterRole(p, workflow) ?? "");
  const chooser = ratioControl ? ratioParameterChoices(p, String(value), workflow)
    : loraModel && p.type === "select" ? { ...p, options: [...new Set([String(value), ...(p.options ?? [])])] } : p;
  return (
    <label className={"parameter" + (action ? " parameter-with-action" : "") + (action?.kind === "seed" ? " parameter-seed" : "") + (ratioControl ? " parameter-ratio" : "") + (dimension ? " parameter-dimension" : "") + (loraModel ? " parameter-lora-model" : "")}
      style={{ "--parameter-width": `${footerParameterWidth(p, value, workflow)}px` } as CSSProperties}>
      <span title={p.label + (p.description ? " · " + p.description : "")}>
        {p.model && !loraModel ? "模型 · " : ""}
        {compact && !loraModel ? p.label.replace(/^LoRA\s+/, "") : p.label}
      </span>
      {chooser.type === "select" || freeRatio ? (
        <ParameterSelect
          parameter={chooser}
          value={parameterOptionKey(chooser, value)}
          onChange={(key) => onChange(p.optionValues?.[key] ?? key)}
          disabled={disabled}
          compact={compact}
          editable={freeRatio && chooser.type === "text"}
        />
      ) : p.type === "text" && p.multiline ? (
        <textarea
          value={String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : p.type === "boolean" ? (
        <input
          type="checkbox"
          checked={!!value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : (
        <div className="parameter-value-row">
          <input
            aria-label={p.label}
            type={
              p.secret ? "password" : p.type === "number" ? "number" : "text"
            }
            value={p.type === "number" && numberDraft !== undefined ? numberDraft : parameterDisplay(value)}
            title={loraModel ? String(value) : undefined}
            min={p.min}
            max={p.max}
            step={p.step ?? (p.numericType === "float" || sourceControl && /^(?:FLOAT|DOUBLE|NUMBER)$/.test(sourceControl.valueType) ? "any" : 1)}
            list={freeModel ? modelSuggestionsId : undefined}
            disabled={disabled}
            onChange={(e) => {
              if (p.type !== "number") { onChange(e.target.value); return; }
              const raw = e.target.value;
              setNumberDraft(raw);
              if (raw.trim() && Number.isFinite(Number(raw))) onChange(Number(raw));
            }}
            onBlur={() => setNumberDraft(undefined)}
          />
          {freeModel && <datalist id={modelSuggestionsId}>{[...new Set([String(value), String(p.default), ...(p.options ?? [])])].map(name => <option key={name} value={name} />)}</datalist>}
          {action && (
            <button
              type="button"
              className="parameter-action"
              title={action.title}
              aria-label={action.title}
              disabled={
                disabled || !parameterActionAvailable(p, Number(value), action)
              }
              onClick={() =>
                onChange(applyParameterAction(p, Number(value), action))
              }
            >
              <Shuffle size={17} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </label>
  );
}

function ParameterSelect({
  parameter,
  value,
  onChange,
  disabled,
  compact = false,
  editable = false,
}: {
  parameter: Parameter;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  compact?: boolean;
  editable?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null),
    editor = useRef<HTMLInputElement>(null),
    editableAnchor = useRef<HTMLDivElement>(null);
  const options = parameter.options ?? [];
  const selectedIndex = Math.max(0, options.indexOf(value));
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(selectedIndex);
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    width: 150,
    maxHeight: 240,
  });
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) (editable ? editor.current : trigger.current)?.focus();
  };
  const choose = (index: number) => {
    if (options[index] === undefined || disabled) return;
    onChange(options[index]);
    close(true);
  };
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = (editable ? editableAnchor.current : trigger.current)?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 156), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 12,
        above = rect.top - 12;
      const preferredHeight = Math.min(250, options.length * (compact ? 38 : 44) + 10);
      const useAbove = below < preferredHeight && above > below;
      const maxHeight = Math.max(
        44,
        Math.min(preferredHeight, useAbove ? above : below),
      );
      setPosition({
        top: useAbove ? Math.max(8, rect.top - maxHeight - 5) : rect.bottom + 5,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        width,
        maxHeight,
      });
    };
    place();
    menu.current?.focus();
    window.addEventListener("resize", place);
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !editableAnchor.current?.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const scrollOutside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scrollOutside, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scrollOutside, true);
    };
  }, [open, options.length, compact, editable]);
  useEffect(() => {
    if (open)
      menu.current
        ?.querySelector<HTMLElement>(`[id="${id}-option-${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);
  const keyDown = (event: KeyboardEvent) => {
    // A second Escape from a collapsed compact selector closes its settings popover.
    if (compact && event.key === "Escape" && !open) return;
    event.stopPropagation();
    if (disabled || !options.length) return;
    if (
      ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape"].includes(
        event.key,
      )
    )
      event.preventDefault();
    if (event.key === "Escape") {
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      if (open) choose(active);
      else {
        setActive(selectedIndex);
        setOpen(true);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!open) {
        setActive(selectedIndex);
        setOpen(true);
      } else
        setActive(
          (index) =>
            (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
            options.length,
        );
    } else if (event.key === "Home" || event.key === "End") {
      setActive(event.key === "Home" ? 0 : options.length - 1);
      setOpen(true);
    } else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const matching = options.findIndex((option) =>
        (parameterOptionDisplay(parameter, option))
          .toLocaleLowerCase()
          .startsWith(event.key.toLocaleLowerCase()),
      );
      if (matching >= 0) {
        setActive(matching);
        setOpen(true);
      }
    }
  };
  return (
    <>
      {editable ? <div ref={editableAnchor} className="parameter-editable-select">
        <input
          ref={editor}
          type="text"
          role="combobox"
          aria-label={parameter.label}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-haspopup="listbox"
          aria-autocomplete="none"
          title={value}
          value={value}
          disabled={disabled}
          onChange={event => { onChange(event.target.value); setOpen(false); }}
          onKeyDown={event => {
            // Keep ordinary text editing keys in the editor. Arrows open the
            // complete choices rather than a native datalist's filtered subset.
            if (["ArrowDown", "ArrowUp", "Escape"].includes(event.key) || (open && event.key === "Enter")) keyDown(event);
          }}
        />
        <button
          ref={trigger}
          type="button"
          aria-label={`展开${parameter.label}选项`}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-haspopup="listbox"
          disabled={disabled || !options.length}
          onKeyDown={keyDown}
          onClick={() => { setActive(selectedIndex); setOpen(previous => !previous); }}
        ><ChevronDown size={12} aria-hidden="true" /></button>
      </div> : <button
        ref={trigger}
        type="button"
        className="parameter-select-trigger"
        role="combobox"
        aria-label={parameter.label}
        title={parameterOptionDisplay(parameter, value)}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="listbox"
        disabled={disabled || !options.length}
        onKeyDown={keyDown}
        onClick={() => {
          if (open) close();
          else {
            setActive(selectedIndex);
            setOpen(true);
          }
        }}
      >
        <span>{parameterOptionDisplay(parameter, value)}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>}
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            className={"parameter-select-menu nodrag nopan nowheel" + (compact ? " parameter-select-menu-compact" : "")}
            role="listbox"
            aria-label={parameter.label}
            aria-activedescendant={`${id}-option-${active}`}
            tabIndex={-1}
            style={position}
            onKeyDown={keyDown}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            {options.map((option, index) => (
              <button
                key={option}
                id={`${id}-option-${index}`}
                type="button"
                role="option"
                aria-selected={option === value}
                tabIndex={-1}
                className={
                  "parameter-select-option" +
                  (active === index ? " active" : "")
                }
                // A stationary pointer can enter an option when the portal opens or
                // repositions. Only an actual pointer move should replace keyboard focus.
                onPointerMove={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <span>{parameterOptionDisplay(parameter, option)}</span>
                {option === value && <Check size={13} aria-hidden="true" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
