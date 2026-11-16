import { describe, expect, it } from "vitest";
import { museWorkflows } from "../src/muse/catalog";
import { resolveInputs, workflowInputRoleLabel, workflowInputRoleOptions } from "../src/semantic/resolver";
import type { Asset, Canvas, Role } from "../src/types";

function fixture(kinds: Asset["kind"][], roles: Role[] = []) {
  const assets = Object.fromEntries(kinds.map((kind, index) => ["asset" + index, {
    id: "asset" + index, name: "reference" + index, kind, mime: kind + "/test", size: 1, createdAt: 1,
  } satisfies Asset]));
  const canvas: Canvas = {
    id: "canvas", sceneId: "scene", name: "Muse", viewport: { x: 0, y: 0, zoom: 1 },
    nodes: kinds.map((_kind, index) => ({ id: "source" + index, position: { x: 0, y: 0 }, data: { kind: "reference", title: "Reference " + index, assetId: "asset" + index } })),
    edges: kinds.map((_kind, index) => ({ id: "edge" + index, source: "source" + index, target: "target", data: { role: roles[index] ?? "auto", order: index } })),
  };
  return { canvas, assets };
}

describe("Muse reference routing", () => {
  it.each(museWorkflows)("routes mixed references in edge order for $id without graph slots", workflow => {
    const { canvas, assets } = fixture(["image", "video", "audio", "image", "video", "audio"]);
    canvas.edges.reverse();
    expect(workflow.inputSlots).toBeUndefined();
    expect(workflow.mapping).toEqual([]);
    const inputs = resolveInputs(canvas, "target", workflow, assets);
    expect(inputs.map(input => input.asset.id)).toEqual(Object.keys(assets));
    expect(inputs.map(input => input.semantic)).toEqual(["referenceImages", "referenceVideos", "referenceAudios", "referenceImages", "referenceVideos", "referenceAudios"]);
  });

  it("keeps existing explicitly assigned image references usable", () => {
    const { canvas, assets } = fixture(["image", "image", "image", "image", "image"], ["slot:muse-image-1", "slot:muse-image-2", "slot:muse-image-3", "slot:muse-image-4", "auto"]);
    expect(resolveInputs(canvas, "target", museWorkflows[0], assets)).toHaveLength(5);
    expect(workflowInputRoleLabel(museWorkflows[0], "slot:muse-image-1", "image")).toBe("参考图片");
  });

  it("does not apply another workflow's stale input slot to Muse", () => {
    const { canvas, assets } = fixture(["image"], ["slot:another-workflow"]);
    expect(() => resolveInputs(canvas, "target", museWorkflows[0], assets)).toThrow("不适用于 Muse");
  });

  it.each(["video", "audio"] as const)("rejects image roles on %s media", kind => {
    const { canvas, assets } = fixture([kind], ["slot:muse-image-1"]);
    expect(() => resolveInputs(canvas, "target", museWorkflows[0], assets)).toThrow("需要图片素材");
  });

  it.each(["file", "text"] as const)("rejects unsupported %s assets", kind => {
    const { canvas, assets } = fixture([kind]);
    expect(() => resolveInputs(canvas, "target", museWorkflows[0], assets)).toThrow("仅支持图片、视频和音频");
  });

  it("reports missing local asset metadata instead of dropping the connection", () => {
    const { canvas } = fixture(["video"]);
    expect(() => resolveInputs(canvas, "target", museWorkflows[0], {})).toThrow("尚未准备好");
  });

  it.each([
    ["image", "referenceImage", "参考图片"], ["video", "referenceVideo", "参考视频"], ["audio", "referenceAudio", "参考音频"],
  ] as const)("offers the %s reference role in the connection menu", (kind, value, label) => {
    expect(workflowInputRoleOptions(museWorkflows[0], kind)).toEqual([{ value: "auto", label: "自动分配" }, { value, label }]);
  });
});
