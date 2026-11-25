import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findManagedWorkflowImportFolder, migrateManagedWorkflowImportFolders, readWorkflowLibraryImportSource, resolveWorkflowLibraryImport, validateManagedWorkflowImport, writeWorkflowLibraryImport, type WorkflowImportRequest } from "../scripts/workflow-library-writer";
import { readWorkflowLibrary } from "../scripts/workflow-library-reader";
import { deleteWorkflowLibraryFolder } from "../scripts/workflow-library-delete";
import { workflowLibraryPlugin } from "../scripts/workflow-library-plugin";
import { buildWorkflowImport } from "../src/workflow/import-analyzer";
import { convertEditorWorkflow } from "../src/workflow/import-editor";
import { prepareWorkflowImport as prepareWorkflowImportWithReader } from "../src/workflow/import-pipeline";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";
import { workflowModelFolderStem } from "../src/workflow/import-folder-name";

const failures = vi.hoisted(() => ({
  commit: false, migration: false, migrationMoves: 0,
  pauseAfterBackup: undefined as (() => Promise<void>) | undefined,
}));
// Exercise the actual pinned server reader without a browser fetch or network.
const prepareWorkflowImport = (source: unknown, filename: string, info?: Record<string, unknown>) =>
  prepareWorkflowImportWithReader(source, filename, info, async request => await readAIFisherWorkflow(request) as AifisherWorkflowReadResult);
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (source: string, target: string) => {
    if (failures.commit && path.basename(source).startsWith(".canvas-import-") && !path.basename(source).startsWith(".canvas-import-backup-") && !path.basename(target).startsWith(".canvas-import-")) throw Object.assign(new Error("simulated commit failure"), { code: "EIO" });
    if (failures.migration && path.basename(source).startsWith("Custom-") && !path.basename(target).startsWith("Custom-") && ++failures.migrationMoves === 2) throw Object.assign(new Error("simulated migration failure"), { code: "EIO" });
    await actual.rename(source, target);
    if (path.basename(target).startsWith(".canvas-import-backup-")) await failures.pauseAfterBackup?.();
  } };
});

