import type { DirectorSnapshot } from "./upstream-host";
import { directorRunSelection } from "./mode-model";
// @ts-expect-error The pinned upstream helpers are distributed as plain JavaScript.
import { resolveTaskKey } from "../../vendor/minimax-director/web/js/minimax_gen_timeline.js";

export type DirectorRunProgress = {
  /** Groups sampled in this run, independent of the number of exported files. */
  segmentTotal: number;
  timelineSegmentTotal: number;
};

/** Mirror getRunnableSegmentCount/getRunProgressSegmentTotal on a serialized UI snapshot. */
export function directorSnapshotProgress(
  snapshot: DirectorSnapshot,
): DirectorRunProgress {
  const timeline = snapshot.timeline;
  const task = resolveTaskKey(
    timeline.global?.taskType || snapshot.values.task_type,
  );
  const groups =
    task === "fl2v" ? timeline.shots || timeline.segments : timeline.segments;
  const total = Array.isArray(groups) ? groups.length : 0;
  const selected =
    total >= 2 ? directorRunSelection(timeline, total) : undefined;
  return {
    segmentTotal: selected?.length || Math.max(total, 1),
    timelineSegmentTotal: Math.max(total, 1),
  };
}

type RecordedRun = {
  runProgress?: DirectorRunProgress;
  receipt?: { runProgress?: DirectorRunProgress };
};

export function recordedDirectorProgress(
  run: RecordedRun,
): DirectorRunProgress | undefined {
  for (const value of [run.receipt?.runProgress, run.runProgress]) {
    if (
      value &&
      Number.isSafeInteger(value.segmentTotal) &&
      value.segmentTotal > 0 &&
      Number.isSafeInteger(value.timelineSegmentTotal) &&
      value.timelineSegmentTotal >= value.segmentTotal
    )
      return {
        segmentTotal: value.segmentTotal,
        timelineSegmentTotal: value.timelineSegmentTotal,
      };
  }
}

/** Run the original finish cleanup, but never infer a legacy task's count from today's editor. */
export function showDirectorCompletion(
  host: {
    setProgress(detail: Record<string, unknown>): void;
    editor: { runDetailEl?: { textContent: string | null } };
  },
  run: RecordedRun,
): void {
  const progress = recordedDirectorProgress(run);
  host.setProgress({
    phase: "finish",
    ...(progress
      ? {
          segment_total: progress.segmentTotal,
          timeline_segment_total: progress.timelineSegmentTotal,
          partial_run: progress.segmentTotal < progress.timelineSegmentTotal,
        }
      : {}),
  });
  // The upstream finish handler falls back to the current editor for old records.
  // Keep its completed title/bars/cleanup, then omit that unsupported numeric detail.
  if (!progress && host.editor.runDetailEl)
    host.editor.runDetailEl.textContent = "";
}
