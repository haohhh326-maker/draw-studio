import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { prepareWorkflowImport } from "../src/workflow/import-pipeline";
import { withImportEnvironmentCapabilities } from "../src/workflow/import-environment-diagnostics";
import { writeWorkflowLibraryImport } from "../scripts/workflow-library-writer";
import { readWorkflowLibrary } from "../scripts/workflow-library-reader";
import { importReadiness } from "../src/workflow/import-review";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";

const source = {
  "127": { class_type: "UNETLoader", inputs: { unet_name: "original-model.safetensors" } },
  "165": { class_type: "BlockSparseAttention", inputs: { model: ["127", 0], selection: "sol-attn", "selection.tau": 1.3 } },
  "188": { class_type: "LoadImage", inputs: { image: "original-reference.png" } },
  "136": { class_type: "ReferenceCollection", inputs: { model: ["165", 0], "ref_images.ref_image_0": ["188", 0] } },
  "200": { class_type: "忽略多组孤海", inputs: {}, _meta: { title: "图像参考 · 多组开关" } },
  "save": { class_type: "SaveImage", inputs: { images: ["136", 0], filename_prefix: "saved" } },
};
const info = {
  UNETLoader: { input: { required: { unet_name: [["different-model.safetensors"]] } }, output: ["MODEL"] },
  BlockSparseAttention: { input: { required: { model: ["MODEL"], selection: ["COMFY_DYNAMICCOMBO_V3", { options: [
    { key: "sol-attn", inputs: { required: { tau: ["FLOAT", { default: 1.3, min: 0, max: 4, step: 0.05 }] } } },
  ] }] } }, output: ["MODEL"] },
  LoadImage: { input: { required: { image: [["uploaded.png"], { image_upload: true }] } }, output: ["IMAGE"] },
  ReferenceCollection: { input: { required: { model: ["MODEL"] }, optional: { ref_images: ["COMFY_AUTOGROW_V3", {
    template: { prefix: "ref_image_", min: 1, max: 9, input: { required: { ref_image: ["IMAGE"] } } },
  }] } }, output: ["IMAGE"] },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
};
const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("canvas-environment-test-")) throw new Error("Invalid temporary fixture root");
    await rm(root, { recursive: true, force: true });
  }
});
const prepare = () => prepareWorkflowImport(source, "environment_api.json", info,
  async request => await readAIFisherWorkflow(request) as AifisherWorkflowReadResult);
function routedVideoFixture() {
  const graph = { ...source,
    clip: { class_type: "VHS_LoadVideo", inputs: { video: "authored-reference.mp4" } },
    frames: { class_type: "FrameResize", inputs: { images: ["clip", 0] } },
    "136": { ...source["136"], inputs: { ...source["136"].inputs,
      "ref_videos.ref_video_0": ["frames", 0], "ref_video_audios.ref_video_audio_0": ["clip", 2] } },
  };
  const definitions = { ...info,
    VHS_LoadVideo: { input: { required: { video: ["STRING"] } }, output: ["IMAGE", "INT", "AUDIO"] },
    FrameResize: { input: { required: { images: ["IMAGE"] } }, output: ["IMAGE"] },
    ReferenceCollection: { ...info.ReferenceCollection, input: { ...info.ReferenceCollection.input, optional: {
      ...info.ReferenceCollection.input.optional,
      ref_videos: ["COMFY_AUTOGROW_V3", { template: { prefix: "ref_video_", min: 0, max: 3, input: { required: { video: ["IMAGE"] } } } }],
      ref_video_audios: ["COMFY_AUTOGROW_V3", { template: { prefix: "ref_video_audio_", min: 0, max: 3, input: { required: { audio: ["AUDIO"] } } } }],
    } } },
  };
  return { graph, definitions };
}

