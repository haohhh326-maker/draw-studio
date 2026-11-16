import { describe, expect, it } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import type { AifisherBindingCandidate, AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";
import { buildImportEnvironmentDiagnostics, readImportEnvironmentReport, withImportEnvironmentCapabilities } from "../src/workflow/import-environment-diagnostics";

const candidate = (value: Partial<AifisherBindingCandidate>): AifisherBindingCandidate => ({
  id: "candidate", nodeId: "1", classType: "Loader", nodeTitle: "作者的节点", fieldName: "unet_name", value: "original.safetensors",
  valueType: "COMBO", required: true, connected: false, control: "select", mediaKind: null, modelKind: "diffusionModels",
  options: ["cloud.safetensors"], minimum: null, maximum: null, step: null, ...value,
});
function fixture(overrides: Partial<AifisherWorkflowReadResult> = {}): AifisherWorkflowReadResult {
  return { environment: "comfyui", upstream: { repository: "upstream", revision: "pinned" }, format: "comfy-api", workflow: {},
    analysis: { format: "comfy-api", compileStatus: "ready", nodeCount: 0, linkCount: 0, candidateBindings: [], candidateOutputs: [], warnings: [], requirements: { models: [], nodeTypes: [] } },
    bindingCandidates: [], outputEvidence: { state: "unresolved", candidateNodes: [], outputs: [] }, ...overrides };
}

describe("readable cloud import evidence", () => {
  it("checks models and node structure without checking sample media filenames", async () => {
    const graph = {
      "127": { class_type: "UNETLoader", _meta: { title: "主扩散模型" }, inputs: { unet_name: "author/unet.safetensors" } },
      "145": { class_type: "LoraLoader", inputs: { lora_name: "author/lora-one.safetensors" } },
      "148": { class_type: "Sampler", inputs: { no_preview: true } },
      "150": { class_type: "PreviewSettings", inputs: { tiny_vae: "author-setting" } },
      "166": { class_type: "LoraLoader", inputs: { lora_name: "author/lora-two.safetensors" } },
      "188": { class_type: "LoadImage", inputs: { image: "author-one.png" } },
      "199": { class_type: "LoadImage", inputs: { image: "author-two.png" } },
      "200": { class_type: "忽略多组孤海", _meta: { title: "作者的开关" }, inputs: {} },
      "511": { class_type: "LoadImage", inputs: { image: "author-three.png" } },
    };
    const objectInfo = {
      UNETLoader: { input: { required: { unet_name: [["cloud/unet.safetensors"]] } }, output: ["MODEL"] },
      LoraLoader: { input: { required: { lora_name: [["cloud/lora.safetensors"]] } }, output: ["MODEL"] },
      Sampler: { input: { required: {} }, output: [] },
      PreviewSettings: { input: { required: { tiny_vae: [["none", "taesd"]] } }, output: [] },
      LoadImage: { input: { required: { image: [["cloud.png"], { image_upload: true }] } }, output: ["IMAGE"] },
    };
    const read = await readAIFisherWorkflow({ environment: "comfyui", source: graph, objectInfo }) as AifisherWorkflowReadResult;
    const original = JSON.stringify(read), report = buildImportEnvironmentDiagnostics(read);
    expect(report.counts.byCategory).toMatchObject({ "model-unavailable": 3, "asset-unavailable": 0, "option-mismatch": 1, "schema-mismatch": 1, "missing-node": 1 });
    expect(report.issues.some(issue => ["188", "199", "511"].includes(issue.nodeId ?? ""))).toBe(false);
    expect(JSON.stringify(report)).not.toContain("author-one.png");
    expect(report.issues.find(issue => issue.nodeId === "127")).toMatchObject({ nodeTitle: "主扩散模型", classType: "UNETLoader", field: "unet_name", actualValue: "author/unet.safetensors", allowedValues: ["cloud/unet.safetensors"] });
    expect(report.issues.find(issue => issue.nodeId === "150")?.category).toBe("option-mismatch");
    expect(report.issues.find(issue => issue.nodeId === "148")?.message).toContain("插件版本");
    expect(report.issues.find(issue => issue.nodeId === "200")).toMatchObject({ nodeTitle: "作者的开关", classType: "忽略多组孤海" });
    expect(report.hasBlockingIssues).toBe(true);
    expect(JSON.stringify(read)).toBe(original);
  });

  it("does not turn a requirement inventory or a ready compilation into verified availability", () => {
    const read = fixture();
    read.analysis.requirements.models = [{ type: "unet", name: "listed.safetensors" }];
    const report = buildImportEnvironmentDiagnostics(read);
    expect(report.issues).toEqual([]);
    expect(report.status).toBe("not-verified");
    expect(report.summary).toContain("实际验证");
    expect(report.capabilities).toBe("unavailable");
    const cached = withImportEnvironmentCapabilities(report, "cached");
    expect(cached.summary).toContain("缓存");
    expect(cached.summary).toContain("仅供补齐参考");
    expect(cached.capabilities).toBe("cached");
    expect(report.capabilities).toBe("unavailable");
    expect(withImportEnvironmentCapabilities(report, "live").summary).toContain("实时节点定义");
  });

  it("skips image/video/audio filenames while retaining missing ports and model option checks", () => {
    const read = fixture({ bindingCandidates: [
      candidate({ nodeId: "v", fieldName: "clip", control: "asset", mediaKind: "video", modelKind: null, value: "sample.mp4" }),
      candidate({ nodeId: "a", fieldName: "clip", control: "asset", mediaKind: "audio", modelKind: null, value: "sample.wav" }),
      candidate({}),
    ] });
    read.analysis.warnings = [
      { code: "INVALID_INPUT_VALUE", nodeId: "v", fieldName: "clip" },
      { code: "INVALID_INPUT_VALUE", nodeId: "a", fieldName: "clip" },
      { code: "MISSING_REQUIRED_INPUT", nodeId: "v", fieldName: "clip" },
      { code: "INVALID_INPUT_VALUE", nodeId: "1", fieldName: "unet_name" },
    ];
    const report = buildImportEnvironmentDiagnostics(read);
    expect(report.issues.map(issue => issue.code)).toEqual(["MISSING_REQUIRED_INPUT", "INVALID_INPUT_VALUE"]);
    expect(report.issues[1].category).toBe("model-unavailable");
  });

  it("prefers named graph values and preserves authored values and cloud lists", () => {
    const read = fixture({ workflow: { "1": { class_type: "Loader", inputs: { unet_name: "graph.safetensors" } } }, bindingCandidates: [candidate({ value: "candidate.safetensors" })] });
    read.analysis.warnings = [{ code: "INVALID_INPUT_VALUE", nodeId: "1", fieldName: "unet_name" }];
    const report = buildImportEnvironmentDiagnostics(read, { source: { "1": { class_type: "Loader", inputs: { unet_name: "source.safetensors" } } } });
    expect(report.issues[0].actualValue).toBe("graph.safetensors");
    expect(read.bindingCandidates[0].options).toEqual(["cloud.safetensors"]);
  });

  it("enriches an unconverted UI node without guessing positional widget values", () => {
    const read = fixture({ workflow: null });
    read.analysis.compileStatus = "needs-confirmation";
    read.analysis.warnings = [{ code: "AMBIGUOUS_WIDGET_MAPPING", nodeId: "1", fieldName: "tiny_vae" }];
    const report = buildImportEnvironmentDiagnostics(read, { source: { nodes: [{ id: 1, type: "PreviewSettings", title: "原图标题", widgets_values: ["some-value"] }] } });
    expect(report.issues[0]).toMatchObject({ nodeTitle: "原图标题", classType: "PreviewSettings", valueStatus: "unavailable" });
    expect(report.issues[0]).not.toHaveProperty("actualValue");
    const named = buildImportEnvironmentDiagnostics(read, { source: { nodes: [{ id: 1, type: "PreviewSettings", widgets_values: { tiny_vae: "some-value" } }] } });
    expect(named.issues[0].actualValue).toBe("some-value");
  });

  it("reads legal dynamic combo inputs without false limitations and retains real range errors", async () => {
    const graph = { "165": { class_type: "DynamicSampler", inputs: { selection: "tau", "selection.tau": 0.6 } } };
    const objectInfo = { DynamicSampler: { input: { required: { selection: ["COMFY_DYNAMICCOMBO_V3", {
      options: [{ key: "tau", inputs: { required: { tau: ["FLOAT", { min: 0, max: 1 }] } } }],
    }] } }, output: [] } };
    const read = await readAIFisherWorkflow({ environment: "comfyui", source: graph, objectInfo }) as AifisherWorkflowReadResult;
    expect(read.analysis.warnings).toEqual([]);
    const report = buildImportEnvironmentDiagnostics(read, { objectInfo });
    expect(report.issues).toEqual([]);
    expect(read.bindingCandidates.find(candidate => candidate.fieldName === "selection")?.options).toEqual(["tau"]);
    expect(read.bindingCandidates.find(candidate => candidate.fieldName === "selection.tau")).toMatchObject({ value: 0.6, minimum: 0, maximum: 1 });
    graph["165"].inputs["selection.tau"] = 9;
    const invalid = await readAIFisherWorkflow({ environment: "comfyui", source: graph, objectInfo }) as AifisherWorkflowReadResult;
    expect(buildImportEnvironmentDiagnostics(invalid).issues.find(issue => issue.field === "selection.tau")?.category).toBe("option-mismatch");
  });

  it("reports dynamic assets as an application execution limitation ahead of environment issues", () => {
    const read = fixture({ bindingCandidates: [candidate({ nodeId: "136", classType: "MiniMaxH3ReferenceToVideo", fieldName: "ref_images", value: undefined, valueType: "ASSET_GROUP", modelKind: null, control: "asset", mediaKind: "image", variableAssetGroup: { branches: [] } })] });
    read.analysis.warnings = [{ code: "MISSING_NODE_TYPE", nodeId: "200", classType: "PrivateSwitch" }];
    const report = buildImportEnvironmentDiagnostics(read);
    expect(report.groups[0].category).toBe("unsupported");
    expect(report.issues.find(issue => issue.nodeId === "136")).toMatchObject({ field: "ref_images", category: "unsupported", code: "aifisher-variable-asset-runtime-required" });
    expect(report.summary).toContain("1 项属于当前应用尚不支持");
    expect(report.issues.find(issue => issue.nodeId === "136")?.action).toContain("补模型或安装节点不能解决");
  });

  it("never echoes credential values, linked credential primitives, prompt values or arbitrary warning details", () => {
    const secret = "AUTH-SECRET-DO-NOT-SHOW", prompt = "PRIVATE-PROMPT-DO-NOT-SHOW";
    const read = fixture({ workflow: {
      "1": { class_type: "PrimitiveString", inputs: { value: secret } },
      "2": { class_type: "RemoteGenerator", inputs: { api_key: ["1", 0], prompt, model_name: secret + ".safetensors" } },
    }, bindingCandidates: [candidate({ nodeId: "1", classType: "PrimitiveString", fieldName: "value", value: secret, modelKind: null }), candidate({ nodeId: "2", fieldName: "prompt", value: prompt, options: [prompt], modelKind: null })] });
    read.analysis.warnings = [
      { code: "INVALID_INPUT_VALUE", nodeId: "1", fieldName: "value", arbitraryRequestEcho: secret },
      { code: "INVALID_INPUT_VALUE", nodeId: "2", fieldName: "prompt" },
      { code: "INVALID_INPUT_VALUE", nodeId: "2", fieldName: "model_name" },
    ];
    const report = buildImportEnvironmentDiagnostics(read), text = JSON.stringify(report);
    expect(text).not.toContain(secret); expect(text).not.toContain(prompt); expect(text).not.toContain("arbitraryRequestEcho");
    expect(report.issues[0].valueStatus).toBe("redacted"); expect(report.issues[1].valueStatus).toBe("redacted");
    expect(report.issues[1]).not.toHaveProperty("allowedValues");
  });

  it("keeps an incomplete compile explicit even if the reader reports no warnings", () => {
    const read = fixture(); read.analysis.compileStatus = "needs-runtime-capabilities";
    expect(buildImportEnvironmentDiagnostics(read).issues[0].code).toBe("AIFISHER_COMPILE_INCOMPLETE");
  });

  it("hides prompt primitive values even when the warned field is named value", () => {
    const read = fixture({ workflow: {
      "1": { class_type: "PrimitiveStringMultiline", inputs: { value: "PRIVATE-PROMPT" } },
      "2": { class_type: "Generator", inputs: { prompt: ["1", 0] } },
    } });
    read.analysis.warnings = [{ code: "INVALID_INPUT_VALUE", nodeId: "1", fieldName: "value" }];
    const report = buildImportEnvironmentDiagnostics(read);
    expect(report.issues[0].valueStatus).toBe("redacted");
    expect(JSON.stringify(report)).not.toContain("PRIVATE-PROMPT");
  });
});

describe("persisted environment reports", () => {
  const report = () => {
    const read = fixture({ bindingCandidates: [candidate({})] });
    read.analysis.warnings = [{ code: "INVALID_INPUT_VALUE", nodeId: "1", fieldName: "unet_name" }];
    return buildImportEnvironmentDiagnostics(read);
  };
  it("rebuilds every summary and count and permits no verified status", () => {
    const original = report(), stored = { ...original, status: "verified", summary: "all good", counts: {}, groups: [], hasBlockingIssues: false };
    expect(readImportEnvironmentReport(stored)).toEqual(original);
    expect(readImportEnvironmentReport({ ...stored, version: 2 })).toBeUndefined();
    expect(readImportEnvironmentReport({ ...stored, capabilities: "verified" })).toBeUndefined();
    expect(readImportEnvironmentReport(withImportEnvironmentCapabilities(original, "cached"))?.capabilities).toBe("cached");
  });
  it("rejects object values, oversized data and invalid categories or severity", () => {
    const original = report();
    for (const patch of [{ actualValue: {} }, { allowedValues: [{}] }, { category: "verified" }, { severity: "success" }, { message: "x".repeat(8193) }, { code: "<script>" }])
      expect(readImportEnvironmentReport({ ...original, issues: [{ ...original.issues[0], ...patch }] })).toBeUndefined();
    expect(readImportEnvironmentReport({ ...original, issues: Array(1001).fill(original.issues[0]) })).toBeUndefined();
  });
  it("reapplies field-based redaction and drops unknown stored properties", () => {
    const original = report(), secret = "PRIVATE-KEY";
    const parsed = readImportEnvironmentReport({ ...original, issues: [{ ...original.issues[0], field: "api_key", actualValue: secret, allowedValues: [secret], rawRequest: secret }] });
    expect(parsed?.issues[0].valueStatus).toBe("redacted");
    expect(JSON.stringify(parsed)).not.toContain(secret);
    expect(JSON.stringify(parsed)).not.toContain("rawRequest");
  });
  it("does not restore sample-file warnings from previously saved reports", () => {
    const original = report();
    const stored = { ...original, issues: [...original.issues, { ...original.issues[0], category: "asset-unavailable", nodeId: "188", actualValue: "sample.png" }] };
    const restored = readImportEnvironmentReport(stored)!;
    expect(restored.issues).toEqual(original.issues);
    expect(JSON.stringify(restored)).not.toContain("sample.png");
    expect(restored.counts.byCategory["asset-unavailable"]).toBe(0);
  });
});
