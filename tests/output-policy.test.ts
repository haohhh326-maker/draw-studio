import { describe, expect, it } from "vitest";
import { collectWorkflowOutputs } from "../src/comfyui/client";
import { outputKey } from "../src/comfyui/files";
import { compareOutputDescriptors, prioritizeOutputAssets, selectPreferredOutputDescriptor } from "../src/workflow/output-policy";
import type { ApiWorkflow, Asset, MediaKind, RemoteFile, WorkflowDefinition } from "../src/types";

const node = (class_type: string, inputs: Record<string, unknown> = {}) => ({ class_type, inputs });
const descriptor = (nodeId: string, kind: MediaKind = "image", field = "images") => ({ nodeId, kind, field });
const graph: ApiWorkflow = {
  model: node("CheckpointLoaderSimple"),
  latent: node("EmptyLatentImage"),
  sample: node("KSampler", { model: ["model", 0], latent_image: ["latent", 0] }),
  decode: node("VAEDecode", { samples: ["sample", 0], vae: ["model", 2] }),
  normal: node("SaveImage", { images: ["decode", 0] }),
  upscale_model: node("UpscaleModelLoader"),
  upscale: node("ImageUpscaleWithModel", { image: ["decode", 0], upscale_model: ["upscale_model", 0] }),
  enlarged: node("SaveImage", { images: ["upscale", 0] }),
};
const workflow = (template = graph): WorkflowDefinition => ({
  id: "normal-plus-upscale", name: "Normal and enlarged", family: "Fixture", description: "", mode: "text-to-image",
  requiredInputs: [], optionalInputs: [], parameters: [], mapping: [], template: structuredClone(template),
  output: descriptor("normal"), additionalOutputs: [descriptor("enlarged")],
});
const asset = (id: string, kind: MediaKind = "image", width?: number, height?: number): Asset => ({
  id, name: id, kind, width, height, createdAt: 1, size: 1, mime: kind === "video" ? "video/mp4" : "image/png",
});
const downloaded = (assets: Asset[], files: Partial<RemoteFile>[] = []) => assets.map((result, index) => ({
  asset: result, file: { filename: result.name + ".png", type: "output" as const, ...files[index] },
}));

