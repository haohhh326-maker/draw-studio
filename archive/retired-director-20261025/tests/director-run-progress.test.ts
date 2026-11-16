import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  directorSnapshotProgress,
  recordedDirectorProgress,
  showDirectorCompletion,
} from "../src/director/run-progress";
import type { DirectorSnapshot } from "../src/director/upstream-host";

const source = (
  await readFile("vendor/minimax-director/web/js/minimax_timeline.js", "utf8")
).replaceAll("\r\n", "\n");
const methods = ["getRunnableSegmentCount", "getRunProgressSegmentTotal"]
  .map((name) => {
    const start = source.indexOf(`    ${name}(`),
      end = source.indexOf("\n    }\n", start);
    if (start < 0 || end < 0)
      throw new Error(`Missing original method: ${name}`);
    return source.slice(start, end + 6).trim();
  })
  .join(",\n");
const original = new Function("fl2vStartIndices", `return {${methods}};`)(
  (editor: any) =>
    (editor.timeline.shots || editor.timeline.segments || []).map(
      (_: unknown, index: number) => index,
    ),
);
const groups = (count: number) => Array.from({ length: count }, () => ({}));

describe("director recorded run progress", () => {
  it.each([
    ["all groups", "r2v", { segments: groups(3) }],
    [
      "one selected group",
      "r2v",
      { segments: groups(3), runSelectEnabled: true, runSelection: [1] },
    ],
    [
      "all selected groups",
      "r2v",
      { segments: groups(3), runSelectEnabled: true, runSelection: [0, 1, 2] },
    ],
    [
      "single group",
      "r2v",
      { segments: groups(1), runSelectEnabled: true, runSelection: [0] },
    ],
    ["legacy empty timeline", "r2v", { segments: [] }],
    [
      "fl2v shot indices",
      "fl2v",
      {
        shots: groups(3),
        segments: groups(1),
        runSelectEnabled: true,
        runSelection: [2],
      },
    ],
    [
      "fl2v segment fallback",
      "fl2v",
      { segments: groups(2), runSelectEnabled: false, runSelection: [1] },
    ],
  ] as const)(
    "matches original getRunProgressSegmentTotal for %s",
    (_label, task, timeline) => {
      const editor = {
        ...original,
        timeline,
        isFl2vMode: () => task === "fl2v",
        isRunSelectEnabled: () =>
          !!("runSelectEnabled" in timeline && timeline.runSelectEnabled),
      };
      const snapshot: DirectorSnapshot = {
        values: { task_type: task },
        timeline: structuredClone(timeline),
      };
      const progress = directorSnapshotProgress(snapshot);
      expect(progress.segmentTotal).toBe(editor.getRunProgressSegmentTotal());
      expect(progress.timelineSegmentTotal).toBe(
        Math.max(1, editor.getRunnableSegmentCount()),
      );
    },
  );

  it("counts effective unique group indices without changing the submitted selection or timeline", () => {
    const snapshot: DirectorSnapshot = {
      values: { task_type: "mixed" },
      timeline: {
        segments: groups(3),
        runSelectEnabled: true,
        runSelection: [1, "1", -1, 7],
      },
    };
    const saved = structuredClone(snapshot);
    expect(directorSnapshotProgress(snapshot)).toEqual({
      segmentTotal: 1,
      timelineSegmentTotal: 3,
    });
    expect(snapshot).toEqual(saved);
  });

  it("uses saved checkpoint counts despite changes to today's editor or duplicate exported files", () => {
    const host = {
      editor: {
        runDetailEl: { textContent: "" },
        timeline: { segments: groups(99) },
      },
      setProgress: vi.fn(),
    };
    const run = {
      runProgress: { segmentTotal: 9, timelineSegmentTotal: 9 },
      receipt: { runProgress: { segmentTotal: 1, timelineSegmentTotal: 2 } },
      outputIds: ["a", "b", "c"],
    };
    showDirectorCompletion(host, run);
    expect(host.setProgress).toHaveBeenCalledExactlyOnceWith({
      phase: "finish",
      segment_total: 1,
      timeline_segment_total: 2,
      partial_run: true,
    });
  });

  it("keeps original finish cleanup but omits unverifiable counts on old records", () => {
    const detail = { textContent: "before" };
    const host = {
      editor: { runDetailEl: detail },
      setProgress: vi.fn(() => {
        detail.textContent = "count inferred from current editor";
      }),
    };
    const legacy = {
      outputIds: ["a", "b"],
      receipt: { downloads: [{ assetId: "a" }, { assetId: "b" }] },
    };
    expect(recordedDirectorProgress(legacy as any)).toBeUndefined();
    showDirectorCompletion(host, legacy as any);
    expect(host.setProgress).toHaveBeenCalledExactlyOnceWith({
      phase: "finish",
    });
    expect(detail.textContent).toBe("");
    expect(
      recordedDirectorProgress({
        runProgress: { segmentTotal: 3, timelineSegmentTotal: 2 },
      }),
    ).toBeUndefined();
  });
});
