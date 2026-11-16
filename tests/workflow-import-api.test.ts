import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ApiWorkflow } from "../src/types";
import { prepareApiWorkflow } from "../src/workflow/import-api";

const info = {
  Loader: { input: { required: { model_name: [["one.safetensors", "two.safetensors"]] } }, output: ["MODEL", "CLIP", "VAE"] },
  Sample: { input: { required: { model: ["MODEL"], seed: ["INT", { default: 17, min: 0 }], enabled: ["BOOLEAN", { default: true }] } }, output: ["LATENT"] },
  Encode: { input: { required: { clip: ["CLIP"], prompt: ["STRING", { default: "" }] }, optional: { vae: ["VAE"] } }, output: ["CONDITIONING"] },
  Decode: { input: { required: { vae: ["VAE"], samples: ["LATENT"] } }, output: ["IMAGE"] },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", { default: "ComfyUI" }] } }, output: [], output_node: true },
  ModelCache: { input: { required: { model: ["MODEL"] } }, output: ["MODEL"] },
};
const node = (class_type: string, inputs: Record<string, unknown> = {}) => ({ class_type, inputs });
const fixture = (): ApiWorkflow => ({
  "1": node("Loader", { model_name: "one.safetensors" }),
  "2": node("Sample", { model: ["1", 0], seed: 91, enabled: false }),
  "3": node("Encode", { clip: ["1", 1], prompt: "Original text" }),
  "4": node("Decode", { vae: ["1", 2], samples: ["2", 0] }),
  "5": node("SaveImage", { images: ["4", 0], filename_prefix: "original/path" }),
});
const nestedDynamicSchema = (selector: Record<string, unknown> = { default: "B" }, required = true) => ({
  Nested: { input: { required: { mode: ["COMFY_DYNAMICCOMBO_V3", { default: "A", options: [
    { key: "A", inputs: { [required ? "required" : "optional"]: { sub: ["COMFY_DYNAMICCOMBO_V3", {
      options: [
        { key: "B", inputs: { required: { count: ["INT", { default: 4 }] } } },
        { key: "C", inputs: { required: { count: ["INT", { default: 9 }] } } },
      ], ...selector,
    }] } } },
    { key: "Z", inputs: { required: {} } },
  ] }] } }, output: [] },
});