const temporary: string[] = [];
afterEach(async () => { failures.commit = false; failures.migration = false; failures.migrationMoves = 0; failures.pauseAfterBackup = undefined; await Promise.all(temporary.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-import-test-"));
  temporary.push(root); return root;
}
const WORKFLOW_ID = "custom.0123456789abcdef";
const graph = () => ({
  "1": { class_type: "LoadImage", inputs: { image: "local-example.png" } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "example" } },
});
function importRequest(): WorkflowImportRequest {
  const api = graph();
  return {
    filename: "我的工作流_api.json", source: api, graph: api,
    config: { id: WORKFLOW_ID, version: "1.0.0", nameLabel: "我的工作流", primaryCategoryLabel: "自定义工作流", nodeKind: "image", runnerType: "comfyui",
      inputs: [{ id: "reference", name: "参考图", dataType: "image", required: true, binding: { target: "comfyui", nodeId: "1", path: "inputs.image" } }],
      parameters: [], execution: { file: "../../outside.json", modelRequirementsFile: "../../models.json" } },
    requirements: { items: [] },
  };
}
async function packageBytes(folder: string) {
  return Object.fromEntries(await Promise.all((await readdir(folder)).map(async name => [name, await readFile(path.join(folder, name))])));
}
const contentId = (source: unknown) => "custom." + createHash("sha256").update(JSON.stringify(source)).digest("hex");
const modelGraph = (model = "models/qwen_image_2.1_bf16.safetensors", prompt = "Krea2 is only prompt text") => ({
  model: { class_type: "UNETLoader", inputs: { unet_name: model } },
  encoder: { class_type: "CLIPLoader", inputs: { clip_name: "encoder_ignored.safetensors" } },
  encode: { class_type: "CLIPTextEncode", inputs: { clip: ["encoder", 0], text: prompt } },
  lora: { class_type: "LoraLoader", inputs: { model: ["model", 0], clip: ["encoder", 0], lora_name: "lora_ignored.safetensors" } },
  latent: { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
  sampler: { class_type: "KSampler", inputs: { model: ["lora", 0], positive: ["encode", 0], negative: ["encode", 0], latent_image: ["latent", 0] } },
  vae: { class_type: "VAELoader", inputs: { vae_name: "vae_ignored.safetensors" } },
  decode: { class_type: "VAEDecode", inputs: { samples: ["sampler", 0], vae: ["vae", 0] } },
  save: { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: "misleading-title" } },
  unused: { class_type: "UNETLoader", inputs: { unet_name: "unused_model.safetensors" } },
});

describe("readable model import directories", () => {
  it("names API packages after the actual main model while preserving all source and bindings", async () => {
    const root = await fixtureRoot(), source = modelGraph(), prepared = await prepareWorkflowImport(source, "misleading-Krea2.json");
    const saved = await writeWorkflowLibraryImport(root, prepared);
    expect(saved.folder).toBe("qwen_image_2.1_bf16");
    expect(saved.workflowId).toBe(contentId(source));
    expect(JSON.parse(await readFile(path.join(saved.path, "source.json"), "utf8"))).toEqual(source);
    expect(JSON.parse(await readFile(path.join(saved.path, "execution.api.json"), "utf8"))).toEqual(prepared.graph);
    expect((await readWorkflowLibrary(root)).issues).toEqual([]);
    expect(await findManagedWorkflowImportFolder(root, saved.workflowId)).toBe(saved.path);
  });

  it("keeps the plain model name for the first workflow and appends a stable short ID for different content", async () => {
    const root = await fixtureRoot();
    const first = await writeWorkflowLibraryImport(root, await prepareWorkflowImport(modelGraph(), "first.json"));
    const secondPrepared = await prepareWorkflowImport(modelGraph(undefined, "A different prompt"), "second.json");
    const second = await writeWorkflowLibraryImport(root, secondPrepared);
    expect(first.folder).toBe("qwen_image_2.1_bf16");
    expect(second.folder).toBe("qwen_image_2.1_bf16-" + second.workflowId.slice(7, 15));
    const before = await packageBytes(second.path);
    expect(await writeWorkflowLibraryImport(root, { ...secondPrepared, filename: "third.json", reuseExisting: true })).toMatchObject({ path: second.path, reused: true });
    expect(await packageBytes(second.path)).toEqual(before);
  });

  it("uses only an explicitly selected output branch and sanitizes paths/reserved Windows names", () => {
    const source = { ...modelGraph(), other: { class_type: "OwnImageGenerator", inputs: { model_name: "other_model.safetensors" } },
      otherSave: { class_type: "SaveImage", inputs: { images: ["other", 0] } } };
    expect(workflowModelFolderStem(source, { outputNodeIds: ["save"] })).toBe("qwen_image_2.1_bf16");
    expect(workflowModelFolderStem(modelGraph("C:\\weights\\CON.safetensors"))).toBe("工作流-CON");
    expect(workflowModelFolderStem(modelGraph("folder/author:custom?.gguf"))).toBe("author-custom");
    expect(workflowModelFolderStem(graph(), { name: "图像批处理" })).toBe("图像批处理");
  });

  it("keeps an unsupported-version editor pending and resolves its managed identity after rename", async () => {
    const root = await fixtureRoot(), source = { nodes: [
      { id: 1, type: "UNETLoader", widgets_values: ["folder/custom_image_v2.gguf", "default"] },
      { id: 2, type: "OwnSampler", widgets_values: [42], inputs: [{ name: "model", type: "MODEL", link: 1 }], outputs: [{ type: "IMAGE" }] },
      { id: 3, type: "SaveImage", widgets_values: ["prefix"], inputs: [{ name: "images", type: "IMAGE", link: 2 }] },
      { id: 4, type: "UNETLoader", mode: 2, widgets_values: ["disabled.safetensors"] },
    ], links: [[1, 1, 0, 2, 0, "MODEL"], [2, 2, 0, 3, 0, "IMAGE"]] };
    const saved = await writeWorkflowLibraryImport(root, await prepareWorkflowImport(source, "Krea2.json"));
    expect(saved).toMatchObject({ folder: "custom_image_v2", status: "pending" });
    const renamed = path.join(root, "My retained folder"); await rename(saved.path, renamed);
    const info = {
      UNETLoader: { input: { required: { unet_name: [["folder/custom_image_v2.gguf"]], weight_dtype: [["default"]] } }, output: ["MODEL"] },
      OwnSampler: { input: { required: { model: ["MODEL"], seed: ["INT"] } }, output: ["IMAGE"] },
      SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
    };
    const result = await resolveWorkflowLibraryImport(root, { workflowId: saved.workflowId, objectInfo: info });
    expect(result).toMatchObject({ path: renamed, workflowId: saved.workflowId, status: "pending", updated: true });
    expect(JSON.parse(await readFile(path.join(renamed, "workflow.config.json"), "utf8")).importReader)
      .toMatchObject({ revision: "bdcf3bec054594fcab591952a8c5acef858d6de4", compileStatus: "unsupported-version" });
    expect(JSON.parse(await readFile(path.join(renamed, "source.json"), "utf8"))).toEqual(source);
  });

  it("preserves a pending publisher locator, then validates and applies it when the schema becomes available", async () => {
    const root = await fixtureRoot();
    const source = { version: 0.4, nodes: [
      { id: 49, type: "OwnImageGenerator", pos: [0, 0], widgets_values: { prompt: "scene description" }, inputs: [], outputs: [{ type: "IMAGE", links: [1] }] },
      { id: 79, type: "SaveImage", pos: [400, 0], widgets_values: { filename_prefix: "prefix" }, inputs: [{ name: "images", type: "IMAGE", link: 1 }], outputs: [] },
    ], links: [[1, 49, 0, 79, 0, "IMAGE"]] };
    const locator = { nodeId: "49", field: "prompt" };
    const initial = await prepareWorkflowImport(source, "pending-publisher.json");
    expect(initial.importState.status).toBe("pending");
    initial.config.importPublishedPrompt = { ...locator, sample: "discard publisher text" };
    const saved = await writeWorkflowLibraryImport(root, initial);
    const pending = await readWorkflowLibraryImportSource(root, saved.workflowId);
    expect(pending.config.importPublishedPrompt).toEqual(locator);
    const info = {
      OwnImageGenerator: { input: { required: { prompt: ["STRING"] } }, output: ["IMAGE"] },
      SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
    };
    const upgrade = await prepareWorkflowImport(source, "upload-without-locator.json", info);
    expect(upgrade.importState.status, JSON.stringify(upgrade.importState.diagnostics)).toBe("ready");
    expect(await writeWorkflowLibraryImport(root, { ...upgrade, reuseExisting: true })).toMatchObject({ path: saved.path, status: "pending", reused: true });
    expect(await resolveWorkflowLibraryImport(root, { workflowId: saved.workflowId, objectInfo: info }))
      .toMatchObject({ workflowId: saved.workflowId, path: saved.path, status: "ready", updated: true });
    const actual = await readWorkflowLibraryImportSource(root, saved.workflowId);
    expect(actual.config).toMatchObject({ importPublishedPrompt: locator, prompt: { binding: { nodeId: "49", path: "inputs.prompt" } } });
    expect(actual.source).toEqual(source);
    expect(await readdir(root)).toEqual([saved.folder]);
  });

  it("previews and migrates a verified legacy directory without changing any bytes or timestamps", async () => {
    const root = await fixtureRoot(), prepared = await prepareWorkflowImport(modelGraph(), "source.json");
    const saved = await writeWorkflowLibraryImport(root, prepared), before = await packageBytes(saved.path);
    const legacy = path.join(root, "Custom-" + saved.workflowId.slice(7)); await rename(saved.path, legacy);
    expect(await migrateManagedWorkflowImportFolders(root)).toEqual([{ workflowId: saved.workflowId, from: legacy, to: saved.path, changed: false }]);
    expect(await packageBytes(legacy)).toEqual(before);
    const migrated = await migrateManagedWorkflowImportFolders(root, { dryRun: false });
    expect(migrated[0]).toMatchObject({ workflowId: saved.workflowId, to: saved.path, changed: true });
    expect(await packageBytes(saved.path)).toEqual(before);
    expect(await validateManagedWorkflowImport(root, saved.path)).toEqual({ workflowId: saved.workflowId, sourceSha256: saved.workflowId.slice(7) });
    expect(await writeWorkflowLibraryImport(root, { ...prepared, reuseExisting: true })).toMatchObject({ path: saved.path, reused: true });
    expect(await migrateManagedWorkflowImportFolders(root, { dryRun: false })).toEqual([]);
  });

  it("rejects ambiguous IDs, deep directories, added files and linked packages during management", async () => {
    const root = await fixtureRoot(), saved = await writeWorkflowLibraryImport(root, importRequest());
    const original = path.join(root, "Original"); await mkdir(original);
    await writeFile(path.join(original, "workflow.config.json"), JSON.stringify({ id: WORKFLOW_ID }));
    await expect(findManagedWorkflowImportFolder(root, WORKFLOW_ID)).rejects.toMatchObject({ status: 409 });
    await expect(validateManagedWorkflowImport(root, path.join(saved.path, "nested"))).rejects.toMatchObject({ status: 403 });
    await rm(original, { recursive: true });
    const legacy = path.join(root, "Custom-" + WORKFLOW_ID.slice(7)); await rename(saved.path, legacy);
    await writeFile(path.join(legacy, "preserve.txt"), "user data");
    await expect(migrateManagedWorkflowImportFolders(root, { dryRun: false })).rejects.toMatchObject({ status: 409 });
    expect(await readFile(path.join(legacy, "preserve.txt"), "utf8")).toBe("user data");
    await rm(path.join(legacy, "preserve.txt"));
    const outside = await fixtureRoot(), linked = path.join(root, "Custom-ffffffffffffffff");
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(migrateManagedWorkflowImportFolders(root, { dryRun: false })).rejects.toMatchObject({ status: 403 });
    expect(await readdir(root)).toContain(path.basename(legacy));
  });

  it("rolls back earlier renames if a later legacy migration fails", async () => {
    const root = await fixtureRoot(), imports = [];
    for (const model of ["first_model.safetensors", "second_model.safetensors"]) {
      const saved = await writeWorkflowLibraryImport(root, await prepareWorkflowImport(modelGraph(model), "source.json"));
      const legacy = path.join(root, "Custom-" + saved.workflowId.slice(7)), before = await packageBytes(saved.path);
      await rename(saved.path, legacy); imports.push({ legacy, before });
    }
    failures.migration = true;
    await expect(migrateManagedWorkflowImportFolders(root, { dryRun: false })).rejects.toThrow("simulated migration failure");
    expect((await readdir(root)).sort()).toEqual(imports.map(item => path.basename(item.legacy)).sort());
    for (const item of imports) expect(await packageBytes(item.legacy)).toEqual(item.before);
  });
});

describe("workflow import packages", () => {
  it("writes a complete reader-compatible package with fixed paths and preserves original neighboring files", async () => {
    const root = await fixtureRoot();
    const original = path.join(root, "Original-Qwen"); await mkdir(original);
    await writeFile(path.join(original, "workflow.config.json"), JSON.stringify({ id: "qwen.original" }));
    const before = await readFile(path.join(original, "workflow.config.json"));
    const request = importRequest(); request.graph = { prompt: graph() };
    const result = await writeWorkflowLibraryImport(root, request);
    expect(result).toEqual({ folder: "我的工作流", path: path.join(root, "我的工作流"), workflowId: WORKFLOW_ID, updated: false });
    expect((await readdir(result.path)).sort()).toEqual(["execution.api.json", "import.meta.json", "model.requirements.json", "source.json", "workflow.config.json"]);
    const savedConfig = JSON.parse(await readFile(path.join(result.path, "workflow.config.json"), "utf8"));
    expect(savedConfig.execution).toEqual({ file: "execution.api.json", modelRequirementsFile: "model.requirements.json" });
    expect(JSON.parse(await readFile(path.join(result.path, "execution.api.json"), "utf8"))).toEqual(graph());
    expect(JSON.parse(await readFile(path.join(result.path, "source.json"), "utf8"))).toEqual(request.source);
    const snapshot = await readWorkflowLibrary(root);
    expect(snapshot.workflows).toHaveLength(1);
    expect(snapshot.workflows[0].library?.executionIssue).toBeUndefined();
    expect(snapshot.workflows[0].mapping).toContainEqual({ semantic: "slot:reference", nodeId: "1", field: "image" });
    expect(await readFile(path.join(original, "workflow.config.json"))).toEqual(before);
    const metadata = JSON.parse(await readFile(path.join(result.path, "import.meta.json"), "utf8"));
    expect(metadata).toMatchObject({ importer: "clearframe-canvas", workflowId: WORKFLOW_ID, originalFilename: request.filename, sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(Object.keys(metadata).sort()).toEqual(["importedAt", "importer", "originalFilename", "schemaVersion", "sourceSha256", "updatedAt", "workflowId"]);
  });
  it("rejects duplicates until overwrite is explicit, then atomically updates the existing package", async () => {
    const root = await fixtureRoot(), request = importRequest();
    const first = await writeWorkflowLibraryImport(root, request);
    const before = await readFile(path.join(first.path, "execution.api.json"));
    await expect(writeWorkflowLibraryImport(root, request)).rejects.toMatchObject({ status: 409, existing: { path: first.path, workflowId: WORKFLOW_ID } });
    expect(await readFile(path.join(first.path, "execution.api.json"))).toEqual(before);
    const next = importRequest(); next.overwrite = true; next.config.nameLabel = "已更新"; next.graph = { ...graph(), "3": { class_type: "ModelLoader", inputs: { model: "new.safetensors" } } }; next.source = next.graph;
    const updated = await writeWorkflowLibraryImport(root, next);
    expect(updated.updated).toBe(true); expect(updated.path).toBe(first.path);
    expect((await readdir(root))).toEqual([first.folder]);
    expect((await readWorkflowLibrary(root)).workflows[0].name).toBe("已更新");
  });
  it("detects the same source under another identity and prevents duplicate registration", async () => {
    const root = await fixtureRoot(); const first = await writeWorkflowLibraryImport(root, importRequest());
    const other = importRequest(); other.config.id = "custom.ffffffffffffffff";
    await expect(writeWorkflowLibraryImport(root, other)).rejects.toMatchObject({ status: 409, existing: { path: first.path, workflowId: WORKFLOW_ID } });
    expect(await readdir(root)).toEqual([first.folder]);
  });
  it("reuses an identical source without rewriting existing names, settings, graph or import metadata", async () => {
    const root = await fixtureRoot(), first = await writeWorkflowLibraryImport(root, importRequest());
    const before = await packageBytes(first.path);
    const retry = importRequest(); retry.reuseExisting = true; retry.overwrite = true;
    retry.filename = "renamed_api.json"; retry.config.nameLabel = "Do not replace the saved title";
    retry.graph = { ...graph(), other: { class_type: "UnrelatedNode", inputs: {} } };
    expect(await writeWorkflowLibraryImport(root, retry)).toEqual({ ...first, updated: false, reused: true });
    expect(await packageBytes(first.path)).toEqual(before);
    expect(await readdir(root)).toEqual([first.folder]);
    expect((await readWorkflowLibrary(root)).workflows[0].name).toBe("我的工作流");
  });
  it("reuses a verified legacy short identity instead of creating a new full-hash directory", async () => {
    const root = await fixtureRoot(), first = await writeWorkflowLibraryImport(root, importRequest());
    const before = await packageBytes(first.path), retry = importRequest();
    retry.config.id = contentId(retry.source); retry.reuseExisting = true;
    expect(await writeWorkflowLibraryImport(root, retry)).toEqual({ ...first, reused: true });
    expect(await packageBytes(first.path)).toEqual(before);
    expect(await readdir(root)).toEqual([first.folder]);
  });
  it("makes simultaneous automatic imports succeed with one shared identity and one complete directory", async () => {
    const root = await fixtureRoot();
    const results = await Promise.all([writeWorkflowLibraryImport(root, { ...importRequest(), reuseExisting: true }), writeWorkflowLibraryImport(root, { ...importRequest(), reuseExisting: true })]);
    expect(results.filter(result => result.reused === true)).toHaveLength(1);
    expect(results.filter(result => result.reused === undefined)).toHaveLength(1);
    expect(results.map(result => result.workflowId)).toEqual([WORKFLOW_ID, WORKFLOW_ID]);
    expect(results[0].path).toBe(results[1].path); expect(results.every(result => !result.updated)).toBe(true);
    expect(await readdir(root)).toEqual([results[0].folder]);
    const snapshot = await readWorkflowLibrary(root); expect(snapshot.issues).toEqual([]); expect(snapshot.workflows).toHaveLength(1);
  });
  it("adds changed content under its new identity but never overwrites a different source in automatic mode", async () => {
    const root = await fixtureRoot(), initial = importRequest(); initial.config.id = contentId(initial.source);
    const first = await writeWorkflowLibraryImport(root, { ...initial, reuseExisting: true }), before = await packageBytes(first.path);
    const changed = importRequest(), changedGraph = graph(); changedGraph["1"].inputs.image = "new-reference.png";
    changed.source = changedGraph; changed.graph = changedGraph; changed.config.id = contentId(changed.source); changed.reuseExisting = true;
    const second = await writeWorkflowLibraryImport(root, changed);
    expect(second.path).not.toBe(first.path); expect(second.reused).toBeUndefined(); expect(second.updated).toBe(false);
    expect(await packageBytes(first.path)).toEqual(before);
    const collision = structuredClone(changed); collision.config.id = first.workflowId; collision.overwrite = true;
    await expect(writeWorkflowLibraryImport(root, collision)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("自动添加不会覆盖") });
    expect(await packageBytes(first.path)).toEqual(before);
    expect((await readWorkflowLibrary(root)).workflows).toHaveLength(2);
  });
  it("ignores and preserves leftover staging and backup directories during identity checks", async () => {
    const root = await fixtureRoot(), leftovers = [".canvas-import-1111", ".canvas-import-backup-2222"];
    for (const folder of leftovers) {
      await mkdir(path.join(root, folder)); await writeFile(path.join(root, folder, "workflow.config.json"), JSON.stringify(importRequest().config));
      await writeFile(path.join(root, folder, "preserve.txt"), "recovery data");
    }
    const saved = await writeWorkflowLibraryImport(root, { ...importRequest(), reuseExisting: true });
    expect(await writeWorkflowLibraryImport(root, { ...importRequest(), reuseExisting: true })).toMatchObject({ workflowId: saved.workflowId, reused: true });
    for (const folder of leftovers) expect(await readFile(path.join(root, folder, "preserve.txt"), "utf8")).toBe("recovery data");
    expect((await readdir(root)).sort()).toEqual([...leftovers, saved.folder].sort());
    const snapshot = await readWorkflowLibrary(root); expect(snapshot.scanned).toBe(1); expect(snapshot.issues).toEqual([]);
  });
  it.each(["execution-json", "execution-binding", "requirements", "execution-path", "config-json", "missing-file", "extra-file", "source-mismatch", "metadata-missing", "metadata-hash"])("preserves a damaged %s package and rejects automatic reuse under both its original and a new identity", async damage => {
    const root = await fixtureRoot(), saved = await writeWorkflowLibraryImport(root, importRequest());
    if (damage === "execution-json") await writeFile(path.join(saved.path, "execution.api.json"), "{");
    if (damage === "execution-binding") await writeFile(path.join(saved.path, "execution.api.json"), JSON.stringify({ "2": { class_type: "SaveImage", inputs: { images: ["missing", 0] } } }));
    if (damage === "requirements") await writeFile(path.join(saved.path, "model.requirements.json"), "{\"items\":\"invalid\"}");
    if (damage === "execution-path") {
      const config = JSON.parse(await readFile(path.join(saved.path, "workflow.config.json"), "utf8")); config.execution.file = "../../external.json";
      await writeFile(path.join(saved.path, "workflow.config.json"), JSON.stringify(config));
    }
    if (damage === "config-json") await writeFile(path.join(saved.path, "workflow.config.json"), "{");
    if (damage === "missing-file") await rm(path.join(saved.path, "model.requirements.json"));
    if (damage === "extra-file") await writeFile(path.join(saved.path, "user-note.txt"), "never delete");
    if (damage === "source-mismatch") await writeFile(path.join(saved.path, "source.json"), "{}");
    if (damage === "metadata-missing") await rm(path.join(saved.path, "import.meta.json"));
    if (damage === "metadata-hash") {
      const metadata = JSON.parse(await readFile(path.join(saved.path, "import.meta.json"), "utf8")); metadata.sourceSha256 = "f".repeat(64);
      await writeFile(path.join(saved.path, "import.meta.json"), JSON.stringify(metadata));
    }
    const before = await packageBytes(saved.path);
    for (const id of [WORKFLOW_ID, contentId(importRequest().source)]) {
      const retry = importRequest(); retry.config.id = id; retry.reuseExisting = true;
      await expect(writeWorkflowLibraryImport(root, retry)).rejects.toMatchObject({ status: 409, existing: { path: saved.path, workflowId: WORKFLOW_ID } });
      expect(await packageBytes(saved.path)).toEqual(before); expect(await readdir(root)).toEqual([saved.folder]);
    }
  });
  it("does not reuse a valid package when an original directory makes its identity ambiguous", async () => {
    const root = await fixtureRoot(), saved = await writeWorkflowLibraryImport(root, importRequest());
    const original = path.join(root, "Original-User"); await mkdir(original);
    await writeFile(path.join(original, "workflow.config.json"), JSON.stringify({ id: WORKFLOW_ID }));
    const retry = importRequest(); retry.config.id = contentId(retry.source); retry.reuseExisting = true;
    await expect(writeWorkflowLibraryImport(root, retry)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("多个目录") });
    expect((await readdir(root)).sort()).toEqual([saved.folder, "Original-User"].sort());
  });
  it("imports changed content under a new hash identity without replacing the same-named original", async () => {
    const root = await fixtureRoot(), firstRequest = importRequest();
    const contentId = (source: unknown) => "custom." + createHash("sha256").update(JSON.stringify(source)).digest("hex");
    firstRequest.config.id = contentId(firstRequest.source);
    const first = await writeWorkflowLibraryImport(root, firstRequest);
    const before = await readFile(path.join(first.path, "source.json"));
    const changed = importRequest(); const updatedGraph = graph(); updatedGraph["1"].inputs.image = "changed-reference.png";
    changed.source = updatedGraph; changed.graph = updatedGraph; changed.config.id = contentId(changed.source);
    const second = await writeWorkflowLibraryImport(root, changed);
    expect(second.updated).toBe(false); expect(second.path).not.toBe(first.path);
    expect(await readFile(path.join(first.path, "source.json"))).toEqual(before);
    expect((await readWorkflowLibrary(root)).workflows).toHaveLength(2);
    expect(JSON.parse(await readFile(path.join(second.path, "import.meta.json"), "utf8")).originalFilename).toBe(firstRequest.filename);
  });
  it("preserves the selected output from analyzer through package writing and restores only its branch", async () => {
    const root = await fixtureRoot(), original = { ...graph(), "3": { class_type: "LoadImage", inputs: { image: "other-branch.png" } }, "4": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "other" } } };
    const built = buildWorkflowImport(original, { id: WORKFLOW_ID, name: "选定分支", family: "自定义工作流", outputNodeId: "2" });
    const saved = await writeWorkflowLibraryImport(root, { filename: "multi-output_api.json", source: original, graph: built.graph, config: built.config, requirements: built.requirements });
    const savedConfig = JSON.parse(await readFile(path.join(saved.path, "workflow.config.json"), "utf8"));
    expect(savedConfig.execution).toEqual({ file: "execution.api.json", modelRequirementsFile: "model.requirements.json", output: { nodeId: "2", field: "images", kind: "image" } });
    const snapshot = await readWorkflowLibrary(root); expect(snapshot.issues).toEqual([]);
    expect(snapshot.workflows[0].output).toMatchObject({ nodeId: "2", field: "images", kind: "image" });
    expect(Object.keys(snapshot.workflows[0].template ?? {})).toEqual(["1", "2"]);
    expect(JSON.parse(await readFile(path.join(saved.path, "source.json"), "utf8"))).toEqual(original);
  });
  it("validates explicit output bindings even when the submitted API graph still contains multiple outputs", async () => {
    const root = await fixtureRoot(), request = importRequest();
    request.graph = { ...graph(), "3": { class_type: "SaveImageAdvanced", inputs: { images: ["1", 0], filename_prefix: "alternate" } } };
    request.source = request.graph;
    request.config.execution = { file: "../../outside.json", output: { nodeId: "3", field: "images", kind: "image" } };
    const saved = await writeWorkflowLibraryImport(root, request);
    expect((await readWorkflowLibrary(root)).workflows[0].output.nodeId).toBe("3");
    const arbitrary = structuredClone(request); arbitrary.overwrite = true;
    arbitrary.config.execution = { output: { nodeId: "3", field: "arbitrary-history-key", kind: "image" } };
    await writeWorkflowLibraryImport(root, arbitrary);
    const reread = await readWorkflowLibrary(root);
    expect(reread.issues).toEqual([]); expect(reread.workflows[0].output).toMatchObject({ nodeId: "3", field: "arbitrary-history-key", kind: "image" });
    const bad = importRequest(); bad.config.id = "custom.aaaaaaaaaaaaaaaa"; bad.graph = request.graph;
    bad.config.execution = { output: { nodeId: "missing", field: "images", kind: "image" } };
    await expect(writeWorkflowLibraryImport(root, bad)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("输出绑定") });
    expect(await readdir(root)).toEqual([saved.folder]);
  });
  it("serializes simultaneous imports so they cannot silently replace one another", async () => {
    const root = await fixtureRoot();
    const results = await Promise.allSettled([writeWorkflowLibraryImport(root, importRequest()), writeWorkflowLibraryImport(root, importRequest())]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect((await readWorkflowLibrary(root)).workflows).toHaveLength(1);
  });
  it.each([false, true])("keeps a concurrent reload consistent while a package replacement waits (rollback=%s)", async rollback => {
    const root = await fixtureRoot();
    const original = importRequest();
    const saved = await writeWorkflowLibraryImport(root, original);
    const before = await readWorkflowLibrary(root);
    const request = importRequest();
    request.config.nameLabel = "更新后的名称";
    request.overwrite = true;
    let announceBackup!: () => void, releaseBackup!: () => void;
    const inBackup = new Promise<void>(resolve => { announceBackup = resolve; });
    const resume = new Promise<void>(resolve => { releaseBackup = resolve; });
    failures.commit = rollback;
    failures.pauseAfterBackup = () => { announceBackup(); return resume; };
    const commit = Promise.allSettled([writeWorkflowLibraryImport(root, request)]);
    await inBackup;
    const reads = Array.from({ length: 4 }, () => readWorkflowLibrary(root));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let escaped: boolean;
    try {
      escaped = await Promise.race([
        reads[0].then(() => true),
        new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 150); }),
      ]);
    } finally {
      clearTimeout(timeout);
      releaseBackup();
    }
    const [result] = await commit;
    const snapshots = await Promise.all(reads);
    expect(escaped).toBe(false);
    expect(result.status).toBe(rollback ? "rejected" : "fulfilled");
    for (const snapshot of snapshots) {
      expect(snapshot.issues).toEqual([]);
      expect(snapshot.workflows).toHaveLength(1);
      expect(snapshot.workflows[0]).toMatchObject({
        name: rollback ? original.config.nameLabel : request.config.nameLabel,
        original: { id: saved.workflowId },
        template: before.workflows[0].template,
      });
    }
    expect((await readWorkflowLibraryImportSource(root, saved.workflowId)).source).toEqual(original.source);
    expect(await readdir(root)).toEqual([saved.folder]);
  });
  it("preserves every surviving package through mixed reload, overwrite, delete, retry and reimport", async () => {
    const root = await fixtureRoot();
    const requests = await Promise.all(Array.from({ length: 15 }, (_, index) =>
      prepareWorkflowImport(modelGraph(undefined, "mixed pressure fixture " + index), "same-name.json")));
    const initial = await Promise.all(requests.slice(0, 12).map(request => writeWorkflowLibraryImport(root, request)));
    const before = await readWorkflowLibrary(root);
    const deletions = new Map(before.workflows.map(workflow => [workflow.original!.id, {
      workflowId: workflow.original!.id, folder: workflow.library!.folder, configSha256: workflow.original!.configSha256,
    }]));
    const updates = requests.slice(0, 4).map((request, index) => ({
      ...request, overwrite: true, config: { ...request.config, nameLabel: "更新名称 " + index },
    }));
    const survivors = new Set(initial.slice(8).map(result => result.workflowId));
    const malformed = { ...updates[0], graph: { missing: { class_type: "NotAnOutput", inputs: {} } } };
    const invalid = expect(writeWorkflowLibraryImport(root, malformed)).rejects.toMatchObject({ status: 400 });

    const result = await Promise.all([
      Promise.all(updates.map(request => writeWorkflowLibraryImport(root, request))),
      Promise.all(initial.slice(4, 8).map(item => deleteWorkflowLibraryFolder(root, deletions.get(item.workflowId)!))),
      Promise.all(requests.slice(8, 12).map(request => writeWorkflowLibraryImport(root, { ...request, reuseExisting: true }))),
      Promise.all(requests.slice(12).map(request => writeWorkflowLibraryImport(root, request))),
      Promise.all(Array.from({ length: 6 }, () => readWorkflowLibrary(root))),
      invalid,
    ]);
    expect(result[0].every(item => item.updated)).toBe(true);
    expect(result[1].every(item => item.deleted)).toBe(true);
    expect(result[2].every(item => item.reused)).toBe(true);
    for (const snapshot of result[4]) {
      expect(snapshot.issues).toEqual([]);
      expect(snapshot.workflows.every(workflow => !!workflow.template)).toBe(true);
      expect(snapshot.workflows.filter(workflow => survivors.has(workflow.original!.id))).toHaveLength(4);
    }
    await Promise.all(initial.slice(0, 4).map(item =>
      expect(deleteWorkflowLibraryFolder(root, deletions.get(item.workflowId)!)).rejects.toMatchObject({ status: 409 })));
    await Promise.all(requests.slice(4, 6).map(request => writeWorkflowLibraryImport(root, { ...request, reuseExisting: true })));
    const final = await readWorkflowLibrary(root);
    const expected = requests.filter((_, index) => index < 6 || index > 7);
    expect(final.issues).toEqual([]);
    expect(new Set(final.workflows.map(workflow => workflow.original!.id))).toEqual(new Set(expected.map(request => request.config.id)));
    expect(final.workflows).toHaveLength(13);
    await Promise.all(expected.map(async (request) => {
      const stored = await readWorkflowLibraryImportSource(root, String(request.config.id));
      expect(stored.source).toEqual(request.source);
      const item = final.workflows.find(workflow => workflow.original!.id === request.config.id)!;
      expect(item.template).toBeDefined();
      const files = await packageBytes(path.join(root, item.library!.folder));
      expect(Object.keys(files)).toHaveLength(5);
      expect(JSON.parse(files["execution.api.json"].toString())).toEqual(request.graph);
    }));
    expect(await readdir(root)).toHaveLength(13);
  }, 20_000);
  it("never replaces unowned directories or an original workflow sharing an id", async () => {
    const root = await fixtureRoot(), target = path.join(root, "Custom-0123456789abcdef"); await mkdir(target);
    await writeFile(path.join(target, "original.txt"), "preserve");
    const request = importRequest(); request.overwrite = true;
    await expect(writeWorkflowLibraryImport(root, request)).rejects.toThrow();
    expect(await readFile(path.join(target, "original.txt"), "utf8")).toBe("preserve");
    await rm(target, { recursive: true });
    const original = path.join(root, "DFCine-Original"); await mkdir(original);
    await writeFile(path.join(original, "workflow.config.json"), JSON.stringify({ id: WORKFLOW_ID }));
    await expect(writeWorkflowLibraryImport(root, request)).rejects.toMatchObject({ status: 409, existing: { path: original } });
    expect(await readdir(root)).toEqual(["DFCine-Original"]);
  });
  it("rejects linked destinations and linked files without following or replacing external targets", async () => {
    const root = await fixtureRoot(), outside = await fixtureRoot();
    await writeFile(path.join(outside, "original.txt"), "preserve");
    const target = path.join(root, "Custom-0123456789abcdef");
    await symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
    await expect(writeWorkflowLibraryImport(root, { ...importRequest(), overwrite: true })).rejects.toMatchObject({ status: 403 });
    await expect(readWorkflowLibraryImportSource(root, WORKFLOW_ID)).rejects.toMatchObject({ status: 403 });
    expect(await readFile(path.join(outside, "original.txt"), "utf8")).toBe("preserve");
    await rm(target); const saved = await writeWorkflowLibraryImport(root, importRequest());
    await rm(path.join(saved.path, "execution.api.json"));
    // A directory junction is sufficient to prove that import files cannot be followed.
    await symlink(outside, path.join(saved.path, "execution.api.json"), process.platform === "win32" ? "junction" : "dir");
    await expect(writeWorkflowLibraryImport(root, { ...importRequest(), overwrite: true })).rejects.toMatchObject({ status: 403 });
    expect(await readFile(path.join(outside, "original.txt"), "utf8")).toBe("preserve");
  });
  it("keeps added files and tampered import records instead of deleting them during update", async () => {
    const root = await fixtureRoot(), saved = await writeWorkflowLibraryImport(root, importRequest());
    await writeFile(path.join(saved.path, "my-note.txt"), "keep me");
    await expect(writeWorkflowLibraryImport(root, { ...importRequest(), overwrite: true })).rejects.toMatchObject({ status: 409 });
    expect(await readFile(path.join(saved.path, "my-note.txt"), "utf8")).toBe("keep me");
    await rm(path.join(saved.path, "my-note.txt"));
    await writeFile(path.join(saved.path, "source.json"), "{}");
    await expect(writeWorkflowLibraryImport(root, { ...importRequest(), overwrite: true })).rejects.toMatchObject({ status: 409 });
  });
  it("rolls back the previous package and removes staging files if the commit fails", async () => {
    const root = await fixtureRoot(), saved = await writeWorkflowLibraryImport(root, importRequest());
    const before = await readFile(path.join(saved.path, "workflow.config.json"));
    failures.commit = true;
    const request = { ...importRequest(), overwrite: true }; request.config.nameLabel = "Failed update";
    await expect(writeWorkflowLibraryImport(root, request)).rejects.toThrow("simulated commit failure");
    expect(await readFile(path.join(saved.path, "workflow.config.json"))).toEqual(before);
    expect(await readdir(root)).toEqual([saved.folder]);
  });
  it("validates graph, bindings, identity and size before creating any folder", async () => {
    const root = await fixtureRoot();
    const badId = importRequest(); badId.config.id = "../../DFCine";
    await expect(writeWorkflowLibraryImport(root, badId)).rejects.toMatchObject({ status: 400 });
    const missingNode = importRequest(); missingNode.graph = { "2": { class_type: "SaveImage", inputs: { images: ["missing", 0] } } };
    await expect(writeWorkflowLibraryImport(root, missingNode)).rejects.toMatchObject({ status: 400 });
    const editor = importRequest(); editor.graph = { nodes: [], links: [] };
    await expect(writeWorkflowLibraryImport(root, editor)).rejects.toMatchObject({ status: 400 });
    const large = importRequest(); large.config.description = "x".repeat(1024 * 1024);
    await expect(writeWorkflowLibraryImport(root, large)).rejects.toMatchObject({ status: 413 });
    await expect(writeWorkflowLibraryImport(root, { ...importRequest(), reuseExisting: "yes" } as unknown as WorkflowImportRequest)).rejects.toMatchObject({ status: 400 });
    expect(await readdir(root)).toEqual([]);
  });
});

