import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Canvas, CanvasNode, Kind } from "../src/types";
import {
  closeGenerationPanelTarget, nextGenerationPanelTarget, openGenerationPanelTarget,
  resolveGenerationPanelTarget, resolvePanelEditorTarget, resolveTextPanelTarget,
  syncGenerationPanelTarget, useGenerationPanelState,
} from "../src/generation/generation-panel-state";

function node(id: string, kind: Kind, generation = true): CanvasNode {
  return { id, position: { x: 20, y: 20 }, data: { title: id, kind,
    ...(generation ? { generation: { prompt: "原始提示词", negativePrompt: "", workflowId: "w", params: {}, taskId: null } } : {}),
    ...(kind === "text" ? { text: "独立文本" } : {}),
  } };
}
function canvas(): Canvas {
  return { id: "canvas", name: "画布", sceneId: "scene", nodes: [
    node("image", "image-generation"), node("video", "video"), node("audio", "audio"), node("text", "text"),
    node("legacy-note", "text", false), node("reference", "reference", false),
  ], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
}
beforeEach(() => useGenerationPanelState.setState({ target: null }));

describe("visible generation editor selection", () => {
  it("does not scan a large canvas while its editor selection is empty", () => {
    const current = canvas();
    const reads = vi.fn();
    current.nodes = Array.from({ length: 5000 }, (_, index) => ({
      ...node(String(index), "image-generation"),
      get id() { reads(); return String(index); },
    }));
    expect(nextGenerationPanelTarget(null, "project", current, null)).toBeNull();
    expect(reads).not.toHaveBeenCalled();
  });
  it.each(["image", "video", "audio", "text"])("closes %s prompt editor on blank/reference selection without clearing its text", id => {
    const current = canvas(), before = structuredClone(current);
    syncGenerationPanelTarget("project", current, id);
    const target = useGenerationPanelState.getState().target;
    expect(resolveGenerationPanelTarget(target, "project", current)?.id).toBe(id);
    syncGenerationPanelTarget("project", current, null);
    expect(useGenerationPanelState.getState().target).toBeNull();
    expect(resolveGenerationPanelTarget(useGenerationPanelState.getState().target, "project", current)).toBeUndefined();
    syncGenerationPanelTarget("project", current, id);
    syncGenerationPanelTarget("project", current, "reference");
    expect(useGenerationPanelState.getState().target).toBeNull();
    current.viewport = { x: -3000, y: 900, zoom: 0.5 };
    syncGenerationPanelTarget("project", current, null);
    expect(useGenerationPanelState.getState().target).toBeNull();
    syncGenerationPanelTarget("project", current, id);
    expect(resolveGenerationPanelTarget(target, "project", current)?.data.generation?.prompt).toBe("原始提示词");
    expect(current.nodes).toEqual(before.nodes);
  });
  it("switches to the newly selected editable node and resolves its own prompt", () => {
    const current = canvas(); current.nodes[1].data.generation!.prompt = "另一个节点的原文";
    syncGenerationPanelTarget("project", current, "image");
    syncGenerationPanelTarget("project", current, "video");
    expect(resolveGenerationPanelTarget(useGenerationPanelState.getState().target, "project", current)?.data.generation?.prompt).toBe("另一个节点的原文");
    expect(current.nodes[0].data.generation?.prompt).toBe("原始提示词");
  });
  it("shows legacy text controls only while selected without creating generation state", () => {
    const current = canvas();
    syncGenerationPanelTarget("project", current, "legacy-note");
    const target = useGenerationPanelState.getState().target;
    expect(resolvePanelEditorTarget(target, "project", current)?.id).toBe("legacy-note");
    expect(resolveTextPanelTarget(target, "project", current)?.data.text).toBe("独立文本");
    expect(resolveGenerationPanelTarget(target, "project", current)).toBeUndefined();
    syncGenerationPanelTarget("project", current, null);
    expect(resolveTextPanelTarget(useGenerationPanelState.getState().target, "project", current)).toBeUndefined();
    syncGenerationPanelTarget("project", current, "legacy-note");
    expect(resolveTextPanelTarget(useGenerationPanelState.getState().target, "project", current)?.data.text).toBe("独立文本");
    syncGenerationPanelTarget("project", current, "audio");
    expect(resolveTextPanelTarget(useGenerationPanelState.getState().target, "project", current)).toBeUndefined();
  });
  it("requires an explicit new editable selection after closing", () => {
    const current = canvas();
    openGenerationPanelTarget({ projectId: "project", canvasId: current.id, nodeId: "image" });
    closeGenerationPanelTarget();
    syncGenerationPanelTarget("project", current, null);
    syncGenerationPanelTarget("project", current, "reference");
    expect(useGenerationPanelState.getState().target).toBeNull();
    syncGenerationPanelTarget("project", current, "image");
    expect(useGenerationPanelState.getState().target?.nodeId).toBe("image");
  });
  it("rejects stale targets after project, canvas or node removal", () => {
    const current = canvas(), target = { projectId: "project", canvasId: current.id, nodeId: "image" };
    expect(resolvePanelEditorTarget(target, "other-project", current)).toBeUndefined();
    expect(resolvePanelEditorTarget(target, "project", { ...current, id: "other-canvas" })).toBeUndefined();
    current.nodes = current.nodes.filter(node => node.id !== "image");
    expect(nextGenerationPanelTarget(target, "project", current, null)).toBeNull();
    openGenerationPanelTarget(target); syncGenerationPanelTarget("project", current, null);
    expect(useGenerationPanelState.getState().target).toBeNull();
  });
  it("does not retain a node that no longer has an editable generation or note", () => {
    const current = canvas(), target = { projectId: "project", canvasId: current.id, nodeId: "image" };
    delete current.nodes[0].data.generation;
    expect(nextGenerationPanelTarget(target, "project", current, null)).toBeNull();
  });
  it("ignores content edits/reselection but publishes exactly one visible close on deselection", () => {
    const current = canvas(), changed = vi.fn(), unsubscribe = useGenerationPanelState.subscribe(changed);
    syncGenerationPanelTarget("project", current, "image");
    current.nodes[0].data.generation!.prompt = "修改原文";
    syncGenerationPanelTarget("project", current, "image");
    expect(changed).toHaveBeenCalledTimes(1);
    syncGenerationPanelTarget("project", current, null);
    expect(changed).toHaveBeenCalledTimes(2);
    closeGenerationPanelTarget(); closeGenerationPanelTarget();
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
