import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../src/types";
import type { OptimizationContext, OptimizationSettings } from "../src/prompt-optimization/types";
const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/projects/storage", () => ({
  readRecord: async (key: string) => structuredClone(records.get(key)),
  writeRecord: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
  safeConnection: (value: object) => value,
  getBlob: vi.fn(),
}));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));
import { useStore } from "../src/stores/store";
import { createOptimizationOperations } from "../src/prompt-optimization/operations";
import { createPromptDraftSessions } from "../src/prompt-optimization/prompt-drafts";
import { readOptimizationPrompt } from "../src/prompt-optimization/context";
import { encodePromptMention } from "../src/semantic/mentions";

const registries: ReturnType<typeof createOptimizationOperations>[] = [];
const mention = encodePromptMention("reference", "人物 A");
const original = `保留 ${mention}，向前走。`, optimized = `保持 ${mention} 的身份，缓步走向镜头。`;
const scope = { projectId: "draft-persistence", canvasId: "canvas", nodeId: "node", field: "generation" as const };
const current = () => useStore.getState().project.canvases[0].nodes[0];
function registry() {
  const drafts = createPromptDraftSessions();
  const operations = createOptimizationOperations({ readState: useStore.getState, subscribe: listener => useStore.subscribe(listener), drafts,
    settings: async () => ({ readMedia: false }) as OptimizationSettings,
    collect: async () => ({} as OptimizationContext),
    optimize: async () => ({ prompt: optimized, modelId: "test", analyzedImages: 0, warnings: [], skill: { id: "text", name: "Text", level: "generic" } }),
  });
  registries.push(operations);
  return { operations, drafts };
}
beforeEach(() => {
  records.clear();
  const session = new Map<string, string>([["clearframe-open-project", scope.projectId]]);
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value), removeItem: (key: string) => session.delete(key) });
  const project: Project = { version: 2, id: scope.projectId, name: "Test", scenes: [], activeCanvasId: scope.canvasId, updatedAt: 1, assets: {}, tasks: {}, history: [],
    canvases: [{ id: "canvas", name: "Canvas", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 }, edges: [], nodes: [
      { id: "node", position: { x: 0, y: 0 }, data: { kind: "text", title: "Text", text: "独立文本", generation: { prompt: original, negativePrompt: "keep", workflowId: "", params: { seed: 42 }, taskId: null } } },
    ] }],
  };
  useStore.setState({ project, projectOpen: true, projects: {}, ready: false, navigating: false, workflows: [], runningHubWorkflows: [], past: [], future: [], selectedId: "node" });
});
afterEach(() => { for (const item of registries.splice(0)) item.dispose(); vi.unstubAllGlobals(); });

async function refresh() {
  await useStore.getState().save(true);
  for (const item of registries.splice(0)) item.dispose();
  useStore.setState({ projectOpen: false, projects: {}, ready: false });
  await useStore.getState().hydrate();
  return registry();
}

describe("saved original and optimized prompts", () => {
  it("retains both versions after saving, hydration and a fresh draft registry", async () => {
    const first = registry();
    await first.operations.start(scope);
    expect(current().data.generation?.prompt).toBe(optimized);
    const fresh = await refresh();
    fresh.operations.switchVersion(scope, "original");
    expect(current().data.generation?.prompt).toBe(original);
    fresh.operations.switchVersion(scope, "optimized");
    expect(current().data.generation?.prompt).toBe(optimized);
    expect(current().data.text).toBe("独立文本");
    expect(current().data.generation).toMatchObject({ negativePrompt: "keep", params: { seed: 42 } });
  });

  it("saves edits to the displayed version and keeps independent note drafts", async () => {
    const first = registry();
    await first.operations.start(scope);
    useStore.getState().patchNode("node", { generation: { ...current().data.generation!, prompt: optimized + " 光线柔和。" } });
    first.operations.switchVersion(scope, "original");
    useStore.getState().patchNode("node", { generation: { ...current().data.generation!, prompt: original + " 修改原稿。" } });
    const textScope = { ...scope, field: "text" as const };
    await first.operations.start(textScope);
    useStore.getState().patchNode("node", { text: "修改后的优化笔记" });
    const fresh = await refresh();
    expect(readOptimizationPrompt(current(), "generation")).toBe(original + " 修改原稿。");
    fresh.operations.switchVersion(scope, "optimized");
    expect(readOptimizationPrompt(current(), "generation")).toBe(optimized + " 光线柔和。");
    fresh.operations.switchVersion(textScope, "original");
    expect(current().data.text).toBe("独立文本");
    fresh.operations.switchVersion(textScope, "optimized");
    expect(current().data.text).toBe("修改后的优化笔记");
  });

  it("keeps the pair when saving after undoing the first optimization", async () => {
    const first = registry();
    await first.operations.start(scope);
    useStore.getState().undo();
    expect(current().data.generation?.prompt).toBe(original);
    const fresh = await refresh();
    fresh.operations.switchVersion(scope, "optimized");
    expect(current().data.generation?.prompt).toBe(optimized);
  });

  it("retains an empty original and the selected version when reopening", async () => {
    useStore.getState().patchNode("node", { generation: { ...current().data.generation!, prompt: "" } });
    const first = registry();
    await first.operations.start(scope);
    first.operations.switchVersion(scope, "original");
    const fresh = await refresh();
    expect(current().data.generation?.prompt).toBe("");
    expect(fresh.drafts.get(fresh.operations.key(scope))).toEqual({ original: "", optimized, version: "original" });
    fresh.operations.switchVersion(scope, "optimized");
    expect(current().data.generation?.prompt).toBe(optimized);
  });

  it("treats a direct edit matching the other saved buffer as an edit after reopening", async () => {
    const first = registry();
    await first.operations.start(scope);
    useStore.getState().patchNode("node", { generation: { ...current().data.generation!, prompt: original } });
    const fresh = await refresh();
    expect(fresh.drafts.get(fresh.operations.key(scope))).toEqual({ original, optimized: original, version: "optimized" });
  });

  it("does not manufacture an original for legacy nodes that only contain optimized text", async () => {
    useStore.getState().patchNode("node", { generation: { ...current().data.generation!, prompt: "legacy saved text" } });
    const fresh = await refresh();
    fresh.operations.switchVersion(scope, "original");
    expect(current().data.generation?.prompt).toBe("legacy saved text");
    expect(fresh.drafts.get(fresh.operations.key(scope))?.optimized).toBeUndefined();
  });
});
