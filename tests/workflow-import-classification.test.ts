import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inferWorkflowFamily, inferWorkflowModelNames } from "../src/workflow/import-classification";
import { prepareWorkflowImport } from "../src/workflow/import-pipeline";
import { resolveWorkflowLibraryImport, writeWorkflowLibraryImport } from "../scripts/workflow-library-writer";
import { readWorkflowLibrary } from "../scripts/workflow-library-reader";

vi.mock("../src/workflow/aifisher-reader-client", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/workflow/aifisher-reader-client")>();
  const { readAIFisherWorkflow } = await import("../scripts/aifisher-workflow-reader");
  return { ...actual, readAifisherWorkflow: readAIFisherWorkflow };
});

const temporary: string[] = [];
afterEach(async () => {
  for (const folder of temporary.splice(0)) {
    if (path.dirname(path.resolve(folder)) !== path.resolve(os.tmpdir()) || !path.basename(folder).startsWith("canvas-classification-")) throw new Error("Invalid classification test cleanup path");
    await rm(folder, { recursive: true, force: true });
  }
});

const api = (model: string, extras: Record<string, unknown> = {}) => ({
  model: { class_type: "UNETLoader", inputs: { unet_name: model } },
  encoder: { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_4b_bf16.safetensors" } },
  prompt: { class_type: "CLIPTextEncode", inputs: { clip: ["encoder", 0], text: "A Qwen Image, Krea2 and VoxCPM poster" } },
  sampler: { class_type: "KSampler", inputs: { model: ["model", 0], positive: ["prompt", 0] } },
  decode: { class_type: "VAEDecode", inputs: { samples: ["sampler", 0] } },
  save: { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: "Qwen_Image" } },
  ...extras,
});

