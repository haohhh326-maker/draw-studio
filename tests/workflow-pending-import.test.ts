import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { prepareWorkflowImport } from "../src/workflow/import-pipeline";
import { readWorkflowLibrary } from "../scripts/workflow-library-reader";
import { writeWorkflowLibraryImport, resolveWorkflowLibraryImport, readWorkflowLibraryImportSource } from "../scripts/workflow-library-writer";
import { validateDefinition } from "../src/workflow-adapter/adapter";
import { withBuiltinBindings } from "../src/workflow/catalog";
vi.mock("../src/workflow/aifisher-reader-client", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/workflow/aifisher-reader-client")>();
  const { readAIFisherWorkflow } = await import("../scripts/aifisher-workflow-reader");
  return { ...actual, readAifisherWorkflow: readAIFisherWorkflow };
});

const info = {
  OwnMaker: { input: { required: { width: ["INT"], model_name: [["own.safetensors"]] } }, output: ["IMAGE"] },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
};
const source = () => ({ version: 0.4, nodes: [
  { id: 1, type: "OwnMaker", pos: [0, 0], widgets_values: { width: 512, model_name: "own.safetensors" }, inputs: [], outputs: [{ type: "IMAGE", links: [1] }] },
  { id: 2, type: "SaveImage", pos: [400, 0], widgets_values: { filename_prefix: "original-prefix" }, inputs: [{ name: "images", type: "IMAGE", link: 1 }], outputs: [] },
], links: [[1, 1, 0, 2, 0, "IMAGE"]] });
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(path.join(os.tmpdir(), "canvas-pending-")); temps.push(value); return value; }
const bytes = async (folder: string) => Object.fromEntries(await Promise.all((await readdir(folder)).map(async name => [name, await readFile(path.join(folder, name), "utf8")])));

