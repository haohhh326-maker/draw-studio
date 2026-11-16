import { describe, expect, it } from "vitest";
import { selectWorkflowOutput } from "../src/workflow/execution";
import type { WorkflowDefinition } from "../src/types";

function workflow(): WorkflowDefinition {
  return {
    id: "multi-branch", name: "Multi-output", family: "Tests", description: "", mode: "text-to-image",
    requiredInputs: [], optionalInputs: [], parameters: [], mapping: [],
    template: {
      gen: { class_type: "VAEDecode", inputs: {} },
      normal: { class_type: "SaveImage", inputs: { images: ["gen", 0] } },
      upscale: { class_type: "ImageUpscaleWithModel", inputs: { image: ["gen", 0] } },
      hd: { class_type: "SaveImage", inputs: { images: ["upscale", 0] } },
      other: { class_type: "SaveImage", inputs: { images: ["gen", 0] } },
      internal: { class_type: "UnrelatedNode", inputs: {} },
    },
    output: { nodeId: "normal", field: "images", kind: "image" },
    additionalOutputs: [{ nodeId: "hd", field: "images", kind: "image" }, { nodeId: "other", field: "images", kind: "image" }],
    outputChoices: [
      { nodeId: "normal", field: "images", kind: "image", label: "Normal", issues: [] },
      { nodeId: "hd", field: "images", kind: "image", label: "HD", issues: [] },
    ],
    source: { file: "fixture.json", sha256: "fixture", sourceUrl: "", format: "api", models: [], missingNodes: [], missingModels: [], issues: [] },
  };
}

describe("multi-output execution branches", () => {
  it("prefers the genuine upscale branch by default and retains all declared publishing outputs", () => {
    const original = workflow(), snapshot = structuredClone(original);
    const selected = selectWorkflowOutput(original, {});
    expect(selected.output.nodeId).toBe("hd");
    expect(selected.additionalOutputs?.map(output => output.nodeId)).toEqual(["normal", "other"]);
    expect(Object.keys(selected.template!).sort()).toEqual(["gen", "hd", "normal", "other", "upscale"]);
    expect(original).toEqual(snapshot);
  });
  it("honors an explicit ordinary output choice without collecting an unexecuted HD branch", () => {
    const selected = selectWorkflowOutput(workflow(), { __output: "normal" });
    expect(selected.output.nodeId).toBe("normal");
    expect(selected.additionalOutputs).toEqual([]);
    expect(Object.keys(selected.template!).sort()).toEqual(["gen", "normal"]);
  });
  it("keeps a deployed RunningHub graph and its output contract untouched", () => {
    const remote = workflow(); remote.runninghub = { workflowId: "1234567890", baseUrl: "https://www.runninghub.cn", bindingMode: "selected" };
    expect(selectWorkflowOutput(remote, {})).toBe(remote);
  });
});