describe("readable cloud import environment findings", () => {
  it("retains the exact graph source and reports dependencies and compatibility without sample media", async () => {
    const before = structuredClone(source), prepared = await prepare();
    expect(prepared.importState.status).toBe("ready");
    expect(prepared.graph).toEqual(before);
    const report = prepared.importState.environmentReport!;
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "127", category: "model-unavailable", actualValue: "original-model.safetensors" }),
      expect.objectContaining({ nodeId: "200", category: "missing-node", classType: "忽略多组孤海" }),
    ]));
    expect(report.hasBlockingIssues).toBe(true);
    expect(report.issues.some(issue => issue.category === "unsupported")).toBe(false);
    expect(prepared.graph!["165"].inputs).toEqual(source["165"].inputs);
    expect(prepared.graph!["136"].inputs).toEqual(source["136"].inputs);
    expect(prepared.analysis.inputs).toEqual([expect.objectContaining({ nodeId: "188", field: "image", kind: "image" })]);
    expect(report.issues.some(issue => issue.nodeId === "188")).toBe(false);
    expect(prepared.importState.diagnostics.some(issue => issue.nodeId === "188")).toBe(false);
    expect(prepared.importState.diagnostics.some(item => item.code === "aifisher-variable-asset-runtime-required")).toBe(false);
    expect(prepared.source).toEqual(before);
    expect(source).toEqual(before);
    expect(importReadiness(prepared, false).execution).toContain("未确认");
  });

  it("keeps dependency findings and the exact supported graph across package save and directory reload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-environment-test-")); temporary.push(root);
    const prepared = await prepare();
    prepared.importState.environmentReport = withImportEnvironmentCapabilities(prepared.importState.environmentReport!, "cached");
    const saved = await writeWorkflowLibraryImport(root, prepared);
    expect(saved.status).toBe("ready");
    const config = JSON.parse(await readFile(path.join(root, saved.folder, "workflow.config.json"), "utf8"));
    expect(config.importState.environmentReport).toEqual(prepared.importState.environmentReport);
    const library = await readWorkflowLibrary(root);
    expect(library.workflows[0].library?.environmentReport?.capabilities).toBe("cached");
    expect(library.workflows[0].library?.environmentReport?.issues).toEqual(prepared.importState.environmentReport!.issues);
    expect(library.workflows[0].library?.importStatus).toBe("ready");
    expect(library.workflows[0].library?.environmentReport?.hasBlockingIssues).toBe(true);
    expect(library.workflows[0].template).toEqual(source);
    expect(JSON.parse(await readFile(path.join(root, saved.folder, "source.json"), "utf8"))).toEqual(source);
  });
  it("keeps an unsupported asset-group contract pending through save and reload", async () => {
    const before = structuredClone(source);
    const prepared = await prepareWorkflowImport(source, "unsupported_api.json", info, async request => {
      const read = await readAIFisherWorkflow(request) as AifisherWorkflowReadResult;
      const group = read.bindingCandidates.find(candidate => candidate.valueType === "ASSET_GROUP")!;
      const metadata = group.variableAssetGroup as { branches: { connections: { outputIndex: number }[] }[] };
      metadata.branches[0].connections[0].outputIndex = 99;
      return read;
    });
    expect(prepared.importState.status).toBe("pending");
    expect(prepared.graph).toBeUndefined();
    expect(prepared.importState.diagnostics).toContainEqual(expect.objectContaining({ nodeId: "136", field: "ref_images", code: "aifisher-variable-asset-runtime-required" }));
    expect(prepared.source).toEqual(before); expect(source).toEqual(before);
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-environment-test-")); temporary.push(root);
    prepared.importState.environmentReport = withImportEnvironmentCapabilities(prepared.importState.environmentReport!, "cached");
    const saved = await writeWorkflowLibraryImport(root, prepared);
    expect(saved.status).toBe("pending");
    const library = await readWorkflowLibrary(root);
    expect(library.workflows[0].library?.importStatus).toBe("pending");
    expect(library.workflows[0].template).toBeUndefined();
    expect(library.workflows[0].library?.environmentReport?.issues).toEqual(prepared.importState.environmentReport!.issues);
    expect(JSON.parse(await readFile(path.join(root, saved.folder, "source.json"), "utf8"))).toEqual(before);
  });
  it("retains preprocessed video frames and the original paired soundtrack without adding synthetic loaders", async () => {
    const { graph, definitions } = routedVideoFixture(), before = structuredClone(graph);
    const reader = await readAIFisherWorkflow({ environment: "comfyui", source: graph, objectInfo: definitions }) as AifisherWorkflowReadResult;
    expect(reader.bindingCandidates).toContainEqual(expect.objectContaining({ nodeId: "136", fieldName: "ref_videos", valueType: "ASSET_GROUP",
      variableAssetGroup: expect.objectContaining({ minimumItems: 0, capacity: 0, branches: [] }) }));
    const prepared = await prepareWorkflowImport(graph, "routed-video_api.json", definitions, async () => reader);
    expect(prepared.importState.status).toBe("ready");
    expect(prepared.graph).toEqual(before); expect(prepared.source).toEqual(before); expect(graph).toEqual(before);
    expect(prepared.analysis.inputs).toHaveLength(2);
    expect(prepared.analysis.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "188", field: "image", kind: "image" }),
      expect.objectContaining({ nodeId: "clip", field: "video", kind: "video" }),
    ]));
    expect(prepared.importState.diagnostics.some(item => item.code === "aifisher-variable-asset-runtime-required")).toBe(false);
    expect(JSON.stringify(prepared.graph)).not.toContain("__FISHERAI_RUNTIME_UPLOAD__");
  });
  it.each(["missing-schema", "wrong-port", "wrong-type", "beyond-group-capacity"])("keeps a routed asset group pending for %s", async failure => {
    const { graph, definitions } = routedVideoFixture();
    if (failure === "wrong-port") graph["136"].inputs["ref_videos.ref_video_0"] = ["frames", 99];
    if (failure === "wrong-type") definitions.FrameResize.output = ["AUDIO"];
    if (failure === "beyond-group-capacity") {
      (graph["136"].inputs as Record<string, unknown>)["ref_videos.ref_video_3"] = graph["136"].inputs["ref_videos.ref_video_0"];
      delete (graph["136"].inputs as Record<string, unknown>)["ref_videos.ref_video_0"];
    }
    const schema: Record<string, unknown> = definitions;
    if (failure === "missing-schema") delete schema.FrameResize;
    const before = structuredClone(graph);
    const prepared = await prepareWorkflowImport(graph, "invalid-routed-video_api.json", schema,
      async request => await readAIFisherWorkflow(request) as AifisherWorkflowReadResult);
    expect(prepared.importState.status).toBe("pending");
    expect(prepared.graph).toBeUndefined();
    expect(prepared.importState.diagnostics).toContainEqual(expect.objectContaining({ nodeId: "136", field: "ref_videos", code: "aifisher-variable-asset-runtime-required" }));
    expect(prepared.source).toEqual(before); expect(graph).toEqual(before);
  });
});
