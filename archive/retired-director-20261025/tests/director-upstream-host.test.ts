import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { guardDirectorFilePickers, mountUpstreamDirector, normalizeDirectorWidgetValues, setDirectorWidgetValues, DIRECTOR_TASK_OPTIONS } from "../src/director/upstream-host";
import { attachDirectorTransport, detachDirectorTransport, upstreamApi, upstreamApp } from "../src/director/upstream-runtime";

describe("original Director host", () => {
  it("preserves valid scalar inputs while rejecting shifted widget values and graph links", () => {
    const values = normalizeDirectorWidgetValues({
      task_type: DIRECTOR_TASK_OPTIONS[3], seed: 666, steps: 8,
      clear_vram_between_segments: "", clear_vram_before_refine: "misaligned-value",
      cache_frames_codec: "", bd_grp_perf: "", model: ["16", 0],
      frame_rate: Number.NaN, global_prompt: "session-only prompt",
    });
    expect(values).toMatchObject({
      seed: 666, steps: 8, clear_vram_between_segments: true,
      clear_vram_before_refine: false, cache_frames_codec: "raw",
      bd_grp_perf: "性能", frame_rate: 24, global_prompt: "session-only prompt",
    });
    expect(values).not.toHaveProperty("model");
  });

  it("keeps false toggles and supported codec values", () => {
    expect(normalizeDirectorWidgetValues({ clear_vram_between_segments: false, cache_frames_codec: "ffv1" }))
      .toMatchObject({ clear_vram_between_segments: false, cache_frames_codec: "ffv1" });
  });

  it("updates actual parameter widgets, runs their callbacks, flushes and publishes the coherent result without throwing", () => {
    const events: string[] = [];
    const seed = { name: "seed", type: "number", value: 1, callback: vi.fn(function (this: any, value: number) {
      events.push("seed"); expect(this).toBe(seed); expect(value).toBe(123); expect(steps.value).toBe(8);
    }) };
    const steps = { name: "steps", type: "number", value: 25, callback: vi.fn(() => events.push("steps")) };
    const perf = { name: "clear_vram_between_segments", type: "boolean", value: true, callback: vi.fn(() => events.push("performance")) };
    const timeline = { name: "timeline_data", type: "string", value: "{}" };
    const node = { widgets: [seed, steps, perf, timeline], onWidgetChanged: vi.fn(), _minimaxEditor: {
      flushTimelineSync: vi.fn(() => { events.push("flush"); timeline.value = JSON.stringify({ fixture: "flushed" }); }),
    } };
    const changed = vi.fn(() => { events.push("publish"); expect(JSON.parse(timeline.value)).toEqual({ fixture: "flushed" }); });
    expect(() => setDirectorWidgetValues(node, { seed: 123, steps: 8, clear_vram_between_segments: false }, changed)).not.toThrow();
    expect(seed.value).toBe(123); expect(steps.value).toBe(8); expect(perf.value).toBe(false);
    expect(seed.callback).toHaveBeenCalledExactlyOnceWith(123);
    expect(node.onWidgetChanged).toHaveBeenCalledWith("seed", 123, 1, seed);
    expect(node.onWidgetChanged).toHaveBeenCalledTimes(3);
    expect(events).toEqual(["seed", "steps", "performance", "flush", "publish"]);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("ignores unchanged, invalid, unknown and editor-owned fields without flushing or introducing prompt storage", () => {
    const callback = vi.fn(), changed = vi.fn(), flushTimelineSync = vi.fn();
    const node = { widgets: [
      { name: "seed", value: 3, callback }, { name: "steps", value: 8, callback },
      { name: "global_prompt", value: "session-only fixture", callback },
      { name: "timeline_data", value: "{}", callback }, { name: "bd_grp_sample", value: "采样设置", callback },
      { name: "temporary", value: "unchanged", serialize: false, callback },
      { name: "minimax_director_ui", value: "", type: "director", callback },
      { name: "sampler", value: "res_multistep", options: { values: ["res_multistep", "euler"] }, callback },
      { name: "cache_frames_codec", value: "raw", callback },
    ], _minimaxEditor: { flushTimelineSync } };
    const before = node.widgets.map(widget => widget.value);
    expect(setDirectorWidgetValues(node, {
      seed: 3, steps: Number.NaN, unknown: 5, global_prompt: "replacement", timeline_data: "not JSON", bd_grp_sample: "changed",
      temporary: "changed", minimax_director_ui: "changed", sampler: "unavailable", cache_frames_codec: "invalid",
    }, changed)).toBe(false);
    expect(node.widgets.map(widget => widget.value)).toEqual(before);
    expect(callback).not.toHaveBeenCalled(); expect(flushTimelineSync).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
    expect(setDirectorWidgetValues(node, { steps: "8", seed: ["node-link", 0] }, changed)).toBe(false);
  });

  it("uses supported canonical task choices and preserves native string and boolean callback values", () => {
    const callback = vi.fn(), changed = vi.fn();
    const node = { widgets: [
      { name: "task_type", value: DIRECTOR_TASK_OPTIONS[3], options: { values: DIRECTOR_TASK_OPTIONS }, callback },
      { name: "cache_name", value: "", callback }, { name: "clear_vram_before_refine", value: false, callback },
    ], _minimaxEditor: { flushTimelineSync: vi.fn() } };
    expect(setDirectorWidgetValues(node, { task_type: "v2v", cache_name: "fixture-cache", clear_vram_before_refine: true }, changed)).toBe(true);
    expect(node.widgets.map(widget => widget.value)).toEqual([DIRECTOR_TASK_OPTIONS[4], "fixture-cache", true]);
    expect(callback.mock.calls).toEqual([[DIRECTOR_TASK_OPTIONS[4]], ["fixture-cache"], [true]]);
  });

  it("does not load or mount an editor after cancellation", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(mountUpstreamDirector({} as HTMLElement, {
      signal: abort.signal, fetchApi: vi.fn(), apiURL: value => value,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("shares one project transport across independent inline editors", async () => {
    const owner = {}, other = {};
    const response = new Response("test");
    const transport = { fetchApi: vi.fn().mockResolvedValue(response), apiURL: (value: string) => "/canvas" + value };
    const first = { id: "director-a" }, second = { id: "director-b" };
    const graph = { _nodes: [first] }, otherGraph = { _nodes: [second] };
    attachDirectorTransport(owner, transport, graph);
    try {
      expect(upstreamApp.graph._nodes).toEqual([first]);
      expect(upstreamApi.apiURL("/view?filename=a.png")).toBe("/canvas/view?filename=a.png");
      expect(await upstreamApi.fetchApi("/upload/image", { method: "POST" })).toBe(response);
      expect(transport.fetchApi).toHaveBeenCalledWith("/upload/image", { method: "POST" });
      attachDirectorTransport(other, { ...transport }, otherGraph);
      expect(upstreamApp.graph._nodes).toEqual([first, second]);
      expect(upstreamApp.graph.getNodeById("director-a")).toBe(first);
      expect(upstreamApp.graph.getNodeById("director-b")).toBe(second);
      detachDirectorTransport(owner);
      expect(upstreamApp.graph._nodes).toEqual([second]);
      expect(await upstreamApi.fetchApi("/upload/image")).toBe(response);
      detachDirectorTransport({});
      expect(upstreamApp.graph._nodes).toEqual([second]);
    } finally { detachDirectorTransport(owner); detachDirectorTransport(other); }
    expect(upstreamApp.graph).toBeNull();
    await expect(upstreamApi.fetchApi("/upload/image")).rejects.toThrow("导演台已经关闭");
  });

  it("rejects a different project bridge instead of routing uploads to the last mounted node", async () => {
    const owner = {}, other = {};
    const transport = { fetchApi: vi.fn().mockResolvedValue(new Response("first")), apiURL: (value: string) => "/first" + value };
    const different = { fetchApi: vi.fn(), apiURL: (value: string) => "/second" + value };
    attachDirectorTransport(owner, transport, { _nodes: [{ id: "director-a" }] });
    try {
      expect(() => attachDirectorTransport(other, different, { _nodes: [] })).toThrow("共享项目素材连接");
      detachDirectorTransport(other);
      expect(upstreamApi.apiURL("/view")).toBe("/first/view");
      expect(await (await upstreamApi.fetchApi("/upload/image")).text()).toBe("first");
      expect(different.fetchApi).not.toHaveBeenCalled();
    } finally { detachDirectorTransport(owner); detachDirectorTransport(other); }
  });

  it("keeps the shared graph live as async hosts add nodes and preserves in-flight requests", async () => {
    const owner = {}, other = {};
    let finish!: (response: Response) => void;
    const transport = { fetchApi: vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })), apiURL: (value: string) => value };
    const graph: { _nodes: { id: string }[] } = { _nodes: [] };
    attachDirectorTransport(owner, transport, graph);
    attachDirectorTransport(other, transport, { _nodes: [{ id: "director-b" }] });
    try {
      graph._nodes.push({ id: "director-a" });
      expect(upstreamApp.graph.getNodeById("director-a")).toEqual({ id: "director-a" });
      const pending = upstreamApi.fetchApi("/upload/image");
      detachDirectorTransport(owner);
      finish(new Response("complete"));
      expect(await (await pending).text()).toBe("complete");
      expect(upstreamApp.graph.getNodeById("director-a")).toBeNull();
      expect(upstreamApp.graph.getNodeById("director-b")).not.toBeNull();
    } finally { detachDirectorTransport(owner); detachDirectorTransport(other); }
  });

  it("cancels an upstream body picker before its late change can reach the next host", async () => {
    const body = {}, records: MutationRecord[] = [];
    class FileInput extends EventTarget {
      type = "file"; parentNode: object | null = body; value = "selected";
      style = { position: "fixed", left: "-9999px", opacity: "0", pointerEvents: "none" };
      onchange: ((event: Event) => void) | null = vi.fn();
      remove() { this.parentNode = null; }
    }
    const observer = { observe: vi.fn(), disconnect: vi.fn(), takeRecords: () => records.splice(0) };
    vi.stubGlobal("HTMLInputElement", FileInput);
    vi.stubGlobal("MutationObserver", class { constructor() { return observer; } });
    const container = Object.assign(new EventTarget(), { ownerDocument: { body } }) as unknown as HTMLElement;
    try {
      const dispose = guardDirectorFilePickers(container);
      container.dispatchEvent(new Event("click"));
      const input = new FileInput(), upload = input.onchange, cancelled = vi.fn();
      input.addEventListener("cancel", cancelled);
      records.push({ addedNodes: [input] } as unknown as MutationRecord);
      // Cleanup can run before the MutationObserver/microtask has delivered.
      dispose(); dispose();
      await Promise.resolve();
      expect(input.onchange).toBeNull();
      expect(input.parentNode).toBeNull();
      expect(input.value).toBe("");
      expect(upload).not.toHaveBeenCalled();
      expect(cancelled).toHaveBeenCalledOnce();
      expect(observer.disconnect).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it("leaves unrelated file pickers alone and blocks a captured old change callback", async () => {
    const body = {}, records: MutationRecord[] = [];
    class FileInput extends EventTarget {
      type = "file"; parentNode: object | null = body; value = "";
      style = { position: "fixed", left: "-9999px", opacity: "0", pointerEvents: "none" };
      onchange: ((event: Event) => void) | null = vi.fn();
      remove() { this.parentNode = null; }
    }
    const observer = { observe: vi.fn(), disconnect: vi.fn(), takeRecords: () => records.splice(0) };
    vi.stubGlobal("HTMLInputElement", FileInput);
    vi.stubGlobal("MutationObserver", class { constructor() { return observer; } });
    const container = Object.assign(new EventTarget(), { ownerDocument: { body } }) as unknown as HTMLElement;
    try {
      const dispose = guardDirectorFilePickers(container);
      const unrelated = new FileInput(), unrelatedHandler = unrelated.onchange;
      records.push({ addedNodes: [unrelated] } as unknown as MutationRecord);
      container.dispatchEvent(new Event("click"));
      const input = new FileInput(), upload = input.onchange;
      records.push({ addedNodes: [input] } as unknown as MutationRecord);
      await Promise.resolve();
      const capturedChange = input.onchange;
      dispose();
      capturedChange?.(new Event("change"));
      expect(upload).not.toHaveBeenCalled();
      expect(unrelated.onchange).toBe(unrelatedHandler);
      expect(unrelated.parentNode).toBe(body);
    } finally { vi.unstubAllGlobals(); }
  });

  it("ships every pinned UI source file with its original hash", async () => {
    const root = path.resolve("vendor/minimax-director");
    const manifest = JSON.parse((await readFile(path.join(root, "SOURCE.json"), "utf8")).replace(/^\uFEFF/, ""));
    expect(manifest.revision).toBe("4c6245e518dd8a494f3afc4f3cccd53f22d82d10");
    expect(manifest.files.length).toBeGreaterThan(10);
    for (const entry of manifest.files) {
      const bytes = await readFile(path.join(root, entry.path));
      expect(createHash("sha256").update(bytes).digest("hex"), entry.path).toBe(entry.sha256);
    }
  });
});
