import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  convertEditorWorkflow,
  detectWorkflowFormat,
  editorWorkflowOutputs,
  editorWorkflowObjectInfo,
  workflowImportInputSchema,
} from "../src/workflow/import-editor";
import {
  analyzeWorkflowImport,
  buildWorkflowImport,
} from "../src/workflow/import-analyzer";

const info = {
  Loader: {
    input: { required: { name: ["STRING", {}] } },
    output: ["MODEL", "CLIP", "VAE"],
  },
  ImageLoader: {
    input: { required: { image: ["STRING", {}] } },
    output: ["IMAGE"],
  },
  Encode: {
    input: { required: { clip: ["CLIP", {}], text: ["STRING", {}] } },
    output: ["CONDITIONING"],
  },
  Sampler: {
    input: {
      required: {
        model: ["MODEL", {}],
        conditioning: ["CONDITIONING", {}],
        seed: ["INT", { control_after_generate: true }],
        steps: ["INT", {}],
        cfg: ["FLOAT", {}],
      },
    },
    output: ["LATENT"],
  },
  Decode: {
    input: { required: { samples: ["LATENT", {}], vae: ["VAE", {}] } },
    output: ["IMAGE"],
  },
  SaveImage: {
    input: {
      required: { images: ["IMAGE", {}], filename_prefix: ["STRING", {}] },
    },
    output: [],
  },
  ProcessImage: {
    input: {
      required: { image: ["IMAGE", {}] },
      optional: { mask: ["MASK", {}] },
    },
    output: ["IMAGE"],
  },
  Number: { input: { required: { value: ["INT", {}] } }, output: ["INT"] },
  ForceInput: {
    input: { required: { value: ["INT", { forceInput: true }] } },
    output: ["INT"],
  },
};
const node = (
  id: number,
  type: string,
  widgets_values: unknown[] | Record<string, unknown> = [],
  inputs: unknown[] = [],
  outputs: unknown[] = [],
) => ({ id, type, widgets_values, inputs, outputs });
const input = (name: string, type: string, link: number | null) => ({
  name,
  type,
  link,
});
const link = (
  id: number,
  origin: number,
  slot: number,
  target: number,
  targetSlot: number,
  type: string,
) => [id, origin, slot, target, targetSlot, type];

function completeGraph() {
  return {
    nodes: [
      node(
        1,
        "Loader",
        ["model.safetensors"],
        [],
        [{ type: "MODEL" }, { type: "CLIP" }, { type: "VAE" }],
      ),
      node(
        2,
        "Encode",
        ["a mountain"],
        [input("clip", "CLIP", 1)],
        [{ type: "CONDITIONING" }],
      ),
      node(
        3,
        "Sampler",
        [123, "randomize", 20, 7.5],
        [input("model", "MODEL", 2), input("conditioning", "CONDITIONING", 3)],
        [{ type: "LATENT" }],
      ),
      node(
        4,
        "Decode",
        [],
        [input("samples", "LATENT", 4), input("vae", "VAE", 5)],
        [{ type: "IMAGE" }],
      ),
      node(5, "SaveImage", ["canvas"], [input("images", "IMAGE", 6)]),
    ],
    links: [
      link(1, 1, 1, 2, 0, "CLIP"),
      link(2, 1, 0, 3, 0, "MODEL"),
      link(3, 2, 0, 3, 1, "CONDITIONING"),
      link(4, 3, 0, 4, 0, "LATENT"),
      link(5, 1, 2, 4, 1, "VAE"),
      link(6, 4, 0, 5, 0, "IMAGE"),
    ],
  };
}

describe("workflow format detection", () => {
  it("uses content, including a prompt wrapper", () => {
    const api = {
      "1": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
    };
    expect(detectWorkflowFormat(api)).toBe("api");
    expect(detectWorkflowFormat({ prompt: api, client_id: "ignored" })).toBe(
      "api",
    );
    expect(detectWorkflowFormat(completeGraph())).toBe("editor");
    expect(detectWorkflowFormat({ prompt: completeGraph() })).toBe("editor");
    expect(() => detectWorkflowFormat({ arbitrary: "data" })).toThrow(
      "不是有效",
    );
    expect(() => detectWorkflowFormat([])).toThrow("必须为对象");
  });
});

