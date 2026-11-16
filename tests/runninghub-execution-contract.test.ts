import { describe, expect, it } from "vitest";
import type { ApiWorkflow, WorkflowDefinition } from "../src/types";
import type { RunningHubAiApp } from "../src/runninghub/client";
import { attachRunningHubExecutionContract, rebindRunningHubExecutionContract, sameRunningHubExecutionSource, validateRunningHubExecutionGraph, validateRunningHubPublicSchema, validateRunningHubRemoteWorkflow } from "../src/runninghub/execution-contract";
import { prepareRunningHubWorkflow } from "../src/runninghub/workflows";
import { selectWorkflowOutput } from "../src/workflow/execution";
import { withLoraParameters } from "../src/workflow/lora-parameters";
import { withRunningHubWorkflowReader } from "./runninghub-test-reader";

const graph = (): ApiWorkflow => ({
  "1": { class_type: "Generate", inputs: { prompt: "Original example", seed: 4, enabled: true, provider_api_key: "author-example-key" } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "output" } },
  "3": { class_type: "SecondaryBranch", inputs: { strength: 0.75, details: { mode: "preserve", stages: [1, 2] } } },
  "4": { class_type: "PreviewImage", inputs: { images: ["3", 0] } },
});
const definition = (): WorkflowDefinition => ({
  id: "rh.contract", name: "Saved workflow", description: "", family: "Synthetic", mode: "text-to-image",
  requiredInputs: [], optionalInputs: [],
  parameters: [{ key: "seed", label: "Seed", type: "number", default: 4 }],
  mapping: [{ semantic: "prompt", nodeId: "1", field: "prompt" }, { semantic: "seed", nodeId: "1", field: "seed" }],
  output: { nodeId: "2", field: "images", kind: "image" }, template: graph(),
  runninghub: { workflowId: "123456789", baseUrl: "https://www.runninghub.cn" },
});
const app = (): RunningHubAiApp => ({ apiVersion: "v1", name: "Published title", nodeInfoList: [
  { nodeId: "1", fieldName: "prompt", fieldType: "STRING", fieldValue: "Author prompt", nodeName: "Title", description: "Prompt", required: true, fieldData: '["STRING",{"default":"Author prompt","multiline":true}]' },
  { nodeId: "1", fieldName: "seed", fieldType: "INT", fieldValue: 4, min: 0, max: 100, step: 1 },
  { nodeId: "1", fieldName: "ratio", fieldType: "LIST", fieldValue: "wide", fieldData: [{ index: "wide", name: "16:9" }, { index: "square", name: "1:1" }] },
  { nodeId: "1", fieldName: "reference", fieldType: "IMAGE", fieldValue: "author-image.png", required: false, mediaEmptyValue: null },
] });
function appDefinition(): WorkflowDefinition {
  const result = definition();
  result.runninghub = { ...result.runninghub!, kind: "app", mediaInputs: [{ nodeId: "1", field: "reference", required: false, emptyValue: null }] };
  result.template!["1"].inputs = { prompt: "Author prompt", seed: 4, ratio: "wide", reference: null };
  result.mapping.push({ semantic: "reference", nodeId: "1", field: "reference" });
  return result;
}
function mediaDefinition(): WorkflowDefinition {
  const result = definition();
  result.template!["5"] = { class_type: "LoadImage", inputs: { image: "" } };
  result.template!["6"] = { class_type: "LoadAudio", inputs: { audio: "" } };
  result.mapping.push({ semantic: "images", nodeId: "5", field: "image", index: 0 }, { semantic: "audio", nodeId: "6", field: "audio" });
  result.inputSlots = [{ semantic: "images", kind: "image", required: false, label: "Image" }, { semantic: "audio", kind: "audio", required: false, label: "Audio" }];
  result.optionalInputs = ["images", "audio"];
  result.mediaInputMode = "explicit";
  result.runninghub!.mediaInputs = [{ nodeId: "5", field: "image", required: false, emptyValue: "" }, { nodeId: "6", field: "audio", required: false, emptyValue: "" }];
  return result;
}

