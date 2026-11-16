import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, Project } from "../src/types";

const records = vi.hoisted(() => new Map<string, unknown>());
const blobs = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(records.get(key)),
  writeRecord: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
  safeConnection: (value: object) => value, getBlob: blobs.get, putBlob: blobs.put,
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));
import { useStore } from "../src/stores/store";
import { defaultConnection } from "../src/workflow/catalog";
import { libraryAssetAspectRatio, libraryAssetNameParts, libraryAssetRenamedName, rememberLibraryAssetDimensions, renameLibraryAsset } from "../src/assets/library-details";

const asset: Asset = { id: "original", name: "source.PNG", kind: "image", mime: "image/png", size: 123, createdAt: 1, inLibrary: true };
function project(): Project {
  return { version: 2, id: "p", name: "素材命名", activeCanvasId: "c", scenes: [{ id: "s", name: "场景" }],
    canvases: [{ id: "c", name: "画布", sceneId: "s", nodes: [
      { id: "reference", type: "media", position: { x: 20, y: 30 }, style: { width: 240, height: 180 }, data: { kind: "reference", title: "用户的节点名称", assetId: asset.id } },
      { id: "target", type: "media", position: { x: 400, y: 30 }, data: { kind: "video", title: "视频 1", generation: { prompt: "保留原文", negativePrompt: "", workflowId: "w", params: { seed: 7 }, taskId: null } } },
    ], edges: [{ id: "edge", source: "reference", target: "target", data: { role: "firstFrame", order: 1 } }], viewport: { x: 0, y: 0, zoom: 1 } }],
    assets: { [asset.id]: { ...asset }, other: { ...asset, id: "other", name: "other.png" } }, tasks: {}, history: [], updatedAt: 1 };
}
beforeEach(() => {
  records.clear(); vi.clearAllMocks();
  useStore.setState({ project: project(), projects: {}, projectOpen: true, navigating: false, ready: false, workflows: [],
    past: [], future: [], selectedId: null, selectedEdgeId: null, connection: defaultConnection });
});

describe("library asset names", () => {
  it("edits a human title while keeping the original format suffix and casing", () => {
    expect(libraryAssetNameParts({ name: "my.photo.PNG", mime: "image/png" })).toEqual({ title: "my.photo", extension: ".PNG" });
    expect(libraryAssetRenamedName(asset, "  人物正面  ")).toBe("人物正面.PNG");
    expect(libraryAssetRenamedName(asset, "人物正面.png")).toBe("人物正面.PNG");
    expect(libraryAssetRenamedName({ name: "model.safetensors", mime: "application/octet-stream" }, "自定义模型")).toBe("自定义模型.safetensors");
  });
  it("uses the recorded MIME type when a legacy filename has no extension", () => {
    expect(libraryAssetNameParts({ name: "角色参考", mime: "image/webp" })).toEqual({ title: "角色参考", extension: ".webp" });
    expect(libraryAssetRenamedName({ name: "语音", mime: "audio/wav" }, "开场对白")).toBe("开场对白.wav");
  });
  it.each(["", "   ", ".PNG"])("rejects an empty title without dirtying the project: %j", draft => {
    const before = useStore.getState().project;
    expect(() => renameLibraryAsset("p", asset.id, draft)).toThrow("不能为空");
    expect(useStore.getState().project).toBe(before);
  });
  it.each(["folder/name", "C:\\name", "line\nname", "name?", "name.", "CON"])("rejects invalid filenames: %j", draft => {
    expect(() => libraryAssetRenamedName(asset, draft)).toThrow();
  });
  it("renames and persists only asset metadata, keeping blob identity and every canvas association", async () => {
    const before = useStore.getState().project;
    expect(renameLibraryAsset("p", asset.id, "我的人物素材", asset.name)).toBe("我的人物素材.PNG");
    const after = useStore.getState().project;
    expect(after.assets.original).toEqual({ ...asset, name: "我的人物素材.PNG" });
    expect(after.assets.other).toBe(before.assets.other);
    expect(after.canvases).toBe(before.canvases); expect(after.tasks).toBe(before.tasks); expect(after.history).toBe(before.history);
    expect(after.canvases[0].nodes[0].data).toEqual(before.canvases[0].nodes[0].data);
    expect(after.canvases[0].edges).toEqual(before.canvases[0].edges);
    expect(blobs.get).not.toHaveBeenCalled(); expect(blobs.put).not.toHaveBeenCalled();
    await useStore.getState().save(true);
    const saved = records.get("project-library") as Record<string, { project: Project }>;
    expect(saved.p.project.assets.original).toEqual(after.assets.original);
    expect(saved.p.project.canvases[0].nodes[0].data.assetId).toBe(asset.id);
    expect(saved.p.project.assets.original.mime).toBe("image/png");
  });
  it("does not write a stale editor into another project, a removed asset, or a concurrently renamed asset", () => {
    const before = useStore.getState().project;
    expect(() => renameLibraryAsset("another-project", asset.id, "新名称")).toThrow("项目已切换");
    expect(() => renameLibraryAsset("p", "removed", "新名称")).toThrow("不存在");
    expect(() => renameLibraryAsset("p", asset.id, "新名称", "stale.png")).toThrow("已更新");
    expect(useStore.getState().project).toBe(before);
    useStore.setState({ projectOpen: false });
    expect(() => renameLibraryAsset("p", asset.id, "新名称")).toThrow("项目已切换");
  });
});

