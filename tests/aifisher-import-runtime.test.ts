import { expect, it } from "vitest";
import { readAIFisherWorkflow } from "../scripts/aifisher-workflow-reader";
import { buildAifisherImportPackage } from "../src/workflow/aifisher-import-adapter";
import { convertLibraryWorkflow } from "../src/workflow/library-converter";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import type { AifisherWorkflowReadResult } from "../src/workflow/aifisher-reader-client";
import type { CanvasNode } from "../src/types";

it("keeps flattened ComfyUI parameter names literal through import, configuration and execution", async () => {
  const source = {
    prompt: { class_type: "Text", inputs: { text: "authored prompt" } },
    generator: { class_type: "DynamicGenerator", inputs: { sampling_mode: "on", "sampling_mode.temperature": 0.7, prompt: ["prompt", 0] } },
    output: { class_type: "SaveImage", inputs: { images: ["generator", 0], filename_prefix: "result" } },
  };
  const objectInfo = {
    Text: { input: { required: { text: ["STRING", { multiline: true }] } }, output: ["STRING"] },
    DynamicGenerator: { input: { required: { sampling_mode: [["on", "off"]], "sampling_mode.temperature": ["FLOAT", { min: 0, max: 2 }], prompt: ["STRING"] } }, output: ["IMAGE"] },
    SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
  };
  const read = await readAIFisherWorkflow({ environment: "comfyui", source, objectInfo }) as AifisherWorkflowReadResult;
  const prepared = buildAifisherImportPackage(read, "custom.flat", "Flat parameters");
  const definition = convertLibraryWorkflow(prepared.config, prepared.graph, prepared.requirements,
    { sourcePath: "fixture", folder: "flat", configSha256: "config", executionSha256: "graph", executionStatus: "plain" });
  const original = structuredClone(definition.template);
  const node: CanvasNode = { id: "canvas-node", position: { x: 0, y: 0 }, data: { title: "Test", kind: "image",
    generation: { prompt: "new prompt", negativePrompt: "", workflowId: definition.id, params: { "sampling_mode.temperature": 1.2 }, taskId: null } } };
  const built = buildWorkflow(definition, node, [], {});
  expect(built.workflow.generator.inputs).toEqual({ sampling_mode: "on", "sampling_mode.temperature": 1.2, prompt: ["prompt", 0] });
  expect(built.workflow.prompt.inputs.text).toBe("new prompt");
  expect(definition.template).toEqual(original);
  expect(source.generator.inputs["sampling_mode.temperature"]).toBe(0.7);
});
