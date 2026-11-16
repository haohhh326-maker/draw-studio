import { useEffect, useState } from "react";
import { busyPhases, type Phase } from "../types";
import { formatElapsed } from "../generation/elapsed";
import type { DirectorRun } from "./execution";

const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const elapsed = (ms: number) => formatElapsed(Math.floor(Math.max(0, ms) / 1000));

/** RH execution and local result synchronization are measured independently. */
export function directorRunTiming(run: DirectorRun, now = Date.now()) {
  const timing = run.timing ?? run.receipt?.timing;
  if (!timing) return undefined;
  const parts: string[] = [];
  if (valid(timing.providerDurationSeconds)) parts.push("RH " + elapsed(timing.providerDurationSeconds * 1000));
  const busy = busyPhases.includes(run.status as Phase);
  const end = run.status === "completed" && valid(timing.completedAt) ? timing.completedAt : busy && valid(now) ? now : undefined;
  if (end !== undefined && valid(timing.startedAt)) parts.push("总用时 " + elapsed(end - timing.startedAt));
  if (end !== undefined && valid(timing.remoteCompletedAt)) parts.push("同步 " + elapsed(end - timing.remoteCompletedAt));
  if (!parts.length) return undefined;
  return { text: parts.join(" · "), title: "RH 为平台返回的执行耗时；同步从收到成功结果开始，包含下载、导入与本地保存。" +
    ` 下载 ${(Math.max(0, timing.downloadMs || 0) / 1000).toFixed(1)}s；导入 ${(Math.max(0, timing.importMs || 0) / 1000).toFixed(1)}s；保存 ${(Math.max(0, timing.saveMs || 0) / 1000).toFixed(1)}s。` };
}

export function DirectorRunStatus({ run }: { run?: DirectorRun }) {
  const [, tick] = useState(0);
  const busy = !!run && busyPhases.includes(run.status as Phase);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => tick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  const timing = run ? directorRunTiming(run) : undefined;
  return <span className={"director-run-status" + (run?.status === "failed" || run?.status === "interrupted" ? " director-run-error" : "")} role="status">
    <span>{run?.message || "待命"}</span>
    {timing && <span className="director-timing" role="timer" title={timing.title}>{timing.text}</span>}
  </span>;
}
