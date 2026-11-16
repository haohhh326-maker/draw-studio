import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(persistence.get(key)),
  writeRecord: vi.fn(async (key: string, value: unknown) => {
    persistence.set(key, structuredClone(value));
  }),
  safeConnection: (value: object) => ({ ...value, token: "" }),
}));
vi.mock("../src/projects/directory", () => ({
  syncProjectDirectory: vi.fn(async () => {}),
}));
vi.mock("../src/workflow/library-client", () => ({
  readWorkflowLibrary: vi.fn(),
}));

import { useStore, type ProjectLibrary } from "../src/stores/store";
import { catalog, defaultConnection, findWorkflow, withBuiltinBindings } from "../src/workflow/catalog";
import { buildWorkflow, validateDefinition } from "../src/workflow-adapter/adapter";
import { buildDirectoryView } from "../src/workflow/directory-view";
import { readWorkflowLibrary, type WorkflowLibrarySnapshot } from "../src/workflow/library-client";
import type { GenerationTask, WorkflowDefinition } from "../src/types";

const sourcePath = "E:\\123\\DFCine\\DFCine0.26\\workflows\\library";
// Mirrors VideoDeep's four execution nodes and the config's video/resolution bindings.
const deep: WorkflowDefinition = {
  id: "library-video.deep",
  name: "视频转深度",
  family: "视频转换",
  description: "将输入的视频转换为深度视频",
  library: { sourcePath, folder: "VideoDeep" },
  directory: { version: 2, canvas: "video", seriesId: "video-convert", bindingKey: "video.deep", bindingStatus: "bound" },
  mode: "reference-video",
  promptRequired: false,
  requiredInputs: ["slot:input1"],
  optionalInputs: [],
  inputSlots: [{ semantic: "slot:input1", label: "输入视频", kind: "video", required: true }],
  parameters: [{ key: "resolution3", label: "分辨率", type: "number", default: 704, min: 64, max: 4032, step: 64 }],
  mapping: [
    { semantic: "slot:input1", nodeId: "1", field: "video", pathMode: "comfy-input" },
    { semantic: "resolution3", nodeId: "3", field: "resolution" },
  ],
  output: { kind: "video", nodeId: "4", field: "gifs", prefix: { nodeId: "4", field: "filename_prefix" } },
  template: {
    "1": { class_type: "VHS_LoadVideoPath", inputs: { video: "", force_rate: 0, skip_first_frames: 0, select_every_nth: 1 } },
    "5": { class_type: "VHS_VideoInfo", inputs: { video_info: ["1", 3] } },
    "3": { class_type: "DepthAnythingPreprocessor", inputs: { image: ["1", 0], resolution: 704 } },
    "4": { class_type: "VHS_VideoCombine", inputs: { images: ["3", 0], frame_rate: ["5", 5], filename_prefix: "DFCine/VideoDeep", format: "video/h264-mp4", save_output: true } },
  },
};
const snapshot = (workflows: WorkflowDefinition[] = [deep]): WorkflowLibrarySnapshot => ({
  sourcePath, loadedAt: Date.now(), scanned: workflows.length, issues: [], workflows: structuredClone(workflows),
});

