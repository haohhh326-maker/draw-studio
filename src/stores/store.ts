import { create } from "zustand";
import { flushCanvasPositionDrafts } from "../canvas/position-draft";
import { readHiddenWorkflowKeys, WORKFLOW_VISIBILITY_RECORD, workflowVisibilityKey, type WorkflowVisibilityPreferences } from "../workflow/visibility";
import type {
  Project,
  Canvas,
  CanvasNode,
  CanvasEdge,
  Kind,
  WorkflowDefinition,
  Connection,
  GenerationTask,
  Asset,
  HistoryEntry,
  ComputeProvider,
  RunningHubSite,
  RunningHubWorkflowMetadata,
} from "../types";
import {
  catalog,
  defaultConnection,
  defaults,
  withBuiltinBindings,
  compactWorkflows,
} from "../workflow/catalog";
import { readRecord, writeRecord, safeConnection } from "../projects/storage";
import { syncProjectDirectory } from "../projects/directory";
import { defaultTextWorkflow, migrateProject, restoreTextGeneration } from "../projects/migrate";
import { busyPhases, idleTask } from "../types";
import { readWorkflowLibrary, type WorkflowLibrarySnapshot } from "../workflow/library-client";
import { getMediaNodeSize, validMediaDimensions } from "../nodes/media-layout";
import { prepareGenerationNode } from "./generation-result";
import { activeWorkflows, allWorkflows, computeEndpoint, defaultRunningHubConnection, defaultRunningHubConnections, runningHubSite, restoreNodeComputeProviders, projectForNodeComputeProvider } from "../compute/providers";
import { COMFY_CONNECTION_PROFILES_RECORD, comfyConnectionMode, defaultNativeComfyConnection, type ComfyConnectionMode, type ComfyConnectionProfiles } from "../compute/comfy-connections";
import { isRunningHubNativeConnection } from "../runninghub/native-connection";
import { cleanWorkflowCredentials, detectWorkflowCredentials } from "../workflow/credentials";
import { reconcilePromptDraftData } from "../prompt-optimization/prompt-drafts";
import { applyRunningHubWorkflowMetadata, preserveRunningHubWorkflowMetadata, renameRunningHubWorkflow } from "../runninghub/workflow-metadata";
import { storedRunningHubWorkflows, updateRunningHubWorkflowCatalog } from "../runninghub/workflow-persistence";
import { retireDirectorCanvas, retireDirectorProject } from "../projects/retired-tools";
import { museWorkflows } from "../muse/catalog";
import { prioritizeOutputAssets } from "../workflow/output-policy";
const uid = () => crypto.randomUUID();
function fitNodeToAsset(node: CanvasNode, asset: Asset): CanvasNode {
  if (!["image", "video"].includes(asset.kind) || !validMediaDimensions(asset.width, asset.height)) return node;
  const size = getMediaNodeSize(asset.width, asset.height);
  return { ...node, ...size, style: { ...node.style, ...size }, data: { ...node.data, mediaLayoutAssetId: asset.id } };
}
export function createNode(
  kind: Kind,
  index: number,
  x = 180,
  y = 160,
  workflows: WorkflowDefinition[] = catalog,
): CanvasNode {
  if ((kind as string) === "director") throw new Error("导演台已停用。");
  const mode =
    kind === "text"
      ? "text-tool"
      : kind === "image-generation"
      ? "text-to-image"
      : kind === "audio"
        ? "text-to-audio"
        : kind === "tool"
          ? "text-to-image"
          : "text-to-video";
  const w = kind === "text" ? defaultTextWorkflow(workflows) :
    workflows.find((w) => w.mode === mode && w.template) ??
    workflows.find((w) => w.mode === mode);
  return {
    id: uid(),
    type: kind === "group" ? "group" : "media",
    position: { x, y },
    style: kind === "group" ? { width: 420, height: 300 } : undefined,
    data: {
      kind,
      title:
        {
          reference: "参考",
          video: "视频",
          "image-generation": "图像",
          audio: "音频",
          tool: "工具",
          text: "文本",
          group: "分组",
        }[kind] +
        " " +
        index,
      ...(kind === "video" ||
      kind === "image-generation" ||
      kind === "audio" ||
      kind === "text" ||
      kind === "tool"
        ? {
            generation: {
              prompt: "",
              negativePrompt: "",
              workflowId: w?.id ?? "",
              params: w ? defaults(w) : {},
              taskId: null,
            },
          }
        : {}),
    },
  };
}
function initial(name = "未命名项目"): Project {
  const c: Canvas = {
    id: uid(),
    sceneId: "scene-1",
    name: "画布 1",
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  return {
    version: 2,
    id: uid(),
    name,
    scenes: [{ id: "scene-1", name: "场景 01" }],
    canvases: [c],
    activeCanvasId: c.id,
    assets: {},
    tasks: {},
    history: [],
    updatedAt: Date.now(),
  };
}
export type ProjectLibrary = Record<
  string,
  | { project: Project; workflows: WorkflowDefinition[]; deletedAt?: number }
  | { deletedAt: number; project?: never; workflows?: never }
>;

type Snapshot = { canvasId: string; nodes: CanvasNode[]; edges: CanvasEdge[] };
type State = {
  project: Project;
  projects: ProjectLibrary;
  projectOpen: boolean;
  navigating: boolean;
  enterProject: (p: Project, workflows: WorkflowDefinition[]) => Promise<void>;
  newProject: (name: string) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  leaveProject: () => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  workflows: WorkflowDefinition[];
  hiddenWorkflowKeys: string[];
  setWorkflowHidden: (workflow: WorkflowDefinition, hidden: boolean) => Promise<void>;
  forgetWorkflowVisibility: (deleted: WorkflowDefinition) => Promise<void>;
  workflowLibrary?: WorkflowLibrarySnapshot;
  libraryState: "idle" | "loading" | "loaded" | "cached" | "error";
  libraryError: string;
  refreshWorkflowLibrary: (options?: { afterWrite?: boolean; revealWorkflowId?: string }) => Promise<void>;
  connection: Connection;
  comfyConnectionProfiles: ComfyConnectionProfiles;
  setComfyConnectionMode: (mode: ComfyConnectionMode) => void;
  computeProvider: ComputeProvider;
  runningHubConnection: Connection;
  runningHubConnections: Record<RunningHubSite, Connection>;
  setRunningHubSite: (site: RunningHubSite) => void;
  setRunningHubSiteConnection: (site: RunningHubSite, connection: Connection) => void;
  workflowCredentials: Record<string, Record<string, string>>;
  credentialWorkflow: WorkflowDefinition | null;
  setCredentialWorkflow: (workflow: WorkflowDefinition | null) => void;
  saveWorkflowCredentials: (workflow: WorkflowDefinition, values: Record<string, string>) => Promise<void>;
  runningHubConnectionState: "offline" | "connecting" | "connected";
  runningHubConnectionInfo: string;
  runningHubWorkflows: WorkflowDefinition[];
  setComputeProvider: (provider: ComputeProvider) => void;
  setNodeComputeProvider: (canvasId: string, nodeId: string, provider: ComputeProvider) => void;
  setRunningHubConnection: (connection: Connection) => void;
  saveRunningHubWorkflow: (workflow: WorkflowDefinition) => Promise<void>;
  renameRunningHubWorkflow: (id: string, name: string) => Promise<void>;
  updateRunningHubWorkflowMetadata: (id: string, metadata: RunningHubWorkflowMetadata) => Promise<void>;
  removeRunningHubWorkflow: (id: string) => Promise<void>;
  selectedId: string | null;
  selectedEdgeId: string | null;
  modal: "settings" | "compute-switcher" | "runninghub-workflows" | "runninghub-remote-workflows" | "history" | "tasks" | "help" | "workflow-library" | "workflow-import" | "assets" | "execution" | null;
  connectionState: "offline" | "connecting" | "connected";
  connectionInfo: string;
  saveState: string;
  ready: boolean;
  toast: string;
  past: Snapshot[];
  future: Snapshot[];
  setProject: (p: Project) => void;
  editProject: (fn: (p: Project) => Project) => void;
  editCanvas: (fn: (c: Canvas) => Canvas, record?: boolean) => void;
  checkpoint: (canvasId?: string) => void;
  undo: () => void;
  redo: () => void;
  patchNode: (
    id: string,
    patch: Partial<CanvasNode["data"]>,
    canvasId?: string,
  ) => void;
  createTask: (task: GenerationTask) => void;
  patchTask: (taskId: string, patch: Partial<GenerationTask>) => void;
  complete: (taskId: string, assets: Asset[], entry: HistoryEntry) => void;
  addNode: (kind: Kind, pos?: { x: number; y: number }) => string;
  addAsset: (
    asset: Asset,
    pos: { x: number; y: number },
    targetId?: string,
  ) => void;
  addAssetToLibrary: (assetId: string) => void;
  setAssetDimensions: (assetId: string, width: number, height: number) => void;
  notify: (s: string) => void;
  save: (strict?: boolean) => Promise<void>;
  hydrate: () => Promise<void>;
};
const snapshot = (s: State, canvasId = s.project.activeCanvasId): Snapshot | undefined => {
  const c = s.project.canvases.find((c) => c.id === canvasId);
  if (!c) return;
  return {
    canvasId: c.id,
    nodes: structuredClone(c.nodes),
    edges: structuredClone(c.edges),
  };
};
export const taskForNode = (p: Project, n?: CanvasNode) =>
  p.tasks[n?.data.generation?.taskId ?? ""] ?? idleTask;
export const projectBusy = (p: Project) =>
  Object.values(p.tasks).some((t) => busyPhases.includes(t.status));
function restore(c: Canvas, s: Snapshot) {
  const canvas = retireDirectorCanvas({ ...c, nodes: s.nodes, edges: s.edges });
  return {
    ...canvas,
    nodes: canvas.nodes.map((n) => {
      const current = c.nodes.find((x) => x.id === n.id);
      const matchingEdit = (node?: CanvasNode) => !!node?.data.mediaEdit &&
        node.data.mediaEdit.assetId === node.data.assetId &&
        node.data.mediaEdit.taskId === (node.data.generation?.taskId ?? null);
      const restoreMediaEdit = current?.data.generation?.taskId === n.data.generation?.taskId &&
        current?.data.mediaEdit?.assetId !== n.data.mediaEdit?.assetId &&
        (matchingEdit(current) || matchingEdit(n));
      const keepCurrentMediaLayout = !restoreMediaEdit && !!current?.data.assetId &&
        current.data.mediaLayoutAssetId === current.data.assetId &&
        current.data.mediaLayoutAssetId !== n.data.mediaLayoutAssetId;
      const restored = current?.data.generation && n.data.generation
        ? {
            ...n,
            ...(keepCurrentMediaLayout ? {
              width: current.width,
              height: current.height,
              measured: current.measured,
              style: { ...n.style, width: current.style?.width, height: current.style?.height },
            } : {}),
            data: {
              ...n.data,
              ...(restoreMediaEdit ? {} : { assetId: current.data.assetId, mediaEdit: current.data.mediaEdit }),
              ...(keepCurrentMediaLayout ? { mediaLayoutAssetId: current.data.mediaLayoutAssetId } : {}),
              ...(current.data.kind === "tool" || current.data.kind === "text"
                ? { text: current.data.text }
                : {}),
              generation: {
                ...n.data.generation,
                taskId: current.data.generation.taskId,
              },
            },
          }
        : n;
      const data = reconcilePromptDraftData(restored.data, current?.data.promptDrafts, true);
      return { ...restored, data };
    }),
  };
}
let saveTimer: ReturnType<typeof setTimeout>,
  toastTimer: ReturnType<typeof setTimeout>;
let saving = Promise.resolve();
let savingSnapshot: (Pick<State, "project" | "workflows" | "runningHubWorkflows"> & { promise: Promise<void> }) | undefined;
let connectionSaving = Promise.resolve();
let comfyProfilesSaving = Promise.resolve();
let libraryRequest: Promise<void> | undefined;
let visibilitySaving = Promise.resolve();
let computeSaving = Promise.resolve();
let runningHubWorkflowSaving = Promise.resolve();
let credentialSaving = Promise.resolve();
type ComputePreferences = { provider: ComputeProvider; runningHubConnection: Connection; runningHubConnections?: Record<RunningHubSite, Connection> };
const noWorkflowCredentials: Record<string, string> = Object.freeze({});
export const workflowCredentialKey = (workflow: WorkflowDefinition) => JSON.stringify([
  workflow.runninghub?.baseUrl ?? workflow.library?.sourcePath ?? "local", workflow.runninghub?.kind ?? "workflow", workflow.original?.id ?? workflow.id,
]);
export const workflowCredentialValues = (state: Pick<State, "workflowCredentials">, workflow: WorkflowDefinition) =>
  state.workflowCredentials?.[workflowCredentialKey(workflow)] ?? noWorkflowCredentials;
const HYDRATION_LIBRARY_GRACE_MS = 2500;

async function waitForHydrationLibraryRefresh(request: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    request,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, HYDRATION_LIBRARY_GRACE_MS);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

async function withVisibilityLock<T>(action: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks)
    return navigator.locks.request("clearframe-workflow-visibility", action);
  return action();
}
export const useStore = create<State>((set, get) => ({
  project: initial(),
  projects: {},
  projectOpen: false,
  navigating: false,
  workflows: [],
  hiddenWorkflowKeys: [],
  workflowLibrary: undefined,
  libraryState: "idle",
  libraryError: "",
  connection: defaultConnection,
  comfyConnectionProfiles: { cloud: defaultConnection, native: defaultNativeComfyConnection },
  setComfyConnectionMode: mode => {
    // Native endpoints remain available to accepted-task recovery only. New
    // ComfyUI selections always use the independently saved cloud connection.
    if (mode !== "cloud") return;
    const state = get(), current = safeConnection(state.connection);
    if (comfyConnectionMode(current) === mode) return;
    const profiles = { ...state.comfyConnectionProfiles, [comfyConnectionMode(current)]: current };
    const next = safeConnection(isRunningHubNativeConnection(profiles.cloud) ? defaultConnection : profiles.cloud);
    set({ connection: next, comfyConnectionProfiles: { ...profiles, [mode]: next },
      connectionState: "offline", connectionInfo: "已切换连接，等待检测。" });
  },
  computeProvider: "comfyui",
  runningHubConnection: defaultRunningHubConnection,
  runningHubConnections: structuredClone(defaultRunningHubConnections),
  workflowCredentials: {},
  credentialWorkflow: null,
  setCredentialWorkflow: workflow => set({ credentialWorkflow: workflow ? cleanWorkflowCredentials(workflow) : null }),
  saveWorkflowCredentials: (workflow, values) => {
    const pending = credentialSaving.catch(() => {}).then(async () => {
      const clean = Object.fromEntries(detectWorkflowCredentials(workflow).map(field => [field.id, String(values[field.id] ?? "").trim()]));
      const credentials = { ...get().workflowCredentials, [workflowCredentialKey(workflow)]: clean };
      await writeRecord("workflow-credentials", credentials);
      set({ workflowCredentials: credentials });
    });
    credentialSaving = pending;
    return pending;
  },
  setRunningHubSite: site => get().setRunningHubConnection(get().runningHubConnections[site]),
  setRunningHubSiteConnection: (site, connection) => {
    const next = safeConnection({ ...defaultRunningHubConnections[site], ...connection, baseUrl: defaultRunningHubConnections[site].baseUrl });
    if (runningHubSite(get().runningHubConnection.baseUrl) === site) get().setRunningHubConnection(next);
    else set({ runningHubConnections: { ...get().runningHubConnections, [site]: next } });
  },
  runningHubConnectionState: "offline",
  runningHubConnectionInfo: "尚未检测 RunningHub",
  runningHubWorkflows: [],
  setComputeProvider: provider => {
    if (get().navigating) return;
    if (provider === "comfyui" && isRunningHubNativeConnection(get().connection)) get().setComfyConnectionMode("cloud");
    if (provider === get().computeProvider) return;
    // Only new cards inherit this default. Existing cards retain their own selection.
    set({ computeProvider: provider });
  },
  setNodeComputeProvider: (canvasId, nodeId, provider) => {
    const state = get();
    if (state.navigating) return;
    const project = projectForNodeComputeProvider(state.project, canvasId, nodeId, provider, allWorkflows(state), state.computeProvider);
    if (project === state.project) return;
    state.checkpoint(canvasId);
    set({ project: { ...project, updatedAt: Date.now() }, saveState: "待保存" });
  },
  setRunningHubConnection: connection => {
    const current = get().runningHubConnection;
    const next = safeConnection({ ...defaultRunningHubConnection, ...connection });
    const site = runningHubSite(next.baseUrl);
    const changed = computeEndpoint(current.baseUrl) !== computeEndpoint(next.baseUrl) || current.token !== next.token;
    set({ runningHubConnection: next, runningHubConnections: { ...get().runningHubConnections, [site]: next },
      ...(changed ? { runningHubConnectionState: "offline", runningHubConnectionInfo: "RunningHub 配置已更改，等待检测。" } : {}) });
  },
  saveRunningHubWorkflow: workflow => {
    const pending = runningHubWorkflowSaving.catch(() => {}).then(async () => {
      if (!workflow.runninghub?.workflowId || !workflow.runninghub.baseUrl || !workflow.template)
        throw new Error("RunningHub 工作流缺少平台 ID、站点或 API 图。");
      const current = get().runningHubWorkflows;
      const localPrevious = current.find(item => item.id === workflow.id);
      const reconcile = workflow.runninghub.bindingMode === "selected"
        ? (await import("../runninghub/reconcile-bindings")).reconcileRunningHubProjectBindings : undefined;
      let previous = localPrevious;
      const workflows = await updateRunningHubWorkflowCatalog(current, latest => {
        const stored = latest.find(item => item.id === workflow.id);
        previous ??= stored;
        const updated = cleanWorkflowCredentials(preserveRunningHubWorkflowMetadata(workflow, stored));
        return [...latest.filter(item => item.id !== workflow.id), updated];
      });
      const updated = workflows.find(item => item.id === workflow.id)!;
      set(state => {
        const project = reconcile && previous ? reconcile(state.project, previous, updated, state.computeProvider) : state.project;
        return { runningHubWorkflows: workflows, ...(project !== state.project ? { project, saveState: "待保存" } : {}) };
      });
    });
    runningHubWorkflowSaving = pending;
    return pending;
  },
  renameRunningHubWorkflow: (id, name) => {
    const pending = runningHubWorkflowSaving.catch(() => {}).then(async () => {
      const workflows = await updateRunningHubWorkflowCatalog(get().runningHubWorkflows, latest => {
        const existing = latest.find(workflow => workflow.id === id);
        if (!existing) throw new Error("此工作流已被移除，请重新选择。");
        const updated = renameRunningHubWorkflow(existing, name);
        return updated === existing ? latest : latest.map(workflow => workflow.id === id ? updated : workflow);
      });
      set({ runningHubWorkflows: workflows });
    });
    runningHubWorkflowSaving = pending;
    return pending;
  },
  updateRunningHubWorkflowMetadata: (id, metadata) => {
    const incoming = { ...metadata };
    const pending = runningHubWorkflowSaving.catch(() => {}).then(async () => {
      const workflows = await updateRunningHubWorkflowCatalog(get().runningHubWorkflows, latest => {
        const existing = latest.find(workflow => workflow.id === id);
        // A metadata response arriving after deletion cannot restore the workflow.
        if (!existing) return latest;
        const updated = applyRunningHubWorkflowMetadata(existing, incoming);
        return updated === existing ? latest : latest.map(workflow => workflow.id === id ? updated : workflow);
      });
      set({ runningHubWorkflows: workflows });
    });
    runningHubWorkflowSaving = pending;
    return pending;
  },
  removeRunningHubWorkflow: id => {
    const pending = runningHubWorkflowSaving.catch(() => {}).then(async () => {
      const workflows = await updateRunningHubWorkflowCatalog(get().runningHubWorkflows, latest =>
        latest.some(workflow => workflow.id === id) ? latest.filter(workflow => workflow.id !== id) : latest);
      set({ runningHubWorkflows: workflows });
    });
    runningHubWorkflowSaving = pending;
    return pending;
  },
  selectedId: null,
  selectedEdgeId: null,
  modal: null,
  connectionState: "offline",
  connectionInfo: "尚未连接工作站",
  saveState: "本地自动保存",
  ready: false,
  toast: "",
  past: [],
  future: [],
  enterProject: async (p, workflows) => {
    flushCanvasPositionDrafts(true);
    if (get().navigating) return;
    if (get().projectOpen && projectBusy(get().project))
      throw new Error("请等待生成任务结束后再切换项目。");
    const previous = get();
    set({ navigating: true });
    try {
      clearTimeout(saveTimer);
      if (previous.projectOpen) await get().save(true);
      await get().refreshWorkflowLibrary();
      const importedRunningHub = workflows.filter(w => w.runninghub);
      for (const workflow of importedRunningHub) await get().saveRunningHubWorkflow(workflow);
      const mergedWorkflows = withBuiltinBindings(workflows.filter(w => !w.runninghub), get().workflowLibrary?.workflows, get().workflowLibrary?.sourcePath);
      get().setProject(migrateProject(p, [...mergedWorkflows, ...get().runningHubWorkflows, ...museWorkflows], get().connection));
      set({
        workflows: mergedWorkflows,
        projectOpen: true,
        modal: null,
      });
      await get().save(true);
      sessionStorage.setItem("clearframe-open-project", p.id);
    } catch (e) {
      get().setProject(previous.project);
      set({ workflows: previous.workflows, projectOpen: previous.projectOpen });
      throw e;
    } finally {
      set({ navigating: false });
    }
  },
  newProject: (name) =>
    get().enterProject(initial(name.trim() || "未命名项目"), []),
  openProject: async (id) => {
    const item = get().projects[id];
    if (!item || item.deletedAt || !item.project || !item.workflows)
      throw new Error("找不到这个项目，或项目已删除。");
    await get().enterProject(
      item.project,
      item.workflows,
    );
  },
  leaveProject: async () => {
    if (get().navigating) return;
    if (projectBusy(get().project))
      throw new Error("请等待生成任务结束后再退出项目。");
    set({ navigating: true });
    try {
      clearTimeout(saveTimer);
      await get().save(true);
      try {
        await syncProjectDirectory(get().project, allWorkflows(get()));
      } catch (e) {
        get().notify("本机已保存，目录副本未更新：" + String(e));
      }
      sessionStorage.removeItem("clearframe-open-project");
      set({
        projectOpen: false,
        selectedId: null,
        selectedEdgeId: null,
        modal: null,
        past: [],
        future: [],
      });
    } finally {
      set({ navigating: false });
    }
  },
  deleteProject: async (id) => {
    if (get().navigating) return;
    if (get().projectOpen && get().project.id === id)
      throw new Error("请先退出项目再删除。");
    set({ navigating: true });
    const next = saving
      .catch(() => {})
      .then(async () => {
        const persist = async () => {
          const projects = (await readRecord<ProjectLibrary>("project-library")) ?? get().projects;
          if (!projects[id]?.project) throw new Error("找不到这个项目。");
          // Keep only an ID tombstone in the same atomic library write. An old
          // tab's pending save can then see deletedAt and cannot recreate it.
          const updated: ProjectLibrary = { ...projects, [id]: { deletedAt: Date.now() } };
          await writeRecord("project-library", updated);
          set({ projects: updated });
        };
        if (typeof navigator !== "undefined" && navigator.locks)
          await navigator.locks.request("clearframe-project-library", persist);
        else await persist();
      });
    saving = next;
    try {
      await next;
      get().notify("项目已删除。");
    } finally {
      set({ navigating: false });
    }
  },
  setProject: (p) =>
    set({
      project: restoreNodeComputeProviders(restoreTextGeneration(retireDirectorProject(p), allWorkflows(get())), allWorkflows(get()), get().computeProvider),
      selectedId: null,
      selectedEdgeId: null,
      past: [],
      future: [],
    }),
  editProject: (fn) =>
    set((s) => ({
      project: { ...retireDirectorProject(fn(s.project)), updatedAt: Date.now() },
      saveState: "待保存",
    })),
  editCanvas: (fn, record = false) => {
    if (record) get().checkpoint();
    get().editProject((p) => ({
      ...p,
      canvases: p.canvases.map((c) => (c.id === p.activeCanvasId ? fn(c) : c)),
    }));
  },
  checkpoint: (canvasId) =>
    set((s) => {
      const current = snapshot(s, canvasId);
      return current ? { past: [...s.past.slice(-39), current], future: [] } : s;
    }),
  undo: () => {
    flushCanvasPositionDrafts(true);
    const s = get();
    const last = s.past.at(-1);
    if (!last) return;
    if (projectBusy(s.project)) {
      s.notify("生成期间暂不撤销画布操作。");
      return;
    }
    const current = snapshot(s, last.canvasId);
    if (!current) return;
    set({
      past: s.past.slice(0, -1),
      future: [current, ...s.future],
      project: {
        ...s.project,
        activeCanvasId: last.canvasId,
        canvases: s.project.canvases.map((c) =>
          c.id === last.canvasId ? restore(c, last) : c,
        ),
      },
      selectedId: null,
    });
  },
  redo: () => {
    flushCanvasPositionDrafts(true);
    const s = get();
    const next = s.future[0];
    if (!next) return;
    if (projectBusy(s.project)) {
      s.notify("生成期间暂不重做画布操作。");
      return;
    }
    const current = snapshot(s, next.canvasId);
    if (!current) return;
    set({
      past: [...s.past, current],
      future: s.future.slice(1),
      project: {
        ...s.project,
        activeCanvasId: next.canvasId,
        canvases: s.project.canvases.map((c) =>
          c.id === next.canvasId ? restore(c, next) : c,
        ),
      },
      selectedId: null,
    });
  },
  patchNode: (id, patch, canvasId) =>
    get().editProject((p) => ({
      ...p,
      canvases: p.canvases.map((c) =>
        c.id === (canvasId ?? p.activeCanvasId)
          ? {
              ...c,
              nodes: c.nodes.map((n) => {
                if (n.id !== id) return n;
                const previous = n.data.generation, next = patch.generation;
                const editedGeneration = previous && next && (previous.prompt !== next.prompt || previous.negativePrompt !== next.negativePrompt ||
                  previous.workflowId !== next.workflowId || [...new Set([...Object.keys(previous.params), ...Object.keys(next.params)])]
                    .some(key => !Object.is(previous.params[key], next.params[key])));
                return { ...n, data: reconcilePromptDraftData({ ...n.data, ...patch,
                  ...(editedGeneration && !("generationFeedback" in patch) ? { generationFeedback: undefined } : {}),
                }) };
              }),
            }
          : c,
      ),
    })),
  createTask: (task) =>
    get().editProject((p) => ({
      ...p,
      tasks: { ...p.tasks, [task.taskId]: task },
      canvases: p.canvases.map((c) =>
        c.id === task.canvasId
          ? {
              ...c,
              nodes: c.nodes.map((n) =>
                n.id === task.nodeId && n.data.generation
                  ? prepareGenerationNode(n, task.taskId)
                  : n,
              ),
            }
          : c,
      ),
    })),
  patchTask: (taskId, patch) =>
    get().editProject((p) =>
      p.tasks[taskId]
        ? {
            ...p,
            tasks: {
              ...p.tasks,
              [taskId]: {
                ...p.tasks[taskId],
                ...patch,
                ...(patch.status &&
                ["failed", "cancelled"].includes(patch.status)
                  ? { endedAt: p.tasks[taskId].endedAt ?? Date.now() }
                  : patch.status && busyPhases.includes(patch.status)
                    ? { endedAt: undefined }
                    : {}),
                taskId,
                executorType: p.tasks[taskId].executorType,
                updatedAt: Date.now(),
              },
            },
          }
        : p,
    ),
  complete: (taskId, assets, entry) =>
    get().editProject((p) => {
      const task = p.tasks[taskId];
      if (!task || task.status === "completed") return p;
      assets = prioritizeOutputAssets(task.workflow, assets, task.downloadedOutputs ?? []);
      entry = { ...entry, outputs: assets.map(asset => asset.id) };
      return {
        ...p,
        tasks: {
          ...p.tasks,
          [taskId]: {
            ...task,
            status: "completed",
            progress: undefined,
            error: undefined,
            outputs: assets.map((a) => a.id),
            completedAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        assets: {
          ...p.assets,
          ...Object.fromEntries(assets.map((a) => [a.id, { ...a, inLibrary: p.assets[a.id]?.inLibrary === true }])),
        },
        history: [entry, ...p.history.filter((h) => h.id !== entry.id)],
        canvases: p.canvases.map((c) =>
          c.id === task.canvasId
            ? {
                ...c,
                nodes: c.nodes.map((n) =>
                  n.id === task.nodeId && n.data.generation?.taskId === taskId
                    ? {
                        ...fitNodeToAsset(n, assets[0]),
                        data: {
                          ...n.data,
                          ...fitNodeToAsset(n, assets[0]).data,
                          assetId: assets[0].id,
                          mediaEdit: undefined,
                          ...(n.data.kind === "tool" || n.data.kind === "text"
                            ? {
                                text:
                                  assets[0].kind === "text"
                                    ? assets[0].text
                                    : undefined,
                              }
                            : {}),
                        },
                      }
                    : n,
                ),
              }
            : c,
        ),
      };
    }),
  addNode: (kind, pos) => {
    const c = get().project.canvases.find(
      (c) => c.id === get().project.activeCanvasId,
    )!;
    const n = createNode(
      kind,
      c.nodes.filter((n) => n.data.kind === kind).length + 1,
      pos?.x ?? 240 + c.nodes.length * 45,
      pos?.y ?? 170,
      activeWorkflows(get()),
    );
    if (n.data.generation) n.data.generation.computeProvider = get().computeProvider;
    get().editCanvas(
      (c) => ({
        ...c,
        nodes: [
          ...c.nodes.map((node) => ({ ...node, selected: false })),
          { ...n, selected: true },
        ],
      }),
      true,
    );
    set({ selectedId: n.id, selectedEdgeId: null });
    return n.id;
  },
  addAsset: (asset, pos, targetId) => {
    get().editProject((p) => ({
      ...p,
      assets: { ...p.assets, [asset.id]: asset },
    }));
    if (targetId) {
      get().patchNode(targetId, { assetId: asset.id });
      if (validMediaDimensions(asset.width, asset.height)) get().setAssetDimensions(asset.id, asset.width!, asset.height!);
      return;
    }
    const id = get().addNode("reference", pos);
    get().patchNode(id, { assetId: asset.id });
    if (validMediaDimensions(asset.width, asset.height)) get().setAssetDimensions(asset.id, asset.width!, asset.height!);
  },
  addAssetToLibrary: (assetId) => {
    if (!get().project.assets[assetId] || get().project.assets[assetId].inLibrary === true) return;
    get().editProject(p => ({ ...p, assets: { ...p.assets, [assetId]: { ...p.assets[assetId], inLibrary: true } } }));
  },
  setAssetDimensions: (assetId, width, height) => {
    const project = get().project, asset = project.assets[assetId];
    if (!asset || !["image", "video"].includes(asset.kind) || !validMediaDimensions(width, height)) return;
    const metadataChanged = asset.width !== width || asset.height !== height;
    const needsLayout = (node: CanvasNode) => node.data.assetId === assetId && (metadataChanged || node.data.mediaLayoutAssetId !== assetId);
    if (!metadataChanged && !project.canvases.some(canvas => canvas.nodes.some(needsLayout))) return;
    const updatedAsset = { ...asset, width, height };
    get().editProject(p => ({ ...p,
      assets: { ...p.assets, [assetId]: updatedAsset },
      canvases: p.canvases.map(canvas => ({ ...canvas, nodes: canvas.nodes.map(node => needsLayout(node) ? fitNodeToAsset(node, updatedAsset) : node) })),
    }));
  },
  notify: (toast) => {
    clearTimeout(toastTimer);
    set({ toast });
    toastTimer = setTimeout(() => set({ toast: "" }), 5000);
  },
  setWorkflowHidden: async (workflow, hidden) => {
    const key = workflowVisibilityKey(workflow);
    const next = visibilitySaving.catch(() => {}).then(() => withVisibilityLock(async () => {
      // A stale management row cannot restore a directory entry that was deleted.
      if (!allWorkflows(get()).some(item => workflowVisibilityKey(item) === key)) return;
      const saved = await readRecord(WORKFLOW_VISIBILITY_RECORD);
      const previous = saved === undefined ? get().hiddenWorkflowKeys : readHiddenWorkflowKeys(saved);
      const keys = hidden ? [...new Set([...previous, key])] : previous.filter(item => item !== key);
      if (keys.length !== previous.length || keys.some((item, index) => item !== previous[index]))
        await writeRecord(WORKFLOW_VISIBILITY_RECORD, { version: 1, hiddenKeys: keys } satisfies WorkflowVisibilityPreferences);
      set({ hiddenWorkflowKeys: keys });
    }));
    visibilitySaving = next;
    try { await next; }
    catch (reason) { get().notify("工作流设置保存失败：" + (reason instanceof Error ? reason.message : String(reason))); throw reason; }
  },
  forgetWorkflowVisibility: async (deleted) => {
    const key = workflowVisibilityKey(deleted);
    const next = visibilitySaving.catch(() => {}).then(() => withVisibilityLock(async () => {
      // A scan may already have removed the definition. Clearing its preference cannot recreate it.
      const saved = await readRecord(WORKFLOW_VISIBILITY_RECORD);
      const previous = saved === undefined ? get().hiddenWorkflowKeys : readHiddenWorkflowKeys(saved);
      const keys = previous.filter(item => item !== key);
      if (keys.length !== previous.length)
        await writeRecord(WORKFLOW_VISIBILITY_RECORD, { version: 1, hiddenKeys: keys } satisfies WorkflowVisibilityPreferences);
      set({ hiddenWorkflowKeys: keys });
    }));
    visibilitySaving = next;
    await next;
  },
  refreshWorkflowLibrary: async (options) => {
    // An import must not reuse a scan that began before its files were committed.
    if (options?.afterWrite && libraryRequest) await libraryRequest;
    if (libraryRequest) {
      await libraryRequest;
      // Each import still restores its own entry when callers share a directory scan.
      if (options?.revealWorkflowId && get().libraryState === "loaded") {
        const imported = get().workflowLibrary?.workflows.find(workflow => workflow.original?.id === options.revealWorkflowId || workflow.id === options.revealWorkflowId);
        if (imported) await get().forgetWorkflowVisibility(imported);
      }
      return;
    }
    set({ libraryState: "loading", libraryError: "" });
    libraryRequest = (async () => {
      try {
        const library = await readWorkflowLibrary();
        // Persist the complete source snapshot independently of any open project.
        await writeRecord("workflow-library", library);
        if (options?.revealWorkflowId) {
          const imported = library.workflows.find(workflow => workflow.original?.id === options.revealWorkflowId || workflow.id === options.revealWorkflowId);
          if (imported) await get().forgetWorkflowVisibility(imported);
        }
        set({
          workflowLibrary: library,
          workflows: withBuiltinBindings(get().workflows, library.workflows, library.sourcePath),
          libraryState: "loaded",
        });
      } catch (error) {
        set({
          libraryState: get().workflowLibrary ? "cached" : "error",
          libraryError: error instanceof Error ? error.message : String(error),
        });
      } finally {
        libraryRequest = undefined;
      }
    })();
    return libraryRequest;
  },
  save: async (strict = false) => {
    flushCanvasPositionDrafts();
    const s = get();
    const shared = savingSnapshot && saving === savingSnapshot.promise &&
      savingSnapshot.project === s.project && savingSnapshot.workflows === s.workflows &&
      savingSnapshot.runningHubWorkflows === s.runningHubWorkflows;
    const next = shared ? savingSnapshot!.promise : saving
      .catch(() => {})
      .then(async () => {
        const persist = async () => {
          const latest = await readRecord<ProjectLibrary>("project-library");
          if (latest?.[s.project.id]?.deletedAt)
            throw new Error("项目已删除，无法继续保存。");
          const projects = {
            ...(latest ?? get().projects),
            [s.project.id]: {
              project: s.project,
              workflows: [...compactWorkflows(s.workflows), ...s.runningHubWorkflows],
            },
          };
          await writeRecord("project-library", projects);
          set({ projects });
          await writeRecord("workflows", compactWorkflows(s.workflows));
        };
        if (typeof navigator !== "undefined" && navigator.locks)
          await navigator.locks.request("clearframe-project-library", persist);
        else await persist();
      });
    if (!shared) {
      saving = next;
      const snapshot = { project: s.project, workflows: s.workflows, runningHubWorkflows: s.runningHubWorkflows, promise: next };
      savingSnapshot = snapshot;
      const release = () => { if (savingSnapshot === snapshot) savingSnapshot = undefined; };
      // Only consecutive, still-pending identical checkpoints may share work.
      // A later manual save must re-read the library for cross-tab changes.
      void next.then(release, release);
    }
    try {
      await next;
      if (get().project === s.project) set({ saveState: "已保存到本机" });
    } catch (e) {
      set({ saveState: "保存失败" });
      get().notify("本地保存失败：" + String(e));
      if (strict) throw e;
    }
  },
  hydrate: async () => {
    try {
      const [p, w, c, savedProjects, library, visibility, compute, runningHubWorkflows, workflowCredentials, savedComfyProfiles] = await Promise.all([
        readRecord<Project>("project"),
        readRecord<WorkflowDefinition[]>("workflows"),
        readRecord<Connection>("connection"),
        readRecord<ProjectLibrary>("project-library"),
        readRecord<WorkflowLibrarySnapshot>("workflow-library"),
        readRecord<WorkflowVisibilityPreferences>(WORKFLOW_VISIBILITY_RECORD),
        readRecord<ComputePreferences>("compute-preferences"),
        readRecord<WorkflowDefinition[]>("runninghub-workflows"),
        readRecord<Record<string, Record<string, string>>>("workflow-credentials"),
        readRecord<Partial<ComfyConnectionProfiles>>(COMFY_CONNECTION_PROFILES_RECORD),
      ]);
      const previousRunningHub = safeConnection({ ...defaultRunningHubConnection, ...compute?.runningHubConnection });
      const profiles = { cn: safeConnection({ ...defaultRunningHubConnections.cn, ...compute?.runningHubConnections?.cn }),
        ai: safeConnection({ ...defaultRunningHubConnections.ai, ...compute?.runningHubConnections?.ai }) };
      if (!compute?.runningHubConnections) profiles[runningHubSite(previousRunningHub.baseUrl)] = previousRunningHub;
      const comfyProfiles: ComfyConnectionProfiles = {
        cloud: safeConnection({ ...defaultConnection, ...savedComfyProfiles?.cloud }),
        native: safeConnection({ ...defaultNativeComfyConnection,
          ...(savedComfyProfiles?.native ?? { token: profiles.cn.token }) }),
      };
      if (isRunningHubNativeConnection(comfyProfiles.cloud)) comfyProfiles.cloud = safeConnection(defaultConnection);
      // Preserve the last native credentials for accepted-task recovery, while
      // removing that retired endpoint from the active cloud selection.
      const previousComfy = c ? safeConnection({ ...defaultConnection, ...c }) : comfyProfiles.cloud;
      const retiredNative = isRunningHubNativeConnection(previousComfy);
      if (retiredNative) comfyProfiles.native = previousComfy;
      const currentComfy = retiredNative ? comfyProfiles.cloud : previousComfy;
      comfyProfiles.cloud = currentComfy;
      if (retiredNative) {
        // Save recovery credentials before replacing the active endpoint.
        await writeRecord(COMFY_CONNECTION_PROFILES_RECORD, comfyProfiles);
        await writeRecord("connection", currentComfy);
      }
      set({ workflowLibrary: library, workflows: withBuiltinBindings((w ?? []).filter(w => !w.runninghub), library?.workflows, library?.sourcePath), hiddenWorkflowKeys: readHiddenWorkflowKeys(visibility),
        connection: currentComfy, comfyConnectionProfiles: comfyProfiles,
        computeProvider: compute?.provider === "muse" || compute?.provider === "runninghub" || compute?.provider === "runninghub-workflow" ? compute.provider : "comfyui",
        runningHubConnections: profiles,
        runningHubConnection: profiles[runningHubSite(previousRunningHub.baseUrl)],
        workflowCredentials: workflowCredentials && typeof workflowCredentials === "object" ? workflowCredentials : {},
        runningHubWorkflows: storedRunningHubWorkflows(runningHubWorkflows),
      });
      // A slow or temporarily unavailable directory scan must not keep the
      // whole canvas on the startup screen. Cached/local records are enough to
      // render the app; the scan continues and refreshes the library when it
      // completes.
      const libraryRefresh = get().refreshWorkflowLibrary();
      void libraryRefresh.catch(() => {});
      await waitForHydrationLibraryRefresh(libraryRefresh);
      const projects: ProjectLibrary = Object.fromEntries(Object.entries(savedProjects ?? {}).map(([id, item]) =>
        [id, item.project ? { ...item, project: retireDirectorProject(item.project) } : item],
      ));
      if (!savedProjects && p) {
        const workflows = withBuiltinBindings(w ?? [], get().workflowLibrary?.workflows, get().workflowLibrary?.sourcePath);
        const migrated = migrateProject(
          p,
          workflows,
          c ?? defaultConnection,
        );
        projects[migrated.id] = { project: migrated, workflows };
        await writeRecord("project-library", projects);
      }
      set({ projects });
      const currentId = sessionStorage.getItem("clearframe-open-project");
      const current = currentId ? projects[currentId] : undefined;
      if (current?.project && current.workflows && !current.deletedAt) {
        const workflows = withBuiltinBindings(current.workflows.filter(w => !w.runninghub), get().workflowLibrary?.workflows, get().workflowLibrary?.sourcePath);
        set({
          project: restoreNodeComputeProviders(migrateProject(
            current.project,
            [...workflows, ...get().runningHubWorkflows, ...museWorkflows],
            c ?? defaultConnection,
          ), [...workflows, ...get().runningHubWorkflows, ...museWorkflows], get().computeProvider),
          workflows,
          projectOpen: true,
        });
      } else set({ projectOpen: false });
    } catch (e) {
      get().notify("读取本地项目失败：" + String(e));
    } finally {
      set({ ready: true });
    }
  },
}));
useStore.subscribe((s, prev) => {
  if (s.ready && s.connection !== prev.connection && isRunningHubNativeConnection(s.connection)) {
    const previousCloud = !isRunningHubNativeConnection(prev.connection) ? prev.connection : s.comfyConnectionProfiles.cloud;
    const connection = safeConnection(isRunningHubNativeConnection(previousCloud) ? defaultConnection : previousCloud);
    // A pasted retired endpoint must not replace recovery credentials for an
    // already accepted task, or re-enable the removed entry through persistence.
    useStore.setState({ connection, comfyConnectionProfiles: prev.comfyConnectionProfiles,
      connectionState: "offline", connectionInfo: "RunningHub 原生 ComfyUI 入口已停用，请使用独立的「RunningHub ComfyUI 工作流」入口。" });
    return;
  }
  if (s.connection !== prev.connection) {
    const connection = safeConnection(s.connection), mode = comfyConnectionMode(connection);
    if (JSON.stringify(connection) !== JSON.stringify(s.connection)) {
      useStore.setState({ connection, comfyConnectionProfiles: { ...s.comfyConnectionProfiles, [mode]: connection } });
      return;
    }
  }
  if (s.ready && (s.computeProvider !== prev.computeProvider || s.runningHubConnection !== prev.runningHubConnection || s.runningHubConnections !== prev.runningHubConnections)) {
    const preferences: ComputePreferences = { provider: s.computeProvider, runningHubConnection: safeConnection(s.runningHubConnection), runningHubConnections: {
      cn: safeConnection(s.runningHubConnections.cn), ai: safeConnection(s.runningHubConnections.ai),
    } };
    computeSaving = computeSaving.catch(() => {}).then(() => writeRecord("compute-preferences", preferences)).then(() => {})
      .catch(() => useStore.getState().notify("算力配置保存失败，请检查本机存储。"));
  }
  if (s.ready && s.connection !== prev.connection) {
    const connection = safeConnection(s.connection);
    connectionSaving = connectionSaving
      .catch(() => {})
      .then(() => writeRecord("connection", connection))
      .then(() => {})
      .catch(() => {
        useStore.getState().notify("连接认证保存失败，请检查本机存储后重新保存连接设置。");
      });
  }
  if (s.connection !== prev.connection) {
    const connection = safeConnection(s.connection), mode = comfyConnectionMode(connection);
    if (JSON.stringify(s.comfyConnectionProfiles[mode]) !== JSON.stringify(connection))
      useStore.setState({ comfyConnectionProfiles: { ...s.comfyConnectionProfiles, [mode]: connection } });
  }
  if (s.ready && (s.comfyConnectionProfiles !== prev.comfyConnectionProfiles || !prev.ready)) {
    const profiles = useStore.getState().comfyConnectionProfiles;
    const snapshot = { cloud: safeConnection(profiles.cloud), native: safeConnection(profiles.native) };
    comfyProfilesSaving = comfyProfilesSaving.catch(() => {}).then(() => writeRecord(COMFY_CONNECTION_PROFILES_RECORD, snapshot)).then(() => {})
      .catch(() => useStore.getState().notify("连接配置保存失败，请检查本机存储。"));
  }
  if (
    s.ready &&
    s.projectOpen &&
    !s.navigating &&
    (s.project !== prev.project || s.workflows !== prev.workflows || s.runningHubWorkflows !== prev.runningHubWorkflows)
  ) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void s.save(), 700);
  }
});
export const activeCanvas = (s: State) =>
  s.project.canvases.find((c) => c.id === s.project.activeCanvasId)!;
