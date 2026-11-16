import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CircleStop, RefreshCw, Trash2, X, LoaderCircle } from "lucide-react";
import { useStore } from "../stores/store";
import { canvasPopoverBounds, EXECUTION_POPOVER_HEIGHT, EXECUTION_POPOVER_WIDTH } from "../components/topbar-popover";
import { cancelTask } from "../generation/pipeline";
import { phaseLabels } from "../types";
import { ApiError, ComfyUIClient } from "./client";
import { readableRunningHubError } from "../runninghub/error-message";
import { clearCommunicationLog, communicationOrigin, communicationSnapshot, subscribeCommunication, type CommunicationRecord } from "./diagnostics";
import "./execution-panel.css";

export type ExecutionQueueItem = { promptId: string; position?: number; outputNodes: string[] };
export function normalizeExecutionQueue(value: { queue_running: unknown[][]; queue_pending: unknown[][] }): { running: ExecutionQueueItem[]; pending: ExecutionQueueItem[] } {
  function items(raw: unknown): ExecutionQueueItem[] {
    if (!Array.isArray(raw)) throw new Error("ComfyUI 返回的执行队列格式无效。");
    return raw.map(entry => {
      if (!Array.isArray(entry) || typeof entry[1] !== "string" || !entry[1].trim()) throw new Error("执行队列中的任务缺少 promptId。");
      return { promptId: entry[1], ...(typeof entry[0] === "number" && Number.isFinite(entry[0]) ? { position: entry[0] } : {}),
        outputNodes: Array.isArray(entry[4]) ? entry[4].filter((id): id is string => typeof id === "string" && /^[\w:-]{1,128}$/.test(id)).slice(0, 50) : [] };
    });
  }
  return { running: items(value.queue_running), pending: items(value.queue_pending) };
}

function actionError(reason: unknown): string {
  if (reason instanceof ApiError) return `ComfyUI 返回 HTTP ${reason.status}，操作未确认。`;
  if (reason instanceof Error && /fetch|network/i.test(reason.message)) return "无法连接 ComfyUI，操作未确认。";
  return reason instanceof Error ? reason.message : "操作失败，请刷新后重试。";
}
function eventState(logs: readonly CommunicationRecord[], promptId: string) {
  const event = [...logs].reverse().find(entry => entry.promptId === promptId && entry.transport === "WS" && ["executing", "progress", "execution_error", "execution_interrupted", "execution_success"].includes(entry.eventType ?? ""));
  return event;
}
const endpoint = (value: string) => { try { return new URL(value).toString().replace(/\/$/, ""); } catch { return value; } };

