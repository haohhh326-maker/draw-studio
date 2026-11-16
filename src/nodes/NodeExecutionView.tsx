import type { TaskState } from "../types";
import { busyPhases, phaseLabels } from "../types";
import { isRunningHubBalanceError, readableRunningHubError } from "../runninghub/error-message";
import { useStore } from "../stores/store";
import type { CSSProperties } from "react";

/** Water level follows reported progress, never elapsed-time estimates. */
export function NodeExecutionView({ task }: { task: TaskState }) {
  const busy = busyPhases.includes(task.status);
  const localAbort = task.status === "cancelled" && /^(?:AbortError:\s*)?Aborted\.?$/i.test(task.error?.trim() ?? "");
  const error = localAbort || !task.error ? undefined : readableRunningHubError(task.error);
  const details = task.details !== "not-submitted" && !(localAbort && /^(?:AbortError:\s*)?Aborted\.?$/i.test(task.details?.trim() ?? "")) ? task.details : undefined;
  const execution = task.execution;
  const hasSteps = task.status === "generating" && execution?.value !== undefined && Number.isFinite(execution.value)
    && execution.max !== undefined && Number.isFinite(execution.max) && execution.max > 0;
  const progress = hasSteps
    ? Math.min(100, Math.max(0, execution!.value! / execution!.max! * 100))
    : undefined;
  const fill = task.status === "saving" || task.status === "completed" ? 100
    : task.status === "generating" ? progress ?? (Number.isFinite(task.progress) ? Math.max(0, Math.min(100, task.progress!)) : undefined)
    : task.status === "uploading" || task.status === "submitting" || task.status === "queued" ? 0 : undefined;
  const nodeLabel = execution?.nodeTitle || execution?.nodeType;
  const completed = new Set([...(execution?.completedNodes ?? []), ...(execution?.cachedNodes ?? [])]).size;
  return (
    <div className={`node-execution ${task.status} nopan nowheel`}
      role={task.status === "failed" ? "alert" : "status"}
      aria-label="生成执行状态" aria-busy={busy}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("details")) event.stopPropagation();
      }}>
      {busy && <div className={`node-water ${fill === undefined ? "is-indeterminate" : fill === 0 ? "is-empty" : ""}`} aria-hidden="true"
        style={{ "--water-level": `${fill ?? 3}%` } as CSSProperties}>
        <div className="node-water-fill">
          <svg className="node-water-surface" viewBox="0 0 1200 40" preserveAspectRatio="none"><path d="M0 20 Q150 0 300 20 T600 20 T900 20 T1200 20 V40 H0Z" /></svg>
          <svg className="node-water-surface node-water-surface-back" viewBox="0 0 1200 40" preserveAspectRatio="none"><path d="M0 20 Q150 0 300 20 T600 20 T900 20 T1200 20 V40 H0Z" /></svg>
        </div>
      </div>}
      <div className="node-execution-content">
        <strong className="node-execution-phase">{phaseLabels[task.status]}</strong>
        {(nodeLabel || execution?.nodeId) && <div className="node-execution-current">
          {nodeLabel && <span>{nodeLabel}</span>}
          {execution?.nodeId && <small>#{execution.nodeId}{execution.nodeType && execution.nodeType !== nodeLabel ? ` · ${execution.nodeType}` : ""}</small>}
        </div>}
        {hasSteps && <div className="node-execution-progress">
          <progress aria-label="当前 ComfyUI 节点进度" value={execution!.value} max={execution!.max} />
          <span>{execution!.value} / {execution!.max} · {Math.round(progress!)}%</span>
        </div>}
        {busy && !hasSteps && <small className="node-execution-meta">{fill === undefined ? "等待平台进度" : task.status === "saving" ? task.savingMessage ?? "生成 100% · 正在保存结果" : `${Math.round(fill)}%`}</small>}
        {busy && execution?.queueRemaining !== undefined && task.status === "queued" &&
          <small className="node-execution-meta">队列剩余 {execution.queueRemaining}</small>}
        {busy && completed > 0 && <small className="node-execution-meta">已执行 / 缓存 {completed} 个节点</small>}
        {error && <p className="node-execution-error">{error}</p>}
        {task.status === "failed" && task.error && isRunningHubBalanceError(task.error) &&
          <button type="button" className="node-execution-account nodrag" onClick={event => {
            event.stopPropagation();
            useStore.setState({ modal: "runninghub-workflows" });
          }}>检查运行密钥</button>}
        {details && <details className="node-execution-details nodrag">
          <summary>{task.status === "failed" ? "错误详情" : "任务详情"}</summary>
          <pre>{details}</pre>
        </details>}
      </div>
    </div>
  );
}
