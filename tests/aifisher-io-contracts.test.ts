import { describe, expect, it } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import type { ApiWorkflow } from "../src/types";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";
import { aifisherImportAnalysis, buildAifisherImportPackage } from "../src/workflow/aifisher-import-adapter";
import { aifisherOutputPresentation } from "../src/workflow/aifisher-output-presentation";
import { analyzeRunningHubUpstream, buildRunningHubUpstream, type RunningHubReaderResult } from "../src/runninghub/upstream-reader";
import { prepareRunningHubApp, prepareRunningHubWorkflowCandidates } from "../src/runninghub/workflows";

const node = (class_type: string, inputs: Record<string, unknown> = {}) => ({ class_type, inputs });
const read = async (source: ApiWorkflow, objectInfo?: Record<string, unknown>) =>
  await readAIFisherWorkflow({ environment: "comfyui", source, objectInfo }) as AifisherWorkflowReadResult;
const options = { workflowId: "42", baseUrl: "https://www.runninghub.cn", name: "Ports", id: "fixture" };

describe("canvas ports use execution contracts instead of incidental node names", () => {
  it("keeps every normal and HD publisher, excluding schema-proven internal nodes and auxiliary previews", async () => {
    const graph = { source: node("Generator"), normal: node("SaveImage", { images: ["source", 0] }),
      upscale: node("ImageScale", { image: ["source", 0] }), hd: node("SaveImage", { images: ["upscale", 0] }),
      internal: node("LatentOutputRouter", { samples: ["source", 0] }), preview: node("PreviewImage", { images: ["source", 0] }),
      extension: node("CustomPublisher", { image: ["upscale", 0] }) };
    const before = structuredClone(graph), result = await read(graph, {
      LatentOutputRouter: { input: { required: { samples: ["LATENT"] } }, output: ["LATENT"], output_node: false },
      CustomPublisher: { input: { required: { image: ["IMAGE"] } }, output: [], output_node: true },
    });
    expect(result.analysis.candidateOutputs.map(item => item.nodeId)).toContain("internal");
    const prepared = buildAifisherImportPackage(result, "fixture", "Image workflow");
    expect(prepared.analysis.outputs.map(item => item.nodeId).sort()).toEqual(["extension", "hd", "normal"]);
    expect((prepared.config.execution as { outputs: { nodeId: string }[] }).outputs.map(item => item.nodeId).sort()).toEqual(["extension", "hd", "normal"]);
    expect(prepared.graph).toEqual(before); expect(result.workflow).toEqual(before); expect(graph).toEqual(before);
  });

  it("preserves schema-free unknown publishers, known save contracts with partial metadata and preview-only workflows", async () => {
    const unknown = await read({ custom: node("CommunitySaveVideoV9"), saved: node("SaveImage") }, {
      SaveImage: { input: {}, output: [], output_node: false },
    });
    expect(aifisherOutputPresentation(unknown).outputs.map(item => item.nodeId)).toEqual(["custom", "saved"]);
    expect(aifisherOutputPresentation(await read({ preview: node("PreviewImage") })).outputs.map(item => item.nodeId)).toEqual(["preview"]);
  });

  it("lets verified receipts retain real output from a custom or preview node despite incomplete static metadata", async () => {
    const result = await read({ internal: node("CustomOutput"), preview: node("PreviewImage"), saved: node("SaveImage") }, {
      CustomOutput: { input: {}, output: ["MODEL"], output_node: false },
    });
    result.outputEvidence.state = "verified";
    result.outputEvidence.outputs = [{ nodeId: "internal", mediaKind: "image" }, { nodeId: "preview", mediaKind: "image" }];
    expect(aifisherOutputPresentation(result).outputs.map(item => item.nodeId)).toEqual(["internal", "preview", "saved"]);
  });

  it("recovers an actual custom output absent from static candidates without fabricating a graph node", async () => {
    const graph = { generator: node("Generator"), custom: node("CommunityExporter", { source: ["generator", 0] }) };
    const result = await read(graph);
    expect(result.outputEvidence.candidateNodes).toEqual([]);
    result.outputEvidence.state = "verified";
    result.outputEvidence.outputs = [{ nodeId: "custom", mediaKind: "video", outputKey: "files" }];
    expect(aifisherOutputPresentation(result)).toMatchObject({ kind: "video", outputs: [{ nodeId: "custom", field: "*", kind: "video" }] });
    expect(result.workflow).toEqual(graph);
  });

  it("exposes writable loader fields, not media tensor sockets, connected values or loader scalar settings", async () => {
    const graph = { uploaded: node("CustomSource", { media: "sample.png", rate: 24 }),
      loader: node("LoadImage", { image: "sample.png" }),
      processor: node("ImageProcess", { image: "invalid stale sample", audio: "stale.wav" }),
      connected: node("ImageProcess", { image: ["loader", 0] }), saved: node("SaveImage", { images: ["connected", 0] }) };
    const before = structuredClone(graph), result = await read(graph, {
      CustomSource: { input: { required: { media: ["STRING", { image_upload: true }], rate: ["INT"] } }, output: ["IMAGE"], output_node: false },
      LoadImage: { input: { required: { image: [["sample.png"], { image_upload: true }] } }, output: ["IMAGE"], output_node: false },
      ImageProcess: { input: { required: { image: ["IMAGE"] }, optional: { audio: ["AUDIO"] } }, output: ["IMAGE"], output_node: false },
    });
    expect(result.analysis.candidateBindings.filter(item => item.nodeId === "processor").map(item => item.control)).toEqual(["asset", "asset"]);
    expect(aifisherImportAnalysis(result).inputs.map(item => [item.nodeId, item.field]).sort()).toEqual([["loader", "image"], ["uploaded", "media"]]);
    const prepared = buildAifisherImportPackage(result, "fixture", "Tensor sockets");
    expect((prepared.config.parameters as { binding: { nodeId: string } }[]).some(parameter => parameter.binding.nodeId === "processor")).toBe(false);
    expect(result.workflow).toEqual(before); expect(graph).toEqual(before);
  });

  it("keeps all RunningHub AI app published media fields even though its projection uses media socket types", async () => {
    const raw = { appName: "Public app", nodeInfoList: [
      { nodeId: "1", fieldName: "prompt", fieldType: "STRING", fieldValue: "" },
      { nodeId: "2", fieldName: "reference", fieldType: "IMAGE", fieldValue: "" },
      { nodeId: "3", fieldName: "motion", fieldType: "VIDEO", fieldValue: "" },
      { nodeId: "4", fieldName: "sound", fieldType: "AUDIO", fieldValue: "" },
    ] };
    const result = await readAIFisherWorkflow({ environment: "runninghub-webapp", remoteId: "42", source: raw }) as unknown as RunningHubReaderResult;
    expect(analyzeRunningHubUpstream(result).inputs.map(item => item.kind)).toEqual(["image", "video", "audio"]);
    const app = { apiVersion: "v1" as const, reader: result, nodeInfoList: raw.nodeInfoList };
    expect(prepareRunningHubApp(app, options).workflow.inputSlots?.map(item => item.kind)).toEqual(["image", "video", "audio"]);
  });

  it("keeps both RunningHub save nodes and rejects bindings to an unrelated existing graph node", async () => {
    const graph = { loader: node("LoadImage", { image: "sample.png" }), processor: node("ImageScale", { image: ["loader", 0], width: 2048 }),
      normal: node("SaveImage", { images: ["loader", 0] }), hd: node("SaveImage", { images: ["processor", 0] }) };
    const result = await readAIFisherWorkflow({ environment: "runninghub-workflow", source: graph }) as unknown as RunningHubReaderResult;
    const prepared = prepareRunningHubWorkflowCandidates(graph, { ...options, reader: result }).workflow;
    expect([prepared.output, ...(prepared.additionalOutputs ?? [])].map(item => item.nodeId).sort()).toEqual(["hd", "normal"]);
    expect(() => buildRunningHubUpstream(result, { ...options, outputs: [{ nodeId: "processor", field: "images", kind: "image" }] })).toThrow("输出绑定");
    expect(() => buildRunningHubUpstream(result, { ...options, mediaInputs: [{ nodeId: "processor", field: "width", kind: "image" }] })).toThrow("外部素材输入合同");
    expect(result.workflow).toEqual(graph);
  });
});
