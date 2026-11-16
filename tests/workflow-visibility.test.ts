import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(records.get(key)),
  writeRecord: vi.fn(async (key: string, value: unknown) => { records.set(key, structuredClone(value)); }),
  safeConnection: (value: object) => ({ ...value, token: "" }),
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: vi.fn(async () => {}) }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: vi.fn() }));
import { useStore } from "../src/stores/store";
import { defaultConnection, findWorkflow } from "../src/workflow/catalog";
import { readWorkflowLibrary, type WorkflowLibrarySnapshot } from "../src/workflow/library-client";
import { readHiddenWorkflowKeys, WORKFLOW_VISIBILITY_RECORD, workflowVisibilityGroups, workflowVisibilityKey } from "../src/workflow/visibility";
import { buildDirectoryView } from "../src/workflow/directory-view";
import { validateDefinition } from "../src/workflow-adapter/adapter";
import * as storage from "../src/projects/storage";
import type { WorkflowDefinition } from "../src/types";

const sourcePath = "E:/123/library";
function workflow(id: string, kind: "image" | "video" | "audio" | "text" = "image", path = sourcePath): WorkflowDefinition {
  return { id: "library-" + id, name: "Workflow " + id, family: "Family " + kind, description: "", mode: "text-to-image", promptRequired: false,
    library: { sourcePath: path, folder: id }, directory: { version: 2, canvas: kind === "audio" ? "music" : kind, seriesId: kind, bindingKey: id, bindingStatus: "bound" },
    requiredInputs: [], optionalInputs: [], parameters: [], mapping: [],
    template: { maker: { class_type: "OwnMaker", inputs: {} }, result: { class_type: "Save", inputs: { value: ["maker", 0] } } },
    output: { nodeId: "result", field: kind === "image" ? "images" : kind, kind } };
}
let files: WorkflowDefinition[];
const snapshot = (): WorkflowLibrarySnapshot => ({ sourcePath, loadedAt: Date.now(), scanned: files.length, workflows: structuredClone(files), issues: [] });
beforeEach(() => {
  vi.useFakeTimers(); records.clear(); vi.clearAllMocks();
  vi.mocked(storage.writeRecord).mockReset().mockImplementation(async (key, value) => { records.set(key, structuredClone(value)); });
  files = [workflow("one"), workflow("video", "video"), workflow("audio", "audio"), workflow("text", "text")];
  vi.mocked(readWorkflowLibrary).mockReset().mockImplementation(async () => snapshot());
  const session = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value), removeItem: (key: string) => session.delete(key) });
  useStore.setState({ projectOpen: false, navigating: false, ready: false, projects: {}, workflows: structuredClone(files), hiddenWorkflowKeys: [],
    workflowLibrary: snapshot(), libraryState: "loaded", libraryError: "", connection: defaultConnection, past: [], future: [] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("reversible software workflow visibility", () => {
  it("partitions all four output categories and changes visible classification counts", () => {
    const keys = [workflowVisibilityKey(files[0]), workflowVisibilityKey(files[2])];
    const groups = workflowVisibilityGroups(files, keys), view = buildDirectoryView(groups.visible);
    expect(groups.visible.map(item => item.output.kind)).toEqual(["video", "text"]);
    expect(groups.hidden.map(item => item.output.kind)).toEqual(["image", "audio"]);
    expect(view.map(item => [item.id, item.workflows.length])).toEqual([["music", 0], ["image", 0], ["video", 1], ["text", 1]]);
    expect(buildDirectoryView(groups.hidden).flatMap(item => item.series).every(series => series.workflows === 1)).toBe(true);
  });

  it("keeps preference identities stable across canvas aliases, source path spelling and display-name changes", () => {
    const original = workflow("stable"), alias = { ...original, id: "older-canvas-id", name: "renamed", library: { ...original.library!, sourcePath: "e:\\123\\LIBRARY\\" } };
    expect(workflowVisibilityKey(original)).toBe(workflowVisibilityKey(alias));
    expect(workflowVisibilityGroups([alias], [workflowVisibilityKey(original)]).hidden).toEqual([alias]);
    expect(workflowVisibilityGroups([workflow("stable", "image", "E:/other/library")], [workflowVisibilityKey(original)]).visible).toHaveLength(1);
  });

  it("hides and restores only the menu preference, retaining the exact definition and current node binding", async () => {
    await useStore.getState().newProject("Bound workflow");
    const state = useStore.getState(), nodeId = state.addNode("image-generation"), original = state.workflows.find(item => item.id === files[0].id)!;
    state.patchNode(nodeId, { generation: { workflowId: original.id, prompt: "keep this prompt", negativePrompt: "", params: {}, taskId: null } });
    const project = useStore.getState().project, definitions = useStore.getState().workflows;
    await useStore.getState().setWorkflowHidden(original, true);
    expect(useStore.getState().project).toBe(project);
    expect(useStore.getState().workflows).toBe(definitions);
    expect(findWorkflow(useStore.getState().workflows, original.id)).toBe(original);
    expect(() => validateDefinition(original)).not.toThrow();
    expect(workflowVisibilityGroups(definitions, useStore.getState().hiddenWorkflowKeys).visible).not.toContain(original);
    expect(records.get(WORKFLOW_VISIBILITY_RECORD)).toEqual({ version: 1, hiddenKeys: [workflowVisibilityKey(original)] });
    await useStore.getState().setWorkflowHidden(original, false);
    expect(workflowVisibilityGroups(definitions, useStore.getState().hiddenWorkflowKeys).visible).toContain(original);
    expect(useStore.getState().project.canvases[0].nodes.find(node => node.id === nodeId)?.data.generation?.workflowId).toBe(original.id);
    expect(records.get(WORKFLOW_VISIBILITY_RECORD)).toEqual({ version: 1, hiddenKeys: [] });
  });

  it("persists outside projects, survives hydrate and project reopen, and shows newly added dynamic workflows", async () => {
    await useStore.getState().newProject("First");
    const first = useStore.getState().project.id;
    await useStore.getState().setWorkflowHidden(files[0], true);
    await useStore.getState().leaveProject();
    await useStore.getState().newProject("Second");
    expect(useStore.getState().hiddenWorkflowKeys).toEqual([workflowVisibilityKey(files[0])]);
    await useStore.getState().leaveProject();
    files.push(workflow("newly-added"));
    useStore.setState({ hiddenWorkflowKeys: [], workflows: [], ready: false });
    await useStore.getState().hydrate();
    await useStore.getState().openProject(first);
    const groups = workflowVisibilityGroups(useStore.getState().workflows, useStore.getState().hiddenWorkflowKeys);
    expect(groups.hidden.map(item => item.id)).toEqual([files[0].id]);
    expect(groups.visible.some(item => item.id === "library-newly-added")).toBe(true);
    expect(records.get(WORKFLOW_VISIBILITY_RECORD)).toEqual({ version: 1, hiddenKeys: [workflowVisibilityKey(files[0])] });
  });

  it("never restores deleted directory entries from hidden preferences or a stale management row", async () => {
    const removed = files[0];
    await useStore.getState().setWorkflowHidden(removed, true);
    files = files.slice(1);
    await useStore.getState().refreshWorkflowLibrary();
    const before = records.get(WORKFLOW_VISIBILITY_RECORD);
    expect(workflowVisibilityGroups(useStore.getState().workflows, useStore.getState().hiddenWorkflowKeys).hidden).toEqual([]);
    await useStore.getState().setWorkflowHidden(removed, false);
    expect(records.get(WORKFLOW_VISIBILITY_RECORD)).toEqual(before);
    expect(findWorkflow(useStore.getState().workflows, removed.id)).toBeUndefined();
  });

  it("retains current visibility when hiding or restoring cannot be persisted", async () => {
    vi.mocked(storage.writeRecord).mockRejectedValueOnce(new Error("disk full"));
    await expect(useStore.getState().setWorkflowHidden(files[0], true)).rejects.toThrow("disk full");
    expect(useStore.getState().hiddenWorkflowKeys).toEqual([]);
    expect(useStore.getState().toast).toContain("保存失败");
    await useStore.getState().setWorkflowHidden(files[0], true);
    const before = [...useStore.getState().hiddenWorkflowKeys];
    vi.mocked(storage.writeRecord).mockRejectedValueOnce(new Error("disk full"));
    await expect(useStore.getState().setWorkflowHidden(files[0], false)).rejects.toThrow("disk full");
    expect(useStore.getState().hiddenWorkflowKeys).toEqual(before);
  });

  it("reveals the same workflow after deletion and reimport and persists the restored visibility", async () => {
    const removed = files[0];
    await useStore.getState().setWorkflowHidden(removed, true);
    files = files.slice(1);
    await useStore.getState().refreshWorkflowLibrary();
    const imported = { ...removed, library: { ...removed.library!, folder: "readable-model-name" } };
    files.push(imported);
    await useStore.getState().refreshWorkflowLibrary({ afterWrite: true, revealWorkflowId: imported.id });
    expect(workflowVisibilityGroups(useStore.getState().workflows, useStore.getState().hiddenWorkflowKeys).visible.map(item => item.id)).toContain(imported.id);
    expect(records.get(WORKFLOW_VISIBILITY_RECORD)).toEqual({ version: 1, hiddenKeys: [] });
    useStore.setState({ hiddenWorkflowKeys: [workflowVisibilityKey(removed)], ready: false });
    await useStore.getState().hydrate();
    expect(useStore.getState().hiddenWorkflowKeys).toEqual([]);
    expect(workflowVisibilityGroups(useStore.getState().workflows, useStore.getState().hiddenWorkflowKeys).hidden).toEqual([]);
  });

  it("reveals an existing hidden import by its returned original ID while retaining other hidden entries", async () => {
    const imported = files[0];
    imported.original = { id: "custom.returned-legacy-id" } as NonNullable<WorkflowDefinition["original"]>;
    useStore.setState({ workflows: structuredClone(files) });
    await useStore.getState().setWorkflowHidden(imported, true);
    await useStore.getState().setWorkflowHidden(files[1], true);
    await useStore.getState().refreshWorkflowLibrary({ afterWrite: true, revealWorkflowId: "custom.returned-legacy-id" });
    const groups = workflowVisibilityGroups(useStore.getState().workflows, useStore.getState().hiddenWorkflowKeys);
    expect(groups.visible.map(item => item.id)).toContain(imported.id);
    expect(groups.hidden.map(item => item.id)).toEqual([files[1].id]);
    expect(records.get(WORKFLOW_VISIBILITY_RECORD)).toEqual({ version: 1, hiddenKeys: [workflowVisibilityKey(files[1])] });
  });

  it("clears persisted import visibility even when this tab has no matching in-memory key", async () => {
    const imported = files[0], other = files[1], differentLibrary = workflow("one", "image", "E:/another-library");
    records.set(WORKFLOW_VISIBILITY_RECORD, { version: 1, hiddenKeys: [workflowVisibilityKey(imported), workflowVisibilityKey(other), workflowVisibilityKey(differentLibrary)] });
    useStore.setState({ hiddenWorkflowKeys: [] });
    await useStore.getState().refreshWorkflowLibrary({ afterWrite: true, revealWorkflowId: imported.id });
    expect(useStore.getState().hiddenWorkflowKeys).toEqual([workflowVisibilityKey(other), workflowVisibilityKey(differentLibrary)]);
    expect(records.get(WORKFLOW_VISIBILITY_RECORD)).toEqual({ version: 1, hiddenKeys: [workflowVisibilityKey(other), workflowVisibilityKey(differentLibrary)] });
  });

  it("does not recreate a cleared preference from stale tab memory when editing another workflow", async () => {
    const cleared = files[0], other = files[1];
    useStore.setState({ hiddenWorkflowKeys: [workflowVisibilityKey(cleared)] });
    records.set(WORKFLOW_VISIBILITY_RECORD, { version: 1, hiddenKeys: [] });
    await useStore.getState().setWorkflowHidden(other, true);
    expect(useStore.getState().hiddenWorkflowKeys).toEqual([workflowVisibilityKey(other)]);
    expect(records.get(WORKFLOW_VISIBILITY_RECORD)).toEqual({ version: 1, hiddenKeys: [workflowVisibilityKey(other)] });
  });

  it("preserves intentional hiding on ordinary scans and restores an import on scan retry", async () => {
    const imported = files[0];
    await useStore.getState().setWorkflowHidden(imported, true);
    await useStore.getState().refreshWorkflowLibrary();
    expect(useStore.getState().hiddenWorkflowKeys).toEqual([workflowVisibilityKey(imported)]);
    vi.mocked(readWorkflowLibrary).mockRejectedValueOnce(new Error("temporary scan failure"));
    await useStore.getState().refreshWorkflowLibrary({ afterWrite: true, revealWorkflowId: imported.id });
    expect(useStore.getState().libraryError).toContain("temporary scan failure");
    expect(useStore.getState().hiddenWorkflowKeys).toEqual([workflowVisibilityKey(imported)]);
    await useStore.getState().refreshWorkflowLibrary({ afterWrite: true, revealWorkflowId: imported.id });
    expect(useStore.getState().libraryState).toBe("loaded");
    expect(useStore.getState().hiddenWorkflowKeys).toEqual([]);
  });

  it("restores both imports when they share a directory refresh", async () => {
    await useStore.getState().setWorkflowHidden(files[0], true);
    await useStore.getState().setWorkflowHidden(files[1], true);
    let finish!: () => void;
    vi.mocked(readWorkflowLibrary).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return snapshot();
    });
    const first = useStore.getState().refreshWorkflowLibrary({ revealWorkflowId: files[0].id });
    const second = useStore.getState().refreshWorkflowLibrary({ revealWorkflowId: files[1].id });
    finish();
    await Promise.all([first, second]);
    expect(readWorkflowLibrary).toHaveBeenCalledTimes(1);
    expect(useStore.getState().hiddenWorkflowKeys).toEqual([]);
    expect(records.get(WORKFLOW_VISIBILITY_RECORD)).toEqual({ version: 1, hiddenKeys: [] });
  });

  it("clears a deleted snapshot's preference after a concurrent rescan so reimport is visible", async () => {
    const removed = files[0];
    await useStore.getState().setWorkflowHidden(removed, true);
    files = files.slice(1);
    await useStore.getState().refreshWorkflowLibrary();
    expect(findWorkflow(useStore.getState().workflows, removed.id)).toBeUndefined();
    await useStore.getState().forgetWorkflowVisibility(removed);
    expect(useStore.getState().hiddenWorkflowKeys).toEqual([]);
    expect(records.get(WORKFLOW_VISIBILITY_RECORD)).toEqual({ version: 1, hiddenKeys: [] });
    expect(findWorkflow(useStore.getState().workflows, removed.id)).toBeUndefined();
    files.push(removed);
    await useStore.getState().refreshWorkflowLibrary();
    expect(workflowVisibilityGroups(useStore.getState().workflows, useStore.getState().hiddenWorkflowKeys).visible.map(item => item.id)).toContain(removed.id);
  });

  it("serializes hide and restore writes so a delayed first write cannot overwrite the final preference", async () => {
    let release!: () => void;
    vi.mocked(storage.writeRecord).mockImplementationOnce(async (key, value) => {
      await new Promise<void>(resolve => { release = resolve; }); records.set(key, structuredClone(value));
    });
    const hiding = useStore.getState().setWorkflowHidden(files[0], true);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const restoring = useStore.getState().setWorkflowHidden(files[0], false);
    expect(useStore.getState().hiddenWorkflowKeys).toEqual([]);
    release(); await Promise.all([hiding, restoring]);
    expect(useStore.getState().hiddenWorkflowKeys).toEqual([]);
    expect(records.get(WORKFLOW_VISIBILITY_RECORD)).toEqual({ version: 1, hiddenKeys: [] });
    expect(storage.writeRecord).toHaveBeenCalledTimes(2);
  });

  it("ignores malformed saved preferences and deduplicates valid records", () => {
    expect(readHiddenWorkflowKeys({ version: 2, hiddenKeys: ["x"] })).toEqual([]);
    expect(readHiddenWorkflowKeys({ version: 1, hiddenKeys: "x" })).toEqual([]);
    expect(readHiddenWorkflowKeys({ version: 1, hiddenKeys: ["x", "x", null, "", 3] })).toEqual(["x"]);
  });
});
