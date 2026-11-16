import type { GenerationTask, RunningHubTiming } from "../types";
import { formatElapsed, isTimerRunning } from "./elapsed";

const phaseDefinitions = [
  ["prepareMs", "准备与上传"],
  ["submitMs", "提交任务"],
  ["observeMs", "等待远端结果"],
  ["downloadMs", "下载结果"],
  ["importMs", "导入结果"],
  ["checkpointMs", "保存检查点"],
] as const;

export type RunningHubTimingPhase = {
  key: (typeof phaseDefinitions)[number][0];
  label: string;
  ms: number;
};

export type RunningHubTimingDiagnostics = {
  totalMs: number;
  totalSeconds: number;
  providerDurationSeconds?: number;
  /** Cumulative measurements can overlap; these are not an exclusive breakdown. */
  phases: RunningHubTimingPhase[];
  hasPhaseRecords: boolean;
  downloadBytes?: number;
  submittedAt?: number;
  remoteFinishedAt?: number;
};

function nonnegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function taskTotalMs(task: GenerationTask, now: number): number {
  const start = nonnegativeFinite(task.createdAt);
  const end = nonnegativeFinite(
    isTimerRunning(task)
      ? now
      : (task.completedAt ?? task.endedAt ?? task.updatedAt),
  );
  if (start === undefined || end === undefined) return 0;
  return Math.max(0, end - start);
}

/** Reads stored measurements without changing them or treating recovery as a new run. */
export function runningHubTimingDiagnostics(
  task: GenerationTask,
  now = Date.now(),
): RunningHubTimingDiagnostics {
  const totalMs = taskTotalMs(task, now);
  const timing: RunningHubTiming =
    task.executorType === "runninghub" ? (task.runningHubTiming ?? {}) : {};
  const phases = phaseDefinitions.flatMap(([key, label]) => {
    const ms = nonnegativeFinite(timing[key]);
    return ms === undefined ? [] : [{ key, label, ms }];
  });
  return {
    totalMs,
    totalSeconds: Math.floor(totalMs / 1000),
    providerDurationSeconds: nonnegativeFinite(timing.providerDurationSeconds),
    phases,
    hasPhaseRecords: phases.length > 0,
    downloadBytes: nonnegativeFinite(timing.downloadBytes),
    submittedAt: nonnegativeFinite(timing.submittedAt),
    remoteFinishedAt: nonnegativeFinite(timing.remoteFinishedAt),
  };
}

export function runningHubTimingDisplay(
  task: GenerationTask,
  now = Date.now(),
) {
  const timing = runningHubTimingDiagnostics(task, now);
  const total = formatElapsed(timing.totalSeconds);
  if (task.executorType !== "runninghub") {
    return {
      text: `用时 ${total}`,
      title: "从点击生成开始计时，包含上传、排队、生成和保存结果",
    };
  }
  const provider = timing.providerDurationSeconds;
  return {
    text:
      provider === undefined
        ? `总用时 ${total}`
        : `RH ${formatElapsed(Math.floor(provider))} · 总用时 ${total}`,
    title:
      "RH 为 RunningHub 返回的执行时长；总用时从点击生成开始，包含准备、上传、排队、生成、下载和保存，恢复任务期间的等待也计入总用时。未返回的 RH 时长不作估算。",
  };
}
