import { resolveInputs } from "../src/semantic/resolver";
import { describe, it, expect } from "vitest";
import {
  buildWorkflow,
  validateDefinition,
} from "../src/workflow-adapter/adapter";
import { parseApiWorkflow } from "../src/workflow/catalog";
import type {
  WorkflowDefinition,
  Canvas,
  Asset,
  CanvasNode,
} from "../src/types";
const a = (id: string, kind: "image" | "video" = "image"): Asset => ({
  id,
  name: id + ".png",
  mime: kind + "/png",
  kind,
  size: 1,
  createdAt: 0,
});
const node: CanvasNode = {
  id: "dest",
  position: { x: 0, y: 0 },
  data: {
    title: "创作",
    kind: "video",
    generation: {
      prompt: "a fox",
      negativePrompt: "blur",
      workflowId: "w",
      params: { seed: -1 },
      taskId: null,
    },
  },
};
function workflow(
  mode: WorkflowDefinition["mode"] = "first-last-frame",
): WorkflowDefinition {
  return {
    id: "w",
    name: "Semantic adapter fixture",
    family: "Fixtures",
    description: "Independent legacy semantic mappings, without directory input slots.",
    mode,
    promptRequired: true,
    optionalInputs: ["prompt"],
    requiredInputs:
      mode === "first-last-frame" ? ["firstFrame", "lastFrame"] : [],
    parameters: [
      { key: "seed", label: "Seed", type: "number", default: -1, min: -1 },
    ],
    template: {
      "1": { class_type: "Text", inputs: { text: "old" } },
      "2": { class_type: "LoadImage", inputs: { image: "first.png" } },
      "3": { class_type: "LoadImage", inputs: { image: "last.png" } },
      "4": { class_type: "Sampler", inputs: { seed: 1, source: ["2", 0] } },
    },
    mapping: [
      { semantic: "prompt", nodeId: "1", field: "text" },
      { semantic: "firstFrame", nodeId: "2", field: "image" },
      { semantic: "lastFrame", nodeId: "3", field: "image" },
      { semantic: "seed", nodeId: "4", field: "seed" },
    ],
    output: { nodeId: "4", field: "gifs", kind: "video" },
  };
}
function canvas(): Canvas {
  return {
    id: "canvas",
    sceneId: "s",
    name: "c",
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "a",
        position: { x: 0, y: 0 },
        data: { kind: "reference", title: "A", assetId: "a" },
      },
      {
        id: "b",
        position: { x: 0, y: 0 },
        data: { kind: "reference", title: "B", assetId: "b" },
      },
      node,
    ],
    edges: [
      {
        id: "a-d",
        source: "a",
        target: "dest",
        data: { role: "auto", order: 10 },
      },
      {
        id: "b-d",
        source: "b",
        target: "dest",
        data: { role: "auto", order: 20 },
      },
    ],
  };
}
describe("workflow adapter", () => {
  it.each([undefined, 0, 1, 3])("preserves the configured dynamic reference starting index (%s)", (start) => {
    const w = workflow("image-to-image");
    w.requiredInputs = [];
    w.parameters = [];
    w.mapping = [{ semantic: "prompt", nodeId: "1", field: "text" }];
    w.template = {
      "1": { class_type: "TextEncodeQwenImage21", inputs: { text: "old", "images.image_1": ["2", 0] } },
      "2": { class_type: "LoadImage", inputs: { image: "example.png" } },
      "3": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
    };
    w.output = { nodeId: "3", field: "images", kind: "image" };
    w.dynamicReferences = {
      binding: { targetNodeId: "1" },
      constraints: { minTotal: 1 }, routes: { image: {
        maxItems: 16, prototypeNodeIds: ["2"], pathBinding: { nodeId: "2", path: "inputs.image" },
        output: { nodeId: "2", index: 0 }, targetInputPrefix: "images.image_",
        ...(start === undefined ? {} : { targetInputStartIndex: start }),
      } },
    };
    const before = structuredClone(w);
    const selected = ["a", "b"].map(id => ({ semantic: "dynamic:image", edgeId: id, asset: a(id) }));
    const built = buildWorkflow(w, node, selected, { a: "task/a.png", b: "task/b.png" }).workflow;
    const first = start ?? 0;
    expect(Object.keys(built["1"].inputs).filter(key => key.startsWith("images.")))
      .toEqual([`images.image_${first}`, `images.image_${first + 1}`]);
    const references = [first, first + 1].map(index => built[String((built["1"].inputs[`images.image_${index}`] as [string, number])[0])].inputs.image);
    expect(references).toEqual(["task/a.png", "task/b.png"]);
    expect(built["2"]).toBeUndefined();
    expect(w).toEqual(before);
  });
  it("accepts an explicitly mapped custom loader string and assigns distinct prefixes to multiple outputs", () => {
    const custom: WorkflowDefinition = {
      id: "custom-loader", name: "Custom", family: "Custom", description: "", mode: "image-to-image", promptRequired: false,
      parameters: [], requiredInputs: ["slot:reference"], optionalInputs: [],
      mapping: [{ semantic: "slot:reference", nodeId: "loader", field: "source_file", pathMode: "comfy-input" }],
      template: { loader: { class_type: "MyImageLoader", inputs: { source_file: "" } }, one: { class_type: "CustomSaver", inputs: { image: ["loader", 0], filename_prefix: "one" } }, two: { class_type: "OtherSaver", inputs: { image: ["loader", 0], filename_prefix: "two" } } },
      output: { nodeId: "one", field: "results", kind: "image" }, additionalOutputs: [{ nodeId: "two", field: "files", kind: "file", prefix: { nodeId: "two", field: "filename_prefix" } }],
    };
    const built = buildWorkflow(custom, node, [{ semantic: "slot:reference", edgeId: "edge", asset: a("a") }], { a: "task/reference.png" }, "task/result");
    expect(built.workflow.loader.inputs.source_file).toBe("input/task/reference.png");
    expect(built.workflow.one.inputs.filename_prefix).toBe("task/result"); expect(built.workflow.two.inputs.filename_prefix).toBe("task/result-output-1");
    expect(custom.template?.two.inputs.filename_prefix).toBe("two");
    custom.template!.loader.inputs.source_file = 123;
    expect(() => validateDefinition(custom)).toThrow("字符串素材字段");
    custom.template!.loader.inputs.source_file = "";
    custom.additionalOutputs![0].nodeId = "missing";
    expect(() => validateDefinition(custom)).toThrow("输出节点");
  });
  it("rejects two semantic inputs targeting the same field", () => {
    const w = workflow();
    w.mapping.push({ semantic: "lastFrame", nodeId: "2", field: "image" });
    expect(() => validateDefinition(w)).toThrow("同一字段");
  });
  it("assigns first/last by edge creation order", () => {
    const c = canvas();
    c.edges.reverse();
    expect(
      resolveInputs(c, "dest", workflow(), { a: a("a"), b: a("b") }).map(
        (i) => i.semantic,
      ),
    ).toEqual(["firstFrame", "lastFrame"]);
  });
  it("reserves an explicit first-frame role before AUTO assignment", () => {
    const c = canvas();
    c.edges[1].data!.role = "firstFrame";
    expect(
      resolveInputs(c, "dest", workflow(), { a: a("a"), b: a("b") }).map(
        (i) => i.semantic,
      ),
    ).toEqual(["lastFrame", "firstFrame"]);
  });
  it("rejects incomplete required inputs", () => {
    const c = canvas();
    c.edges.pop();
    expect(() => resolveInputs(c, "dest", workflow(), { a: a("a") })).toThrow(
      "lastFrame",
    );
  });
  it("rejects duplicate singleton roles", () => {
    const c = canvas();
    c.edges.forEach((e) => (e.data!.role = "firstFrame"));
    expect(() =>
      resolveInputs(c, "dest", workflow(), { a: a("a"), b: a("b") }),
    ).toThrow("重复");
  });
  it("rejects video in image role", () => {
    const c = canvas();
    c.edges[0].data!.role = "firstFrame";
    expect(() =>
      resolveInputs(c, "dest", workflow(), { a: a("a", "video"), b: a("b") }),
    ).toThrow("图片素材");
  });
  it("writes a clone, resolves random seed, and keeps Comfy graph links", () => {
    const w = workflow(),
      inputs = resolveInputs(canvas(), "dest", w, { a: a("a"), b: a("b") });
    const result = buildWorkflow(w, node, inputs, {
      a: "uploaded/a.png",
      b: "uploaded/b.png",
    });
    expect(result.workflow["1"].inputs.text).toBe("a fox");
    expect(result.workflow["2"].inputs.image).toBe("uploaded/a.png");
    expect(result.workflow["4"].inputs.source).toEqual(["2", 0]);
    expect(result.params.seed).toBeGreaterThanOrEqual(0);
    expect(w.template!["1"].inputs.text).toBe("old");
    expect(node.data.generation!.params.seed).toBe(-1);
  });
  it("rejects mappings that destroy graph links", () => {
    const w = workflow();
    w.mapping[0] = { semantic: "prompt", nodeId: "4", field: "source" };
    expect(() => validateDefinition(w)).toThrow("覆盖节点连接");
  });
  it("requires mapped visible parameters", () => {
    const w = workflow();
    w.mapping = w.mapping.filter((m) => m.semantic !== "seed");
    expect(() => validateDefinition(w)).toThrow("参数未绑定");
  });
  it("maps multiple images into indexed loader slots", () => {
    const w = workflow("multi-reference");
    w.mapping = w.mapping.map((m) =>
      m.semantic === "firstFrame"
        ? { ...m, semantic: "referenceImages", index: 0 }
        : m.semantic === "lastFrame"
          ? { ...m, semantic: "referenceImages", index: 1 }
          : m,
    );
    const inputs = resolveInputs(canvas(), "dest", w, { a: a("a"), b: a("b") });
    expect(
      buildWorkflow(w, node, inputs, { a: "a", b: "b" }).workflow["3"].inputs
        .image,
    ).toBe("b");
  });
  it("rejects more reference images than mapped slots", () => {
    const w = workflow("multi-reference");
    w.mapping = w.mapping.map((m) =>
      m.semantic === "firstFrame"
        ? { ...m, semantic: "referenceImages", index: 0 }
        : m,
    );
    expect(() =>
      resolveInputs(canvas(), "dest", w, { a: a("a"), b: a("b") }),
    ).toThrow("容量");
  });
  it("rejects UI workflow JSON, accepts API export wrapper", () => {
    expect(() => parseApiWorkflow({ nodes: [] })).toThrow("API 格式");
    expect(parseApiWorkflow({ prompt: workflow().template })).toEqual(
      workflow().template,
    );
  });
  it("does not require text nodes or edges for text generation", () => {
    const c = canvas();
    c.edges = [];
    expect(resolveInputs(c, "dest", workflow("text-to-video"), {})).toEqual([]);
  });
});