beforeEach(() => {
  vi.useFakeTimers();
  persistence.clear();
  vi.clearAllMocks();
  vi.mocked(readWorkflowLibrary).mockReset().mockImplementation(async () => snapshot());
  const session = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => session.set(key, value),
    removeItem: (key: string) => session.delete(key),
  });
  // Any accidental network use fails immediately; these tests only exercise local persistence.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("网络访问不允许出现在本地目录测试中"); }));
  useStore.setState({
    projects: {}, projectOpen: false, navigating: false, ready: false,
    workflows: catalog, workflowLibrary: undefined, libraryState: "idle", libraryError: "",
    connection: defaultConnection, past: [], future: [],
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function projectWithDeep() {
  await useStore.getState().newProject("深度转换项目");
  const id = useStore.getState().addNode("video");
  useStore.getState().patchNode(id, {
    generation: { computeProvider: "comfyui", prompt: "", negativePrompt: "", workflowId: deep.id, params: { resolution3: 1024 }, taskId: null },
  });
  return { projectId: useStore.getState().project.id, nodeId: id };
}

describe("local workflow library persistence", () => {
  it("starts a new scan after import commit instead of registering from a pre-write request", async () => {
    let release!: (value: WorkflowLibrarySnapshot) => void;
    const beforeWrite = new Promise<WorkflowLibrarySnapshot>(resolve => { release = resolve; });
    vi.mocked(readWorkflowLibrary).mockReturnValueOnce(beforeWrite).mockResolvedValueOnce(snapshot([deep]));
    const previous = useStore.getState().refreshWorkflowLibrary();
    const afterWrite = useStore.getState().refreshWorkflowLibrary({ afterWrite: true });
    expect(readWorkflowLibrary).toHaveBeenCalledTimes(1);
    release(snapshot([]));
    await previous; await afterWrite;
    expect(readWorkflowLibrary).toHaveBeenCalledTimes(2);
    expect(useStore.getState().workflowLibrary?.workflows.map(w => w.id)).toEqual([deep.id]);
    expect(useStore.getState().libraryState).toBe("loaded");
  });

  it("keeps saved workflow registration pending when the post-write scan fails", async () => {
    await useStore.getState().refreshWorkflowLibrary();
    vi.mocked(readWorkflowLibrary).mockRejectedValueOnce(new Error("扫描暂时不可用"));
    await useStore.getState().refreshWorkflowLibrary({ afterWrite: true });
    expect(useStore.getState().libraryState).toBe("cached");
    expect(useStore.getState().libraryError).toBe("扫描暂时不可用");
    expect(useStore.getState().workflowLibrary?.workflows.map(w => w.id)).toEqual([deep.id]);
  });
  it("shows a shared source workflow once while resolving both legacy aliases, and invalidates both aliases after source deletion", () => {
    const aliases = catalog.filter(w => w.original?.id === "klein-imageupscale");
    expect(aliases).toHaveLength(2);
    const loaded: WorkflowDefinition = {
      ...structuredClone(deep),
      id: "library-klein-imageupscale", name: "Klein 高清放大", family: "图像工具",
      library: { sourcePath, folder: "Klein-ImageUpscale" },
      original: { ...structuredClone(aliases[0].original!), id: "klein-imageupscale" },
      directory: { ...deep.directory!, canvas: "image", bindingKey: "klein-imageupscale" },
      output: { kind: "image", nodeId: "4", field: "images" },
    };
    const current = withBuiltinBindings(aliases, [loaded], sourcePath);
    expect(current).toHaveLength(1);
    expect(buildDirectoryView(current).find(v => v.id === "image")?.workflows).toHaveLength(1);
    for (const alias of aliases) expect(findWorkflow(current, alias.id)).toBe(current[0]);
    expect(findWorkflow(current, loaded.id)).toBe(current[0]);
    const deleted = withBuiltinBindings(current, [], sourcePath);
    expect(deleted).toEqual([]);
    for (const alias of aliases) expect(findWorkflow(deleted, alias.id)).toBeUndefined();
    expect(findWorkflow(deleted, loaded.id)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a first launch empty when reading the directory fails before any complete cache exists", async () => {
    vi.mocked(readWorkflowLibrary).mockRejectedValue(new Error("首次目录读取失败"));
    useStore.setState({ workflows: [] });
    await useStore.getState().hydrate();
    expect(useStore.getState().ready).toBe(true);
    expect(useStore.getState().workflows).toEqual([]);
    expect(useStore.getState().workflowLibrary).toBeUndefined();
    expect(useStore.getState().libraryState).toBe("error");
    expect(useStore.getState().libraryError).toBe("首次目录读取失败");
    expect(persistence.has("workflow-library")).toBe(false);
    await useStore.getState().newProject("首次读取失败的项目");
    const nodeId = useStore.getState().addNode("video");
    expect(useStore.getState().project.canvases[0].nodes.find(n => n.id === nodeId)?.data.generation?.workflowId).toBe("");
    expect(useStore.getState().workflows).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("filters the old fixed catalog on an uncached failed hydrate without losing assets, node references or independently imported workflows", async () => {
    const { projectId, nodeId } = await projectWithDeep();
    const builtin = catalog.find(w => w.template)!;
    const independent: WorkflowDefinition = { ...structuredClone(deep), id: "independent-local", library: undefined, name: "我的独立工作流" };
    const staleSource: WorkflowDefinition = { ...structuredClone(deep), id: "library-stale-cache", name: "旧来源缓存流程" };
    useStore.getState().patchNode(nodeId, {
      assetId: "retained-result",
      generation: { computeProvider: "comfyui", prompt: "保留旧提示词", negativePrompt: "保留排除词", workflowId: builtin.id, params: { savedSeed: 81 }, taskId: null },
    });
    const sourceId = useStore.getState().addNode("reference");
    useStore.getState().patchNode(sourceId, { assetId: "retained-input" });
    useStore.getState().editProject(p => ({
      ...p,
      assets: {
        "retained-input": { id: "retained-input", name: "原始视频.mp4", kind: "video", mime: "video/mp4", size: 12, createdAt: 1 },
        "retained-result": { id: "retained-result", name: "上次结果.mp4", kind: "video", mime: "video/mp4", size: 24, createdAt: 2 },
      },
      canvases: p.canvases.map(c => ({ ...c, edges: [{ id: "retained-edge", source: sourceId, target: nodeId, data: { role: "referenceVideo", order: 1 } }] })),
    }));
    const savedProject = structuredClone(useStore.getState().project);
    // Represents an installation that has project records but never saved a complete directory snapshot.
    persistence.clear();
    const oldWorkflows = [...structuredClone(catalog), staleSource, independent];
    persistence.set("project-library", { [projectId]: { project: savedProject, workflows: oldWorkflows } });
    persistence.set("workflows", oldWorkflows);
    vi.mocked(readWorkflowLibrary).mockRejectedValue(new Error("没有目录或完整缓存"));
    useStore.setState({ projects: {}, projectOpen: false, ready: false, workflows: [], workflowLibrary: undefined, libraryState: "idle", libraryError: "" });
    await useStore.getState().hydrate();
    expect(useStore.getState().projectOpen).toBe(true);
    expect(useStore.getState().project).toEqual(savedProject);
    expect(useStore.getState().workflows).toEqual([independent]);
    expect(useStore.getState().libraryState).toBe("error");
    expect(useStore.getState().workflowLibrary).toBeUndefined();
    expect(useStore.getState().project.canvases[0].nodes.find(n => n.id === nodeId)?.data.generation?.workflowId).toBe(builtin.id);
    expect(useStore.getState().project.assets["retained-input"].name).toBe("原始视频.mp4");
    expect(useStore.getState().project.assets["retained-result"].name).toBe("上次结果.mp4");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("adds the discovered category and execution bindings, then preserves the selected workflow across save, exit and reopen", async () => {
    const { projectId, nodeId } = await projectWithDeep();
    const directory = buildDirectoryView(useStore.getState().workflows).find(v => v.id === "video")!;
    expect(directory.workflows).toHaveLength(1);
    expect(useStore.getState().workflows.map(w => w.id)).toEqual([deep.id]);
    expect(directory.series.find(s => s.name === "视频转换")?.workflows).toBe(1);
    const cached = persistence.get("workflow-library") as WorkflowLibrarySnapshot;
    expect(cached.sourcePath).toBe(sourcePath);
    expect(cached.workflows[0].template).toEqual(deep.template);
    await useStore.getState().save(true);
    await useStore.getState().leaveProject();
    await useStore.getState().openProject(projectId);
    const node = useStore.getState().project.canvases[0].nodes.find(n => n.id === nodeId)!;
    expect(node.data.generation).toEqual({ computeProvider: "comfyui", prompt: "", negativePrompt: "", workflowId: deep.id, params: { resolution3: 1024 }, taskId: null });
    const restored = useStore.getState().workflows.find(w => w.id === deep.id)!;
    const built = buildWorkflow(restored, node,
      [{ semantic: "slot:input1", edgeId: "video-edge", asset: { id: "video-input", name: "参考.mp4", kind: "video", mime: "video/mp4", size: 1, createdAt: 0 } }],
      { "video-input": "infinite-canvas/task-1/reference.mp4" }, "infinite-canvas/task-1/result");
    expect(built.workflow["1"].inputs.video).toBe("input/infinite-canvas/task-1/reference.mp4");
    expect(built.workflow["3"].inputs.resolution).toBe(1024);
    expect(built.workflow["4"].inputs.filename_prefix).toBe("infinite-canvas/task-1/result");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("removes a source workflow that previously replaced a builtin, without resurrecting it from an older project", async () => {
    const builtin = catalog.find(w => w.original && w.template)!;
    const loaded: WorkflowDefinition = {
      ...structuredClone(builtin), id: "library-" + encodeURIComponent(builtin.original!.id),
      name: "目录中的内置匹配流程", library: { sourcePath, folder: "BuiltinFixture" },
    };
    vi.mocked(readWorkflowLibrary).mockResolvedValue(snapshot([loaded, deep]));
    const { projectId, nodeId } = await projectWithDeep();
    useStore.getState().patchNode(nodeId, {
      generation: { computeProvider: "comfyui", prompt: "保留我的提示词", negativePrompt: "", workflowId: builtin.id, params: { personalValue: 37 }, taskId: null },
    });
    expect(useStore.getState().workflows.find(w => w.id === builtin.id)?.name).toBe(loaded.name);
    await useStore.getState().leaveProject();
    const originalProject = structuredClone((persistence.get("project-library") as ProjectLibrary)[projectId].project);
    expect((persistence.get("project-library") as ProjectLibrary)[projectId].workflows.some(w => w.id === builtin.id)).toBe(true);
    vi.mocked(readWorkflowLibrary).mockResolvedValue(snapshot([deep]));
    await useStore.getState().refreshWorkflowLibrary();
    expect(useStore.getState().workflows.map(w => w.id)).toEqual([deep.id]);
    await useStore.getState().openProject(projectId);
    expect(useStore.getState().project).toEqual(originalProject);
    expect(useStore.getState().workflows.map(w => w.id)).toEqual([deep.id]);
    expect(useStore.getState().workflows.some(w => w.original?.id === builtin.original!.id)).toBe(false);
    // The node keeps its missing workflow ID and parameters so the user can choose a replacement explicitly.
    expect(useStore.getState().project.canvases[0].nodes.find(n => n.id === nodeId)?.data.generation?.workflowId).toBe(builtin.id);
    expect(useStore.getState().project.canvases[0].nodes.find(n => n.id === nodeId)?.data.generation?.params).toEqual({ personalValue: 37 });
    // Projects saved before directory support contain only the old static catalog.
    persistence.set("project-library", { [projectId]: { project: originalProject, workflows: structuredClone(catalog) } });
    useStore.setState({ projects: {}, projectOpen: false, ready: false, workflows: catalog, workflowLibrary: undefined, libraryState: "idle", libraryError: "" });
    await useStore.getState().hydrate();
    expect(useStore.getState().project).toEqual(originalProject);
    expect(useStore.getState().workflows.map(w => w.id)).toEqual([deep.id]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats a successfully scanned empty directory as authoritative, including offline hydrate and old project reopen", async () => {
    const { projectId, nodeId } = await projectWithDeep();
    await useStore.getState().leaveProject();
    const savedProject = structuredClone((persistence.get("project-library") as ProjectLibrary)[projectId].project);
    vi.mocked(readWorkflowLibrary).mockResolvedValue(snapshot([]));
    await useStore.getState().refreshWorkflowLibrary();
    expect(useStore.getState().workflows).toEqual([]);
    expect((persistence.get("workflow-library") as WorkflowLibrarySnapshot).workflows).toEqual([]);
    expect(useStore.getState().libraryState).toBe("loaded");
    vi.mocked(readWorkflowLibrary).mockRejectedValue(new Error("目录服务暂时离线"));
    useStore.setState({ projects: {}, projectOpen: false, ready: false, workflows: catalog, workflowLibrary: undefined, libraryState: "idle", libraryError: "" });
    await useStore.getState().hydrate();
    expect(useStore.getState().workflows).toEqual([]);
    expect(useStore.getState().libraryState).toBe("cached");
    expect(useStore.getState().workflowLibrary?.workflows).toEqual([]);
    await useStore.getState().openProject(projectId);
    expect(useStore.getState().workflows).toEqual([]);
    expect(useStore.getState().project).toEqual(savedProject);
    expect(useStore.getState().project.canvases[0].nodes.find(n => n.id === nodeId)?.data.generation?.workflowId).toBe(deep.id);
    expect(buildDirectoryView(useStore.getState().workflows).every(v => !v.workflows.length)).toBe(true);
  });

  it("does not assign retired builtin workflows to newly created nodes when the directory is empty", async () => {
    vi.mocked(readWorkflowLibrary).mockResolvedValue(snapshot([]));
    await useStore.getState().newProject("空目录项目");
    const projectId = useStore.getState().project.id;
    const ids = ["video", "image-generation", "audio", "tool"].map(kind => useStore.getState().addNode(kind as "video" | "image-generation" | "audio" | "tool"));
    expect(useStore.getState().workflows).toEqual([]);
    expect(useStore.getState().project.canvases[0].nodes.map(n => n.data.generation?.workflowId)).toEqual(["", "", "", ""]);
    expect(useStore.getState().project.canvases[0].nodes.every(n => !Object.keys(n.data.generation!.params).length)).toBe(true);
    await useStore.getState().leaveProject();
    await useStore.getState().openProject(projectId);
    expect(useStore.getState().project.canvases[0].nodes.map(n => n.id)).toEqual(ids);
    expect(useStore.getState().project.canvases[0].nodes.map(n => n.data.generation?.workflowId)).toEqual(["", "", "", ""]);
    expect(useStore.getState().workflows).toEqual([]);
  });

  it("does not re-add snapshots from a previous source directory, but retains an independently imported API workflow", async () => {
    const { projectId } = await projectWithDeep();
    const staleSource: WorkflowDefinition = {
      ...structuredClone(deep), id: "library-retired-directory", name: "旧目录流程",
      library: { sourcePath: "E:\\retired-library", folder: "Retired" },
    };
    const independent: WorkflowDefinition = { ...structuredClone(deep), id: "independent-api", name: "独立 API", library: undefined };
    useStore.setState({ workflows: [...useStore.getState().workflows, staleSource, independent] });
    await useStore.getState().leaveProject();
    await useStore.getState().openProject(projectId);
    expect(useStore.getState().workflows.some(w => w.id === staleSource.id)).toBe(false);
    expect(useStore.getState().workflows.find(w => w.id === independent.id)).toEqual(independent);
    expect(useStore.getState().workflows.map(w => w.id).sort()).toEqual([deep.id, independent.id].sort());
  });

  it("persists metadata-only source entries and their execution issue through project save, reopen and cached hydrate", async () => {
    const unavailable: WorkflowDefinition = {
      ...structuredClone(deep), id: "library-unavailable", name: "待适配视频流程", template: undefined,
      library: { sourcePath, folder: "Unavailable", executionIssue: "执行文件无法读取，需要重新导出 API 工作流。" },
      directory: { ...deep.directory!, bindingStatus: "pending" },
    };
    vi.mocked(readWorkflowLibrary).mockResolvedValue(snapshot([deep, unavailable]));
    const { projectId } = await projectWithDeep();
    expect(buildDirectoryView(useStore.getState().workflows).find(v => v.id === "video")?.workflows).toHaveLength(2);
    await useStore.getState().leaveProject();
    const saved = (persistence.get("project-library") as ProjectLibrary)[projectId].workflows.find(w => w.id === unavailable.id)!;
    expect(saved.library?.executionIssue).toBe(unavailable.library!.executionIssue);
    expect(saved.template).toBeUndefined();
    await useStore.getState().openProject(projectId);
    expect(useStore.getState().workflows.find(w => w.id === unavailable.id)).toEqual(unavailable);
    vi.mocked(readWorkflowLibrary).mockRejectedValue(new Error("本地服务离线"));
    useStore.setState({ projects: {}, projectOpen: false, ready: false, workflows: catalog, workflowLibrary: undefined, libraryState: "idle", libraryError: "" });
    await useStore.getState().hydrate();
    const restored = useStore.getState().workflows.find(w => w.id === unavailable.id)!;
    expect(restored).toEqual(unavailable);
    expect(restored.library?.executionIssue).toBe(unavailable.library!.executionIssue);
    expect(restored.directory?.bindingStatus).toBe("pending");
    expect(() => validateDefinition(restored)).toThrow();
    expect(useStore.getState().libraryState).toBe("cached");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hydrates the full cached workflow when the local directory is temporarily unavailable", async () => {
    const { projectId, nodeId } = await projectWithDeep();
    await useStore.getState().save(true);
    const saved = structuredClone((persistence.get("project-library") as ProjectLibrary)[projectId].project);
    vi.mocked(readWorkflowLibrary).mockRejectedValue(new Error("目录暂时不可用"));
    useStore.setState({ projects: {}, projectOpen: false, ready: false, workflows: catalog, workflowLibrary: undefined, libraryState: "idle", libraryError: "" });
    await useStore.getState().hydrate();
    expect(useStore.getState().projectOpen).toBe(true);
    expect(useStore.getState().project).toEqual(saved);
    expect(useStore.getState().project.canvases[0].nodes.find(n => n.id === nodeId)?.data.generation?.params.resolution3).toBe(1024);
    expect(useStore.getState().workflows.find(w => w.id === deep.id)?.template).toEqual(deep.template);
    expect(useStore.getState().libraryState).toBe("cached");
    expect(useStore.getState().libraryError).toBe("目录暂时不可用");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hydrates the newest directory definition while retaining the node's chosen parameters", async () => {
    const { projectId, nodeId } = await projectWithDeep();
    await useStore.getState().save(true);
    const updated = structuredClone(deep);
    updated.name = "视频转深度 新版";
    updated.parameters[0].default = 512;
    updated.template!["3"].inputs.resolution = 512;
    vi.mocked(readWorkflowLibrary).mockResolvedValue(snapshot([updated]));
    useStore.setState({ projects: {}, projectOpen: false, ready: false, workflows: catalog, workflowLibrary: undefined, libraryState: "idle", libraryError: "" });
    await useStore.getState().hydrate();
    expect(useStore.getState().project.id).toBe(projectId);
    expect(useStore.getState().workflows.find(w => w.id === deep.id)?.name).toBe(updated.name);
    expect(useStore.getState().workflows.find(w => w.id === deep.id)?.template!["3"].inputs.resolution).toBe(512);
    expect(useStore.getState().project.canvases[0].nodes.find(n => n.id === nodeId)?.data.generation?.params.resolution3).toBe(1024);
    expect((persistence.get("workflow-library") as WorkflowLibrarySnapshot).workflows[0].name).toBe(updated.name);
    expect(useStore.getState().libraryState).toBe("loaded");
  });

  it("removes a deleted source workflow after refreshing and reopening, while preserving project content and other custom workflows", async () => {
    const { projectId } = await projectWithDeep();
    const independent: WorkflowDefinition = { ...structuredClone(deep), id: "my-api-workflow", library: undefined, name: "独立导入" };
    useStore.setState({ workflows: [...useStore.getState().workflows, independent] });
    const projectBefore = structuredClone(useStore.getState().project);
    await useStore.getState().save(true);
    vi.mocked(readWorkflowLibrary).mockResolvedValue(snapshot([]));
    await useStore.getState().refreshWorkflowLibrary();
    expect(useStore.getState().workflows.find(w => w.id === deep.id)).toBeUndefined();
    expect(useStore.getState().workflows.find(w => w.id === independent.id)).toEqual(independent);
    expect(useStore.getState().project).toEqual(projectBefore);
    // The project record still contains the old snapshot; reopening must reconcile it with the directory.
    expect((persistence.get("project-library") as ProjectLibrary)[projectId].workflows.some(w => w.id === deep.id)).toBe(true);
    await useStore.getState().openProject(projectId);
    expect(useStore.getState().workflows.find(w => w.id === deep.id)).toBeUndefined();
    expect(useStore.getState().workflows.find(w => w.id === independent.id)).toEqual(independent);
    expect(useStore.getState().project).toEqual(projectBefore);
  });

  it("keeps the last saved library and unsaved node parameters intact after refresh failure", async () => {
    await projectWithDeep();
    const node = useStore.getState().project.canvases[0].nodes[0];
    useStore.getState().patchNode(node.id, { generation: { ...node.data.generation!, params: { resolution3: 1536 } } });
    const projectBefore = structuredClone(useStore.getState().project);
    const cacheBefore = structuredClone(persistence.get("workflow-library"));
    vi.mocked(readWorkflowLibrary).mockRejectedValue(new Error("读取失败"));
    await useStore.getState().refreshWorkflowLibrary();
    expect(useStore.getState().project).toEqual(projectBefore);
    expect(useStore.getState().workflowLibrary).toEqual(cacheBefore);
    expect(persistence.get("workflow-library")).toEqual(cacheBefore);
    expect(useStore.getState().workflows.find(w => w.id === deep.id)).toEqual(deep);
    expect(useStore.getState().libraryState).toBe("cached");
  });

  it("does not rewrite an existing task's workflow, execution graph or submission identity during a directory update", async () => {
    const { projectId, nodeId } = await projectWithDeep();
    const task: GenerationTask = {
      taskId: "persisted-task", promptId: "remote-prompt", executorType: "comfyui", requestId: "request-1", clientId: "client-1",
      projectId, canvasId: useStore.getState().project.activeCanvasId, nodeId, nodeTitle: "视频 1", status: "generating", createdAt: 1, updatedAt: 1,
      connection: { name: "原连接", baseUrl: "https://example.invalid", authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 60 },
      workflow: structuredClone(deep), executionWorkflow: structuredClone(deep.template),
      input: { prompt: "", negativePrompt: "", params: { resolution3: 1024 }, assets: [] }, outputs: [],
    };
    useStore.getState().createTask(task);
    const projectBefore = structuredClone(useStore.getState().project);
    const updated = structuredClone(deep);
    updated.name = "已更新工作流";
    updated.template!["3"].inputs.resolution = 2048;
    vi.mocked(readWorkflowLibrary).mockResolvedValue(snapshot([updated]));
    await useStore.getState().refreshWorkflowLibrary();
    expect(useStore.getState().workflows.find(w => w.id === deep.id)?.name).toBe(updated.name);
    expect(useStore.getState().project.tasks[task.taskId]).toEqual(task);
    expect(useStore.getState().project).toEqual(projectBefore);
    await useStore.getState().save(true);
    expect((persistence.get("project-library") as ProjectLibrary)[projectId].project.tasks[task.taskId]).toEqual(task);
    expect(fetch).not.toHaveBeenCalled();
  });
});
