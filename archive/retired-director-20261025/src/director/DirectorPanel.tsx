import { useEffect, useRef, useState } from "react";
import { Play, Square, RefreshCw, Settings2 } from "lucide-react";
import { activeCanvas, useStore } from "../stores/store";
import { AssetPreview } from "../assets/AssetPreview";
import { mountUpstreamDirector, type DirectorHost, type DirectorSnapshot } from "./upstream-host";
import { stripDirectorPrompts } from "./media-bridge";
import { acquireDirectorMediaBridge } from "./shared-media-bridge";
import { cancelDirector, directorRunning, directorSessionId, DIRECTOR_WORKFLOW_ID, runDirector, type DirectorRun } from "./execution";
import template from "./workflow-template.json";
import type { RunningHubInstanceType } from "../types";
import { RunningHubClient } from "../runninghub/client";
import { directorDefinition, readDirectorWorkflow } from "./execution";
import { directorLinkedInputs } from "./linked-inputs";
import { DirectorRunStatus } from "./DirectorRunStatus";
import { DirectorNativeSettings } from "./DirectorNativeSettings";
import { showDirectorCompletion } from "./run-progress";
import "./director.css";

type SavedDirector = { snapshot?: DirectorSnapshot; media?: Record<string, string>; workflowId?: string; instanceType?: RunningHubInstanceType; run?: DirectorRun; linkedPaths?: string[] };

