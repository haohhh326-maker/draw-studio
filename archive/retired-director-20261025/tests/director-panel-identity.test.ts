import { describe, expect, it, vi } from "vitest";

const live = vi.hoisted(() => ({ project: { id: "original", activeCanvasId: "canvas" } }));
vi.mock("../src/stores/store", () => ({ useStore: (selector: any) => selector(live) }));
vi.mock("../src/director/node-actions", () => ({ deleteDirectorNode: vi.fn(), isDirectorDeleteKey: vi.fn(), selectDirectorNode: vi.fn() }));
import { DirectorNode } from "../src/director/DirectorNode";

function findPanel(tree: any): any {
  if (Array.isArray(tree)) return tree.map(findPanel).find(Boolean);
  if (!tree || typeof tree !== "object" || !tree.props) return;
  if (tree.props.nodeId) return tree;
  return findPanel(tree.props.children);
}
const panel = (id = "director") => findPanel((DirectorNode as any).type({
  id, data: { title: "Director", kind: "director" }, selected: true,
}));

describe("director panel instance identity", () => {
  it("recreates the panel for an imported project copy retaining the same canvas/node ids", () => {
    live.project = { id: "original", activeCanvasId: "canvas" };
    const original = panel();
    live.project = { ...live.project, id: "imported-copy" };
    const imported = panel();
    expect(imported.props.nodeId).toBe(original.props.nodeId);
    expect(imported.type).toBe(original.type);
    expect(imported.key).not.toBe(original.key);
    expect(panel().key).toBe(imported.key);
  });

  it("separates canvases and nodes while retaining a stable key during ordinary edits", () => {
    live.project = { id: "project", activeCanvasId: "canvas-a" };
    const key = panel().key;
    expect(panel().key).toBe(key);
    expect(panel("another-director").key).not.toBe(key);
    live.project = { ...live.project, activeCanvasId: "canvas-b" };
    expect(panel().key).not.toBe(key);
  });
});
