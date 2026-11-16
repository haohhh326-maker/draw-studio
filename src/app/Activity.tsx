import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, History, ListTodo } from "lucide-react";
import { Modal } from "../components/ui";
import { useStore, taskForNode } from "../stores/store";
import { busyPhases, phaseLabels } from "../types";
import { getBlob, download } from "../projects/storage";
import { AssetPreview } from "../assets/AssetPreview";
import { resumeTask, cancelTask } from "../generation/pipeline";
import { readableRunningHubError } from "../runninghub/error-message";
import { RunningHubClient } from "../runninghub/client";
import { runningHubInstanceTypeLabel } from "../runninghub/instance-types";
import { computeEndpoint, runningHubSite } from "../compute/providers";
import { runningHubTimingDiagnostics } from "../generation/runninghub-timing";
import { formatElapsed } from "../generation/elapsed";
import type { Asset, GenerationTask } from "../types";
import { prioritizeOutputAssets } from "../workflow/output-policy";
import { filterHistoryByTime, historyTimeOptions, type HistoryTimeFilter } from "./history-time";
import "./activity.css";

function RunningHubTaskTiming({ task }: { task: GenerationTask }) {
  const [checking, setChecking] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const report = runningHubTimingDiagnostics(task);
  const savedBytes = task.downloadedOutputs?.reduce((sum, output) => sum + output.asset.size, 0);
  const refresh = async () => {
    if (!task.promptId || checking || pending.current) return;
    const state = useStore.getState(), owner = state.project.id;
    let expired = false;
    const ownsTask = () => {
      const currentState = useStore.getState(), current = currentState.project.tasks[task.taskId];
      return !expired && currentState.project.id === owner && !!current && current.status === "completed"
        && current.executorType === "runninghub" && current.promptId === task.promptId && current.requestId === task.requestId
        && current.clientId === task.clientId && computeEndpoint(current.connection.baseUrl) === computeEndpoint(task.connection.baseUrl);
    };
    if (!ownsTask()) return;
    const configured = computeEndpoint(state.runningHubConnection.baseUrl) === computeEndpoint(task.connection.baseUrl)
      ? state.runningHubConnection : state.runningHubConnections[runningHubSite(task.connection.baseUrl)];
    if (!configured?.token || computeEndpoint(configured.baseUrl) !== computeEndpoint(task.connection.baseUrl)) {
      state.notify("请先配置原任务站点的 RunningHub API Key。");
      return;
    }
    const controller = new AbortController(); pending.current = controller; setChecking(true);
    const unsubscribe = useStore.subscribe(() => {
      if (!ownsTask()) { expired = true; controller.abort(); }
    });
    try {
      const client = new RunningHubClient({ ...task.connection, token: configured.token }, task.clientId, task.workflow);
      const result = await client.readTaskTiming(task.promptId, controller.signal);
      controller.signal.throwIfAborted();
      const currentState = useStore.getState(), current = currentState.project.tasks[task.taskId];
      if (!ownsTask()) return;
      if (result?.providerDurationSeconds === undefined) { currentState.notify("平台暂未返回这条原任务的运行时长。"); return; }
      currentState.patchTask(task.taskId, { runningHubTiming: { ...current.runningHubTiming, ...result } });
      await useStore.getState().save(true);
      if (ownsTask() && !controller.signal.aborted) useStore.getState().notify("已读取原任务的平台用时，未重新生成。");
    } catch (error) {
      if (ownsTask() && !controller.signal.aborted) useStore.getState().notify(readableRunningHubError(error instanceof Error ? error.message : "暂时无法核对平台用时。"));
    } finally {
      unsubscribe();
      if (pending.current === controller) pending.current = null;
      setChecking(false);
    }
  };
  return <div className="runninghub-task-timing" role="group" aria-label="RunningHub 耗时">
    <dl>
      <dt>平台运行</dt><dd>{report.providerDurationSeconds === undefined ? "尚未记录" : formatElapsed(Math.floor(report.providerDurationSeconds))}</dd>
      <dt>总用时</dt><dd>{formatElapsed(report.totalSeconds)}</dd>
      {report.phases.map(phase => <div className="timing-phase" key={phase.key}><dt>{phase.label}</dt><dd>{(phase.ms / 1000).toFixed(1)} 秒</dd></div>)}
      {report.downloadBytes !== undefined && <><dt>下载数据</dt><dd>{(report.downloadBytes / (1024 * 1024)).toFixed(2)} MB</dd></>}
      {report.downloadBytes === undefined && savedBytes !== undefined && <><dt>已保存结果</dt><dd>{(savedBytes / (1024 * 1024)).toFixed(2)} MB</dd></>}
    </dl>
    <small>{report.hasPhaseRecords ? "阶段记录可能重叠；总用时包含排队、传输及本地保存。" : "此任务没有阶段耗时记录，不能确定额外时间花在哪一步。"}</small>
    {task.status === "completed" && task.promptId && <button disabled={checking} title="只读取原任务，不重新提交生成" onClick={() => void refresh()}>{checking ? "正在核对…" : "核对平台用时"}</button>}
  </div>;
}

