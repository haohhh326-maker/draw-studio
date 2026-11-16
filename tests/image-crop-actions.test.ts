import { beforeEach, expect, it, vi } from "vitest";
import type { Asset, CanvasNode, GenerationTask, Project } from "../src/types";
import { busyPhases } from "../src/types";
const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/projects/storage", () => ({ readRecord: async (key: string) => structuredClone(records.get(key)),
  writeRecord: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); }, safeConnection: (value: object) => value }));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));
import { useStore } from "../src/stores/store";
import { applyImageCrop, getImageCropSource } from "../src/nodes/image-crop-actions";
import { catalog, defaultConnection } from "../src/workflow/catalog";
import { migrateProject } from "../src/projects/migrate";
import { isAssetInLibrary } from "../src/assets/library-membership";

const original: Asset = { id: "original-image", name: "actor.png", kind: "image", mime: "image/png", size: 10, createdAt: 1, width: 1600, height: 900 };
const cropped: Asset = { ...original, id: "cropped-image", name: "actor-cropped.png", size: 6, width: 900, height: 900, createdAt: 2 };
const generation = { workflowId: "w", prompt: "原提示词", negativePrompt: "负面词", params: { seed: 123 }, taskId: "old-task" };
function task(id = "old-task"): GenerationTask {
  return { taskId: id, promptId: "prompt-" + id, executorType: "comfyui", requestId: "request-" + id, clientId: "client-" + id,
    canvasId: "canvas", nodeId: "image-node", nodeTitle: "角色参考", status: "completed", createdAt: 1, updatedAt: 1, connection: defaultConnection,
    workflow: structuredClone(catalog[0]), input: { prompt: generation.prompt, negativePrompt: generation.negativePrompt, params: { ...generation.params }, assets: [] }, outputs: [original.id] };
}
function project(generated = false): Project {
  const node: CanvasNode = { id: "image-node", type: "media", position: { x: 20, y: 30 }, width: 360, height: 203,
    style: { width: 360, height: 203, borderColor: "#fff" }, data: { kind: generated ? "image-generation" : "reference", title: "角色参考", assetId: original.id,
      mediaLayoutAssetId: original.id, ...(generated ? { generation: structuredClone(generation) } : {}) } };
  return { version: 2, id: "project", name: "裁切测试", activeCanvasId: "canvas", updatedAt: 1, scenes: [{ id: "scene", name: "场景" }],
    canvases: [{ id: "canvas", name: "画布", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [node, { ...structuredClone(node), id: "shared-image", position: { x: 450, y: 30 } },
        { id: "destination", position: { x: 800, y: 30 }, data: { kind: "video", title: "视频", generation: { ...structuredClone(generation), taskId: null } } }],
      edges: [{ id: "edge", source: node.id, target: "destination", data: { role: "firstFrame", order: 1 } }] }],
    assets: { [original.id]: structuredClone(original) }, tasks: { "old-task": task() },
    history: [{ id: "old-task", canvasId: "canvas", nodeId: node.id, nodeTitle: node.data.title, workflowId: "w", prompt: generation.prompt,
      negativePrompt: generation.negativePrompt, params: { ...generation.params }, inputs: [], outputs: [original.id], createdAt: 1, promptId: "prompt-old-task" }] };
}
beforeEach(() => {
  records.clear();
  useStore.setState({ project: project(), projects: {}, projectOpen: true, navigating: false, workflows: [], ready: false, past: [], future: [], selectedId: null, selectedEdgeId: null, connection: defaultConnection });
});

it.each([false, true])("applies and undoes a crop on generated=%s without touching links, history, task state, other references or filenames", async generated => {
  useStore.setState({ project: project(generated) });
  const source = getImageCropSource("image-node"), before = structuredClone(useStore.getState().project);
  applyImageCrop(source, cropped);
  const after = useStore.getState().project, node = after.canvases[0].nodes[0];
  expect(node.id).toBe("image-node"); expect(node.position).toEqual(before.canvases[0].nodes[0].position);
  expect(node.data).toMatchObject({ kind: before.canvases[0].nodes[0].data.kind, title: "角色参考", assetId: cropped.id, mediaLayoutAssetId: cropped.id });
  expect(node.data.generation).toEqual(before.canvases[0].nodes[0].data.generation);
  expect(node.style).toEqual({ width: 360, height: 360, borderColor: "#fff" });
  expect(after.assets[original.id]).toEqual(original); expect(after.assets[cropped.id]).toEqual({ ...cropped, inLibrary: false });
  expect(after.canvases[0].nodes[1]).toEqual(before.canvases[0].nodes[1]); expect(after.canvases[0].edges).toEqual(before.canvases[0].edges);
  expect(after.history).toEqual(before.history); expect(after.tasks).toEqual(before.tasks); expect(useStore.getState().past).toHaveLength(1);
  await useStore.getState().save(true);
  const saved = (records.get("project-library") as Record<string, { project: Project }>).project.project;
  expect(saved.assets[cropped.id]).toMatchObject({ width: 900, height: 900 });
  expect(migrateProject(saved, []).canvases[0].nodes[0].data.assetId).toBe(cropped.id);
  useStore.getState().undo();
  const undone = useStore.getState().project;
  expect(undone.canvases[0].nodes[0].data.assetId).toBe(original.id);
  expect(undone.canvases[0].nodes[0].style).toEqual(before.canvases[0].nodes[0].style);
  expect(undone.tasks).toEqual(before.tasks); expect(undone.history).toEqual(before.history);
  expect(undone.assets[cropped.id]).toEqual({ ...cropped, inLibrary: false });
  useStore.getState().redo();
  expect(useStore.getState().project.canvases[0].nodes[0].data.assetId).toBe(cropped.id);
  expect(useStore.getState().project.canvases[0].nodes[0].style).toMatchObject({ width: 360, height: 360 });
});

