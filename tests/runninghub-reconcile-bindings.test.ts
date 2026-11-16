import { describe, expect, it } from "vitest";
import type { Generation, Project, WorkflowDefinition } from "../src/types";
import { reconcileRunningHubProjectBindings } from "../src/runninghub/reconcile-bindings";

function workflow(): WorkflowDefinition {
  return { id: "runninghub-fixture", name: "Fixture", family: "Image", description: "", mode: "text-to-image",
    runninghub: { workflowId: "42", baseUrl: "https://www.runninghub.cn", bindingMode: "selected" },
    requiredInputs: [], optionalInputs: [], parameters: [
      { key: "first", label: "Seed", type: "number", default: 1 },
      { key: "second", label: "Steps", type: "number", default: 20 },
    ], mapping: [{ semantic: "prompt", nodeId: "1", field: "prompt" },
      { semantic: "first", nodeId: "1", field: "seed" }, { semantic: "second", nodeId: "1", field: "steps" }],
    template: { "1": { class_type: "Generator", inputs: { prompt: "example", seed: 1, steps: 20, custom: 7 } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } } }, output: { nodeId: "2", field: "images", kind: "image" } };
}
function project(patch: Partial<Generation> = {}): Project {
  return { version: 2, id: "project", name: "Fixture", scenes: [{ id: "scene", name: "Scene" }], activeCanvasId: "canvas", updatedAt: 100,
    assets: { asset: { id: "asset", name: "image.png", kind: "image", mime: "image/png", size: 1, createdAt: 1 } },
    tasks: { accepted: { taskId: "accepted", workflow: workflow(), input: { params: { first: 99 } } } as Project["tasks"][string] },
    history: [{ taskId: "accepted", assetIds: ["asset"], promptId: "remote", createdAt: 1 }],
    canvases: [{ id: "canvas", name: "Canvas", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 }, edges: [], nodes: [
      { id: "node", position: { x: 0, y: 0 }, data: { title: "Result", kind: "image-generation", assetId: "asset", generationFeedback: { status: "generating" },
        generation: { prompt: "Own prompt", negativePrompt: "Own negative", workflowId: "runninghub-fixture", params: { first: 99, second: 32, orphan: true },
          taskId: "accepted", computeProvider: "runninghub", runningHubInstanceType: "ultra", ...patch } } },
      { id: "reference", position: { x: 20, y: 0 }, data: { title: "Reference", kind: "reference", assetId: "asset" } },
    ] }] };
}
const generation = (value: Project) => value.canvases[0].nodes[0].data.generation!;
function appPromptUpgrade() {
  const previous = workflow(); previous.runninghub!.kind = "app";
  previous.mapping = previous.mapping.filter(mapping => mapping.semantic !== "prompt");
  previous.parameters.push({ key: "old_text", label: "Published text", type: "text", default: "Author text" });
  previous.mapping.push({ semantic: "old_text", nodeId: "1", field: "prompt" });
  const next = structuredClone(previous);
  Object.assign(next.runninghub!, { parameterSchemaVersion: 2 });
  next.parameters = next.parameters.filter(parameter => parameter.key !== "old_text");
  next.mapping = next.mapping.filter(mapping => mapping.semantic !== "old_text");
  next.mapping.push({ semantic: "prompt", nodeId: "1", field: "prompt" });
  return { previous, next };
}

