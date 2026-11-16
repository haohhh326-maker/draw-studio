import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, CanvasNode, GenerationTask, HistoryEntry, Kind, Project, WorkflowDefinition } from "../src/types";
const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(records.get(key)),
  writeRecord: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
  safeConnection: (value: object) => value,
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));
import { useStore } from "../src/stores/store";
import { defaultConnection } from "../src/workflow/catalog";
import { generatedAssetIds, isAssetInLibrary, libraryAssets } from "../src/assets/library-membership";
import { applyParameterAction } from "../src/generation/parameter-actions";
import { migrateProject } from "../src/projects/migrate";

const workflow: WorkflowDefinition = { id: "w", name: "Test", family: "Test", mode: "text-to-image", requiredInputs: [], optionalInputs: [],
  parameters: [{ key: "seed", label: "种子", type: "number", default: 58 }],
  template: { sampler: { class_type: "Sampler", inputs: { seed: 58 } } }, mapping: [{ semantic: "seed", nodeId: "sampler", field: "seed" }],
  output: { nodeId: "sampler", field: "images", kind: "image" } };
const asset = (id = "old-result", extra: Partial<Asset> = {}): Asset => ({ id, name: id + ".png", kind: "image", mime: "image/png", createdAt: 1, size: 1, ...extra });
function node(kind: Kind = "image-generation", id = "node"): CanvasNode {
  return { id, type: "media", position: { x: 0, y: 0 }, width: 360, height: 203, measured: { width: 360, height: 203 },
    style: { width: 360, height: 203, borderColor: "#fff" }, data: { kind, title: "生成", assetId: "old-result", mediaLayoutAssetId: "old-result",
    mediaEdit: { assetId: "old-result", taskId: "old-task" }, text: "上次生成文本",
    generation: { workflowId: workflow.id, prompt: "原始提示词", negativePrompt: "保留限制", params: { seed: 58, steps: 20 }, taskId: "old-task" } } };
}
function task(taskId = "old-task", status: GenerationTask["status"] = "completed"): GenerationTask {
  return { taskId, promptId: "remote-" + taskId, executorType: "comfyui", requestId: "request-" + taskId, clientId: "client", nodeId: "node", nodeTitle: "生成",
    canvasId: "canvas", createdAt: 1, updatedAt: 1, status, workflow: structuredClone(workflow), connection: defaultConnection,
    input: { prompt: "原始提示词", negativePrompt: "保留限制", params: { seed: 58 }, assets: [] }, outputs: ["old-result"] };
}
function entry(id = "old-task", output = "old-result"): HistoryEntry {
  return { id, canvasId: "canvas", nodeId: "node", nodeTitle: "生成", workflowId: workflow.id, prompt: "原始提示词", negativePrompt: "保留限制",
    params: { seed: 58 }, inputs: [], outputs: [output], promptId: "remote-" + id, createdAt: 1 };
}
function project(kind: Kind = "image-generation"): Project {
  return { version: 2, id: "project", name: "Test", activeCanvasId: "canvas", scenes: [], updatedAt: 1,
    canvases: [{ id: "canvas", name: "画布", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node(kind), node("reference", "reference")],
      edges: [{ id: "edge", source: "reference", target: "node", data: { role: "referenceImage", order: 1 } }] }],
    assets: { "old-result": asset(), imported: asset("imported") }, tasks: { "old-task": task() }, history: [entry()] };
}
beforeEach(() => {
  records.clear();
  useStore.setState({ project: project(), projects: {}, projectOpen: true, navigating: false, ready: false, workflows: [structuredClone(workflow)], past: [], future: [] });
});