describe("mixed semantic inputs", () => {
  it("groups interleaved images, videos and audio by schema while retaining order within each type", () => {
    const w = workflow("multi-reference");
    w.requiredInputs = ["images", "audios", "referenceVideos"];
    w.mapping = [
      { semantic: "prompt", nodeId: "1", field: "text" },
      { semantic: "images", nodeId: "2", field: "image" },
      { semantic: "audios", nodeId: "3", field: "image" },
      { semantic: "referenceVideos", nodeId: "4", field: "video" },
    ];
    w.parameters = [];
    w.template!["4"].inputs.video = "";
    const kinds = ["image", "audio", "image", "video", "audio"] as const;
    const assets: Record<string, Asset> = {};
    const c = canvas();
    c.nodes = [node];
    c.edges = [];
    kinds.forEach((kind, i) => {
      const id = "asset-" + i;
      assets[id] = {
        id,
        name: id,
        kind,
        mime: kind + "/fixture",
        size: 1,
        createdAt: 0,
      };
      c.nodes.push({
        id,
        position: { x: 0, y: 0 },
        data: { title: id, kind: "reference", assetId: id },
      });
      c.edges.push({
        id: "edge-" + i,
        source: id,
        target: "dest",
        data: { role: "auto", order: i },
      });
    });
    c.edges.reverse();
    const inputs = resolveInputs(c, "dest", w, assets);
    expect(
      inputs.filter((i) => i.semantic === "images").map((i) => i.asset.id),
    ).toEqual(["asset-0", "asset-2"]);
    expect(
      inputs.filter((i) => i.semantic === "audios").map((i) => i.asset.id),
    ).toEqual(["asset-1", "asset-4"]);
    const uploaded = Object.fromEntries(
      Object.keys(assets).map((id) => [id, "infinite-canvas/task/" + id]),
    );
    const built = buildWorkflow(w, node, inputs, uploaded);
    expect(built.workflow["2"].inputs.image).toEqual([
      uploaded["asset-0"],
      uploaded["asset-2"],
    ]);
    expect(built.workflow["3"].inputs.image).toEqual([
      uploaded["asset-1"],
      uploaded["asset-4"],
    ]);
    expect(built.workflow["4"].inputs.video).toEqual([uploaded["asset-3"]]);
  });
  it("injects an explicit output prefix into a cloned template and rejects link targets", () => {
    const w = workflow("text-to-video");
    w.template!["4"].inputs.prefix = "original";
    w.output.prefix = { nodeId: "4", field: "prefix" };
    const result = buildWorkflow(
      w,
      node,
      [],
      {},
      "infinite-canvas/task/result",
    );
    expect(result.workflow["4"].inputs.prefix).toBe(
      "infinite-canvas/task/result",
    );
    expect(w.template!["4"].inputs.prefix).toBe("original");
    w.output.prefix.field = "source";
    expect(() => validateDefinition(w)).toThrow("输出前缀");
  });
});

