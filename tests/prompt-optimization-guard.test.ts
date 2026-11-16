import { describe, expect, it, vi } from "vitest";
import { createOptimizationGuard } from "../src/prompt-optimization/operation-guard";

function state(initial: string) {
  let value = initial;
  const listeners = new Set<() => void>();
  return { read: () => value, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    change: (next: string) => { value = next; for (const fn of listeners) fn(); }, listeners };
}
describe("prompt optimization operation guard", () => {
  it("cancels immediately on an edit and never accepts a changed-back response", () => {
    const source = state("original"), invalidated = vi.fn();
    const guard = createOptimizationGuard(source.read, source.subscribe, invalidated);
    source.change("edited"); source.change("original");
    expect(guard.signal.aborted).toBe(true); expect(guard.valid()).toBe(false); expect(invalidated).toHaveBeenCalledOnce();
  });
  it("keeps an unchanged context valid across unrelated notifications", () => {
    const source = state("same"), guard = createOptimizationGuard(source.read, source.subscribe);
    source.change("same"); expect(guard.valid()).toBe(true); expect(guard.signal.aborted).toBe(false);
  });
  it.each(["another-node", "another-canvas", "another-project", "new-workflow", "new-connection", "new-source-text", "new-asset"])("rejects %s identity before applying", identity => {
    const source = state("original"), guard = createOptimizationGuard(source.read, source.subscribe);
    source.change(identity); expect(guard.valid()).toBe(false);
  });
  it("manual cancellation rejects late results without invoking context-change notice", () => {
    const source = state("same"), invalidated = vi.fn(), guard = createOptimizationGuard(source.read, source.subscribe, invalidated);
    guard.cancel(); expect(guard.signal.aborted).toBe(true); expect(guard.valid()).toBe(false); expect(invalidated).not.toHaveBeenCalled();
  });
  it("disposes listeners before the guarded operation applies its own replacement", () => {
    const source = state("original"), invalidated = vi.fn(), guard = createOptimizationGuard(source.read, source.subscribe, invalidated);
    guard.dispose(); source.change("optimized"); expect(source.listeners.size).toBe(0); expect(invalidated).not.toHaveBeenCalled(); expect(guard.valid()).toBe(false);
  });
});
