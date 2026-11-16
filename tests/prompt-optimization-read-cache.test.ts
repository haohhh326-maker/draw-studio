import { expect, it, vi } from "vitest";
import { createOptimizationReadCache } from "../src/prompt-optimization/read-cache";

it("shares a pending read while keeping each caller's cancellation independent", async () => {
  const cache = createOptimizationReadCache<{ count: number }>();
  let complete!: (value: { count: number }) => void;
  let sharedSignal!: AbortSignal;
  const load = vi.fn((signal: AbortSignal) => { sharedSignal = signal; return new Promise<{ count: number }>(resolve => { complete = resolve; }); });
  const first = new AbortController(), second = new AbortController();
  const cancelled = cache.read("templates", load, first.signal);
  const retained = cache.read("templates", load, second.signal);
  await Promise.resolve();
  first.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(sharedSignal.aborted).toBe(false);
  complete({ count: 5 });
  await expect(retained).resolves.toEqual({ count: 5 });
  await expect(cache.read("templates", load)).resolves.toEqual({ count: 5 });
  expect(load).toHaveBeenCalledTimes(1);
});

it("aborts an unobserved request and never caches its late result", async () => {
  const cache = createOptimizationReadCache<number>();
  let complete!: (value: number) => void;
  let sharedSignal!: AbortSignal;
  const load = vi.fn((signal: AbortSignal) => { sharedSignal = signal; return new Promise<number>(resolve => { complete = resolve; }); });
  const controller = new AbortController();
  const pending = cache.read("models", load, controller.signal);
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(sharedSignal.aborted).toBe(true);
  complete(1);
  await expect(cache.read("models", async () => 2)).resolves.toBe(2);
  await expect(cache.read("models", async () => 3)).resolves.toBe(2);
});

it("keeps the refreshed result when the superseded request completes later", async () => {
  const cache = createOptimizationReadCache<number>();
  let complete!: (value: number) => void;
  const original = cache.read("templates", () => new Promise<number>(resolve => { complete = resolve; }));
  await Promise.resolve();
  await expect(cache.read("templates", async () => 2, undefined, true)).resolves.toBe(2);
  complete(1);
  await expect(original).resolves.toBe(1);
  await expect(cache.read("templates", async () => 3)).resolves.toBe(2);
});

it("rejects a cancelled cached read without discarding the successful result", async () => {
  const cache = createOptimizationReadCache<number>();
  await cache.read("settings", async () => 4);
  const controller = new AbortController(); controller.abort();
  await expect(cache.read("settings", async () => 5, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  await expect(cache.read("settings", async () => 6)).resolves.toBe(4);
});
