import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, GenerationTask, Project, WorkflowDefinition } from "../src/types";

const records = vi.hoisted(() => new Map<string, unknown>());
const blobs = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), remove: vi.fn() }));
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(records.get(key)),
  writeRecord: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
  safeConnection: (value: object) => value, getBlob: blobs.get, putBlob: blobs.put, deleteBlob: blobs.remove,
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));

import { useStore } from "../src/stores/store";
import { defaultConnection } from "../src/workflow/catalog";
import { migrateProject } from "../src/projects/migrate";
import { isAssetInLibrary, libraryAssets } from "../src/assets/library-membership";
import { normalizeLibraryCategory, removeLibraryAsset, saveLibraryAsset } from "../src/assets/library-entry";

const workflow: WorkflowDefinition = { id: "w", name: "图像工作流", family: "Test", description: "", mode: "text-to-image", requiredInputs: [], optionalInputs: [], parameters: [], mapping: [], output: { nodeId: "out", field: "images", kind: "image" } };
function asset(id: string, patch: Partial<Asset> = {}): Asset {
  return { id, name: "source.PNG", kind: "image", mime: "image/png", size: 123, createdAt: 1, ...patch };
}
function project(): Project {
  const generated = asset("generated", { name: "generated.JPG", mime: "image/jpeg", width: 1920, height: 1080 });
  const { token: _token, ...connection } = defaultConnection;
  const task: GenerationTask = { taskId: "task", promptId: "remote", executorType: "comfyui", requestId: "request", clientId: "client", canvasId: "c", nodeId: "target", nodeTitle: "图像 1", createdAt: 1, updatedAt: 2, completedAt: 2, status: "completed", workflow, connection,
    input: { prompt: "保留的生成提示词", negativePrompt: "保留负向限制", params: { seed: 17 }, assets: [{ semantic: "firstFrame", asset: asset("imported"), edgeId: "edge", order: 1 }] }, outputs: [generated.id],
    downloadedOutputs: [{ file: { filename: "remote-generated.JPG", type: "output" }, asset: { ...generated } }],
  };
  return { version: 2, id: "p", name: "资产库条目", activeCanvasId: "c", scenes: [{ id: "s", name: "场景" }], updatedAt: 1,
    canvases: [{ id: "c", name: "画布", sceneId: "s", nodes: [
      { id: "reference", type: "media", position: { x: 20, y: 30 }, style: { width: 240, height: 180 }, data: { kind: "reference", title: "用户的参考节点", assetId: "imported" } },
      { id: "target", type: "media", position: { x: 400, y: 30 }, data: { kind: "image-generation", title: "图像 1", assetId: generated.id, generation: { prompt: "保留的生成提示词", negativePrompt: "保留负向限制", workflowId: workflow.id, params: { seed: 17 }, taskId: task.taskId } } },
    ], edges: [{ id: "edge", source: "reference", target: "target", data: { role: "firstFrame", order: 1 } }], viewport: { x: 0, y: 0, zoom: 1 } }],
    assets: { imported: asset("imported"), generated, existing: asset("existing", { inLibrary: true, libraryCategory: "原分类" }), other: asset("other", { name: "other.png" }) },
    tasks: { [task.taskId]: task }, history: [{ id: "history", canvasId: "c", nodeId: "target", nodeTitle: "图像 1", workflowId: workflow.id, prompt: task.input.prompt, negativePrompt: task.input.negativePrompt, params: { seed: 17 }, inputs: [{ assetId: "imported", role: "firstFrame" }], outputs: [generated.id], promptId: "remote", createdAt: 2 }],
  };
}
const snapshot = (asset: Asset) => ({ name: asset.name, libraryCategory: asset.libraryCategory, inLibrary: asset.inLibrary });
beforeEach(() => {
  records.clear(); vi.clearAllMocks();
  useStore.setState({ project: project(), projects: {}, projectOpen: true, navigating: false, ready: false, workflows: [workflow],
    past: [], future: [], selectedId: "target", selectedEdgeId: null, connection: defaultConnection, saveState: "已保存到本机" });
});

