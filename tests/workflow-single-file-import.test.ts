import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareWorkflowImport } from "../src/workflow/import-pipeline";
import { writeWorkflowLibraryImport } from "../scripts/workflow-library-writer";
import { readWorkflowLibrary } from "../scripts/workflow-library-reader";
import { normalizeApiWorkflow } from "../vendor/aifisher/server/workflowRuntime/workflowFormat.js";
vi.mock("../src/workflow/aifisher-reader-client", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/workflow/aifisher-reader-client")>();
  const { readAIFisherWorkflow } = await import("../scripts/aifisher-workflow-reader");
  return { ...actual, readAifisherWorkflow: readAIFisherWorkflow };
});

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const folder of temporary.splice(0)) {
    if (path.dirname(path.resolve(folder)) !== path.resolve(os.tmpdir()) || !path.basename(folder).startsWith("canvas-single-file-")) throw new Error("Invalid test cleanup path");
    await rm(folder, { recursive: true, force: true });
  }
});
async function register(source: unknown, filename: string, info?: Record<string, unknown>) {
  const prepared = await prepareWorkflowImport(source, filename, info);
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-single-file-")); temporary.push(root);
  const request = { filename, source, graph: prepared.graph, config: prepared.config, requirements: prepared.requirements, reuseExisting: true };
  const saved = await writeWorkflowLibraryImport(root, request);
  const snapshot = await readWorkflowLibrary(root);
  if (prepared.importState.status === "ready") expect(snapshot.issues).toEqual([]);
  else {
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0].message).toContain("已加入目录");
    expect(snapshot.workflows[0]?.library?.importStatus).toBe("pending");
  }
  expect(snapshot.workflows).toHaveLength(1);
  expect(saved.status).toBe(prepared.importState.status);
  if (prepared.importState.status === "ready") expect(snapshot.workflows[0].template).toBeDefined();
  else expect(snapshot.workflows[0].template).toBeUndefined();
  expect((await readdir(saved.path)).sort()).toEqual(["execution.api.json", "import.meta.json", "model.requirements.json", "source.json", "workflow.config.json"]);
  expect(JSON.parse(await readFile(path.join(saved.path, "source.json"), "utf8"))).toEqual(source);
  return { prepared, root, request, saved, workflow: snapshot.workflows[0] };
}