describe("review regressions", () => {
  it("keeps a manually assigned singular reference-image mapping", () => {
    const w = workflow("multi-reference");
    w.mapping = w.mapping.map((m) =>
      m.semantic === "firstFrame"
        ? { ...m, semantic: "referenceImage" }
        : m.semantic === "lastFrame"
          ? { ...m, semantic: "referenceImages", index: 0 }
          : m,
    );
    const c = canvas();
    c.edges[0].data!.role = "referenceImage";
    const inputs = resolveInputs(c, "dest", w, { a: a("a"), b: a("b") });
    expect(inputs.map((i) => i.semantic)).toEqual([
      "referenceImage",
      "referenceImages",
    ]);
    expect(
      buildWorkflow(w, node, inputs, {
        a: "task/manual.png",
        b: "task/auto.png",
      }).workflow["2"].inputs.image,
    ).toBe("task/manual.png");
  });
  it("rejects an uncovered zero index even when there is only one input", () => {
    const w = workflow("multi-reference");
    w.mapping = w.mapping
      .filter((m) => m.semantic !== "lastFrame")
      .map((m) =>
        m.semantic === "firstFrame"
          ? { ...m, semantic: "referenceImages", index: 1 }
          : m,
      );
    const c = canvas();
    c.edges.pop();
    expect(() => resolveInputs(c, "dest", w, { a: a("a") })).toThrow("容量");
  });
  it.each([-1, 0.5])("rejects invalid mapping index %s", (index) => {
    const w = workflow("multi-reference");
    w.mapping[1] = { ...w.mapping[1], semantic: "referenceImages", index };
    expect(() => validateDefinition(w)).toThrow("索引");
  });
  it.each([
    { type: "boolean" as const, value: "false" },
    { type: "text" as const, value: 12 },
    { type: "select" as const, value: "not-an-option" },
  ])("rejects invalid $type parameters before execution", ({ type, value }) => {
    const w = workflow("text-to-video");
    w.parameters = [
      {
        key: "option",
        label: "Option",
        type,
        default: type === "boolean" ? false : "allowed",
        options: ["allowed"],
      },
    ];
    w.mapping = [
      { semantic: "prompt", nodeId: "1", field: "text" },
      { semantic: "option", nodeId: "4", field: "option" },
    ];
    w.template!["4"].inputs.option = "allowed";
    const n = structuredClone(node);
    n.data.generation!.params = { option: value };
    expect(() => buildWorkflow(w, n, [], {})).toThrow("参数");
  });
});

describe("text and media separation", () => {
  it("excludes text nodes from media staging and first/last frame ordering", () => {
    const c = canvas();
    c.nodes.push({
      id: "text",
      position: { x: 0, y: 0 },
      data: { kind: "text", title: "脚本", text: "A quiet forest" },
    });
    c.edges.unshift({
      id: "text-edge",
      source: "text",
      target: "dest",
      data: { role: "prompt", order: 0 },
    });
    const inputs = resolveInputs(c, "dest", workflow(), {
      a: a("a"),
      b: a("b"),
    });
    expect(inputs.map((i) => i.semantic)).toEqual(["firstFrame", "lastFrame"]);
    expect(inputs.map((i) => i.asset.id)).toEqual(["a", "b"]);
  });
});
