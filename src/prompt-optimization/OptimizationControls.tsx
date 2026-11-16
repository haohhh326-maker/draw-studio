import { executionWorkflows, nodeComputeState } from "../compute/providers";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, LoaderCircle, RefreshCw, Settings2, Sparkles, X } from "lucide-react";
import { IconButton } from "../components/ui";
import { activeCanvas, useStore } from "../stores/store";
import { findWorkflow } from "../workflow/catalog";
import { selectWorkflowOutput } from "../workflow/execution";
import { describeCanvasOptimizationTarget, optimizationPromptField } from "./context";
import { optimizationModelLabel, optimizationTaskLabel } from "./target-labels";
import { optimizationClient } from "./client";
import { useOptimizationPanel } from "./settings-panel-state";
import type { OptimizationController } from "./use-prompt-optimization";
import type { OptimizationModel, OptimizationSettings, OptimizationTarget, SkillStatus, VisionCapability } from "./types";
import { OPTIMIZATION_CONTEXT_TOKEN_LIMITS, OPTIMIZATION_OUTPUT_TOKEN_LIMITS } from "./types";
import "./optimization.css";

const capabilityLabel = (capability: VisionCapability) => ({ vision: "支持视觉", text: "纯文本", unknown: "视觉能力未知" })[capability];
export function OptimizationOutputTokenSetting({ value, disabled, onChange }: {
  value: number; disabled: boolean; onChange: (value: number) => void;
}) {
  return <><label>最大输出（token）<input type="number" min={OPTIMIZATION_OUTPUT_TOKEN_LIMITS.min} max={OPTIMIZATION_OUTPUT_TOKEN_LIMITS.max} step={1}
    value={value} disabled={disabled} aria-describedby="optimization-output-token-help" onChange={event => {
      const next = event.target.valueAsNumber;
      if (Number.isFinite(next)) onChange(next);
    }} /></label>
    <small id="optimization-output-token-help">这是本次生成的输出上限，必须小于总上下文容量。</small></>;
}
export function OptimizationContextTokenSetting({ value, disabled, onChange }: {
  value: number; disabled: boolean; onChange: (value: number) => void;
}) {
  return <><label>上下文容量（token）<input type="number" min={OPTIMIZATION_CONTEXT_TOKEN_LIMITS.min} max={OPTIMIZATION_CONTEXT_TOKEN_LIMITS.max} step={1}
    value={value} disabled={disabled} aria-describedby="optimization-context-token-help" onChange={event => {
      const next = event.target.valueAsNumber;
      if (Number.isFinite(next)) onChange(next);
    }} /></label>
    <small id="optimization-context-token-help">token 不是字数。上下文包含输入与输出，实际容量受模型支持和可用内存限制。</small></>;
}
export function OptimizationControls({ controller }: { controller: OptimizationController }) {
  const open = useOptimizationPanel(state => state.open);
  const computeProvider = controller.computeProvider;
  const settingsButton = useRef<HTMLButtonElement>(null);
  return <div className="optimization-controls">
    <IconButton title={controller.loading ? "取消提示词优化" : computeProvider === "comfyui" ? "AI 优化" : "DeepSeek 优化"} aria-busy={controller.loading} disabled={controller.disabled && !controller.loading}
      onClick={() => controller.loading ? controller.cancel() : void controller.run()}>
      {controller.loading ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
    </IconButton>
    <IconButton title={controller.promptVersion === "optimized" ? "切换到原文" : "切换到优化提示词"}
      aria-pressed={controller.promptVersion === "optimized"} disabled={!controller.canToggle || controller.disabled || controller.loading}
      onClick={controller.toggleVersion}>
      <ArrowLeftRight size={14} aria-hidden="true" />
    </IconButton>
    <button type="button" className="icon-button" ref={settingsButton} title="AI 优化设置" aria-label="AI 优化设置" aria-controls="optimization-settings" aria-expanded={open} disabled={controller.loading || !controller.target}
      onClick={() => useOptimizationPanel.setState({ open: true, target: controller.target ?? null,
        canvasId: controller.canvasId, nodeId: controller.nodeId, promptField: controller.promptField, returnFocus: settingsButton.current })}>
      <Settings2 size={14} aria-hidden="true" />
    </button>
  </div>;
}

/** Mounted outside the selected node, so canvas clicks and selection changes never dismiss settings. */
export function OptimizationSettingsDock() {
  const { open, target: retainedTarget, canvasId: retainedCanvasId, nodeId: retainedNodeId, promptField: retainedField } = useOptimizationPanel();
  const canvas = useStore(state => open && retainedCanvasId ? state.project.canvases.find(item => item.id === retainedCanvasId) ?? activeCanvas(state) : activeCanvas(state));
  const selectedId = useStore(state => state.selectedId);
  const targetNodeId = open && retainedNodeId ? retainedNodeId : selectedId ?? "";
  const computeProvider = useStore(state => nodeComputeState(state, canvas.id, targetNodeId).computeProvider);
  const workflows = useStore(state => executionWorkflows(nodeComputeState(state, canvas.id, targetNodeId)));
  const assets = useStore(state => state.project.assets);
  const node = canvas.nodes.find(item => item.id === targetNodeId);
  const field = node ? optimizationPromptField(node, node.id === retainedNodeId ? retainedField : undefined) : retainedField;
  const target = useMemo(() => {
    if (!node || (!node.data.generation && node.data.kind !== "text")) return retainedTarget;
    const definition = findWorkflow(workflows, node.data.generation?.workflowId ?? "");
    const workflow = definition ? selectWorkflowOutput(definition, node.data.generation?.params ?? {}) : undefined;
    return describeCanvasOptimizationTarget(canvas, node, workflow, assets, field);
  }, [node, workflows, retainedTarget, canvas, assets, field]);
  const targetKey = JSON.stringify(target);
  useEffect(() => {
    if (open && target && targetKey !== JSON.stringify(retainedTarget))
      useOptimizationPanel.setState({ target, canvasId: canvas.id, nodeId: node?.id, promptField: field });
  }, [open, targetKey, retainedTarget, canvas.id, node?.id, field]);
  const close = () => {
    const button = useOptimizationPanel.getState().returnFocus;
    useOptimizationPanel.setState({ open: false });
    if (button?.isConnected) button.focus();
  };
  return open && target ? computeProvider === "comfyui"
    ? <OptimizationSettingsPanel target={target} onClose={close} />
    : <DeepSeekSettingsPanel target={target} onClose={close} /> : null;
}

export function OptimizationFeedback({ controller }: { controller: OptimizationController }) {
  if (!controller.error) return null;
  return <div className="optimization-feedback error" role="alert">
    <span>{controller.error.message}</span>
    {controller.error.textOnlyAllowed && <button type="button" disabled={controller.loading || controller.disabled} onClick={() => void controller.run(true)}>仅基于文本优化</button>}
  </div>;
}

type DeepSeekSession = { status: "disconnected" | "login-required" | "connected"; message: string };
function deepSeekBridgePath(route: string): string {
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const sameHost = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  return (desktop && !sameHost ? "http://127.0.0.1:1420" : "") + "/__canvas/deepseek/" + route;
}
async function deepSeekSession(route: "session" | "open", signal: AbortSignal): Promise<DeepSeekSession> {
  const response = await fetch(deepSeekBridgePath(route), {
    method: route === "open" ? "POST" : "GET", signal,
    ...(route === "open" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
  });
  if (!(response.headers.get("content-type") ?? "").includes("application/json"))
    throw new Error("DeepSeek 本地连接服务尚未启动，请重新启动画布服务。");
  const result = await response.json() as DeepSeekSession & { error?: string };
  if (!response.ok) throw new Error(result.error || `DeepSeek 连接返回 HTTP ${response.status}。`);
  return result;
}
function DeepSeekSettingsPanel({ target, onClose }: { target: OptimizationTarget; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const sessionRequest = useRef<AbortController | null>(null);
  const settingsRequest = useRef<AbortController | null>(null);
  const [session, setSession] = useState<DeepSeekSession | null>(null);
  const [settings, setSettings] = useState<OptimizationSettings | null>(null);
  const [skill, setSkill] = useState<SkillStatus | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false), [settingsBusy, setSettingsBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const busy = sessionBusy || settingsBusy;
  const targetKey = JSON.stringify(target);
  useEffect(() => {
    panel.current?.focus();
    const sessionController = new AbortController(), settingsController = new AbortController();
    sessionRequest.current = sessionController; settingsRequest.current = settingsController;
    setSessionBusy(true); setSettingsBusy(true);
    void deepSeekSession("session", sessionController.signal)
      .then(value => { if (!sessionController.signal.aborted) setSession(value); })
      .catch(cause => { if (!sessionController.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取 DeepSeek 连接。"); })
      .finally(() => { if (!sessionController.signal.aborted) setSessionBusy(false); });
    void optimizationClient.settings(settingsController.signal, "runninghub")
      .then(value => { if (!settingsController.signal.aborted) setSettings(value); })
      .catch(cause => { if (!settingsController.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取优化设置。"); })
      .finally(() => { if (!settingsController.signal.aborted) setSettingsBusy(false); });
    return () => { sessionController.abort(); settingsController.abort(); sessionRequest.current = null; settingsRequest.current = null; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void optimizationClient.skills(target, false, controller.signal).then(value => {
      if (!controller.signal.aborted) setSkill(value);
    }).catch(() => { if (!controller.signal.aborted) setSkill(null); });
    return () => controller.abort();
  }, [targetKey]);
  const loadSession = async (route: "session" | "open") => {
    sessionRequest.current?.abort();
    const controller = new AbortController(); sessionRequest.current = controller;
    setSessionBusy(true); setError(""); setNotice("");
    try {
      const value = await deepSeekSession(route, controller.signal);
      if (!controller.signal.aborted) setSession(value);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "DeepSeek 连接失败。"); }
    finally { if (!controller.signal.aborted) setSessionBusy(false); }
  };
  const save = async () => {
    if (!settings || busy) return;
    settingsRequest.current?.abort();
    const controller = new AbortController(); settingsRequest.current = controller;
    setSettingsBusy(true); setError(""); setNotice("");
    try {
      const saved = await optimizationClient.saveSettings({ language: settings.language, skillDirectory: settings.skillDirectory }, controller.signal);
      if (controller.signal.aborted) return;
      setSettings(saved);
      setSkill(await optimizationClient.skills(target, true, controller.signal));
      if (!controller.signal.aborted) setNotice("提示词语言与 Skill 目录已保存。");
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "保存失败。"); }
    finally { if (!controller.signal.aborted) setSettingsBusy(false); }
  };
  return createPortal(<aside id="optimization-settings" ref={panel} className="optimization-settings nodrag nopan nowheel" aria-label="DeepSeek 提示词优化设置" tabIndex={-1}
    onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <header><strong>DeepSeek 提示词优化</strong><IconButton title="关闭 AI 优化设置" onClick={onClose}><X size={14} /></IconButton></header>
    <p>除 AutoDL 外，星光按钮使用 DeepSeek 网页优化当前提示词。</p>
    <p role="status">连接状态：{session?.status === "connected" ? "已连接" : session?.status === "login-required" ? "请登录" : "未连接"}。{session?.message}</p>
    <div className="optimization-setting-row">
      <button type="button" disabled={busy} onClick={() => void loadSession("open")}>连接已有会话</button>
      <button type="button" disabled={busy} onClick={() => void loadSession("session")}><RefreshCw size={13} />刷新状态</button>
    </div>
    <small>DeepSeek 在后台使用本机已有会话。需要登录时，点击画布顶部的显示器图标，再选择 DeepSeek，在画布窗口中操作原聊天页面。优化会发送提示词、工作流信息与 Skill 文字；不会上传图片或视频画面。</small>
    {settings && <>
      <label>输出语言<select value={settings.language} disabled={busy} onChange={event => setSettings({ ...settings, language: event.target.value as OptimizationSettings["language"] })}>
        <option value="zh">中文</option><option value="en">English</option>
      </select></label>
      <label>Skill 目录<input value={settings.skillDirectory} disabled={busy} onChange={event => setSettings({ ...settings, skillDirectory: event.target.value })} /></label>
      <div className="optimization-skill-status"><span>生成模型：{optimizationModelLabel(target) || "通用"}</span><span>任务：{optimizationTaskLabel(target)}</span>
        <span>当前 Skill：{skill?.match?.name ?? "尚未匹配"}</span></div>
      <footer><button type="button" className="optimization-save" disabled={busy} onClick={() => void save()}>保存设置</button></footer>
    </>}
    {busy && <p role="status"><LoaderCircle size={13} className="spin" />正在读取连接…</p>}
    {error && <p className="optimization-settings-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </aside>, document.body);
}

function OptimizationSettingsPanel({ target, onClose }: {
  target: OptimizationTarget; onClose: () => void;
}) {
  const connection = useStore(state => state.connection);
  const panel = useRef<HTMLElement>(null);
  const abort = useRef(new AbortController());
  const skillRequest = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState<OptimizationSettings | null>(null), [apiKey, setApiKey] = useState(""), [keyProvided, setKeyProvided] = useState(false);
  const [models, setModels] = useState<OptimizationModel[]>([]), [mmprojModels, setMmprojModels] = useState<string[]>([]), [skill, setSkill] = useState<SkillStatus | null>(null);
  const [loading, setLoading] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState(""), [skillError, setSkillError] = useState("");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const targetKey = JSON.stringify(target);
  const latestTarget = useRef(target);
  latestTarget.current = target;
  const connectionKey = JSON.stringify([connection.baseUrl, connection.token, connection.authHeader, connection.authPrefix]);
  const lastConnectionKey = useRef(connectionKey);
  const projectorFor = (settings: OptimizationSettings, inventory: OptimizationModel[], files: string[]) => {
    const visual = inventory.find(model => model.id === settings.modelId);
    const candidates = (visual?.mmprojCandidates ?? []).filter(id => files.includes(id));
    return candidates.includes(settings.mmproj) ? settings.mmproj
      : visual?.recommendedMmproj && candidates.includes(visual.recommendedMmproj) ? visual.recommendedMmproj : "";
  };
  const acceptModels = (found: { models: OptimizationModel[]; mmprojModels?: string[]; warning?: string }) => {
    const files = [...new Set(found.mmprojModels ?? [])];
    setModels(found.models); setMmprojModels(files);
    if (found.warning && !found.models.length) { setError(found.warning); setNotice(""); }
    else setNotice(found.warning || `已读取 ${found.models.filter(model => model.available).length} 个可用模型。`);
    setDraft(current => {
      if (!current || current.provider !== "comfyui") return current;
      const onlyModel = found.models.filter(model => model.available);
      const next = !current.modelId && onlyModel.length === 1 ? { ...current, modelId: onlyModel[0].id } : current;
      return found.models.some(model => model.id === next.modelId)
        ? { ...next, visionModelId: "", mmproj: projectorFor(next, found.models, files) } : next;
    });
  };
  const readSkill = async (refresh = false) => {
    skillRequest.current?.abort();
    const controller = new AbortController();
    skillRequest.current = controller;
    const requestedTarget = latestTarget.current, requestedKey = JSON.stringify(requestedTarget);
    setSkill(null); setSkillError("");
    try {
      const status = await optimizationClient.skills(requestedTarget, refresh, controller.signal);
      if (!controller.signal.aborted && skillRequest.current === controller && JSON.stringify(latestTarget.current) === requestedKey) setSkill(status);
    } catch (cause) {
      if (!controller.signal.aborted && skillRequest.current === controller) setSkillError(cause instanceof Error ? cause.message : "无法读取 Skill。");
    }
  };
  useEffect(() => { panel.current?.focus(); }, []);
  useEffect(() => {
    abort.current.abort();
    const controller = new AbortController(); abort.current = controller;
    setLoading(true);
    void optimizationClient.settings(controller.signal, "comfyui").then(async settings => {
      if (controller.signal.aborted) return;
      setDraft(settings); setSettingsLoaded(true);
      const inventory = await optimizationClient.models(controller.signal);
      if (!controller.signal.aborted) acceptModels(inventory);
    })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法加载设置。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!settingsLoaded) return;
    void readSkill();
    const controller = skillRequest.current;
    return () => controller?.abort();
  }, [targetKey, settingsLoaded, connectionKey]);
  useEffect(() => () => { abort.current.abort(); skillRequest.current?.abort(); }, []);
  useEffect(() => {
    if (lastConnectionKey.current === connectionKey) return;
    lastConnectionKey.current = connectionKey;
    if (!draft || draft.provider !== "comfyui" || draft.connectionSource !== "canvas") return;
    abort.current.abort(); abort.current = new AbortController();
    setModels([]); setMmprojModels([]); setLoading(false); setError("");
    setNotice("当前画布连接已变更，请读取该连接的模型。");
  }, [connectionKey, draft?.provider, draft?.connectionSource]);
  const update = (patch: Partial<OptimizationSettings>) => setDraft(current => current ? { ...current, ...patch } : current);
  const invalidateModels = () => { setModels([]); setMmprojModels([]); setNotice(""); setError(""); };
  const save = async (refreshModels = false, refreshSkills = false) => {
    if (!draft || loading) return;
    const controller = abort.current;
    setLoading(true); setNotice(""); setError("");
    try {
      const saved = await optimizationClient.saveSettings({ ...draft, ...(keyProvided && !usesCanvas ? { apiKey } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      // A previous target/directory read must not replace the state after this save.
      skillRequest.current?.abort();
      setSkill(null); setSkillError("");
      setDraft(saved); setApiKey(""); setKeyProvided(false);
      if (refreshModels) {
        const found = await optimizationClient.models(controller.signal, true);
        if (controller.signal.aborted) return;
        acceptModels(found);
      } else setNotice("默认模型、语言和 Skill 目录已保存。");
      if (!controller.signal.aborted) await readSkill(refreshSkills);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "保存失败。"); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const listed = new Map(models.map(model => [model.id, model]));
  const selectedModel = models.find(model => model.id === draft?.modelId);
  const capability = selectedModel?.capability ?? (draft?.provider === "openai-compatible" ? draft.capabilities[draft.modelId] : undefined) ?? "unknown";
  const compatibleProjectors = selectedModel?.mmprojCandidates ?? [];
  const usesCanvas = draft?.provider === "comfyui";
  const visionModels = models.filter(model => model.available && model.capability === "vision");
  const chooseModel = (patch: Partial<OptimizationSettings>) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    update({ ...patch, ...(draft.provider === "comfyui" ? { visionModelId: "", mmproj: projectorFor(next, models, mmprojModels) } : {}) });
  };
  return createPortal(<aside id="optimization-settings" ref={panel} className="optimization-settings nodrag nopan nowheel" aria-label="AI 提示词优化设置" tabIndex={-1}
    onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
    onKeyDown={event => { event.stopPropagation(); }}>
    <header><strong>AI 提示词优化</strong><IconButton title="关闭 AI 优化设置" onClick={onClose}><X size={14} /></IconButton></header>
    {error && <p className="optimization-settings-error" role="alert">{error}</p>}
    {skillError && <p className="optimization-settings-error" role="alert">{skillError}</p>}
    {draft && <>
      <label>优化后端<select value={draft.provider} disabled={loading} onChange={event => {
        const provider = event.target.value as OptimizationSettings["provider"];
        update({ provider, connectionSource: provider === "comfyui" ? "canvas" : "custom", modelId: "", visionModelId: "", mmproj: "" });
        setApiKey(""); setKeyProvided(false); invalidateModels();
      }}>
        <option value="comfyui">ComfyUI · GGUF 优化工作流</option><option value="openai-compatible">OpenAI 兼容接口</option>
      </select></label>
      {!usesCanvas && <><label>AI 接口地址<input value={draft.baseUrl} placeholder="填写兼容接口地址，包含 /v1 时保留" disabled={loading} onChange={event => { update({ baseUrl: event.target.value }); invalidateModels(); }} /></label>
        <small>使用已有模型服务的 Chat Completions 接口。</small></>}
      <div className="optimization-setting-row"><label>优化模型<select value={draft.modelId} disabled={loading} onChange={event => chooseModel({ modelId: event.target.value })}>
        <option value="">请选择服务中的模型</option>
        {draft.modelId && !listed.has(draft.modelId) && <option value={draft.modelId} disabled>{draft.modelId} · 尚未在当前服务验证</option>}
        {[...listed.values()].map(model => <option key={model.id} value={model.id} disabled={!model.available}>{model.id} · {model.available ? capabilityLabel(model.capability) : "不可用"}</option>)}
      </select></label><button type="button" disabled={loading} onClick={() => void save(true)} title="保存接口设置并读取真实模型列表"><RefreshCw size={13} />读取模型</button></div>
      {draft.provider !== "comfyui" && <label>优化模型 API ID<input value={draft.modelId} disabled={loading} onChange={event => update({ modelId: event.target.value })} /></label>}
      <small>当前：{capabilityLabel(capability)}。{draft.provider === "comfyui" ? "以服务读取的模型架构和运行依赖为准。" : "API ID 可能与文件名不同。"}</small>
      {selectedModel?.reason && <small className="optimization-model-warning">{selectedModel.reason}</small>}
      {draft.provider !== "comfyui" && <label>模型能力（按模型说明设置）<select value={draft.capabilities[draft.modelId] ?? "unknown"} disabled={loading || !draft.modelId}
        onChange={event => update({ capabilities: { ...draft.capabilities, [draft.modelId]: event.target.value as VisionCapability } })}>
        <option value="unknown">未知，先读取服务能力</option><option value="vision">支持图片视觉理解</option><option value="text">只支持文本</option>
      </select></label>}
      <label className="optimization-checkbox"><input type="checkbox" checked={draft.readMedia} disabled={loading} onChange={event => update({ readMedia: event.target.checked })} />读取已连接图片与视频画面</label>
      {!draft.readMedia && <small>当前仅根据提示词、Skill 与素材角色文字优化，不分析图片或视频画面。</small>}
      {draft.provider === "comfyui" ? <div className="optimization-setting-row"><label>视觉优化模型（mmproj）<select value={draft.mmproj} disabled={loading || mmprojModels.length === 0} onChange={event => update({ mmproj: event.target.value })}>
        <option value="">{mmprojModels.length ? "请选择 mmproj 文件" : "尚未读取到 mmproj 文件"}</option>
        {draft.mmproj && !mmprojModels.includes(draft.mmproj) && <option value={draft.mmproj} disabled>{draft.mmproj} · 当前服务未列出</option>}
        {mmprojModels.map(id => <option key={id} value={id} disabled={!selectedModel || !compatibleProjectors.includes(id)}>{id}{!selectedModel ? " · 先选择优化模型" : !compatibleProjectors.includes(id) ? " · 不匹配当前模型" : id === selectedModel.recommendedMmproj ? " · 推荐" : ""}</option>)}
      </select></label><button type="button" disabled={loading} onClick={() => void save(true)} title="读取当前 ComfyUI 中的 mmproj 文件"><RefreshCw size={13} />读取 mmproj</button></div> : <><label>视觉优化模型（可选）<input value={draft.visionModelId} list="optimization-vision-models" placeholder="遇到图片时优先使用此模型" disabled={loading} onChange={event => update({ visionModelId: event.target.value })} /></label>
        <datalist id="optimization-vision-models">{visionModels.map(model => <option key={model.id} value={model.id} />)}</datalist></>}
      {draft.visionModelId && draft.provider !== "comfyui" && <label>视觉模型能力（按模型说明设置）<select value={draft.capabilities[draft.visionModelId] ?? "unknown"} disabled={loading}
        onChange={event => update({ capabilities: { ...draft.capabilities, [draft.visionModelId]: event.target.value as VisionCapability } })}>
        <option value="unknown">未知，先读取服务能力</option><option value="vision">支持图片视觉理解</option><option value="text">只支持文本</option>
      </select></label>}
      {draft.provider === "comfyui" && <>
        {draft.mmproj && draft.mmproj === selectedModel?.recommendedMmproj && <small>推荐的 mmproj 已选入当前设置，点击“保存设置”后用于优化。</small>}
        <label>计算设备<select value={draft.device} disabled={loading} onChange={event => update({ device: event.target.value as "cuda" | "cpu" })}><option value="cuda">CUDA</option><option value="cpu">CPU</option></select></label>
      </>}
      <small>视觉能力未知或不可用时会明确报错；可在错误提示处选择仅基于文本优化。</small>
      <label>输出语言<select value={draft.language} disabled={loading} onChange={event => update({ language: event.target.value as "zh" | "en" })}><option value="zh">中文</option><option value="en">English</option></select></label>
      {draft.provider === "comfyui" && <OptimizationContextTokenSetting value={draft.contextTokens} disabled={loading} onChange={contextTokens => update({ contextTokens })} />}
      <OptimizationOutputTokenSetting value={draft.maxTokens} disabled={loading} onChange={maxTokens => update({ maxTokens })} />
      {!usesCanvas && <><label>服务访问令牌（需要时）<input type="password" autoComplete="off" value={apiKey} placeholder={draft.keyConfigured ? "已配置本次服务会话令牌" : "按优化服务的访问要求填写"} disabled={loading} onChange={event => { setApiKey(event.target.value); setKeyProvided(true); invalidateModels(); }} /></label>
      <details><summary>认证方式</summary><label>认证头<input value={draft.authHeader} disabled={loading} onChange={event => { update({ authHeader: event.target.value }); invalidateModels(); }} /></label>
        <label>令牌前缀（包括所需空格）<input value={draft.authPrefix} disabled={loading} onChange={event => { update({ authPrefix: event.target.value }); invalidateModels(); }} /></label>
        <button type="button" disabled={loading} onClick={async () => { const controller = abort.current; setLoading(true); try { const saved = await optimizationClient.saveSettings({ apiKey: "" }, controller.signal); if (!controller.signal.aborted) { setDraft(saved); setApiKey(""); setKeyProvided(false); setNotice("会话令牌已清除。"); } } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "清除失败。"); } finally { if (!controller.signal.aborted) setLoading(false); } }}>清除会话令牌</button>
      </details>
      <small>单独配置的密钥仅保留在当前本地服务进程中，不写入设置文件；重启服务后需重新输入。</small></>}
      <label>Skill 目录<input value={draft.skillDirectory} disabled={loading} onChange={event => update({ skillDirectory: event.target.value })} /></label>
      <div className="optimization-skill-status"><span>生成模型：{optimizationModelLabel(target) || "通用"}</span><span>任务：{optimizationTaskLabel(target)}</span>
        <span>当前 Skill：{skill?.match?.name ?? "尚未匹配"}{skill?.match?.level === "generic" ? "（通用降级）" : ""}</span>
        {skill?.error && <span role="alert">{skill.error}</span>}
        {!!skill?.warnings.length && <span role="status">{skill.warnings.join(" ")}</span>}
        {!!skill?.match?.files?.length && <details><summary>本次匹配的 Skill 文件（{skill.match.files.length}）</summary><ul>{skill.match.files.map(file => <li key={file}>{file}</li>)}</ul></details>}
      </div>
      <footer><button type="button" disabled={loading} onClick={() => void save(false, true)}><RefreshCw size={13} />重新扫描 Skill</button><button type="button" className="optimization-save" disabled={loading} onClick={() => void save()}>保存设置</button></footer>
    </>}
    {loading && <p role="status"><LoaderCircle size={13} className="spin" />正在读取服务…</p>}
    {notice && <p role="status">{notice}</p>}
  </aside>, document.body);
}
