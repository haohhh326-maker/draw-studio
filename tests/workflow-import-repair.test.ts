import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { convertEditorWorkflow, editorWorkflowOutputs } from "../src/workflow/import-editor";
import { repairApiWorkflowFromEditor } from "../src/workflow/import-repair";
import { validateImportGraph } from "../src/workflow/import-analyzer";
import { prepareApiWorkflow } from "../src/workflow/import-api";
import type { ApiWorkflow } from "../src/types";

const info = {
  GenericMux: { input: { required: { model_name: [["generic.safetensors", "other.safetensors"]] } }, output: ["MODEL", "CLIP", "VAE"] },
  GenericWords: { input: { required: { words: ["STRING"] } }, output: ["STRING"] },
  GenericEncode: { input: { required: { clip: ["CLIP"], words: ["STRING"] } }, output: ["CONDITIONING"] },
  GenericSample: { input: { required: { model: ["MODEL"], conditioning: ["CONDITIONING"], prompt: ["STRING"], seed: ["INT"], strength: ["FLOAT"] }, optional: { vae: ["VAE"] } }, output: ["LATENT"] },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], display_name: "Save Image", output_node: true },
  PreviewImage: { input: { required: { images: ["IMAGE"] } }, output: [], output_node: true },
};
const port = (name: string, type: string, link?: number) => ({ name, type, ...(link === undefined ? {} : { link }) });
function editorFixture(broadcast = false) {
  return {
    nodes: [
      { id: 5, type: "GenericMux", widgets_values: { model_name: "generic.safetensors" }, inputs: [], outputs: [{ type: "MODEL" }, { type: "CLIP" }, { type: "VAE" }] },
      { id: 3, type: "GenericWords", widgets_values: { words: "editor words" }, inputs: [], outputs: [{ type: "STRING" }] },
      { id: 11, type: "GenericEncode", widgets_values: { words: "editor text" }, inputs: [port("clip", "CLIP", broadcast ? undefined : 2)], outputs: [{ type: "CONDITIONING" }] },
      { id: 17, type: "GenericSample", widgets_values: { prompt: "editor prompt", seed: 22, strength: 0.5 }, inputs: [port("model", "MODEL", broadcast ? undefined : 1), port("conditioning", "CONDITIONING", 3), port("prompt", "STRING", 5), port("vae", "VAE", broadcast ? undefined : 4)], outputs: [{ type: "LATENT" }] },
      { id: 70, type: "UnregisteredOutputPlugin", inputs: [port("payload", "LATENT", 6)], widgets_values: ["unrecognized dynamic widget"] },
      ...(broadcast ? [{ id: 99, type: "Anything Everywhere3", widgets_values: [], inputs: [port("anything", "*", 7), port("anything2", "*", 8), port("anything3", "*", 9)], properties: { group_restricted: 0, color_restricted: 0 } }] : []),
    ],
    links: [
      ...(!broadcast ? [[1, 5, 0, 17, 0, "MODEL"], [2, 5, 1, 11, 0, "CLIP"], [4, 5, 2, 17, 3, "VAE"]] : [[7, 5, 0, 99, 0, "MODEL"], [8, 5, 1, 99, 1, "CLIP"], [9, 5, 2, 99, 2, "VAE"]]),
      [3, 11, 0, 17, 1, "CONDITIONING"], [5, 3, 0, 17, 2, "STRING"], [6, 17, 0, 70, 0, "LATENT"],
    ],
  };
}
function apiFixture(editor = editorFixture()): ApiWorkflow {
  const graph = convertEditorWorkflow(editor, info, "17").graph;
  delete graph["17"].inputs.model;
  delete graph["11"].inputs.clip;
  delete graph["17"].inputs.vae;
  graph["70"] = { class_type: "UnregisteredOutputPlugin", inputs: { payload: ["17", 0], opaque_option: { nested: [1, 2, 3] } } };
  return graph;
}
const expected = [
  { nodeId: "11", field: "clip", value: ["5", 1] },
  { nodeId: "17", field: "model", value: ["5", 0] },
  { nodeId: "17", field: "vae", value: ["5", 2] },
];

