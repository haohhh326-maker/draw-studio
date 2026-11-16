import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { apiGraph } from "../src/workflow/library-converter";
import { repairApiWorkflowFromEditor } from "../src/workflow/import-repair";
import { buildWorkflowImport } from "../src/workflow/import-analyzer";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import { writeWorkflowLibraryImport } from "../scripts/workflow-library-writer";
import { readWorkflowLibrary } from "../scripts/workflow-library-reader";
import type { Asset, CanvasNode } from "../src/types";
import type { ResolvedInput } from "../src/semantic/resolver";

const apiFile = "E:/123/【Qwen Image 2.1】图像生成大合集_api.json";
const editorFile = "E:/123/【Qwen Image 2.1】图像生成大合集.json";
const capabilities = ".cache/directory-cloud-capabilities.json";
const available = existsSync(apiFile) && existsSync(editorFile) && existsSync(capabilities);
const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0)) {
    const resolved = path.resolve(root), tempRoot = path.resolve(os.tmpdir());
    if (!resolved.startsWith(tempRoot + path.sep) || !path.basename(root).startsWith("canvas-api-repair-test-")) throw new Error("Refusing cleanup outside the named fixture directory");
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-api-repair-test-")); temporary.push(root);
  const apiBytes = await readFile(apiFile), editorBytes = await readFile(editorFile);
  return { root, apiBytes, editorBytes, source: JSON.parse(apiBytes.toString("utf8")), editor: JSON.parse(editorBytes.toString("utf8")), info: JSON.parse(await readFile(capabilities, "utf8")).objectInfo };
}

it.skipIf(!available)("preserves the user's complete API source while repairing and registering all three output branches from its companion editor", async () => {
  const fixtureData = await fixture(), { root, source, editor, info, apiBytes, editorBytes } = fixtureData;
  const original = apiGraph(source);
  const repaired = repairApiWorkflowFromEditor(source, editor, info);
  expect(Object.keys(original)).toHaveLength(28);
  expect(repaired.repairs).toHaveLength(4);
  expect(repaired.repairs.map(repair => repair.nodeId + "." + repair.field).sort()).toEqual(["416.model", "418.clip", "418.vae", "426.vae"]);
  for (const [id, node] of Object.entries(original)) {
    expect(repaired.graph[id].class_type).toBe(node.class_type);
    for (const [field, value] of Object.entries(node.inputs)) expect(repaired.graph[id].inputs[field]).toEqual(value);
  }
  expect(source).toEqual(JSON.parse(apiBytes.toString("utf8")));
  const built = buildWorkflowImport(repaired.graph, { id: "custom." + createHash("sha256").update(JSON.stringify(source)).digest("hex"), name: "Qwen API 修复合集", family: "我的工作流", promptKey: "494.prompt" }, info);
  const saved = await writeWorkflowLibraryImport(root, { filename: path.basename(apiFile), source, graph: built.graph, config: built.config, requirements: built.requirements });
  expect((await readdir(saved.path)).sort()).toEqual(["execution.api.json", "import.meta.json", "model.requirements.json", "source.json", "workflow.config.json"]);
  expect(JSON.parse(await readFile(path.join(saved.path, "source.json"), "utf8"))).toEqual(source);
  const snapshot = await readWorkflowLibrary(root); expect(snapshot.issues).toEqual([]); expect(snapshot.workflows).toHaveLength(1);
  const workflow = snapshot.workflows[0];
  expect(workflow.additionalOutputs).toHaveLength(2);
  expect(workflow.original?.executionStatus).toBe("plain"); expect(workflow.library?.executionIssue).toBeUndefined();
  expect(workflow.template?.["421"]).toBeDefined(); expect(workflow.template?.["423"]).toBeDefined();
  expect(Object.values(workflow.template ?? {}).some(node => /^(?:SetNode|GetNode|Anything Everywhere(?:3)?)$/.test(node.class_type))).toBe(false);
  expect(await readFile(apiFile)).toEqual(apiBytes); expect(await readFile(editorFile)).toEqual(editorBytes);
});

it.skipIf(!available)("builds the repaired 470 branch without replacing any original API widget values or six reference bindings", async () => {
  const { root, source, editor, info, apiBytes, editorBytes } = await fixture();
  const original = apiGraph(source), repaired = repairApiWorkflowFromEditor(source, editor, info);
  const built = buildWorkflowImport(repaired.graph, { id: "custom." + createHash("sha256").update(JSON.stringify(source)).digest("hex"), name: "Qwen API 六图", family: "我的工作流", outputNodeId: "470", promptKey: "494.prompt" }, info);
  const saved = await writeWorkflowLibraryImport(root, { filename: path.basename(apiFile), source, graph: built.graph, config: built.config, requirements: built.requirements });
  const snapshot = await readWorkflowLibrary(root); expect(snapshot.issues).toEqual([]);
  const workflow = snapshot.workflows[0];
  expect(workflow.output).toMatchObject({ nodeId: "470", field: "images", kind: "image" }); expect(workflow.additionalOutputs ?? []).toEqual([]);
  expect(workflow.inputSlots).toHaveLength(6);
  const inputs: ResolvedInput[] = workflow.inputSlots!.map((slot, index) => ({ semantic: slot.semantic, edgeId: "edge-" + index, asset: { id: "reference-" + index, name: "reference-" + index + ".png", kind: "image", mime: "image/png", size: 1, createdAt: 1 } as Asset }));
  const uploaded = Object.fromEntries(inputs.map((input, index) => [input.asset.id, "task/reference-" + index + ".png"]));
  const node: CanvasNode = { id: "test", position: { x: 0, y: 0 }, data: { kind: "image-generation", title: "Qwen", generation: { workflowId: workflow.id, prompt: String(original["494"].inputs.prompt), negativePrompt: "", params: {}, taskId: null } } };
  const execution = buildWorkflow(workflow, node, inputs, uploaded, "task/result");
  expect(execution.workflow["416"].inputs).toMatchObject({ seed: 985625657145008, steps: 40, cfg: 1 });
  for (const repair of repaired.repairs) {
    if (!execution.workflow[repair.nodeId]) continue;
    expect(execution.workflow[repair.nodeId].inputs[repair.field]).toEqual(repair.value);
  }
  const mediaFields = new Set(workflow.mapping.filter(mapping => mapping.semantic.startsWith("slot:")).map(mapping => mapping.nodeId + "." + mapping.field));
  for (const [id, node] of Object.entries(original)) {
    if (!execution.workflow[id]) continue;
    for (const [field, value] of Object.entries(node.inputs)) {
      if (mediaFields.has(id + "." + field) || field === "filename_prefix") continue;
      expect(execution.workflow[id].inputs[field]).toEqual(value);
    }
  }
  expect(execution.workflow["470"].inputs.filename_prefix).toBe("task/result");
  expect(workflow.mapping.filter(mapping => mapping.semantic.startsWith("slot:")).map(mapping => mapping.nodeId).sort()).toEqual(["420", "432", "433", "434", "435", "436"]);
  expect(JSON.parse(await readFile(path.join(saved.path, "source.json"), "utf8"))).toEqual(source);
  expect(await readFile(apiFile)).toEqual(apiBytes); expect(await readFile(editorFile)).toEqual(editorBytes);
});