describe("single-file API preparation", () => {
  it("keeps complete API values, all outputs and unknown plugin metadata intact", () => {
    const api = fixture();
    api.custom = { ...node("UnregisteredOutput", { payload: ["4", 0], opaque: { nested: ["do", "not", "interpret"] } }), _meta: { title: "Keep me" } };
    api.second = node("SaveImage", { images: ["4", 0], filename_prefix: "second" });
    const before = structuredClone(api), result = prepareApiWorkflow({ prompt: api }, info);
    expect(result.graph).toEqual(before);
    expect(result.graph).not.toBe(api);
    expect(result.repairs).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some(message => message.includes("UnregisteredOutput"))).toBe(true);
    expect(api).toEqual(before);
  });

  it("restores missing required links from the only compatible source without filling optional links", () => {
    const api = fixture();
    delete api["2"].inputs.model;
    delete api["3"].inputs.clip;
    delete api["4"].inputs.vae;
    const result = prepareApiWorkflow(api, info);
    expect(result.repairs).toEqual([
      { nodeId: "2", field: "model", value: ["1", 0], evidence: "unique-type" },
      { nodeId: "3", field: "clip", value: ["1", 1], evidence: "unique-type" },
      { nodeId: "4", field: "vae", value: ["1", 2], evidence: "unique-type" },
    ]);
    expect(result.graph["3"].inputs).not.toHaveProperty("vae");
    expect(result.errors).toEqual([]);
  });

  it("uses exact broadcaster wires even when multiple same-type loaders exist", () => {
    const api = fixture();
    api["6"] = node("Loader", { model_name: "two.safetensors" });
    api["7"] = node("ModelCache", { model: ["1", 0] });
    api["8"] = node("Anything Everywhere3", { anything: ["7", 0], anything2: ["1", 1], anything3: ["1", 2] });
    delete api["2"].inputs.model;
    delete api["3"].inputs.clip;
    const before = structuredClone(api), result = prepareApiWorkflow(api, info);
    expect(result.graph["2"].inputs.model).toEqual(["7", 0]);
    expect(result.graph["3"].inputs.clip).toEqual(["1", 1]);
    expect(result.graph["3"].inputs.vae).toEqual(["1", 2]);
    expect(result.repairs.every(repair => repair.evidence === "broadcast")).toBe(true);
    for (const [id, original] of Object.entries(before)) for (const [field, value] of Object.entries(original.inputs)) expect(result.graph[id].inputs[field]).toEqual(value);
    expect(api).toEqual(before);
    expect(result.errors).toEqual([]);
  });

  it.each(["multiple", "restricted", "unknown-type", "special-class"])("leaves uncertain broadcast %s unresolved instead of falling back to a guess", mode => {
    const api = fixture();
    api["8"] = node("Anything Everywhere", { anything: ["1", 0] });
    delete api["2"].inputs.model;
    if (mode === "multiple") {
      api["6"] = node("Loader", { model_name: "two.safetensors" });
      api["9"] = node("Anything Everywhere", { anything: ["6", 0] });
    }
    if (mode === "restricted") Object.assign(api["8"], { properties: { ue_properties: { group_restricted: 1 } } });
    if (mode === "unknown-type") {
      api.unknown = node("UnknownSource");
      api["8"].inputs.other = ["unknown", 0];
    }
    if (mode === "special-class") api["8"].class_type = "Anything Everywhere?";
    const result = prepareApiWorkflow(api, info);
    expect(result.graph["2"].inputs).not.toHaveProperty("model");
    expect(result.repairs).toEqual([]);
    expect(result.diagnostics.some(item => item.code === "broadcast-ambiguous" && item.nodeId === "2")).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("does not choose one of two typed outputs, a title-matched model or a source with unknown output types", () => {
    const api = fixture();
    delete api["2"].inputs.model;
    api["6"] = { ...node("Loader", { model_name: "two.safetensors" }), _meta: { title: "Best matching Sample MODEL" } };
    const result = prepareApiWorkflow(api, info);
    expect(result.graph["2"].inputs).not.toHaveProperty("model");
    expect(result.diagnostics.find(item => item.code === "connection-unresolved")?.candidates).toEqual([["1", 0], ["6", 0]]);
    delete api["6"];
    api.unknown = node("UnregisteredPlugin");
    expect(prepareApiWorkflow(api, info).graph["2"].inputs).not.toHaveProperty("model");
  });

  it("fills declared scalar/default and singleton choices, never a missing weight, upload or unsafe seed", () => {
    const schema = { Widgets: { input: { required: {
      count: ["INT", { default: 4, min: 1 }], text: ["STRING", { default: "" }], enabled: ["BOOLEAN", { default: false }], choice: [["only"]],
      model_name: [["one.safetensors"], { default: "one.safetensors" }], image: [["old.png"], { image_upload: true }], seed: ["INT", { default: 18446744073709552000 }],
    } }, output: [] } };
    const result = prepareApiWorkflow({ "1": node("Widgets") }, schema);
    expect(result.graph["1"].inputs).toEqual({ count: 4, text: "", enabled: false, choice: "only" });
    expect(result.repairs.every(repair => repair.evidence === "schema-default")).toBe(true);
    expect(result.diagnostics.filter(item => item.code === "missing-widget").map(item => item.field)).toEqual(["model_name", "image", "seed"]);
  });

  it("expands a selected branch after restoring its missing nested selector from the declared default", () => {
    const source = { "1": node("Nested", { mode: "A" }) }, schema = nestedDynamicSchema();
    const before = structuredClone(source), schemaBefore = structuredClone(schema);
    const result = prepareApiWorkflow(source, schema);
    expect(result.graph["1"].inputs).toEqual({ mode: "A", "mode.sub": "B", "mode.sub.count": 4 });
    expect(result.repairs).toEqual([
      { nodeId: "1", field: "mode.sub", value: "B", evidence: "schema-default" },
      { nodeId: "1", field: "mode.sub.count", value: 4, evidence: "schema-default" },
    ]);
    expect(result.errors).toEqual([]);
    expect(source).toEqual(before);
    expect(schema).toEqual(schemaBefore);
  });

  it("restores missing root and nested selectors in order without reading unselected branch defaults", () => {
    const result = prepareApiWorkflow({ "1": node("Nested") }, nestedDynamicSchema());
    expect(result.graph["1"].inputs).toEqual({ mode: "A", "mode.sub": "B", "mode.sub.count": 4 });
    expect(result.repairs.map(item => item.field)).toEqual(["mode", "mode.sub", "mode.sub.count"]);
    expect(result.errors).toEqual([]);
    const selected = prepareApiWorkflow({ "1": node("Nested", { mode: "Z" }) }, nestedDynamicSchema());
    expect(selected.graph["1"].inputs).toEqual({ mode: "Z" });
    expect(selected.repairs).toEqual([]);
    expect(selected.errors).toEqual([]);
  });

  it("continues expanding successive nested selector defaults before filling the final scalar", () => {
    const schema = nestedDynamicSchema({ default: "B", options: [{ key: "B", inputs: { required: {
      inner: ["COMFY_DYNAMICCOMBO_V3", { default: "last", options: [{ key: "last", inputs: { required: { count: ["INT", { default: 4 }] } } }] }],
    } } }] });
    const result = prepareApiWorkflow({ "1": node("Nested", { mode: "A" }) }, schema);
    expect(result.graph["1"].inputs).toEqual({ mode: "A", "mode.sub": "B", "mode.sub.inner": "last", "mode.sub.inner.count": 4 });
    expect(result.repairs.map(item => item.field)).toEqual(["mode.sub", "mode.sub.inner", "mode.sub.inner.count"]);
    expect(result.errors).toEqual([]);
  });

  it("preserves a saved nested selection and its literal value instead of substituting defaults", () => {
    const source = { "1": node("Nested", { mode: "A", "mode.sub": "C", "mode.sub.count": 23 }) };
    const result = prepareApiWorkflow(source, nestedDynamicSchema());
    expect(result.graph).toEqual(source);
    expect(result.repairs).toEqual([]);
    expect(result.errors).toEqual([]);
    const missingCount = prepareApiWorkflow({ "1": node("Nested", { mode: "A", "mode.sub": "C" }) }, nestedDynamicSchema());
    expect(missingCount.graph["1"].inputs["mode.sub.count"]).toBe(9);
  });

  it.each([{}, { default: "missing" }, { default: "B", options: [
    { key: "B", inputs: { required: {} } }, { key: "B", inputs: { required: {} } },
  ] }])("does not fill a nested selector without a valid uniquely declared branch (%j)", selector => {
    const result = prepareApiWorkflow({ "1": node("Nested", { mode: "A" }) }, nestedDynamicSchema(selector));
    expect(result.graph["1"].inputs).toEqual({ mode: "A" });
    expect(result.repairs).toEqual([]);
    expect(result.diagnostics.some(item => item.code === "schema-invalid" && item.message.includes("mode.sub"))).toBe(true);
  });

  it.each([null, "missing"])("does not replace an existing invalid nested selector (%j)", selected => {
    const source = { "1": node("Nested", { mode: "A", "mode.sub": selected }) };
    const result = prepareApiWorkflow(source, nestedDynamicSchema());
    expect(result.graph).toEqual(source);
    expect(result.repairs).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("does not enable an omitted optional nested selector even when it declares a default", () => {
    const result = prepareApiWorkflow({ "1": node("Nested", { mode: "A" }) }, nestedDynamicSchema({ default: "B" }, false));
    expect(result.graph["1"].inputs).toEqual({ mode: "A" });
    expect(result.repairs).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("does not restore model or upload selections from defaults inside a nested branch", () => {
    const schema = nestedDynamicSchema({ default: "B", options: [{ key: "B", inputs: { required: {
      count: ["INT", { default: 4 }], model: ["COMBO", { default: "auto", options: ["auto"] }],
      model_name: [["one.gguf"], { default: "one.gguf" }], image: [["old.png"], { image_upload: true, default: "old.png" }],
      file_path: ["STRING", { default: "/tmp/author.png" }], filename: ["STRING", { default: "author.png" }],
    } } }] });
    const result = prepareApiWorkflow({ "1": node("Nested", { mode: "A" }) }, schema);
    expect(result.graph["1"].inputs).toEqual({ mode: "A", "mode.sub": "B", "mode.sub.count": 4 });
    expect(result.diagnostics.filter(item => item.code === "missing-widget").map(item => item.field)).toEqual(["mode.sub.model", "mode.sub.model_name", "mode.sub.image", "mode.sub.file_path", "mode.sub.filename"]);
  });

  it("does not overwrite a present invalid value or an existing connection with a schema default or inferred source", () => {
    const api = fixture();
    api["2"].inputs.seed = null;
    api["2"].inputs.model = ["missing", 0];
    const result = prepareApiWorkflow(api, info);
    expect(result.graph["2"].inputs).toEqual(api["2"].inputs);
    expect(result.repairs).toEqual([]);
    expect(result.errors.some(error => error.includes("missing"))).toBe(true);
  });

  it("does not create a cycle or use a wildcard output as proof of a compatible source", () => {
    const schema = { Consumer: { input: { required: { payload: ["OPAQUE"] } }, output: ["OPAQUE"] }, Wildcard: { input: { required: {} }, output: ["*"] } };
    const graph = { "1": node("Consumer"), "2": node("Consumer", { payload: ["1", 0] }), "3": node("Wildcard") };
    const result = prepareApiWorkflow(graph, schema);
    expect(result.graph["1"].inputs).not.toHaveProperty("payload");
    expect(result.repairs).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("does not claim a known source is unique while another output remains a wildcard", () => {
    const api = fixture();
    delete api["2"].inputs.model;
    api.extra = node("Wildcard");
    const result = prepareApiWorkflow(api, { ...info, Wildcard: { input: { required: {} }, output: ["*"] } });
    expect(result.graph["2"].inputs).not.toHaveProperty("model");
    expect(result.diagnostics.some(item => item.nodeId === "2" && item.message.includes("未确定"))).toBe(true);
  });

  it("supports editor metadata beside bare API nodes without treating metadata as an executable node", () => {
    const api = fixture();
    const result = prepareApiWorkflow({ ...api, extra_pnginfo: { workflow: { nodes: [], links: [] } } }, info);
    expect(result.graph).toEqual(api);
    expect(result.graph).not.toHaveProperty("extra_pnginfo");
  });

  it("accepts recognized bare API metadata without an embedded editor graph", () => {
    const api = fixture();
    const source = { ...api, metadata: { author: "me" }, extra_data: { client: "desktop" }, extra_pnginfo: {}, workflow: { description: "API-only metadata" } };
    const before = structuredClone(source), result = prepareApiWorkflow(source, info);
    expect(result.graph).toEqual(api);
    expect(result.errors).toEqual([]);
    expect(source).toEqual(before);
  });

  it("retains valid metadata-named nodes and rejects malformed node-shaped or unknown entries", () => {
    const api = fixture();
    api.metadata = node("SaveImage", { images: ["4", 0], filename_prefix: "another result" });
    expect(prepareApiWorkflow(api, info).graph.metadata).toEqual(api.metadata);
    expect(() => prepareApiWorkflow({ ...api, metadata: { class_type: "Malformed", inputs: [] } }, info)).toThrow();
    expect(() => prepareApiWorkflow({ ...api, extra_data: { inputs: {} } }, info)).toThrow();
    expect(() => prepareApiWorkflow({ ...api, unrecognized: { note: "must not discard" } }, info)).toThrow();
    expect(prepareApiWorkflow({ prompt: api, metadata: { class_type: "OutsidePrompt", inputs: [] } }, info).graph).toEqual(api);
  });

  it("restores explicit connection evidence from embedded editor metadata in the same file", () => {
    const schema = { Loader: info.Loader, Sample: { input: { required: { model: ["MODEL"], seed: ["INT"] } }, output: ["LATENT"] } };
    const api = { "1": node("Loader", { model_name: "one.safetensors" }), "2": node("Sample", { seed: 91 }) };
    const workflow = { nodes: [
      { id: 1, type: "Loader", inputs: [], outputs: [{ type: "MODEL" }, { type: "CLIP" }, { type: "VAE" }], widgets_values: { model_name: "one.safetensors" } },
      { id: 2, type: "Sample", inputs: [{ name: "model", type: "MODEL", link: 5 }], outputs: [{ type: "LATENT" }], widgets_values: { seed: 33 } },
    ], links: [[5, 1, 0, 2, 0, "MODEL"]] };
    const source = { prompt: api, extra_data: { extra_pnginfo: { workflow: JSON.stringify(workflow) } } }, before = structuredClone(source);
    const result = prepareApiWorkflow(source, schema);
    expect(result.repairs).toEqual([{ nodeId: "2", field: "model", value: ["1", 0], evidence: "embedded-editor" }]);
    expect(result.graph["2"].inputs.seed).toBe(91);
    expect(result.errors).toEqual([]);
    expect(source).toEqual(before);
  });

  it("prioritizes the API prompt inside an envelope that also contains top-level editor nodes", () => {
    const schema = { Loader: info.Loader, Sample: { input: { required: { model: ["MODEL"], seed: ["INT"] } }, output: ["LATENT"] } };
    const api = { "1": node("Loader", { model_name: "one.safetensors" }), "2": node("Sample", { seed: 91 }) };
    const source = { prompt: api, nodes: [
      { id: 1, type: "Loader", inputs: [], outputs: [{ type: "MODEL" }, { type: "CLIP" }, { type: "VAE" }], widgets_values: { model_name: "one.safetensors" } },
      { id: 2, type: "Sample", inputs: [{ name: "model", type: "MODEL", link: 5 }], outputs: [{ type: "LATENT" }], widgets_values: { seed: 33 } },
    ], links: [[5, 1, 0, 2, 0, "MODEL"]] };
    const before = structuredClone(source), result = prepareApiWorkflow(source, schema);
    expect(result.graph["2"].inputs).toEqual({ seed: 91, model: ["1", 0] });
    expect(result.repairs).toEqual([{ nodeId: "2", field: "model", value: ["1", 0], evidence: "embedded-editor" }]);
    expect(result.errors).toEqual([]);
    expect(source).toEqual(before);
  });

  it("diagnoses conflicting embedded metadata while preserving all API values", () => {
    const api = fixture();
    const a = { nodes: [], links: [] }, b = { nodes: [{ id: 1, type: "Other" }], links: [] };
    const result = prepareApiWorkflow({ prompt: api, workflow: a, extra_pnginfo: { workflow: b } }, info);
    expect(result.graph).toEqual(api);
    expect(result.diagnostics.some(item => item.code === "embedded-editor-ambiguous")).toBe(true);
  });

  it("works offline as an unchanged API clone with concrete structural diagnostics", () => {
    const api = fixture();
    delete api["4"].inputs.vae;
    api["4"].class_type = "VAEDecode";
    const result = prepareApiWorkflow(api);
    expect(result.graph).toEqual(api);
    expect(result.repairs).toEqual([]);
    expect(result.errors.some(message => message.includes("vae"))).toBe(true);
    expect(result.warnings.some(message => message.includes("未读取云端"))).toBe(true);
  });
});

const apiPath = "E:/123/【Qwen Image 2.1】图像生成大合集_api.json";
const infoPath = ".cache/directory-cloud-capabilities.json";
it.skipIf(![apiPath, infoPath].every(existsSync))("prepares the real Qwen API alone, recovers its four broadcaster links and preserves all 28 original nodes/weights", () => {
  const bytes = readFileSync(apiPath), original = JSON.parse(bytes.toString("utf8")) as ApiWorkflow;
  const schema = JSON.parse(readFileSync(infoPath, "utf8")).objectInfo;
  const result = prepareApiWorkflow(original, schema);
  expect(result.repairs).toEqual([
    { nodeId: "416", field: "model", value: ["471", 0], evidence: "broadcast" },
    { nodeId: "418", field: "clip", value: ["192", 0], evidence: "broadcast" },
    { nodeId: "418", field: "vae", value: ["197", 0], evidence: "broadcast" },
    { nodeId: "426", field: "vae", value: ["197", 0], evidence: "broadcast" },
  ]);
  expect(Object.keys(result.graph)).toEqual(Object.keys(original));
  expect(Object.keys(result.graph)).toHaveLength(28);
  for (const [id, item] of Object.entries(original)) for (const [field, value] of Object.entries(item.inputs)) expect(result.graph[id].inputs[field]).toEqual(value);
  expect(result.graph["310"].inputs.unet_name).toBe("qwen_image_2.1_bf16.safetensors");
  expect(result.errors).toEqual([]);
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  expect(hash(readFileSync(apiPath))).toBe(hash(bytes));
});