describe("RunningHub local execution contracts", () => {
  it("keeps old binding hashes compatible and signs selected submission semantics only when opted in", async () => {
    const legacy = await attachRunningHubExecutionContract(definition()), legacyOverride = structuredClone(legacy);
    legacyOverride.runninghub!.includeWorkflowJson = false;
    await expect(validateRunningHubExecutionGraph(legacyOverride)).resolves.toBeUndefined();
    expect(sameRunningHubExecutionSource(legacy, legacyOverride)).toBe(true);
    const selected = structuredClone(legacy); selected.runninghub!.bindingMode = "selected";
    await expect(validateRunningHubExecutionGraph(selected)).rejects.toThrow("执行图或绑定发生变化");
    const rebound = await rebindRunningHubExecutionContract(selected, legacy);
    await expect(validateRunningHubExecutionGraph(rebound)).resolves.toBeUndefined();
    expect(rebound.runninghub!.executionContract!.bindingHash).not.toBe(legacy.runninghub!.executionContract!.bindingHash);
    const changed = structuredClone(rebound); changed.runninghub!.includeWorkflowJson = true;
    await expect(validateRunningHubExecutionGraph(changed)).rejects.toThrow("执行图或绑定发生变化");
    expect(sameRunningHubExecutionSource(rebound, changed)).toBe(false);
    const missingHash = structuredClone(rebound); delete missingHash.runninghub!.executionContract!.bindingHash;
    await expect(validateRunningHubExecutionGraph(missingHash)).rejects.toThrow("执行图或绑定发生变化");
  });

  it("allows only selected scalars and independent primitive credentials to change", async () => {
    const source = definition(); source.runninghub!.bindingMode = "selected";
    source.template!["5"] = { class_type: "PrimitiveString", inputs: { value: "author-secret" } };
    source.template!["1"].inputs.provider_api_key = ["5", 0];
    const saved = await attachRunningHubExecutionContract(source), runtime = structuredClone(saved.template!);
    runtime["1"].inputs.prompt = "User prompt"; runtime["1"].inputs.seed = 25;
    runtime["5"].inputs.value = "runtime-provider-key";
    await expect(validateRunningHubExecutionGraph(saved, runtime)).resolves.toBeUndefined();
    expect(runtime["1"].inputs.provider_api_key).toEqual(["5", 0]);
    expect(saved.runninghub!.executionContract!.targets.some(target => target.nodeId === "5" && target.field === "value")).toBe(true);
  });

  it.each(["unselected-scalar", "structured-value", "extra-node", "extra-field", "missing-node", "missing-field", "connected-target", "selected-type", "output-prefix"])("rejects selected-mode %s drift even with complete workflow JSON enabled", async change => {
    const source = definition(); source.runninghub = { ...source.runninghub!, bindingMode: "selected", includeWorkflowJson: true };
    source.output.prefix = { nodeId: "2", field: "filename_prefix" };
    const saved = await attachRunningHubExecutionContract(source), runtime = structuredClone(saved.template!);
    if (change === "unselected-scalar") runtime["1"].inputs.enabled = false;
    if (change === "structured-value") runtime["3"].inputs.details = { mode: "changed", stages: [1, 2] };
    if (change === "extra-node") runtime["99"] = { class_type: "Extra", inputs: {} };
    if (change === "extra-field") runtime["1"].inputs.internal_override = "extra";
    if (change === "missing-node") delete runtime["4"];
    if (change === "missing-field") delete runtime["3"].inputs.details;
    if (change === "connected-target") runtime["1"].inputs.prompt = ["3", 0];
    if (change === "selected-type") runtime["1"].inputs.seed = "25";
    if (change === "output-prefix") runtime["2"].inputs.filename_prefix = "canvas-rewrite";
    await expect(validateRunningHubExecutionGraph(saved, runtime)).rejects.toThrow("RunningHub");
  });

  it("preserves legacy runtime scalar and structured behavior without the selected marker", async () => {
    const saved = await attachRunningHubExecutionContract(definition()), runtime = structuredClone(saved.template!);
    runtime["1"].inputs.enabled = false;
    runtime["3"].inputs.details = { mode: "legacy", stages: [2, 1] };
    runtime["99"] = { class_type: "LegacyExtra", inputs: {} };
    await expect(validateRunningHubExecutionGraph(saved, runtime)).resolves.toBeUndefined();
  });

  it("rebinds a verified identical source without modifying its graph or the previous contract", async () => {
    const previous = await attachRunningHubExecutionContract(definition()), before = structuredClone(previous), selected = structuredClone(previous);
    selected.runninghub!.bindingMode = "selected";
    selected.mapping = selected.mapping.filter(mapping => mapping.semantic !== "seed"); selected.parameters = [];
    const result = await rebindRunningHubExecutionContract(selected, previous);
    expect(previous).toEqual(before);
    expect(result.template).toEqual(previous.template);
    expect(result.runninghub!.executionContract!.targets.some(target => target.field === "seed")).toBe(false);
    await expect(validateRunningHubExecutionGraph(result)).resolves.toBeUndefined();
  });

  it.each(["missing-snapshot", "source-drift", "old-binding-drift", "new-source", "site", "id", "kind", "protocol"])("does not re-sign an unverified or different source: %s", async change => {
    const previous = await attachRunningHubExecutionContract(definition()), next = structuredClone(previous);
    next.runninghub!.bindingMode = "selected";
    if (change === "missing-snapshot") delete previous.runninghub!.executionContract;
    if (change === "source-drift") previous.template!["3"].inputs.strength = 0.1;
    if (change === "old-binding-drift") previous.mapping[0].semantic = "changedPrompt";
    if (change === "new-source") next.template!["3"].inputs.strength = 0.1;
    if (change === "site") next.runninghub!.baseUrl = "https://www.runninghub.ai";
    if (change === "id") next.runninghub!.workflowId = "987654321";
    if (change === "kind") next.runninghub!.kind = "app";
    if (change === "protocol") next.runninghub!.apiVersion = "v2";
    await expect(rebindRunningHubExecutionContract(next, previous)).rejects.toThrow("RunningHub");
  });

  it("hashes and retains the complete sanitized graph, including unselected branches, without mutating sources", async () => {
    const source = definition(), before = structuredClone(source);
    const saved = await attachRunningHubExecutionContract(source);
    expect(source).toEqual(before);
    expect(saved.runninghub!.executionContract).toMatchObject({ version: 1, scope: "full-graph", nodeCount: 4 });
    expect(saved.runninghub!.executionContract!.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.template!["3"]).toEqual(source.template!["3"]);
    expect(saved.template!["4"]).toEqual(source.template!["4"]);
    expect(saved.template!["1"].inputs.provider_api_key).toBe("");
    expect(JSON.stringify(saved)).not.toContain("author-example-key");
    expect(saved.runninghub!.executionContract!.targets).toContainEqual({ nodeId: "1", classType: "Generate", field: "provider_api_key", inputShape: "scalar", valueType: "string" });
    await expect(validateRunningHubExecutionGraph(saved)).resolves.toBeUndefined();
  });

  it("normalizes object order and ignores node credential values in the source hash", async () => {
    const first = definition(), second = definition();
    second.template = Object.fromEntries(Object.entries(second.template!).reverse().map(([id, node]) => [id, { inputs: Object.fromEntries(Object.entries(node.inputs).reverse()), class_type: node.class_type }]));
    second.template["1"].inputs.provider_api_key = "another-local-key";
    const a = await attachRunningHubExecutionContract(first), b = await attachRunningHubExecutionContract(second);
    expect(a.runninghub!.executionContract).toEqual(b.runninghub!.executionContract);
  });

  it("follows a linked PrimitiveString credential source without storing its value", async () => {
    const source = definition();
    source.template!["5"] = { class_type: "PrimitiveString", inputs: { value: "primitive-secret-key" } };
    source.template!["1"].inputs.provider_api_key = ["5", 0];
    const saved = await attachRunningHubExecutionContract(source);
    expect(saved.template!["5"].inputs.value).toBe("");
    expect(saved.template!["1"].inputs.provider_api_key).toEqual(["5", 0]);
    expect(JSON.stringify(saved.runninghub!.executionContract)).not.toContain("primitive-secret-key");
    expect(saved.runninghub!.executionContract!.targets).toContainEqual({ nodeId: "5", classType: "PrimitiveString", field: "value", inputShape: "scalar", valueType: "string" });
  });

  it("allows prompt, seed and independent node Key edits without changing graph structure", async () => {
    const saved = await attachRunningHubExecutionContract(definition()), runtime = structuredClone(saved.template!);
    runtime["1"].inputs.prompt = "User prompt"; runtime["1"].inputs.seed = 93; runtime["1"].inputs.provider_api_key = "runtime-node-key";
    const before = structuredClone(runtime);
    await expect(validateRunningHubExecutionGraph(saved, runtime)).resolves.toBeUndefined();
    expect(runtime).toEqual(before);
  });

  it.each(["node", "class", "input", "link", "scalar", "value"])("rejects %s drift before submission", async change => {
    const saved = await attachRunningHubExecutionContract(definition()), runtime = structuredClone(saved.template!);
    if (change === "node") delete runtime["3"];
    if (change === "class") runtime["3"].class_type = "DifferentBranch";
    if (change === "input") delete runtime["3"].inputs.strength;
    if (change === "link") runtime["2"].inputs.images = ["3", 0];
    if (change === "scalar") runtime["1"].inputs.prompt = ["3", 0];
    if (change === "value") runtime["1"].inputs.seed = "93";
    await expect(validateRunningHubExecutionGraph(saved, runtime)).rejects.toThrow("RunningHub");
  });

  it("detects source or binding edits against the saved version hash", async () => {
    const saved = await attachRunningHubExecutionContract(definition());
    const changedSource = structuredClone(saved); changedSource.template!["3"].inputs.strength = 0.3;
    await expect(validateRunningHubExecutionGraph(changedSource)).rejects.toThrow("执行图或绑定发生变化");
    const changedBinding = structuredClone(saved); changedBinding.mapping.push({ semantic: "enabled", nodeId: "1", field: "enabled" });
    await expect(validateRunningHubExecutionGraph(changedBinding)).rejects.toThrow("执行图或绑定发生变化");
  });

  it("detects swapped semantics on two same-typed targets while source and target snapshots stay identical", async () => {
    const original = definition(); original.template!["1"].inputs.negative_prompt = "Original negative";
    original.mapping.push({ semantic: "negativePrompt", nodeId: "1", field: "negative_prompt" });
    const saved = await attachRunningHubExecutionContract(original), changed = structuredClone(saved);
    expect(saved.runninghub!.executionContract!.bindingHash).toMatch(/^[a-f0-9]{64}$/);
    changed.mapping[0].semantic = "negativePrompt"; changed.mapping[2].semantic = "prompt";
    expect(changed.template).toEqual(saved.template);
    await expect(validateRunningHubExecutionGraph(changed)).rejects.toThrow("执行图或绑定发生变化");
    expect(sameRunningHubExecutionSource(saved, changed)).toBe(false);
  });

  it.each(["index", "pathMode", "serialization", "maxItems", "slot-kind", "slot-required", "required-input", "media-mode", "media-required", "media-empty"])("detects binding execution %s changes", async change => {
    const saved = await attachRunningHubExecutionContract(mediaDefinition()), changed = structuredClone(saved);
    const mapping = changed.mapping.find(item => item.semantic === "images")!;
    if (change === "index") mapping.index = 1;
    if (change === "pathMode") mapping.pathMode = "comfy-input";
    if (change === "serialization") mapping.serialization = "json-paths";
    if (change === "maxItems") mapping.maxItems = 4;
    if (change === "slot-kind") changed.inputSlots![0].kind = "video";
    if (change === "slot-required") changed.inputSlots![0].required = true;
    if (change === "required-input") { changed.requiredInputs = ["images"]; changed.optionalInputs = ["audio"]; }
    if (change === "media-mode") changed.mediaInputMode = "schema";
    if (change === "media-required") changed.runninghub!.mediaInputs![0].required = true;
    if (change === "media-empty") changed.runninghub!.mediaInputs![0].emptyValue = null;
    expect(changed.template).toEqual(saved.template);
    await expect(validateRunningHubExecutionGraph(changed)).rejects.toThrow("执行图或绑定发生变化");
    expect(sameRunningHubExecutionSource(saved, changed)).toBe(false);
  });

  it("ignores binding array order and slot labels, and does not hash the current result selection", async () => {
    const saved = await attachRunningHubExecutionContract(mediaDefinition()), presentation = structuredClone(saved);
    presentation.mapping.reverse(); presentation.optionalInputs.reverse(); presentation.inputSlots!.reverse(); presentation.runninghub!.mediaInputs!.reverse();
    presentation.inputSlots![0].label = "Renamed presentation";
    await expect(validateRunningHubExecutionGraph(presentation)).resolves.toBeUndefined();
    expect(sameRunningHubExecutionSource(saved, presentation)).toBe(true);
    presentation.output = { nodeId: "4", field: "images", kind: "image" };
    await expect(validateRunningHubExecutionGraph(presentation)).resolves.toBeUndefined();
  });

  it("retains compatibility with older snapshots that have no binding hash", async () => {
    const legacy = await attachRunningHubExecutionContract(mediaDefinition());
    delete legacy.runninghub!.executionContract!.bindingHash;
    legacy.inputSlots![0].label = "Older saved project";
    await expect(validateRunningHubExecutionGraph(legacy, structuredClone(legacy.template!))).resolves.toBeUndefined();
  });

  it("captures all imported LoRA bindings before ordinary execution normalization", async () => {
    const source = graph();
    source["5"] = { class_type: "LoraLoader", inputs: { lora_name: ["7", 0], strength_model: ["6", 0], strength_clip: 0.9 } };
    source["6"] = { class_type: "PrimitiveFloat", inputs: { value: 0.5 } };
    source["7"] = { class_type: "PrimitiveString", inputs: { value: "fixture-lora.safetensors" } };
    source["1"].inputs.model = ["5", 0];
    const prepared = prepareRunningHubWorkflow(source, await withRunningHubWorkflowReader(source, { workflowId: "123456789", baseUrl: "https://www.runninghub.cn", name: "LoRA contract", outputs: [{ nodeId: "2", field: "images", kind: "image" }] })).workflow;
    expect(withLoraParameters(prepared).mapping).toEqual(prepared.mapping);
    const saved = await attachRunningHubExecutionContract(prepared), executable = selectWorkflowOutput(saved, {});
    await expect(validateRunningHubExecutionGraph(executable)).resolves.toBeUndefined();
  });

  it.each(["missing-node", "missing-field", "link"])("validates legacy bindings with no saved snapshot: %s", async change => {
    const legacy = definition();
    if (change === "missing-node") legacy.mapping[0].nodeId = "unknown";
    if (change === "missing-field") legacy.mapping[0].field = "unknown";
    if (change === "link") legacy.mapping[0] = { semantic: "prompt", nodeId: "2", field: "images" };
    await expect(validateRunningHubExecutionGraph(legacy)).rejects.toThrow("绑定");
  });

  it("keeps valid legacy workflows runnable with local validation only", async () => {
    const legacy = definition();
    await expect(validateRunningHubExecutionGraph(legacy, structuredClone(legacy.template!))).resolves.toBeUndefined();
  });

  it("recognizes the same sanitized source in older project records without retaining snapshots for changed execution", async () => {
    const original = definition(), saved = await attachRunningHubExecutionContract(original);
    const renamed = structuredClone(original); renamed.name = "User title"; renamed.mapping.reverse();
    expect(sameRunningHubExecutionSource(saved, renamed)).toBe(true);
    for (const change of ["graph", "mapping", "output", "protocol", "site", "kind", "id"]) {
      const different = structuredClone(original);
      if (change === "graph") different.template!["1"].inputs.seed = 9;
      if (change === "mapping") different.mapping[0].field = "enabled";
      if (change === "output") different.output.nodeId = "4";
      if (change === "protocol") different.runninghub!.apiVersion = "v2";
      if (change === "site") different.runninghub!.baseUrl = "https://www.runninghub.ai";
      if (change === "kind") different.runninghub!.kind = "app";
      if (change === "id") different.runninghub!.workflowId = "987654321";
      expect(sameRunningHubExecutionSource(saved, different), change).toBe(false);
    }
  });
});