describe("RunningHub current node binding reconciliation", () => {
  it("moves values by concrete target when generated keys are reordered, while preserving task and result references", () => {
    const previous = workflow(), next = workflow(), original = project(), before = structuredClone(original);
    next.parameters[0].key = "second"; next.parameters[1].key = "first";
    next.mapping[1].semantic = "second"; next.mapping[2].semantic = "first";
    const result = reconcileRunningHubProjectBindings(original, previous, next, "runninghub");
    expect(generation(result).params).toEqual({ second: 99, first: 32 });
    expect(generation(result)).toMatchObject({ prompt: "Own prompt", negativePrompt: "Own negative", taskId: "accepted", runningHubInstanceType: "ultra" });
    expect(result.tasks).toBe(original.tasks); expect(result.history).toBe(original.history); expect(result.assets).toBe(original.assets);
    expect(result.tasks.accepted).toBe(original.tasks.accepted); expect(result.updatedAt).toBe(100);
    expect(result.canvases[0].nodes[0].data.generationFeedback).toBe(original.canvases[0].nodes[0].data.generationFeedback);
    expect(result.canvases[0].nodes[1]).toBe(original.canvases[0].nodes[1]);
    expect(original).toEqual(before);
  });

  it.each(["field", "class", "node", "index", "serialization", "pathMode"] as const)("uses the new default for a reused key with changed %s identity", change => {
    const previous = workflow(), next = workflow(), original = project();
    if (change === "field") next.mapping[1].field = "custom";
    if (change === "class") next.template!["1"].class_type = "DifferentGenerator";
    if (change === "node") { next.template!.other = structuredClone(next.template!["1"]); next.mapping[1].nodeId = "other"; }
    if (change === "index") next.mapping[1].index = 1;
    if (change === "serialization") next.mapping[1].serialization = "json-paths";
    if (change === "pathMode") next.mapping[1].pathMode = "comfy-input";
    expect(generation(reconcileRunningHubProjectBindings(original, previous, next, "runninghub")).params.first).toBe(1);
  });

  it("requires the full multi-target binding set to match instead of preserving by one shared target", () => {
    const previous = workflow(), next = workflow();
    next.mapping.push({ semantic: "first", nodeId: "1", field: "custom" });
    expect(generation(reconcileRunningHubProjectBindings(project(), previous, next, "runninghub")).params.first).toBe(1);
    previous.mapping.push({ semantic: "first", nodeId: "1", field: "custom" });
    previous.mapping.reverse();
    expect(generation(reconcileRunningHubProjectBindings(project(), previous, next, "runninghub")).params.first).toBe(99);
  });

  it("removes cancelled and unknown old parameters and initializes genuinely new selected controls", () => {
    const previous = workflow(), next = workflow();
    next.parameters = [{ key: "renamed", label: "Seed", type: "number", default: 3 }, { key: "custom", label: "Custom", type: "number", default: 7 }];
    next.mapping = [{ semantic: "prompt", nodeId: "1", field: "prompt" }, { semantic: "renamed", nodeId: "1", field: "seed" }, { semantic: "custom", nodeId: "1", field: "custom" }];
    expect(generation(reconcileRunningHubProjectBindings(project(), previous, next, "runninghub")).params).toEqual({ renamed: 99, custom: 7 });
    next.parameters = []; next.mapping = next.mapping.slice(0, 1); next.runninghub!.canvasParameterKeys = [];
    expect(generation(reconcileRunningHubProjectBindings(project(), previous, next, "runninghub")).params).toEqual({});
  });

  it("updates an inactive RunningHub remembered selection without touching current cloud generation", () => {
    const cloudParams = { cloudSetting: 42 }, rememberedCloud = { workflowId: "cloud", params: cloudParams };
    const original = project({ computeProvider: "comfyui", workflowId: "cloud", params: cloudParams, providerSelections: {
      comfyui: rememberedCloud, runninghub: { workflowId: "runninghub-fixture", params: { first: 45, second: 12, unknown: 3 } },
    } });
    const next = workflow(); next.parameters = next.parameters.slice(0, 1); next.mapping = next.mapping.slice(0, 2);
    const result = reconcileRunningHubProjectBindings(original, workflow(), next, "runninghub");
    expect(generation(result).params).toBe(cloudParams);
    expect(generation(result).workflowId).toBe("cloud"); expect(generation(result).computeProvider).toBe("comfyui");
    expect(generation(result).providerSelections!.runninghub!.params).toEqual({ first: 45 });
    expect(generation(result).providerSelections!.comfyui).toBe(rememberedCloud);
  });

  it("uses the active provider only when the node has no provider marker", () => {
    const original = project({ computeProvider: undefined }), previous = workflow(), next = workflow();
    const skipped = reconcileRunningHubProjectBindings(original, previous, next, "comfyui");
    expect(skipped).toBe(original);
    expect(generation(reconcileRunningHubProjectBindings(original, previous, next, "runninghub")).params).toEqual({ first: 99, second: 32 });
    expect(generation(original).params).toHaveProperty("orphan");
  });

  it("never restores secret values from old node params or author defaults", () => {
    const previous = workflow(), next = workflow();
    for (const definition of [previous, next]) {
      definition.template!["1"].inputs.api_key = "author-key";
      definition.parameters.push({ key: "credential", label: "Credential", type: "text", default: "author-key" });
      definition.mapping.push({ semantic: "credential", nodeId: "1", field: "api_key" });
    }
    const result = reconcileRunningHubProjectBindings(project({ params: { first: 45, credential: "old-local-key" } }), previous, next, "runninghub");
    expect(generation(result).params).toEqual({ first: 45, second: 20 });
    expect(JSON.stringify(generation(result))).not.toContain("key");
  });

  it("keeps the same project reference when reconciliation has no actual value changes", () => {
    const original = project({ params: { first: 99, second: 32 }, providerSelections: { runninghub: { workflowId: "runninghub-fixture", params: { first: 99, second: 32 } } } });
    expect(reconcileRunningHubProjectBindings(original, workflow(), workflow(), "runninghub")).toBe(original);
    const unrelated = project({ workflowId: "other", providerSelections: { runninghub: { workflowId: "other", params: { old: 1 } } } });
    expect(reconcileRunningHubProjectBindings(unrelated, workflow(), workflow(), "runninghub")).toBe(unrelated);
  });

  it.each(["legacy", "localId", "remoteId", "site", "kind", "version", "invalidSite"] as const)("does nothing across a %s boundary", change => {
    const previous = workflow(), next = workflow(), original = project();
    if (change === "legacy") delete next.runninghub!.bindingMode;
    if (change === "localId") next.id = "different";
    if (change === "remoteId") next.runninghub!.workflowId = "43";
    if (change === "site") next.runninghub!.baseUrl = "https://www.runninghub.ai";
    if (change === "kind") next.runninghub!.kind = "app";
    if (change === "version") next.runninghub!.apiVersion = "v2";
    if (change === "invalidSite") next.runninghub!.baseUrl = "https://foreign.example";
    expect(reconcileRunningHubProjectBindings(original, previous, next, "runninghub")).toBe(original);
  });

  it("accepts normalized aliases and legacy omitted v1/workflow metadata for the same official deployment", () => {
    const previous = workflow(), next = workflow();
    previous.runninghub!.baseUrl = "https://runninghub.cn/";
    next.runninghub!.kind = "workflow"; next.runninghub!.apiVersion = "v1";
    expect(generation(reconcileRunningHubProjectBindings(project(), previous, next, "runninghub")).params).toEqual({ first: 99, second: 32 });
  });

  it("moves an explicitly edited legacy text field into an empty main prompt during an app schema upgrade", () => {
    const { previous, next } = appPromptUpgrade();
    const original = project({ prompt: "", params: { first: 99, second: 32, old_text: "My published user prompt" } });
    const before = structuredClone(original);
    const result = reconcileRunningHubProjectBindings(original, previous, next, "runninghub");
    expect(generation(result).prompt).toBe("My published user prompt");
    expect(generation(result).params).toEqual({ first: 99, second: 32 });
    expect(result.tasks).toBe(original.tasks); expect(result.history).toBe(original.history); expect(result.assets).toBe(original.assets);
    expect(original).toEqual(before);
  });

  it("preserves an existing user main prompt while removing the superseded legacy text control", () => {
    const { previous, next } = appPromptUpgrade();
    const original = project({ prompt: "Keep my main prompt", params: { first: 3, old_text: "Different old parameter text" } });
    const result = reconcileRunningHubProjectBindings(original, previous, next, "runninghub");
    expect(generation(result).prompt).toBe("Keep my main prompt");
    expect(generation(result).params).toEqual({ first: 3, second: 20 });
  });

  it.each(["default", "absent", "empty", "nontext", "ambiguous", "new-target", "already-v2", "no-upgrade"] as const)("does not infer a user prompt from %s legacy parameter state", state => {
    const { previous, next } = appPromptUpgrade();
    const params: Generation["params"] = { first: 3, old_text: "A user edit" };
    if (state === "default") params.old_text = "Author text";
    if (state === "absent") delete params.old_text;
    if (state === "empty") params.old_text = "  ";
    if (state === "nontext") params.old_text = 42;
    if (state === "ambiguous") {
      previous.parameters.push({ key: "alias", label: "Alias", type: "text", default: "" });
      previous.mapping.push({ semantic: "alias", nodeId: "1", field: "prompt" }); params.alias = "Another user edit";
    }
    if (state === "new-target") next.mapping.find(mapping => mapping.semantic === "prompt")!.field = "custom";
    if (state === "already-v2") Object.assign(previous.runninghub!, { parameterSchemaVersion: 2 });
    if (state === "no-upgrade") delete (next.runninghub as { parameterSchemaVersion?: number }).parameterSchemaVersion;
    const result = reconcileRunningHubProjectBindings(project({ prompt: "", params }), previous, next, "runninghub");
    expect(generation(result).prompt).toBe("");
    expect(generation(result).params).not.toHaveProperty("old_text");
  });

  it("never copies a remembered RunningHub text parameter into another provider's main prompt", () => {
    const { previous, next } = appPromptUpgrade();
    const original = project({ computeProvider: "comfyui", workflowId: "cloud", prompt: "Cloud's own prompt", params: { cloudSetting: 42 },
      providerSelections: { runninghub: { workflowId: next.id, params: { first: 7, old_text: "Remembered RH text" } } } });
    const result = reconcileRunningHubProjectBindings(original, previous, next, "runninghub");
    expect(generation(result).prompt).toBe("Cloud's own prompt");
    expect(generation(result).params).toBe(generation(original).params);
    expect(generation(result).providerSelections!.runninghub).toEqual({ workflowId: next.id, params: { first: 7, second: 20 } });
    expect(generation(result).providerSelections!.runninghub).not.toHaveProperty("prompt");
  });

  it("resets values that violate the new typed contract without coercing otherwise compatible user edits", () => {
    const previous = workflow(), next = workflow();
    Object.assign(next.parameters[0], { sourceControl: { kind: "seed", valueType: "INT", order: 0 } });
    Object.assign(next.parameters[1], { sourceControl: { kind: "number", valueType: "FLOAT", order: 1 } });
    next.parameters[1].default = 0.7;
    const original = project({ params: { first: "99", second: 0.65 }, providerSelections: {
      runninghub: { workflowId: next.id, params: { first: 45, second: "0.9" } },
    } });
    const result = reconcileRunningHubProjectBindings(original, previous, next, "runninghub");
    expect(generation(result).params).toEqual({ first: 1, second: 0.65 });
    expect(generation(result).providerSelections!.runninghub!.params).toEqual({ first: 45, second: 0.7 });
    expect(result.tasks).toBe(original.tasks);
  });

  it("resets changed enum/range values while preserving exact typed values still declared by the new source", () => {
    const previous = workflow(), next = workflow();
    Object.assign(next.parameters[0], { type: "select", default: 1, options: ["numeric-one", "string-one"], optionValues: { "numeric-one": 1, "string-one": "1" }, sourceControl: { kind: "select", valueType: "COMBO", order: 0 } });
    Object.assign(next.parameters[1], { min: 0, max: 10, default: 5, sourceControl: { kind: "number", valueType: "INT", order: 1 } });
    const result = reconcileRunningHubProjectBindings(project({ params: { first: "1", second: 32 } }), previous, next, "runninghub");
    expect(generation(result).params).toEqual({ first: "1", second: 5 });
    const invalid = reconcileRunningHubProjectBindings(project({ params: { first: true, second: 3 } }), previous, next, "runninghub");
    expect(generation(invalid).params).toEqual({ first: 1, second: 3 });
  });
});

