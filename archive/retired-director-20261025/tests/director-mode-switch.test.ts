import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIRECTOR_TASK_OPTIONS, enableDirectorModeCompatibility, normalizeDirectorWidgetValues } from "../src/director/upstream-host";
// @ts-expect-error The pinned upstream helpers are distributed as plain JavaScript.
import { getDirectorMode, resolveTaskKey } from "../vendor/minimax-director/web/js/minimax_gen_timeline.js";
// @ts-expect-error Exercise the real original sizing/cleanup implementation.
import { syncBatchPanelFillHeight } from "../vendor/minimax-director/web/js/minimax_image_batch.js";

const source = (await readFile("vendor/minimax-director/web/js/minimax_timeline.js", "utf8")).replaceAll("\r\n", "\n");
function originalMethod(name: string, bindings: Record<string, unknown> = {}) {
  const start = source.indexOf(`    ${name}(`), end = source.indexOf("\n    }\n", start);
  if (start < 0 || end < 0) throw new Error(`Missing original Director method: ${name}`);
  const method = source.slice(start, end + 6).trim();
  return new Function(...Object.keys(bindings), `return {${method}}.${name};`)(...Object.values(bindings));
}
const onGlobalField = originalMethod("onGlobalField", { resolveTaskKey });
const populateTaskSelect = originalMethod("populateTaskSelect", { resolveTaskKey, taskDisplayLabel: (key: string) => key });

function element() {
  const classes = new Set<string>();
  const style: Record<string, any> = {
    setProperty(name: string, value: string) { this[name] = value; },
    removeProperty(name: string) { const old = this[name]; this[name] = ""; return old; },
  };
  return {
    style, offsetHeight: 0, clientHeight: 0, children: [] as any[],
    querySelector: (_selector: string): any => null,
    querySelectorAll: (_selector: string): any[] => [],
    classList: {
      toggle(name: string, force: boolean) { if (force) classes.add(name); else classes.delete(name); },
      contains(name: string) { return classes.has(name); },
      remove(name: string) { classes.delete(name); },
    },
  };
}

function editorFixture() {
  vi.stubGlobal("getComputedStyle", () => ({ display: "block" }));
  const mainBody = element(), batchPanel = element(), root = element(), container = element();
  mainBody.children = [batchPanel]; root.children = [mainBody];
  container.querySelector = selector => selector === ".bd-main" ? mainBody : null;
  const editor: any = {
    mainBody, batchPanel, root, container, batchList: element(),
    domWidget: { computedHeight: 0, options: {} },
    node: {}, timeline: { global: { taskType: DIRECTOR_TASK_OPTIONS[3] }, segments: [{}], output: {} },
    globalTask: { value: DIRECTOR_TASK_OPTIONS[3] },
    taskTypeWidget: { value: DIRECTOR_TASK_OPTIONS[3], options: { values: DIRECTOR_TASK_OPTIONS } },
    _taskKey: "r2v", _directorMode: "prompt_batch",
    getDirectorUiMinHeight: () => 680,
    getDirectorMode() { return getDirectorMode(this.globalTask.value || this.taskTypeWidget.value); },
    getTaskKey() { return resolveTaskKey(this.globalTask.value || this.taskTypeWidget.value); },
    isImageBatch() { return this.getDirectorMode() === "prompt_batch"; },
    applyTaskLayout: vi.fn(function (this: any, previousMode: string, previousTask: string) {
      this.previous = { mode: previousMode, task: previousTask };
      this._taskKey = this.getTaskKey(); this._directorMode = this.getDirectorMode();
      this.batchPanel.classList.toggle("hidden", !this.isImageBatch());
      syncBatchPanelFillHeight(this, { settle: false });
    }),
    updateSegmentContinuityUI: vi.fn(), scheduleTimelineSync: vi.fn(), scheduleRender: vi.fn(), _schedulePromptRender: vi.fn(),
    onGlobalField, populateTaskSelect,
    applyImportedTimeline: vi.fn(function (this: any, timeline: unknown, widgets: any) {
      this.imported = { timeline, widgets };
      this.taskTypeWidget.value = widgets.task_type;
      this.globalTask.value = widgets.task_type;
      this.applyTaskLayout(this._directorMode, this._taskKey);
    }),
  };
  return editor;
}

afterEach(() => vi.unstubAllGlobals());

