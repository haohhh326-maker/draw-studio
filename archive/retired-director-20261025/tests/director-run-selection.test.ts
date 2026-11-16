import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { keepDirectorRunSelectionDiscoverable } from "../src/director/upstream-host";
// @ts-expect-error The pinned upstream helper is distributed as plain JavaScript.
import { isPromptBatchTask } from "../vendor/minimax-director/web/js/minimax_gen_timeline.js";

const source = (await readFile("vendor/minimax-director/web/js/minimax_timeline.js", "utf8")).replaceAll("\r\n", "\n");
const methodNames = ["supportsRunSelect", "isRunSelectEnabled", "normalizeRunSelection", "isSegmentRunEnabled", "toggleSegmentRun", "toggleRunSelectMode", "setRunSelectionAll", "updateRunSelectUI", "_runSelectionPayload"];
// Exercise the shipped methods, including serialization, without constructing
// the unrelated browser/media UI. Their bytes are separately pinned by hash.
const methods = methodNames.map(name => {
  const start = source.indexOf(`    ${name}(`);
  const end = source.indexOf("\n    }\n", start);
  if (start < 0 || end < 0) throw new Error(`Missing upstream method: ${name}`);
  return source.slice(start, end + 6).trim();
}).join(",\n");
const upstreamMethods = new Function("isPromptBatchTask", "fl2vStartIndices", "t", `return {${methods}};`)(
  isPromptBatchTask,
  (editor: any) => editor.timeline.segments.map((_: unknown, index: number) => index),
  (key: string) => key,
);
const batchSource = await readFile("vendor/minimax-director/web/js/minimax_image_batch.js", "utf8");
const cardPredicate = batchSource.match(/const runSelectOn = ([^;]+);/);
if (!cardPredicate) throw new Error("Missing upstream group checkbox predicate");
const cardCheckboxVisible = new Function("editor", `return ${cardPredicate[1]};`);

function control() {
  const classes = new Set<string>();
  return {
    disabled: false, checked: false, indeterminate: false, textContent: "", title: "upstream run-selection tooltip", style: { color: "" },
    classList: {
      toggle(name: string, force: boolean) { if (force) classes.add(name); else classes.delete(name); },
      remove(name: string) { classes.delete(name); },
      contains(name: string) { return classes.has(name); },
    },
  };
}
function makeEditor(count: number) {
  const editor: any = {
    ...upstreamMethods,
    timeline: { segments: Array.from({ length: count }, () => ({})), runSelectEnabled: false, runSelection: [], output: {} },
    getRunnableSegmentCount() { return this.timeline.segments.length; },
    getDirectorMode: () => "prompt_batch", getTaskKey: () => "r2v", isImageBatch: () => true, isFl2vMode: () => false,
    btnRunSelectToggle: control(), batchRunSelectBtn: control(), runSelectAllWrap: control(), batchRunSelectAllWrap: control(),
    runSelectAllCb: control(), batchRunSelectAllCb: control(), runSelectBar: control(), runSelectSummary: control(), runStatusEl: control(),
    renderImageBatchGroups: vi.fn(), scheduleRender: vi.fn(),
  };
  editor.commit = vi.fn(() => { editor.serialized = JSON.parse(JSON.stringify(editor._runSelectionPayload())); });
  return editor;
}