describe("library preview ratios", () => {
  it("uses landscape, portrait and extreme ratios without forcing a fixed-height contain box", () => {
    expect(libraryAssetAspectRatio({ kind: "image", width: 1920, height: 1080 })).toBe("1920 / 1080");
    expect(libraryAssetAspectRatio({ kind: "video", width: 1080, height: 1920 })).toBe("1080 / 1920");
    expect(libraryAssetAspectRatio({ kind: "image", width: 10000, height: 100 })).toBe("10000 / 100");
    expect(libraryAssetAspectRatio({ kind: "image" })).toBeUndefined();
    expect(libraryAssetAspectRatio({ kind: "audio", width: 100, height: 100 })).toBeUndefined();
  });
  it("records actual loaded dimensions and persists them without resizing user canvas frames", async () => {
    const before = useStore.getState().project;
    rememberLibraryAssetDimensions("p", asset.id, 900, 1600);
    const after = useStore.getState().project;
    expect(libraryAssetAspectRatio(after.assets.original)).toBe("900 / 1600");
    expect(after.assets.original).toEqual({ ...asset, width: 900, height: 1600 });
    expect(after.canvases).toBe(before.canvases);
    expect(after.assets.other).toBe(before.assets.other);
    rememberLibraryAssetDimensions("p", asset.id, 900, 1600);
    expect(useStore.getState().project).toBe(after);
    await useStore.getState().save(true);
    const saved = records.get("project-library") as Record<string, { project: Project }>;
    expect(saved.p.project.assets.original).toMatchObject({ width: 900, height: 1600 });
    expect(saved.p.project.canvases[0].nodes[0].style).toEqual({ width: 240, height: 180 });
  });
  it("ignores invalid, stale or nonvisual dimension reports", () => {
    const before = useStore.getState().project;
    for (const [width, height] of [[0, 100], [100, Infinity], [12.5, 100], [NaN, 100]]) rememberLibraryAssetDimensions("p", asset.id, width, height);
    rememberLibraryAssetDimensions("other", asset.id, 100, 100);
    rememberLibraryAssetDimensions("p", "removed", 100, 100);
    expect(useStore.getState().project).toBe(before);
    const audio = { ...asset, kind: "audio" as const, mime: "audio/wav" };
    useStore.setState({ project: { ...before, assets: { ...before.assets, [asset.id]: audio } } });
    const nonvisual = useStore.getState().project;
    rememberLibraryAssetDimensions("p", asset.id, 100, 100);
    expect(useStore.getState().project).toBe(nonvisual);
  });
});
