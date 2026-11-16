import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskTimer } from "../src/generation/TaskTimer";
import { elapsedSeconds } from "../src/generation/elapsed";
import {
  runningHubTimingDiagnostics,
  runningHubTimingDisplay,
} from "../src/generation/runninghub-timing";
import type { GenerationTask } from "../src/types";

function task(extra: Partial<GenerationTask> = {}): GenerationTask {
  return {
    taskId: "same-remote-task",
    executorType: "runninghub",
    status: "completed",
    createdAt: 1_000,
    updatedAt: 187_000,
    completedAt: 187_000,
    ...extra,
  } as GenerationTask;
}

describe("RunningHub timing", () => {
  it("separates the reported execution duration from the original end-to-end total", () => {
    const current = task({
      runningHubTiming: {
        providerDurationSeconds: 130,
        submittedAt: 11_000,
        remoteFinishedAt: 151_000,
      },
    });
    expect(runningHubTimingDisplay(current, 999_000).text).toBe(
      "RH 02:10 · 总用时 03:06",
    );
    const diagnostics = runningHubTimingDiagnostics(current, 999_000);
    expect(diagnostics.totalSeconds).toBe(elapsedSeconds(current, 999_000));
    expect(diagnostics).toMatchObject({
      totalMs: 186_000,
      providerDurationSeconds: 130,
      submittedAt: 11_000,
      remoteFinishedAt: 151_000,
      phases: [],
      hasPhaseRecords: false,
    });
    expect(diagnostics.phases.some((phase) => phase.key === "downloadMs")).toBe(
      false,
    );
  });

  it("shows only total time for old tasks without inventing remote or phase duration", () => {
    const current = task();
    expect(runningHubTimingDisplay(current).text).toBe("总用时 03:06");
    expect(runningHubTimingDiagnostics(current)).toMatchObject({
      providerDurationSeconds: undefined,
      hasPhaseRecords: false,
      phases: [],
    });
    expect(
      runningHubTimingDisplay(task({ executorType: "comfyui" })).text,
    ).toBe("用时 03:06");
  });

  it("does not add the reported duration again when a saved task resumes repeatedly", () => {
    const saved = task({
      status: "interrupted",
      completedAt: undefined,
      runningHubTiming: {
        remoteFinishedAt: 151_000,
        providerDurationSeconds: 130.8,
        downloadMs: 8_000,
      },
    });
    expect(runningHubTimingDisplay(saved, 187_000).text).toBe(
      "RH 02:10 · 总用时 03:06",
    );
    const recovered = structuredClone(saved);
    recovered.status = "saving";
    expect(runningHubTimingDisplay(recovered, 197_000).text).toBe(
      "RH 02:10 · 总用时 03:16",
    );
    const recoveredAgain = structuredClone(recovered);
    recoveredAgain.status = "completed";
    recoveredAgain.completedAt = 201_000;
    expect(runningHubTimingDisplay(recoveredAgain, 999_000).text).toBe(
      "RH 02:10 · 总用时 03:20",
    );
    expect(recoveredAgain.runningHubTiming).toEqual(saved.runningHubTiming);
  });

  it("keeps the existing terminal and live total-time policy", () => {
    for (const status of [
      "uploading",
      "submitting",
      "queued",
      "generating",
      "saving",
      "interrupted",
    ] as const) {
      const current = task({ status, completedAt: undefined });
      expect(runningHubTimingDiagnostics(current, 67_234).totalMs).toBe(66_234);
      expect(runningHubTimingDiagnostics(current, 67_234).totalSeconds).toBe(
        elapsedSeconds(current, 67_234),
      );
    }
    for (const status of ["failed", "cancelled"] as const) {
      const current = task({ status, completedAt: undefined, endedAt: 66_000 });
      expect(runningHubTimingDisplay(current, 999_000).text).toBe(
        "总用时 01:05",
      );
    }
    expect(
      runningHubTimingDisplay(
        task({ completedAt: undefined, updatedAt: 66_000 }),
      ).text,
    ).toBe("总用时 01:05");
  });

  it("returns independent cumulative phase records without attributing an unmeasured gap", () => {
    const current = task({
      runningHubTiming: {
        providerDurationSeconds: 130,
        prepareMs: 25_000,
        submitMs: 1_000,
        observeMs: 140_000,
        downloadMs: 40_000,
        importMs: 20_000,
        checkpointMs: 5_000,
        downloadBytes: 12_345,
      },
    });
    const diagnostics = runningHubTimingDiagnostics(current);
    expect(diagnostics.phases).toHaveLength(6);
    expect(diagnostics.hasPhaseRecords).toBe(true);
    expect(diagnostics.downloadBytes).toBe(12_345);
    expect(
      diagnostics.phases.find((phase) => phase.key === "downloadMs")?.ms,
    ).toBe(40_000);
    // These measurements overlap: they must not change the end-to-end total.
    expect(diagnostics.totalMs).toBe(186_000);
    expect(diagnostics).not.toHaveProperty("unrecordedMs");
    expect(diagnostics).not.toHaveProperty("overlapMs");
  });

  it("ignores malformed metrics and accepts a genuinely reported zero duration", () => {
    for (const invalid of [undefined, null, "130", -1, NaN, Infinity]) {
      const current = task({
        runningHubTiming: { providerDurationSeconds: invalid as number },
      });
      expect(runningHubTimingDisplay(current).text).toBe("总用时 03:06");
    }
    const current = task({
      runningHubTiming: {
        providerDurationSeconds: 0,
        prepareMs: NaN,
        submitMs: -1,
        observeMs: Infinity,
        downloadMs: 0,
        downloadBytes: -1,
        submittedAt: Infinity,
        remoteFinishedAt: -1,
      },
    });
    expect(runningHubTimingDisplay(current).text).toBe(
      "RH 00:00 · 总用时 03:06",
    );
    expect(runningHubTimingDiagnostics(current)).toMatchObject({
      phases: [{ key: "downloadMs", label: "下载结果", ms: 0 }],
      downloadBytes: undefined,
      submittedAt: undefined,
      remoteFinishedAt: undefined,
    });
    for (const invalid of [NaN, Infinity, -1]) {
      expect(
        runningHubTimingDiagnostics(task({ createdAt: invalid })).totalMs,
      ).toBe(0);
    }
    expect(
      runningHubTimingDiagnostics(task({ completedAt: NaN })).totalMs,
    ).toBe(0);
    expect(
      runningHubTimingDiagnostics(task({ status: "saving" }), NaN).totalMs,
    ).toBe(0);
    expect(
      runningHubTimingDiagnostics(task({ createdAt: 188_000 })).totalMs,
    ).toBe(0);
  });

  it("renders both times on the canvas timer and keeps the old text for other compute", () => {
    vi.spyOn(Date, "now").mockReturnValue(999_000);
    try {
      const html = renderToStaticMarkup(
        createElement(TaskTimer, {
          task: task({ runningHubTiming: { providerDurationSeconds: 130 } }),
        }),
      );
      expect(html).toContain("RH 02:10 · 总用时 03:06");
      expect(html).toContain('role="timer"');
      const other = renderToStaticMarkup(
        createElement(TaskTimer, {
          task: task({ executorType: "comfyui" }),
        }),
      );
      expect(other).toContain(">用时 03:06</span>");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