describe("Director run-selection control discoverability", () => {
  it("keeps a single-group button visible but disabled with no all-select, card checkbox or selection payload", () => {
    const editor = makeEditor(1);
    editor.updateRunSelectUI();
    expect(editor.btnRunSelectToggle.classList.contains("hidden")).toBe(true);
    const supports = editor.supportsRunSelect;
    keepDirectorRunSelectionDiscoverable(editor);
    expect(editor.supportsRunSelect).toBe(supports);
    expect(editor.supportsRunSelect()).toBe(false);
    expect(editor.getRunnableSegmentCount()).toBe(1);
    expect(editor.btnRunSelectToggle.classList.contains("hidden")).toBe(false);
    expect(editor.btnRunSelectToggle.disabled).toBe(true);
    expect(editor.btnRunSelectToggle.title).toContain("至少需要 2 个分组");
    editor.toggleRunSelectMode();
    expect(editor.timeline.runSelectEnabled).toBe(false);
    expect(editor.runSelectAllWrap.classList.contains("hidden")).toBe(true);
    expect(editor.runSelectBar.classList.contains("hidden")).toBe(true);
    expect(cardCheckboxVisible(editor)).toBe(false);
    expect(editor._runSelectionPayload()).toEqual({ runSelectEnabled: false, runSelection: [] });
    expect(editor.commit).not.toHaveBeenCalled();
    expect(editor.renderImageBatchGroups).not.toHaveBeenCalled();
  });

  it("preserves the full original two-group selection, all-select and indeterminate sequence", () => {
    const original = makeEditor(2), adapted = makeEditor(2);
    original.updateRunSelectUI();
    keepDirectorRunSelectionDiscoverable(adapted);
    const state = (editor: any) => ({
      payload: editor._runSelectionPayload(), selected: [editor.isSegmentRunEnabled(0), editor.isSegmentRunEnabled(1)],
      all: editor.runSelectAllCb.checked, indeterminate: editor.runSelectAllCb.indeterminate,
      allHidden: editor.runSelectAllWrap.classList.contains("hidden"), cardCheckboxVisible: cardCheckboxVisible(editor),
      summary: editor.runSelectSummary.textContent, summaryColor: editor.runSelectSummary.style.color,
    });
    for (const [action, arg, selected, all, indeterminate] of [
      ["toggleRunSelectMode", undefined, [0, 1], true, false],
      ["toggleSegmentRun", 0, [1], false, true],
      ["toggleSegmentRun", 1, [], false, false],
      ["setRunSelectionAll", true, [0, 1], true, false],
      ["setRunSelectionAll", false, [], false, false],
      ["toggleSegmentRun", 0, [0], false, true],
      ["toggleRunSelectMode", undefined, [], false, true],
    ] as const) {
      original[action](arg); adapted[action](arg);
      expect(state(adapted)).toEqual(state(original));
      expect(adapted._runSelectionPayload().runSelection).toEqual(selected);
      expect(adapted.runSelectAllCb.checked).toBe(all);
      expect(adapted.runSelectAllCb.indeterminate).toBe(indeterminate);
    }
    expect(adapted.btnRunSelectToggle.title).toBe("upstream run-selection tooltip");
    expect(adapted.btnRunSelectToggle.disabled).toBe(false);
  });

  it("does not leak old selection flags after reducing to one group or restoring a legacy single-group state", () => {
    const editor = makeEditor(2);
    keepDirectorRunSelectionDiscoverable(editor);
    editor.toggleRunSelectMode(); editor.toggleSegmentRun(0);
    expect(editor._runSelectionPayload()).toEqual({ runSelectEnabled: true, runSelection: [1] });
    editor.timeline.segments.pop();
    editor.updateRunSelectUI();
    expect(editor.timeline.runSelectEnabled).toBe(true); // Original preference is retained, not forcibly cleared.
    expect(editor.btnRunSelectToggle.disabled).toBe(true);
    expect(editor.runSelectAllWrap.classList.contains("hidden")).toBe(true);
    expect(cardCheckboxVisible(editor)).toBe(false);
    expect(editor._runSelectionPayload()).toEqual({ runSelectEnabled: false, runSelection: [] });

    const legacy = makeEditor(1);
    legacy.timeline.runSelectEnabled = true; legacy.timeline.runSelection = [0];
    keepDirectorRunSelectionDiscoverable(legacy);
    expect(cardCheckboxVisible(legacy)).toBe(false);
    expect(legacy._runSelectionPayload()).toEqual({ runSelectEnabled: false, runSelection: [] });
    expect(legacy.renderImageBatchGroups).not.toHaveBeenCalled();

    // A language change replaces the upstream title before updateRunSelectUI.
    editor.btnRunSelectToggle.title = "new upstream locale tooltip";
    editor.updateRunSelectUI();
    editor.timeline.segments.push({});
    editor.updateRunSelectUI();
    expect(editor.btnRunSelectToggle.disabled).toBe(false);
    expect(editor.btnRunSelectToggle.title).toBe("new upstream locale tooltip");
  });

  it("keeps empty or unsupported timelines discoverable but cannot enable an invalid selection", () => {
    const editor = makeEditor(0);
    keepDirectorRunSelectionDiscoverable(editor);
    expect(editor.btnRunSelectToggle.classList.contains("hidden")).toBe(false);
    expect(editor.btnRunSelectToggle.disabled).toBe(true);
    editor.toggleRunSelectMode();
    expect(editor.timeline.runSelectEnabled).toBe(false);
    editor.timeline.segments.push({}, {});
    editor.getDirectorMode = () => "gen_blank"; editor.isImageBatch = () => false;
    const before = JSON.parse(JSON.stringify(editor.timeline));
    editor.updateRunSelectUI();
    expect(editor.btnRunSelectToggle.disabled).toBe(true);
    expect(editor.btnRunSelectToggle.title).toBe("当前模式不支持选择运行。");
    expect(editor.runSelectAllWrap.classList.contains("hidden")).toBe(true);
    expect(cardCheckboxVisible(editor)).toBe(false);
    expect(editor._runSelectionPayload()).toEqual({ runSelectEnabled: false, runSelection: [] });
    expect(editor.timeline).toEqual(before);
  });
});