describe("Director mode compatibility", () => {
  it("reproduces the original batch cleanup leaving a zero flex basis, then releases it in the content-sized host", () => {
    const editor = editorFixture();
    editor.applyTaskLayout("prompt_batch", "r2v");
    expect(editor.mainBody.style.flex).toBe("1 1 0");
    editor.onGlobalField("taskType", DIRECTOR_TASK_OPTIONS[4]);
    // This is the shipped upstream cleanup, not a duplicate of its styles.
    expect(editor.mainBody.style.flex).toBe("1 1 0");
    enableDirectorModeCompatibility(editor);
    expect(editor.mainBody.style.flex).toBe("");
  });

  it("preserves the original mode handler across every ordered pair of the seven supported modes", () => {
    const editor = editorFixture(), originalLayout = editor.applyTaskLayout;
    enableDirectorModeCompatibility(editor);
    const adapted = editor.applyTaskLayout;
    enableDirectorModeCompatibility(editor);
    expect(editor.applyTaskLayout).toBe(adapted);
    for (const from of DIRECTOR_TASK_OPTIONS) for (const to of DIRECTOR_TASK_OPTIONS) {
      if (from === to) continue;
      editor.onGlobalField("taskType", from);
      editor.onGlobalField("taskType", to);
      expect(editor.previous).toEqual({ mode: getDirectorMode(from), task: resolveTaskKey(from) });
      expect(editor.getTaskKey()).toBe(resolveTaskKey(to));
      expect(editor.globalTask.value).toBe(to);
      expect(editor.taskTypeWidget.value).toBe(to);
      expect(editor.timeline.global.taskType).toBe(to);
      expect(editor.batchPanel.classList.contains("hidden")).toBe(getDirectorMode(to) !== "prompt_batch");
      expect(editor.mainBody.style.flex).toBe(getDirectorMode(to) === "prompt_batch" ? "1 1 0" : "");
    }
    expect(originalLayout).toHaveBeenCalledTimes(84);
    expect(editor.scheduleTimelineSync).toHaveBeenCalledTimes(84);
    expect(editor.updateSegmentContinuityUI).toHaveBeenCalledTimes(84);
  });

  it.each(DIRECTOR_TASK_OPTIONS)("recognizes the original task key rather than an exact translated label: %s", option => {
    const key = resolveTaskKey(option);
    expect(normalizeDirectorWidgetValues({ task_type: key }).task_type).toBe(option);
    expect(normalizeDirectorWidgetValues({ task_type: key + " — previous locale label" }).task_type).toBe(option);
    const editor = editorFixture();
    enableDirectorModeCompatibility(editor);
    editor.onGlobalField("taskType", key);
    expect(editor.globalTask.value).toBe(option);
    expect(editor._taskKey).toBe(key);
  });

  it("normalizes imported task options without changing the original timeline, other settings, or import semantics", () => {
    const editor = editorFixture(), imported = editor.applyImportedTimeline;
    enableDirectorModeCompatibility(editor);
    const timeline = { global: { taskType: "v2v" }, segments: [] }, widgets = { steps: 8, seed: 5 };
    editor.applyImportedTimeline(timeline, widgets);
    expect(imported).toHaveBeenCalledExactlyOnceWith(timeline, { steps: 8, seed: 5, task_type: DIRECTOR_TASK_OPTIONS[4] });
    expect(editor.imported.timeline).toBe(timeline);
    expect(widgets).toEqual({ steps: 8, seed: 5 });
    editor.applyImportedTimeline(timeline, { task_type: "fl2v — legacy label", seed: 7 });
    expect(editor._taskKey).toBe("fl2v");
    expect(editor.imported.widgets).toEqual({ task_type: DIRECTOR_TASK_OPTIONS[2], seed: 7 });
    expect(editor.mainBody.style.flex).toBe("");
  });

  it("keeps the original selector selected after receiving a bare task key", () => {
    vi.stubGlobal("document", { createElement: () => ({ value: "", textContent: "" }) });
    const editor = editorFixture(), options: any[] = [];
    let selected = "";
    const select = {
      set innerHTML(_value: string) { options.length = 0; selected = ""; },
      get value() { return selected; },
      set value(value: string) { selected = options.some(option => option.value === value) ? value : ""; },
      appendChild(option: any) { options.push(option); },
    };
    editor.populateTaskSelect(select, "rv2v");
    expect(select.value).toBe("");
    enableDirectorModeCompatibility(editor);
    editor.populateTaskSelect(select, "rv2v");
    expect(select.value).toBe(DIRECTOR_TASK_OPTIONS[5]);
    expect(options.map(option => option.value)).toEqual(DIRECTOR_TASK_OPTIONS);
  });

  it("does not introduce unsupported task modes or alter ordinary field edits", () => {
    expect(normalizeDirectorWidgetValues({ task_type: "unknown — unavailable" }).task_type).toBe(DIRECTOR_TASK_OPTIONS[3]);
    const editor = editorFixture(), other = editorFixture();
    enableDirectorModeCompatibility(editor); enableDirectorModeCompatibility(other);
    editor.onGlobalField("taskType", "fl2v");
    editor.onGlobalField("prompt", "test-only edit");
    expect(editor.timeline.global.prompt).toBe("test-only edit");
    expect(other._taskKey).toBe("r2v");
    expect(other.timeline.global.prompt).toBeUndefined();
  });
});