describe("companion editor API wire recovery", () => {
  it.each([false, true])("recovers generic explicit/broadcast wires (broadcast %s) without converting unknown output branches", broadcast => {
    const editor = editorFixture(broadcast), api = apiFixture(editor);
    const before = structuredClone({ api, editor });
    const result = repairApiWorkflowFromEditor({ prompt: api }, editor, info);
    expect(result.repairs).toEqual(expected);
    expect(result.graph["70"]).toEqual(api["70"]);
    for (const [id, node] of Object.entries(api)) for (const [field, value] of Object.entries(node.inputs)) expect(result.graph[id].inputs[field]).toEqual(value);
    expect(validateImportGraph(result.graph, info).errors).toEqual([]);
    expect({ api, editor }).toEqual(before);
  });

  it("keeps API primitive literals, literal wrappers, seed and other widgets authoritative", () => {
    const editor = editorFixture(), api = apiFixture(editor);
    api["17"].inputs.prompt = { __value__: "API literal prompt" };
    api["17"].inputs.seed = 91;
    api["11"].inputs.words = "API text";
    const before = structuredClone(api);
    const result = repairApiWorkflowFromEditor(api, editor, info);
    expect(result.repairs).toEqual(expected);
    expect(result.graph["17"].inputs.prompt).toEqual({ __value__: "API literal prompt" });
    expect(result.graph["17"].inputs.seed).toBe(91);
    expect(result.graph["11"].inputs.words).toBe("API text");
    expect(result.warnings.some(warning => warning.includes("17.prompt") && warning.includes("保留 API 原值"))).toBe(true);
    expect(api).toEqual(before);
  });

  it("adds only missing dependencies needed by restored wires and does not add a replaced primitive upstream", () => {
    const editor = editorFixture(), api = apiFixture(editor);
    delete api["5"];
    delete api["3"];
    api["17"].inputs.prompt = "authoritative API text";
    const result = repairApiWorkflowFromEditor(api, editor, info);
    expect(result.graph["5"]).toEqual({ class_type: "GenericMux", inputs: { model_name: "generic.safetensors" }, _meta: { title: "GenericMux" } });
    expect(result.graph["3"]).toBeUndefined();
    expect(result.graph["17"].inputs.prompt).toBe("authoritative API text");
    expect(result.repairs).toEqual(expected);
  });

  it("does not replace an existing typed connection while repairing another port", () => {
    const editor = editorFixture(), api = apiFixture(editor);
    api["17"].inputs.model = ["5", 0];
    const result = repairApiWorkflowFromEditor(api, editor, info);
    expect(result.graph["17"].inputs.model).toEqual(["5", 0]);
    expect(result.repairs.some(repair => repair.nodeId === "17" && repair.field === "model")).toBe(false);
  });

  it.each(["class", "connection", "model", "missing-root", "disabled"] as const)("rejects companion mismatch %s without changing either source", failure => {
    const editor = editorFixture(), api = apiFixture(editor);
    if (failure === "class") editor.nodes.find(node => node.id === 17)!.type = "DifferentSampler";
    if (failure === "connection") api["17"].inputs.conditioning = ["5", 0];
    if (failure === "model") api["5"].inputs.model_name = "other.safetensors";
    if (failure === "missing-root") editor.nodes = editor.nodes.filter(node => node.id !== 17);
    if (failure === "disabled") Object.assign(editor.nodes.find(node => node.id === 17)!, { mode: 2 });
    const before = structuredClone({ api, editor });
    expect(() => repairApiWorkflowFromEditor(api, editor, info)).toThrow(/无法可靠配对/);
    expect({ api, editor }).toEqual(before);
  });

  it("preserves localized default metadata without treating display names as structural identities", () => {
    const editor = editorFixture(), api = apiFixture(editor);
    api["17"]._meta = { title: "采样器" };
    const result = repairApiWorkflowFromEditor(api, editor, { ...info, GenericSample: { ...info.GenericSample, display_name: "Generic Sample" } });
    expect(result.graph["17"]._meta?.title).toBe("采样器");
    expect(result.repairs).toEqual(expected);
    Object.assign(editor.nodes.find(node => node.id === 17)!, { title: "my companion sampler" });
    expect(repairApiWorkflowFromEditor(api, editor, info).graph["17"]._meta?.title).toBe("采样器");
  });

  it("refuses ambiguous or restricted implicit propagation instead of choosing a model by name", () => {
    const editor = editorFixture(true), api = apiFixture(editor);
    const source = editor.nodes.find(node => node.id === 99)!;
    Object.assign(source, { properties: { group_restricted: 1 } });
    expect(() => repairApiWorkflowFromEditor(api, editor, info)).toThrow(/限制|筛选/);
    Object.assign(source, { properties: { group_restricted: 0, color_restricted: 0 } });
    editor.nodes.push({ id: 25, type: "GenericMux", widgets_values: { model_name: "other.safetensors" }, inputs: [], outputs: [{ type: "MODEL" }, { type: "CLIP" }, { type: "VAE" }] });
    editor.nodes.push({ id: 199, type: "Anything Everywhere3", widgets_values: [], inputs: [port("anything", "*", 17)], properties: { group_restricted: 0, color_restricted: 0 } } as never);
    editor.links.push([17, 25, 0, 199, 0, "MODEL"]);
    expect(() => repairApiWorkflowFromEditor(api, editor, info)).toThrow(/多个|歧义|唯一/);
  });

  it("returns an unchanged clone when no typed required port is missing", () => {
    const editor = editorFixture(), api = convertEditorWorkflow(editor, info, "17").graph;
    const result = repairApiWorkflowFromEditor(api, editor, info);
    expect(result.repairs).toEqual([]);
    expect(result.graph).toEqual(api);
    expect(result.graph).not.toBe(api);
  });

  it("restores named scalar and exact model selections even when every required connection is present", () => {
    const editor = editorFixture(), api = convertEditorWorkflow(editor, info, "17").graph;
    delete api["5"].inputs.model_name;
    delete api["11"].inputs.words;
    delete api["17"].inputs.seed;
    delete api["17"].inputs.strength;
    api["17"].inputs.prompt = "Keep the API prompt";
    api["70"] = { class_type: "UnregisteredOutputPlugin", inputs: { opaque: { arbitrary: ["data"] } } };
    const before = structuredClone({ api, editor });
    const result = repairApiWorkflowFromEditor(api, editor, info);
    expect(result.repairs).toEqual([
      { nodeId: "5", field: "model_name", value: "generic.safetensors" },
      { nodeId: "11", field: "words", value: "editor text" },
      { nodeId: "17", field: "seed", value: 22 },
      { nodeId: "17", field: "strength", value: 0.5 },
    ]);
    for (const [id, node] of Object.entries(api)) for (const [field, value] of Object.entries(node.inputs)) expect(result.graph[id].inputs[field]).toEqual(value);
    expect(result.graph["70"]).toEqual(api["70"]);
    expect(result.warnings.some(message => message.includes("17.seed 的保存值"))).toBe(true);
    expect({ api, editor }).toEqual(before);
  });

  it("restores an explicit optional wire without requiring another missing mandatory connection", () => {
    const editor = editorFixture(), api = convertEditorWorkflow(editor, info, "17").graph;
    delete api["17"].inputs.vae;
    const before = structuredClone({ api, editor });
    const result = repairApiWorkflowFromEditor(api, editor, info);
    expect(result.repairs).toEqual([{ nodeId: "17", field: "vae", value: ["5", 2] }]);
    expect(validateImportGraph(result.graph, info).errors).toEqual([]);
    expect({ api, editor }).toEqual(before);
  });

  it("recovers an explicit primitive wire and only its required missing dependency", () => {
    const editor = editorFixture(), api = convertEditorWorkflow(editor, info, "17").graph;
    delete api["17"].inputs.prompt;
    delete api["3"];
    const result = repairApiWorkflowFromEditor(api, editor, info);
    expect(result.repairs).toEqual([{ nodeId: "17", field: "prompt", value: ["3", 0] }]);
    expect(result.graph["3"]).toMatchObject({ class_type: "GenericWords", inputs: { words: "editor words" } });
    expect(api).not.toHaveProperty("3");
    expect(validateImportGraph(result.graph, info).errors).toEqual([]);
  });

  it("uses the same-file saved widget before a different server default, preserving false and existing API inputs", () => {
    const schema = { SavedWidget: { input: { required: { text: ["STRING", { default: "server default" }], seed: ["INT", { default: 17 }], enabled: ["BOOLEAN", { default: true }] } }, output: [] } };
    const source = { prompt: { "1": { class_type: "SavedWidget", inputs: { text: "API authoritative" } } },
      workflow: { nodes: [{ id: 1, type: "SavedWidget", widgets_values: { text: "editor value", seed: 91, enabled: false }, inputs: [], outputs: [] }], links: [] } };
    const before = structuredClone(source), result = prepareApiWorkflow(source, schema);
    expect(result.graph["1"].inputs).toEqual({ text: "API authoritative", seed: 91, enabled: false });
    expect(result.repairs).toEqual([
      { nodeId: "1", field: "seed", value: 91, evidence: "embedded-editor" },
      { nodeId: "1", field: "enabled", value: false, evidence: "embedded-editor" },
    ]);
    expect(result.errors).toEqual([]);
    expect(source).toEqual(before);
  });

  it("does not fabricate an optional connection when the editor does not explicitly link it", () => {
    const editor = editorFixture(true), api = convertEditorWorkflow(editor, info, "17").graph;
    delete api["17"].inputs.vae;
    const result = repairApiWorkflowFromEditor(api, editor, info);
    expect(result.repairs).toEqual([]);
    expect(result.graph["17"].inputs).not.toHaveProperty("vae");
  });

  it("rejects conflicting metadata bindings before filling a missing widget", () => {
    const editor = editorFixture(), api = convertEditorWorkflow(editor, info, "17").graph;
    delete api["17"].inputs.seed;
    api["17"].inputs.conditioning = ["5", 0];
    const before = structuredClone({ api, editor });
    expect(() => repairApiWorkflowFromEditor(api, editor, info)).toThrow(/已有连接 17.conditioning.*不一致/);
    expect({ api, editor }).toEqual(before);
  });

  it("keeps every enabled preview and save while excluding virtual helpers", () => {
    const source = { nodes: [
      { id: 1, type: "UnknownImageSource", outputs: [{ type: "IMAGE" }] },
      { id: 2, type: "UnknownCollage", outputs: [{ type: "IMAGE" }] },
      { id: 3, type: "SaveImage", inputs: [port("images", "IMAGE", 1)] },
      { id: 4, type: "PreviewImage", inputs: [port("images", "IMAGE", 2)] },
      { id: 5, type: "PreviewImage", inputs: [port("images", "IMAGE", 3)] },
      { id: 6, type: "SetNode", inputs: [] },
    ], links: [[1, 1, 0, 3, 0, "IMAGE"], [2, 1, 0, 4, 0, "IMAGE"], [3, 2, 0, 5, 0, "IMAGE"]] };
    expect(editorWorkflowOutputs(source, { ...info, SetNode: { output_node: true } }).map(output => output.nodeId)).toEqual(["3", "4", "5"]);
  });
});

