import { describe, expect, it } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { buildAifisherImportPackage } from "../src/workflow/aifisher-import-adapter";
import { aifisherOutputPresentation } from "../src/workflow/aifisher-output-presentation";
import { convertLibraryWorkflow } from "../src/workflow/library-converter";
import { collectWorkflowOutputs } from "../src/comfyui/client";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";
import type { ApiWorkflow } from "../src/types";

const sink = (type: string, inputs: Record<string, unknown> = {}) => ({ class_type: type, inputs });
const reader = async (source: ApiWorkflow, objectInfo?: Record<string, unknown>) =>
  await readAIFisherWorkflow({ environment: "comfyui", source, objectInfo }) as AifisherWorkflowReadResult;

describe("AIFISHER output presentation, independent of graph conversion", () => {
  it("uses the Qwen image save contract while keeping auxiliary previews only in the unchanged source", async () => {
    const source = {
      "413": sink("Image Comparer (rgthree)", { image_a: ["426", 0] }),
      "414": sink("PreviewImage", { images: ["426", 0] }),
      "426": sink("VAEDecode"),
      "470": sink("SaveImage", { images: ["426", 0], filename_prefix: "keep-me" }),
      "496": sink("PreviewAny", { source: ["494", 0] }),
      "494": sink("CR Prompt Text", { prompt: "LTX video is merely prompt text" }),
    };
    const original = structuredClone(source);
    const read = await reader(source, { "Image Comparer (rgthree)": { input: { optional: { image_a: ["IMAGE"] } }, output: [], output_node: true } });
    const prepared = buildAifisherImportPackage(read, "custom.image", "Misleading video title");
    expect(prepared.config).toMatchObject({ nodeKind: "image", primaryCategoryLabel: "图像工作流", execution: { output: { nodeId: "470", field: "*", kind: "image" } } });
    expect(prepared.analysis.outputs).toEqual([
      expect.objectContaining({ nodeId: "470", kind: "image", field: "*" }),
    ]);
    expect(read.outputEvidence.candidateNodes.map(item => item.nodeId)).toEqual(["413", "414", "470", "496"]);
    expect(prepared.graph).toEqual(original);
    expect(source).toEqual(original);
    expect(read.workflow).toEqual(original);
    const definition = convertLibraryWorkflow(prepared.config, prepared.graph, prepared.requirements,
      { sourcePath: "fixture", folder: "qwen", configSha256: "config", executionSha256: "graph", executionStatus: "plain" });
    expect(definition.output).toMatchObject({ nodeId: "470", kind: "image", field: "*" });
    expect([definition.output, ...(definition.additionalOutputs ?? [])].map(output => output.nodeId)).toEqual(["470"]);
    expect(definition.template).toEqual(original);
  });

  it.each(["SaveVideo", "VHS_VideoCombine"])("uses %s's video contract despite an image preview", async classType => {
    const read = await reader({ first: sink("PreviewImage"), final: sink(classType), text: sink("PreviewAny") });
    const projected = aifisherOutputPresentation(read);
    expect(projected).toMatchObject({ kind: "video", primary: { nodeId: "final", kind: "video", field: "*" } });
    expect(projected.outputs).toHaveLength(1);
    expect(read.outputEvidence.candidateNodes).toHaveLength(3);
  });

  it.each(["SaveAudio", "SaveAudioMP3", "SaveAudioAdvanced"])("recognizes %s's audio output", async classType => {
    expect(aifisherOutputPresentation(await reader({ output: sink(classType) }))).toMatchObject({ kind: "audio", categoryLabel: "音频工作流" });
  });

  it("classifies MiniMax by its saved video instead of model-preview and group-control helpers", async () => {
    const source = { "148": sink("VHS_VideoCombine"), "150": sink("ModelPreviewOverrideKJ"), "200": sink("忽略多组孤海") };
    const read = await reader(source, {
      ModelPreviewOverrideKJ: { input: {}, output: ["MODEL"], output_node: false },
      "忽略多组孤海": { input: { required: {} }, output: [], output_node: true },
    });
    const prepared = buildAifisherImportPackage(read, "custom.minimax", "MiniMax");
    expect(prepared.config).toMatchObject({ nodeKind: "video", primaryCategoryLabel: "视频工作流", execution: { output: { nodeId: "148", field: "*", kind: "video" } } });
    expect(prepared.analysis.outputs.map(item => item.nodeId)).toEqual(["148"]);
    expect(read.outputEvidence.candidateNodes.map(item => item.nodeId)).toEqual(["148", "150", "200"]);
    expect(prepared.graph).toEqual(source);
    read.outputEvidence.state = "verified";
    read.outputEvidence.outputs = [{ nodeId: "200", mediaKind: "image" }];
    expect(aifisherOutputPresentation(read).kind).toBe("file");
  });

  it("keeps an unknown publisher unresolved even if it accepts images or advertises an IMAGE socket", async () => {
    const read = await reader({ output: sink("MySaveVideoFromImages", { images: "not a result" }) }, {
      MySaveVideoFromImages: { output_node: true, input: { required: { images: ["IMAGE"] } }, output: ["IMAGE"] },
    });
    expect(aifisherOutputPresentation(read)).toMatchObject({ kind: "file", outputs: [{ nodeId: "output", kind: "file", field: "*", needsBinding: true }] });
  });

  it("does not silently discard a second saved media kind or unknown output", async () => {
    const mixed = aifisherOutputPresentation(await reader({ image: sink("SaveImage"), video: sink("SaveVideo") }));
    expect(mixed.kind).toBe("file"); expect(mixed.outputs.map(item => item.kind)).toEqual(["image", "video"]);
    const unknown = aifisherOutputPresentation(await reader({ image: sink("SaveImage"), other: sink("CustomExport") }, {
      CustomExport: { input: {}, output: [], output_node: true },
    }));
    expect(unknown.kind).toBe("file"); expect(unknown.outputs).toHaveLength(2);
  });

  it("loads a mixed image/video package and keeps the real result media kinds", async () => {
    const source = { image: sink("SaveImage"), video: sink("SaveVideo") };
    const read = await reader(source);
    const prepared = buildAifisherImportPackage(read, "custom.mixed", "Mixed outputs");
    const definition = convertLibraryWorkflow(prepared.config, prepared.graph, prepared.requirements,
      { sourcePath: "fixture", folder: "mixed", configSha256: "config", executionSha256: "graph", executionStatus: "plain" });
    expect(definition.output.kind).toBe("file");
    expect([definition.output, ...(definition.additionalOutputs ?? [])].map(output => output.nodeId)).toEqual(["image", "video"]);
    expect(definition.template).toEqual(source);
    const actual = collectWorkflowOutputs({ outputs: {
      image: { images: [{ filename: "result.png", subfolder: "", type: "output" }] },
      video: { images: [{ filename: "result.mp4", subfolder: "", type: "output" }] },
    } }, definition);
    expect(actual.files.map(file => file.filename)).toEqual(["result.png", "result.mp4"]);
    expect(Object.values(actual.fileKinds)).toEqual(["image", "video"]);
  });

  it("lets verified receipt media override a presentation contract without narrowing collection fields", async () => {
    const read = await reader({ output: sink("SaveImage") });
    read.outputEvidence.state = "verified";
    read.outputEvidence.outputs = [{ nodeId: "output", mediaKind: "video", outputKey: "alternate_result" }];
    expect(aifisherOutputPresentation(read)).toMatchObject({ kind: "video", outputs: [{ nodeId: "output", kind: "video", field: "*" }] });
    read.outputEvidence.outputs.push({ nodeId: "output", mediaKind: "image" });
    expect(aifisherOutputPresentation(read).kind).toBe("file");
  });
});
