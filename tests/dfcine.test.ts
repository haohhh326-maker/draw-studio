import { describe, expect, it } from "vitest";
import { dfcineWorkflows } from "../src/workflow/dfcine";
import { catalog, withBuiltinBindings } from "../src/workflow/catalog";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { resolveInputs } from "../src/semantic/resolver";
import { outputFiles } from "../src/comfyui/client";
import type { Asset, Canvas, CanvasNode } from "../src/types";

const node: CanvasNode = {
  id: "dest",
  position: { x: 0, y: 0 },
  data: {
    kind: "video",
    title: "视频",
    generation: {
      workflowId: "unused",
      prompt: "测试提示词",
      negativePrompt: "",
      params: { seed: 58, duration: 5 },
      taskId: null,
    },
  },
};
const assets: Record<string, Asset> = Object.fromEntries(
  ["a", "b", "c"].map((id) => [
    id,
    {
      id,
      name: id + ".png",
      kind: "image",
      mime: "image/png",
      size: 1,
      createdAt: 0,
    },
  ]),
);
function canvas(count: number): Canvas {
  const ids = Object.keys(assets).slice(0, count);
  return {
    id: "c",
    name: "c",
    sceneId: "s",
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      node,
      ...ids.map((id) => ({
        id,
        position: { x: 0, y: 0 },
        data: { kind: "reference" as const, title: id, assetId: id },
      })),
    ],
    edges: ids
      .map((id, order) => ({
        id,
        source: id,
        target: "dest",
        data: { role: "auto" as const, order },
      }))
      .reverse(),
  };
}
describe("audited DFCine recipes", () => {
  it.each(dfcineWorkflows)(
    "stages and reads $name without altering its graph",
    (w) => {
      const count = w.mode === "multi-reference" ? 2 : 1;
      const before = structuredClone(w.template!);
      const inputs = resolveInputs(canvas(count), "dest", w, assets);
      const result = buildWorkflow(
        w,
        node,
        inputs,
        { a: "infinite-canvas/task/a.png", b: "infinite-canvas/task/b.png" },
        "infinite-canvas/task/result",
      );
      const graph = result.workflow;
      expect(w.template).toEqual(before);
      expect(graph["138"].inputs.value).toBe("测试提示词");
      expect(graph["132"].inputs.value).toBe(5);
      expect(graph["129"].inputs.noise_seed).toBe(58);
      expect(graph["92"].inputs.filename_prefix).toBe(
        "infinite-canvas/task/result",
      );
      const loaders = Object.values(graph).filter(
        (n) => n.class_type === "Image Load",
      );
      expect(loaders.map((n) => n.inputs.image_path)).toEqual(
        Object.keys(assets)
          .slice(0, count)
          .map((id) => `input/infinite-canvas/task/${id}.png`),
      );
      for (const [id, n] of Object.entries(before)) {
        expect(graph[id].class_type).toBe(n.class_type);
        for (const [field, value] of Object.entries(n.inputs))
          if (Array.isArray(value))
            expect(graph[id].inputs[field]).toEqual(value);
      }
      expect(graph["124"].inputs.steps).toBe(
        w.family.endsWith("加速") ? 4 : 20,
      );
      const file = {
        filename: "result_00001_.mp4",
        subfolder: "infinite-canvas/task",
        type: "output" as const,
      };
      expect(outputFiles({ outputs: { "92": { images: [file] } } }, w)).toEqual(
        [file],
      );
      expect(() =>
        buildWorkflow(w, node, inputs, { a: "../other.png", b: "b.png" }),
      ).toThrow("相对路径");
    },
  );
  it("rejects a missing second image and excess images before upload", () => {
    const w = dfcineWorkflows[1];
    expect(() =>
      buildWorkflow(w, node, resolveInputs(canvas(1), "dest", w, assets), {
        a: "a.png",
      }),
    ).toThrow("缺少输入");
    expect(() => resolveInputs(canvas(3), "dest", w, assets)).toThrow("容量");
    expect(() =>
      resolveInputs(canvas(2), "dest", dfcineWorkflows[0], assets),
    ).toThrow("重复");
  });
  it("restores source placeholders only from the current directory snapshot and preserves custom bindings", () => {
    const bound = catalog.find(w => w.output.kind === "video" && w.original?.id && w.template)!;
    const placeholder = { ...bound, template: undefined, mapping: [] };
    const custom = { ...dfcineWorkflows[1], id: "my-custom-dfcine", name: "my custom workflow" };
    const saved = [placeholder, custom];
    const sourcePath = "E:/test-workflow-library";
    const loaded = { ...structuredClone(bound), id: "library-" + encodeURIComponent(bound.original!.id), name: "Current directory binding", library: { sourcePath, folder: "Current-Workflow", runnerType: "comfyui" } };
    const result = withBuiltinBindings(saved, [loaded], sourcePath);
    expect(result.find((w) => w.id === bound.id)).toEqual({ ...loaded, id: bound.id });
    expect(result.find((w) => w.id === custom.id)).toBe(custom);
    expect(result).toHaveLength(2);
    expect(saved[0].template).toBeUndefined();
    expect(withBuiltinBindings(saved, [], sourcePath)).toEqual([custom]);
    expect(withBuiltinBindings(result, [], sourcePath)).toEqual([custom]);
  });
});
