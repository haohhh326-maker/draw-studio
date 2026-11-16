import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildWorkflowImport, type ImportBindings, type ImportOutputBinding } from "../src/workflow/import-analyzer";
import { writeWorkflowLibraryImport } from "../scripts/workflow-library-writer";
import { readWorkflowLibrary } from "../scripts/workflow-library-reader";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { prepareForServer } from "../src/workflow-adapter/preflight";
import { collectWorkflowOutputs, type History } from "../src/comfyui/client";
import { outputKey } from "../src/comfyui/files";
import type { ApiWorkflow, Asset, CanvasNode, MediaKind } from "../src/types";

const temporary: string[] = [];
const temporaryPrefix = "canvas-generic-import-";
afterEach(async () => {
  for (const folder of temporary.splice(0)) {
    const absolute = path.resolve(folder);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith(temporaryPrefix))
      throw new Error("Refusing to remove a path outside this test's temporary root.");
    await rm(absolute, { recursive: true, force: true });
  }
});
async function fixtureRoot() {
  const folder = await mkdtemp(path.join(os.tmpdir(), temporaryPrefix));
  temporary.push(folder);
  return folder;
}

// None of these classes is in a built-in output/loader name table. The second
// branch produces text and a document independently of the image branch.
function graphFixture(): ApiWorkflow {
  return {
    "image.source": { class_type: "AtlasReferenceReader", inputs: { source_path: "C:/original/reference.png" } },
    "image.paint": { class_type: "AtlasPainter", inputs: { reference: ["image.source", 0], scene_words: "original scene", model_name: "atlas-generic.safetensors", control_strength: 0.5, seed: 42 } },
    "image.out": { class_type: "AtlasGalleryWriter", inputs: { frames: ["image.paint", 0], filename_prefix: "original-image" } },
    "text.source": { class_type: "AtlasSentenceMaker", inputs: { topic_words: "original document", count: 3 } },
    "text.out": { class_type: "AtlasSentenceWriter", inputs: { sentence: ["text.source", 0] } },
    "file.pack": { class_type: "AtlasArchiveMaker", inputs: { sentence: ["text.source", 0], filename: "result.pdf" } },
    "file.out": { class_type: "AtlasArchiveWriter", inputs: { payload: ["file.pack", 0], filename_prefix: "original-document" } },
    "unselected": { class_type: "AnUninstalledUnrelatedPlugin", inputs: { dependency: ["unavailable", 0] } },
  };
}