describe("editor workflow conversion", () => {
  it("keeps explicit links and scalar widgets, skipping the seed control", () => {
    const source = completeGraph();
    const snapshot = JSON.stringify(source);
    const result = convertEditorWorkflow(source, info);
    expect(result.graph["3"].inputs).toEqual({
      model: ["1", 0],
      conditioning: ["2", 0],
      seed: 123,
      steps: 20,
      cfg: 7.5,
    });
    expect(result.graph["5"].inputs).toEqual({
      filename_prefix: "canvas",
      images: ["4", 0],
    });
    expect(result.graph["2"]._meta?.title).toBe("Encode");
    expect(result.warnings).toEqual([]);
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it("reads cloud input_order rather than object key order", () => {
    const schema = {
      Ordered: {
        input: { required: { second: ["INT", {}], first: ["STRING", {}] } },
        input_order: { required: ["first", "second"] },
        output: [],
      },
    };
    const result = convertEditorWorkflow(
      { nodes: [node(1, "Ordered", ["saved", 42])], links: [] },
      schema,
    );
    expect(result.graph["1"].inputs).toEqual({ first: "saved", second: 42 });
  });

  it("handles object-valued widget maps and object-valued links", () => {
    const source = {
      nodes: [
        node(1, "ImageLoader", { image: "a.png" }, [], [{ type: "IMAGE" }]),
        node(2, "SaveImage", { filename_prefix: "saved" }, [
          input("images", "IMAGE", 1),
        ]),
      ],
      links: [
        {
          id: 1,
          origin_id: 1,
          origin_slot: 0,
          target_id: 2,
          target_slot: 0,
          type: "IMAGE",
        },
      ],
    };
    expect(
      convertEditorWorkflow(source, info).graph["2"].inputs.images,
    ).toEqual(["1", 0]);
  });

  it("rejects missing definitions and unsupported widget sequences with precise errors", () => {
    expect(() =>
      convertEditorWorkflow(
        { nodes: [node(1, "Plugin", [12])], links: [] },
        info,
      ),
    ).toThrow("没有云端节点定义");
    expect(() =>
      convertEditorWorkflow(
        { nodes: [node(1, "Number", [4, "dynamic"])], links: [] },
        info,
      ),
    ).toThrow("额外控件");
    expect(() =>
      convertEditorWorkflow(
        { nodes: [node(1, "Number", ["wrong"])], links: [] },
        info,
      ),
    ).toThrow("控件 value");
    expect(() =>
      convertEditorWorkflow(
        {
          nodes: [node(1, "Number", { value: 3, plugin_control: 4 })],
          links: [],
        },
        info,
      ),
    ).toThrow("动态控件 plugin_control");
    expect(() =>
      convertEditorWorkflow(
        { nodes: [node(1, "Number", [])], links: [] },
        info,
      ),
    ).toThrow("缺少控件 value");
  });

  it("resolves Primitive, Reroute and uniquely named Set/Get nodes", () => {
    const source = {
      nodes: [
        node(1, "PrimitiveNode", [42], [], [{ type: "INT" }]),
        node(2, "Reroute", [], [input("value", "INT", 1)], [{ type: "INT" }]),
        node(
          3,
          "SetNode",
          ["seed"],
          [input("value", "INT", 2)],
          [{ type: "INT" }],
        ),
        node(4, "GetNode", ["seed"], [], [{ type: "INT" }]),
        node(
          5,
          "ForceInput",
          [],
          [input("value", "INT", 3)],
          [{ type: "INT" }],
        ),
        node(6, "Note", ["do not execute"]),
      ],
      links: [
        link(1, 1, 0, 2, 0, "INT"),
        link(2, 2, 0, 3, 0, "INT"),
        link(3, 4, 0, 5, 0, "INT"),
      ],
    };
    expect(convertEditorWorkflow(source, info).graph).toEqual({
      "5": {
        class_type: "ForceInput",
        inputs: { value: 42 },
        _meta: { title: "ForceInput" },
      },
    });
    source.nodes.push(node(7, "SetNode", ["seed"], [input("value", "INT", 4)]));
    source.links.push(link(4, 1, 0, 7, 0, "INT"));
    expect(() => convertEditorWorkflow(source, info)).toThrow(
      "找不到唯一 SetNode",
    );
  });

  it("wraps primitive literal arrays rather than mistaking them for API links", () => {
    const schema = {
      ListInput: { input: { required: { value: ["LIST", {}] } }, output: [] },
    };
    const source = {
      nodes: [
        node(1, "PrimitiveNode", [[1, 2]], [], [{ type: "LIST" }]),
        node(2, "ListInput", [], [input("value", "LIST", 1)]),
      ],
      links: [link(1, 1, 0, 2, 0, "LIST")],
    };
    expect(
      convertEditorWorkflow(source, schema).graph["2"].inputs.value,
    ).toEqual({ __value__: [1, 2] });
  });

  it("bypasses a node only through its unique matching input and ignores muted UI nodes", () => {
    const source = {
      nodes: [
        node(1, "ImageLoader", ["a.png"], [], [{ type: "IMAGE" }]),
        {
          ...node(
            2,
            "ProcessImage",
            [],
            [input("image", "IMAGE", 1)],
            [{ type: "IMAGE" }],
          ),
          mode: 4,
        },
        node(3, "SaveImage", ["result"], [input("images", "IMAGE", 2)]),
        { ...node(4, "Number", ["invalid"]), mode: 2 },
        node(5, "Fast Groups Bypasser (rgthree)", ["irrelevant"]),
      ],
      links: [link(1, 1, 0, 2, 0, "IMAGE"), link(2, 2, 0, 3, 0, "IMAGE")],
    };
    const graph = convertEditorWorkflow(source, info).graph;
    expect(Object.keys(graph)).toEqual(["1", "3"]);
    expect(graph["3"].inputs.images).toEqual(["1", 0]);
  });

  it("reports missing mandatory inputs from muted nodes, and omits optional ones", () => {
    const source = {
      nodes: [
        {
          ...node(1, "ImageLoader", ["a.png"], [], [{ type: "IMAGE" }]),
          mode: 2,
        },
        node(2, "ProcessImage", [], [input("image", "IMAGE", 1)]),
      ],
      links: [link(1, 1, 0, 2, 0, "IMAGE")],
    };
    expect(() => convertEditorWorkflow(source, info)).toThrow("依赖已禁用节点");
    const optional = {
      nodes: [
        node(1, "ImageLoader", ["a.png"], [], [{ type: "IMAGE" }]),
        { ...node(2, "MaskLoader", [], [], [{ type: "MASK" }]), mode: 2 },
        node(
          3,
          "ProcessImage",
          [],
          [input("image", "IMAGE", 1), input("mask", "MASK", 2)],
        ),
      ],
      links: [link(1, 1, 0, 3, 0, "IMAGE"), link(2, 2, 0, 3, 1, "MASK")],
    };
    const result = convertEditorWorkflow(optional, info);
    expect(result.graph["3"].inputs.mask).toBeUndefined();
    expect(result.warnings[0]).toContain("可选输入 mask");
  });

  it("rejects ambiguous bypasses, malformed links and cycles", () => {
    const source = {
      nodes: [
        node(1, "ImageLoader", ["a.png"], [], [{ type: "IMAGE" }]),
        {
          ...node(
            2,
            "ProcessImage",
            [],
            [input("image", "IMAGE", 1), input("other", "IMAGE", 2)],
            [{ type: "IMAGE" }],
          ),
          mode: 4,
        },
        node(3, "SaveImage", ["result"], [input("images", "IMAGE", 3)]),
      ],
      links: [
        link(1, 1, 0, 2, 0, "IMAGE"),
        link(2, 1, 0, 2, 1, "IMAGE"),
        link(3, 2, 0, 3, 0, "IMAGE"),
      ],
    };
    expect(() => convertEditorWorkflow(source, info)).toThrow(
      "没有唯一同类型输入",
    );
    expect(() =>
      convertEditorWorkflow(
        {
          nodes: [node(1, "ProcessImage", [], [input("image", "IMAGE", 1)])],
          links: [link(1, 1, 0, 1, 0, "IMAGE")],
        },
        info,
      ),
    ).toThrow("构成循环");
    expect(() =>
      convertEditorWorkflow(
        {
          nodes: [node(1, "ProcessImage", [], [input("image", "IMAGE", 2)])],
          links: [],
        },
        info,
      ),
    ).toThrow("找不到连线 2");
  });

  it("restores unique model, clip and VAE broadcasts without replacing explicit links", () => {
    const source = completeGraph();
    source.nodes[1].inputs[0].link = null;
    source.nodes[2].inputs[0].link = null;
    source.nodes[3].inputs[1].link = null;
    source.nodes.push(
      node(
        6,
        "Anything Everywhere3",
        [],
        [
          input("anything", "*", 7),
          input("anything2", "*", 8),
          input("anything3", "*", 9),
        ],
      ),
    );
    source.links.push(
      link(7, 1, 0, 6, 0, "MODEL"),
      link(8, 1, 1, 6, 1, "CLIP"),
      link(9, 1, 2, 6, 2, "VAE"),
    );
    const result = convertEditorWorkflow(source, info);
    expect(result.graph["2"].inputs.clip).toEqual(["1", 1]);
    expect(result.graph["3"].inputs.model).toEqual(["1", 0]);
    expect(result.graph["4"].inputs.vae).toEqual(["1", 2]);
    expect(result.graph["3"].inputs.conditioning).toEqual(["2", 0]);
    expect(result.graph["6"]).toBeUndefined();
    expect(result.warnings).toHaveLength(3);
  });

  it("rejects ambiguous or filtered implicit propagation", () => {
    const source = {
      nodes: [
        node(1, "ImageLoader", ["a.png"], [], [{ type: "IMAGE" }]),
        node(2, "ImageLoader", ["b.png"], [], [{ type: "IMAGE" }]),
        node(
          3,
          "Anything Everywhere3",
          [],
          [input("a", "*", 1), input("b", "*", 2)],
        ),
        node(4, "SaveImage", ["result"], [input("images", "IMAGE", null)]),
      ],
      links: [link(1, 1, 0, 3, 0, "IMAGE"), link(2, 2, 0, 3, 1, "IMAGE")],
    };
    expect(() => convertEditorWorkflow(source, info)).toThrow("存在歧义");
    const filtered = {
      ...source,
      nodes: source.nodes.map((n) =>
        n.id === 3
          ? { ...n, properties: { ue_properties: { group_restricted: 1 } } }
          : n,
      ),
    };
    expect(() => convertEditorWorkflow(filtered, info)).toThrow("筛选或优先级");
  });

  it("deduplicates identical implicit sources and honors disabled node input propagation", () => {
    const source = {
      nodes: [
        node(1, "ImageLoader", ["a.png"], [], [{ type: "IMAGE" }]),
        node(
          2,
          "Anything Everywhere3",
          [],
          [input("a", "*", 1), input("b", "*", 2)],
        ),
        node(3, "SaveImage", ["result"], [input("images", "IMAGE", null)]),
      ],
      links: [link(1, 1, 0, 2, 0, "IMAGE"), link(2, 1, 0, 2, 1, "IMAGE")],
    };
    expect(
      convertEditorWorkflow(source, info).graph["3"].inputs.images,
    ).toEqual(["1", 0]);
    const blocked = {
      ...source,
      nodes: source.nodes.map((n) =>
        n.id === 3
          ? {
              ...n,
              properties: {
                ue_properties: { input_ue_unconnectable: { images: true } },
              },
            }
          : n,
      ),
    };
    expect(() => convertEditorWorkflow(blocked, info)).toThrow(
      "缺少必填输入 images",
    );
  });

  it("expands subgraph boundaries and applies proxy widget overrides", () => {
    const definition = {
      id: "subgraph-uuid",
      inputNode: { id: -10 },
      outputNode: { id: -20 },
      inputs: [{ name: "image", type: "IMAGE" }],
      outputs: [{ name: "image", type: "IMAGE" }],
      nodes: [
        node(
          11,
          "ProcessImage",
          [],
          [input("image", "IMAGE", 1)],
          [{ type: "IMAGE" }],
        ),
        node(12, "Number", [2], [], [{ type: "INT" }]),
      ],
      links: [link(1, -10, 0, 11, 0, "IMAGE"), link(2, 11, 0, -20, 0, "IMAGE")],
    };
    const source = {
      definitions: { subgraphs: [definition] },
      nodes: [
        node(1, "ImageLoader", ["a.png"], [], [{ type: "IMAGE" }]),
        {
          ...node(
            2,
            "subgraph-uuid",
            [9],
            [input("image", "IMAGE", 1)],
            [{ type: "IMAGE" }],
          ),
          properties: { proxyWidgets: [["12", "value"]] },
        },
        node(3, "SaveImage", ["result"], [input("images", "IMAGE", 2)]),
      ],
      links: [link(1, 1, 0, 2, 0, "IMAGE"), link(2, 2, 0, 3, 0, "IMAGE")],
    };
    const result = convertEditorWorkflow(source, info);
    expect(result.graph["2:11"].inputs.image).toEqual(["1", 0]);
    expect(result.graph["2:12"]).toBeUndefined();
    expect(result.graph["3"].inputs.images).toEqual(["2:11", 0]);
    expect(result.graph["2"]).toBeUndefined();
  });

  it("rejects a complex subgraph proxy shape rather than guessing", () => {
    const source = {
      definitions: {
        subgraphs: [{ id: "sg", nodes: [node(4, "Number", [1])], links: [] }],
      },
      nodes: [
        {
          ...node(1, "sg", [4]),
          properties: { proxyWidgets: [{ nodeId: 4, field: "value" }] },
        },
      ],
      links: [],
    };
    expect(() => convertEditorWorkflow(source, info)).toThrow(
      "不受支持的代理控件",
    );
  });

  it("keeps converted widget connections and skips the known image upload button", () => {
    const schema = {
      ...info,
      LoadImage: {
        input: { required: { image: [["a.png"], { image_upload: true }] } },
        output: ["IMAGE"],
      },
    };
    const source = {
      nodes: [
        node(1, "PrimitiveNode", [27], [], [{ type: "INT" }]),
        node(
          2,
          "Number",
          [12],
          [{ ...input("value", "INT", 1), widget: { name: "value" } }],
        ),
        node(3, "LoadImage", ["a.png", "image"]),
      ],
      links: [link(1, 1, 0, 2, 0, "INT")],
    };
    expect(convertEditorWorkflow(source, schema).graph["2"].inputs.value).toBe(
      27,
    );
    expect(convertEditorWorkflow(source, schema).graph["3"].inputs.image).toBe(
      "a.png",
    );
  });

  it("flattens separate instances of the same subgraph without mixing IDs", () => {
    const definition = {
      id: "sg",
      inputNode: { id: -10 },
      outputNode: { id: -20 },
      inputs: [],
      outputs: [{ name: "value", type: "INT" }],
      nodes: [node(1, "Number", [5], [], [{ type: "INT" }])],
      links: [link(1, 1, 0, -20, 0, "INT")],
    };
    const source = {
      definitions: { subgraphs: [definition] },
      nodes: [
        node(1, "sg", [], [], [{ type: "INT" }]),
        node(2, "sg", [], [], [{ type: "INT" }]),
        node(3, "ForceInput", [], [input("value", "INT", 1)]),
        node(4, "ForceInput", [], [input("value", "INT", 2)]),
      ],
      links: [link(1, 1, 0, 3, 0, "INT"), link(2, 2, 0, 4, 0, "INT")],
    };
    const graph = convertEditorWorkflow(source, info).graph;
    expect(graph["3"].inputs.value).toEqual(["1:1", 0]);
    expect(graph["4"].inputs.value).toEqual(["2:1", 0]);
  });

  it("reports missing and ambiguous subgraph boundaries", () => {
    const definition = {
      id: "sg",
      inputNode: { id: -10 },
      outputNode: { id: -20 },
      inputs: [{ name: "image", type: "IMAGE" }],
      outputs: [{ name: "image", type: "IMAGE" }],
      nodes: [
        node(
          1,
          "ProcessImage",
          [],
          [input("image", "IMAGE", 1)],
          [{ type: "IMAGE" }],
        ),
      ],
      links: [link(1, -10, 0, 1, 0, "IMAGE"), link(2, 1, 0, -20, 0, "IMAGE")],
    };
    const source = {
      definitions: { subgraphs: [definition] },
      nodes: [
        node(1, "sg", [], [input("image", "IMAGE", null)], [{ type: "IMAGE" }]),
        node(2, "SaveImage", ["saved"], [input("images", "IMAGE", 1)]),
      ],
      links: [link(1, 1, 0, 2, 0, "IMAGE")],
    };
    expect(() => convertEditorWorkflow(source, info)).toThrow(
      "未提供的子图输入",
    );
    const malformed = {
      definitions: { subgraphs: [{ ...definition, links: [] }] },
      nodes: source.nodes,
      links: source.links,
    };
    expect(() => convertEditorWorkflow(malformed, info)).toThrow(
      "没有唯一连接",
    );
  });

  it("rejects recursive definitions and invalid input orders", () => {
    const source = {
      definitions: {
        subgraphs: [
          {
            id: "sg",
            nodes: [node(1, "sg")],
            outputNode: { id: -20 },
            links: [link(1, 1, 0, -20, 0, "INT")],
          },
        ],
      },
      nodes: [node(1, "sg")],
      links: [],
    };
    expect(() => convertEditorWorkflow(source, info)).toThrow("递归定义");
    const badInfo = {
      Number: { ...info.Number, input_order: { required: [] } },
    };
    expect(() =>
      convertEditorWorkflow(
        { nodes: [node(1, "Number", [1])], links: [] },
        badInfo,
      ),
    ).toThrow("input_order 与输入定义不一致");
  });
});

describe("selected editor outputs and formal V3 templates", () => {
  it("keeps every enabled save and preview by default and skips unrelated missing plugins", () => {
    const source = {
      nodes: [
        node(1, "ImageLoader", ["a.png"], [], [{ type: "IMAGE" }]),
        node(2, "SaveImage", ["save"], [input("images", "IMAGE", 1)]),
        node(3, "MissingPlugin", ["unknown"]),
        node(4, "PreviewImage", [], [input("images", "IMAGE", 2)]),
        { ...node(5, "SaveImage", ["muted"]), mode: 2 },
      ],
      links: [link(1, 1, 0, 2, 0, "IMAGE"), link(2, 1, 0, 4, 0, "IMAGE")],
    };
    expect(editorWorkflowOutputs(source)).toEqual([
      { nodeId: "2", label: "SaveImage · 2", kind: "image" },
      { nodeId: "4", label: "PreviewImage · 4", kind: "image" },
    ]);
    expect(Object.keys(convertEditorWorkflow(source, info).graph)).toEqual([
      "1",
      "2",
      "4",
    ]);
    const two = {
      ...source,
      nodes: [
        ...source.nodes,
        node(6, "SaveImage", ["second"], [input("images", "IMAGE", 3)]),
      ],
      links: [...source.links, link(3, 1, 0, 6, 0, "IMAGE")],
    };
    expect(Object.keys(convertEditorWorkflow(two, info).graph)).toEqual(["1", "2", "4", "6"]);
    expect(Object.keys(convertEditorWorkflow(two, info, "6").graph)).toEqual([
      "1",
      "6",
    ]);
  });

  it("does not inspect unknown schema in muted or bypassed non-selected branches", () => {
    const source = completeGraph();
    source.nodes.push(
      { ...node(9, "NotInstalled", ["nonsense"]), mode: 2 } as never,
      { ...node(10, "UnknownBypass", ["nonsense"]), mode: 4 } as never,
    );
    expect(convertEditorWorkflow(source, info).graph["5"].class_type).toBe(
      "SaveImage",
    );
    const onlyPreview = {
      nodes: [
        node(1, "ImageLoader", ["a.png"], [], [{ type: "IMAGE" }]),
        node(2, "PreviewImage", [], [input("images", "IMAGE", 1)]),
      ],
      links: [link(1, 1, 0, 2, 0, "IMAGE")],
    };
    expect(editorWorkflowOutputs(onlyPreview)[0].nodeId).toBe("2");
  });

  it("expands AUTOGROW by a declared prefix and enforces minimum connections", () => {
    const schema = {
      ...info,
      Batch: {
        input: {
          required: {
            images: [
              "COMFY_AUTOGROW_V3",
              {
                template: {
                  input: { required: { image: ["IMAGE", {}] } },
                  prefix: "image",
                  min: 1,
                  max: 4,
                },
              },
            ],
          },
        },
        output: ["IMAGE"],
      },
    };
    const source = {
      nodes: [
        node(1, "ImageLoader", ["a.png"], [], [{ type: "IMAGE" }]),
        node(
          2,
          "Batch",
          [],
          [
            input("images.image0", "IMAGE", 1),
            input("images.image1", "IMAGE", null),
          ],
          [{ type: "IMAGE" }],
        ),
        node(3, "SaveImage", ["save"], [input("images", "IMAGE", 2)]),
      ],
      links: [link(1, 1, 0, 2, 0, "IMAGE"), link(2, 2, 0, 3, 0, "IMAGE")],
    };
    const result = convertEditorWorkflow(source, schema);
    expect(result.graph["2"].inputs).toEqual({ "images.image0": ["1", 0] });
    expect(
      workflowImportInputSchema(result.graph["2"], schema.Batch).required[
        "images.image0"
      ],
    ).toEqual(["IMAGE", {}]);
    expect(() =>
      convertEditorWorkflow(
        {
          ...source,
          links: source.links.slice(1),
          nodes: source.nodes.map((n) =>
            n.id === 2
              ? { ...n, inputs: [input("images.image0", "IMAGE", null)] }
              : n,
          ),
        },
        schema,
      ),
    ).toThrow("至少需要 1 项连接");
  });

  it("expands dynamic combos from the selected schema branch in exact widget order", () => {
    const schema = {
      Dynamic: {
        input: {
          required: {
            prompt: ["STRING", {}],
            mode: [
              "COMFY_DYNAMICCOMBO_V3",
              {
                options: [
                  {
                    key: "on",
                    inputs: {
                      required: {
                        temperature: ["FLOAT", {}],
                        seed: ["INT", {}],
                      },
                      optional: { penalty: ["FLOAT", {}] },
                    },
                  },
                  { key: "off", inputs: { required: {} } },
                ],
              },
            ],
          },
          optional: { thinking: ["BOOLEAN", {}] },
        },
        input_order: { required: ["prompt", "mode"], optional: ["thinking"] },
        output: ["STRING"],
      },
    };
    const source = {
      nodes: [node(1, "Dynamic", ["hello", "on", 0.7, 123, 0, false])],
      links: [],
    };
    const result = convertEditorWorkflow(source, schema);
    expect(result.graph["1"].inputs).toEqual({
      prompt: "hello",
      mode: "on",
      "mode.temperature": 0.7,
      "mode.seed": 123,
      "mode.penalty": 0,
      thinking: false,
    });
    const expanded = workflowImportInputSchema(
      result.graph["1"],
      schema.Dynamic,
    );
    expect(expanded.required["mode.temperature"]).toEqual(["FLOAT", {}]);
    expect(expanded.optional["mode.penalty"]).toEqual(["FLOAT", {}]);
    expect(() =>
      convertEditorWorkflow(
        { nodes: [node(1, "Dynamic", ["hello", "unknown", false])], links: [] },
        schema,
      ),
    ).toThrow("没有唯一分支");
  });

  it("limits the CR Prompt Text fallback to its verified single STRING widget", () => {
    const source = {
      nodes: [
        node(
          1,
          "CR Prompt Text",
          ["a scene"],
          [input("prompt", "STRING", null)],
          [{ type: "STRING" }],
        ),
      ],
      links: [],
    };
    expect(convertEditorWorkflow(source, {}).graph["1"].inputs.prompt).toBe(
      "a scene",
    );
    expect(() =>
      convertEditorWorkflow(
        { nodes: [node(1, "CR Prompt Text", ["a scene", 2])], links: [] },
        {},
      ),
    ).toThrow("没有云端节点定义");
  });

  it("keeps proxy overrides only on the selected subgraph's actual ancestry", () => {
    const definition = {
      id: "sg",
      outputNode: { id: -20 },
      nodes: [node(11, "Number", [2], [], [{ type: "INT" }])],
      links: [link(1, 11, 0, -20, 0, "INT")],
    };
    const source = {
      definitions: { subgraphs: [definition] },
      nodes: [
        {
          ...node(1, "sg", [9], [], [{ type: "INT" }]),
          properties: { proxyWidgets: [["11", "value"]] },
        },
        node(2, "ForceInput", [], [input("value", "INT", 1)]),
      ],
      links: [link(1, 1, 0, 2, 0, "INT")],
    };
    expect(
      convertEditorWorkflow(source, info, "2").graph["1:11"].inputs.value,
    ).toBe(9);
  });
});

describe("arbitrary server output nodes and multiple execution roots", () => {
  it("lists new server output classes with an automatic history wildcard", () => {
    const schemas = {
      ...info,
      GalleryWriter: {
        input: { required: { frames: ["IMAGE", {}], prefix: ["STRING", {}] } },
        output: [],
        output_node: true,
      },
      SentenceWriter: {
        input: { required: { text: ["STRING", {}] } },
        output: [],
        output_node: true,
      },
      ArchiveWriter: {
        input: { required: { data: ["DATA", {}], level: ["INT", {}] } },
        output: [],
        output_node: true,
      },
      MixedWriter: {
        input: { required: { image: ["IMAGE", {}], audio: ["AUDIO", {}] } },
        output: [],
        output_node: true,
      },
      NotAnOutput: { input: {}, output: ["IMAGE"], output_node: false },
    };
    const source = {
      nodes: [
        node(1, "GalleryWriter", ["saved"]),
        node(2, "SentenceWriter", ["text"]),
        node(3, "ArchiveWriter", [1]),
        node(4, "MixedWriter"),
        node(5, "NotAnOutput"),
        { ...node(6, "GalleryWriter", ["muted"]), mode: 2 },
      ],
      links: [],
    };
    expect(editorWorkflowOutputs(source, schemas)).toEqual([
      {
        nodeId: "1",
        label: "GalleryWriter · 1",
        kind: "image",
        field: "*",
      },
      {
        nodeId: "2",
        label: "SentenceWriter · 2",
        kind: "text",
        field: "*",
      },
      {
        nodeId: "3",
        label: "ArchiveWriter · 3",
        kind: "file",
        field: "*",
      },
      {
        nodeId: "4",
        label: "MixedWriter · 4",
        kind: "file",
        field: "*",
      },
    ]);
    expect(
      editorWorkflowOutputs(source, schemas).every(
        (output) => output.field === "*" && !output.needsBinding,
      ),
    ).toBe(true);
    expect(editorWorkflowOutputs(source)).toEqual([]);
  });

  it("converts the union of two independent roots without including an unrelated plugin", () => {
    const schemas = {
      ...info,
      GalleryWriter: {
        input: { required: { frames: ["IMAGE", {}], prefix: ["STRING", {}] } },
        output: [],
        output_node: true,
      },
    };
    const source = {
      nodes: [
        node(1, "ImageLoader", ["a.png"], [], [{ type: "IMAGE" }]),
        node(2, "GalleryWriter", ["first"], [input("frames", "IMAGE", 1)]),
        node(3, "ImageLoader", ["b.png"], [], [{ type: "IMAGE" }]),
        node(4, "GalleryWriter", ["second"], [input("frames", "IMAGE", 2)]),
        node(5, "UninstalledPlugin", ["unknown"]),
      ],
      links: [link(1, 1, 0, 2, 0, "IMAGE"), link(2, 3, 0, 4, 0, "IMAGE")],
    };
    expect(Object.keys(convertEditorWorkflow(source, schemas).graph)).toEqual(["1", "2", "3", "4"]);
    const converted = convertEditorWorkflow(source, schemas, ["2", "4", "2"]);
    expect(Object.keys(converted.graph)).toEqual(["1", "2", "3", "4"]);
    expect(converted.graph["2"].inputs.frames).toEqual(["1", 0]);
    expect(converted.graph["4"].inputs.frames).toEqual(["3", 0]);
    expect(
      Object.keys(convertEditorWorkflow(source, schemas, "2").graph),
    ).toEqual(["1", "2"]);
    expect(() => convertEditorWorkflow(source, schemas, [])).toThrow(
      "至少一个",
    );
    expect(() =>
      convertEditorWorkflow(source, schemas, ["2", "missing"]),
    ).toThrow("不存在或已禁用");
  });

  it("accepts an explicitly chosen executable intermediate node regardless of its class name", () => {
    const source = {
      nodes: [
        node(1, "ImageLoader", ["a.png"], [], [{ type: "IMAGE" }]),
        node(
          2,
          "ProcessImage",
          [],
          [input("image", "IMAGE", 1)],
          [{ type: "IMAGE" }],
        ),
        node(3, "SaveImage", ["saved"], [input("images", "IMAGE", 2)]),
      ],
      links: [link(1, 1, 0, 2, 0, "IMAGE"), link(2, 2, 0, 3, 0, "IMAGE")],
    };
    expect(Object.keys(convertEditorWorkflow(source, info, "2").graph)).toEqual(
      ["1", "2"],
    );
    expect(() =>
      convertEditorWorkflow(
        {
          ...source,
          nodes: source.nodes.map((n) => (n.id === 2 ? { ...n, mode: 4 } : n)),
        },
        info,
        "2",
      ),
    ).toThrow("不存在或已禁用");
  });

  it("keeps instance identities across two selected subgraph branches", () => {
    const definition = {
      id: "sg",
      inputNode: { id: -10 },
      outputNode: { id: -20 },
      inputs: [{ name: "image", type: "IMAGE" }],
      nodes: [
        node(
          11,
          "ProcessImage",
          [],
          [input("image", "IMAGE", 1)],
          [{ type: "IMAGE" }],
        ),
      ],
      links: [link(1, -10, 0, 11, 0, "IMAGE"), link(2, 11, 0, -20, 0, "IMAGE")],
    };
    const source = {
      definitions: { subgraphs: [definition] },
      nodes: [
        node(1, "ImageLoader", ["a.png"], [], [{ type: "IMAGE" }]),
        node(2, "sg", [], [input("image", "IMAGE", 1)], [{ type: "IMAGE" }]),
        node(3, "SaveImage", ["first"], [input("images", "IMAGE", 2)]),
        node(4, "ImageLoader", ["b.png"], [], [{ type: "IMAGE" }]),
        node(5, "sg", [], [input("image", "IMAGE", 3)], [{ type: "IMAGE" }]),
        node(6, "SaveImage", ["second"], [input("images", "IMAGE", 4)]),
      ],
      links: [
        link(1, 1, 0, 2, 0, "IMAGE"),
        link(2, 2, 0, 3, 0, "IMAGE"),
        link(3, 4, 0, 5, 0, "IMAGE"),
        link(4, 5, 0, 6, 0, "IMAGE"),
      ],
    };
    const converted = convertEditorWorkflow(source, info, ["3", "6"]);
    expect(converted.graph["3"].inputs.images).toEqual(["2:11", 0]);
    expect(converted.graph["6"].inputs.images).toEqual(["5:11", 0]);
    expect(converted.graph["2:11"].inputs.image).toEqual(["1", 0]);
    expect(converted.graph["5:11"].inputs.image).toEqual(["4", 0]);
  });

  it("still explains when the selected branch requires an unknown plugin schema", () => {
    expect(() =>
      convertEditorWorkflow(
        { nodes: [node(1, "NewPlugin", ["value"])], links: [] },
        {},
        "1",
      ),
    ).toThrow("保存数据");
  });
});

const personalFile = "E:/123/【Qwen Image 2.1】图像生成大合集.json";
const personalInfo = ".cache/directory-cloud-capabilities.json";
it.skipIf(!existsSync(personalFile) || !existsSync(personalInfo))(
  "converts the user's unchanged Qwen editor workflow into a complete six-image 470 branch",
  () => {
    const before = readFileSync(personalFile);
    const hash = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    const source = JSON.parse(before.toString("utf8"));
    const info = JSON.parse(readFileSync(personalInfo, "utf8")).objectInfo;
    const converted = convertEditorWorkflow(source, info, "470");
    const analysis = analyzeWorkflowImport(converted.graph, info, "470");
    expect(analysis.errors).toEqual([]);
    expect(analysis.inputs).toHaveLength(6);
    const built = buildWorkflowImport(
      converted.graph,
      {
        id: "test.qwen.6",
        name: "Qwen 6",
        family: "Qwen",
        outputNodeId: "470",
        promptKey: "494.prompt",
      },
      info,
    );
    expect(Object.keys(built.graph)).toHaveLength(21);
    expect(built.graph["416"].inputs.model).toEqual(["471", 0]);
    expect(built.graph["418"].inputs.clip).toEqual(["192", 0]);
    expect(built.graph["426"].inputs.vae).toEqual(["197", 0]);
    expect(built.graph["418"].inputs["images.image_6"]).toEqual(["434", 0]);
    expect(built.graph["484"].inputs["sampling_mode.temperature"]).toBe(0.7);
    expect(hash(readFileSync(personalFile))).toBe(hash(before));
  },
);
