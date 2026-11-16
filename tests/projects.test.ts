import { beforeEach, describe, expect, it, vi } from "vitest";
const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(records.get(key)),
  writeRecord: vi.fn(async (key: string, value: unknown) => {
    records.set(key, structuredClone(value));
  }),
  safeConnection: (value: object) => ({ ...value, token: "" }),
}));
vi.mock("../src/workflow/library-client", () => ({
  readWorkflowLibrary: vi.fn(async () => {
    throw new Error("本地目录未配置");
  }),
}));
import { useStore, type ProjectLibrary } from "../src/stores/store";
import { writeRecord } from "../src/projects/storage";
import { readWorkflowLibrary } from "../src/workflow/library-client";
import { catalog, defaultConnection } from "../src/workflow/catalog";
import { migrateProject } from "../src/projects/migrate";
import { taskConnectionSnapshot } from "../src/projects/connection-snapshot";
import type { Project } from "../src/types";

function recoveryFixture(): Project {
  return {
    version: 2, id: "restore-project", name: "恢复项目", updatedAt: 1,
    activeCanvasId: "canvas-two", scenes: [{ id: "existing-scene", name: "原有场景" }],
    canvases: [
      { id: "canvas-one", name: "画布 1", sceneId: "existing-scene", viewport: { x: 12, y: 23, zoom: 0.8 },
        nodes: [
          { id: "reference", type: "media", position: { x: 10, y: 20 }, data: { kind: "reference", title: "参考 1", assetId: "image" } },
          { id: "result", type: "media", position: { x: 400, y: 20 }, data: { kind: "reference", title: "参考 2", assetId: "image" } },
        ], edges: [{ id: "edge", source: "reference", target: "result", data: { role: "auto", order: 1 } }] },
      { id: "canvas-two", name: "画布 2", sceneId: "existing-scene", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
    ],
    assets: { image: { id: "image", name: "saved.png", kind: "image", mime: "image/png", size: 10, createdAt: 1 } },
    tasks: { receipt: { taskId: "receipt", promptId: "remote-id", executorType: "comfyui", requestId: "request", clientId: "client",
      canvasId: "canvas-one", nodeId: "result", nodeTitle: "参考 2", status: "completed", createdAt: 1, updatedAt: 2,
      connection: taskConnectionSnapshot(defaultConnection), workflow: structuredClone(catalog[0]),
      input: { prompt: "保留提示词", negativePrompt: "", params: {}, assets: [] }, outputs: ["image"] } },
    history: [{ id: "history", canvasId: "canvas-one", nodeId: "result", nodeTitle: "参考 2", workflowId: catalog[0].id,
      prompt: "保留提示词", negativePrompt: "", params: {}, inputs: [{ assetId: "image", role: "image" }], outputs: ["image"], promptId: "remote-id", createdAt: 2 }],
  };
}

beforeEach(() => {
  records.clear();
  vi.mocked(writeRecord).mockClear();
  const session = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => session.set(key, value),
    removeItem: (key: string) => session.delete(key),
  });
  useStore.setState({
    projects: {},
    projectOpen: false,
    navigating: false,
    ready: false,
    workflows: catalog,
    workflowLibrary: undefined,
    libraryState: "idle",
    libraryError: "",
  });
});

