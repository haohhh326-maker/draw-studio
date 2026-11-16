import { describe, expect, it } from "vitest";
import type { Asset, CanvasNode, WorkflowDefinition } from "../src/types";
import { withServerMediaInputs } from "../src/workflow/media-input-definition";
import { buildWorkflow } from "../src/workflow-adapter/adapter";

const schema = {
  RequiredImage: { input: { required: { image: ["IMAGE"] } } },
  ManyImages: { input: { required: { images: ["COMFY_AUTOGROW_V3", { template: {
    input: { required: { image: ["IMAGE"] } }, names: ["image_1", "image_2"], min: 1,
  } }] } } },
  SaveImage: { input: { required: { images: ["IMAGE"] } } },
};
function definition(): WorkflowDefinition {
  return {
    id: "library-custom.old", name: "Imported multi-image workflow", family: "Imports", description: "",
    mode: "image-to-image", mediaInputMode: "schema", promptRequired: false, parameters: [],
    inputSlots: [
      { semantic: "slot:input1", kind: "image", label: "Main image", required: true },
      { semantic: "slot:input2", kind: "image", label: "Extra reference", required: true },
    ],
    requiredInputs: ["slot:input1", "slot:input2"], optionalInputs: [],
    mapping: [{ semantic: "slot:input1", nodeId: "1", field: "image" }, { semantic: "slot:input2", nodeId: "2", field: "image" }],
    template: {
      "1": { class_type: "LoadImage", inputs: { image: "" } },
      "2": { class_type: "LoadImage", inputs: { image: "" } },
      "3": { class_type: "RequiredImage", inputs: { image: ["1", 0] } },
      "4": { class_type: "ManyImages", inputs: { "images.image_1": ["1", 0], "images.image_2": ["2", 0] } },
      "5": { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "example" } },
      "6": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "main" } },
    },
    output: { nodeId: "5", field: "images", kind: "image" },
    additionalOutputs: [{ nodeId: "6", field: "images", kind: "image" }],
  };
}
const node: CanvasNode = { id: "dest", position: { x: 0, y: 0 }, data: { title: "Result", kind: "image-generation", generation: {
  workflowId: "library-custom.old", prompt: "", negativePrompt: "", params: {}, taskId: null,
} } };
const asset: Asset = { id: "asset", name: "user.png", mime: "image/png", kind: "image", size: 1, createdAt: 0 };

describe("schema-driven imported media execution", () => {
  it("refreshes an old six-style required contract and prunes unused example loaders from the submitted copy", () => {
    const original = definition(), before = structuredClone(original);
    const effective = withServerMediaInputs(original, schema);
    expect(effective.requiredInputs).toEqual(["slot:input1"]);
    expect(effective.optionalInputs).toEqual(["slot:input2"]);
    const built = buildWorkflow(effective, node, [{ semantic: "slot:input1", asset, edgeId: "edge" }], { asset: "task/user.png" }, "task/result");
    expect(built.workflow["1"].inputs.image).toBe("task/user.png");
    expect(built.workflow["2"]).toBeUndefined();
    expect(built.workflow["4"].inputs).toEqual({ "images.image_1": ["1", 0] });
    expect(built.workflow["5"].inputs.filename_prefix).toBe("task/result");
    expect(built.workflow["6"].inputs.filename_prefix).toBe("task/result-output-1");
    expect(original).toEqual(before);
  });

  it("keeps explicit user contracts and vendor contracts intact", () => {
    for (const mode of ["explicit", undefined] as const) {
      const original = { ...definition(), mediaInputMode: mode };
      expect(withServerMediaInputs(original, schema)).toBe(original);
    }
  });

  it("cannot reuse a cached optional rule when the current server makes the input required", () => {
    const original = definition();
    original.mediaInputPolicy = { optionalSemantics: ["slot:input2"], removals: [], groups: [] };
    const changed = { ...schema, ManyImages: { input: { required: { "images.image_1": ["IMAGE"], "images.image_2": ["IMAGE"] } } } };
    const effective = withServerMediaInputs(original, changed);
    expect(effective.requiredInputs).toEqual(["slot:input1", "slot:input2"]);
    expect(effective.mediaInputPolicy?.optionalSemantics).toEqual([]);
  });
});
