import type { ApiWorkflow, CanvasNode, WorkflowDefinition } from "../types";
import { inferWorkflowModelNames } from "../workflow/import-classification";

const compact = (value: string) => value.toLowerCase().replace(/[\s_.\\/()（）-]+/g, "");
const unique = (values: string[]) => [...new Set(values.filter(value => value.trim()))];
const encoderWeight = (value: string) => /(?:^|[\\/])(?:text_encoders?|clip|vae|controlnet|mmproj)[\\/]|mmproj|text[_ -]?(?:encoder|projection)|(?:^|[_ .-])vae(?:[_ .-]|$)|qwen[_ .-]?(?:2[._]5[_ .-]?vl|3[_ .-]?(?:4b|8b)|3vl)|gemma|umt5|t5[_ .-]|clip[_ .-]/i.test(value);
const auxiliaryWeight = (value: string) => encoderWeight(value) || /(?:^|[\\/])loras?[\\/]|lightning|lightx2v|lora|film_20|multiple.angles|spatial.upscaler|detailer/i.test(value);

/** Canonical model identity uses model evidence, never workflow IDs or titles. */
export function resolveOptimizationModelKey(ids: string[] = [], family = "", kind = ""): string | undefined {
  const identify = (value: string): string | undefined => {
    const key = compact(value);
    if (/minimaxmusic3/.test(key)) return "minimax-music3";
    if (/minimaxh3|^h3(?:fl2|ref2|t2|i2)/.test(key)) return "minimax-h3";
    if (/bernini/.test(key)) return "wan-2.2-bernini";
    if (/scail2|scail_?2/.test(key)) return "wan-2.1-scail2";
    if (/wan22.*remix|remix.*wan22/.test(key)) return "wan-2.2-remix";
    if (/wan22/.test(key)) return "wan-2.2";
    if (/ltx23/.test(key)) return "ltx-2.3";
    if (/qwenimage21/.test(key)) return "qwen-image-2.1";
    if (/qwenimageedit2511/.test(key)) return "qwen-image-edit-2511";
    if (/qwenimage2512/.test(key)) return "qwen-image-2512";
    if (/qwenimage|qwenrapid/.test(key) && kind !== "text") return "qwen-image";
    if (/flux2.*klein|klein/.test(key)) return "flux-2-klein";
    if (/krea2/.test(key)) return "krea-2";
    if (/flux2/.test(key)) return "flux-2";
    if (/flux1/.test(key)) return "flux-1";
    if (/zimage|zimg/.test(key)) return "z-image";
    if (/voxcpm2/.test(key)) return "voxcpm-2";
    if (/gptimage2(?:official)?$/.test(key)) return "gpt-image-2";
    if (/nanobananapro|gemini3proimage/.test(key)) return "nano-banana-pro";
    if (/grok.*video|grok15/.test(key)) return "grok-video";
    if (/wan27/.test(key)) return "wan-2.7";
    return undefined;
  };
  // These IDs are main-model evidence. A merged checkpoint can legitimately
  // contain "LoRA", "Lightning" or "LightX2V" in its filename. Node roles, not
  // those substrings, exclude adapter branches when graph evidence is gathered.
  const recognized = unique(ids.filter(value => !encoderWeight(value)).map(identify).filter((value): value is string => !!value));
  if (recognized.length === 1) return recognized[0];
  if (recognized.length > 1) return undefined;
  const label = compact(family);
  if (/^minimaxh3(?:标准|加速|极速|standard|accelerated|fast)?$/.test(label)) return "minimax-h3";
  if (/^minimaxmusic(?:3)?$/.test(label)) return "minimax-music3";
  if (/^(?:flux2)?klein(?:图像|系列|9b)?$/.test(label)) return "flux-2-klein";
  if (/^krea2$/.test(label)) return "krea-2";
  if (/^zimage$/.test(label)) return "z-image";
  if (/^ltx23$/.test(label)) return "ltx-2.3";
  if (/^bernini$/.test(label)) return "wan-2.2-bernini";
  if (/^remix$/.test(label)) return "wan-2.2-remix";
  if (/^scail(?:2)?$/.test(label)) return "wan-2.1-scail2";
  if (/^voxcpm2$/.test(label)) return "voxcpm-2";
  if (/^qwen(?:图像|image)$/.test(label) && kind !== "text") return "qwen-image";
  return identify(family);
}

/** A private snapshot with current public parameters; the execution graph is never mutated. */
export function optimizationModelGraph(node: CanvasNode, workflow?: WorkflowDefinition): ApiWorkflow | undefined {
  if (!workflow?.template) return undefined;
  const graph = structuredClone(workflow.template);
  for (const parameter of workflow.parameters.filter(parameter => !parameter.secret)) {
    const value = node.data.generation?.params[parameter.key] ?? parameter.default;
    for (const binding of workflow.mapping.filter(item => item.semantic === parameter.key)) {
      const target = graph[binding.nodeId];
      if (!target) continue;
      if (binding.index === undefined) target.inputs[binding.field] = value;
      else { const list = target.inputs[binding.field]; if (Array.isArray(list)) list[binding.index] = value; }
    }
  }
  return graph;
}