describe("persisted automatic import classification", () => {
  const editor = () => ({ version: 0.4, nodes: [
    { id: 1, type: "UNETLoader", widgets_values: { unet_name: "qwen_image_2.1_bf16.safetensors", weight_dtype: "default" }, inputs: [], outputs: [{ type: "MODEL", links: [1] }] },
    { id: 2, type: "OwnSamplerPlugin", widgets_values: { seed: 123 }, inputs: [{ name: "model", type: "MODEL", link: 1 }], outputs: [{ type: "IMAGE", links: [2] }] },
    { id: 3, type: "SaveImage", widgets_values: { filename_prefix: "author-prefix" }, inputs: [{ name: "images", type: "IMAGE", link: 2 }], outputs: [] },
  ], links: [[1, 1, 0, 2, 0, "MODEL"], [2, 2, 0, 3, 0, "IMAGE"]] });
  const info = {
    UNETLoader: { input: { required: { unet_name: [["qwen_image_2.1_bf16.safetensors"]], weight_dtype: [["default"]] } }, output: ["MODEL"] },
    OwnSamplerPlugin: { input: { required: { model: ["MODEL"], seed: ["INT"] } }, output: ["IMAGE"] },
    SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
  };
  const packageBytes = async (folder: string) => Object.fromEntries(await Promise.all((await readdir(folder)).map(async name => [name, await readFile(path.join(folder, name), "utf8")])));
  async function saved(source: unknown, filename: string, definitions?: Record<string, unknown>) {
    const prepared = await prepareWorkflowImport(source, filename, definitions);
    const folder = await mkdtemp(path.join(os.tmpdir(), "canvas-classification-")); temporary.push(folder);
    const result = await writeWorkflowLibraryImport(folder, { ...prepared, reuseExisting: true });
    const snapshot = await readWorkflowLibrary(folder);
    if (prepared.importState.status === "ready") expect(snapshot.issues).toEqual([]);
    expect(snapshot.workflows).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(result.path, "source.json"), "utf8"))).toEqual(source);
    return { prepared, folder, result, workflow: snapshot.workflows[0], config: JSON.parse(await readFile(path.join(result.path, "workflow.config.json"), "utf8")) };
  }

  it("persists the actual model series through ready API registration and directory reload", async () => {
    const source = { make: { class_type: "OwnImageGenerator", inputs: { model_name: "krea2_turbo.safetensors", prompt: "Qwen Image" } },
      save: { class_type: "SaveImage", inputs: { images: ["make", 0], filename_prefix: "Qwen Image" } } };
    const { prepared, workflow, config } = await saved(source, "Qwen Image misleading title.json");
    expect(prepared.importState.status).toBe("ready");
    expect(config.primaryCategoryLabel).toBe("Krea2");
    expect(workflow.family).toBe("Krea2");
    expect(workflow.template?.make.inputs.model_name).toBe("krea2_turbo.safetensors");
  });

  it("persists a real series for ordinary JSON even when its plugin prevents immediate conversion", async () => {
    const source = editor();
    const { prepared, workflow, config } = await saved(source, "Krea2 misleading title.json");
    expect(prepared.importState.status).toBe("pending");
    expect(config.primaryCategoryLabel).toBe("Qwen 图像");
    expect(workflow.family).toBe("Qwen 图像");
    expect(workflow.library?.importStatus).toBe("pending");
    expect(workflow.template).toBeUndefined();
  });

  it("gives ordinary and API JSON the same series after their actual graphs are available", async () => {
    const plain = await saved(editor(), "Krea2 misleading title.json", info);
    const apiSource = { model: { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1_bf16.safetensors" } },
      sample: { class_type: "OwnSamplerPlugin", inputs: { model: ["model", 0], seed: 123 } },
      save: { class_type: "SaveImage", inputs: { images: ["sample", 0], filename_prefix: "author" } } };
    const exported = await saved(apiSource, "Krea2 misleading title_api.json");
    expect(plain.prepared.importState.status).toBe("ready");
    expect(plain.workflow.family).toBe("Qwen 图像");
    expect(plain.workflow.family).toBe(exported.workflow.family);
    expect(plain.workflow.directory?.seriesId).toBe(exported.workflow.directory?.seriesId);
  });

  it.each(["ready", "pending"] as const)("reclassifies a legacy %s category during directory reading without changing package bytes", async state => {
    const imported = state === "pending" ? await saved(editor(), "legacy.json") : await saved({
      make: { class_type: "OwnImageGenerator", inputs: { model_name: "qwen_image.safetensors" } },
      save: { class_type: "SaveImage", inputs: { images: ["make", 0] } },
    }, "legacy_api.json");
    imported.config.primaryCategoryLabel = "我的工作流";
    await writeFile(path.join(imported.result.path, "workflow.config.json"), JSON.stringify(imported.config));
    const before = await packageBytes(imported.result.path);
    const reloaded = await readWorkflowLibrary(imported.folder);
    expect(reloaded.workflows[0].family).toBe("Qwen 图像");
    expect(reloaded.workflows[0].directory?.seriesId).toBe("library-" + encodeURIComponent("Qwen 图像"));
    expect(await packageBytes(imported.result.path)).toEqual(before);
  });

  it.each([
    ["recheck", "我的工作流", "Qwen 图像"],
    ["automatic upgrade", "我的工作流", "Qwen 图像"],
    ["recheck", "摄影工作流", "摄影工作流"],
    ["automatic upgrade", "摄影工作流", "摄影工作流"],
  ])("%s keeps the appropriate category when the saved category is %s", async (action, category, expected) => {
    const source = editor(), imported = await saved(source, "original.json");
    imported.config.primaryCategoryLabel = category;
    imported.config.nameLabel = "保留原名";
    await writeFile(path.join(imported.result.path, "workflow.config.json"), JSON.stringify(imported.config));
    const originalSource = await readFile(path.join(imported.result.path, "source.json"), "utf8");
    const metadataBefore = JSON.parse(await readFile(path.join(imported.result.path, "import.meta.json"), "utf8"));
    const result = action === "recheck"
      ? await resolveWorkflowLibraryImport(imported.folder, { workflowId: imported.result.workflowId, objectInfo: info })
      : await writeWorkflowLibraryImport(imported.folder, { ...await prepareWorkflowImport(source, "misleading-Krea2.json", info), reuseExisting: true });
    expect(result.status).toBe("ready");
    const reloaded = await readWorkflowLibrary(imported.folder);
    expect(reloaded.issues).toEqual([]);
    expect(reloaded.workflows[0].family).toBe(expected);
    expect(reloaded.workflows[0].name).toBe("保留原名");
    expect(JSON.parse(await readFile(path.join(result.path, "workflow.config.json"), "utf8")).primaryCategoryLabel).toBe(expected);
    expect(await readFile(path.join(result.path, "source.json"), "utf8")).toBe(originalSource);
    const metadataAfter = JSON.parse(await readFile(path.join(result.path, "import.meta.json"), "utf8"));
    expect(metadataAfter.importedAt).toBe(metadataBefore.importedAt);
    expect(metadataAfter.sourceSha256).toBe(metadataBefore.sourceSha256);
  });
});