const info: Record<string, unknown> = {
  AtlasReferenceReader: { input: { required: { source_path: ["STRING"] } }, output: ["IMAGE"] },
  AtlasPainter: { input: { required: { reference: ["IMAGE"], scene_words: ["STRING"], model_name: [["atlas-generic.safetensors"]], control_strength: ["FLOAT", { min: 0, max: 1 }], seed: ["INT", { min: 0, max: 1000 }] } }, output: ["IMAGE"] },
  AtlasGalleryWriter: { input: { required: { frames: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
  AtlasSentenceMaker: { input: { required: { topic_words: ["STRING"], count: ["INT", { min: 1, max: 20 }] } }, output: ["STRING"] },
  AtlasSentenceWriter: { input: { required: { sentence: ["STRING"] } }, output: [], output_node: true },
  AtlasArchiveMaker: { input: { required: { sentence: ["STRING"], filename: ["STRING"] } }, output: ["ATLAS_DOCUMENT"] },
  AtlasArchiveWriter: { input: { required: { payload: ["ATLAS_DOCUMENT"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
};
const outputBindings: ImportOutputBinding[] = [
  { nodeId: "image.out", field: "rendered_frames", kind: "image" },
  { nodeId: "text.out", field: "caption_result", kind: "text" },
  { nodeId: "file.out", field: "attachments", kind: "file" },
];
function bindings(primary: MediaKind = "image", wildcard = false): ImportBindings {
  const ordered = [...outputBindings].sort((a, b) => Number(b.kind === primary) - Number(a.kind === primary));
  return {
    outputs: wildcard ? outputBindings.map(output => ({ ...output, field: "*", kind: "file" })) : ordered,
    mediaInputs: [{ nodeId: "image.source", field: "source_path", kind: "image", label: "Reference", required: true, pathMode: "comfy-input" }],
  };
}
const options = (contract: ImportBindings) => ({ id: "custom.0123456789abcdef", name: "任意自定义多输出", family: "My custom tools", promptKey: "image.paint.scene_words", bindings: contract });
const selectedIds = ["image.source", "image.paint", "image.out", "text.source", "text.out", "file.pack", "file.out"].sort();
const asset: Asset = { id: "reference-asset", name: "reference.png", kind: "image", mime: "image/png", size: 10, createdAt: 1 };
const imageFile = { filename: "render.png", subfolder: "tasks/task-42", type: "output" as const };
const documentFile = { filename: "result.pdf", subfolder: "tasks/task-42", type: "output" as const };
function historyFixture(wildcard = false): History {
  return { outputs: wildcard ? {
    "image.out": { arbitrary_result: { generated: [imageFile] } },
    "text.out": { another_result: { text: ["first sentence", "second sentence"] } },
    "file.out": { unexpected_field: { bundle: { files: [documentFile] } } },
  } : {
    "image.out": { rendered_frames: [imageFile] },
    "text.out": { caption_result: ["first sentence", "second sentence"] },
    "file.out": { attachments: documentFile },
  } };
}

async function roundTrip(primary: "image" | "text" | "file", wildcard = false) {
  const root = await fixtureRoot();
  const source = graphFixture(), original = structuredClone(source);
  const contract = bindings(primary, wildcard);
  const built = buildWorkflowImport(source, options(wildcard ? { mediaInputs: contract.mediaInputs } : contract), info);
  expect(Object.keys(built.graph).sort()).toEqual(selectedIds);
  expect(built.graph["text.out"].inputs.sentence).toEqual(["text.source", 0]);
  expect(built.graph["file.out"].inputs.payload).toEqual(["file.pack", 0]);
  expect(built.requirements).toMatchObject({ items: [{ name: "atlas-generic.safetensors", required: true }] });

  const saved = await writeWorkflowLibraryImport(root, { filename: "arbitrary-api.json", source, graph: built.graph, config: built.config, requirements: built.requirements });
  expect((await readdir(saved.path)).sort()).toEqual(["execution.api.json", "import.meta.json", "model.requirements.json", "source.json", "workflow.config.json"]);
  expect(JSON.parse(await readFile(path.join(saved.path, "source.json"), "utf8"))).toEqual(original);
  expect(JSON.parse(await readFile(path.join(saved.path, "execution.api.json"), "utf8"))).toEqual(built.graph);
  const snapshot = await readWorkflowLibrary(root);
  expect(snapshot.issues).toEqual([]);
  expect(snapshot.scanned).toBe(1);
  expect(snapshot.workflows).toHaveLength(1);
  const restored = snapshot.workflows[0];
  const restoredOutputs = [restored.output, ...(restored.additionalOutputs ?? [])];
  expect(restored.additionalOutputs).toHaveLength(2);
  expect(restoredOutputs.map(({ nodeId, field, kind }) => ({ nodeId, field, kind }))).toEqual(contract.outputs);
  expect((await readWorkflowLibrary(root)).workflows[0].additionalOutputs).toEqual(restored.additionalOutputs);
  expect(Object.keys(restored.template ?? {}).sort()).toEqual(selectedIds);
  expect(restored.mapping).toContainEqual({ semantic: "prompt", nodeId: "image.paint", field: "scene_words" });
  expect(restored.mapping).toContainEqual({ semantic: "slot:input1", nodeId: "image.source", field: "source_path", pathMode: "comfy-input" });
  const templateBefore = structuredClone(restored.template);
  const node: CanvasNode = { id: "canvas-node", type: "media", position: { x: 0, y: 0 }, data: {
    title: "My custom result", kind: primary === "image" ? "image-generation" : primary === "text" ? "text" : "tool",
    generation: { workflowId: restored.id, prompt: "updated custom scene", negativePrompt: "", params: { control_strength: 0.7, topic_words: "updated custom document" }, taskId: null },
  } };
  const execution = buildWorkflow(restored, node, [{ semantic: "slot:input1", asset, edgeId: "reference-edge" }], { [asset.id]: "tasks/task-42/reference.png" }, "tasks/task-42/result");
  expect(execution.workflow["image.source"].inputs.source_path).toBe("input/tasks/task-42/reference.png");
  expect(execution.workflow["image.paint"].inputs).toMatchObject({ scene_words: "updated custom scene", control_strength: 0.7, model_name: "atlas-generic.safetensors", reference: ["image.source", 0] });
  expect(execution.workflow["text.source"].inputs.topic_words).toBe("updated custom document");
  const serverGraph = prepareForServer(execution.workflow, restoredOutputs.map(output => output.nodeId), info);
  expect(Object.keys(serverGraph).sort()).toEqual(selectedIds);
  expect(serverGraph["image.out"].inputs.frames).toEqual(["image.paint", 0]);
  expect(serverGraph["file.out"].inputs.payload).toEqual(["file.pack", 0]);
  for (const [index, output] of restoredOutputs.entries()) {
    if (output.nodeId === "text.out") continue;
    expect(serverGraph[output.nodeId].inputs.filename_prefix).toBe(index === 0 ? "tasks/task-42/result" : "tasks/task-42/result-output-" + index);
  }

  const collected = collectWorkflowOutputs(historyFixture(wildcard), restored);
  expect(collected.files).toHaveLength(2);
  expect(collected.files).toEqual(expect.arrayContaining([imageFile, documentFile]));
  expect(collected.fileKinds).toEqual({ [outputKey(imageFile)]: "image", [outputKey(documentFile)]: "file" });
  expect(collected.text).toBe("first sentence\nsecond sentence");
  expect(collected.textFirst).toBe(!wildcard && primary === "text");
  expect(restored.template).toEqual(templateBefore);
  expect(source).toEqual(original);
  return { root, restored, execution: serverGraph };
}

describe("generic custom workflow import, storage and execution contract", () => {
  it.each(["image", "text", "file"] as const)("round-trips a new-class API graph with %s primary and all three outputs", async primary => {
    await roundTrip(primary);
  });

  it("automatically discovers every new-class output and its unknown history fields without output bindings", async () => {
    const { restored } = await roundTrip("file", true);
    expect([restored.output, ...(restored.additionalOutputs ?? [])].every(output => output.field === "*")).toBe(true);
  });

  it.each(["missing", "wrong-type"] as const)("rejects a %s required media connection before writing a package", async failure => {
    const root = await fixtureRoot();
    const source = graphFixture();
    if (failure === "missing") delete source["image.paint"].inputs.reference;
    else source["image.paint"].inputs.reference = ["text.source", 0];
    const before = structuredClone(source);
    expect(() => buildWorkflowImport(source, options(bindings()), info)).toThrow(failure === "missing" ? /缺少必填输入/ : /连接类型不匹配/);
    expect(await readdir(root)).toEqual([]);
    expect(source).toEqual(before);
  });

  it("checks every restored branch against the server schema and rejects missing output results", async () => {
    const { restored, execution } = await roundTrip("image");
    const roots = [restored.output, ...(restored.additionalOutputs ?? [])].map(output => output.nodeId);
    const badDocument = structuredClone(execution);
    badDocument["file.out"].inputs.payload = ["image.paint", 0];
    expect(() => prepareForServer(badDocument, roots, info)).toThrow(/连接类型不匹配/);
    const badText = structuredClone(execution);
    delete badText["text.out"].inputs.sentence;
    expect(() => prepareForServer(badText, roots, info)).toThrow(/缺少必填输入/);
    const incomplete = historyFixture();
    delete incomplete.outputs["file.out"];
    expect(() => collectWorkflowOutputs(incomplete, restored)).toThrow(/file\.out\.attachments/);
  });
});
