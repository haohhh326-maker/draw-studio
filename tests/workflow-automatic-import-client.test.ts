import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Connection } from "../src/types";
import { applyImportReview, initialImportReview } from "../src/workflow/import-review";
import type { WorkflowImportSource } from "../src/workflow/import-client";
import { prepareWorkflowImport, type PreparedWorkflowImport } from "../src/workflow/import-pipeline";
import { readWorkflowLibraryImportSource, writeWorkflowLibraryImport } from "../scripts/workflow-library-writer";
import { readWorkflowLibrary } from "../scripts/workflow-library-reader";

vi.mock("../src/workflow/aifisher-reader-client", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/workflow/aifisher-reader-client")>();
  const { readAIFisherWorkflow } = await import("../scripts/aifisher-workflow-reader");
  return { ...actual, readAifisherWorkflow: vi.fn(readAIFisherWorkflow) };
});
const calls = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), automatic: vi.fn() }));
vi.mock("../src/workflow/import-client", async importOriginal => ({
  ...await importOriginal<typeof import("../src/workflow/import-client")>(),
  readWorkflowImportSource: calls.read, saveWorkflowImport: calls.save,
}));
vi.mock("../src/workflow/automatic-import", () => ({ prepareAutomaticWorkflowImport: calls.automatic }));
import { isImportPluginDiagnostic, repairSavedWorkflowImport, saveAutomaticWorkflowImport } from "../src/workflow/automatic-import-client";

const connection: Connection = { name: "test workstation", baseUrl: "https://workstation.example", token: "private-test-credential", authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 5 };
beforeEach(() => { calls.read.mockReset(); calls.save.mockReset(); calls.automatic.mockReset(); });

async function prepared(): Promise<PreparedWorkflowImport> {
  const value = await prepareWorkflowImport({
    make: { class_type: "OwnImageGenerator", inputs: { prompt: "author's original intent", model_name: "original.safetensors" } },
    save: { class_type: "SaveImage", inputs: { images: ["make", 0], filename_prefix: "author/prefix" } },
  }, "author-original.json");
  if (!value.graph) throw new Error("Fixture must have a parsed execution contract");
  value.graph.make.inputs.strength = .75;
  value.config.inputs = [{ id: "new-media", binding: { nodeId: "make", path: "inputs.reference" } }];
  value.config.parameters = [{ id: "new-strength", binding: { nodeId: "make", path: "inputs.strength" } }];
  value.config.execution = { file: "execution.api.json", output: { nodeId: "save", field: "images", kind: "image" } };
  value.requirements.items = [{ name: "newly-resolved.safetensors", required: true }];
  return value;
}
function saved(id: string, reused = false) {
  return { folder: "OwnWorkflow", path: "/library/OwnWorkflow", workflowId: id, updated: !reused, reused, status: "ready" as const };
}
function prior(value: PreparedWorkflowImport): WorkflowImportSource {
  return { source: structuredClone(value.source), filename: "verified-original-name.json", config: {
    id: value.config.id, nameLabel: { "zh-CN": "保留作者名称", "en-US": "Keep author title" }, primaryCategoryLabel: "Author custom family",
    description: "Keep my description", docs: { localizedUrls: { "zh-CN": "https://docs.example/author" } }, promptPlaceholder: "Keep my placeholder",
    inputs: [{ id: "stale-media" }], parameters: [{ id: "stale-parameter" }], execution: { output: { nodeId: "obsolete" } },
    importState: { status: "ready", diagnostics: [{ code: "manager-plugin-unmatched", classType: "OwnImageGenerator", message: "Old Manager result" }] },
  } };
}
const automaticResult = (value: PreparedWorkflowImport) => ({ prepared: value, warnings: ["new automatic import result"], schema: { info: {}, warnings: [] }, manager: { marker: "latest Manager result" } });
const publishedPrompt = { nodeId: "49", field: "text" };
const multipromptSource = () => ({
  "49": { class_type: "CR Text", inputs: { text: "first-stage sample" } },
  "70": { class_type: "CR Prompt Text", inputs: { prompt: "second-stage sample" } },
  first: { class_type: "OwnImageGenerator", inputs: { prompt: ["49", 0] } },
  second: { class_type: "OwnImageGenerator", inputs: { prompt: ["70", 0], image: ["first", 0] } },
  save: { class_type: "SaveImage", inputs: { images: ["second", 0], filename_prefix: "test" } },
});

