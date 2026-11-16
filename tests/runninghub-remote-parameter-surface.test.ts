import { describe, expect, it } from "vitest";
import type { ApiWorkflow, Parameter, WorkflowDefinition } from "../src/types";
import { generationParameterSurface, runningHubRemoteCanvasParameterKeys } from "../src/generation/parameter-actions";
import { selectRunningHubBindings } from "../src/runninghub/selected-bindings";
import { buildWorkflow } from "../src/workflow-adapter/adapter";

function workflow(source?: ApiWorkflow): WorkflowDefinition {
  const template: ApiWorkflow = source ?? {
    clip: { class_type: "LoadCLIP", inputs: { clip_name: "clip.safetensors", device: "cuda", type: "qwen", dtype: "bf16" } },
    vae: { class_type: "VAELoader", inputs: { vae_name: "vae.safetensors" } },
    model: { class_type: "UNETLoader", inputs: { unet_name: "model.safetensors", weight_dtype: "default" } },
    llm: { class_type: "TextGenerateLTX2Prompt", inputs: { text: "original helper instruction", sampling_mode: "on", steps: 999, seed: 999, width: 999, height: 999 } },
    latent: { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 768, batch_size: 1 } },
    sampler: { class_type: "KSampler", inputs: { model: ["model", 0], positive: ["llm", 0], latent_image: ["latent", 0], seed: 10, steps: 20, cfg: 4, denoise: 1, sampler_name: "euler", scheduler: "normal" } },
    decode: { class_type: "VAEDecode", inputs: { samples: ["sampler", 0], vae: ["vae", 0] } },
    save: { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: "original" } },
  };
  const parameters: Parameter[] = [], mapping: WorkflowDefinition["mapping"] = [];
  for (const [nodeId, node] of Object.entries(template)) for (const [field, value] of Object.entries(node.inputs)) {
    if (!["number", "string", "boolean"].includes(typeof value)) continue;
    const key = nodeId + "_" + field;
    parameters.push({ key, label: field, type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "text", default: value as string | number | boolean });
    mapping.push({ semantic: key, nodeId, field });
  }
  return { id: "remote", family: "图像工具", name: "Remote", mode: "text-to-image", promptRequired: false,
    requiredInputs: [], optionalInputs: [], parameters, mapping, template,
    output: { nodeId: "save", field: "images", kind: "image" },
    runninghub: { workflowId: "123", baseUrl: "https://www.runninghub.cn", kind: "workflow", billingMode: "consumer", parameterSchemaVersion: 2, bindingMode: "selected", includeWorkflowJson: false, canvasParameterKeys: parameters.map(parameter => parameter.key) } };
}

describe("compact remote consumer workflow controls", () => {
  it("keeps main dimensions, seed and steps while hiding model/device/precision/helper and other internal controls", () => {
    const definition = workflow(), before = structuredClone(definition);
    const keys = runningHubRemoteCanvasParameterKeys(definition);
    expect(new Set(keys)).toEqual(new Set(["latent_width", "latent_height", "sampler_seed", "sampler_steps"]));
    const surface = generationParameterSurface(definition, { clip_device: "cpu", sampler_cfg: 99, llm_seed: 42 });
    expect(new Set(surface.basic.map(parameter => parameter.key))).toEqual(new Set(keys));
    expect(surface.advanced).toEqual([]); expect(surface.other).toEqual([]);
    expect(definition).toEqual(before);
  });

  it("removes internal overrides before execution while preserving their original server-template values", () => {
    const definition = workflow(), before = structuredClone(definition.template);
    const selected = selectRunningHubBindings(definition, runningHubRemoteCanvasParameterKeys(definition));
    const node = { id: "image", position: { x: 0, y: 0 }, data: { kind: "image-generation" as const, title: "Image", generation: { workflowId: selected.id, prompt: "", negativePrompt: "", params: { sampler_seed: 88, sampler_steps: 30 }, taskId: null } } };
    const execution = buildWorkflow(selected, node, [], {}).workflow;
    expect(selected.parameters.map(parameter => parameter.key)).not.toContain("clip_device");
    expect(selected.mapping.some(item => item.nodeId === "clip")).toBe(false);
    expect(execution.clip.inputs.device).toBe("cuda"); expect(execution.llm.inputs.seed).toBe(999);
    expect(execution.sampler.inputs.cfg).toBe(4); expect(execution.sampler.inputs.seed).toBe(88); expect(execution.sampler.inputs.steps).toBe(30);
    expect(selected.template).toEqual(before); expect(definition.template).toEqual(before);
  });

  it("honors an explicitly narrowed common-key selection without restoring adjusted internal fields", () => {
    const definition = workflow(); definition.runninghub!.canvasParameterKeys = ["sampler_seed", "clip_device"];
    expect(runningHubRemoteCanvasParameterKeys(definition)).toEqual(["sampler_seed"]);
    const surface = generationParameterSurface(definition, { clip_device: "cpu", sampler_steps: 99 });
    expect(surface.basic.map(parameter => parameter.key)).toEqual(["sampler_seed"]); expect(surface.other).toEqual([]);
    definition.runninghub!.canvasParameterKeys = [];
    expect(runningHubRemoteCanvasParameterKeys(definition)).toEqual([]);
  });

  it("supports custom video generators and one real video duration/ratio rather than prompt-generator helper controls", () => {
    const definition = workflow({
      prompt: { class_type: "TextGenerateLTX2Prompt", inputs: { steps: 500, seed: 123, text: "helper example", duration: 50, aspect_ratio: "4:3" } },
      h3: { class_type: "MiniMaxH3ReferenceToVideo", inputs: { prompt: ["prompt", 0], seed: 25, duration: 10, aspect_ratio: "9:16", megapixels: 1.5, steps: 4 } },
      save: { class_type: "VHS_VideoCombine", inputs: { images: ["h3", 0], frame_rate: 24, filename_prefix: "source" } },
    });
    definition.output = { nodeId: "save", field: "gifs", kind: "video" };
    const keys = runningHubRemoteCanvasParameterKeys(definition);
    expect(new Set(keys)).toEqual(new Set(["h3_seed", "h3_duration", "h3_aspect_ratio", "h3_megapixels", "h3_steps", "save_frame_rate"]));
    expect(keys.some(key => key.startsWith("prompt_"))).toBe(false); expect(keys.length).toBeLessThanOrEqual(7);
  });

  it("does not change the AI app public control contract or old nonconsumer workflow presentation", () => {
    const app = workflow(); app.runninghub!.kind = "app";
    expect(runningHubRemoteCanvasParameterKeys(app)).toEqual([]);
    expect(generationParameterSurface(app).basic).toHaveLength(app.parameters.length);
    const legacy = workflow(); delete legacy.runninghub!.billingMode;
    expect(generationParameterSurface(legacy).basic).toHaveLength(legacy.parameters.length);
  });
});