export function Activity({ mode }: { mode: "history" | "tasks" }) {
  const [timeFilter, setTimeFilter] = useState<HistoryTimeFilter>("all");
  const [selectedOutputs, setSelectedOutputs] = useState<Record<string, string>>({});
  const project = useStore((s) => s.project),
    cloudWorkflows = useStore((s) => s.workflows),
    runningHubWorkflows = useStore(s => s.runningHubWorkflows);
  const workflows = [...cloudWorkflows, ...runningHubWorkflows];
  const history = filterHistoryByTime(project.history, timeFilter);
  const tasks = Object.values(project.tasks).sort(
    (a, b) => b.createdAt - a.createdAt,
  );
  return (
    <Modal
      title={mode === "history" ? "生成历史" : "生成任务"}
      onClose={() => useStore.setState({ modal: null })}
      wide
    >
      <div className="activity">
        {mode === "history" && <div className="history-time-filters" role="group" aria-label="历史时间筛选">
          {historyTimeOptions.map(option => <button key={option.value} type="button" title={option.title}
            aria-pressed={timeFilter === option.value} onClick={() => setTimeFilter(option.value)}>{option.label}</button>)}
        </div>}
        {mode === "tasks" ? (
          tasks.length ? (
            tasks.map((task) => (
              <div className="task-row" key={task.taskId}>
                <div>
                  <strong>{task.nodeTitle}</strong>
                  <p>
                    {project.canvases.find((c) => c.id === task.canvasId)
                      ?.name ?? "原画布已删除"}{" "}
                    · {phaseLabels[task.status]}
                    {task.progress !== undefined
                      ? " · 当前步骤 " + task.progress + "%"
                      : ""}
                  </p>
                  {task.error && (
                    <small className="error-text">{readableRunningHubError(task.error)}</small>
                  )}
                  <details className="task-details">
                    <summary>任务详情</summary>
                    <dl>
                      <dt>Task ID</dt>
                      <dd>{task.taskId}</dd>
                      <dt>Prompt ID</dt>
                      <dd>{task.promptId ?? "尚未确认"}</dd>
                      <dt>Executor</dt>
                      <dd>{task.executorType}</dd>
                      <dt>Status</dt>
                      <dd>{task.status}</dd>
                      {task.executorType === "muse" && task.muse?.conversationUrl && /^https:\/\/muse\.ai\/thread\/(?!new$)[a-zA-Z0-9_-]+$/.test(task.muse.conversationUrl) && <>
                        <dt>Muse 原会话</dt>
                        <dd><a href={task.muse.conversationUrl} target="_blank" rel="noopener noreferrer">打开原生成会话</a></dd>
                      </>}
                      {task.executorType === "runninghub" && <>
                        <dt>创建时间</dt>
                        <dd>{new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false })}</dd>
                        <dt>工作流</dt>
                        <dd>{task.workflow.name}</dd>
                        <dt>RunningHub 来源</dt>
                        <dd>{task.workflow.runninghub?.kind === "app" ? "AI 应用" : "完整工作流"} · {task.workflow.runninghub?.apiVersion ?? "v1"} · ID {task.workflow.runninghub?.workflowId}</dd>
                        <dt>API 站点</dt>
                        <dd>{task.connection.baseUrl}</dd>
                        <dt>运行模式</dt>
                        <dd>{runningHubInstanceTypeLabel(task.runningHubInstanceType)}</dd>
                        {!!task.remoteOutputs?.length && <>
                          <dt>结果来源（不含签名）</dt>
                          <dd>{[...new Set(task.remoteOutputs.map(file => {
                            try { return new URL(file.url ?? "").origin; } catch { return "无效结果地址"; }
                          }))].join("、")}</dd>
                        </>}
                      </>}
                      {task.staging && (
                        <>
                          <dt>输入目录</dt>
                          <dd>input/{task.staging.inputSubfolder}</dd>
                          <dt>已上传素材</dt>
                          <dd>{Object.keys(task.staging.uploads).length}</dd>
                        </>
                      )}
                      {!!task.remoteOutputs?.length && (
                        <>
                          <dt>结果已下载</dt>
                          <dd>
                            {task.downloadedOutputs?.length ?? 0} /{" "}
                            {task.remoteOutputs.length}
                          </dd>
                        </>
                      )}
                    </dl>
                    {task.executorType === "runninghub" && <RunningHubTaskTiming task={task} />}
                    {task.details && <pre>{task.details}</pre>}
                  </details>
                </div>
                <div className="row">
                  {busyPhases.includes(task.status) ? (
                    <button title={task.executorType === "muse" ? "停止本机队列任务；已经发送到 Muse 的任务可能仍会继续" : undefined} onClick={() => void cancelTask(task.taskId)}>
                      {task.executorType === "muse" ? "停止任务" : "取消"}
                    </button>
                  ) : task.status === "interrupted" ? (
                    <>
                      <button onClick={() => void resumeTask(task.taskId)}>
                        恢复查询
                      </button>
                      <button title={task.executorType === "muse" ? "停止本机队列任务；已经发送到 Muse 的任务可能仍会继续" : undefined} onClick={() => void cancelTask(task.taskId)}>
                        {task.executorType === "muse" ? "停止任务" : "取消任务"}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        if (
                          !project.canvases.some(
                            (c) =>
                              c.id === task.canvasId &&
                              c.nodes.some((n) => n.id === task.nodeId),
                          )
                        ) {
                          useStore
                            .getState()
                            .notify("原节点已删除，任务记录仍保留。");
                          return;
                        }
                        useStore.getState().editProject((p) => ({
                          ...p,
                          activeCanvasId: task.canvasId,
                        }));
                        useStore.setState({
                          selectedId: task.nodeId,
                          modal: null,
                        });
                      }}
                    >
                      定位节点
                      <ArrowUpRight size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state">
              <ListTodo size={32} />
              <h3>还没有生成任务</h3>
              <p>你的每一次创作都会在这里留下进度。</p>
            </div>
          )
        ) : history.length ? (
          <div className="history-grid">
            {history.map((h) => {
              const task = project.tasks[h.id];
              const workflow = task?.workflow ?? workflows.find(w => w.id === h.workflowId);
              const savedOutputs = h.outputs.map(id => project.assets[id]).filter((asset): asset is Asset => !!asset);
              const outputs = workflow ? prioritizeOutputAssets(workflow, savedOutputs, task?.downloadedOutputs ?? []) : savedOutputs;
              const selected = outputs.find(asset => asset.id === selectedOutputs[h.id]) ?? outputs[0];
              return (
              <article key={h.id}>
                <div className="history-preview">
                  {selected && (
                    <AssetPreview asset={selected} />
                  )}
                </div>
                <div className="history-body">
                  <strong>{h.nodeTitle}</strong>
                  <p>{h.prompt}</p>
                  <small>
                    {workflows.find((w) => w.id === h.workflowId)?.name}
                    <br />
                    {new Date(h.createdAt).toLocaleString()} · Seed{" "}
                    {h.params.seed}
                  </small>
                  {outputs.length > 1 && <label className="history-output-select">
                    生成结果
                    <select aria-label={h.nodeTitle + "的生成结果"} value={selected?.id ?? ""}
                      onChange={event => setSelectedOutputs(current => ({ ...current, [h.id]: event.target.value }))}>
                      {outputs.map((asset, index) => <option key={asset.id} value={asset.id}>
                        {index + 1}. {asset.name}{asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ""}
                      </option>)}
                    </select>
                  </label>}
                  <div className="row">
                    <button
                      onClick={() => {
                        const c = project.canvases.find(
                            (c) => c.id === h.canvasId,
                          ),
                          n = c?.nodes.find((n) => n.id === h.nodeId);
                        if (!n?.data.generation) {
                          useStore
                            .getState()
                            .notify("原节点已删除，结果仍可下载。");
                          return;
                        }
                        if (
                          busyPhases.includes(taskForNode(project, n).status)
                        ) {
                          useStore.getState().notify("请等待当前任务结束。");
                          return;
                        }
                        useStore.getState().patchNode(
                          n.id,
                          {
                            assetId: selected?.id,
                            text:
                              selected?.kind === "text"
                                ? selected.text
                                : undefined,
                            generation: {
                              ...n.data.generation,
                              prompt: h.prompt,
                              negativePrompt: h.negativePrompt,
                              workflowId: h.workflowId,
                              params: h.params,
                              taskId: h.id,
                              ...((h.runningHubInstanceType || project.tasks[h.id]?.executorType === "runninghub" || workflows.find(workflow => workflow.id === h.workflowId)?.runninghub)
                                ? { runningHubInstanceType: h.runningHubInstanceType ?? project.tasks[h.id]?.runningHubInstanceType ?? "default" } : {}),
                            },
                          },
                          c!.id,
                        );
                        useStore.getState().editProject((p) => ({
                          ...p,
                          activeCanvasId: c!.id,
                        }));
                        useStore.setState({ modal: null, selectedId: n.id });
                      }}
                    >
                      恢复版本
                    </button>
                    <button
                      onClick={() => {
                        for (const id of h.outputs) {
                          const a = project.assets[id];
                          if (!a) { useStore.getState().notify("部分结果素材已不存在。"); continue; }
                          void getBlob(id, a.mime).then((b) =>
                            download(b, a.name),
                          ).catch(error => useStore.getState().notify(String(error)));
                        }
                      }}
                    >
                      下载
                    </button>
                  </div>
                </div>
              </article>
            ); })}
          </div>
        ) : (
          <div className="empty-state">
            <History size={32} />
            <h3>{timeFilter === "all" ? "还没有生成历史" : "这个时间范围内没有记录"}</h3>
            <p>{timeFilter === "all" ? "完成生成后，这里会保存提示词、参数和结果版本。" : "可以选择其他时间范围查看。"}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
