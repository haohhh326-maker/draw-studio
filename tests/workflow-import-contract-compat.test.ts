import { describe, expect, it } from "vitest";
import { analyzeWorkflow } from "../vendor/aifisher/server/workflowRuntime/workflowFormat.js";
import { isWorkflowPresentationInput, revalidateWorkflowContracts } from "../scripts/workflow-import-contract-compat";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";

const match = (group = "switch", allowed = "*") => ["COMFY_MATCHTYPE_V3", { template: { template_id: group, allowed_types: allowed }, lazy: true }];
const info = () => ({
  Latent: { input: { required: {} }, output: ["LATENT"] },
  Image: { input: { required: {} }, output: ["IMAGE"] },
  ComfySwitchNode: { input: { required: { switch: ["BOOLEAN"] }, optional: { on_true: match(), on_false: match() } }, output: ["COMFY_MATCHTYPE_V3"], output_matchtypes: ["switch"] },
  KSampler: { input: { required: { latent_image: ["LATENT"] } }, output: ["LATENT"] },
  "Image Comparer (rgthree)": { input: { required: {}, optional: { image_a: ["IMAGE"], image_b: ["IMAGE"] } }, output: [], output_node: true },
});
const graph = () => ({
  "422": { class_type: "Latent", inputs: {} },
  "419": { class_type: "ComfySwitchNode", inputs: { switch: true, on_true: ["422", 0] } },
  "416": { class_type: "KSampler", inputs: { latent_image: ["419", 0] } },
});
const warningsFor = (workflow: Record<string, any>, objectInfo: Record<string, any>) => analyzeWorkflow(workflow, "comfy-api", { objectInfo }).warnings;