describe("project library", () => {
  it.each(["missing-canvas", ""])("repairs stale active canvas %s without changing saved content", activeCanvasId => {
    const raw = { ...recoveryFixture(), activeCanvasId };
    const before = structuredClone(raw);
    const restored = migrateProject(raw);
    expect(restored.activeCanvasId).toBe("canvas-one");
    expect(restored).toEqual({ ...before, activeCanvasId: "canvas-one" });
    expect(raw).toEqual(before);
    expect(migrateProject(restored)).toEqual(restored);
  });

  it("retains an existing active canvas and every saved graph", () => {
    const raw = recoveryFixture();
    expect(migrateProject(raw)).toEqual(raw);
  });

  it.each(["existing", "empty", "missing", "invalid"])("restores an empty canvas list with %s scenes while retaining receipts and assets", sceneState => {
    const raw = { ...recoveryFixture(), canvases: [] };
    if (sceneState === "empty") raw.scenes = [];
    if (sceneState === "missing") delete (raw as Partial<Project>).scenes;
    if (sceneState === "invalid") raw.scenes = [{ id: "", name: "未完整保存的场景" }];
    const before = structuredClone(raw);
    const restored = migrateProject(raw);
    const canvas = restored.canvases[0];
    expect(restored.canvases).toHaveLength(1);
    expect(restored.activeCanvasId).toBe(canvas.id);
    expect(canvas).toEqual({ id: expect.any(String), name: "画布 1", sceneId: sceneState === "existing" ? "existing-scene" : "scene-1",
      nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
    expect(restored.scenes.filter(scene => scene.id === canvas.sceneId)).toHaveLength(1);
    if (sceneState === "existing" || sceneState === "invalid") expect(restored.scenes).toEqual(expect.arrayContaining(before.scenes));
    expect(restored.assets).toEqual(before.assets);
    expect(restored.history).toEqual(before.history);
    expect(restored.tasks).toEqual(before.tasks);
    expect(raw).toEqual(before);
    expect(migrateProject(restored)).toEqual(restored);
  });

  it("hydrates a saved project whose active canvas was removed", async () => {
    const project = { ...recoveryFixture(), activeCanvasId: "removed-canvas" };
    records.set("project-library", { [project.id]: { project, workflows: [] } });
    sessionStorage.setItem("clearframe-open-project", project.id);
    await useStore.getState().hydrate();
    const restored = useStore.getState();
    expect(restored.ready).toBe(true);
    expect(restored.projectOpen).toBe(true);
    expect(restored.project.activeCanvasId).toBe("canvas-one");
    expect(restored.project.canvases.find(canvas => canvas.id === restored.project.activeCanvasId)).toBeDefined();
    expect(restored.project.canvases[0].edges).toEqual(project.canvases[0].edges);
    expect(restored.project.assets).toEqual(project.assets);
    expect(restored.project.history).toEqual(project.history);
  });

  it("deletes permanently and rejects stale saves from another tab", async () => {
    await useStore.getState().newProject("待删除项目");
    const node = useStore.getState().addNode("text");
    useStore.getState().patchNode(node, { text: "待删除内容" });
    const id = useStore.getState().project.id;
    await useStore.getState().leaveProject();
    await useStore.getState().deleteProject(id);
    expect(useStore.getState().projects[id].deletedAt).toBeGreaterThan(0);
    expect(useStore.getState().projects[id].project).toBeUndefined();
    await expect(useStore.getState().openProject(id)).rejects.toThrow("已删除");
    await expect(useStore.getState().save(true)).rejects.toThrow("已删除");
    await useStore.getState().hydrate();
    expect(useStore.getState().projects[id].deletedAt).toBeGreaterThan(0);
    expect(useStore.getState().projects[id].project).toBeUndefined();
    await expect(useStore.getState().openProject(id)).rejects.toThrow("已删除");
  });
  it("retains a project in the list if the deletion cannot be saved", async () => {
    await useStore.getState().newProject("删除失败时保留");
    const id = useStore.getState().project.id;
    await useStore.getState().leaveProject();
    vi.mocked(writeRecord).mockRejectedValueOnce(new Error("disk full"));
    await expect(useStore.getState().deleteProject(id)).rejects.toThrow(
      "disk full",
    );
    expect(useStore.getState().projects[id].project?.name).toBe("删除失败时保留");
    expect(useStore.getState().navigating).toBe(false);
  });
  it("merges the latest saved library so another tab's project is retained", async () => {
    await useStore.getState().newProject("当前项目");
    const current = useStore.getState().project;
    const library = records.get("project-library") as ProjectLibrary;
    library.external = {
      project: {
        ...structuredClone(current),
        id: "external",
        name: "另一页面的项目",
      },
      workflows: catalog,
    };
    records.set("project-library", library);
    useStore.getState().editProject((p) => ({ ...p, name: "更新当前项目" }));
    await useStore.getState().save(true);
    const saved = records.get("project-library") as ProjectLibrary;
    expect(saved.external.project.name).toBe("另一页面的项目");
    expect(saved[current.id].project.name).toBe("更新当前项目");
  });
  it("keeps separate canvases and workflow settings across create, exit, reopen and hydrate", async () => {
    await useStore.getState().newProject("项目 A");
    const a = useStore.getState().project.id;
    const node = useStore.getState().addNode("text");
    useStore.getState().patchNode(node, { text: "A 的内容" });
    const workflows = [{ ...catalog[0], id: "custom-project-a", name: "A 专用能力" }];
    useStore.setState({ workflows });
    await useStore.getState().leaveProject();
    expect(useStore.getState().projectOpen).toBe(false);
    expect(sessionStorage.getItem("clearframe-open-project")).toBeNull();
    await useStore.getState().newProject("项目 B");
    const b = useStore.getState().project.id;
    expect(a).not.toBe(b);
    expect(useStore.getState().project.canvases[0].nodes).toHaveLength(0);
    await useStore.getState().leaveProject();
    await useStore.getState().openProject(a);
    expect(useStore.getState().project.canvases[0].nodes[0].data.text).toBe(
      "A 的内容",
    );
    expect(useStore.getState().workflows.find(w => w.id === "custom-project-a")).toEqual(workflows[0]);
    expect(useStore.getState().workflows.find(w => w.id === catalog[0].id)).toBeUndefined();
    useStore.setState({ projects: {}, projectOpen: false, ready: false });
    await useStore.getState().hydrate();
    expect(useStore.getState().project.id).toBe(a);
    expect(useStore.getState().projectOpen).toBe(true);
    expect(useStore.getState().workflows.find(w => w.id === "custom-project-a")).toEqual(workflows[0]);
    expect(useStore.getState().workflows.find(w => w.id === catalog[0].id)).toBeUndefined();
    const saved = records.get("project-library") as ProjectLibrary;
    expect(Object.keys(saved)).toHaveLength(2);
    expect(saved[b].project.canvases[0].nodes).toHaveLength(0);
  });

  it("opens the canvas when the local workflow scan is slow", async () => {
    let finishScan!: (snapshot: { sourcePath: string; loadedAt: number; workflows: never[]; scanned: number; issues: never[] }) => void;
    vi.mocked(readWorkflowLibrary).mockImplementationOnce(() => new Promise((resolve) => {
      finishScan = resolve;
    }));
    vi.useFakeTimers();
    try {
      const hydration = useStore.getState().hydrate();
      await vi.advanceTimersByTimeAsync(2500);
      await hydration;
      expect(useStore.getState().ready).toBe(true);
      finishScan({ sourcePath: "", loadedAt: Date.now(), workflows: [], scanned: 0, issues: [] });
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("imports the previous single project once and never restores its stale copy over newer edits", async () => {
    await useStore.getState().newProject("旧项目");
    const old = structuredClone(useStore.getState().project);
    records.clear();
    records.set("project", old);
    sessionStorage.removeItem("clearframe-open-project");
    useStore.setState({ projects: {}, projectOpen: false });
    await useStore.getState().hydrate();
    expect(useStore.getState().projectOpen).toBe(false);
    expect(Object.keys(useStore.getState().projects)).toEqual([old.id]);
    await useStore.getState().openProject(old.id);
    useStore.getState().editProject((p) => ({ ...p, name: "更新后的名称" }));
    await useStore.getState().leaveProject();
    await useStore.getState().hydrate();
    expect(useStore.getState().projects[old.id].project.name).toBe(
      "更新后的名称",
    );
    expect(useStore.getState().projectOpen).toBe(false);
  });

  it("keeps the active project and unsaved edits when saving before exit or switching fails", async () => {
    await useStore.getState().newProject("保留我");
    const id = useStore.getState().project.id;
    useStore.getState().editProject((p) => ({ ...p, name: "尚未保存的修改" }));
    vi.mocked(writeRecord).mockRejectedValueOnce(new Error("disk full"));
    await expect(useStore.getState().leaveProject()).rejects.toThrow(
      "disk full",
    );
    expect(useStore.getState().projectOpen).toBe(true);
    expect(useStore.getState().project.name).toBe("尚未保存的修改");
    vi.mocked(writeRecord).mockRejectedValueOnce(new Error("disk full"));
    await expect(useStore.getState().newProject("不会覆盖")).rejects.toThrow(
      "disk full",
    );
    expect(useStore.getState().project.id).toBe(id);
    expect(useStore.getState().project.name).toBe("尚未保存的修改");
    expect(Object.keys(useStore.getState().projects)).toHaveLength(1);
    expect(useStore.getState().navigating).toBe(false);
  });
});