describe("pending workflow registration and later resolution", () => {
  it("reads only the verified source and saved presentation for automatic re-import without modifying package bytes", async () => {
    const dir = await root(), original = source();
    const prepared = await prepareWorkflowImport(original, "author-editor.json");
    prepared.config.nameLabel = "Retain my title"; prepared.config.primaryCategoryLabel = "Retain my family";
    const saved = await writeWorkflowLibraryImport(dir, prepared), before = await bytes(saved.path);
    const result = await readWorkflowLibraryImportSource(dir, saved.workflowId);
    expect(result).toMatchObject({ source: original, filename: "author-editor.json", config: { id: saved.workflowId, nameLabel: "Retain my title", primaryCategoryLabel: "Retain my family" } });
    expect(await bytes(saved.path)).toEqual(before);
    result.config.nameLabel = "Mutated only in memory";
    expect((await readWorkflowLibraryImportSource(dir, saved.workflowId)).config.nameLabel).toBe("Retain my title");
    await expect(readWorkflowLibraryImportSource(dir, "../../outside")).rejects.toThrow("ID");
    await expect(readWorkflowLibraryImportSource(dir, "custom.aaaaaaaaaaaaaaaa")).rejects.toMatchObject({ status: 404 });
    await writeFile(path.join(saved.path, "source.json"), JSON.stringify({ ...original, author: "changed externally" }));
    await expect(readWorkflowLibraryImportSource(dir, saved.workflowId)).rejects.toMatchObject({ status: 409 });
  });

  it("does not follow a substituted source file link outside the managed package", async () => {
    const dir = await root(), outside = await root();
    await writeFile(path.join(outside, "private.json"), "preserve outside data");
    const saved = await writeWorkflowLibraryImport(dir, await prepareWorkflowImport(source(), "author.json"));
    await rm(path.join(saved.path, "source.json"));
    await symlink(outside, path.join(saved.path, "source.json"), process.platform === "win32" ? "junction" : "dir");
    await expect(readWorkflowLibraryImportSource(dir, saved.workflowId)).rejects.toMatchObject({ status: 403 });
    expect(await readFile(path.join(outside, "private.json"), "utf8")).toBe("preserve outside data");
  });

  it("keeps unfamiliar API plugins executable offline without guessing their named inputs", async () => {
    const original = {
      own: { class_type: "MyUnfamiliarPlugin", inputs: { opaque: { __value__: { list: ["preserve", "everything"] } }, model_name: "author.gguf" }, _meta: { title: "作者节点" } },
      save: { class_type: "SaveImage", inputs: { images: ["own", 0], filename_prefix: "author-prefix" } },
    };
    const prepared = await prepareWorkflowImport(original, "my-api.json");
    expect(prepared.importState.status).toBe("ready");
    expect(prepared.graph?.own).toEqual(original.own);
    expect(prepared.warnings.some(message => message.includes("尚未确认"))).toBe(true);
    const dir = await root(), saved = await writeWorkflowLibraryImport(dir, prepared);
    const workflow = (await readWorkflowLibrary(dir)).workflows[0];
    expect(workflow.template?.own).toEqual(original.own);
    expect(JSON.parse(await readFile(path.join(saved.path, "source.json"), "utf8"))).toEqual(original);
  });

  it("persists missing registrations as historical import diagnostics without changing a parsed API contract", async () => {
    const original = {
      own: { class_type: "MyPrivateImagePlugin", inputs: { prompt: "author intent", model_name: "author.gguf" } },
      save: { class_type: "SaveImage", inputs: { images: ["own", 0], filename_prefix: "author-prefix" } },
    };
    const prepared = await prepareWorkflowImport(original, "private-api.json", { SaveImage: info.SaveImage });
    expect(prepared.importState.status).toBe("ready");
    expect(prepared.graph?.own).toEqual(original.own);
    expect(prepared.importState.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "MISSING_NODE_TYPE", nodeId: "own", classType: "MyPrivateImagePlugin", message: expect.stringContaining("MyPrivateImagePlugin") })]));
    const dir = await root(), saved = await writeWorkflowLibraryImport(dir, prepared);
    expect(saved).toMatchObject({ status: "ready", diagnostics: prepared.importState.diagnostics });
    const workflow = (await readWorkflowLibrary(dir)).workflows[0];
    expect(workflow.library?.importStatus).toBe("ready");
    expect(workflow.library?.diagnostics).toEqual(prepared.importState.diagnostics.map(({ code, message, nodeId, classType, field }) => ({
      code, message, ...(nodeId ? { nodeId } : {}), ...(classType ? { classType } : {}), ...(field ? { field } : {}),
    })));
    expect(workflow.library?.executionIssue).toBeUndefined();
    expect(workflow.template?.own).toEqual(original.own);
    expect(() => validateDefinition(workflow)).not.toThrow();
    const config = JSON.parse(await readFile(path.join(saved.path, "workflow.config.json"), "utf8"));
    expect(config.importState.diagnostics).toEqual(prepared.importState.diagnostics);
    expect(await resolveWorkflowLibraryImport(dir, { workflowId: saved.workflowId })).toMatchObject({ status: "ready", reused: true, diagnostics: prepared.importState.diagnostics });
    const offline = await prepareWorkflowImport(original, "private-api.json", {});
    expect(offline.importState.diagnostics).toEqual([]);
    const offlineDir = await root(), offlineSaved = await writeWorkflowLibraryImport(offlineDir, offline);
    expect(offlineSaved).not.toHaveProperty("diagnostics");
  });

  it("retains incomplete API input contracts with upstream warnings and never injects a later schema default", async () => {
    const original = {
      own: { class_type: "OwnGenerator", inputs: { model_name: "my-model.gguf", prompt: "keep my intent" }, _meta: { title: "Keep all metadata" } },
      save: { class_type: "SaveImage", inputs: { images: ["own", 0], filename_prefix: "keep/prefix" } },
    };
    const schema = { OwnGenerator: { input: { required: { model_name: ["STRING"], prompt: ["STRING"], count: ["INT"] } }, output: ["IMAGE"] }, SaveImage: info.SaveImage };
    const prepared = await prepareWorkflowImport(original, "missing-api-input.json", schema);
    expect(prepared.importState).toMatchObject({ status: "ready", format: "api" });
    expect(prepared.warnings).toContain("MISSING_REQUIRED_INPUT · own · count");
    expect(prepared.graph).toEqual(original);
    expect(prepared.graph?.own.inputs).not.toHaveProperty("count");
    const dir = await root(), saved = await writeWorkflowLibraryImport(dir, prepared);
    expect((await readWorkflowLibrary(dir)).workflows[0].template).toEqual(original);
    expect(JSON.parse(await readFile(path.join(saved.path, "source.json"), "utf8"))).toEqual(original);
    expect(JSON.parse(await readFile(path.join(saved.path, "execution.api.json"), "utf8"))).toEqual(original);
    // Only fields recognized by AIFISHER's MODEL_FIELDS establish model requirements.
    expect(prepared.requirements.items).toEqual([]);
    const stillPending = await resolveWorkflowLibraryImport(dir, { workflowId: saved.workflowId, objectInfo: schema });
    expect(stillPending).toMatchObject({ status: "ready", reused: true, updated: false });
    const reliable = structuredClone(schema); reliable.OwnGenerator.input.required.count = ["INT", { default: 2 }];
    const resolved = await resolveWorkflowLibraryImport(dir, { workflowId: saved.workflowId, objectInfo: reliable });
    expect(resolved).toMatchObject({ status: "ready", workflowId: saved.workflowId, path: saved.path });
    const graph = (await readWorkflowLibrary(dir)).workflows[0].template!;
    expect(graph.own).toEqual(original.own);
    expect(graph.own.inputs).not.toHaveProperty("count");
    expect(graph.save).toEqual(original.save);
    expect(JSON.parse(await readFile(path.join(saved.path, "source.json"), "utf8"))).toEqual(original);
  });

  it("preserves API output contract failures but still rejects malformed API records", async () => {
    const original = { only: { class_type: "PrivateTool", inputs: { prompt: "author text" } } };
    const prepared = await prepareWorkflowImport(original, "no-output.json", { PrivateTool: { input: { required: { prompt: ["STRING"] } }, output: ["STRING"], output_node: false } });
    expect(prepared.importState).toMatchObject({ status: "pending", format: "api" });
    expect(prepared.importState.diagnostics.some(item => item.message.includes("输出"))).toBe(true);
    const dir = await root(), saved = await writeWorkflowLibraryImport(dir, prepared);
    expect(JSON.parse(await readFile(path.join(saved.path, "source.json"), "utf8"))).toEqual(original);
    await expect(prepareWorkflowImport({ only: { class_type: "PrivateTool", inputs: [] } }, "invalid-api.json")).rejects.toThrow();
    await expect(prepareWorkflowImport({ only: { class_type: "", inputs: {} } }, "invalid-api.json")).rejects.toThrow();
    const resolved = await resolveWorkflowLibraryImport(dir, { workflowId: saved.workflowId, objectInfo: { PrivateTool: { input: { required: { prompt: ["STRING"] } }, output: ["STRING"], output_node: true } } });
    expect(resolved.status).toBe("ready");
  });

  it("retains unused formal definitions as source metadata without expanding or interpreting them", async () => {
    const original = { ...source(), definitions: { subgraphs: [
      { id: "unused-empty", nodes: [], links: [], inputs: [], outputs: [] },
      { id: "unused-passthrough", nodes: [], inputNode: { id: -10 }, outputNode: { id: -20 },
        inputs: [{ name: "image", type: "IMAGE" }], outputs: [{ name: "image", type: "IMAGE" }], links: [[4, -10, 0, -20, 0, "IMAGE"]] },
    ] } };
    const prepared = await prepareWorkflowImport(original, "own.json", info);
    expect(prepared.importState.status).toBe("ready");
    expect(prepared.graph?.["2"].inputs.images).toEqual(["1", 0]);
    const pending = await prepareWorkflowImport(original, "own.json");
    expect(pending.importState.status).toBe("pending");
    const broken = structuredClone(original); broken.definitions.subgraphs[1].links[0][1] = -999;
    const retained = await prepareWorkflowImport(broken, "own.json", info);
    expect(retained.importState.status).toBe("ready");
    expect(retained.graph).toEqual(prepared.graph);
    expect(retained.source).toEqual(broken);
  });

  it("saves one ordinary source with missing schema in a five-file pending package, visible without an executable template", async () => {
    const original = source(), before = structuredClone(original), prepared = await prepareWorkflowImport(original, "own.json", { SaveImage: info.SaveImage });
    expect(prepared.importState.status).toBe("pending");
    expect(prepared.graph).toBeUndefined();
    expect(prepared.importState.diagnostics.some(item => item.classType === "OwnMaker" && item.nodeId === "1")).toBe(true);
    const dir = await root(), saved = await writeWorkflowLibraryImport(dir, { ...prepared, reuseExisting: true });
    expect(saved.status).toBe("pending");
    expect((await readdir(saved.path)).sort()).toEqual(["execution.api.json", "import.meta.json", "model.requirements.json", "source.json", "workflow.config.json"]);
    const marker = JSON.parse(await readFile(path.join(saved.path, "execution.api.json"), "utf8"));
    expect(marker).toMatchObject({ canvasImportState: "pending", workflowId: saved.workflowId });
    expect(marker["1"]).toBeUndefined();
    const snapshot = await readWorkflowLibrary(dir), workflow = snapshot.workflows[0];
    expect(snapshot.workflows).toHaveLength(1);
    expect(workflow.library?.importStatus).toBe("pending");
    expect(workflow.directory?.canvas).toBe("image");
    expect(workflow.template).toBeUndefined();
    expect(() => validateDefinition(workflow)).toThrow("OwnMaker");
    expect(withBuiltinBindings([], snapshot.workflows, snapshot.sourcePath)).toHaveLength(1);
    expect(workflow.library?.diagnostics?.some(item => item.message.includes("OwnMaker"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(saved.path, "source.json"), "utf8"))).toEqual(original);
    expect(original).toEqual(before);
  });

  it("reuses an identical pending source without rewriting its files or adding a second folder", async () => {
    const dir = await root(), prepared = await prepareWorkflowImport(source(), "first.json");
    const first = await writeWorkflowLibraryImport(dir, { ...prepared, reuseExisting: true }), before = await bytes(first.path);
    const second = await writeWorkflowLibraryImport(dir, { ...prepared, filename: "renamed.json", reuseExisting: true });
    expect(second).toMatchObject({ workflowId: first.workflowId, path: first.path, status: "pending", reused: true });
    expect(await bytes(first.path)).toEqual(before);
    expect(await readdir(dir)).toEqual([first.folder]);
  });

  it("upgrades the saved source using real schema under its same identity, preserving source, title and import time", async () => {
    const dir = await root(), original = source(), prepared = await prepareWorkflowImport(original, "my-source.json");
    const first = await writeWorkflowLibraryImport(dir, { ...prepared, reuseExisting: true });
    const sourceBefore = await readFile(path.join(first.path, "source.json"), "utf8"), metadataBefore = JSON.parse(await readFile(path.join(first.path, "import.meta.json"), "utf8"));
    const configPath = path.join(first.path, "workflow.config.json"), config = JSON.parse(await readFile(configPath, "utf8"));
    config.nameLabel = "My retained title"; config.primaryCategoryLabel = "My retained category"; await writeFile(configPath, JSON.stringify(config));
    const result = await resolveWorkflowLibraryImport(dir, { workflowId: first.workflowId, objectInfo: info });
    expect(result).toMatchObject({ workflowId: first.workflowId, path: first.path, status: "ready", updated: true });
    const workflow = (await readWorkflowLibrary(dir)).workflows[0];
    expect(workflow.template?.["1"].inputs).toEqual({ width: 512, model_name: "own.safetensors" });
    expect(workflow.template?.["2"].inputs.filename_prefix).toBe("original-prefix");
    expect(workflow.library?.importStatus).toBe("ready");
    expect(workflow.name).toBe("My retained title");
    expect(workflow.family).toBe("My retained category");
    expect(await readFile(path.join(first.path, "source.json"), "utf8")).toBe(sourceBefore);
    const metadata = JSON.parse(await readFile(path.join(first.path, "import.meta.json"), "utf8"));
    expect(metadata.importedAt).toBe(metadataBefore.importedAt);
    expect(metadata.sourceSha256).toBe(metadataBefore.sourceSha256);
    const readyBefore = await bytes(first.path);
    expect(await resolveWorkflowLibraryImport(dir, { workflowId: first.workflowId })).toMatchObject({ reused: true, status: "ready", updated: false });
    expect(await bytes(first.path)).toEqual(readyBefore);
  });

  it("automatically upgrades a repeated pending upload after schema arrives, and a stale pending retry cannot downgrade it", async () => {
    const dir = await root(), original = source(), pending = await prepareWorkflowImport(original, "own.json");
    const first = await writeWorkflowLibraryImport(dir, { ...pending, reuseExisting: true });
    const ready = await prepareWorkflowImport(original, "renamed.json", info);
    const result = await writeWorkflowLibraryImport(dir, { ...ready, reuseExisting: true });
    expect(result).toMatchObject({ updated: true, status: "ready", path: first.path });
    const before = await bytes(first.path);
    expect(await writeWorkflowLibraryImport(dir, { ...pending, overwrite: true })).toMatchObject({ reused: true, status: "ready" });
    expect(await bytes(first.path)).toEqual(before);
  });

  it("does not automatically upgrade an existing package with a corrupted execution marker", async () => {
    const dir = await root(), original = source(), pending = await prepareWorkflowImport(original, "own.json");
    const first = await writeWorkflowLibraryImport(dir, { ...pending, reuseExisting: true });
    await writeFile(path.join(first.path, "execution.api.json"), JSON.stringify({ canvasImportState: "pending", workflowId: "another-id" }));
    const before = await bytes(first.path), ready = await prepareWorkflowImport(original, "own.json", info);
    await expect(writeWorkflowLibraryImport(dir, { ...ready, reuseExisting: true })).rejects.toThrow("执行记录");
    expect(await bytes(first.path)).toEqual(before);
  });

  it("rechecks unresolved entries without creating a fake executable graph and reports remaining gaps", async () => {
    const dir = await root(), prepared = await prepareWorkflowImport(source(), "own.json");
    const first = await writeWorkflowLibraryImport(dir, { ...prepared, reuseExisting: true });
    const result = await resolveWorkflowLibraryImport(dir, { workflowId: first.workflowId, objectInfo: { SaveImage: info.SaveImage } });
    expect(result.status).toBe("pending");
    expect(result.diagnostics?.some(item => item.message.includes("OwnMaker"))).toBe(true);
    expect((await readWorkflowLibrary(dir)).workflows[0].template).toBeUndefined();
    expect(await readdir(dir)).toEqual([first.folder]);
  });

  it("serializes simultaneous resolvers and cannot replace the first ready graph with another schema", async () => {
    const dir = await root(), prepared = await prepareWorkflowImport(source(), "own.json");
    const first = await writeWorkflowLibraryImport(dir, { ...prepared, reuseExisting: true });
    const alternative = { ...info, OwnMaker: { display_name: "Alternative schema title", input: { required: { width: ["INT"], model_name: [["own.safetensors"]] } }, output: ["IMAGE"] } };
    const results = await Promise.all([
      resolveWorkflowLibraryImport(dir, { workflowId: first.workflowId, objectInfo: info }),
      resolveWorkflowLibraryImport(dir, { workflowId: first.workflowId, objectInfo: alternative }),
    ]);
    // realpath may finish in either order, but exactly one resolver may upgrade.
    expect(results.filter(result => result.status === "ready" && result.updated)).toHaveLength(1);
    expect(results.filter(result => result.status === "ready" && !result.updated && result.reused)).toHaveLength(1);
    const compiled = (await readWorkflowLibrary(dir)).workflows[0].template!;
    expect(compiled["1"].inputs).toEqual({ width: 512, model_name: "own.safetensors" });
    expect(compiled["1"]._meta?.title).toBe(results[0].updated ? "OwnMaker" : "Alternative schema title");
  });

  it("rejects malformed workflow structures, hash mismatches, fabricated graphs and escaped resolution IDs", async () => {
    await expect(prepareWorkflowImport({ nodes: [], links: [] }, "empty.json")).rejects.toThrow();
    const dangling = source(); dangling.links[0][1] = 999;
    await expect(prepareWorkflowImport(dangling, "broken.json")).rejects.toThrow("不存在");
    await expect(prepareWorkflowImport({ arbitrary: "JSON" }, "not-workflow.json")).rejects.toThrow();
    const dir = await root(), prepared = await prepareWorkflowImport(source(), "own.json");
    await expect(writeWorkflowLibraryImport(dir, { ...prepared, config: { ...prepared.config, id: "custom.0000000000000000" } })).rejects.toThrow("哈希");
    await expect(writeWorkflowLibraryImport(dir, { ...prepared, graph: { "1": { class_type: "Fake", inputs: {} } } })).rejects.toThrow("伪造");
    await expect(resolveWorkflowLibraryImport(dir, { workflowId: "../../outside" })).rejects.toThrow("ID");
    expect(await readdir(dir)).toEqual([]);
  });
});