describe("MatchType contract compatibility", () => {
  it("reports missing source schema as unverified instead of claiming a proven type mismatch", async () => {
    const workflow = { source: { class_type: "PrivateImagePlugin", inputs: {} }, save: { class_type: "SaveImage", inputs: { images: ["source", 0] } } };
    const objectInfo = { SaveImage: { input: { required: { images: ["IMAGE"] } }, output: [], output_node: true } };
    const result = await readAIFisherWorkflow({ environment: "comfyui", source: workflow, objectInfo });
    expect(result.analysis.warnings).toContainEqual(expect.objectContaining({ code: "MISSING_NODE_TYPE", nodeId: "source" }));
    expect(result.analysis.warnings).toContainEqual(expect.objectContaining({ code: "RUNTIME_SLOT_UNVERIFIED", nodeId: "save" }));
    expect(result.analysis.warnings).not.toContainEqual(expect.objectContaining({ code: "RUNTIME_SLOT_MISMATCH" }));
    expect(result.workflow).toEqual(workflow);
    const known = { ...objectInfo, PrivateImagePlugin: { input: {}, output: ["LATENT"] } };
    expect(revalidateWorkflowContracts(workflow, known, warningsFor(workflow, known))).toContainEqual(expect.objectContaining({ code: "RUNTIME_SLOT_MISMATCH" }));
    const badSlot = structuredClone(workflow); badSlot.save.inputs.images = ["source", 99];
    expect(revalidateWorkflowContracts(badSlot, known, warningsFor(badSlot, known))).toContainEqual(expect.objectContaining({ code: "RUNTIME_SLOT_MISMATCH" }));
  });
  it("applies the compatibility check in the real reader while preserving the complete API graph", async () => {
    const workflow: Record<string, any> = graph();
    workflow["413"] = { class_type: "Image Comparer (rgthree)", inputs: { rgthree_comparer: { images: [] } } };
    const result = await readAIFisherWorkflow({ environment: "comfyui", source: workflow, objectInfo: info() });
    expect(result.analysis.warnings).toEqual([]);
    expect(result.workflow).toEqual(workflow);
  });
  it("resolves the actual linked type for both sides of a switch without rewriting graph or schema", () => {
    const workflow = graph(), objectInfo = info(), before = JSON.stringify({ workflow, objectInfo });
    const warnings = warningsFor(workflow, objectInfo);
    expect(warnings).toHaveLength(2);
    expect(revalidateWorkflowContracts(workflow, objectInfo, warnings)).toEqual([]);
    expect(JSON.stringify({ workflow, objectInfo })).toBe(before);
  });
  it.each(["ComfySwitchNode", "ComfySoftSwitchNode"])("uses the verified %s return contract when platform definitions omit output_matchtypes", classType => {
    const workflow: Record<string, any> = graph(), objectInfo: Record<string, any> = info();
    objectInfo[classType] = { ...objectInfo.ComfySwitchNode };
    delete objectInfo[classType].output_matchtypes;
    workflow["419"].class_type = classType;
    const before = JSON.stringify({ workflow, objectInfo });
    expect(revalidateWorkflowContracts(workflow, objectInfo, warningsFor(workflow, objectInfo))).toEqual([]);
    expect(JSON.stringify({ workflow, objectInfo })).toBe(before);
  });
  it("does not guess an output template for an arbitrary custom node with similar inputs", () => {
    const workflow: Record<string, any> = graph(), objectInfo: Record<string, any> = info();
    objectInfo.CustomSwitch = { ...objectInfo.ComfySwitchNode };
    delete objectInfo.CustomSwitch.output_matchtypes;
    workflow["419"].class_type = "CustomSwitch";
    expect(revalidateWorkflowContracts(workflow, objectInfo, warningsFor(workflow, objectInfo)))
      .toContainEqual(expect.objectContaining({ nodeId: "416", code: "RUNTIME_SLOT_MISMATCH" }));
  });
  it("resolves multiple linked matching nodes and separate instances independently", () => {
    const workflow: Record<string, any> = graph();
    workflow.second = { class_type: "ComfySwitchNode", inputs: { switch: false, on_false: ["419", 0] } };
    workflow["416"].inputs.latent_image = ["second", 0];
    workflow.image = { class_type: "Image", inputs: {} };
    workflow.other = { class_type: "ComfySwitchNode", inputs: { switch: true, on_true: ["image", 0] } };
    expect(revalidateWorkflowContracts(workflow, info(), warningsFor(workflow, info()))).toEqual([]);
  });
  it("retains a true output mismatch even though the incoming MatchType link is valid", () => {
    const workflow: Record<string, any> = graph(); workflow["422"].class_type = "Image";
    expect(revalidateWorkflowContracts(workflow, info(), warningsFor(workflow, info()))).toEqual([
      expect.objectContaining({ code: "RUNTIME_SLOT_MISMATCH", nodeId: "416", fieldName: "latent_image" }),
    ]);
  });
  it.each(["conflict", "allowed-types", "missing-template", "malformed-output-template", "cycle", "unknown", "bad-slot"])("does not validate unresolved/invalid %s contracts", mode => {
    const workflow: Record<string, any> = graph(), objectInfo: Record<string, any> = info();
    if (mode === "conflict") { workflow.image = { class_type: "Image", inputs: {} }; workflow["419"].inputs.on_false = ["image", 0]; }
    if (mode === "allowed-types") objectInfo.ComfySwitchNode.input.optional.on_true = match("switch", "IMAGE");
    if (mode === "missing-template") delete objectInfo.ComfySwitchNode.input.optional.on_true[1].template;
    if (mode === "malformed-output-template") objectInfo.ComfySwitchNode.output_matchtypes = [];
    if (mode === "cycle") workflow["419"].inputs.on_true = ["419", 0];
    if (mode === "unknown") objectInfo.Latent.output = ["*"];
    if (mode === "bad-slot") workflow["419"].inputs.on_true = ["422", 99];
    const warnings = warningsFor(workflow, objectInfo);
    const remaining = revalidateWorkflowContracts(workflow, objectInfo, warnings);
    expect(remaining).toContainEqual(expect.objectContaining({ code: "RUNTIME_SLOT_MISMATCH", nodeId: "416" }));
  });
  it("keeps ordinary invalid wiring and missing node definitions untouched", () => {
    const workflow: Record<string, any> = graph(); workflow["416"].inputs.latent_image = ["422", 1];
    const warnings = warningsFor(workflow, info());
    expect(revalidateWorkflowContracts(workflow, undefined, warnings)).toBe(warnings);
    expect(revalidateWorkflowContracts(workflow, info(), warnings)).toContainEqual(expect.objectContaining({ nodeId: "416", code: "RUNTIME_SLOT_MISMATCH" }));
  });
});

describe("serialized preview widget metadata", () => {
  const preview = () => ({ class_type: "Image Comparer (rgthree)", inputs: { rgthree_comparer: { images: [{ name: "A", selected: true, url: "https://example.invalid/preview?private=test" }] } } });
  it("recognizes only the upstream comparison widget and never dereferences its media", () => {
    const workflow = { "413": preview() }, objectInfo = info(), before = JSON.stringify(workflow);
    const warnings = warningsFor(workflow, objectInfo);
    expect(warnings).toContainEqual(expect.objectContaining({ code: "UNKNOWN_NODE_INPUT", fieldName: "rgthree_comparer" }));
    expect(revalidateWorkflowContracts(workflow, objectInfo, warnings)).toEqual([]);
    expect(JSON.stringify(workflow)).toBe(before);
  });
  it.each(["wrong-class", "invalid-value", "extra-field", "backend-field", "missing-schema"])("does not conceal %s", kind => {
    const node: Record<string, any> = preview(), schema: Record<string, any> = structuredClone(info()["Image Comparer (rgthree)"]);
    if (kind === "wrong-class") node.class_type = "AnotherComparer";
    if (kind === "invalid-value") node.inputs.rgthree_comparer = 12;
    if (kind === "extra-field") node.inputs.rgthree_comparer.images[0].execution = "unexpected";
    if (kind === "backend-field") schema.input.optional.rgthree_comparer = ["STRING"];
    expect(isWorkflowPresentationInput(node, "rgthree_comparer", kind === "missing-schema" ? undefined : schema)).toBe(false);
  });
});