describe("RunningHub remote full workflow verification", () => {
  it("compares the complete remote source independent of object order and author credential values", async () => {
    const source = definition(); source.runninghub!.bindingMode = "selected";
    const saved = await attachRunningHubExecutionContract(source), remote = graph();
    remote["1"].inputs.provider_api_key = "another-author-key";
    const reordered = Object.fromEntries(Object.entries(remote).reverse().map(([nodeId, node]) => [nodeId, { ...node, inputs: Object.fromEntries(Object.entries(node.inputs).reverse()) }]));
    const before = structuredClone(reordered);
    await expect(validateRunningHubRemoteWorkflow(saved, reordered)).resolves.toBeUndefined();
    expect(reordered).toEqual(before);
    expect(saved.template!["1"].inputs.provider_api_key).toBe("");
  });

  it("ignores a linked primitive's author Key while preserving its complete connection", async () => {
    const source = definition(); source.runninghub!.bindingMode = "selected";
    source.template!["5"] = { class_type: "PrimitiveString", inputs: { value: "author-key" } };
    source.template!["1"].inputs.provider_api_key = ["5", 0];
    const saved = await attachRunningHubExecutionContract(source), remote = structuredClone(source.template!);
    remote["5"].inputs.value = "changed-author-key";
    await expect(validateRunningHubRemoteWorkflow(saved, remote)).resolves.toBeUndefined();
    expect(remote["1"].inputs.provider_api_key).toEqual(["5", 0]);
  });

  it.each(["selected-default", "internal-default", "structured", "node-class", "link", "extra-node", "missing-node", "extra-field", "missing-field", "deleted-secret", "output-prefix"])("requires a fresh read after remote %s drift", async change => {
    const source = definition(); source.runninghub!.bindingMode = "selected";
    const saved = await attachRunningHubExecutionContract(source), remote = graph();
    if (change === "selected-default") remote["1"].inputs.seed = 88;
    if (change === "internal-default") remote["3"].inputs.strength = 0.3;
    if (change === "structured") remote["3"].inputs.details = { mode: "changed", stages: [1, 2] };
    if (change === "node-class") remote["3"].class_type = "NewInternalBranch";
    if (change === "link") remote["2"].inputs.images = ["3", 0];
    if (change === "extra-node") remote["99"] = { class_type: "NewBranch", inputs: {} };
    if (change === "missing-node") delete remote["4"];
    if (change === "extra-field") remote["1"].inputs.new_field = true;
    if (change === "missing-field") delete remote["3"].inputs.strength;
    if (change === "deleted-secret") delete remote["1"].inputs.provider_api_key;
    if (change === "output-prefix") remote["2"].inputs.filename_prefix = "remote-new-prefix";
    await expect(validateRunningHubRemoteWorkflow(saved, remote)).rejects.toThrow("远程工作流已变化");
  });

  it("does not accept a locally altered source merely because the remote matches the alteration", async () => {
    const source = definition(); source.runninghub!.bindingMode = "selected";
    const saved = await attachRunningHubExecutionContract(source);
    saved.template!["3"].inputs.strength = 0.1;
    await expect(validateRunningHubRemoteWorkflow(saved, structuredClone(saved.template!))).rejects.toThrow("执行图或绑定发生变化");
  });
});

