import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../src/types";

vi.mock("../src/projects/storage", () => ({ readRecord: async () => undefined, writeRecord: async () => {}, safeConnection: (value: object) => value, getBlob: vi.fn() }));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));

import { useStore } from "../src/stores/store";
import { isPromptHistoryRestore, promptDraftKey, promptDraftSessions } from "../src/prompt-optimization/prompt-drafts";
import { optimizationPromptPatch, readOptimizationPrompt, type OptimizationPromptField } from "../src/prompt-optimization/context";
// Register the same history observer used by mounted editors; no React renderer or AI call is needed.
import "../src/prompt-optimization/use-prompt-optimization";

let sequence = 0;
beforeEach(() => {
  const project: Project = {
    version: 2, id: "draft-history-" + ++sequence, name: "Test", activeCanvasId: "canvas", scenes: [], updatedAt: 1,
    canvases: [{ id: "canvas", name: "Canvas", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 }, edges: [],
      nodes: [{ id: "node", type: "media", position: { x: 0, y: 0 }, data: { kind: "text", title: "Text", text: "text optimized",
        generation: { workflowId: "", prompt: "generation optimized", negativePrompt: "keep", params: { seed: 58 }, taskId: null } } }] }],
    assets: {}, tasks: {}, history: [],
  };
  useStore.setState({ project, projects: {}, projectOpen: true, navigating: false, ready: false, workflows: [], selectedId: "node", past: [], future: [] });
});

const currentNode = () => useStore.getState().project.canvases[0].nodes[0];
const keyFor = (field: OptimizationPromptField) => promptDraftKey(useStore.getState().project.id, "canvas", "node", field);
const savePair = (field: OptimizationPromptField) => {
  const key = keyFor(field), source = promptDraftSessions.capture(key, field + " original");
  promptDraftSessions.complete(key, source, field + " optimized");
  return key;
};
const observeEditor = (field: OptimizationPromptField) => useStore.subscribe(() => {
  promptDraftSessions.capture(keyFor(field), readOptimizationPrompt(currentNode(), field));
});

describe("prompt draft canvas undo/redo integration", () => {
  it("keeps generation buffers across toggle, undo and unselected redo with a separate text editor", () => {
    const field = "generation" as const;
    const key = savePair(field), otherField = field === "text" ? "generation" : "text", otherKey = savePair(otherField);
    const stopEditor = observeEditor(field), stopOtherEditor = observeEditor(otherField);
    try {
      const state = useStore.getState();
      state.checkpoint();
      const next = promptDraftSessions.switchVersion(key, readOptimizationPrompt(currentNode(), field))!;
      state.patchNode("node", optimizationPromptPatch(currentNode(), next.original, field)!, "canvas");
      expect(promptDraftSessions.get(key)).toEqual({ original: field + " original", optimized: field + " optimized", version: "original" });
      state.undo();
      expect(useStore.getState().selectedId).toBeNull();
      expect(readOptimizationPrompt(currentNode(), field)).toBe(field + " optimized");
      expect(promptDraftSessions.get(key)?.version).toBe("optimized");
      // Undo unmounts selected-text controls. Redo must reconcile their drafts without an editor listener.
      stopEditor();
      useStore.getState().redo();
      expect(readOptimizationPrompt(currentNode(), field)).toBe(field + " original");
      expect(promptDraftSessions.get(key)).toEqual({ original: field + " original", optimized: field + " optimized", version: "original" });
      expect(promptDraftSessions.get(otherKey)).toEqual({ original: otherField + " original", optimized: otherField + " optimized", version: "optimized" });
      // Returning to the node does not reinterpret the restored text as edits to the wrong side.
      promptDraftSessions.capture(key, readOptimizationPrompt(currentNode(), field));
      expect(promptDraftSessions.get(key)?.original).toBe(field + " original");
      expect(currentNode().data.generation).toMatchObject({ negativePrompt: "keep", params: { seed: 58 } });
    } finally { stopEditor(); stopOtherEditor(); }
  });

  it("restores plain text-note drafts across undo and redo after its selected editor unmounts", () => {
    useStore.getState().patchNode("node", { generation: undefined });
    const key = savePair("text"), stopEditor = observeEditor("text");
    try {
      useStore.getState().checkpoint();
      const next = promptDraftSessions.switchVersion(key, currentNode().data.text!)!;
      useStore.getState().patchNode("node", { text: next.original });
      useStore.getState().undo();
      expect(currentNode().data.text).toBe("text optimized");
      expect(promptDraftSessions.get(key)?.version).toBe("optimized");
      stopEditor();
      useStore.getState().redo();
      expect(currentNode().data.text).toBe("text original");
      expect(promptDraftSessions.get(key)).toEqual({ original: "text original", optimized: "text optimized", version: "original" });
      expect(currentNode().data.generation).toBeUndefined();
    } finally { stopEditor(); }
  });

  it("respects existing undo policy that preserves text generation outputs without flipping drafts", () => {
    const key = savePair("text"), stopEditor = observeEditor("text");
    try {
      useStore.getState().checkpoint();
      const next = promptDraftSessions.switchVersion(key, currentNode().data.text!)!;
      useStore.getState().patchNode("node", { text: next.original });
      useStore.getState().undo();
      expect(currentNode().data.text).toBe("text original");
      stopEditor();
      useStore.getState().redo();
      expect(promptDraftSessions.get(key)).toEqual({ original: "text original", optimized: "text optimized", version: "original" });
    } finally { stopEditor(); }
  });

  it("treats a direct edit matching the other buffer as an edit, without changing versions", () => {
    const key = savePair("generation"), stopEditor = observeEditor("generation");
    try {
      useStore.getState().patchNode("node", optimizationPromptPatch(currentNode(), "generation original", "generation")!);
      expect(promptDraftSessions.get(key)).toEqual({ original: "generation original", optimized: "generation original", version: "optimized" });
    } finally { stopEditor(); }
  });

  it("distinguishes actual canvas restore transitions from checkpoints, edits and project replacement", () => {
    const beforeCheckpoint = useStore.getState();
    beforeCheckpoint.checkpoint();
    const checkpointed = useStore.getState();
    expect(isPromptHistoryRestore(checkpointed, beforeCheckpoint)).toBe(false);
    checkpointed.patchNode("node", { text: "edited" });
    const edited = useStore.getState();
    expect(isPromptHistoryRestore(edited, checkpointed)).toBe(false);
    edited.undo();
    const undone = useStore.getState();
    expect(isPromptHistoryRestore(undone, edited)).toBe(true);
    undone.redo();
    const redone = useStore.getState();
    expect(isPromptHistoryRestore(redone, undone)).toBe(true);
    expect(isPromptHistoryRestore({ ...redone, project: { ...redone.project, id: "different-project" } }, undone)).toBe(false);
  });
});
