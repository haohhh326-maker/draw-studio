import { describe, expect, it } from "vitest";
import { convertEditorWorkflow, detectWorkflowFormat, editorWorkflowObjectInfo, editorWorkflowOutputs, MissingWorkflowNodeDefinitionError } from "../src/workflow/import-editor";
import { buildWorkflowImport } from "../src/workflow/import-analyzer";

const load = { input: { required: { image: ["STRING", { image_upload: true }] } }, output: ["IMAGE"] };
const process = { input: { required: { image: ["IMAGE"] } }, output: ["IMAGE"] };
const save = { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true };
const info = { LoadImage: load, Processor: process, SaveImage: save, PreviewImage: { input: { required: { images: ["IMAGE"] } }, output: [], output_node: true } };
const input = (name: string, type: string, link: number | null) => ({ name, type, link });
const options = { id: "custom.offline", name: "Offline own workflow", family: "Own" };

describe("single editor JSON import", () => {
  it("uses the file's exact embedded schema snapshot without fetching a second file", () => {
    const source = { object_info: info, nodes: [
      { id: 1, type: "LoadImage", widgets_values: ["original.png"], outputs: [{ type: "IMAGE" }] },
      { id: 2, type: "SaveImage", widgets_values: ["original"], inputs: [input("images", "IMAGE", 1)] },
    ], links: [[1, 1, 0, 2, 0, "IMAGE"]] };
    const before = structuredClone(source), converted = convertEditorWorkflow(source);
    expect(converted.graph["2"].inputs.images).toEqual(["1", 0]);
    expect(converted.objectInfo.LoadImage).toEqual(load);
    const built = buildWorkflowImport(converted.graph, options, converted.objectInfo);
    expect(built.config.inputs).toHaveLength(1);
    expect(source).toEqual(before);
  });

  it("preserves named scalar and JSON widget values and custom output metadata while offline", () => {
    const source = { nodes: [
      { id: "make", type: "MyFrameGenerator", widgets_values: { title: "My image", strength: .2, settings: { layers: [1, 2], alpha: true } }, outputs: [{ type: "IMAGE" }] },
      { id: "save", type: "MyPhotoWriter", properties: { output_node: true }, widgets_values: { prefix: "original" }, inputs: [input("photo", "IMAGE", 1)], outputs: [] },
    ], links: [[1, "make", 0, "save", 0, "IMAGE"]] };
    expect(editorWorkflowOutputs(source)).toEqual([{ nodeId: "save", label: "MyPhotoWriter · save", kind: "image", field: "*" }]);
    const converted = convertEditorWorkflow(source);
    expect(converted.graph.make.inputs).toEqual(source.nodes[0].widgets_values);
    expect(converted.graph.save.inputs).toEqual({ prefix: "original", photo: ["make", 0] });
    expect(converted.warnings.some(warning => warning.includes("具名控件"))).toBe(true);
    expect(buildWorkflowImport(converted.graph, options, converted.objectInfo).config.execution).toMatchObject({ output: { nodeId: "save", field: "*", kind: "file" } });
  });

  it("maps anonymous values only when explicit named widget declarations supply their order", () => {
    const source = { nodes: [{ id: 1, type: "NamedWidgets", properties: { output_node: true }, widgets: [
      { name: "caption", type: "text" }, { name: "steps", type: "INT" }, { name: "active", type: "toggle" },
    ], widgets_values: ["A scene", 30, true], outputs: [] }], links: [] };
    const converted = convertEditorWorkflow(source);
    expect(converted.graph["1"].inputs).toEqual({ caption: "A scene", steps: 30, active: true });
    const unknown = { nodes: [{ id: 1, type: "UnknownWidgets", widgets_values: ["A scene", 30], inputs: [{ name: "steps", type: "INT", widget: { name: "steps" }, link: null }] }], links: [] };
    expect(() => convertEditorWorkflow(unknown)).toThrow("具名控件信息");
    try { convertEditorWorkflow(unknown); } catch (error) { expect(String(error)).not.toMatch(/导出 API|第二|另外.*JSON/); }
  });

  it("uses a unique named converted-widget port without inventing names for other array values", () => {
    const source = { nodes: [{ id: 1, type: "PortOnly", widgets_values: [42], inputs: [{ name: "steps", type: "INT", widget: { name: "steps" }, link: null }], outputs: [{ type: "IMAGE" }] }], links: [] };
    expect(convertEditorWorkflow(source).graph["1"].inputs).toEqual({ steps: 42 });
    expect(() => convertEditorWorkflow({ ...source, nodes: [{ ...source.nodes[0], widgets_values: [42, 99] }] })).toThrow("无法还原参数");
  });

  it("keeps a live/cached contract authoritative over conflicting file metadata", () => {
    const source = { nodes: [{ id: 1, type: "CachedNode", node_def: { input: { required: { title: ["INT"] } }, output: [] }, widgets_values: ["actual string"] }], links: [] };
    const cache = { CachedNode: { input: { required: { title: ["STRING"] } }, output: [] } };
    expect(convertEditorWorkflow(source, cache).graph["1"].inputs.title).toBe("actual string");
    expect(editorWorkflowObjectInfo(source, cache).CachedNode).toEqual(cache.CachedNode);
  });

  it("discovers and executes all enabled internal subgraph saves, including separate instances", () => {
    const subgraph = { id: "save-group", inputNode: { id: -10 }, inputs: [{ name: "image", type: "IMAGE" }], nodes: [
      { id: 11, type: "Processor", widgets_values: [], inputs: [input("image", "IMAGE", 1)], outputs: [{ type: "IMAGE" }] },
      { id: 12, type: "SaveImage", widgets_values: ["nested"], inputs: [input("images", "IMAGE", 2)] },
    ], links: [[1, -10, 0, 11, 0, "IMAGE"], [2, 11, 0, 12, 0, "IMAGE"]] };
    const source = { definitions: { subgraphs: [subgraph] }, nodes: [
      { id: 1, type: "LoadImage", widgets_values: ["original.png"], outputs: [{ type: "IMAGE" }] },
      { id: 2, type: "save-group", widgets_values: [], inputs: [input("image", "IMAGE", 1)] },
      { id: 3, type: "save-group", widgets_values: [], inputs: [input("image", "IMAGE", 2)] },
      { id: 4, type: "save-group", mode: 2, widgets_values: [], inputs: [] },
    ], links: [[1, 1, 0, 2, 0, "IMAGE"], [2, 1, 0, 3, 0, "IMAGE"]] };
    expect(editorWorkflowOutputs(source, info).map(output => output.nodeId)).toEqual(["2:12", "3:12"]);
    const converted = convertEditorWorkflow(source, info);
    expect(Object.keys(converted.graph).sort()).toEqual(["1", "2:11", "2:12", "3:11", "3:12"]);
    expect(converted.graph["2:11"].inputs.image).toEqual(["1", 0]);
    expect(converted.graph["3:12"].inputs.images).toEqual(["3:11", 0]);
  });

  it("does not drop an enabled branch that cannot be reconstructed", () => {
    const source = { nodes: [
      { id: 1, type: "LoadImage", widgets_values: ["original.png"], outputs: [{ type: "IMAGE" }] },
      { id: 2, type: "SaveImage", widgets_values: ["save"], inputs: [input("images", "IMAGE", 1)] },
      { id: 3, type: "UnknownPlugin", widgets_values: ["unnamed"], outputs: [{ type: "IMAGE" }] },
      { id: 4, type: "PreviewImage", inputs: [input("images", "IMAGE", 2)], widgets_values: [] },
    ], links: [[1, 1, 0, 2, 0, "IMAGE"], [2, 3, 0, 4, 0, "IMAGE"]] };
    expect(editorWorkflowOutputs(source, info).map(output => output.nodeId)).toEqual(["2", "4"]);
    expect(() => convertEditorWorkflow(source, info)).toThrow("UnknownPlugin");
    expect(convertEditorWorkflow(source, info, "2").graph["2"]).toBeDefined();
  });

  it("allows absent trailing optional widgets without fabricating their defaults", () => {
    const source = { nodes: [{ id: 1, type: "OptionalWidget", widgets_values: ["exact"] }], links: [] };
    const schema = { OptionalWidget: { input: { required: { title: ["STRING"] }, optional: { strength: ["FLOAT", { default: .5 }] } }, output: [] } };
    expect(convertEditorWorkflow(source, schema).graph["1"].inputs).toEqual({ title: "exact" });
  });

  it("classifies API nodes with recognized top-level metadata while rejecting malformed entries", () => {
    const node = { class_type: "MyOutput", inputs: { text: "exact" } };
    expect(detectWorkflowFormat({ "1": node, workflow: { nodes: [] }, extra_pnginfo: {}, extra_data: {}, metadata: { author: "me" } })).toBe("api");
    expect(detectWorkflowFormat({ prompt: { "1": node }, workflow: { nodes: [] }, client_id: "client" })).toBe("api");
    expect(detectWorkflowFormat({ workflow: node, "1": node })).toBe("api");
    expect(() => detectWorkflowFormat({ "1": node, metadata: { class_type: "Malformed", inputs: [] } })).toThrow("有效");
    expect(() => detectWorkflowFormat({ "1": node, unrecognized: { note: "must not discard" } })).toThrow("有效");
    expect(() => detectWorkflowFormat({ extra_pnginfo: {} })).toThrow("有效");
  });

  const legacySource = () => ({ extra: { groupNodes: { ImageGroup: { nodes: [
    { type: "Processor", widgets_values: [], inputs: [input("image", "IMAGE", null)], outputs: [{ type: "IMAGE" }] },
    { type: "SaveImage", widgets_values: ["old"], inputs: [input("images", "IMAGE", 88)], outputs: [] },
  ], links: [[0, 0, 1, 0, 123, "IMAGE"]] } } }, nodes: [
    { id: 1, type: "LoadImage", widgets_values: ["original.png"], outputs: [{ type: "IMAGE" }] },
    { id: 2, type: "workflow>ImageGroup", widgets_values: ["instance"], inputs: [input("image", "IMAGE", 1)], outputs: [] },
  ], links: [[1, 1, 0, 2, 0, "IMAGE"]] });

  it("reconstructs a legacy indexed group and preserves its internal save and current instance widgets", () => {
    const source = legacySource(), before = structuredClone(source);
    expect(editorWorkflowOutputs(source, info).map(output => output.nodeId)).toEqual(["2:1"]);
    const converted = convertEditorWorkflow(source, info);
    expect(converted.graph["2:0"].inputs.image).toEqual(["1", 0]);
    expect(converted.graph["2:1"].inputs).toEqual({ filename_prefix: "instance", images: ["2:0", 0] });
    expect(source).toEqual(before);
  });

  it("keeps independent legacy instances, including the old slash separator", () => {
    const source = legacySource();
    source.nodes.push({ ...source.nodes[1], id: 3, type: "workflow/ImageGroup", widgets_values: ["second"], inputs: [input("image", "IMAGE", 2)] });
    source.links.push([2, 1, 0, 3, 0, "IMAGE"]);
    const converted = convertEditorWorkflow(source, info);
    expect(converted.graph["2:1"].inputs.filename_prefix).toBe("instance");
    expect(converted.graph["3:1"].inputs.filename_prefix).toBe("second");
    expect(Object.keys(converted.graph)).toHaveLength(5);
  });

  it("reconnects an externally exposed internal output without using old outside-node ids", () => {
    const source = legacySource();
    source.extra.groupNodes.ImageGroup.nodes.pop();
    source.extra.groupNodes.ImageGroup.links = [];
    source.nodes[1].widgets_values = [];
    source.nodes[1].outputs = [{ type: "IMAGE" }];
    source.nodes.push({ id: 3, type: "SaveImage", widgets_values: ["outside"], inputs: [input("images", "IMAGE", 2)], outputs: [] });
    source.links.push([2, 2, 0, 3, 0, "IMAGE"]);
    const converted = convertEditorWorkflow(source, info);
    expect(converted.graph["3"].inputs.images).toEqual(["2:0", 0]);
    expect(converted.graph["2:0"].inputs.image).toEqual(["1", 0]);
  });

  it("uses explicit legacy visibility and names and blocks ambiguous mismatched instance sockets", () => {
    const source = legacySource();
    Object.assign(source.extra.groupNodes.ImageGroup, { config: { 0: { input: { image: { name: "reference" } } } } });
    source.nodes[1].inputs![0].name = "reference";
    expect(convertEditorWorkflow(source, info).graph["2:0"].inputs.image).toEqual(["1", 0]);
    source.nodes[1].inputs![0].name = "wrong";
    expect(() => convertEditorWorkflow(source, info)).toThrow("外部插槽");
    Object.assign(source.extra.groupNodes.ImageGroup, { config: { 0: { input: { image: { visible: false } } } } });
    source.nodes[1].inputs = [];
    source.links = [];
    expect(() => convertEditorWorkflow(source, info)).toThrow("缺少必填输入 image");
  });

  it("maps converted widgets after normal group widgets and discards only seed UI controls", () => {
    const source = { extra: { groupNodes: { Mixed: { nodes: [
      { type: "Numbers", widgets_values: [1, "fixed", 2], inputs: [{ name: "steps", type: "INT", widget: { name: "steps" }, link: null }], outputs: [{ type: "IMAGE" }] },
      { type: "SaveImage", widgets_values: ["old"], inputs: [input("images", "IMAGE", 1)], outputs: [] },
    ], links: [[0, 0, 1, 0, 0, "IMAGE"]] } } }, nodes: [
      { id: 1, type: "workflow>Mixed", widgets_values: [42, "randomize", "current", 25], inputs: [input("steps", "INT", null)], outputs: [] },
    ], links: [] };
    const definitions = { ...info, Numbers: { input: { required: { seed: ["INT"], steps: ["INT"] } }, output: ["IMAGE"] } };
    const converted = convertEditorWorkflow(source, definitions);
    expect(converted.graph["1:0"].inputs).toEqual({ seed: 42, steps: 25 });
    expect(converted.graph["1:1"].inputs.filename_prefix).toBe("current");
  });

  it("never silently drops an enabled legacy group whose saved schema is incomplete", () => {
    const source = legacySource();
    source.extra.groupNodes.ImageGroup.nodes[0].type = "UnknownPlugin";
    source.extra.groupNodes.ImageGroup.nodes[0].widgets_values = ["unknown"];
    source.nodes.push({ id: 3, type: "SaveImage", widgets_values: ["another"], inputs: [input("images", "IMAGE", 2)], outputs: [] });
    source.links.push([2, 1, 0, 3, 0, "IMAGE"]);
    expect(() => editorWorkflowOutputs(source, info)).toThrow("UnknownPlugin");
    expect(() => convertEditorWorkflow(source, info)).toThrow("UnknownPlugin");
  });

  it("keeps explicitly hidden legacy widgets at their saved internal values", () => {
    const source = legacySource();
    Object.assign(source.extra.groupNodes.ImageGroup, { config: { 1: { input: { filename_prefix: { visible: false } } } } });
    source.nodes[1].widgets_values = [];
    expect(convertEditorWorkflow(source, info).graph["2:1"].inputs.filename_prefix).toBe("old");
  });

  it("ignores a muted unknown legacy branch and restores a bypass using its declared ports", () => {
    const source = legacySource();
    source.extra.groupNodes.ImageGroup.nodes.push({ type: "UnknownDisabled", widgets_values: ["unexplained"], inputs: [], outputs: [], mode: 2 } as typeof source.extra.groupNodes.ImageGroup.nodes[0]);
    expect(convertEditorWorkflow(source, info).graph["2:1"]).toBeDefined();
    Object.assign(source.extra.groupNodes.ImageGroup.nodes[0], { type: "UnknownBypass", mode: 4, widgets_values: ["unused plugin control"] });
    const converted = convertEditorWorkflow(source, info);
    expect(converted.graph["2:1"].inputs.images).toEqual(["1", 0]);
    expect(converted.graph["2:0"]).toBeUndefined();
  });

  it("preserves nested legacy instance overrides instead of the nested definition's old values", () => {
    const source = legacySource();
    Object.assign(source.extra.groupNodes, { Parent: { nodes: [{ type: "workflow>ImageGroup", widgets_values: ["old child"], inputs: [input("image", "IMAGE", null)], outputs: [] }], links: [] } });
    source.nodes[1].type = "workflow>Parent";
    source.nodes[1].widgets_values = ["nested current"];
    const converted = convertEditorWorkflow(source, info);
    expect(converted.graph["2:0:1"].inputs.filename_prefix).toBe("nested current");
    expect(converted.graph["2:0:0"].inputs.image).toEqual(["1", 0]);
  });

  it("propagates nested formal proxy values and rejects an ambiguous repeated proxy name", () => {
    const inner = { id: "Inner", nodes: [
      { id: 21, type: "Maker", widgets_values: [2], outputs: [{ type: "IMAGE" }] },
      { id: 22, type: "SaveImage", widgets_values: ["nested"], inputs: [input("images", "IMAGE", 1)] },
    ], links: [[1, 21, 0, 22, 0, "IMAGE"]] };
    const outer = { id: "Outer", nodes: [{ id: 11, type: "Inner", properties: { proxyWidgets: [[21, "steps"]] }, widgets_values: [2] }], links: [] };
    const source = { definitions: { subgraphs: [inner, outer] }, nodes: [{ id: 5, type: "Outer", properties: { proxyWidgets: [[11, "steps"]] }, widgets_values: [99] }], links: [] };
    const definitions = { ...info, Maker: { input: { required: { steps: ["INT"] } }, output: ["IMAGE"] } };
    expect(convertEditorWorkflow(source, definitions).graph["5:11:21"].inputs.steps).toBe(99);
    outer.nodes[0].properties.proxyWidgets.push([22, "steps"]);
    outer.nodes[0].widgets_values.push(3);
    expect(() => convertEditorWorkflow(source, definitions)).toThrow("无法唯一对应");
  });

  it("retains an explicitly saved JSON null rather than removing the literal", () => {
    const source = { nodes: [{ id: 1, type: "JsonMaker", widgets_values: { payload: null } }], links: [] };
    expect(convertEditorWorkflow(source).graph["1"].inputs).toEqual({ payload: null });
  });

  it("respects control_after_generate:false and does not swallow the next author's string widget", () => {
    const source = { nodes: [{ id: 1, type: "CustomSeed", widgets_values: [5, "randomize"] }], links: [] };
    const schema = { CustomSeed: { input: { required: { seed: ["INT", { control_after_generate: false }] }, optional: { label: ["STRING"] } }, output: [], output_node: true } };
    expect(convertEditorWorkflow(source, schema).graph["1"].inputs).toEqual({ seed: 5, label: "randomize" });
    const group = { extra: { groupNodes: { G: { nodes: [{ ...source.nodes[0], outputs: [] }], links: [] } } }, nodes: [{ id: 2, type: "workflow>G", widgets_values: [6, "fixed"], inputs: [], outputs: [] }], links: [] };
    expect(convertEditorWorkflow(group, schema).graph["2:0"].inputs).toEqual({ seed: 6, label: "fixed" });
  });

  it("reports missing node contracts with structured identity while preserving the original diagnostic", () => {
    const source = { nodes: [{ id: 134, type: "TESpeedMiniMaxH3", inputs: [
      input("model", "MODEL", null), ...["processing_control_value", "processing_percent_1", "processing_percent_2", "mcs", "device"].map((name, index) => ({ ...input(name, index < 3 ? "FLOAT" : index === 3 ? "INT" : "COMBO", null), widget: { name } })),
    ], outputs: [{ type: "MODEL" }], widgets_values: [.09, .1, .9, 2, "auto"], properties: { "Node name for S&R": "TESpeedMiniMaxH3" } }], links: [] };
    let reason: unknown;
    try { convertEditorWorkflow(source); } catch (error) { reason = error; }
    expect(reason).toBeInstanceOf(MissingWorkflowNodeDefinitionError);
    expect(reason).toMatchObject({ name: "MissingWorkflowNodeDefinitionError", nodeId: "134", nodeType: "TESpeedMiniMaxH3" });
    expect((reason as Error).message).toBe("节点 134（TESpeedMiniMaxH3）没有云端节点定义，文件也未保存足够的具名控件信息，无法还原参数。当前文件与可用节点定义不足以可靠还原此部分，请补齐节点定义或检查该节点的保存数据。");
    expect(() => convertEditorWorkflow({ nodes: [{ id: "named", type: "Unknown", widgets_values: ["anonymous"] }], links: [] })).toThrow(MissingWorkflowNodeDefinitionError);
  });

  it("does not mislabel invalid known schemas as missing node definitions", () => {
    const source = { nodes: [{ id: 134, type: "Known", widgets_values: ["wrong type"] }], links: [] };
    const schema = { Known: { input: { required: { steps: ["INT"] } }, output: [] } };
    let reason: unknown;
    try { convertEditorWorkflow(source, schema); } catch (error) { reason = error; }
    expect(reason).toBeInstanceOf(Error);
    expect(reason).not.toBeInstanceOf(MissingWorkflowNodeDefinitionError);
    expect((reason as Error).message).toContain("与 INT 定义不符");
  });
});