describe("automatic import persistence and retry", () => {
  it("saves a new automatically prepared import once in idempotent mode", async () => {
    const value = await prepared(), signal = new AbortController().signal, result = saved(String(value.config.id));
    calls.save.mockResolvedValue(result);
    expect(await saveAutomaticWorkflowImport(value, signal)).toEqual({ prepared: value, saved: result });
    expect(calls.save).toHaveBeenCalledExactlyOnceWith({ ...value, reuseExisting: true }, signal);
    expect(calls.read).not.toHaveBeenCalled(); expect(calls.automatic).not.toHaveBeenCalled();
  });

  it("keeps saved presentation while adopting the newly parsed graph, mappings, requirements and diagnostics", async () => {
    const value = await prepared(), originalPrepared = structuredClone(value), existing = prior(value), originalExisting = structuredClone(existing);
    const signal = new AbortController().signal;
    calls.save.mockResolvedValue(saved(String(value.config.id)));
    const result = await saveAutomaticWorkflowImport(value, signal, existing);
    expect(calls.read).not.toHaveBeenCalled(); expect(calls.save).toHaveBeenCalledTimes(1);
    const request = calls.save.mock.calls[0][0];
    expect(request.overwrite).toBe(true); expect(request).not.toHaveProperty("reuseExisting");
    for (const key of ["nameLabel", "primaryCategoryLabel", "description", "docs", "promptPlaceholder"]) expect(request.config[key]).toEqual(existing.config[key]);
    expect(request.graph).toEqual(value.graph); expect(request.requirements).toEqual(value.requirements);
    for (const key of ["inputs", "parameters", "execution", "importState"]) expect(request.config[key]).toEqual(value.config[key]);
    expect(request.source).toEqual(value.source);
    expect(result.prepared.config).toEqual(request.config);
    expect(value).toEqual(originalPrepared); expect(existing).toEqual(originalExisting);
    request.config.docs.localizedUrls["zh-CN"] = "https://docs.example/changed-in-memory";
    expect(existing.config).toEqual(originalExisting.config);
  });

  it("retries from the verified saved original, forwarding connection, cancellation and progress to automatic repair", async () => {
    const value = await prepared(), existing = prior(value), signal = new AbortController().signal, progress = vi.fn();
    const automatic = automaticResult(value), result = saved(String(value.config.id));
    calls.read.mockResolvedValue(existing); calls.automatic.mockResolvedValue(automatic); calls.save.mockResolvedValue(result);
    const response = await repairSavedWorkflowImport(String(value.config.id), connection, signal, progress);
    expect(calls.read).toHaveBeenCalledExactlyOnceWith(value.config.id, signal);
    expect(calls.automatic).toHaveBeenCalledExactlyOnceWith(existing.source, existing.filename, connection, signal, progress, undefined);
    expect(calls.read.mock.invocationCallOrder[0]).toBeLessThan(calls.automatic.mock.invocationCallOrder[0]);
    expect(calls.automatic.mock.invocationCallOrder[0]).toBeLessThan(calls.save.mock.invocationCallOrder[0]);
    expect(calls.save.mock.calls[0][0]).toMatchObject({ overwrite: true, graph: value.graph, requirements: value.requirements, config: { nameLabel: existing.config.nameLabel, primaryCategoryLabel: existing.config.primaryCategoryLabel } });
    expect(response).toMatchObject({ saved: result, manager: automatic.manager, warnings: automatic.warnings });
    expect(response.prepared.source).toEqual(existing.source);
  });

  it("uses the verified publisher target when checking a saved workflow", async () => {
    const source = multipromptSource(), signal = new AbortController().signal;
    const original = await prepareWorkflowImport(source, "original.json", undefined, undefined, signal, publishedPrompt);
    const existing = { source, filename: "original.json", config: original.config };
    calls.read.mockResolvedValue(existing);
    calls.automatic.mockImplementation(async (source, filename, _conn, signal, _progress, options) =>
      automaticResult(await prepareWorkflowImport(source, filename, undefined, undefined, signal, options.publishedPrompt)));
    calls.save.mockResolvedValue(saved(String(original.config.id)));

    const result = await repairSavedWorkflowImport(String(original.config.id), connection, signal, undefined, { installMissingPlugins: false });
    expect(calls.automatic).toHaveBeenCalledExactlyOnceWith(source, existing.filename, connection, signal, undefined,
      { installMissingPlugins: false, publishedPrompt });
    expect(result.prepared.config.prompt).toMatchObject({ binding: { nodeId: "49", path: "inputs.text" } });
    expect(result.prepared.config.importPublishedPrompt).toEqual(publishedPrompt);
    expect(result.prepared.graph).toEqual(original.graph);
  });

  it.each([false, true])("restores a saved publisher binding from an identical unannotated upload while respecting review=%s", async manual => {
    const source = multipromptSource(), signal = new AbortController().signal;
    const original = await prepareWorkflowImport(source, "original.json", undefined, undefined, signal, publishedPrompt);
    const unannotated = await prepareWorkflowImport(source, "same-source.json");
    expect(unannotated.config.prompt).toBeUndefined();
    expect(unannotated.config.id).toBe(original.config.id);
    const existing: WorkflowImportSource = { source, filename: "original.json", config: { ...original.config, nameLabel: "Author library title" } };
    if (manual) existing.config.importBindingReview = {
      ...initialImportReview(original), prompt: { nodeId: "70", field: "prompt", classType: "CR Prompt Text" },
    };
    calls.save.mockResolvedValueOnce(saved(String(original.config.id), true)).mockResolvedValueOnce(saved(String(original.config.id)));
    calls.read.mockResolvedValue(existing);

    const { prepared: reopened } = await saveAutomaticWorkflowImport(unannotated, signal);
    const target = manual ? { nodeId: "70", field: "prompt" } : publishedPrompt;
    expect(reopened.config.prompt).toMatchObject({ binding: { nodeId: target.nodeId, path: "inputs." + target.field } });
    expect(reopened.config.importPublishedPrompt).toEqual(publishedPrompt);
    expect(reopened.config.nameLabel).toBe("Author library title");
    expect(reopened.config.importBindingReview).toEqual(existing.config.importBindingReview);
    expect(reopened.graph).toEqual(original.graph);
    expect(calls.save).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite another workflow when the verified source identity differs", async () => {
    const value = await prepared(), existing = prior(value), before = structuredClone(existing);
    existing.config.id = "custom." + "f".repeat(64);
    await expect(saveAutomaticWorkflowImport(value, new AbortController().signal, existing)).rejects.toThrow("ID 不一致");
    expect(calls.save).not.toHaveBeenCalled(); expect(calls.read).not.toHaveBeenCalled();
    expect(existing.source).toEqual(before.source); expect(existing.config.nameLabel).toEqual(before.config.nameLabel);
  });

  it("upgrades a verified legacy ready package under its original short identity without changing its source or folder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-auto-client-"));
    try {
      const source = { make: { class_type: "OwnImageGenerator", inputs: { prompt: "legacy intent", model_name: "author.safetensors", steps: 4 } }, save: { class_type: "SaveImage", inputs: { images: ["make", 0], filename_prefix: "author-prefix" } } };
      const initial = await prepareWorkflowImport(source, "legacy-original.json");
      const legacyId = String(initial.config.id).slice(0, "custom.".length + 16);
      initial.config = { ...initial.config, id: legacyId, nameLabel: "Retain legacy author title", primaryCategoryLabel: "Legacy author family", description: "Retain description", promptPlaceholder: "Retain placeholder", docs: { localizedUrls: { "zh-CN": "https://docs.example/legacy" } } };
      const first = await writeWorkflowLibraryImport(root, initial);
      const before = await readFile(path.join(first.path, "source.json"));
      const reparsed = await prepareWorkflowImport(source, "legacy-original.json", {
        OwnImageGenerator: { input: { required: { prompt: ["STRING"], model_name: ["STRING"], steps: ["INT", { default: 4 }] } }, output: ["IMAGE"] },
        SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
      });
      expect(reparsed.config.id).not.toBe(legacyId); expect(reparsed.graph?.make.inputs.steps).toBe(4);
      calls.read.mockImplementation((id: string) => readWorkflowLibraryImportSource(root, id));
      calls.automatic.mockResolvedValue(automaticResult(reparsed));
      calls.save.mockImplementation(request => writeWorkflowLibraryImport(root, request));
      const result = await repairSavedWorkflowImport(legacyId, connection, new AbortController().signal);
      expect(result.saved).toMatchObject({ workflowId: legacyId, path: first.path, updated: true });
      expect(result.prepared.config.id).toBe(legacyId);
      const actual = (await readWorkflowLibrary(root)).workflows[0];
      expect(actual.original?.id).toBe(legacyId); expect(actual.name).toBe("Retain legacy author title"); expect(actual.family).toBe("Legacy author family");
      expect(actual.template?.make.inputs.steps).toBe(4);
      expect(actual.parameters.some(parameter => parameter.key === "steps" && parameter.default === 4)).toBe(true);
      expect(await readFile(path.join(first.path, "source.json"))).toEqual(before);
      expect(await readdir(root)).toEqual([first.folder]);
    } finally {
      if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("canvas-auto-client-")) throw new Error("Unsafe fixture cleanup path");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reuse a legacy identity for a different original source", async () => {
    const value = await prepared(), existing = prior(value);
    existing.config.id = "custom." + "a".repeat(16); existing.source = { different: "original source" };
    await expect(saveAutomaticWorkflowImport(value, new AbortController().signal, existing)).rejects.toThrow("ID 不一致");
    expect(calls.save).not.toHaveBeenCalled();
  });

  it.each(["cleared", "changed"])("refreshes Manager diagnostics on a reused upload when they are %s", async mode => {
    const value = await prepared(), existing = prior(value), signal = new AbortController().signal;
    const diagnostics = mode === "cleared" ? [] : [{ code: "manager-plugin-failed", classType: "OwnImageGenerator", message: "New specific installation failure" }];
    value.importState = { ...value.importState, diagnostics }; value.config.importState = value.importState;
    const first = saved(String(value.config.id), true), second = saved(String(value.config.id));
    calls.save.mockResolvedValueOnce(first).mockResolvedValueOnce(second); calls.read.mockResolvedValue(existing);
    const result = await saveAutomaticWorkflowImport(value, signal);
    expect(calls.save).toHaveBeenCalledTimes(2); expect(calls.save.mock.calls[0][0].reuseExisting).toBe(true);
    expect(calls.read).toHaveBeenCalledExactlyOnceWith(first.workflowId, signal);
    const replacement = calls.save.mock.calls[1][0];
    expect(replacement).toMatchObject({ overwrite: true, graph: value.graph, config: { nameLabel: existing.config.nameLabel, importState: { diagnostics } } });
    expect(replacement).not.toHaveProperty("reuseExisting");
    expect(result.prepared.importState.diagnostics).toEqual(diagnostics); expect(result.saved).toBe(second);
    expect(existing.config.importState).toEqual({ status: "ready", diagnostics: [{ code: "manager-plugin-unmatched", classType: "OwnImageGenerator", message: "Old Manager result" }] });
  });

  it("keeps a newly inferred family when an existing package used the old automatic family bucket", async () => {
    const value = await prepared(), existing = prior(value);
    value.config.primaryCategoryLabel = "New model family"; existing.config.primaryCategoryLabel = "自定义工作流";
    calls.save.mockResolvedValue(saved(String(value.config.id)));
    await saveAutomaticWorkflowImport(value, new AbortController().signal, existing);
    expect(calls.save.mock.calls[0][0].config.primaryCategoryLabel).toBe("New model family");
  });

  it("refreshes the old reader's automatic other-workflow category on reread without losing bindings or presentation", async () => {
    const value = await prepared(), existing = prior(value), signal = new AbortController().signal;
    existing.config.importReader = structuredClone(value.config.importReader);
    existing.config.primaryCategoryLabel = "其他工作流";
    value.config.primaryCategoryLabel = "图像工作流";
    calls.read.mockResolvedValue(existing); calls.automatic.mockResolvedValue(automaticResult(value));
    calls.save.mockResolvedValue(saved(String(value.config.id)));
    const result = await repairSavedWorkflowImport(String(value.config.id), connection, signal);
    expect(result.prepared.config.primaryCategoryLabel).toBe("图像工作流");
    expect(result.prepared.config.nameLabel).toEqual(existing.config.nameLabel);
    expect(result.prepared.config.description).toEqual(existing.config.description);
    for (const key of ["inputs", "parameters", "execution"]) expect(result.prepared.config[key]).toEqual(value.config[key]);
    expect(result.prepared.graph).toEqual(value.graph);
    expect(existing.config.primaryCategoryLabel).toBe("其他工作流");
  });

  it("does not reinterpret an unproven category as an automatic reader category", async () => {
    const value = await prepared(), existing = prior(value);
    existing.config.primaryCategoryLabel = "其他工作流";
    value.config.primaryCategoryLabel = "图像工作流";
    calls.save.mockResolvedValue(saved(String(value.config.id)));
    const result = await saveAutomaticWorkflowImport(value, new AbortController().signal, existing);
    expect(result.prepared.config.primaryCategoryLabel).toBe("其他工作流");
  });

  it("does not overwrite a reused package if reading the verified original fails", async () => {
    const value = await prepared(); calls.save.mockResolvedValue(saved(String(value.config.id), true)); calls.read.mockRejectedValue(new Error("Saved source hash changed"));
    await expect(saveAutomaticWorkflowImport(value, new AbortController().signal)).rejects.toThrow("source hash changed");
    expect(calls.save).toHaveBeenCalledTimes(1);
  });

  it("does not save a retry when automatic repair fails", async () => {
    const value = await prepared(); calls.read.mockResolvedValue(prior(value)); calls.automatic.mockRejectedValue(new Error("Manager lookup failed"));
    await expect(repairSavedWorkflowImport(String(value.config.id), connection, new AbortController().signal)).rejects.toThrow("Manager lookup failed");
    expect(calls.save).not.toHaveBeenCalled();
  });
});

