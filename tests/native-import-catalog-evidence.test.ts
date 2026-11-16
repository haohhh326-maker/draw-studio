import { expect, it } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";
import { buildImportEnvironmentDiagnostics, readImportEnvironmentReport, withImportEnvironmentCapabilities } from "../src/workflow/import-environment-diagnostics";
import { formatImportEnvironmentChecklist } from "../src/workflow/ImportEnvironmentReport";

it("does not confuse RunningHub's general model list with a task worker's installed inventory", async () => {
  const source = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1_bf16.safetensors" } },
    "2": { class_type: "PrivateNode", inputs: {} },
    "3": { class_type: "Sampler", inputs: { steps: "not a number" } },
  };
  const objectInfo = {
    UNETLoader: { input: { required: { unet_name: [["flux1-dev-fp8.safetensors"]] } }, output: ["MODEL"] },
    Sampler: { input: { required: { steps: ["INT"] } }, output: [] },
  };
  const read = await readAIFisherWorkflow({ environment: "comfyui", source, objectInfo }) as AifisherWorkflowReadResult;
  const original = JSON.stringify(source);
  const live = buildImportEnvironmentDiagnostics(read, { source, objectInfo, capabilities: "live" });
  const platform = withImportEnvironmentCapabilities(live, "platform");
  expect(live.issues.filter(issue => ["1", "2"].includes(issue.nodeId!)).every(issue => issue.severity === "error")).toBe(true);
  expect(platform.issues.filter(issue => ["1", "2"].includes(issue.nodeId!)).every(issue => issue.severity === "warning")).toBe(true);
  expect(platform.issues.find(issue => issue.nodeId === "1")).toMatchObject({ actualValue: "qwen_image_2.1_bf16.safetensors", allowedValues: ["flux1-dev-fp8.safetensors"] });
  expect(platform.issues.find(issue => issue.nodeId === "3")?.severity).toBe("error");
  expect(platform.counts.blocking).toBe(1);
  expect(readImportEnvironmentReport(JSON.parse(JSON.stringify(platform)))).toEqual(platform);
  expect(formatImportEnvironmentChecklist(platform)).toContain("平台模型待确认");
  expect(JSON.stringify(source)).toBe(original);
});

it("does not downgrade malformed model values or missing required inputs on the platform", async () => {
  const source = {
    wrongType: { class_type: "UNETLoader", inputs: { unet_name: 123 } },
    blank: { class_type: "UNETLoader", inputs: { unet_name: "" } },
    numeric: { class_type: "ModelWeight", inputs: { model_weight: "wrong.safetensors" } },
    missing: { class_type: "UNETLoader", inputs: {} },
  };
  const objectInfo = {
    UNETLoader: { input: { required: { unet_name: [["qwen.safetensors"]] } }, output: ["MODEL"] },
    ModelWeight: { input: { required: { model_weight: ["FLOAT", { min: 0, max: 1 }] } }, output: ["MODEL"] },
  };
  const read = await readAIFisherWorkflow({ environment: "comfyui", source, objectInfo }) as AifisherWorkflowReadResult;
  const platform = buildImportEnvironmentDiagnostics(read, { source, objectInfo, capabilities: "platform" });
  expect(platform.issues).toHaveLength(4);
  expect(platform.issues.every(issue => issue.severity === "error")).toBe(true);
  expect(platform.counts.blocking).toBe(4);
  expect(readImportEnvironmentReport(JSON.parse(JSON.stringify(platform)))?.counts.blocking).toBe(4);
});