/** Only the selected output's ancestors can contribute model or task contracts. */
export function activeOptimizationGraph(graph: ApiWorkflow | undefined, outputId: string): ApiWorkflow {
  if (!graph || !graph[outputId]) return {};
  const active: ApiWorkflow = Object.create(null);
  const visitValue = (value: unknown) => {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]) && graph[value[0]]) visit(value[0]);
    else if (Array.isArray(value)) value.forEach(visitValue);
    else if (value && typeof value === "object") Object.values(value).forEach(visitValue);
  };
  const visit = (id: string) => {
    if (active[id] || !graph[id]) return;
    active[id] = graph[id]; Object.values(graph[id].inputs).forEach(visitValue);
  };
  visit(outputId); return active;
}

export function optimizationModelContext(node: CanvasNode, workflow?: WorkflowDefinition) {
  const graph = optimizationModelGraph(node, workflow);
  const active = activeOptimizationGraph(graph, workflow?.output.nodeId ?? "");
  const selected = workflow?.parameters.filter(parameter => parameter.model && !parameter.secret).flatMap(parameter => {
    const value = node.data.generation?.params[parameter.key] ?? parameter.default;
    return typeof value === "string" && value.trim() && !auxiliaryWeight(value) ? [value] : [];
  }) ?? [];
  const primary = graph && Object.keys(active).length ? inferWorkflowModelNames(graph, { kind: workflow?.output.kind, outputNodeIds: [workflow!.output.nodeId] }).filter(value => !encoderWeight(value)) : [];
  const requirements = workflow?.original?.models.filter(item => !auxiliaryWeight(item.relativePath ?? item.name)).flatMap(item => [item.name, ...(item.relativePath ? [item.relativePath] : [])]).filter(value => !auxiliaryWeight(value)) ?? [];
  const modelIds = unique(primary.length ? primary : selected.length ? selected : workflow?.generationModels?.length ? workflow.generationModels : requirements);
  const kind = workflow?.output.kind ?? (node.data.kind === "text" ? "text" : "");
  let modelKey = resolveOptimizationModelKey(modelIds, workflow?.family ?? "", kind);
  const types = Object.values(active).map(item => item.class_type);
  // Explicit node architecture is stronger than a coarse directory category.
  if (!modelKey && types.some(type => type === "MiniMaxH3IntegrationGH" || type === "MiniMaxH3ImageToVideo" || type === "MiniMaxH3ReferenceToVideo")) modelKey = "minimax-h3";
  if (!modelKey && types.includes("TextEncodeQwenImage21")) modelKey = "qwen-image-2.1";
  const features: string[] = [];
  const activeWeights = Object.values(active).filter(item => !/lora/i.test(item.class_type) || item.inputs.strength_model !== 0).flatMap(item => Object.entries(item.inputs).filter(([field, value]) => /(?:lora|model|unet|checkpoint)/i.test(field) && typeof value === "string").map(([, value]) => String(value)));
  if (types.includes("LiconMSR") || activeWeights.some(value => /LTX.?2[._-]?3.?Licon.?MSR.?V2/i.test(value))) features.push("msr-v2");
  if (types.includes("PromptRelayEncode") && workflow?.mapping.some(item => item.semantic === "prompt" && active[item.nodeId]?.class_type === "PromptRelayEncode" && item.field === "global_prompt")) features.push("prompt-relay-global");
  if (workflow?.inputSlots?.some(slot => slot.kind === "audio" && slot.required)) features.push("audio-conditioned");
  if (activeWeights.some(value => /qwen.image.edit.2511.multiple.angles.lora/i.test(value))) features.push("camera-angle");
  if (activeWeights.some(value => /(?:^|[\\/])film_20\.(?:safetensors|gguf)$/i.test(value))) features.push("film-trigger");
  if (Object.values(active).some(item => (item.class_type === "TextEncodeQwenImageEditPlus" || item.class_type === "TextEncodeQwenImage21") && Object.entries(item.inputs).some(([field, value]) => /^(?:image\d+|images\.image_\d+)$/.test(field) && (Array.isArray(value) || typeof value === "string" && !!value.trim())))
    || workflow?.dynamicReferences?.routes.image?.targetInputPrefix === "images.image_" && (workflow.dynamicReferences.constraints.minimumByType?.image ?? workflow.dynamicReferences.constraints.minTotal) >= 1) features.push("ordered-image-edit");
  const prompt = workflow?.mapping.find(item => item.semantic === "prompt");
  const promptNode = prompt && active[prompt.nodeId];
  const speech = promptNode?.class_type === "RunningHub_VoxCPM_Generate" && prompt?.field === "text";
  const declaredApiPrompt = workflow?.library?.runnerType === "api" && !!workflow.generationModels?.length;
  const utility = (!!workflow && !prompt && !workflow.original?.promptBinding && !declaredApiPrompt) || activeWeights.some(value => /ic.subtitles.remove|ic.watermark.remove/i.test(value));
  const promptContract = features.includes("camera-angle") ? "fixed-vocabulary" as const : speech ? "verbatim" as const : utility ? "utility" as const : "creative" as const;
  return { modelIds, ...(modelKey ? { modelKey } : {}), features, promptContract };
}
