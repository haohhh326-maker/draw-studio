import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type { ApiWorkflow } from "../src/types";
import { analyzeWorkflowImport, buildWorkflowImport } from "../src/workflow/import-analyzer";
import { convertLibraryWorkflow, createLibraryRegistration } from "../src/workflow/library-converter";

const source = { sourcePath: "test", folder: "test", configSha256: "", executionSha256: "", executionStatus: "plain" as const };
const options = { id: "custom.dynamic-media", name: "Dynamic media", family: "Own workflows" };
const schema = {
  LoadImage: { input: { required: { image: ["STRING", { image_upload: true }] } }, output: ["IMAGE"] },
  ForeignReferenceMixer_7408: { input: { required: {
    main: ["IMAGE"],
    references: ["COMFY_AUTOGROW_V3", { template: { prefix: "reference_", min: 0, max: 8, input: { required: { image: ["IMAGE"] } } } }],
  } }, output: ["IMAGE"] },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
};
function fixture(): ApiWorkflow {
  return {
    a: { class_type: "LoadImage", inputs: { image: "required-source.png" } },
    b: { class_type: "LoadImage", inputs: { image: "optional-source.png" } },
    mix: { class_type: "ForeignReferenceMixer_7408", inputs: { main: ["a", 0], "references.reference_0": ["a", 0], "references.reference_1": ["b", 0] } },
    out: { class_type: "SaveImage", inputs: { images: ["mix", 0], filename_prefix: "original" } },
  };
}

describe("schema-driven custom import media contracts", () => {
  it("marks removable media optional while retaining media shared with a mandatory consumer", () => {
    const graph = fixture(), before = structuredClone(graph);
    expect(analyzeWorkflowImport(graph, schema).inputs.map(input => ({ nodeId: input.nodeId, required: input.required }))).toEqual([
      { nodeId: "a", required: true }, { nodeId: "b", required: false },
    ]);
    const built = buildWorkflowImport(graph, options, schema);
    expect(built.config.mediaInputMode).toBe("schema");
    expect(built.config.mediaInputPolicy).toMatchObject({ optionalSemantics: ["slot:input2"], removals: [{ semantic: "slot:input2", nodeId: "mix", field: "references.reference_1" }] });
    const restored = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(restored.requiredInputs).toEqual(["slot:input1"]);
    expect(restored.optionalInputs).toEqual(["slot:input2"]);
    expect(restored.mediaInputMode).toBe("schema");
    expect(restored.mediaInputPolicy).toEqual(built.config.mediaInputPolicy);
    expect(createLibraryRegistration(built.config, built.requirements, source).mediaInputPolicy).toEqual(restored.mediaInputPolicy);
    expect(graph).toEqual(before);
  });

  it("stays conservative offline and allows a later live schema inference for historical custom imports", () => {
    const built = buildWorkflowImport(fixture(), options);
    expect((built.config.inputs as { required: boolean }[]).every(input => input.required)).toBe(true);
    const legacy = structuredClone(built.config); delete legacy.mediaInputMode; delete legacy.mediaInputPolicy;
    const restored = convertLibraryWorkflow(legacy, built.graph, built.requirements, source);
    expect(restored.mediaInputMode).toBe("schema");
    expect(restored.mediaInputPolicy).toBeUndefined();
    const vendor = { ...legacy, id: "vendor.references" };
    expect(convertLibraryWorkflow(vendor, built.graph, built.requirements, source).mediaInputMode).toBeUndefined();
    expect(createLibraryRegistration(vendor, built.requirements, source).mediaInputMode).toBeUndefined();
    expect(convertLibraryWorkflow(vendor, built.graph, built.requirements, source).requiredInputs).toHaveLength(2);
  });

  it("preserves explicit required flags instead of applying automatic consumer rules", () => {
    const built = buildWorkflowImport(fixture(), { ...options, bindings: { mediaInputs: [
      { nodeId: "a", field: "image", kind: "image", required: false },
      { nodeId: "b", field: "image", kind: "image", required: true },
    ] } }, schema);
    expect(built.config.mediaInputMode).toBe("explicit");
    expect(built.config.mediaInputPolicy).toBeUndefined();
    const restored = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(restored.inputSlots?.map(slot => slot.required)).toEqual([false, true]);
    expect(restored.template?.a.inputs.image).toBe("required-source.png");
    expect(restored.mediaInputMode).toBe("explicit");
  });

  it("stores a group minimum without forcing one particular dynamic reference slot", () => {
    const graph = fixture(); delete graph.mix.inputs.main;
    const variableOnly = structuredClone(schema);
    delete (variableOnly.ForeignReferenceMixer_7408.input.required as Record<string, unknown>).main;
    (variableOnly.ForeignReferenceMixer_7408.input.required.references[1] as Record<string, any>).template.min = 1;
    const built = buildWorkflowImport(graph, options, variableOnly);
    const restored = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
    expect(restored.requiredInputs).toEqual([]);
    expect(restored.mediaInputPolicy?.groups).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "mix", minimum: 1, fields: ["references.reference_0", "references.reference_1"] })]));
  });

  it("rejects malformed persisted policy instead of interpreting invalid group minima", () => {
    const built = buildWorkflowImport(fixture(), options, schema);
    const invalid = { ...built.config, mediaInputPolicy: { optionalSemantics: [], removals: [], groups: [{ nodeId: "mix", label: "References", minimum: -1, fields: [] }] } };
    expect(() => convertLibraryWorkflow(invalid, built.graph, built.requirements, source)).toThrow("最少数量无效");
  });
});

const personalExecution = "E:/123/DFCine/DFCine0.26/workflows/library/Custom-b07642e2ed455db85378af37a2437df0c21460c6ffe4abda305f0b9fa6e8bc94/execution.api.json";
const liveSchema = ".cache/media-policy-object-info.json";
it.skipIf(!existsSync(personalExecution) || !existsSync(liveSchema))("recognizes optional extra images in the installed Qwen import without altering its package", () => {
  const before = readFileSync(personalExecution, "utf8");
  const graph = JSON.parse(before) as ApiWorkflow;
  const info = JSON.parse(readFileSync(liveSchema, "utf8"));
  const analysis = analyzeWorkflowImport(graph, info);
  expect(analysis.inputs).toHaveLength(6);
  expect(analysis.inputs.find(input => input.nodeId === "420")?.required).toBe(true);
  expect(analysis.inputs.find(input => input.nodeId === "432")?.required).toBe(false);
  const built = buildWorkflowImport(graph, { ...options, promptKey: "" }, info);
  expect(built.config.mediaInputMode).toBe("schema");
  const restored = convertLibraryWorkflow(built.config, built.graph, built.requirements, source);
  expect(restored.inputSlots?.filter(slot => slot.required)).toHaveLength(1);
  expect(restored.mediaInputPolicy?.optionalSemantics).toHaveLength(5);
  expect(readFileSync(personalExecution, "utf8")).toBe(before);
});