describe("library category normalization", () => {
  it("normalizes Unicode and internal spaces without treating category text as a file path", () => {
    expect(normalizeLibraryCategory("  人物   主角  ")).toBe("人物 主角");
    expect(normalizeLibraryCategory("　场景　  夜景　")).toBe("场景 夜景");
    expect(normalizeLibraryCategory(" 🎨 角色 / 场景 ")).toBe("🎨 角色 / 场景");
    expect(normalizeLibraryCategory("  ")).toBe("");
    expect(normalizeLibraryCategory("")).toBe("");
    expect(normalizeLibraryCategory("人".repeat(50))).toBe("人".repeat(50));
  });
  it.each(["人物\n参考", "人物\r参考", "人物\t参考", "人物\u0000参考", "人物\u001f参考", "人物\u007f参考", "\n人物", "人物\t"])("rejects controls before trimming/collapsing: %j", value => {
    expect(() => normalizeLibraryCategory(value)).toThrow();
  });
  it("rejects a normalized category above the limit instead of silently truncating it", () => {
    expect(() => normalizeLibraryCategory("人".repeat(51))).toThrow();
    expect(normalizeLibraryCategory("  " + "人".repeat(50) + "  ")).toBe("人".repeat(50));
  });
});

describe("atomic library entry saving", () => {
  it("publishes name, category and membership in one project mutation while protecting the original suffix", () => {
    const before = useStore.getState().project, observed: Asset[] = [];
    const unsubscribe = useStore.subscribe((next, previous) => { if (next.project !== previous.project) observed.push(structuredClone(next.project.assets.generated)); });
    try { saveLibraryAsset("p", "generated", "  人物正面.jpg ", "  人物   主角  ", snapshot(before.assets.generated)); }
    finally { unsubscribe(); }
    const after = useStore.getState().project;
    expect(observed).toEqual([{ ...before.assets.generated, name: "人物正面.JPG", libraryCategory: "人物 主角", inLibrary: true }]);
    expect(after.assets.generated).toEqual(observed[0]);
    expect(isAssetInLibrary(after.assets.generated, after)).toBe(true);
    expect(after.assets.other).toBe(before.assets.other);
    expect(after.canvases).toBe(before.canvases); expect(after.tasks).toBe(before.tasks); expect(after.history).toBe(before.history);
    expect(after.canvases[0].nodes[1].data.generation).toEqual(before.canvases[0].nodes[1].data.generation);
    expect(blobs.get).not.toHaveBeenCalled(); expect(blobs.put).not.toHaveBeenCalled(); expect(blobs.remove).not.toHaveBeenCalled();
  });
  it("removes the category property when cleared rather than persisting an empty/undefined category", () => {
    const before = useStore.getState().project.assets.existing;
    saveLibraryAsset("p", before.id, "我的素材", "   ", snapshot(before));
    expect(useStore.getState().project.assets.existing).toMatchObject({ name: "我的素材.PNG", inLibrary: true });
    expect(useStore.getState().project.assets.existing).not.toHaveProperty("libraryCategory");
  });
  it.each(["", undefined])("cleans a legacy blank category property even when other metadata is unchanged: %j", libraryCategory => {
    const state = useStore.getState(), existing = { ...state.project.assets.existing, libraryCategory };
    useStore.setState({ project: { ...state.project, assets: { ...state.project.assets, existing } } });
    expect(useStore.getState().project.assets.existing).toHaveProperty("libraryCategory");
    saveLibraryAsset("p", "existing", existing.name, "", snapshot(existing));
    expect(useStore.getState().project.assets.existing).toMatchObject({ name: existing.name, inLibrary: true });
    expect(useStore.getState().project.assets.existing).not.toHaveProperty("libraryCategory");
  });
  it.each([
    ["", "新分类"], ["folder/name", "新分类"], ["CON", "新分类"],
    ["有效新名称", "不合法\n分类"], ["有效新名称", "不合法\t分类"], ["有效新名称", "人".repeat(51)],
  ])("rejects invalid fields atomically: name=%j category=%j", (name, category) => {
    const before = useStore.getState().project, notified = vi.fn(), unsubscribe = useStore.subscribe(notified);
    try { expect(() => saveLibraryAsset("p", "generated", name, category)).toThrow(); }
    finally { unsubscribe(); }
    expect(useStore.getState().project).toBe(before); expect(notified).not.toHaveBeenCalled();
    expect(useStore.getState().project.assets.generated).not.toHaveProperty("inLibrary");
    expect(useStore.getState().saveState).toBe("已保存到本机");
  });
  it.each([
    { name: "stale.PNG", libraryCategory: "原分类", inLibrary: true },
    { name: "source.PNG", libraryCategory: "旧分类", inLibrary: true },
    { name: "source.PNG", libraryCategory: "原分类", inLibrary: false },
    { name: "source.PNG", libraryCategory: "原分类", inLibrary: undefined },
  ])("rejects a concurrent metadata/membership change against the raw editor snapshot: %j", expected => {
    const before = useStore.getState().project;
    expect(() => saveLibraryAsset("p", "existing", "新的名称", "新分类", expected)).toThrow();
    expect(useStore.getState().project).toBe(before);
  });
  it.each([
    { name: "source.PNG", libraryCategory: "", inLibrary: undefined },
    { name: "source.PNG", libraryCategory: undefined, inLibrary: false },
    { name: "source.PNG", libraryCategory: undefined, inLibrary: true },
  ])("keeps undefined membership/category distinct from explicit values: %j", expected => {
    const before = useStore.getState().project;
    expect(() => saveLibraryAsset("p", "imported", "新的名称", "分类", expected)).toThrow();
    expect(useStore.getState().project).toBe(before);
  });
  it("allows preview dimensions to arrive after opening the editor without losing them", () => {
    const state = useStore.getState(), expected = snapshot(state.project.assets.imported);
    useStore.setState({ project: { ...state.project, assets: { ...state.project.assets, imported: { ...state.project.assets.imported, width: 800, height: 1200 } } } });
    saveLibraryAsset("p", "imported", "人物参考", "角色", expected);
    expect(useStore.getState().project.assets.imported).toMatchObject({ name: "人物参考.PNG", width: 800, height: 1200, libraryCategory: "角色", inLibrary: true });
  });
});

