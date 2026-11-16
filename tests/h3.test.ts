import { describe, expect, it } from "vitest";
import { h3Workflows } from "../src/workflow/h3";
import {
  buildWorkflow,
  validateDefinition,
} from "../src/workflow-adapter/adapter";
import { catalog, withBuiltinBindings } from "../src/workflow/catalog";
import type { CanvasNode, Asset } from "../src/types";

const node: CanvasNode = {
  id: "n",
  position: { x: 0, y: 0 },
  data: {
    kind: "video",
    title: "test",
    generation: {
      workflowId: "unused",
      prompt: "test motion",
      negativePrompt: "",
      params: { seed: 58 },
      taskId: null,
    },
  },
};
const input = (semantic: string, id: string) => ({
  semantic,
  asset: {
    id,
    name: id,
    size: 1,
    kind: "image",
    mime: "image/png",
    createdAt: 0,
  } as Asset,
  edgeId: id,
});
describe("H3 task variants", () => {
  it.each(h3Workflows)("validates all fields in $name", (w) => {
    expect(() => validateDefinition(w)).not.toThrow();
  });
  it("pure text uses FL conditioning without stale image loaders", () => {
    const w = h3Workflows.find((w) => w.id === "preset-1-0")!;
    const { workflow: g } = buildWorkflow(w, node, [], {});
    expect(g["136"].class_type).toBe("MiniMaxH3ImageToVideo");
    expect(g["136"].inputs.first_frame).toBeUndefined();
    expect(
      Object.values(g).some((n) =>
        ["LoadImage", "Image Load"].includes(n.class_type),
      ),
    ).toBe(false);
    expect(g["127"].inputs.unet_name).toContain("fl2va");
    expect(g["153"].inputs.lora_name).toContain("8step");
    expect(g["124"].inputs.steps).toBe(8);
  });
  it("first and last frames remain distinct and require both files", () => {
    const w = h3Workflows.find((w) => w.id === "preset-1-2")!;
    const inputs = [input("firstFrame", "a"), input("lastFrame", "b")];
    const { workflow: g } = buildWorkflow(w, node, inputs, {
      a: "task/a.png",
      b: "task/b.png",
    });
    expect(g["136"].inputs.first_frame).toEqual(["frame0", 0]);
    expect(g["136"].inputs.last_frame).toEqual(["frame1", 0]);
    expect(g.frame0.inputs.image).toBe("task/a.png");
    expect(g.frame1.inputs.image).toBe("task/b.png");
    expect(() =>
      buildWorkflow(w, node, inputs.slice(0, 1), { a: "task/a.png" }),
    ).toThrow("缺少输入");
  });
  it("serializes variable reference lists in order, leaves absent videos empty, and checks capacity", () => {
    const w = h3Workflows.find((w) => w.id === "h3-turbo-mixed")!;
    const inputs = [
      input("referenceImages", "b"),
      input("referenceImages", "a"),
    ];
    const before = structuredClone(w.template);
    const { workflow: g } = buildWorkflow(w, node, inputs, {
      a: "task/a.png",
      b: "task/b.png",
    });
    expect(JSON.parse(g.media.inputs.image_paths as string)).toEqual([
      "task/b.png",
      "task/a.png",
    ]);
    expect(g.media.inputs.video_references).toBe("[]");
    expect(w.template).toEqual(before);
    expect(() =>
      buildWorkflow(
        w,
        node,
        Array.from({ length: 10 }, () => input("referenceImages", "a")),
        { a: "a.png" },
      ),
    ).toThrow("容量");
    expect(() =>
      buildWorkflow(w, node, inputs, { a: "../a.png", b: "b.png" }),
    ).toThrow("相对路径");
  });
  it("audio drive preserves original audio rather than decoding new audio", () => {
    const w = h3Workflows.find((w) => w.id === "h3-turbo-driven")!;
    const { workflow: g } = buildWorkflow(
      w,
      node,
      [input("referenceAudio", "a")],
      { a: "task/a.wav" },
    );
    expect(g.audio.inputs.audio).toBe("task/a.wav");
    expect(g["125"].inputs.latent_image).toEqual(["drive", 0]);
    expect(g["130"].inputs.audio).toEqual(["drive", 1]);
    expect(g["121"]).toBeUndefined();
  });
  it("takes H3 variant membership from the directory snapshot while preserving independent custom task definitions", () => {
    const directoryH3 = catalog.filter(w => w.family.startsWith("MiniMax H3") && w.original?.id);
    expect(directoryH3.length).toBeGreaterThan(1);
    const old = directoryH3.map(w => ({ ...w, template: undefined, mapping: [] }));
    const selected = directoryH3.find(w => w.template)!;
    const sourcePath = "E:/test-h3-library";
    const loaded = { ...structuredClone(selected), id: "library-" + encodeURIComponent(selected.original!.id), library: { sourcePath, folder: "Selected-H3", runnerType: "comfyui" } };
    const added = { ...structuredClone(h3Workflows.find(w => w.id === "h3-turbo-driven")!), id: "library-added-h3", name: "New directory H3 variant", library: { sourcePath, folder: "Added-H3", runnerType: "comfyui" } };
    const custom = { ...structuredClone(h3Workflows[0]), id: "custom-h3", name: "Independent custom H3" };
    const refreshed = withBuiltinBindings([...old, custom], [loaded, added], sourcePath);
    expect(refreshed.map(w => w.id)).toEqual([selected.id, added.id, custom.id]);
    expect(refreshed[0]).toEqual({ ...loaded, id: selected.id });
    expect(refreshed[1]).toBe(added);
    expect(refreshed[2]).toBe(custom);
    expect(old.every(w => w.template === undefined)).toBe(true);
    expect(withBuiltinBindings(refreshed, [], sourcePath)).toEqual([custom]);
    expect(withBuiltinBindings([custom], [], sourcePath)).toEqual([custom]);
  });
});