it("preserves old WebApp parameter values across a change from our old adapter classes to the original projection classes", () => {
  const previous = workflow(), next = workflow();
  previous.runninghub!.kind = "app"; next.runninghub!.kind = "app";
  Object.assign(next.runninghub!, { parameterSchemaVersion: 2 });
  previous.template!["1"].class_type = "RunningHubAppInput";
  next.template!["1"].class_type = "FisherAIOriginalPublicInput";
  next.parameters[0].key = "field_1_seed";
  next.mapping = next.mapping.map(mapping => mapping.semantic === "first" ? { ...mapping, semantic: "field_1_seed" } : mapping);
  const original = project(), result = reconcileRunningHubProjectBindings(original, previous, next, "runninghub");
  expect(generation(result).params).toEqual({ field_1_seed: 99, second: 32 });
  expect(result.tasks).toBe(original.tasks);
  expect(result.tasks.accepted).toBe(original.tasks.accepted);
});

it("moves an old full-workflow text edit into the source-selected main prompt during a reader upgrade", () => {
  const { previous, next } = appPromptUpgrade();
  delete previous.runninghub!.kind; delete next.runninghub!.kind;
  const original = project({ prompt: "", params: { first: 21, second: 32, old_text: "My saved text" } });
  const result = reconcileRunningHubProjectBindings(original, previous, next, "runninghub");
  expect(generation(result).prompt).toBe("My saved text");
  expect(generation(result).params).toEqual({ first: 21, second: 32 });
  expect(result.tasks).toBe(original.tasks);
});