describe("explicit asset library membership", () => {
  it("keeps imported assets visible while hiding legacy task/history outputs until explicitly added", () => {
    const p = project();
    p.assets.historyOnly = asset("historyOnly"); p.history.push(entry("historyOnly", "historyOnly"));
    p.assets.download = asset("download"); p.tasks["old-task"].downloadedOutputs = [{ file: { filename: "download.png" }, asset: p.assets.download }];
    p.assets.text = asset("text", { kind: "text" }); p.tasks["old-task"].outputTextAsset = p.assets.text;
    expect([...generatedAssetIds(p)].sort()).toEqual(["download", "historyOnly", "old-result", "text"]);
    expect(libraryAssets(p).map(a => a.id)).toEqual(["imported"]);
    expect(isAssetInLibrary({ ...p.assets["old-result"], inLibrary: true }, p)).toBe(true);
    expect(isAssetInLibrary({ ...p.assets.imported, inLibrary: false }, p)).toBe(false);
  });

  it("retains generated results on the node and in history without automatically adding them to the library", () => {
    useStore.getState().createTask(task("new-task", "saving"));
    useStore.getState().complete("new-task", [asset("new-result")], entry("new-task", "new-result"));
    const p = useStore.getState().project;
    expect(p.assets["new-result"].inLibrary).toBe(false);
    expect(p.canvases[0].nodes[0].data.assetId).toBe("new-result");
    expect(p.tasks["new-task"].outputs).toEqual(["new-result"]);
    expect(p.history[0].outputs).toEqual(["new-result"]);
    expect(libraryAssets(p).map(a => a.id)).toEqual(["imported"]);
  });

  it("persists manually added generated results across save and restore without copying or changing history", async () => {
    const before = structuredClone(useStore.getState().project);
    useStore.getState().addAssetToLibrary("old-result");
    useStore.getState().addAssetToLibrary("old-result");
    useStore.getState().addAssetToLibrary("missing");
    await useStore.getState().save(true);
    const saved = (records.get("project-library") as Record<string, { project: Project }>).project.project;
    expect(saved.assets["old-result"]).toEqual({ ...before.assets["old-result"], inLibrary: true });
    expect(saved.history).toEqual(before.history); expect(saved.tasks).toEqual(before.tasks);
    expect(libraryAssets(migrateProject(saved, [workflow])).map(a => a.id)).toEqual(["old-result", "imported"]);
  });
});