describe.each(["configureServer", "configurePreviewServer"] as const)("%s import endpoint", hook => {
  it("uses only the configured root and rejects wrong methods, origins, content types, paths and oversized uploads", async () => {
    const project = await fixtureRoot(), library = path.join(project, "library"), outside = await fixtureRoot(); await mkdir(library);
    await writeFile(path.join(project, "workflow-library.settings.json"), JSON.stringify({ sourcePath: library }));
    let handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void = () => { throw new Error("Plugin did not register"); };
    const plugin = workflowLibraryPlugin(project);
    (plugin[hook] as (server: unknown) => void)({ middlewares: { use: (fn: typeof handler) => { handler = fn; } } });
    const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Server not listening");
    const base = "http://127.0.0.1:" + address.port, endpoint = base + "/__canvas/workflow-library/import";
    const upload = (body: unknown, headers: Record<string, string> = {}) => fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...headers }, body: JSON.stringify(body) });
    try {
      expect((await fetch(endpoint)).status).toBe(405);
      expect((await upload(importRequest(), { Origin: "https://unrelated.example" })).status).toBe(403);
      expect((await upload(importRequest(), { Host: "unrelated.example:" + address.port, Origin: "http://unrelated.example:" + address.port })).status).toBe(403);
      expect((await upload(importRequest(), { "Content-Type": "text/plain" })).status).toBe(415);
      expect((await fetch(endpoint + "?path=" + encodeURIComponent(outside), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(importRequest()) })).status).toBe(405);
      expect((await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status).toBe(400);
      const oversized = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": 64 * 1024 * 1024 + 1 } }, response => { response.resume(); resolve(response.statusCode ?? 0); }); req.end();
        req.once("error", reject);
      });
      expect(oversized).toBe(413);
      expect(await readdir(library)).toEqual([]);
      expect(await readdir(outside)).toEqual([]);
      const result = await upload({ ...importRequest(), sourcePath: outside, folder: "../../outside" });
      expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store");
      const saved = await result.json(); expect(saved.path).toBe(path.join(library, saved.folder));
      const sourceEndpoint = base + "/__canvas/workflow-library/source";
      const readSource = (body: unknown, headers: Record<string, string> = {}) => fetch(sourceEndpoint, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...headers }, body: JSON.stringify(body) });
      expect((await fetch(sourceEndpoint)).status).toBe(405);
      expect((await readSource({ workflowId: saved.workflowId }, { Origin: "https://unrelated.example" })).status).toBe(403);
      expect((await readSource({ workflowId: saved.workflowId }, { "Content-Type": "text/plain" })).status).toBe(415);
      expect((await readSource({ workflowId: saved.workflowId, path: outside })).status).toBe(400);
      expect((await readSource({ workflowId: "../../outside" })).status).toBe(400);
      expect((await readSource(null)).status).toBe(400);
      expect((await fetch(sourceEndpoint + "?path=" + encodeURIComponent(outside), { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ workflowId: saved.workflowId }) })).status).toBe(405);
      const sourceOversized = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(sourceEndpoint, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": 64 * 1024 * 1024 + 1 } }, response => { response.resume(); resolve(response.statusCode ?? 0); }); req.end();
        req.once("error", reject);
      });
      expect(sourceOversized).toBe(413);
      const loadedSource = await readSource({ workflowId: saved.workflowId });
      expect(loadedSource.status).toBe(200); expect(loadedSource.headers.get("cache-control")).toBe("no-store");
      expect(await loadedSource.json()).toMatchObject({ source: importRequest().source, filename: importRequest().filename, config: { id: saved.workflowId, nameLabel: "我的工作流" } });
      expect(await readdir(outside)).toEqual([]);
      const duplicate = await upload(importRequest()); expect(duplicate.status).toBe(409);
      expect((await duplicate.json()).existing).toMatchObject({ path: saved.path, workflowId: WORKFLOW_ID });
      const automatic = importRequest(); automatic.config.id = contentId(automatic.source); automatic.reuseExisting = true;
      const metadata = await readFile(path.join(saved.path, "import.meta.json"));
      const reused = await upload(automatic); expect(reused.status).toBe(200);
      expect(await reused.json()).toMatchObject({ path: saved.path, workflowId: WORKFLOW_ID, updated: false, reused: true });
      expect(await readFile(path.join(saved.path, "import.meta.json"))).toEqual(metadata);
      expect(await readdir(library)).toEqual([saved.folder]);
      const update = await upload({ ...importRequest(), overwrite: true }); expect(update.status).toBe(200); expect((await update.json()).updated).toBe(true);
      const read = await fetch(base + "/__canvas/workflow-library"); expect((await read.json()).workflows).toHaveLength(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

const personalWorkflow = "E:/123/【Qwen Image 2.1】图像生成大合集.json";
const cachedCapabilities = ".cache/directory-cloud-capabilities.json";
it.skipIf(!existsSync(personalWorkflow) || !existsSync(cachedCapabilities))("imports the user's Qwen editor 470 branch into a temporary package and restores six references", async () => {
  const root = await fixtureRoot(), before = await readFile(personalWorkflow);
  const source = JSON.parse(before.toString("utf8"));
  const objectInfo = JSON.parse(await readFile(cachedCapabilities, "utf8")).objectInfo;
  const converted = convertEditorWorkflow(source, objectInfo, "470");
  const built = buildWorkflowImport(converted.graph, {
    id: "custom." + createHash("sha256").update(JSON.stringify(source)).digest("hex"),
    name: "Qwen Image 2.1 六图参考", family: "我的工作流", outputNodeId: "470", promptKey: "494.prompt",
  }, objectInfo);
  const saved = await writeWorkflowLibraryImport(root, { filename: path.basename(personalWorkflow), source, graph: built.graph, config: built.config, requirements: built.requirements });
  expect((await readdir(saved.path)).sort()).toEqual(["execution.api.json", "import.meta.json", "model.requirements.json", "source.json", "workflow.config.json"]);
  const snapshot = await readWorkflowLibrary(root);
  expect(snapshot.scanned).toBe(1); expect(snapshot.issues).toEqual([]); expect(snapshot.workflows).toHaveLength(1);
  const workflow = snapshot.workflows[0];
  expect(workflow.name).toBe("Qwen Image 2.1 六图参考"); expect(workflow.family).toBe("Qwen 图像");
  expect(workflow.original?.executionStatus).toBe("plain"); expect(workflow.library?.executionIssue).toBeUndefined();
  expect(workflow.output).toMatchObject({ nodeId: "470", field: "images", kind: "image" });
  expect(workflow.mapping).toContainEqual({ semantic: "prompt", nodeId: "494", field: "prompt" });
  expect(workflow.inputSlots).toHaveLength(6); expect(workflow.inputSlots?.every(slot => slot.kind === "image")).toBe(true);
  // The 470-only branch has no collage's mandatory first-image consumer.
  // Its variable batch still requires at least one of these six reference slots.
  expect(workflow.inputSlots?.filter(slot => slot.required)).toHaveLength(0);
  expect(workflow.inputSlots?.filter(slot => !slot.required)).toHaveLength(6);
  expect(workflow.mediaInputPolicy?.optionalSemantics).toHaveLength(6);
  expect(workflow.mediaInputPolicy?.groups.some(group => group.minimum === 1)).toBe(true);
  expect(workflow.mapping.filter(binding => binding.semantic.startsWith("slot:")).map(binding => binding.nodeId).sort()).toEqual(["420", "432", "433", "434", "435", "436"]);
  expect(Object.keys(workflow.template ?? {})).toHaveLength(21);
  expect(workflow.template?.["416"].inputs.model).toEqual(["471", 0]);
  expect(workflow.template?.["418"].inputs.clip).toEqual(["192", 0]);
  expect(workflow.template?.["426"].inputs.vae).toEqual(["197", 0]);
  expect(await readFile(personalWorkflow)).toEqual(before);
  expect(JSON.parse(await readFile(path.join(saved.path, "source.json"), "utf8"))).toEqual(source);
  console.info(JSON.stringify({ temporaryPackageOnly: true, files: 5, registered: snapshot.workflows.length, executable: snapshot.workflows.filter(entry => entry.template).length, output: workflow.output.nodeId, prompt: "494.prompt", referenceImages: workflow.inputSlots?.length, graphNodes: Object.keys(workflow.template ?? {}).length, originalUnchanged: true, modelRequirements: workflow.original?.models.map(model => model.name), conversionWarnings: converted.warnings }));
});
