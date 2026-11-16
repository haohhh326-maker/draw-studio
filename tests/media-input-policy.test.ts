import { expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { inferMediaInputPolicy, omitUnconnectedMedia } from "../src/workflow/media-input-policy";
import { repairApiWorkflowFromEditor } from "../src/workflow/import-repair";
import { convertLibraryWorkflow } from "../src/workflow/library-converter";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { prepareForServer } from "../src/workflow-adapter/preflight";
import type { ApiWorkflow, Asset, CanvasNode } from "../src/types";

const loader = (filename = "cloud-example.png") => ({ class_type: "Loader", inputs: { file: filename } });
const binding = (nodeId: string) => ({ semantic: "slot:" + nodeId, nodeId, field: "file" });
const groupSpec = (minimum: number, naming: { names: string[] } | { prefix: string }) => ["COMFY_AUTOGROW_V3", { template: { input: { required: { value: ["IMAGE", {}] } }, min: minimum, ...naming } }];
const schema = {
  Optional: { input: { required: { words: ["STRING", {}] }, optional: { reference: ["IMAGE", {}] } } },
  Required: { input: { required: { reference: ["IMAGE", {}] } } },
  Batch: { input: { required: { images: groupSpec(1, { prefix: "image" }) } } },
  Named: { input: { required: { refs: groupSpec(0, { names: ["first", "second", "third"] }) } } },
  Save: { input: { required: { value: ["IMAGE", {}] } } },
};

it("removes an unconnected optional loader and its sample filename from an immutable execution copy", () => {
  const graph: ApiWorkflow = { source: loader(), painter: { class_type: "Optional", inputs: { words: "draw", reference: ["source", 0] } }, result: { class_type: "Save", inputs: { value: ["painter", 0] } } };
  const snapshot = structuredClone(graph), policy = inferMediaInputPolicy(graph, [binding("source")], schema, ["result"]);
  expect(policy.optionalSemantics).toEqual(["slot:source"]);
  const omitted = omitUnconnectedMedia(graph, policy, new Set(), ["result"]);
  expect(omitted.source).toBeUndefined(); expect(omitted.painter.inputs).toEqual({ words: "draw" });
  expect(JSON.stringify(omitted)).not.toContain("cloud-example.png"); expect(graph).toEqual(snapshot);
  expect(omitUnconnectedMedia(graph, policy, new Set(["slot:source"]), ["result"])).toEqual(graph);
});

it("keeps a loader mandatory when one live consumer requires its output", () => {
  const graph: ApiWorkflow = { source: loader(), optional: { class_type: "Optional", inputs: { words: "draw", reference: ["source", 0] } }, required: { class_type: "Required", inputs: { reference: ["source", 0] } }, first: { class_type: "Save", inputs: { value: ["optional", 0] } }, second: { class_type: "Save", inputs: { value: ["required", 0] } } };
  expect(inferMediaInputPolicy(graph, [binding("source")], schema, ["first", "second"]).optionalSemantics).toEqual([]);
  expect(inferMediaInputPolicy(graph, [binding("source")], schema, ["first"]).optionalSemantics).toEqual(["slot:source"]);
});

it("uses a group minimum rather than making its first member mandatory and closes prefix gaps", () => {
  const graph: ApiWorkflow = { a: loader("example-a.png"), b: loader("example-b.png"), batch: { class_type: "Batch", inputs: { "images.image0": ["a", 0], "images.image1": ["b", 0] } }, result: { class_type: "Save", inputs: { value: ["batch", 0] } } };
  const policy = inferMediaInputPolicy(graph, [binding("a"), binding("b")], schema, ["result"]);
  expect(policy.optionalSemantics).toEqual(["slot:a", "slot:b"]); expect(policy.groups[0].minimum).toBe(1);
  expect(() => omitUnconnectedMedia(graph, policy, new Set(), ["result"])).toThrow("至少需要 1 项");
  const one = omitUnconnectedMedia(graph, policy, new Set(["slot:b"]), ["result"]);
  expect(one.a).toBeUndefined(); expect(one.batch.inputs).toEqual({ "images.image0": ["b", 0] }); expect(one.b).toBeDefined();
});

it("enforces separate group minima and preserves declared named order", () => {
  const graph: ApiWorkflow = { a: loader(), b: loader(), named: { class_type: "Named", inputs: { "refs.first": ["a", 0], "refs.second": ["b", 0] } }, batch: { class_type: "Batch", inputs: { "images.image0": ["a", 0], "images.image1": ["b", 0] } }, namedResult: { class_type: "Save", inputs: { value: ["named", 0] } }, batchResult: { class_type: "Save", inputs: { value: ["batch", 0] } } };
  const outputs = ["namedResult", "batchResult"], policy = inferMediaInputPolicy(graph, [binding("a"), binding("b")], schema, outputs);
  expect(policy.groups.map(group => group.minimum).sort()).toEqual([0, 1]);
  const one = omitUnconnectedMedia(graph, policy, new Set(["slot:b"]), outputs);
  expect(one.named.inputs).toEqual({ "refs.first": ["b", 0] }); expect(one.batch.inputs).toEqual({ "images.image0": ["b", 0] });
  expect(() => omitUnconnectedMedia(graph, policy, new Set(), outputs)).toThrow("至少需要 1 项");
});

it("counts existing non-media links and literals toward a live group minimum", () => {
  const graph: ApiWorkflow = { source: loader(), fixed: { class_type: "Fixed", inputs: {} }, batch: { class_type: "Batch", inputs: { "images.image0": ["source", 0], "images.image1": ["fixed", 0], "images.image2": { __value__: "literal" } } }, result: { class_type: "Save", inputs: { value: ["batch", 0] } } };
  const policy = inferMediaInputPolicy(graph, [binding("source")], schema, ["result"]);
  const omitted = omitUnconnectedMedia(graph, policy, new Set(), ["result"]);
  expect(omitted.batch.inputs).toEqual({ "images.image0": ["fixed", 0], "images.image1": { __value__: "literal" } }); expect(omitted.source).toBeUndefined();
});

it("does not check a group floor after its whole consumer branch is omitted", () => {
  const graph: ApiWorkflow = { source: loader(), batch: { class_type: "Batch", inputs: { "images.image0": ["source", 0] } }, outer: { class_type: "Optional", inputs: { words: "draw", reference: ["batch", 0] } }, result: { class_type: "Save", inputs: { value: ["outer", 0] } } };
  const policy = inferMediaInputPolicy(graph, [binding("source"), { semantic: "slot:batch", nodeId: "batch", field: "images.image0" }], schema, ["result"]);
  const omitted = omitUnconnectedMedia(graph, policy, new Set(), ["result"]);
  expect(omitted.batch).toBeUndefined(); expect(omitted.source).toBeUndefined(); expect(omitted.outer.inputs).toEqual({ words: "draw" });
});

it("remains conservative for unknown schemas, absent port declarations, and multiple bindings to a loader", () => {
  const graph: ApiWorkflow = { source: { class_type: "Loader", inputs: { file: "a.png", alternate: "b.png" } }, painter: { class_type: "Optional", inputs: { words: "draw", reference: ["source", 0] } }, result: { class_type: "Save", inputs: { value: ["painter", 0] } } };
  expect(inferMediaInputPolicy(graph, [binding("source")], {}, ["result"]).optionalSemantics).toEqual([]);
  expect(inferMediaInputPolicy(graph, [binding("source")], { Optional: { input: { optional: { different: ["IMAGE", {}] } } } }, ["result"]).optionalSemantics).toEqual([]);
  expect(inferMediaInputPolicy(graph, [binding("source"), { semantic: "slot:other", nodeId: "source", field: "alternate" }], schema, ["result"]).optionalSemantics).toEqual([]);
});

it("reads only the selected dynamic branch, including its nested AUTOGROW contract", () => {
  const info = { ...schema, Dynamic: { input: { required: { mode: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "variable", inputs: { required: { refs: groupSpec(1, { names: ["one", "two"] }) } } }, { key: "fixed", inputs: { required: { refs: ["IMAGE", {}] } } }] }] } } } };
  const graph: ApiWorkflow = { a: loader(), b: loader(), dynamic: { class_type: "Dynamic", inputs: { mode: "variable", "mode.refs.one": ["a", 0], "mode.refs.two": ["b", 0] } }, result: { class_type: "Save", inputs: { value: ["dynamic", 0] } } };
  const policy = inferMediaInputPolicy(graph, [binding("a"), binding("b")], info, ["result"]);
  expect(policy.optionalSemantics).toEqual(["slot:a", "slot:b"]);
  expect(omitUnconnectedMedia(graph, policy, new Set(["slot:b"]), ["result"]).dynamic.inputs).toEqual({ mode: "variable", "mode.refs.one": ["b", 0] });
  graph.dynamic.inputs.mode = "fixed";
  expect(inferMediaInputPolicy(graph, [binding("a"), binding("b")], info, ["result"]).optionalSemantics).toEqual([]);
});

