import { busyPhases, type GenerationTask } from "../types";

export function isTimerRunning(task: GenerationTask) {
  // Loss of connectivity does not mean the remote job stopped.
  return busyPhases.includes(task.status) || task.status === "interrupted";
}

export function elapsedSeconds(task: GenerationTask, now: number) {
  const end = isTimerRunning(task)
    ? now
    : (task.completedAt ?? task.endedAt ?? task.updatedAt);
  return Math.max(0, Math.floor((end - task.createdAt) / 1000));
}

export function formatElapsed(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return (hours ? pad(hours) + ":" : "") + pad(minutes) + ":" + pad(remainder);
}
