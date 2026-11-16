import { describe, expect, it } from "vitest";
import { resolveInputs, workflowInputRoleLabel, workflowInputRoleOptions } from "../src/semantic/resolver";
import type { Asset, Canvas, Role, WorkflowDefinition } from "../src/types";

type Slot = NonNullable<WorkflowDefinition["inputSlots"]>[number];
const image = (id: string, kind: Asset["kind"] = "image"): Asset => ({ id, kind, name: id + ".png", mime: kind + "/png", size: 1, createdAt: 1 });
function workflow(slots: Slot[]): WorkflowDefinition {
  return { id: "own", name: "Own workflow", family: "Custom", description: "", mode: "image-to-image", promptRequired: false,
    parameters: [], inputSlots: slots, requiredInputs: slots.filter(slot => slot.required).map(slot => slot.semantic), optionalInputs: slots.filter(slot => !slot.required).map(slot => slot.semantic),
    mapping: slots.map((slot, index) => ({ semantic: slot.semantic, nodeId: "loader" + index, field: "image" })), output: { nodeId: "out", field: "images", kind: "image" } };
}
function canvas(roles: Role[]): Canvas {
  return { id: "c", name: "Canvas", sceneId: "s", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
    ...roles.map((_role, index) => ({ id: "source" + index, position: { x: 0, y: 0 }, data: { kind: "reference" as const, title: "Reference " + (index + 1), assetId: "asset" + index } })),
    { id: "target", position: { x: 0, y: 0 }, data: { kind: "image-generation", title: "Own workflow" } }],
    edges: roles.map((role, index) => ({ id: "edge" + index, source: "source" + index, target: "target", data: { role, order: index } })) };
}
const first: Slot = { semantic: "slot:first", label: "人物图片", kind: "image", required: true };
const second: Slot = { semantic: "slot:second", label: "服装图片", kind: "image", required: true };

describe("imported workflow input routing", () => {
  it("reserves a later explicit input so an earlier AUTO connection cannot take it", () => {
    const inputs = resolveInputs(canvas(["auto", "slot:first"]), "target", workflow([first, second]), { asset0: image("asset0"), asset1: image("asset1") });
    expect(inputs.map(input => input.semantic)).toEqual(["slot:second", "slot:first"]);
  });

  it("assigns AUTO to remaining required inputs before earlier optional ones", () => {
    const optional = { ...first, semantic: "slot:optional", label: "可选参考", required: false };
    const inputs = resolveInputs(canvas(["auto"]), "target", workflow([optional, second]), { asset0: image("asset0") });
    expect(inputs[0].semantic).toBe("slot:second");
  });

  it("preserves an explicit optional input and tells the user a required input still needs an asset", () => {
    const optional = { ...second, required: false };
    expect(() => resolveInputs(canvas(["slot:second"]), "target", workflow([first, optional]), { asset0: image("asset0") }))
      .toThrow("已连接 1 张图片；仍缺 1 个必需输入：人物图片");
  });

  it("summarizes several missing inputs without implying that the existing connection disappeared", () => {
    const slots = Array.from({ length: 6 }, (_value, index) => ({ ...first, semantic: "slot:ref" + index, label: "参考图片 " + (index + 1) }));
    expect(() => resolveInputs(canvas(["auto"]), "target", workflow(slots), { asset0: image("asset0") }))
      .toThrow("已连接 1 张图片；仍缺 5 个必需输入：参考图片 2、参考图片 3、参考图片 4等 5 项。请连接素材");
  });

  it("rejects duplicate explicit inputs using the workflow input label", () => {
    expect(() => resolveInputs(canvas(["slot:first", "slot:first"]), "target", workflow([first, second]), { asset0: image("asset0"), asset1: image("asset1") }))
      .toThrow("输入「人物图片」的角色重复");
  });

  it("does not silently reassign a removed explicit input", () => {
    expect(() => resolveInputs(canvas(["slot:removed"]), "target", workflow([first]), { asset0: image("asset0") }))
      .toThrow("指定的输入已不存在于当前工作流");
  });

  it("rejects the wrong media kind for an explicit input", () => {
    expect(() => resolveInputs(canvas(["slot:first"]), "target", workflow([first]), { asset0: image("asset0", "video") }))
      .toThrow("输入「人物图片」需要图片素材；当前连接的是视频");
  });

  it("keeps first and last frame aliases reserved for imported image inputs", () => {
    const inputs = resolveInputs(canvas(["auto", "firstFrame"]), "target", workflow([first, second]), { asset0: image("asset0"), asset1: image("asset1") });
    expect(inputs.map(input => input.semantic)).toEqual(["slot:second", "slot:first"]);
    expect(() => resolveInputs(canvas(["lastFrame"]), "target", workflow([first, second]), { asset0: image("asset0", "video") }))
      .toThrow("首尾帧角色需要图片素材");
  });

  it("filters actual slot choices by media type and shows required / optional markers", () => {
    const video: Slot = { semantic: "slot:video", label: "原视频", kind: "video", required: false };
    const options = workflowInputRoleOptions(workflow([first, video]), "image");
    expect(options).toEqual([{ value: "auto", label: "自动分配" }, { value: "slot:first", label: "人物图片 · 必需" }]);
    expect(workflowInputRoleOptions(workflow([first, video]), "video")).toContainEqual({ value: "slot:video", label: "原视频 · 可选" });
    expect(workflowInputRoleLabel(workflow([first, video]), "slot:video", "video")).toBe("原视频 · 可选");
  });

  it("shows a saved but removed role so it can be corrected, and preserves the legacy role list", () => {
    expect(workflowInputRoleOptions(workflow([first]), "image", "slot:removed")).toContainEqual({ value: "slot:removed", label: "输入已移除，请重新选择" });
    const legacy = workflow([first]); delete legacy.inputSlots;
    expect(workflowInputRoleOptions(legacy, "image")).toContainEqual({ value: "firstFrame", label: "首帧" });
  });
});