describe("library membership removal", () => {
  it.each(["imported", "generated", "existing"])("hides %s by writing membership false without deleting its asset, references or metadata", id => {
    const before = useStore.getState().project, notifications = vi.fn(), unsubscribe = useStore.subscribe(notifications);
    try { removeLibraryAsset("p", id); } finally { unsubscribe(); }
    const after = useStore.getState().project;
    expect(after.assets[id]).toEqual({ ...before.assets[id], inLibrary: false });
    expect(notifications).toHaveBeenCalledTimes(1);
    expect(after.assets.other).toBe(before.assets.other);
    expect(Object.keys(after.assets)).toEqual(Object.keys(before.assets));
    expect(after.canvases).toBe(before.canvases); expect(after.tasks).toBe(before.tasks); expect(after.history).toBe(before.history);
    expect(libraryAssets(after).some(asset => asset.id === id)).toBe(false);
    expect(blobs.get).not.toHaveBeenCalled(); expect(blobs.put).not.toHaveBeenCalled(); expect(blobs.remove).not.toHaveBeenCalled();
  });
  it("is idempotent once explicitly removed", () => {
    removeLibraryAsset("p", "imported"); const after = useStore.getState().project;
    removeLibraryAsset("p", "imported");
    expect(useStore.getState().project).toBe(after);
  });
  it("prevents a removed imported item from reappearing after legacy generated history changes", () => {
    const state = useStore.getState();
    expect(isAssetInLibrary(state.project.assets.imported, state.project)).toBe(true);
    expect(isAssetInLibrary(state.project.assets.generated, state.project)).toBe(false);
    removeLibraryAsset("p", "imported"); removeLibraryAsset("p", "generated");
    const after = useStore.getState().project;
    expect(isAssetInLibrary(after.assets.imported, { tasks: {}, history: [] })).toBe(false);
    expect(isAssetInLibrary(after.assets.generated, { tasks: {}, history: [] })).toBe(false);
  });
});

