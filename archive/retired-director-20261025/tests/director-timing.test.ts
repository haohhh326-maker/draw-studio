import { describe, expect, it } from "vitest";
import { directorRunTiming } from "../src/director/DirectorRunStatus";
import type { DirectorRun } from "../src/director/execution";

const run: DirectorRun = { workflowId: "123", site: "https://www.runninghub.cn", status: "saving", message: "RunningHub 已完成，正在下载结果…",
  timing: { startedAt: 1000, submittedAt: 2000, remoteCompletedAt: 131000, providerDurationSeconds: 130, uploadMs: 1000, downloadMs: 0, importMs: 0, saveMs: 0 } };

describe("director synchronization timing", () => {
  it("keeps provider execution separate while the local download clock advances", () => {
    expect(directorRunTiming(run, 141000)?.text).toBe("RH 02:10 · 总用时 02:20 · 同步 00:10");
    expect(directorRunTiming(run, 151000)?.text).toBe("RH 02:10 · 总用时 02:30 · 同步 00:20");
  });
  it("freezes completion and exposes actual download/import/save measurements", () => {
    const display = directorRunTiming({ ...run, status: "completed", timing: { ...run.timing!, completedAt: 151000, downloadMs: 14000, importMs: 4000, saveMs: 2000 } }, 999000);
    expect(display?.text).toBe("RH 02:10 · 总用时 02:30 · 同步 00:20");
    expect(display?.title).toContain("下载 14.0s；导入 4.0s；保存 2.0s");
  });
  it("does not estimate missing platform duration or keep a paused timer ticking", () => {
    const noProvider = { ...run, timing: { ...run.timing!, providerDurationSeconds: undefined } };
    expect(directorRunTiming(noProvider, 141000)?.text).toBe("总用时 02:20 · 同步 00:10");
    expect(directorRunTiming({ ...run, status: "interrupted" }, 999000)?.text).toBe("RH 02:10");
    expect(directorRunTiming({ ...run, timing: undefined })).toBeUndefined();
  });
});
