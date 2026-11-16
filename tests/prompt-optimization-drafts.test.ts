import { describe, expect, it } from "vitest";
import { createPromptDraftSessions, promptDraftKey, readPromptDrafts } from "../src/prompt-optimization/prompt-drafts";
import { createOptimizationGuard } from "../src/prompt-optimization/operation-guard";

describe("original and optimized prompt drafts", () => {
  it("validates saved metadata and preserves source identity when restoring unchanged drafts", () => {
    for (const value of [null, "text", {}, { original: 12, version: "original" }, { original: "x", version: "optimized" },
      { original: "x", optimized: 12, version: "original" }, { original: "x", optimized: "y", version: "unknown" }])
      expect(readPromptDrafts(value)).toBeUndefined();
    const drafts = createPromptDraftSessions(), saved = { original: "x", optimized: "y", version: "optimized" as const };
    const first = drafts.restore("node", saved);
    expect(drafts.restore("node", structuredClone(saved))).toBe(first);
    expect(drafts.restore("node", { original: "malformed", version: "optimized" })).toBe(first);
  });

  it("keeps each version's edits while switching back and forth", () => {
    const drafts = createPromptDraftSessions();
    const source = drafts.capture("node", "一个人物走向镜头");
    expect(drafts.complete("node", source, "人物缓步走向镜头，镜头平稳后退。")).toMatchObject({ version: "optimized" });
    const original = drafts.switchVersion("node", "人物走近镜头，保持服装一致。");
    expect(original).toEqual({ original: "一个人物走向镜头", optimized: "人物走近镜头，保持服装一致。", version: "original" });
    const optimized = drafts.switchVersion("node", "一个人物跑向镜头");
    expect(optimized).toEqual({ original: "一个人物跑向镜头", optimized: "人物走近镜头，保持服装一致。", version: "optimized" });
    expect(drafts.switchVersion("node", optimized!.optimized!)).toMatchObject({ original: "一个人物跑向镜头", version: "original" });
  });

  it("uses the edited original for the next optimization without dropping it", () => {
    const drafts = createPromptDraftSessions();
    drafts.complete("node", drafts.capture("node", "向前走"), "缓步向前走。");
    drafts.switchVersion("node", "缓步向前走。");
    const edited = drafts.capture("node", "向前跑");
    drafts.complete("node", edited, "人物向前奔跑，镜头跟随。");
    expect(drafts.get("node")).toEqual({ original: "向前跑", optimized: "人物向前奔跑，镜头跟随。", version: "optimized" });
  });

  it("re-optimizing an optimized draft preserves the editable original", () => {
    const drafts = createPromptDraftSessions();
    drafts.complete("node", drafts.capture("node", "原文"), "优化一");
    drafts.complete("node", drafts.capture("node", "手动修改的优化一"), "优化二");
    expect(drafts.switchVersion("node", "优化二")).toEqual({ original: "原文", optimized: "优化二", version: "original" });
  });

  it("keeps drafts through node selection changes with independent project, canvas, node and editor scopes", () => {
    const drafts = createPromptDraftSessions();
    const first = promptDraftKey("project", "canvas", "node", "generation");
    drafts.complete(first, drafts.capture(first, "original"), "optimized");
    const scopes = [
      promptDraftKey("other-project", "canvas", "node", "generation"),
      promptDraftKey("project", "other-canvas", "node", "generation"),
      promptDraftKey("project", "canvas", "other-node", "generation"),
      promptDraftKey("project", "canvas", "node", "text"),
    ];
    for (const scope of scopes) expect(drafts.capture(scope, "other")).toEqual({ original: "other", version: "original" });
    expect(drafts.capture(first, "optimized")).toEqual({ original: "original", optimized: "optimized", version: "optimized" });
    expect(drafts.switchVersion(first, "optimized")?.original).toBe("original");
  });

  it("does not offer an optimized version before success and preserves empty original drafts", () => {
    const drafts = createPromptDraftSessions();
    expect(drafts.switchVersion("node", "")).toBeUndefined();
    drafts.complete("node", drafts.capture("node", ""), "success");
    expect(drafts.switchVersion("node", "success")).toEqual({ original: "", optimized: "success", version: "original" });
  });

  it("preserves both versions when a subsequent AI call fails or is cancelled", () => {
    const drafts = createPromptDraftSessions();
    drafts.complete("node", drafts.capture("node", "original"), "optimized");
    drafts.switchVersion("node", "optimized");
    const source = drafts.capture("node", "edited original");
    // A failed request never calls complete, so the prior optimized draft stays available.
    expect(drafts.get("node")).toBe(source);
    expect(drafts.switchVersion("node", "edited original")?.optimized).toBe("optimized");
  });

  it("rejects late completions after source edits, including changing back to the same text", () => {
    const drafts = createPromptDraftSessions();
    const source = drafts.capture("node", "original");
    drafts.capture("node", "new input");
    drafts.capture("node", "original");
    expect(drafts.complete("node", source, "stale result")).toBeUndefined();
    expect(drafts.get("node")).toEqual({ original: "original", version: "original" });
  });

  it("rejects late completions after switching to another version even if the text is identical", () => {
    const drafts = createPromptDraftSessions();
    drafts.complete("node", drafts.capture("node", "same text"), "same text");
    const source = drafts.capture("node", "same text");
    drafts.switchVersion("node", "same text");
    expect(drafts.complete("node", source, "stale result")).toBeUndefined();
    expect(drafts.get("node")?.version).toBe("original");
  });

  it("does not write old node results after switching away and back", () => {
    const drafts = createPromptDraftSessions(), listeners = new Set<() => void>();
    let selected = "first";
    const key = promptDraftKey("project", "canvas", "first", "text");
    const source = drafts.capture(key, "first prompt");
    const guard = createOptimizationGuard(() => selected, listener => { listeners.add(listener); return () => { listeners.delete(listener); }; });
    for (const next of ["second", "first"]) {
      selected = next;
      for (const listener of listeners) listener();
    }
    if (guard.valid()) drafts.complete(key, source, "late result");
    expect(drafts.get(key)).toEqual({ original: "first prompt", version: "original" });
    expect(guard.signal.aborted).toBe(true);
    guard.dispose();
  });

  it("notifies subscribers only when draft contents or version actually change", () => {
    const drafts = createPromptDraftSessions();
    let changes = 0;
    const unsubscribe = drafts.subscribe(() => changes++);
    const source = drafts.capture("node", "same");
    drafts.capture("node", "same");
    expect(changes).toBe(1);
    drafts.complete("node", source, "optimized");
    drafts.switchVersion("node", "optimized", "optimized");
    expect(changes).toBe(2);
    unsubscribe();
    drafts.capture("node", "edited");
    expect(changes).toBe(2);
  });
});