describe("entry scope and persistence", () => {
  it.each(["save", "remove"] as const)("guards stale project identity, closed/navigating scope and missing assets during %s", operation => {
    const invoke = (projectId = "p", assetId = "imported") => operation === "save" ? saveLibraryAsset(projectId, assetId, "新名称", "分类") : removeLibraryAsset(projectId, assetId);
    const before = useStore.getState().project;
    expect(() => invoke("another-project")).toThrow(); expect(useStore.getState().project).toBe(before);
    expect(() => invoke("p", "removed")).toThrow(); expect(useStore.getState().project).toBe(before);
    useStore.setState({ projectOpen: false });
    expect(() => invoke()).toThrow(); expect(useStore.getState().project).toBe(before);
    useStore.setState({ projectOpen: true, navigating: true });
    expect(() => invoke()).toThrow(); expect(useStore.getState().project).toBe(before);
  });
  it("persists save/remove/re-add through project storage and migration while retaining file and graph identity", async () => {
    const original = structuredClone(useStore.getState().project);
    saveLibraryAsset("p", "generated", "生成的人物", " 人物  参考 ", snapshot(original.assets.generated));
    await useStore.getState().save(true);
    let saved = (records.get("project-library") as Record<string, { project: Project }>).p.project;
    let restored = migrateProject(saved, [workflow], defaultConnection);
    expect(restored.assets.generated).toMatchObject({ id: "generated", name: "生成的人物.JPG", libraryCategory: "人物 参考", inLibrary: true, mime: "image/jpeg", size: 123 });
    expect(isAssetInLibrary(restored.assets.generated, restored)).toBe(true);
    expect(restored.canvases).toEqual(original.canvases); expect(restored.tasks).toEqual(original.tasks); expect(restored.history).toEqual(original.history);
    useStore.setState({ project: restored });
    removeLibraryAsset("p", "generated");
    await useStore.getState().save(true);
    saved = (records.get("project-library") as Record<string, { project: Project }>).p.project;
    restored = migrateProject(saved, [workflow], defaultConnection);
    expect(restored.assets.generated).toMatchObject({ name: "生成的人物.JPG", libraryCategory: "人物 参考", inLibrary: false });
    expect(libraryAssets(restored).some(asset => asset.id === "generated")).toBe(false);
    useStore.setState({ project: restored });
    saveLibraryAsset("p", "generated", "生成的人物.jpg", "", snapshot(restored.assets.generated));
    await useStore.getState().save(true);
    saved = (records.get("project-library") as Record<string, { project: Project }>).p.project;
    restored = migrateProject(saved, [workflow], defaultConnection);
    expect(restored.assets.generated).toMatchObject({ name: "生成的人物.JPG", inLibrary: true });
    expect(restored.assets.generated).not.toHaveProperty("libraryCategory");
    expect(restored.canvases[0].nodes[1].data.assetId).toBe("generated");
    expect(restored.tasks.task.downloadedOutputs?.[0].asset.id).toBe("generated");
    expect(restored.history[0].outputs).toEqual(["generated"]);
    expect(isAssetInLibrary(restored.assets.generated, restored)).toBe(true);
    expect(blobs.get).not.toHaveBeenCalled(); expect(blobs.put).not.toHaveBeenCalled(); expect(blobs.remove).not.toHaveBeenCalled();
  });
});