describe("automatic import cancellation boundaries", () => {
  it("never starts a save for an already cancelled import", async () => {
    const value = await prepared(), controller = new AbortController(); controller.abort();
    await expect(saveAutomaticWorkflowImport(value, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.save).not.toHaveBeenCalled(); expect(calls.read).not.toHaveBeenCalled();
  });

  it("does not begin installation after cancellation while reading the saved original", async () => {
    const value = await prepared(), controller = new AbortController();
    calls.read.mockImplementation(async (_id, signal) => { expect(signal).toBe(controller.signal); controller.abort(); return prior(value); });
    await expect(repairSavedWorkflowImport(String(value.config.id), connection, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.automatic).not.toHaveBeenCalled(); expect(calls.save).not.toHaveBeenCalled();
  });

  it("does not write a stale repair result after cancellation during automatic preparation", async () => {
    const value = await prepared(), controller = new AbortController(); calls.read.mockResolvedValue(prior(value));
    calls.automatic.mockImplementation(async (_source, _filename, _connection, signal) => { expect(signal).toBe(controller.signal); controller.abort(); return automaticResult(value); });
    await expect(repairSavedWorkflowImport(String(value.config.id), connection, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.save).not.toHaveBeenCalled();
  });

  it.each(["first-save", "source-read"])("does not overwrite a reused package when cancelled during %s", async stage => {
    const value = await prepared(), controller = new AbortController();
    calls.save.mockImplementation(async (_request, signal) => { expect(signal).toBe(controller.signal); if (stage === "first-save") controller.abort(); return saved(String(value.config.id), true); });
    calls.read.mockImplementation(async (_id, signal) => { expect(signal).toBe(controller.signal); controller.abort(); return prior(value); });
    await expect(saveAutomaticWorkflowImport(value, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.save).toHaveBeenCalledTimes(1);
    expect(calls.read).toHaveBeenCalledTimes(stage === "first-save" ? 0 : 1);
  });
});

it("distinguishes plugin discovery outcomes from parser and parameter errors", () => {
  expect(isImportPluginDiagnostic({ code: "node-definition-not-in-snapshot" })).toBe(true);
  expect(isImportPluginDiagnostic({ code: "manager-plugin-unmatched" })).toBe(true);
  expect(isImportPluginDiagnostic({ code: "manager-plugin-installed-pending-restart" })).toBe(true);
  expect(isImportPluginDiagnostic({ code: "conversion-incomplete" })).toBe(false);
  expect(isImportPluginDiagnostic({ code: "graph-invalid" })).toBe(false);
});


it("retains explicit prompt/output choices when rereading an existing import", async () => {
  const value = await prepared(), existing = prior(value), review = initialImportReview(value);
  review.prompt = { nodeId: "make", field: "prompt", classType: "OwnImageGenerator" };
  review.outputs[0].kind = "video";
  existing.config.importBindingReview = review;
  calls.read.mockResolvedValue(existing);
  calls.save.mockResolvedValue(saved(String(value.config.id)));
  const result = await saveAutomaticWorkflowImport(value, new AbortController().signal, existing);
  expect(result.prepared.config.importBindingReview).toEqual(review);
  expect(result.prepared.config.nodeKind).toBe("video");
  expect(result.prepared.graph).toEqual(value.graph);
});

it("does not overwrite a confirmed workflow with an incomplete reread", async () => {
  const value = await prepared(), existing = prior(value);
  existing.config.importBindingReview = initialImportReview(value);
  const incomplete = { ...value, importState: { ...value.importState, status: "pending" as const } };
  await expect(saveAutomaticWorkflowImport(incomplete, new AbortController().signal, existing)).rejects.toThrow("保留原工作流");
  expect(calls.save).not.toHaveBeenCalled();
});

it("does not overwrite saved bindings when a target class has changed", async () => {
  const value = await prepared(), existing = prior(value), review = initialImportReview(value);
  review.prompt = { nodeId: "make", field: "prompt", classType: "OldClass" };
  existing.config.importBindingReview = review;
  await expect(saveAutomaticWorkflowImport(value, new AbortController().signal, existing)).rejects.toThrow("提示词绑定已失效");
  expect(calls.save).not.toHaveBeenCalled();
});