describe("published output priority", () => {
  it("selects the real same-source upscale branch without relying on name, node order or URL", () => {
    const definition = workflow(), before = structuredClone(definition);
    expect(compareOutputDescriptors(definition, descriptor("enlarged"), descriptor("normal"))).toBeLessThan(0);
    expect(selectPreferredOutputDescriptor(definition)).toEqual(descriptor("enlarged"));
    expect(selectPreferredOutputDescriptor(definition, [descriptor("enlarged"), descriptor("normal")])).toEqual(descriptor("enlarged"));
    expect(definition).toEqual(before);
  });

  it("does not mistake independent samplers sharing a model and latent for an upscale of each other", () => {
    const definition = workflow({ ...graph,
      secondSample: node("KSampler", { model: ["model", 0], latent_image: ["latent", 0] }),
      secondDecode: node("VAEDecode", { samples: ["secondSample", 0], vae: ["model", 2] }),
      upscale: node("ImageUpscaleWithModel", { image: ["secondDecode", 0], upscale_model: ["upscale_model", 0] }),
    });
    expect(compareOutputDescriptors(definition, descriptor("enlarged"), descriptor("normal"))).toBe(0);
    expect(selectPreferredOutputDescriptor(definition)).toEqual(descriptor("normal"));
  });

  it.each([0.5, 1])("does not call an explicit scale factor %s an enlargement", scale_by => {
    const definition = workflow({ ...graph, upscale: node("ImageScaleBy", { image: ["decode", 0], scale_by }) });
    expect(selectPreferredOutputDescriptor(definition)).toEqual(descriptor("normal"));
  });

  it("supports explicit ImageScaleBy enlargement and safely visits cycles", () => {
    const definition = workflow({ ...graph, upscale: node("ImageScaleBy", { image: ["decode", 0], scale_by: 2, passthrough: ["cycle", 0] }),
      cycle: node("Reroute", { input: ["upscale", 0] }) });
    expect(selectPreferredOutputDescriptor(definition)).toEqual(descriptor("enlarged"));
  });

  it("prioritizes decoded pixels over misleading labels and even graph upscale evidence", () => {
    const definition = workflow(), assets = [asset("Normal misleading HD name", "image", 768, 512), asset("Actually larger", "image", 3072, 2048)];
    const before = structuredClone(assets);
    const receipts = downloaded(assets, [{ sourceNodeId: "enlarged", width: 9000, height: 9000 }, { sourceNodeId: "normal" }]);
    expect(prioritizeOutputAssets(definition, assets, receipts).map(item => item.id)).toEqual(["Actually larger", "Normal misleading HD name"]);
    expect(assets).toEqual(before);
  });

  it("uses receipt dimensions when the decoded media has no dimensions", () => {
    const assets = [asset("a"), asset("b")];
    expect(prioritizeOutputAssets(workflow(), assets, downloaded(assets, [{ width: 512, height: 768 }, { width: 2048, height: 3072 }]))
      .map(item => item.id)).toEqual(["b", "a"]);
  });

  it("finds HD even when an unknown-size result occurs between normal and HD", () => {
    const assets = [asset("normal", "image", 512, 512), asset("unknown"), asset("hd", "image", 2048, 2048)];
    expect(prioritizeOutputAssets(workflow(), assets, downloaded(assets)).map(item => item.id)).toEqual(["hd", "normal", "unknown"]);
  });

  it("uses source lineage when sizes are absent, and otherwise preserves receipt order", () => {
    const assets = [asset("normal"), asset("enlarged"), asset("independent")];
    expect(prioritizeOutputAssets(workflow(), assets, downloaded(assets, [{ sourceNodeId: "normal" }, { sourceNodeId: "enlarged" }, {}]))
      .map(item => item.id)).toEqual(["enlarged", "normal", "independent"]);
    expect(prioritizeOutputAssets(workflow(), assets, downloaded(assets))).toEqual(assets);
  });

  it("keeps all independent results and mixed-kind contract slots for a generic file output", () => {
    const definition = workflow(); definition.output.kind = "file";
    const assets = [asset("normal", "image", 512, 512), asset("movie", "video", 1920, 1080), asset("hd", "image", 2048, 2048), asset("song", "audio"), asset("bundle", "file")];
    expect(prioritizeOutputAssets(definition, assets, downloaded(assets)).map(item => item.id)).toEqual(["hd", "movie", "normal", "song", "bundle"]);
  });

  it("does not replace a declared video result with a larger image poster", () => {
    const definition = workflow(); definition.output.kind = "video";
    const assets = [asset("poster", "image", 4096, 4096), asset("movie", "video", 1920, 1080)];
    expect(prioritizeOutputAssets(definition, assets, downloaded(assets)).map(item => item.id)).toEqual(["movie", "poster"]);
  });
});