it("generates canonical prefix targets even if the original group uses noncontiguous indices", () => {
  const graph: ApiWorkflow = { a: loader(), b: loader(), batch: { class_type: "Batch", inputs: { "images.image3": ["a", 0], "images.image9": ["b", 0] } }, result: { class_type: "Save", inputs: { value: ["batch", 0] } } };
  const policy = inferMediaInputPolicy(graph, [binding("a"), binding("b")], schema, ["result"]);
  expect(omitUnconnectedMedia(graph, policy, new Set(["slot:b"]), ["result"]).batch.inputs).toEqual({ "images.image0": ["b", 0] });
});

const apiFile = "E:/123/【Qwen Image 2.1】图像生成大合集_api.json", editorFile = "E:/123/【Qwen Image 2.1】图像生成大合集.json", liveSchemaFile = ".cache/media-policy-object-info.json";
it.skipIf(![apiFile, editorFile, liveSchemaFile].every(file => existsSync(file)))("omits five unused Qwen examples using the real cloud schema while preserving required image consumers", () => {
  const sourceBytes = readFileSync(apiFile), editorBytes = readFileSync(editorFile), source = JSON.parse(sourceBytes.toString("utf8"));
  const info = JSON.parse(readFileSync(liveSchemaFile, "utf8")), editor = JSON.parse(editorBytes.toString("utf8"));
  const graph = repairApiWorkflowFromEditor(source, editor, info).graph;
  const media = ["420", "432", "433", "434", "435", "436"].map(nodeId => ({ semantic: "slot:" + nodeId, nodeId, field: "image" }));
  const outputs = ["470", "414"], policy = inferMediaInputPolicy(graph, media, info, outputs);
  expect(policy.optionalSemantics.sort()).toEqual(["slot:432", "slot:433", "slot:434", "slot:435", "slot:436"]);
  const one = omitUnconnectedMedia(graph, policy, new Set(["slot:420"]), outputs);
  expect(Object.entries(one).filter(([, node]) => node.class_type === "LoadImage").map(([id]) => id)).toEqual(["420"]);
  expect(Object.keys(one["418"].inputs).filter(field => field.startsWith("images."))).toEqual(["images.image_1"]);
  expect(one["416"].inputs.model).toEqual(graph["416"].inputs.model); expect(one["426"].inputs.vae).toEqual(graph["426"].inputs.vae);
  expect(readFileSync(apiFile)).toEqual(sourceBytes); expect(readFileSync(editorFile)).toEqual(editorBytes);
});