describe("fresh results for changed seeds", () => {
  it.each(["image-generation", "video", "text", "audio", "tool"] as const)("retains the %s result, crop and frame until Generate starts a new task", kind => {
    useStore.setState({ project: project(kind) });
    const before = structuredClone(useStore.getState().project), gen = before.canvases[0].nodes[0].data.generation!;
    useStore.getState().patchNode("node", { generation: { ...gen, params: { ...gen.params, seed: 59 } } });
    const after = useStore.getState().project, result = after.canvases[0].nodes[0].data;
    expect(result.assetId).toBe("old-result"); expect(result.mediaEdit).toEqual(before.canvases[0].nodes[0].data.mediaEdit);
    expect(result.mediaLayoutAssetId).toBe("old-result"); expect(result.text).toBe("上次生成文本");
    expect(result.generation).toEqual({ ...gen, params: { ...gen.params, seed: 59 } });
    expect(after.canvases[0].nodes[0]).toEqual({ ...before.canvases[0].nodes[0], data: {
      ...before.canvases[0].nodes[0].data, generation: { ...gen, params: { ...gen.params, seed: 59 } }, generationFeedback: undefined,
    } });
    expect(after.canvases[0].nodes[1]).toEqual(before.canvases[0].nodes[1]); expect(after.canvases[0].edges).toEqual(before.canvases[0].edges);
    expect(after.assets).toEqual(before.assets); expect(after.tasks).toEqual(before.tasks); expect(after.history).toEqual(before.history);
  });

  it("also retains the displayed result when the random-seed button changes the seed", () => {
    const generation = useStore.getState().project.canvases[0].nodes[0].data.generation!;
    const next = applyParameterAction(workflow.parameters[0], Number(generation.params.seed), { kind: "seed", title: "随机" });
    expect(next).not.toBe(generation.params.seed);
    useStore.getState().patchNode("node", { generation: { ...generation, params: { ...generation.params, seed: next } } });
    expect(useStore.getState().project.canvases[0].nodes[0].data.generation?.taskId).toBe("old-task");
    expect(useStore.getState().project.canvases[0].nodes[0].data.assetId).toBe("old-result");
  });

  it("retains the previous output for imported seed aliases as well as ordinary seed controls", () => {
    const mapped = { ...workflow, parameters: [{ key: "value17", label: "整数", type: "number" as const, default: 58 }],
      mapping: [{ semantic: "value17", nodeId: "sampler", field: "noise_seed" }] };
    useStore.setState({ workflows: [mapped] });
    const previous = node().data.generation!;
    useStore.getState().patchNode("node", { generation: { ...previous, params: { value17: 59 } } });
    expect(useStore.getState().project.canvases[0].nodes[0].data.assetId).toBe("old-result");
    expect(useStore.getState().project.canvases[0].nodes[0].data.generation?.taskId).toBe("old-task");
  });

  it("does not clear an unchanged seed when only prompt or unrelated parameters change", () => {
    const before = structuredClone(useStore.getState().project.canvases[0].nodes[0].data);
    useStore.getState().patchNode("node", { generation: { ...before.generation!, prompt: "更新提示词", params: { seed: 58, steps: 30 } } });
    const after = useStore.getState().project.canvases[0].nodes[0].data;
    expect(after.assetId).toBe(before.assetId); expect(after.mediaEdit).toEqual(before.mediaEdit); expect(after.generation?.taskId).toBe("old-task");
  });

  it.each(["prompt", "seed", "new-task"])("clears local generation feedback on %s without mutating old tasks", change => {
    const before = structuredClone(useStore.getState().project.tasks);
    useStore.getState().patchNode("node", { generationFeedback: { status: "failed", error: "本地校验错误" } });
    const generation = useStore.getState().project.canvases[0].nodes[0].data.generation!;
    if (change === "new-task") useStore.getState().createTask(task("new-task", "submitting"));
    else useStore.getState().patchNode("node", { generation: { ...generation,
      ...(change === "prompt" ? { prompt: "更新提示词" } : { params: { ...generation.params, seed: 59 } }) } });
    const current = useStore.getState().project;
    expect(current.canvases[0].nodes[0].data.generationFeedback).toBeUndefined();
    expect(current.tasks["old-task"]).toEqual(before["old-task"]);
    if (change === "prompt") expect(current.canvases[0].nodes[0].data.generation?.taskId).toBe("old-task");
  });

  it("keeps newly supplied feedback when updating generation configuration in the same patch", () => {
    const generation = useStore.getState().project.canvases[0].nodes[0].data.generation!, feedback = { status: "failed" as const, error: "新的校验失败" };
    useStore.getState().patchNode("node", { generation: { ...generation, prompt: "更新提示词" }, generationFeedback: feedback });
    expect(useStore.getState().project.canvases[0].nodes[0].data.generationFeedback).toEqual(feedback);
  });

  it.each(["failed", "cancelled"] as const)("retains the old %s task association until a new task starts", status => {
    const p = project(); p.tasks["old-task"].status = status; p.tasks["old-task"].error = "上次任务错误"; useStore.setState({ project: p });
    const generation = p.canvases[0].nodes[0].data.generation!;
    useStore.getState().patchNode("node", { generation: { ...generation, params: { ...generation.params, seed: 59 } } });
    const current = useStore.getState().project;
    expect(current.canvases[0].nodes[0].data.generation?.taskId).toBe("old-task");
    expect(current.tasks["old-task"].error).toBe("上次任务错误");
    useStore.getState().createTask(task("new-task", "uploading"));
    expect(useStore.getState().project.canvases[0].nodes[0].data.generation?.taskId).toBe("new-task");
  });

  it("retains a changed seed's display until starting on the explicitly targeted canvas without touching a same-ID node elsewhere", () => {
    const p = project(); p.canvases.push({ ...structuredClone(p.canvases[0]), id: "other-canvas" }); useStore.setState({ project: p });
    const before = structuredClone(p.canvases[0].nodes[0]), generation = before.data.generation!;
    useStore.getState().patchNode("node", { generation: { ...generation, params: { ...generation.params, seed: 59 } } }, "other-canvas");
    expect(useStore.getState().project.canvases[0].nodes[0]).toEqual(before);
    expect(useStore.getState().project.canvases[1].nodes[0].data.assetId).toBe("old-result");
    useStore.getState().createTask({ ...task("new-task", "uploading"), canvasId: "other-canvas" });
    expect(useStore.getState().project.canvases[0].nodes[0]).toEqual(before);
    expect(useStore.getState().project.canvases[1].nodes[0].data.assetId).toBeUndefined();
  });

  it.each(["image-generation", "video", "text", "audio", "tool"] as const)("clears only the %s display and restores its initial frame when a new task starts", kind => {
    useStore.setState({ project: project(kind) });
    const before = structuredClone(useStore.getState().project), generation = before.canvases[0].nodes[0].data.generation!;
    useStore.getState().patchNode("node", { generation: { ...generation, params: { ...generation.params, seed: 59 } } });
    useStore.getState().createTask(task("new-task", "uploading"));
    const current = useStore.getState().project, result = current.canvases[0].nodes[0];
    expect(result).toMatchObject({ position: before.canvases[0].nodes[0].position, width: 200, height: 180,
      measured: { width: 200, height: 180 }, style: { width: 200, height: 180, borderColor: "#fff" } });
    expect(result.data.assetId).toBeUndefined(); expect(result.data.mediaEdit).toBeUndefined(); expect(result.data.mediaLayoutAssetId).toBeUndefined();
    expect(result.data.generation).toEqual({ ...generation, params: { ...generation.params, seed: 59 }, taskId: "new-task" });
    if (kind === "text" || kind === "tool") expect(result.data.text).toBeUndefined();
    expect(current.canvases[0].nodes[1]).toEqual(before.canvases[0].nodes[1]); expect(current.canvases[0].edges).toEqual(before.canvases[0].edges);
    expect(current.assets).toEqual(before.assets); expect(current.history).toEqual(before.history); expect(current.tasks["old-task"]).toEqual(before.tasks["old-task"]);
    useStore.getState().setAssetDimensions("old-result", 1920, 1080);
    expect(useStore.getState().project.canvases[0].nodes[0]).toEqual(result);
  });

  it("persists an edited seed without discarding the completed preview, then saves the reset frame only after Generate", async () => {
    const generation = useStore.getState().project.canvases[0].nodes[0].data.generation!;
    useStore.getState().patchNode("node", { generation: { ...generation, params: { ...generation.params, seed: 59 } } });
    await useStore.getState().save(true);
    let saved = (records.get("project-library") as Record<string, { project: Project }>).project.project;
    expect(saved.canvases[0].nodes[0]).toMatchObject({ width: 360, height: 203, data: { assetId: "old-result", generation: { taskId: "old-task", params: { seed: 59 } } } });
    useStore.getState().createTask(task("new-task", "uploading"));
    await useStore.getState().save(true);
    saved = (records.get("project-library") as Record<string, { project: Project }>).project.project;
    expect(saved.canvases[0].nodes[0]).toMatchObject({ width: 200, height: 180, measured: { width: 200, height: 180 }, data: { generation: { taskId: "new-task" } } });
    expect(saved.canvases[0].nodes[0].data.assetId).toBeUndefined();
    expect(saved.history[0].outputs).toEqual(["old-result"]);
  });

  it.each(["uploading", "submitting", "queued", "loading", "generating", "saving", "interrupted"] as const)("does not detach a %s task if parameters change", status => {
    const p = project(); p.tasks["old-task"].status = status; useStore.setState({ project: p });
    const before = structuredClone(p.canvases[0].nodes[0].data);
    useStore.getState().patchNode("node", { generation: { ...before.generation!, params: { seed: 59 } } });
    const after = useStore.getState().project.canvases[0].nodes[0].data;
    expect(after.assetId).toBe(before.assetId); expect(after.mediaEdit).toEqual(before.mediaEdit); expect(after.generation?.taskId).toBe("old-task");
    expect(useStore.getState().project.tasks["old-task"]).toEqual(p.tasks["old-task"]);
  });

  it("clears the previous display immediately on a new task and refuses late completion into a different task", () => {
    useStore.setState({ project: project("text") });
    useStore.getState().createTask(task("new-task", "submitting"));
    let p = useStore.getState().project;
    expect(p.canvases[0].nodes[0].data).toMatchObject({ assetId: undefined, text: undefined, generation: { taskId: "new-task" } });
    const old = { ...p.tasks["old-task"], status: "saving" as const };
    useStore.getState().editProject(current => ({ ...current, tasks: { ...current.tasks, "old-task": old } }));
    useStore.getState().complete("old-task", [asset("late-result")], entry("late-history", "late-result"));
    p = useStore.getState().project;
    expect(p.canvases[0].nodes[0].data.assetId).toBeUndefined(); expect(p.canvases[0].nodes[0].data.generation?.taskId).toBe("new-task");
    expect(p.assets["late-result"].inLibrary).toBe(false); expect(p.history[0].outputs).toEqual(["late-result"]);
  });
});