const apiPath = "E:/123/【Qwen Image 2.1】图像生成大合集_api.json";
const editorPath = "E:/123/【Qwen Image 2.1】图像生成大合集.json";
const infoPath = ".cache/directory-cloud-capabilities.json";
it.skipIf(![apiPath, editorPath, infoPath].every(existsSync))("recovers the unchanged real Qwen API's four implicit connections while retaining all 28 original nodes", () => {
  const originalApi = readFileSync(apiPath), originalEditor = readFileSync(editorPath);
  const api = JSON.parse(originalApi.toString("utf8")), editor = JSON.parse(originalEditor.toString("utf8"));
  const schema = JSON.parse(readFileSync(infoPath, "utf8")).objectInfo;
  const result = repairApiWorkflowFromEditor(api, editor, schema);
  expect(Object.keys(result.graph)).toEqual(Object.keys(api));
  expect(result.repairs).toEqual([
    { nodeId: "416", field: "model", value: ["471", 0] },
    { nodeId: "418", field: "clip", value: ["192", 0] },
    { nodeId: "418", field: "vae", value: ["197", 0] },
    { nodeId: "426", field: "vae", value: ["197", 0] },
  ]);
  for (const [id, node] of Object.entries(api as ApiWorkflow)) for (const [field, value] of Object.entries(node.inputs)) expect(result.graph[id].inputs[field]).toEqual(value);
  expect(result.graph["423"]).toEqual(api["423"]);
  expect(editorWorkflowOutputs(editor, schema).map(output => output.nodeId)).toEqual(["414", "470", "496"]);
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  expect(hash(readFileSync(apiPath))).toBe(hash(originalApi));
  expect(hash(readFileSync(editorPath))).toBe(hash(originalEditor));
});
