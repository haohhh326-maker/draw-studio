import { describe, it, expect } from "vitest";
import {
  elapsedSeconds,
  formatElapsed,
  isTimerRunning,
} from "../src/generation/elapsed";
import type { GenerationTask } from "../src/types";
const task = (
  status: GenerationTask["status"],
  extra: Partial<GenerationTask> = {},
) => ({ createdAt: 1000, updatedAt: 6000, status, ...extra }) as GenerationTask;
describe("generation elapsed time", () => {
  it("counts from the original start across queueing and interrupted recovery", () => {
    for (const status of [
      "uploading",
      "queued",
      "generating",
      "saving",
      "interrupted",
    ] as const) {
      expect(isTimerRunning(task(status))).toBe(true);
      expect(elapsedSeconds(task(status), 66000)).toBe(65);
    }
  });
  it("freezes completed, failed and cancelled tasks", () => {
    expect(
      elapsedSeconds(task("completed", { completedAt: 9000 }), 999000),
    ).toBe(8);
    expect(elapsedSeconds(task("failed", { endedAt: 7000 }), 999000)).toBe(6);
    expect(elapsedSeconds(task("cancelled", { endedAt: 8000 }), 999000)).toBe(
      7,
    );
    expect(elapsedSeconds(task("completed"), 999000)).toBe(5);
  });
  it("formats minutes and hours, and guards clock rollback", () => {
    expect(formatElapsed(65)).toBe("01:05");
    expect(formatElapsed(3661)).toBe("01:01:01");
    expect(elapsedSeconds(task("queued"), 0)).toBe(0);
  });
});