describe("single file automatic workflow import", () => {
  it("adds an API file offline, keeping two independent outputs, prompts, model names and all source data", async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Offline import must not use the engine"); }));
    const source = {
      text: { class_type: "TextWriterOutput", inputs: { words: "original words" } },
      image: { class_type: "MyImageGenerator", inputs: { unet_name: "my-model.safetensors", seed: 12 } },
      save: { class_type: "SaveImage", inputs: { images: ["image", 0], filename_prefix: "my-prefix" } },
    };
    const original = structuredClone(source);
    const { prepared, request, root, saved, workflow } = await register(source, "my-workflow_api.json");
    expect(prepared.name).toBe("my-workflow");
    expect(prepared.importState.status).toBe("ready");
    expect(workflow.additionalOutputs).toHaveLength(1);
    expect(prepared.graph.image.inputs).toEqual(source.image.inputs);
    expect(prepared.requirements.items).toEqual([{ name: "my-model.safetensors", required: true }]);
    const metadata = await readFile(path.join(saved.path, "import.meta.json"), "utf8");
    expect(await writeWorkflowLibraryImport(root, request)).toMatchObject({ ...saved, reused: true, updated: false });
    expect(await readFile(path.join(saved.path, "import.meta.json"), "utf8")).toBe(metadata);
    expect(source).toEqual(original); expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a plain editor JSON alone with its own named widgets and registered output contract", async () => {
    const info = {
      MakeText: { input: { required: { prompt: ["STRING"], seed: ["INT"] } }, output: ["STRING"] },
      WriteText: { input: { required: { text: ["STRING"] } }, output: [], output_node: true },
    };
    const source = { version: 0.4, nodes: [
      { id: 1, type: "MakeText", pos: [0, 0], widgets_values: { prompt: "author words", seed: 9 }, inputs: [], outputs: [{ name: "STRING", type: "STRING", links: [1] }] },
      { id: 2, type: "WriteText", pos: [400, 0], inputs: [{ name: "text", type: "STRING", link: 1 }], outputs: [], widgets_values: {} },
    ], links: [[1, 1, 0, 2, 0, "STRING"]] };
    const { prepared, workflow } = await register(source, "custom-text.json", info);
    expect(prepared.importState.status).toBe("ready");
    expect(prepared.format).toBe("editor");
    expect(prepared.graph["2"].inputs.text).toEqual(["1", 0]);
    expect(workflow.output).toMatchObject({ nodeId: "2", field: "*" });
    expect(workflow.template?.["1"].inputs).toEqual({ prompt: "author words", seed: 9 });
    expect(prepared.prompt).toBe("author words");
  });

  it("stores uninstalled plugin and model dependencies as warnings without choosing another model", async () => {
    const source = { custom: { class_type: "UserPlugin", inputs: { model: "author-model.safetensors" } },
      save: { class_type: "SaveImage", inputs: { images: ["custom", 0], filename_prefix: "author" } } };
    const { prepared, workflow } = await register(source, "missing-dependencies.json", {
      SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
    });
    expect(prepared.warnings.some(w => w.includes("MISSING_NODE_TYPE") && w.includes("UserPlugin"))).toBe(true);
    expect(prepared.importState.status).toBe("ready");
    expect(workflow.template?.custom.inputs.model).toBe("author-model.safetensors");
  });

  it("keeps missing API inputs unchanged with upstream warnings instead of inventing a source connection", async () => {
    const source = {
      a: { class_type: "Source", inputs: {} }, b: { class_type: "Source", inputs: {} },
      sample: { class_type: "Sample", inputs: {} }, save: { class_type: "SaveImage", inputs: { images: ["sample", 0], filename_prefix: "result" } },
    };
    const original = structuredClone(source);
    const prepared = await prepareWorkflowImport(source, "ambiguous.json", {
      Source: { input: { required: {} }, output: ["MODEL"] },
      Sample: { input: { required: { model: ["MODEL"] } }, output: ["IMAGE"] },
      SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
    });
    expect(prepared.importState.status).toBe("ready");
    expect(prepared.graph).toEqual(original);
    expect(prepared.graph?.sample.inputs).not.toHaveProperty("model");
    expect(prepared.warnings).toContain("MISSING_REQUIRED_INPUT · sample · model");
    expect(source).toEqual(original);
  });

  it("preserves all prompt candidates and disconnected nodes without choosing or pruning a branch", async () => {
    const source = {
      paint: { class_type: "Painter", inputs: { prompt: "author words" } },
      unused: { class_type: "UnusedText", inputs: { prompt: "unrelated words" } },
      a: { class_type: "SaveImage", inputs: { images: ["paint", 0], filename_prefix: "first" } },
      b: { class_type: "SaveImage", inputs: { images: ["paint", 0], filename_prefix: "second" } },
    };
    const { prepared } = await register(source, "two-outputs.json", {
      Painter: { input: { required: { prompt: ["STRING"] } }, output: ["IMAGE"], output_node: false },
      UnusedText: { input: { required: { prompt: ["STRING"] } }, output: ["STRING"], output_node: false },
      SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
    });
    expect(prepared.importState.status).toBe("ready");
    expect(prepared.prompt).toBe("");
    expect(prepared.graph).toEqual(source);
    expect(prepared.graph).toHaveProperty("unused");
    expect(prepared.analysis.prompts.map(prompt => prompt.value)).toEqual(["author words", "unrelated words"]);
  });

  it("keeps author metadata in the source and retains every API node in the saved execution graph", async () => {
    const graph = { make: { class_type: "Painter", inputs: { prompt: "kept words" } },
      save: { class_type: "SaveImage", inputs: { images: ["make", 0], filename_prefix: "kept" } } };
    const source = { ...graph, extra_pnginfo: { workflow: { nodes: [], links: [] } }, metadata: { author: "myself" } };
    const { prepared, workflow } = await register(source, "with-metadata.json");
    expect(prepared.format).toBe("api");
    expect(prepared.importState.status).toBe("ready");
    expect(prepared.graph).toEqual(graph);
    expect(prepared.source).toEqual(source);
    expect(workflow.template).toEqual(graph);
    const metadataOnly = { ...source, extra_pnginfo: { title: "An author-saved API" } };
    const retained = await prepareWorkflowImport(metadataOnly, "api-metadata-only.json");
    expect(retained.importState.status).toBe("ready");
    expect(retained.graph).toEqual(graph);
    expect(retained.source).toEqual(metadataOnly);
  });
});

const capabilities = ".cache/cloud-final-object-info.json";
for (const suffix of ["_api", ""] as const) {
  const filename = "【Qwen Image 2.1】图像生成大合集" + suffix + ".json";
  const file = "E:/123/" + filename;
  it.skipIf(!existsSync(file) || !existsSync(capabilities))("retains the user's Qwen " + (suffix ? "API contract without repairing implicit links" : "editor pending when its custom nodes cannot compile") + " and preserves its source bytes", async () => {
    const bytes = await readFile(file);
    const source = JSON.parse(bytes.toString("utf8"));
    const snapshot = JSON.parse(await readFile(capabilities, "utf8"));
    const info = snapshot.objectInfo ?? snapshot;
    const { prepared, workflow } = await register(source, filename, info);
    if (suffix) {
      expect(prepared.importState.status).toBe("ready");
      expect([workflow.output, ...(workflow.additionalOutputs ?? [])].map(output => output.nodeId)).toEqual(["470"]);
      expect(prepared.graph["413"].class_type).toBe("Image Comparer (rgthree)");
      expect(prepared.graph["414"].class_type).toBe("PreviewImage");
      expect(prepared.graph["496"].class_type).toBe("PreviewAny");
      expect(workflow.inputSlots).toHaveLength(6);
      expect(prepared.graph).toEqual(normalizeApiWorkflow(source));
      expect(workflow.template).toEqual(prepared.graph);
      expect(prepared.graph["310"].inputs.unet_name).toBe("qwen_image_2.1_bf16.safetensors");
    } else {
      expect(prepared.importState.status).toBe("pending");
      expect(prepared.graph).toBeUndefined();
      expect(workflow.template).toBeUndefined();
      expect(prepared.config.importReader).toMatchObject({ compileStatus: "needs-api-export" });
      expect(prepared.importState.diagnostics.find(item => item.code === "GUI_EXECUTION_SEMANTICS_UNSUPPORTED")).toMatchObject({
        category: "unsupported", severity: "error", nodeId: expect.any(String), classType: expect.any(String),
      });
    }
    expect(prepared.source).toEqual(source);
    expect(await readFile(file)).toEqual(bytes);
  });
}