export function DirectorPanel({ nodeId }: { nodeId: string }) {
  const canvas = useStore(activeCanvas), assets = useStore(state => state.project.assets);
  const node = canvas.nodes.find(item => item.id === nodeId);
  const saved = (node?.data.director ?? {}) as SavedDirector;
  const host = useRef<DirectorHost | null>(null), mount = useRef<HTMLDivElement>(null);
  const mediaBridge = useRef<ReturnType<typeof acquireDirectorMediaBridge> | null>(null);
  const [ready, setReady] = useState(false), [error, setError] = useState(""), [settings, setSettings] = useState(false), [checking, setChecking] = useState(false), [checked, setChecked] = useState("");
  const [widgetValues, setWidgetValues] = useState<Record<string, unknown>>({});
  const currentProjectId = useStore.getState().project.id, canvasId = canvas.id;
  const owner = useRef({ currentProjectId, canvasId, nodeId });
  const update = (patch: Partial<SavedDirector>) => {
    const state = useStore.getState();
    if (state.project.id !== owner.current.currentProjectId) return;
    state.editProject(project => ({ ...project, canvases: project.canvases.map(item => item.id === owner.current.canvasId ? { ...item, nodes: item.nodes.map(target => target.id === owner.current.nodeId ? { ...target, data: { ...target.data, director: { ...(target.data.director as SavedDirector), ...patch } } } : target) } : item) }));
  };
  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    const data = () => (useStore.getState().project.canvases.find(item => item.id === canvasId)?.nodes.find(item => item.id === nodeId)?.data.director ?? {}) as SavedDirector;
    const initial = stripDirectorPrompts(data()) as SavedDirector;
    const bridge = acquireDirectorMediaBridge(currentProjectId);
    mediaBridge.current = bridge;
    const persist = (snapshot: DirectorSnapshot) => {
      if (!live) return;
      setWidgetValues(snapshot.values);
      const clean = stripDirectorPrompts(snapshot) as DirectorSnapshot;
      if (JSON.stringify(data().snapshot) !== JSON.stringify(clean)) update({ snapshot: clean });
    };
    void (async () => {
      try {
        await bridge.prepare();
        if (!live || !mount.current) return;
        const instance = await mountUpstreamDirector(mount.current, {
          ...bridge, signal: abort.signal, nodeId,
          values: initial.snapshot?.values ?? template["12"].inputs,
          timeline: initial.snapshot?.timeline,
          onChange: persist,
        });
        if (!live) { instance.destroy(); return; }
        host.current = instance;
        setWidgetValues(instance.read().values);
        setReady(true);
      } catch (reason) { if (live) setError(reason instanceof Error ? reason.message : "导演台载入失败。"); }
    })();
    const save = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        if (host.current) persist(host.current.read());
      }
    };
    window.addEventListener("keydown", save, true);
    return () => {
      live = false; abort.abort(); window.removeEventListener("keydown", save, true);
      host.current?.destroy(); host.current = null; bridge.release(); mediaBridge.current = null;
    };
  }, [currentProjectId, canvasId, nodeId]);
  const sessionId = directorSessionId(canvasId, nodeId);
  const run = saved.run, busy = directorRunning(sessionId);
  const inputSignature = JSON.stringify(canvas.edges.filter(edge => edge.target === nodeId).map(edge => [edge.id, edge.data?.order, canvas.nodes.find(item => item.id === edge.source)?.data.assetId]));
  useEffect(() => {
    const instance = host.current, bridge = mediaBridge.current;
    if (!ready || busy || !instance || !bridge) return;
    let live = true;
    void (async () => {
      try {
        const current = useStore.getState(), ownerCanvas = current.project.canvases.find(item => item.id === canvasId);
        const data = ownerCanvas?.nodes.find(item => item.id === nodeId)?.data.director as SavedDirector | undefined;
        if (!ownerCanvas || (!ownerCanvas.edges.some(edge => edge.target === nodeId) && !data?.linkedPaths?.length)) return;
        await bridge.prepare();
        if (!live || host.current !== instance) return;
        const snapshot = instance.read();
        const result = directorLinkedInputs(ownerCanvas, nodeId, current.project.assets, snapshot, data?.linkedPaths);
        update({ linkedPaths: result.linkedPaths, media: { ...data?.media, ...result.media } });
        if (JSON.stringify(snapshot.timeline) !== JSON.stringify(result.timeline)) instance.editor.applyImportedTimeline(result.timeline, snapshot.values);
      } catch (reason) { if (live) setError(reason instanceof Error ? reason.message : "连线素材读取失败。"); }
    })();
    return () => { live = false; };
  }, [ready, inputSignature, busy]);
  useEffect(() => {
    const instance = host.current, editor = instance?.editor;
    if (!editor || !run) return;
    if (run.status === "completed") showDirectorCompletion(instance, run);
    else if (["interrupted", "failed", "cancelled"].includes(run.status)) instance.setError(run.message);
    else {
      editor.runStatusEl.className = "bd-run-status active";
      editor.runTitleEl.textContent = run.message;
      editor.runDetailEl.textContent = "";
      editor.runOverallEl.style.width = "0%";
      editor.runPhaseEl.style.width = "0%";
    }
  }, [run, ready]);
  const onRunState = (next: DirectorRun) => {
    update({ run: next });
  };
  const verify = async () => {
    if (!host.current || checking) return;
    setChecking(true); setError(""); setChecked("");
    try {
      const connection = useStore.getState().runningHubConnections.cn;
      if (!connection.token.trim()) throw new Error("请在设置中保存 RunningHub CN Key。");
      const id = saved.workflowId || DIRECTOR_WORKFLOW_ID;
      const graph = await readDirectorWorkflow(new RunningHubClient(connection), id);
      const definition = directorDefinition(graph, host.current.read(), id, connection.baseUrl);
      setChecked(`已核对${id === DIRECTOR_WORKFLOW_ID ? "页面导出的 API JSON" : "云端工作流"} · ${Object.keys(graph).length} 个节点 · 导演台 ${definition.mapping[0]?.nodeId} · 输出 ${definition.output.nodeId}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "工作流核对失败。"); }
    finally { setChecking(false); }
  };
  const start = (resume = false) => {
    if (!host.current || busy) return;
    setError("");
    const snapshot = host.current.read();
    const state = useStore.getState(), data = (state.project.canvases.find(item => item.id === canvasId)?.nodes.find(item => item.id === nodeId)?.data.director ?? {}) as SavedDirector;
    void runDirector({ canvasId, nodeId, snapshot, workflowId: resume && data.run ? data.run.workflowId : data.workflowId || DIRECTOR_WORKFLOW_ID,
      instanceType: data.instanceType ?? "default", connection: state.runningHubConnections.cn, media: mediaBridge.current?.getMediaMap() ?? data.media ?? {}, onState: onRunState,
      resumeTaskId: resume ? data.run?.taskId : undefined, resumeRun: resume ? data.run : undefined });
  };
  if (!node) return null;
  return <section className="director-panel nodrag nopan nowheel" aria-label={node.data.title + "完整导演台"} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <div className="director-frame">
      {settings && <div className="director-connection"><label>RunningHub 工作流 ID<input aria-label="导演台工作流 ID" value={saved.workflowId || DIRECTOR_WORKFLOW_ID} onChange={event => { update({ workflowId: event.target.value.trim() }); setChecked(""); }} disabled={busy} /></label><a href={"https://www.runninghub.cn/workflow/" + (saved.workflowId || DIRECTOR_WORKFLOW_ID)} target="_blank" rel="noreferrer">打开工作流</a><button onClick={() => void verify()} disabled={!ready || busy || checking}>{checking ? "正在核对…" : "检查工作流"}</button><span role="status">{checked}</span></div>}
      {error && <div className="director-error" role="alert">{error}</div>}
      {!ready && !error && <div className="director-loading">正在打开导演台…</div>}
      {ready && <DirectorNativeSettings values={widgetValues} disabled={busy} onChange={patch => host.current?.setValues(patch)} />}
      <div ref={mount} className="director-upstream" />
      <div className="director-runbar">
        <DirectorRunStatus run={run} />
        <button onClick={() => setSettings(value => !value)} aria-expanded={settings}><Settings2 size={15} /> 工作流</button>
        <label>运行模式<select aria-label="导演台运行模式" value={saved.instanceType ?? "default"} onChange={event => update({ instanceType: event.target.value as RunningHubInstanceType })} disabled={busy}><option value="default">Standard</option><option value="plus">Plus</option><option value="ultra">6000D</option></select></label>
        {run?.taskId && !busy && !["completed", "failed", "cancelled"].includes(run.status) && <button onClick={() => start(true)} disabled={!ready}><RefreshCw size={15} /> 恢复查询</button>}
        {busy ? <button onClick={() => void cancelDirector(sessionId).catch(reason => setError(String(reason)))}><Square size={14} /> 停止</button> : <button className="director-run" onClick={() => start()} disabled={!ready || !!run?.taskId && run.status === "interrupted"}><Play size={15} /> 运行</button>}
      </div>
      {!!run?.outputIds?.length && <div className="director-results">{run.outputIds.map(id => assets[id] && <div key={id}><AssetPreview asset={assets[id]} full /></div>)}</div>}
    </div>
  </section>;
}