it("keeps edits to the prompt made while the crop dialog is open", () => {
  useStore.setState({ project: project(true) });
  const source = getImageCropSource("image-node"), next = { ...structuredClone(generation), prompt: "最新提示词" };
  useStore.getState().patchNode("image-node", { generation: next, title: "新的用户标题" });
  applyImageCrop(source, cropped);
  expect(useStore.getState().project.canvases[0].nodes[0].data).toMatchObject({ title: "新的用户标题", generation: next });
});

it.each(["legacy-generated", "imported", "manually-added", "hidden"])("inherits the %s source's library membership when saving a crop", mode => {
  const state = project(true);
  if (mode === "imported") { state.tasks = {}; state.history = []; }
  if (mode === "manually-added") state.assets[original.id].inLibrary = true;
  if (mode === "hidden") state.assets[original.id].inLibrary = false;
  useStore.setState({ project: state });
  const source = getImageCropSource("image-node");
  applyImageCrop(source, { ...cropped, inLibrary: mode === "hidden" });
  const after = useStore.getState().project;
  expect(after.assets[cropped.id].inLibrary).toBe(mode === "imported" || mode === "manually-added");
  expect(isAssetInLibrary(after.assets[cropped.id], after)).toBe(mode === "imported" || mode === "manually-added");
});

it("uses current library membership if the source is manually added while its crop dialog is open", () => {
  useStore.setState({ project: project(true) });
  const source = getImageCropSource("image-node");
  useStore.getState().addAssetToLibrary(source.assetId);
  applyImageCrop(source, cropped);
  expect(useStore.getState().project.assets[cropped.id].inLibrary).toBe(true);
});

it("preserves a newer generated output and its task/history when undo reaches an earlier crop checkpoint", () => {
  useStore.setState({ project: project(true) });
  applyImageCrop(getImageCropSource("image-node"), cropped);
  const nextTask = { ...task("new-task"), status: "saving" as const, outputs: [] };
  useStore.getState().createTask(nextTask);
  const output: Asset = { ...original, id: "new-result", name: "result.png", width: 800, height: 1200 };
  const history = { ...useStore.getState().project.history[0], id: "new-task", outputs: [output.id], promptId: "prompt-new-task" };
  useStore.getState().complete("new-task", [output], history);
  useStore.getState().undo();
  const current = useStore.getState().project, node = current.canvases[0].nodes[0];
  expect(node.data.assetId).toBe(output.id); expect(node.data.mediaEdit).toBeUndefined();
  expect(node.data.generation?.taskId).toBe("new-task"); expect(node.style).toMatchObject({ width: 240, height: 360 });
  expect(current.tasks["new-task"].status).toBe("completed"); expect(current.history[0]).toEqual(history);
});

it.each(["project", "canvas", "removed", "replaced", "busy", "interrupted", "closed", "navigating"])("rejects a %s conflict before a checkpoint or project mutation", conflict => {
  useStore.setState({ project: project(true) });
  const source = getImageCropSource("image-node");
  const changed = structuredClone(useStore.getState().project);
  if (conflict === "project") changed.id = "other-project";
  if (conflict === "canvas") { changed.activeCanvasId = "other-canvas"; changed.canvases.push({ ...structuredClone(changed.canvases[0]), id: "other-canvas" }); }
  if (conflict === "removed") changed.canvases[0].nodes = changed.canvases[0].nodes.filter(node => node.id !== source.nodeId);
  if (conflict === "replaced") changed.canvases[0].nodes[0].data.assetId = "other-asset";
  if (conflict === "busy" || conflict === "interrupted") changed.tasks["old-task"].status = conflict === "busy" ? "generating" : "interrupted";
  useStore.setState({ project: changed, projectOpen: conflict !== "closed", navigating: conflict === "navigating" });
  const before = useStore.getState().project;
  expect(() => applyImageCrop(source, cropped)).toThrow();
  expect(useStore.getState().project).toBe(before); expect(useStore.getState().past).toHaveLength(0);
});

it("refuses overwriting an existing asset or applying malformed crop dimensions", () => {
  const source = getImageCropSource("image-node"), before = useStore.getState().project;
  expect(() => applyImageCrop(source, original)).toThrow("新素材");
  for (const invalid of [{ ...cropped, width: 0 }, { ...cropped, width: 4.5 }, { ...cropped, size: 0 }, { ...cropped, kind: "video" as const }, { ...cropped, id: "../bad" }]) {
    expect(() => applyImageCrop(source, invalid)).toThrow("裁切结果无效");
  }
  expect(useStore.getState().project).toBe(before); expect(useStore.getState().past).toHaveLength(0);
});

it("refuses opening a crop for video, missing images or unfinished generation", () => {
  expect(() => getImageCropSource("destination")).toThrow("上传或生成图片");
  useStore.setState({ project: project(true) });
  useStore.getState().patchTask("old-task", { status: "interrupted" });
  expect(() => getImageCropSource("image-node")).toThrow("等待生成任务");
});

it.each(busyPhases)("blocks both opening and applying a crop while generation is %s", status => {
  useStore.setState({ project: project(true) });
  const source = getImageCropSource("image-node");
  useStore.getState().patchTask("old-task", { status });
  expect(() => getImageCropSource("image-node")).toThrow("等待生成任务");
  expect(() => applyImageCrop(source, cropped)).toThrow("未结束的生成任务");
  expect(useStore.getState().past).toHaveLength(0);
});