describe("automatic imported workflow classification", () => {
  it.each([
    ["qwen_image_edit_2511_fp8mixed.safetensors", "Qwen 图像"],
    ["flux-2-klein-9b-fp8.safetensors", "Klein 系列"],
    ["krea2_turbo_fp8_scaled.safetensors", "Krea2"],
    ["z_image_turbo_bf16.safetensors", "Zimage"],
  ])("classifies a real diffusion model %s independently of the title and shared encoder", (model, expected) => {
    const source = api(model), before = structuredClone(source);
    expect(inferWorkflowFamily(source, { name: "Qwen Image 2.1 图像生成大合集.json", kind: "image" })).toBe(expected);
    expect(source).toEqual(before);
  });

  it("does not use user prompt, filename, note or shared encoder strings as generation model evidence", () => {
    const source = api("author-custom-model.safetensors", {
      note: { class_type: "MarkdownNote", inputs: { text: "minimax_h3_fl2va_bf16.safetensors" } },
      clip2: { class_type: "CLIPLoader", inputs: { clip_name: "qwen_image_text_encoder.safetensors" } },
    });
    expect(inferWorkflowFamily(source, { name: "Krea2.json" })).toBe("图像生成");
    expect(inferWorkflowFamily({ nodes: [{ id: 1, type: "PromptLoader", widgets_values: ["qwen_image.safetensors"] },
      { id: 2, type: "SaveImage", inputs: [{ name: "images", link: 1 }] }], links: [[1, 1, 0, 2, 0, "IMAGE"]] })).toBe("图像工具");
  });

  it("classifies API envelopes from their executable prompt and ignores stale editor metadata", () => {
    expect(inferWorkflowFamily({ prompt: api("krea2_turbo_fp8_scaled.safetensors"),
      workflow: { nodes: [{ id: 1, type: "UNETLoader", widgets_values: ["qwen_image.safetensors"] }] },
      metadata: { family: "VoxCPM", title: "MiniMax H3" } })).toBe("Krea2");
  });

  it("classifies ordinary JSON from loader widgets even before custom node schemas are available", () => {
    const source = { nodes: [
      { id: 1, type: "UNETLoader", widgets_values: ["qwen_image_2.1_bf16.safetensors", "default"] },
      { id: 2, type: "CustomSamplerPlugin", inputs: [{ name: "model", type: "MODEL", link: 1 }], widgets_values: ["Krea2 is just prompt text"] },
      { id: 3, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: 2 }] },
      { id: 4, type: "UNETLoader", mode: 2, widgets_values: ["krea2_turbo.safetensors"] },
      { id: 5, type: "UNETLoader", mode: 4, widgets_values: ["z_image_turbo.safetensors"] },
      { id: 6, type: "Note", widgets_values: ["minimax_music3_dit.safetensors"] },
    ], links: [[1, 1, 0, 2, 0, "MODEL"], [2, 2, 0, 3, 0, "IMAGE"]] };
    expect(inferWorkflowFamily(source)).toBe("Qwen 图像");
  });

  it("reads actual loader model declarations without searching arbitrary property strings", () => {
    const source = { nodes: [
      { id: 1, type: "CustomModelLoader", properties: { models: [{ name: "flux-2-klein-4b.gguf" }], description: "Qwen Image" } },
      { id: 2, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: 1 }] },
    ], links: [[1, 1, 0, 2, 0, "IMAGE"]] };
    expect(inferWorkflowFamily(source)).toBe("Klein 系列");
  });

  it("expands active nested subgraphs and ignores unused or muted subgraph definitions", () => {
    const source = { nodes: [
      { id: 10, type: "main-group" },
      { id: 11, type: "inactive-group", mode: 2 },
      { id: 12, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: 1 }] },
    ], links: [[1, 10, 0, 12, 0, "IMAGE"]], definitions: { subgraphs: [
      { id: "main-group", nodes: [{ id: 20, type: "model-group" }, { id: 21, type: "CustomSampler", inputs: [{ name: "model", type: "MODEL", link: 2 }] }],
        outputNode: { id: -20 }, links: [[2, 20, 0, 21, 0, "MODEL"], [3, 21, 0, -20, 0, "IMAGE"]] },
      { id: "model-group", nodes: [{ id: 1, type: "UNETLoader", widgets_values: ["z_image_turbo_bf16.safetensors"] }], outputNode: { id: -20 }, links: [[4, 1, 0, -20, 0, "MODEL"]] },
      { id: "inactive-group", nodes: [{ id: 1, type: "UNETLoader", widgets_values: ["minimax_h3_fl2va.safetensors"] }] },
      { id: "unused-group", nodes: [{ id: 1, type: "UNETLoader", widgets_values: ["qwen_image.safetensors"] }] },
    ] } };
    expect(inferWorkflowFamily(source)).toBe("Zimage");
  });

  it("reads instantiated legacy groups without letting their user chosen group names establish the family", () => {
    const source = { nodes: [{ id: 10, type: "workflow>Qwen display name" },
      { id: 11, type: "SaveImage", inputs: [{ name: "images", link: 1 }] }],
    links: [[1, 10, 0, 11, 0, "IMAGE"]], extra: { groupNodes: { "Qwen display name": {
      nodes: [{ type: "UNETLoader", widgets_values: ["krea2_turbo.safetensors"] },
        { type: "KSampler", inputs: [{ name: "model" }] }], links: [[0, 0, 1, 0, 0, "MODEL"]],
    } } } };
    expect(inferWorkflowFamily(source)).toBe("Krea2");
  });

  it("prefers the model of the final image generator over connected preprocessing and disconnected helpers", () => {
    const source = api("krea2_turbo.safetensors", {
      helperModel: { class_type: "UNETLoader", inputs: { unet_name: "qwen_image.safetensors" } },
      preprocessor: { class_type: "KSampler", inputs: { model: ["helperModel", 0] } },
      unused: { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo.safetensors" } },
    });
    source.sampler.inputs = { ...source.sampler.inputs, latent_image: ["preprocessor", 0] } as typeof source.sampler.inputs;
    expect(inferWorkflowFamily(source)).toBe("Krea2");
  });

  it.each([
    ["flux-2-klein-9b-fp8.safetensors", "SaveImage", "Klein 系列"],
    ["ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors", "SaveVideo", "LTX2.3"],
    ["minimax_h3_fl2va_int8_convrot.safetensors", "VHS_VideoCombine", "MiniMax H3 标准"],
  ])("follows SamplerCustomAdvanced guider model connections for %s", (model, output, expected) => {
    const source = {
      model: { class_type: "UNETLoader", inputs: { unet_name: model } },
      guider: { class_type: "BasicGuider", inputs: { model: ["model", 0], conditioning: ["preprocess", 0] } },
      sampler: { class_type: "SamplerCustomAdvanced", inputs: { guider: ["guider", 0], latent_image: ["preprocess", 0] } },
      otherModel: { class_type: "UNETLoader", inputs: { unet_name: "qwen_image.safetensors" } },
      preprocess: { class_type: "KSampler", inputs: { model: ["otherModel", 0] } },
      decode: { class_type: "VAEDecode", inputs: { samples: ["sampler", 0] } },
      save: { class_type: output, inputs: { images: ["decode", 0] } },
    };
    expect(inferWorkflowFamily(source)).toBe(expected);
    expect(inferWorkflowModelNames(source)).toEqual([model]);
  });

  it("follows SamplerFromSettings to its model without including image embedding preprocessing models", () => {
    const source = {
      model: { class_type: "WanAnimatePlus ModelLoader", inputs: { model: "wan2.1_14B_SCAIL_2_fp8_scaled.safetensors" } },
      patch: { class_type: "WanAnimatePlus SetBlockSwap", inputs: { model: ["model", 0] } },
      settings: { class_type: "WanAnimatePlus SamplerSettings", inputs: { model: ["patch", 0], image_embeds: ["preprocess", 0] } },
      sampler: { class_type: "WanAnimatePlus SamplerFromSettings", inputs: { sampler_inputs: ["settings", 0] } },
      otherModel: { class_type: "UNETLoader", inputs: { unet_name: "qwen_image.safetensors" } },
      preprocess: { class_type: "KSampler", inputs: { model: ["otherModel", 0] } },
      decode: { class_type: "WanAnimatePlus Decode", inputs: { samples: ["sampler", 0] } },
      save: { class_type: "VHS_VideoCombine", inputs: { images: ["decode", 0] } },
    };
    expect(inferWorkflowFamily(source)).toBe("Scail");
    expect(inferWorkflowModelNames(source)).toEqual(["wan2.1_14B_SCAIL_2_fp8_scaled.safetensors"]);
  });

  it("reads GGUF loader fields on the actual model branch", () => {
    const source = {
      model: { class_type: "LoaderGGUF", inputs: { gguf_name: "qwen_image_edit_2511_Q6_K.gguf" } },
      sampler: { class_type: "KSampler", inputs: { model: ["model", 0] } },
      save: { class_type: "SaveImage", inputs: { images: ["sampler", 0] } },
    };
    expect(inferWorkflowFamily(source)).toBe("Qwen 图像");
    expect(inferWorkflowModelNames(source)).toEqual(["qwen_image_edit_2511_Q6_K.gguf"]);
  });

  it("recognizes the H3 integration workflow through its guider, model switch and tiled output branches", () => {
    const source = {
      fl2va: { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_fl2va_int8_convrot.safetensors" } },
      ref2va: { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_ref2va_int8_convrot.safetensors" } },
      integration: { class_type: "MiniMaxH3IntegrationGH", inputs: { prompt: "A Klein and Qwen poster" } },
      adapter: { class_type: "MiniMaxH3IntegrationAdapterGH", inputs: { integration: ["integration", 0] } },
      switch: { class_type: "easy anythingIndexSwitch", inputs: { index: ["adapter", 4], value0: ["fl2va", 0], value1: ["ref2va", 0] } },
      patch: { class_type: "MiniMaxH3MemoryEfficientSageAttentionPatch", inputs: { model: ["switch", 0] } },
      clock: { class_type: "MiniMaxH3DualClockT8GH", inputs: { model: ["patch", 0], av_latent: ["adapter", 1] } },
      guider: { class_type: "BasicGuider", inputs: { model: ["clock", 0], conditioning: ["adapter", 0] } },
      sampler: { class_type: "SamplerCustomAdvanced", inputs: { guider: ["guider", 0], sampler: ["clock", 1], sigmas: ["clock", 2], latent_image: ["adapter", 1] } },
      upscaler: { class_type: "GoohaiMinimaxH3LatentUpscalerGH", inputs: { model_name: "minimax_h3_latent_upscaler_3d_fp16.safetensors", av_latent: ["sampler", 1] } },
      tiled: { class_type: "GoohaiMinimaxH3TiledSampler", inputs: { guider: ["guider", 0], latent_image: ["upscaler", 0] } },
      decode: { class_type: "MiniMaxH3AVDecodeT8GH", inputs: { av_latent: ["sampler", 1] } },
      tiledDecode: { class_type: "MiniMaxH3AVDecodeT8GH", inputs: { av_latent: ["tiled", 0] } },
      save: { class_type: "VHS_VideoCombine", inputs: { images: ["decode", 0] } },
      tiledSave: { class_type: "VHS_VideoCombine", inputs: { images: ["tiledDecode", 0] } },
    };
    expect(inferWorkflowFamily(source)).toBe("MiniMax H3 标准");
    expect(inferWorkflowModelNames(source)).toEqual([
      "minimax_h3_fl2va_int8_convrot.safetensors", "minimax_h3_ref2va_int8_convrot.safetensors",
    ]);
  });

  it("follows guider MODEL ports in unresolved editor workflows before their plugin definitions are available", () => {
    const source = { nodes: [
      { id: 1, type: "UNETLoader", widgets_values: ["flux-2-klein-9b-fp8.safetensors", "default"] },
      { id: 2, type: "CFGGuider", inputs: [{ name: "model", type: "MODEL", link: 1 }] },
      { id: 3, type: "SamplerCustomAdvanced", inputs: [{ name: "guider", type: "GUIDER", link: 2 }] },
      { id: 4, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: 3 }] },
    ], links: [[1, 1, 0, 2, 0, "MODEL"], [2, 2, 0, 3, 0, "GUIDER"], [3, 3, 0, 4, 0, "IMAGE"]] };
    expect(inferWorkflowFamily(source)).toBe("Klein 系列");
    expect(inferWorkflowModelNames(source)).toEqual(["flux-2-klein-9b-fp8.safetensors"]);
  });

  it("uses an honest general generation category when independent result branches use different families", () => {
    const source = api("qwen_image.safetensors", {
      secondModel: { class_type: "UNETLoader", inputs: { unet_name: "krea2_turbo.safetensors" } },
      secondSampler: { class_type: "KSampler", inputs: { model: ["secondModel", 0] } },
      secondSave: { class_type: "SaveImage", inputs: { images: ["secondSampler", 0] } },
    });
    expect(inferWorkflowFamily(source)).toBe("图像生成");
  });

  it("uses the primary output kind to classify compound workflows with independent media branches", () => {
    const source = api("qwen_image.safetensors", {
      videoModel: { class_type: "UNETLoader", inputs: { unet_name: "minimax_h3_ref2va.safetensors" } },
      videoMaker: { class_type: "CustomVideoGenerator", inputs: { model: ["videoModel", 0] } },
      videoSave: { class_type: "SaveVideo", inputs: { video: ["videoMaker", 0] } },
      text: { class_type: "TextWriter", inputs: { text: "Krea2" } },
    });
    expect(inferWorkflowFamily(source, { kind: "video" })).toBe("MiniMax H3 标准");
    expect(inferWorkflowFamily(source, { kind: "image" })).toBe("Qwen 图像");
  });

  it("uses explicit Set/Get editor connections without interpreting their user supplied alias as family evidence", () => {
    const source = { nodes: [
      { id: 1, type: "UNETLoader", widgets_values: ["krea2_turbo.safetensors"] },
      { id: 2, type: "SetNode", widgets_values: ["Qwen model display name"], inputs: [{ name: "MODEL", link: 1 }] },
      { id: 3, type: "GetNode", widgets_values: ["Qwen model display name"] },
      { id: 4, type: "KSampler", inputs: [{ name: "model", link: 2 }] },
      { id: 5, type: "SaveImage", inputs: [{ name: "images", link: 3 }] },
    ], links: [[1, 1, 0, 2, 0, "MODEL"], [2, 3, 0, 4, 0, "MODEL"], [3, 4, 0, 5, 0, "IMAGE"]] };
    expect(inferWorkflowFamily(source)).toBe("Krea2");
  });

  it.each([
    ["minimax_music3_dit_fp16.safetensors", "SaveAudio", "audio", "MiniMax Music"],
    ["minimax_h3_ref2va_bf16.safetensors", "SaveVideo", "video", "MiniMax H3 标准"],
    ["wan2.2_bernini_r_high_noise.safetensors", "SaveVideo", "video", "Bernini"],
    ["ltx-2.3-22b-distilled.safetensors", "SaveVideo", "video", "LTX2.3"],
  ])("recognizes media family from actual model %s", (model, output, kind, expected) => {
    expect(inferWorkflowFamily({ model: { class_type: "UNETLoader", inputs: { unet_name: model } },
      make: { class_type: "CustomGenerator", inputs: { model: ["model", 0] } },
      save: { class_type: output, inputs: { [kind]: ["make", 0] } } })).toBe(expected);
  });

  it("recognizes specialized generation nodes with model names that are not serialized", () => {
    expect(inferWorkflowFamily({ make: { class_type: "VoxCPMVoiceDesign", inputs: { text: "Qwen Image" } },
      save: { class_type: "SaveAudio", inputs: { audio: ["make", 0] } } })).toBe("VoxCPM");
  });

  it.each([
    [{ make: { class_type: "UnknownImageGenerator", inputs: {} }, save: { class_type: "SaveImage", inputs: { images: ["make", 0] } } }, "图像生成"],
    [api("custom.safetensors", { input: { class_type: "LoadImage", inputs: { image: "input.png" } }, sampler: { class_type: "KSampler", inputs: { model: ["model", 0], latent_image: ["input", 0] } } }), "图像编辑"],
    [{ make: { class_type: "ImageResize", inputs: {} }, save: { class_type: "SaveImage", inputs: { images: ["make", 0] } } }, "图像工具"],
    [{ make: { class_type: "UnknownVideoGenerator", inputs: {} }, save: { class_type: "SaveVideo", inputs: { video: ["make", 0] } } }, "视频生成"],
    [{ make: { class_type: "VideoMerge", inputs: {} }, save: { class_type: "SaveVideo", inputs: { video: ["make", 0] } } }, "视频工具"],
    [{ make: { class_type: "UnknownAudioGenerator", inputs: {} }, save: { class_type: "SaveAudio", inputs: { audio: ["make", 0] } } }, "音频生成"],
    [{ make: { class_type: "AudioTrim", inputs: {} }, save: { class_type: "SaveAudio", inputs: { audio: ["make", 0] } } }, "音频工具"],
    [{ text: { class_type: "TextWriter", inputs: { text: "Krea2" } } }, "文本工具"],
    [{ node: { class_type: "UnknownUtility", inputs: { prompt: "Qwen Image" } } }, "通用工具"],
  ])("gives unknown workflows a media/function category", (source, expected) => {
    expect(inferWorkflowFamily(source)).toBe(expected);
  });

  it("uses saved output contracts and kind hints when class names do not describe media", () => {
    const source = { nodes: [{ id: 1, type: "OwnResize", outputs: [{ type: "IMAGE" }] },
      { id: 2, type: "OwnOutput", inputs: [{ name: "value", type: "IMAGE", link: 1 }],
        node_def: { output_node: true, input: { required: { value: ["IMAGE"] } }, output: [] } }], links: [[1, 1, 0, 2, 0, "IMAGE"]] };
    expect(inferWorkflowFamily(source)).toBe("图像工具");
    expect(inferWorkflowFamily({ node: { class_type: "OwnOperation", inputs: {} } }, { kind: "audio" })).toBe("音频工具");
    expect(inferWorkflowFamily(null)).toBe("通用工具");
  });

  it("recognizes functions from custom node types even when an unresolved file has no known save node", () => {
    expect(inferWorkflowFamily({ nodes: [{ id: 1, type: "OwnImageGenerator", widgets_values: ["MiniMax H3 is only a prompt"] }], links: [] })).toBe("图像生成");
    expect(inferWorkflowFamily({ nodes: [{ id: 1, type: "OwnVideoTrim" }], links: [] })).toBe("视频工具");
    expect(inferWorkflowFamily({ nodes: [{ id: 1, type: "OwnSpeechGenerator" }], links: [] })).toBe("音频生成");
  });

  it("keeps real upscale models in tool categories", () => {
    expect(inferWorkflowFamily({ model: { class_type: "UNETLoader", inputs: { unet_name: "seedvr2_3b.safetensors" } },
      upscale: { class_type: "SeedVR2VideoUpscaler", inputs: { model: ["model", 0] } },
      save: { class_type: "SaveVideo", inputs: { video: ["upscale", 0] } } })).toBe("视频超分工具");
    expect(inferWorkflowFamily({ model: { class_type: "UpscaleModelLoader", inputs: { model_name: "RealESRGAN_x4.pth" } },
      upscale: { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["model", 0] } },
      save: { class_type: "SaveImage", inputs: { images: ["upscale", 0] } } })).toBe("图像工具");
    expect(inferWorkflowFamily({ model: { class_type: "SAMLoader", inputs: { model_name: "sam_vit_b_01ec64.pth" } },
      segment: { class_type: "Segmentation", inputs: { model: ["model", 0] } },
      save: { class_type: "SaveImage", inputs: { images: ["segment", 0] } } })).toBe("图像工具");
  });
});