const userPackage = "E:/123/DFCine/DFCine0.26/workflows/library/Custom-b07642e2ed455db85378af37a2437df0c21460c6ffe4abda305f0b9fa6e8bc94";
it.skipIf(!existsSync(userPackage + "/execution.api.json") || !existsSync(liveSchemaFile))("builds the current user's three-output workflow with one reference and preserves independent live capability checks without submitting", () => {
  const packageFiles = ["workflow.config.json", "execution.api.json", "model.requirements.json"];
  const before = packageFiles.map(file => readFileSync(userPackage + "/" + file));
  const [config, graph, requirements] = before.map(bytes => JSON.parse(bytes.toString("utf8")));
  const definition = convertLibraryWorkflow(config, graph, requirements, { sourcePath: userPackage, folder: "test-only", configSha256: "", executionSha256: "", executionStatus: "plain" });
  const outputs = [definition.output.nodeId, ...(definition.additionalOutputs ?? []).map(output => output.nodeId)];
  const bindings = definition.mapping.filter(mapping => definition.inputSlots?.some(slot => slot.semantic === mapping.semantic));
  const info = JSON.parse(readFileSync(liveSchemaFile, "utf8")), policy = inferMediaInputPolicy(definition.template!, bindings, info, outputs), optional = new Set(policy.optionalSemantics);
  expect(policy.optionalSemantics).toHaveLength(5);
  definition.mediaInputMode = "schema"; definition.mediaInputPolicy = policy;
  definition.inputSlots = definition.inputSlots?.map(slot => ({ ...slot, required: !optional.has(slot.semantic) }));
  definition.requiredInputs = definition.inputSlots!.filter(slot => slot.required).map(slot => slot.semantic);
  definition.optionalInputs = definition.inputSlots!.filter(slot => !slot.required).map(slot => slot.semantic);
  const slot = definition.inputSlots!.find(slot => slot.required)!;
  expect(bindings.find(binding => binding.semantic === slot.semantic)?.nodeId).toBe("420");
  const asset: Asset = { id: "read-only-validation-image", name: "reference.png", kind: "image", mime: "image/png", size: 1, createdAt: 1 };
  const node: CanvasNode = { id: "test-node", position: { x: 0, y: 0 }, data: { kind: "image-generation", title: "测试", generation: { workflowId: definition.id, prompt: definition.defaultPrompt ?? "test", negativePrompt: "", params: {}, taskId: null } } };
  const built = buildWorkflow(definition, node, [{ semantic: slot.semantic, asset, edgeId: "test-edge" }], { [asset.id]: "tasks/test/reference.png" }, "tasks/test/result");
  expect(built.workflow["420"].inputs.image).toBe("tasks/test/reference.png");
  expect(Object.values(built.workflow).filter(node => node.class_type === "LoadImage")).toHaveLength(1);
  let capabilityIssue = "";
  try { prepareForServer(built.workflow, outputs, info); } catch (error) { capabilityIssue = error instanceof Error ? error.message : String(error); }
  // A local reference fix must never bypass absent server nodes or weights.
  if (capabilityIssue) expect(capabilityIssue).toMatch(/^当前服务器未(?:注册节点|提供这些模型选项)：/);
  expect(packageFiles.map(file => readFileSync(userPackage + "/" + file))).toEqual(before);
});