export function ExecutionPanel({ onClose, anchorRef }: { onClose: () => void; anchorRef?: RefObject<HTMLElement | null> }) {
  const connection = useStore(state => state.connection);
  const tasks = useStore(state => state.project.tasks);
  const client = useMemo(() => new ComfyUIClient(connection), [connection]);
  const records = useSyncExternalStore(subscribeCommunication, communicationSnapshot, communicationSnapshot);
  const origin = communicationOrigin(connection.baseUrl);
  const logs = useMemo(() => records.filter(entry => entry.origin === origin), [records, origin]);
  const localTasks = useMemo(() => Object.values(tasks)
    .filter(task => task.executorType === "comfyui" && endpoint(task.connection.baseUrl) === endpoint(connection.baseUrl))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt), [tasks, connection.baseUrl]);
  const [tab, setTab] = useState<"queue" | "logs" | "local">("queue");
  const [queue, setQueue] = useState<{ running: ExecutionQueueItem[]; pending: ExecutionQueueItem[] }>();
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<number>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [socketWarning, setSocketWarning] = useState("");
  const busyRef = useRef(false), refreshRef = useRef(false), mounted = useRef(true), revision = useRef(0);
  const dialog = useRef<HTMLElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(true);
  const [position, setPosition] = useState({ left: 16, top: 80, width: EXECUTION_POPOVER_WIDTH, height: EXECUTION_POPOVER_HEIGHT, ready: false });
  const close = useRef(onClose); close.current = onClose;
  const refresh = useRef<() => Promise<void>>(async () => {});

  refresh.current = async () => {
    if (refreshRef.current || busyRef.current || !connection.baseUrl.trim()) return;
    const requestRevision = revision.current;
    refreshRef.current = true;
    if (mounted.current) setRefreshing(true);
    try {
      const next = normalizeExecutionQueue(await client.getQueue());
      if (mounted.current && requestRevision === revision.current) { setQueue(next); setLastRefresh(Date.now()); setError(""); }
    } catch (reason) { if (mounted.current && requestRevision === revision.current) setError(actionError(reason)); }
    finally { if (requestRevision === revision.current) { refreshRef.current = false; if (mounted.current) setRefreshing(false); } }
  };

  useEffect(() => {
    mounted.current = true;
    revision.current++;
    refreshRef.current = false; busyRef.current = false; setBusy(""); setRefreshing(false);
    let stopped = false;
    setQueue(undefined); setLastRefresh(undefined); setError(""); setNotice(""); setSocketWarning("");
    void refresh.current();
    if (connection.baseUrl.trim()) void client.connect().then(() => { if (stopped) client.disconnect(); }).catch(() => {
      if (!stopped) setSocketWarning("实时通道暂不可用，队列仍可自动刷新。");
    });
    return () => { stopped = true; mounted.current = false; revision.current++; client.disconnect(); };
  }, [client, connection.baseUrl]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void refresh.current(), 2500);
    return () => window.clearInterval(timer);
  }, [autoRefresh]);
  useEffect(() => {
    if (!autoRefresh || logs.at(-1)?.eventType !== "status") return;
    const timer = window.setTimeout(() => void refresh.current(), 150);
    return () => window.clearTimeout(timer);
  }, [autoRefresh, logs]);
  useLayoutEffect(() => {
    const element = dialog.current, anchor = anchorRef?.current, canvas = document.querySelector(".canvas-shell");
    if (!element) return;
    const place = () => {
      const { left, top, width, margin } = canvasPopoverBounds(EXECUTION_POPOVER_WIDTH, canvas?.getBoundingClientRect());
      const height = Math.max(0, Math.min(EXECUTION_POPOVER_HEIGHT, window.innerHeight - top - margin));
      setPosition(previous => previous.ready && previous.left === left && previous.top === top && previous.width === width && previous.height === height
        ? previous : { left, top, width, height, ready: true });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element); if (anchor) observer.observe(anchor); if (canvas) observer.observe(canvas);
    const movement = new MutationObserver(place), container = anchor?.closest(".topbar") ?? anchor?.parentElement;
    if (container) movement.observe(container, { attributes: true, childList: true, subtree: true, attributeFilter: ["style", "class"] });
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); movement.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchorRef]);
  useLayoutEffect(() => {
    if (position.ready) closeButton.current?.focus({ preventScroll: true });
  }, [position.ready]);
  useEffect(() => {
    const anchor = anchorRef?.current;
    const previous = anchor?.querySelector<HTMLElement>("button") ?? anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target) && !anchorRef?.current?.contains(event.target)) {
        // Clicking an outside control should keep that control's normal focus.
        restoreFocus.current = false;
        close.current();
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", keydown, true); if (restoreFocus.current && previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [anchorRef]);

  async function action(name: string, operation: () => Promise<void>, message: string) {
    if (busyRef.current) return;
    // A read that began before this mutation must not replace its confirmed result.
    const requestRevision = ++revision.current;
    refreshRef.current = false; setRefreshing(false);
    busyRef.current = true; setBusy(name); setNotice(""); setError(""); dialog.current?.focus();
    try {
      await operation();
      if (mounted.current && requestRevision === revision.current) {
        const next = normalizeExecutionQueue(await client.getQueue());
        if (mounted.current && requestRevision === revision.current) { setNotice(message); setQueue(next); setLastRefresh(Date.now()); }
      }
    } catch (reason) { if (mounted.current && requestRevision === revision.current) setError(actionError(reason)); }
    finally { if (requestRevision === revision.current) { busyRef.current = false; if (mounted.current) setBusy(""); } }
  }

  async function remove(item: ExecutionQueueItem) {
    const owner = Object.values(useStore.getState().project.tasks).find(task => task.promptId === item.promptId && endpoint(task.connection.baseUrl) === endpoint(connection.baseUrl));
    if (owner) {
      const current = await client.getQueue();
      if (!current.queue_pending.some(entry => entry[1] === item.promptId)) throw new Error("任务已不在排队列表中，请刷新。");
      await cancelTask(owner.taskId);
      if (useStore.getState().project.tasks[owner.taskId]?.status !== "cancelled") throw new Error("本地任务取消尚未确认，请查看任务状态后重试。");
    } else await client.deleteQueuedPrompt(item.promptId);
  }

  const ready = !!queue && !error && !!connection.baseUrl.trim();
  const locked = !!busy || refreshing;
  const running = queue?.running ?? [], pending = queue?.pending ?? [];
  function row(item: ExecutionQueueItem, pendingItem: boolean) {
    const local = Object.values(tasks).find(task => task.promptId === item.promptId && endpoint(task.connection.baseUrl) === endpoint(connection.baseUrl));
    const state = eventState(logs, item.promptId);
    return <li key={item.promptId} className="execution-job">
      <div className="execution-job-main"><span className="execution-status">{pendingItem ? "排队中" : local && ["loading", "generating"].includes(local.status) ? phaseLabels[local.status] : "执行中"}</span><code>{item.promptId}</code>
        {!pendingItem && <small>{state?.nodeId ? `节点 ${state.nodeId}` : "等待当前节点状态"}{state?.max && state.value !== undefined ? ` · ${Math.min(100, Math.round(state.value / state.max * 100))}%` : local?.progress !== undefined ? ` · ${local.progress}%` : ""}</small>}
        {!!item.outputNodes.length && <small>目标输出节点：{item.outputNodes.join("、")}</small>}
      </div>
      {pendingItem && <button type="button" className="execution-delete" disabled={!ready || locked} onClick={() => void action("删除排队任务", () => remove(item), "排队任务已删除。")} title="删除这个排队任务" aria-label={`删除排队任务 ${item.promptId}`}><Trash2 size={17} /></button>}
    </li>;
  }
  return createPortal(<section id="execution-panel" className="execution-panel execution-popover nodrag nopan nowheel" ref={dialog} role="dialog" aria-labelledby="execution-title" aria-describedby="execution-subtitle" tabIndex={-1}
    style={{ left: position.left, top: position.top, width: position.width, height: position.height, visibility: position.ready ? "visible" : "hidden" }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onPaste={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onDrop={event => { event.preventDefault(); event.stopPropagation(); }} onDragOver={event => { event.preventDefault(); event.stopPropagation(); }}>
      <header><div><h2 id="execution-title">ComfyUI 执行与日志</h2><p id="execution-subtitle">查看执行队列、中断任务与通信记录</p></div><button type="button" ref={closeButton} className="execution-icon" onClick={() => close.current()} title="关闭" aria-label="关闭"><X size={19} /></button></header>
      <div className="execution-tab-row"><div className="execution-tabs" role="tablist" aria-label="执行与日志">
        <button id="execution-tab-queue" type="button" role="tab" aria-controls="execution-queue" aria-selected={tab === "queue"} onClick={() => setTab("queue")}>执行任务</button>
        <button id="execution-tab-logs" type="button" role="tab" aria-controls="execution-logs" aria-selected={tab === "logs"} onClick={() => setTab("logs")}>通信日志</button>
        <button id="execution-tab-local" type="button" role="tab" aria-controls="execution-local" aria-selected={tab === "local"} onClick={() => setTab("local")}>本地日志<span>{localTasks.length}</span></button>
      </div><div className="execution-refresh-controls">
        <button type="button" className="execution-refresh" title="刷新执行队列" aria-label="刷新执行队列" disabled={locked || !connection.baseUrl.trim()} onClick={() => void refresh.current()}><RefreshCw size={15} className={refreshing ? "spin" : ""} /></button>
        <label><input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} />自动刷新</label>
      </div></div>
      {tab === "queue" && !!running.length && <div className="execution-toolbar">
        <button type="button" className="execution-danger" disabled={!ready || locked} onClick={() => void action("中断当前任务", () => client.interruptCurrent(), "中断请求已发送，等待工作站确认任务状态。")}><CircleStop size={16} />中断当前任务</button>
      </div>}
      <div className="execution-messages">{error && <p className="execution-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{busy && <p role="status"><LoaderCircle size={15} className="spin" />{busy}…</p>}
        {!connection.baseUrl.trim() && <p>请先设置 ComfyUI 服务地址。</p>}{socketWarning && <small>{socketWarning}</small>}</div>
      <div className="execution-content">{tab === "queue" ? <div id="execution-queue" className="execution-queue" role="tabpanel" aria-labelledby="execution-tab-queue">
        {running.length || pending.length ? <>
          {!!running.length && <section><h3>正在执行 <span>{running.length}</span></h3><ul>{running.map(item => row(item, false))}</ul></section>}
          {!!pending.length && <section><h3>等待执行 <span>{pending.length}</span></h3><ul>{pending.map(item => row(item, true))}</ul></section>}
        </> : <p className="execution-empty execution-queue-empty">{queue ? "当前没有正在执行或排队等待的 ComfyUI 任务。" : !connection.baseUrl.trim() ? "连接服务后可查看执行任务。" : error ? "执行队列暂不可用，可刷新重试。" : "正在读取执行队列…"}</p>}
      </div> : tab === "logs" ? <div id="execution-logs" className="execution-log" role="tabpanel" aria-labelledby="execution-tab-logs"><div className="execution-log-tools"><small>仅记录连接状态、任务标识与进度</small><button type="button" disabled={!logs.length} onClick={clearCommunicationLog}><Trash2 size={15} />清空记录</button></div>
        {logs.length ? <ol>{[...logs].reverse().map(entry => <li key={entry.id} className={entry.stage === "error" || (entry.status ?? 0) >= 400 ? "failed" : ""}><time>{new Date(entry.time).toLocaleTimeString()}</time><b>{entry.transport}</b><code>{entry.transport === "HTTP" ? `${entry.method} ${entry.route}` : entry.eventType ?? entry.stage}</code><span>{entry.status ? `HTTP ${entry.status}` : entry.stage === "error" ? "连接失败" : entry.stage === "request" ? "发送" : entry.transport === "HTTP" ? "响应" : ""}{entry.durationMs !== undefined ? ` · ${entry.durationMs} ms` : ""}</span>
          {(entry.promptId || entry.nodeId || entry.queueRemaining !== undefined) && <small>{entry.promptId ? `promptId ${entry.promptId}` : ""}{entry.nodeId ? ` · 节点 ${entry.nodeId}` : ""}{entry.queueRemaining !== undefined ? `队列剩余 ${entry.queueRemaining}` : ""}</small>}</li>)}</ol> : <p className="execution-empty">暂无通信日志</p>}
      </div> : <div id="execution-local" className="execution-local" role="tabpanel" aria-labelledby="execution-tab-local">
        <p className="execution-local-caption">当前项目在此服务上的任务记录，随项目保存。</p>
        {localTasks.length ? <ol>{localTasks.map(task => <li key={task.taskId} className={`execution-local-task ${task.status === "failed" ? "failed" : ""}`}>
          <div className="execution-local-heading"><strong>{task.nodeTitle}</strong><time dateTime={new Date(task.updatedAt).toISOString()}>{new Date(task.updatedAt).toLocaleString()}</time></div>
          <p><span className="execution-status">{phaseLabels[task.status]}</span>{task.progress !== undefined && Number.isFinite(task.progress) && <span> · 当前步骤 {Math.max(0, Math.min(100, task.progress))}%</span>}<span className="execution-local-workflow">{task.workflow.name}</span></p>
          {task.error && <p className="execution-local-error">{readableRunningHubError(task.error)}</p>}
          {!!task.outputWarnings?.length && <ul className="execution-local-warnings">{task.outputWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
          <details><summary>任务详情</summary><dl><dt>Task ID</dt><dd>{task.taskId}</dd><dt>Prompt ID</dt><dd>{task.promptId ?? "尚未确认"}</dd><dt>执行器</dt><dd>{task.executorType}</dd><dt>状态</dt><dd>{task.status}</dd><dt>创建时间</dt><dd>{new Date(task.createdAt).toLocaleString()}</dd>
            {(task.completedAt ?? task.endedAt) !== undefined && <><dt>结束时间</dt><dd>{new Date((task.completedAt ?? task.endedAt)!).toLocaleString()}</dd></>}
            <dt>本地结果</dt><dd>{task.outputs.length}</dd></dl>{task.details && <pre>{task.details}</pre>}</details>
        </li>)}</ol> : <p className="execution-empty">当前项目在此服务上暂无本地任务记录。</p>}
      </div>}</div>
      <footer><span>{origin}</span><small>{lastRefresh ? `更新于 ${new Date(lastRefresh).toLocaleTimeString()}` : "尚未读取队列"}</small></footer>
  </section>, document.body);
}