describe("RunningHub published application contracts", () => {
  it("reuses only the verified previous application's public schema while re-signing local bindings", async () => {
    const previous = await attachRunningHubExecutionContract(appDefinition(), app()), before = structuredClone(previous), selected = structuredClone(previous);
    selected.runninghub!.bindingMode = "selected";
    selected.mapping = selected.mapping.filter(mapping => mapping.semantic !== "seed"); selected.parameters = [];
    selected.runninghub!.executionContract!.publicSchema!.fields[0].type = "untrusted-incoming-schema";
    const rebound = await rebindRunningHubExecutionContract(selected, previous);
    expect(previous).toEqual(before);
    expect(rebound.template).toEqual(previous.template);
    expect(rebound.runninghub!.executionContract!.publicSchema).toEqual(before.runninghub!.executionContract!.publicSchema);
    expect(rebound.runninghub!.executionContract!.publicSchema).not.toBe(previous.runninghub!.executionContract!.publicSchema);
    expect(rebound.runninghub!.executionContract!.publicFieldCount).toBe(4);
    await expect(validateRunningHubExecutionGraph(rebound)).resolves.toBeUndefined();
    await expect(validateRunningHubPublicSchema(rebound, app())).resolves.toBeUndefined();
  });

  it.each(["missing-schema", "schema-fields", "schema-hash", "field-count"])("rejects an application's unverified saved public snapshot: %s", async change => {
    const previous = await attachRunningHubExecutionContract(appDefinition(), app()), next = structuredClone(previous);
    next.runninghub!.bindingMode = "selected";
    const contract = previous.runninghub!.executionContract!;
    if (change === "missing-schema") delete contract.publicSchema;
    if (change === "schema-fields") contract.publicSchema!.fields[0].type = "changed";
    if (change === "schema-hash") contract.publicSchema!.hash = "0".repeat(64);
    if (change === "field-count") contract.publicFieldCount = 3;
    await expect(rebindRunningHubExecutionContract(next, previous)).rejects.toThrow("公开参数快照");
  });

  it("records the public scope and field count without claiming to read the full internal graph", async () => {
    const saved = await attachRunningHubExecutionContract(appDefinition(), app());
    expect(saved.runninghub!.executionContract).toMatchObject({ scope: "public-inputs", nodeCount: 4, publicFieldCount: 4 });
    expect(saved.runninghub!.executionContract!.publicSchema!.hash).toMatch(/^[a-f0-9]{64}$/);
    const runtime = structuredClone(saved.template!); runtime["1"].inputs.reference = "openapi/uploaded-reference.png";
    await expect(validateRunningHubExecutionGraph(saved, runtime)).resolves.toBeUndefined();
  });

  it("ignores names, input order, prompt/seed defaults, diagnostic metadata and widget defaults", async () => {
    const saved = await attachRunningHubExecutionContract(appDefinition(), app()), current = app();
    current.name = "New title"; current.diagnostics = ["non-contract information"];
    current.nodeInfoList[0].fieldValue = "A different default prompt";
    current.nodeInfoList[0].nodeName = "Renamed node"; current.nodeInfoList[0].description = "Renamed prompt";
    current.nodeInfoList[0].fieldData = ["STRING", { default: "Changed widget default", multiline: false }];
    current.nodeInfoList[1].fieldValue = 57;
    current.nodeInfoList[2].fieldValue = "square";
    current.nodeInfoList.reverse();
    await expect(validateRunningHubPublicSchema(saved, current)).resolves.toBeUndefined();
  });

  it.each(["node", "field", "type", "required", "min", "max", "step", "options", "empty-value", "removed-field", "added-field"])("rejects meaningful public %s drift", async change => {
    const saved = await attachRunningHubExecutionContract(appDefinition(), app()), current = app();
    if (change === "node") current.nodeInfoList[0].nodeId = "9";
    if (change === "field") current.nodeInfoList[0].fieldName = "new_prompt";
    if (change === "type") current.nodeInfoList[1].fieldType = "STRING";
    if (change === "required") current.nodeInfoList[1].required = true;
    if (change === "min") current.nodeInfoList[1].min = 1;
    if (change === "max") current.nodeInfoList[1].max = 200;
    if (change === "step") current.nodeInfoList[1].step = 2;
    if (change === "options") current.nodeInfoList[2].fieldData = [{ index: "tall", name: "16:9" }, { index: "square", name: "1:1" }];
    if (change === "empty-value") current.nodeInfoList[3].mediaEmptyValue = "";
    if (change === "removed-field") current.nodeInfoList.pop();
    if (change === "added-field") current.nodeInfoList.push({ nodeId: "1", fieldName: "new_input", fieldType: "STRING", fieldValue: "" });
    await expect(validateRunningHubPublicSchema(saved, current)).rejects.toThrow("公开参数已变化");
  });

  it("compares original typed options and required/range metadata inside fieldData", async () => {
    const original = app(); original.nodeInfoList[1] = { nodeId: "1", fieldName: "seed", fieldValue: 4, fieldData: ["INT", { min: 0, max: 100, step: 1, required: true, default: 4 }] };
    const saved = await attachRunningHubExecutionContract(appDefinition(), original), current = structuredClone(original);
    current.nodeInfoList[1].fieldData = ["INT", { min: 0, max: 101, step: 1, required: true, default: 4 }];
    await expect(validateRunningHubPublicSchema(saved, current)).rejects.toThrow("公开参数已变化");
  });

  it("detects a media type change declared only in the widget schema", async () => {
    const original = app(); original.nodeInfoList[3] = { nodeId: "1", fieldName: "reference", fieldValue: "", fieldData: ["IMAGE", { default: "" }] };
    const saved = await attachRunningHubExecutionContract(appDefinition(), original), current = structuredClone(original);
    current.nodeInfoList[3].fieldData = ["VIDEO", { default: "" }];
    await expect(validateRunningHubPublicSchema(saved, current)).rejects.toThrow("公开参数已变化");
  });

  it("compares typed choice values while ignoring labels, order, duplicates and trailing widget default metadata", async () => {
    const original = app();
    original.nodeInfoList[2].fieldData = [{ index: "wide", name: "16:9", description: "Wide" }, { value: "square", label: "1:1" }, { default: "wide", description: "Widget metadata" }];
    const saved = await attachRunningHubExecutionContract(appDefinition(), original), current = structuredClone(original);
    current.nodeInfoList[2].fieldData = [{ default: "square", description: "Changed metadata" }, { id: "square", name: "Square" }, "wide", { value: "wide", label: "Wide display" }];
    expect(saved.runninghub!.executionContract!.publicSchema!.fields.find(field => field.fieldName === "ratio")!.options).toEqual({ values: ["square", "wide"] });
    await expect(validateRunningHubPublicSchema(saved, current)).resolves.toBeUndefined();
  });

  it.each(["added", "removed", "changed-type"])("rejects %s typed choice values even when their display labels stay the same", async change => {
    const original = app(); original.nodeInfoList[2].fieldData = [{ index: 0, name: "Off" }, { value: true, label: "On" }, { id: "wide", label: "Wide" }];
    const saved = await attachRunningHubExecutionContract(appDefinition(), original), current = structuredClone(original);
    const choices = structuredClone(original.nodeInfoList[2].fieldData) as Record<string, unknown>[];
    if (change === "added") choices.push({ index: "square", name: "Square" });
    if (change === "removed") choices.pop();
    if (change === "changed-type") choices[0].index = "0";
    current.nodeInfoList[2].fieldData = choices;
    await expect(validateRunningHubPublicSchema(saved, current)).rejects.toThrow("公开参数已变化");
  });

  it("retains opaque fingerprints for unrecognized choices without hashing display names or defaults", async () => {
    const original = app(); original.nodeInfoList[2].fieldData = [{ unsupported: { format: "vendor-specific", label: "Original label" }, description: "Original description", default: "wide" }, "wide"];
    const saved = await attachRunningHubExecutionContract(appDefinition(), original), current = structuredClone(original);
    const options = saved.runninghub!.executionContract!.publicSchema!.fields.find(field => field.fieldName === "ratio")!.options;
    expect(options).toMatchObject({ values: ["wide"], unrecognizedCount: 1, opaqueFingerprints: [expect.stringMatching(/^[a-f0-9]{64}$/)] });
    expect(JSON.stringify(options)).not.toContain("vendor-specific");
    current.nodeInfoList[2].fieldData = ["wide", { unsupported: { format: "vendor-specific", label: "Changed label" }, description: "Changed description", default: "square" }];
    await expect(validateRunningHubPublicSchema(saved, current)).resolves.toBeUndefined();
    current.nodeInfoList[2].fieldData = ["wide", { unsupported: { format: "different-contract" } }];
    await expect(validateRunningHubPublicSchema(saved, current)).rejects.toThrow("公开参数已变化");
  });

  it("keeps malformed fieldData and unknown label-only choices visible as fingerprints", async () => {
    for (const initial of ["not-json-options", [{ label: "unproven-wire-value" }]]) {
      const original = app(); original.nodeInfoList[2].fieldData = initial;
      const saved = await attachRunningHubExecutionContract(appDefinition(), original), current = structuredClone(original);
      expect(saved.runninghub!.executionContract!.publicSchema!.fields.find(field => field.fieldName === "ratio")!.options).toMatchObject({ unrecognizedCount: 1, opaqueFingerprints: [expect.stringMatching(/^[a-f0-9]{64}$/)] });
      current.nodeInfoList[2].fieldData = typeof initial === "string" ? "different-malformed-options" : [{ label: "different-unproven-wire-value" }];
      await expect(validateRunningHubPublicSchema(saved, current)).rejects.toThrow("公开参数已变化");
    }
  });

  it("never hashes public credential examples or their option lists", async () => {
    const first = app(), second = app();
    first.nodeInfoList.push({ nodeId: "1", fieldName: "provider_api_key", fieldType: "STRING", fieldValue: "first-provider-secret", fieldData: [{ value: "first-provider-secret" }] });
    second.nodeInfoList.push({ nodeId: "1", fieldName: "provider_api_key", fieldType: "STRING", fieldValue: "second-provider-secret", fieldData: [{ value: "second-provider-secret" }] });
    const saved = await attachRunningHubExecutionContract(appDefinition(), first);
    expect(JSON.stringify(saved.runninghub!.executionContract)).not.toMatch(/first-provider-secret|second-provider-secret/);
    await expect(validateRunningHubPublicSchema(saved, second)).resolves.toBeUndefined();
  });

  it("does not require a remote schema for legacy applications without a snapshot", async () => {
    await expect(validateRunningHubPublicSchema(appDefinition(), app())).resolves.toBeUndefined();
  });
});