const realSourcePath = "E:/123/001-MiniMaxH3-文生视频.json";
const cachedInfoPath = ".cache/cloud-final-object-info.json";
it.skipIf(![realSourcePath, cachedInfoPath].every(existsSync))("registers the real TESpeed workflow as pending and names node 134 once without changing its original file", async () => {
  const originalBytes = await readFile(realSourcePath), original = JSON.parse(originalBytes.toString("utf8"));
  const objectInfo = JSON.parse(await readFile(cachedInfoPath, "utf8"));
  const prepared = await prepareWorkflowImport(original, path.basename(realSourcePath), objectInfo);
  expect(prepared.importState.status).toBe("pending");
  expect(prepared.importState.diagnostics.filter(item => item.classType === "TESpeedMiniMaxH3")).toHaveLength(1);
  expect(prepared.importState.diagnostics[0]).toMatchObject({ nodeId: "134", classType: "TESpeedMiniMaxH3" });
  const dir = await root(), saved = await writeWorkflowLibraryImport(dir, { ...prepared, reuseExisting: true });
  const snapshot = await readWorkflowLibrary(dir), workflow = snapshot.workflows[0];
  expect(workflow.library?.diagnostics).toEqual(prepared.importState.diagnostics);
  expect(workflow.output.kind).toBe("video");
  expect(workflow.template).toBeUndefined();
  expect(workflow.original?.models.some(model => model.name.endsWith("minimax_h3_fl2va_pruned_int8_convrot.safetensors"))).toBe(true);
  expect(await resolveWorkflowLibraryImport(dir, { workflowId: saved.workflowId, objectInfo })).toMatchObject({ status: "pending", workflowId: saved.workflowId });
  expect(await readFile(realSourcePath)).toEqual(originalBytes);
});