describe("published output collection boundaries", () => {
  it("recovers an undeclared saved HD publisher from an older definition without collecting previews or processors", () => {
    const definition = workflow({ ...graph,
      preview: node("PreviewImage", { images: ["decode", 0] }),
      processor: node("CustomImageProcessor", { image: ["decode", 0] }),
      promptPreview: node("easy showAnything"),
    });
    definition.additionalOutputs = [];
    const before = structuredClone(definition);
    const result = collectWorkflowOutputs({ outputs: {
      normal: { images: [{ filename: "normal.png", type: "output" }] },
      enlarged: { files: [{ filename: "hd.png", type: "output", width: 3072, height: 2048 }] },
      preview: { images: [{ filename: "preview.png", type: "temp" }] },
      processor: { images: [{ filename: "intermediate.png", type: "output" }] },
      promptPreview: { images: [{ filename: "helper.png", type: "output" }] },
      unknown: { images: [{ filename: "outside-the-graph.png", type: "output" }] },
    } }, definition);
    expect(result.files.map(item => item.filename)).toEqual(["normal.png", "hd.png"]);
    expect(result.fileSources[outputKey(result.files[1])]).toEqual({ sourceNodeId: "enlarged", sourceField: "files" });
    expect(definition).toEqual(before);
  });

  it.each(["input", "missing", "preview-only", "unsafe"])("requires a generated same-node receipt before recovering an undeclared save publisher (%s)", condition => {
    const definition = workflow(); definition.additionalOutputs = [];
    const result = collectWorkflowOutputs({ outputs: {
      normal: { images: [{ filename: "normal.png", type: "output" }] },
      ...(condition === "missing" ? {} : { enlarged: condition === "preview-only"
        ? { poster: { filename: "poster.png", type: "temp" } }
        : { files: [{ filename: condition === "unsafe" ? "../private.png" : "input.png", type: condition === "input" ? "input" : "output" }] } }),
    } }, definition);
    expect(result.files.map(item => item.filename)).toEqual(["normal.png"]);
  });

  it("keeps explicit fields exclusive when another field on that same publisher was not selected", () => {
    const definition = workflow(); definition.additionalOutputs = [];
    delete definition.template!.enlarged;
    const result = collectWorkflowOutputs({ outputs: { normal: {
      images: [{ filename: "chosen.png", type: "output" }],
      unused: [{ filename: "unselected.png", type: "output" }],
    } } }, definition);
    expect(result.files.map(item => item.filename)).toEqual(["chosen.png"]);
  });

  it("collects every declared normal and HD output, excluding unrelated inputs and intermediate history", () => {
    const definition = workflow(), before = structuredClone(definition);
    const normal: RemoteFile = { filename: "normal.png", type: "output" }, hd: RemoteFile = { filename: "hd.png", type: "output" };
    const history = { outputs: {
      normal: { images: [normal] }, enlarged: { images: [hd] },
      decode: { images: [{ filename: "intermediate.png", type: "temp" }] },
      input: { images: [{ filename: "input.png", type: "input" }] },
    } };
    const result = collectWorkflowOutputs(history, definition);
    expect(result.files.map(item => item.filename)).toEqual(["normal.png", "hd.png"]);
    expect(result.fileSources[outputKey(normal)]).toEqual({ sourceNodeId: "normal", sourceField: "images" });
    expect(result.fileSources[outputKey(hd)]).toEqual({ sourceNodeId: "enlarged", sourceField: "images" });
    expect(definition).toEqual(before);
  });

  it("skips input storage mixed into a published field while retaining final temp outputs", () => {
    const definition = workflow(); definition.additionalOutputs = [];
    const result = collectWorkflowOutputs({ outputs: { normal: { images: [
      { filename: "uploaded.png", type: "input" }, { filename: "final.png", type: "temp" },
    ] } } }, definition);
    expect(result.files.map(item => item.filename)).toEqual(["final.png"]);
    expect(result.warnings).toEqual([expect.stringContaining("input 目录")]);
  });

  it("does not let a nested input receipt break valid automatic generated results", () => {
    const definition = workflow(); definition.output.field = "*"; definition.additionalOutputs = [];
    const result = collectWorkflowOutputs({ outputs: { normal: { result: [
      { filename: "uploaded.png", type: "input" }, { filename: "hd.png", type: "output" },
    ] } } }, definition);
    expect(result.files.map(item => item.filename)).toEqual(["hd.png"]);
    expect(result.fileSources[outputKey(result.files[0])]).toEqual({ sourceNodeId: "normal", sourceField: "result" });
  });

  it.each(["preview", "previews", "thumbnail", "thumbnails", "poster", "previewImages", "video_thumbnail"])("skips a publisher's %s subtree when actual generated media exists", previewField => {
    const definition = workflow(); definition.output.field = "*"; definition.additionalOutputs = [];
    const result = collectWorkflowOutputs({ outputs: { normal: {
      [previewField]: { filename: "large-poster.png", type: "temp", width: 8192, height: 8192 },
      generated: { images: [{ filename: "actual.png", type: "output", width: 2048, height: 2048 }] },
    } } }, definition);
    expect(result.files.map(item => item.filename)).toEqual(["actual.png"]);
    expect(result.warnings).toEqual([]);
  });

  it("keeps all real image and video results while skipping nested posters regardless of property order", () => {
    const definition = workflow(); definition.output = descriptor("normal", "file", "*"); definition.additionalOutputs = [];
    const result = collectWorkflowOutputs({ outputs: { normal: { result: [
      { thumbnail: { filename: "poster.png", type: "output" } },
      { images: [{ filename: "normal.png", type: "output" }, { filename: "hd.png", type: "output" }] },
      { videos: [{ filename: "finished.mp4", type: "output" }], previews: [{ filename: "preview.gif", type: "temp" }] },
    ] } } }, definition);
    expect(result.files.map(item => item.filename)).toEqual(["normal.png", "hd.png", "finished.mp4"]);
  });

  it("retains preview-only publisher media as a fallback", () => {
    const definition = workflow({ normal: node("PreviewImage") });
    definition.output.field = "*"; definition.additionalOutputs = [];
    const result = collectWorkflowOutputs({ outputs: { normal: {
      preview: { images: [{ filename: "only-preview.png", type: "temp" }] },
    } } }, definition);
    expect(result.files.map(item => item.filename)).toEqual(["only-preview.png"]);
    expect(result.warnings).toEqual([]);
  });

  it("retains preview fallback when the other file is an uploaded input", () => {
    const definition = workflow(); definition.output.field = "*"; definition.additionalOutputs = [];
    const result = collectWorkflowOutputs({ outputs: { normal: {
      images: [{ filename: "uploaded.png", type: "input" }],
      preview: { filename: "only-generated.png", type: "temp" },
    } } }, definition);
    expect(result.files.map(item => item.filename)).toEqual(["only-generated.png"]);
    expect(result.warnings).toHaveLength(1);
  });

  it("honors an explicit preview-field contract even when the same node also returns actual media", () => {
    const definition = workflow(); definition.output.field = "preview"; definition.additionalOutputs = [];
    const result = collectWorkflowOutputs({ outputs: { normal: {
      images: [{ filename: "actual.png", type: "output" }],
      preview: [{ filename: "chosen-preview.png", type: "temp" }],
    } } }, definition);
    expect(result.files.map(item => item.filename)).toEqual(["chosen-preview.png"]);
  });

  it("recognizes a duplicated actual file before deciding whether preview fallback is needed", () => {
    const definition = workflow(); definition.additionalOutputs = [descriptor("enlarged", "image", "*")];
    const file = { filename: "actual.png", type: "output" };
    const result = collectWorkflowOutputs({ outputs: {
      normal: { images: [file] }, enlarged: { poster: [{ filename: "poster.png", type: "temp" }], images: [file] },
    } }, definition);
    expect(result.files.map(item => item.filename)).toEqual(["actual.png"]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects legacy output bindings pointing at known material loaders", () => {
    const definition = workflow({ ...graph, input: node("VHS_LoadVideoPath") });
    definition.output = descriptor("input", "video"); definition.additionalOutputs = [];
    expect(() => collectWorkflowOutputs({ outputs: { input: { images: [{ filename: "source.mp4", type: "output" }] } } }, definition)).toThrow("素材加载节点");
  });

  it.each(["__rh_app_output", "fisherai_webapp_output"])("does not replace actual AI-app receipt provenance with virtual %s", nodeId => {
    const definition = workflow({ [nodeId]: node("RunningHubAppOutput") });
    definition.output = descriptor(nodeId); definition.additionalOutputs = [];
    const result = collectWorkflowOutputs({ outputs: { [nodeId]: { images: [
      { filename: "normal.png", type: "output", sourceNodeId: "9", sourceField: "images" },
      { filename: "hd.png", type: "output", sourceNodeId: "11", sourceField: "images" },
      { filename: "unknown.png", type: "output" },
    ] } } }, definition);
    expect(result.files.map(item => item.sourceNodeId)).toEqual(["9", "11", undefined]);
    expect(Object.values(result.fileSources)).toEqual([{ sourceNodeId: "9", sourceField: "images" }, { sourceNodeId: "11", sourceField: "images" }]);
  });

  it("keeps ambiguous RunningHub V1 files on their real publisher without guessing fields or losing either output", () => {
    const definition = workflow(); definition.runninghub = { workflowId: "123456789", baseUrl: "https://www.runninghub.cn" };
    definition.additionalOutputs = [descriptor("normal", "image", "upscaled")];
    const result = collectWorkflowOutputs({ outputs: { normal: { files: [
      { filename: "normal.png", type: "output", sourceNodeId: "normal" },
      { filename: "hd.png", type: "output", sourceNodeId: "normal", width: 2048, height: 2048 },
    ] } } }, definition);
    expect(result.files.map(item => item.filename)).toEqual(["normal.png", "hd.png"]);
    expect(Object.values(result.fileSources)).toEqual([{ sourceNodeId: "normal" }, { sourceNodeId: "normal" }]);
    expect(result.warnings).toHaveLength(1);
  });

  it("does not borrow files from an unrelated RunningHub node to satisfy missing declared fields", () => {
    const definition = workflow(); definition.runninghub = { workflowId: "123456789", baseUrl: "https://www.runninghub.cn" };
    definition.additionalOutputs = [descriptor("normal", "image", "upscaled")];
    expect(() => collectWorkflowOutputs({ outputs: { normal: { files: [{ filename: "source.png", type: "output", sourceNodeId: "input" }] } } }, definition)).toThrow("normal.images");
  });
});
