import type { Asset, Canvas, CanvasNode, WorkflowDefinition } from "../types";
import { getBlob } from "../projects/storage";
import { parsePromptMentions, resolvePromptMentions } from "../semantic/mentions";
import { resolveInputs, workflowInputRoleLabel } from "../semantic/resolver";
import { assertNotAborted, imageVisionInput, optimizationMediaLimits, videoVisionInputs } from "./media";
import type { OptimizationContext, OptimizationReference, OptimizationTarget } from "./types";
import { activeOptimizationGraph, optimizationModelContext, optimizationModelGraph } from "./model-target";

export class OptimizationVisualError extends Error {
  readonly textOnlyAllowed = true;
  constructor(message: string) { super(message); this.name = "OptimizationVisualError"; }
}

/** The canvas note and a generation's input prompt are independent editors. */
export type OptimizationPromptField = "generation" | "text";

export function optimizationPromptField(node: CanvasNode, preferred?: OptimizationPromptField): OptimizationPromptField {
  return preferred ?? (node.data.generation ? "generation" : "text");
}

export function readOptimizationPrompt(node: CanvasNode, field?: OptimizationPromptField): string {
  return optimizationPromptField(node, field) === "text" ? node.data.text ?? "" : node.data.generation?.prompt ?? "";
}

/** Never create generation state or overwrite the other editor while optimizing. */
export function optimizationPromptPatch(node: CanvasNode, prompt: string, field?: OptimizationPromptField): Partial<CanvasNode["data"]> | null {
  if (optimizationPromptField(node, field) === "text") return { text: prompt };
  if (!node.data.generation) return null;
  return { generation: { ...node.data.generation, prompt } };
}

/**
 * A duration is useful prompt context only when the workflow explicitly exposes
 * its parameter binding. Labels such as "时长" are presentation data, so they
 * must not be used to guess a value. In particular, an image workflow can have
 * a similarly named numeric setting without having an output-video duration.
 */
function outputVideoDurationSeconds(node: CanvasNode, workflow?: WorkflowDefinition): number | undefined {
  if (workflow?.output.kind !== "video") return undefined;
  const parameterFor = (mapping: WorkflowDefinition["mapping"][number]) =>
    workflow.parameters.find(item => item.key === mapping.semantic && item.type === "number");
  const mapping = workflow.mapping.find(item => item.semantic === "duration" && parameterFor(item))
    ?? workflow.mapping.find(item => {
      if (item.field !== "duration_seconds") return false;
      const parameter = parameterFor(item);
      const target = workflow.template?.[item.nodeId];
      // This is the saved V3 MiniMax integration contract: the node owns the
      // duration_seconds input, and the parameter mapping points at that input.
      return parameter !== undefined && target?.class_type === "MiniMaxH3IntegrationGH" && typeof target.inputs.duration_seconds === "number";
    });
  if (!mapping) return undefined;
  const parameter = parameterFor(mapping);
  if (!parameter) return undefined;
  const raw = node.data.generation?.params[parameter.key] ?? parameter.default;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  if (parameter.min !== undefined && raw < parameter.min) return undefined;
  if (parameter.max !== undefined && raw > parameter.max) return undefined;
  return raw;
}

/** Only known node contracts refine an imported workflow's coarse input-count mode. */
export function optimizationWorkflowMode(node: CanvasNode, workflow?: WorkflowDefinition): string {
  if (!workflow?.template) return workflow?.mode ?? "text-tool";
  const graph = optimizationModelGraph(node, workflow)!;
  const linkedNode = (value: unknown): string | undefined => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]) && graph[value[0]] ? value[0] : undefined;
  const active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id) || !graph[id]) return;
    active.add(id);
    for (const value of Object.values(graph[id].inputs)) { const source = linkedNode(value); if (source) visit(source); }
  };
  visit(workflow.output.nodeId);
  const promptNode = workflow.mapping.find(item => item.semantic === "prompt")?.nodeId;
  const contract = (classType: string) => {
    if (promptNode && active.has(promptNode) && graph[promptNode]?.class_type === classType) return promptNode;
    const candidates = [...active].filter(id => graph[id].class_type === classType);
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  // Read parameter values through their saved binding; display labels and key
  // spelling are not contracts, and cannot identify a selected generation task.
  const valueFor = (id: string, field: string): unknown => {
    const mapping = workflow.mapping.find(item => item.nodeId === id && item.field === field);
    const parameter = mapping && workflow.parameters.find(item => item.key === mapping.semantic && !item.secret);
    return parameter ? node.data.generation?.params[parameter.key] ?? parameter.default : graph[id].inputs[field];
  };
  const provided = (value: unknown) => !!linkedNode(value) || typeof value === "string" && !!value.trim() && value !== "(none)";
  if (workflow.output.kind === "image") {
    const dynamic = workflow.dynamicReferences, destination = dynamic?.binding.targetNodeId;
    // Qwen 2.1's ordered image collection has dataType=any in the source
    // config, so the generic importer currently calls it text-to-image.
    if (destination && graph[destination]?.class_type === "TextEncodeQwenImage21"
      && dynamic?.routes.image?.targetInputPrefix === "images.image_"
      && (dynamic.constraints.minimumByType?.image ?? dynamic.constraints.minTotal) >= 1) return "image-to-image";
    if ([...active].some(id => graph[id].class_type === "TextEncodeQwenImageEditPlus" && Object.entries(graph[id].inputs).some(([field, value]) => /^image\d+$/.test(field) && provided(value)))) return "image-to-image";
  }
  if (workflow.output.kind !== "video") return workflow.mode;
  const integrated = contract("MiniMaxH3IntegrationGH");
  if (integrated) {
    let mode = valueFor(integrated, "main_mode");
    let media = Object.fromEntries(["first_frame", "last_frame", "hybrid_audio",
      ...Array.from({ length: 9 }, (_, i) => `ref_image_${i + 1}`),
      ...Array.from({ length: 3 }, (_, i) => `ref_video_${i + 1}`),
      ...Array.from({ length: 3 }, (_, i) => `ref_audio_${i + 1}`),
    ].map(field => [field, valueFor(integrated, field)]));
    // Match GH _restore_ui_state: serialized mode/media override the hidden
    // widgets, including an empty media array which clears stale filenames.
    const serialized = valueFor(integrated, "gh_state_json");
    if (typeof serialized === "string") {
      try {
        const state: unknown = JSON.parse(serialized);
        if (state && typeof state === "object" && !Array.isArray(state)) {
          const saved = state as Record<string, unknown>;
          if (saved.mode === "text_keyframes" || saved.mode === "all_reference") mode = saved.mode;
          if (Array.isArray(saved.media)) {
            const restored: Record<string, unknown> = {};
            for (const item of saved.media) if (Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && Object.hasOwn(media, item[0]) && item[1] && typeof item[1] === "object") {
              const name = (item[1] as Record<string, unknown>).name;
              if (typeof name === "string" && name && name !== "(none)") restored[item[0]] = name;
            }
            media = restored;
          }
        }
      } catch { /* GH also falls back to the individual fields for invalid JSON. */ }
    }
    // GH ignores its task_type widget and calls build_conditioning("auto").
    // all_reference excludes keyframes; text_keyframes excludes ref_* media.
    if (mode === "all_reference") return "multi-reference";
    if (mode === "text_keyframes") return provided(media.first_frame) ? provided(media.last_frame) ? "first-last-frame" : "image-to-video"
      : provided(media.last_frame) ? "last-frame" : "text-to-video";
    return workflow.mode;
  }
  const keyframes = contract("MiniMaxH3ImageToVideo");
  if (keyframes) {
    const first = provided(valueFor(keyframes, "first_frame")), last = provided(valueFor(keyframes, "last_frame"));
    return first ? last ? "first-last-frame" : "image-to-video" : last ? "last-frame" : "text-to-video";
  }
  if (contract("MiniMaxH3ReferenceToVideo")) return "multi-reference";
  const bernini = contract("BerniniConditioning");
  if (bernini) return provided(valueFor(bernini, "source_video")) ? "video-to-video"
    : Object.entries(graph[bernini].inputs).some(([field, value]) => /^reference_images\./.test(field) && provided(value)) ? "image-to-video" : "text-to-video";
  const wanKeyframes = contract("WanFirstLastFrameToVideo");
  if (wanKeyframes && provided(valueFor(wanKeyframes, "start_image")) && provided(valueFor(wanKeyframes, "end_image"))) return "first-last-frame";
  // KJ stores a declared capacity even when an image_N is absent. Only actual
  // image/index pairs are temporal anchors; an unconnected index is not a frame.
  const temporalGuides = [...active].filter(id => graph[id].class_type === "LTXVImgToVideoInplaceKJ").flatMap(id =>
    Object.entries(graph[id].inputs).filter(([field, value]) => /^num_images\.image_\d+$/.test(field) && provided(value)).map(([field]) => valueFor(id, field.replace("image_", "index_"))));
  if (temporalGuides.includes(0) && temporalGuides.includes(-1)) return "first-last-frame";
  if (contract("LTXVImgToVideoConditionOnly") && workflow.inputSlots?.some(slot => slot.kind === "video")) return "video-to-video";
  return workflow.mode;
}

export function describeOptimizationTarget(node: CanvasNode, workflow?: WorkflowDefinition, promptField?: OptimizationPromptField): OptimizationTarget {
  if (optimizationPromptField(node, promptField) === "text") return {
    model: "文本", modelIds: [], family: "", workflowId: "", workflowName: "文本提示词", mode: "text-tool", kind: "text", features: [], promptContract: "creative",
  };
  const params = node.data.generation?.params ?? {};
  const modelContext = optimizationModelContext(node, workflow);
  const selected = workflow?.parameters.filter(parameter => parameter.model && !parameter.secret)
    .flatMap(parameter => {
      const value = params[parameter.key] ?? parameter.default;
      return typeof value === "string" && modelContext.modelIds.includes(value) ? [parameter.label + ": " + value] : [];
    }) ?? [];
  const durationSeconds = outputVideoDurationSeconds(node, workflow);
  return {
    model: [workflow?.family, ...selected, ...modelContext.modelIds.filter(id => !selected.some(label => label.endsWith(": " + id)))].filter(Boolean).join("; ") || (node.data.kind === "text" ? "文本" : "未选择生成模型"),
    ...modelContext,
    family: workflow?.family ?? "",
    workflowId: workflow?.id ?? node.data.generation?.workflowId ?? "",
    workflowName: workflow?.name ?? (node.data.kind === "text" ? "文本提示词" : "未选择工作流"),
    mode: optimizationWorkflowMode(node, workflow),
    kind: workflow?.output.kind ?? (node.data.kind === "video" ? "video" : node.data.kind === "image-generation" ? "image" : "text"),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
}

/** Optional API image inputs select generation/editing only for an explicit
 * known model contract. Ordinary graph tasks never change by canvas image count. */
export function describeCanvasOptimizationTarget(canvas: Canvas, node: CanvasNode, workflow: WorkflowDefinition | undefined, assets: Record<string, Asset>, promptField?: OptimizationPromptField): OptimizationTarget {
  let target = describeOptimizationTarget(node, workflow, promptField);
  if (optimizationPromptField(node, promptField) === "text") return target;
  if ((workflow?.inputSlots?.some(slot => slot.kind === "audio") || workflow?.dynamicReferences?.routes.audio) && relatedEdges(canvas, node.id).some(edge => {
    const source = canvas.nodes.find(candidate => candidate.id === edge.source);
    return !!source?.data.assetId && assets[source.data.assetId]?.kind === "audio";
  })) target = { ...target, features: [...new Set([...(target.features ?? []), "audio-conditioned"])] };
  if (workflow?.library?.runnerType !== "api" || target.kind !== "image" || !["gpt-image-2", "nano-banana-pro"].includes(target.modelKey ?? "")) return target;
  const imageSlots = workflow.inputSlots?.filter(slot => slot.kind === "image") ?? [];
  if (!imageSlots.length || imageSlots.some(slot => slot.required)) return target;
  const images = relatedEdges(canvas, node.id).filter(edge => {
    const source = canvas.nodes.find(candidate => candidate.id === edge.source);
    return !!source?.data.assetId && assets[source.data.assetId]?.kind === "image";
  });
  return { ...target, mode: images.length ? "image-to-image" : "text-to-image" };
}

function relatedEdges(canvas: Canvas, nodeId: string) {
  const nodes = new Map(canvas.nodes.map(node => [node.id, node]));
  return canvas.edges.filter(edge => edge.target === nodeId && nodes.get(edge.source)?.data.kind !== "group")
    .slice().sort((a, b) => (a.data?.order ?? 0) - (b.data?.order ?? 0));
}

function textNode(node: CanvasNode) {
  return node.data.kind === "text" || (node.data.kind === "tool" && node.data.text !== undefined);
}

/** Only missing generation requirements are relaxed. Existing assignment and input role validation are reused. */
function contextRoles(canvas: Canvas, nodeId: string, workflow: WorkflowDefinition | undefined, assets: Record<string, Asset>) {
  if (!workflow) return new Map<string, string>();
  const semanticKinds: Record<string, string[]> = { image: ["images", "referenceImages", "firstFrame", "lastFrame"], video: ["videos", "referenceVideos"], audio: ["audios", "referenceAudios"] };
  const legacyInputs = new Set([...workflow.requiredInputs, ...workflow.optionalInputs, ...workflow.mapping.map(item => item.semantic)]);
  let ready = relatedEdges(canvas, nodeId).filter(edge => {
    const node = canvas.nodes.find(candidate => candidate.id === edge.source);
    const asset = node?.data.assetId ? assets[node.data.assetId] : undefined;
    if (!node || textNode(node)) return !!node;
    if (!asset || !["image", "video", "audio"].includes(asset.kind)) return false;
    if (workflow.muse) return true; // Muse reference roles are validated by the shared resolver below.
    const role = edge.data?.role ?? "auto", slot = workflow.inputSlots?.find(item => item.semantic === role);
    if (role.startsWith("slot:") && !slot) throw new Error("连线指定的输入已不存在于当前工作流，请重新选择素材输入。");
    if (slot && slot.kind !== asset.kind) throw new Error("输入「" + slot.label + "」的素材类型不符，请检查连线。");
    if ((role === "firstFrame" || role === "lastFrame") && asset.kind !== "image") throw new Error("首尾帧角色需要图片素材。");
    // Generation-input validation must not block visual context on text-only workflows.
    // References excluded here are still read below, keeping their explicit role or a generic reference label.
    return workflow.dynamicReferences ? !!workflow.dynamicReferences.routes[asset.kind] : workflow.inputSlots ? workflow.inputSlots.some(item => item.kind === asset.kind) :
      legacyInputs.has("references") || (semanticKinds[asset.kind] ?? []).some(semantic => legacyInputs.has(semantic));
  });
  // Removing required flags must not change AUTO's required-before-optional assignment.
  // Assign those original slots first, then let the existing resolver validate the assignment.
  if (workflow.inputSlots && !workflow.dynamicReferences) {
    const slots = workflow.inputSlots;
    const designated = new Map<string, string>();
    for (const edge of ready) {
      const source = canvas.nodes.find(candidate => candidate.id === edge.source)!;
      if (textNode(source)) continue;
      const asset = assets[source.data.assetId!];
      const role = edge.data?.role ?? "auto";
      const candidates = slots.filter(slot => slot.kind === asset.kind);
      const exact = slots.find(slot => slot.semantic === role);
      if (role.startsWith("slot:") && !exact) throw new Error("连线指定的输入已不存在于当前工作流，请重新选择素材输入。");
      if ((role === "firstFrame" || role === "lastFrame") && asset.kind !== "image") throw new Error("首尾帧角色需要图片素材。");
      const selected = exact ?? (role === "firstFrame" ? candidates[0] : role === "lastFrame" ? candidates.at(-1) : undefined);
      if (selected) designated.set(edge.id, selected.semantic);
    }
    const reserved = new Set(designated.values()), used = new Set<string>();
    ready = ready.map(edge => {
      const source = canvas.nodes.find(candidate => candidate.id === edge.source)!;
      if (textNode(source)) return edge;
      const asset = assets[source.data.assetId!];
      const candidates = slots.filter(slot => slot.kind === asset.kind);
      const available = candidates.filter(slot => !used.has(slot.semantic) && !reserved.has(slot.semantic));
      const selected = slots.find(slot => slot.semantic === designated.get(edge.id)) ?? available.find(slot => slot.required) ?? available[0];
      if (!selected) return edge;
      used.add(selected.semantic);
      return { ...edge, data: { ...edge.data, order: edge.data?.order ?? 0, role: selected.semantic as NonNullable<typeof edge.data>["role"] } };
    });
  }
  const relaxed: WorkflowDefinition = {
    ...workflow,
    requiredInputs: [],
    ...(workflow.inputSlots ? { inputSlots: workflow.inputSlots.map(slot => ({ ...slot, required: false })) } : {}),
    ...(workflow.dynamicReferences ? { dynamicReferences: { ...workflow.dynamicReferences, constraints: { minTotal: 0 } } } : {}),
  };
  return new Map(resolveInputs({ ...canvas, edges: ready }, nodeId, relaxed, assets).map(input => [input.edgeId, input.semantic]));
}

function labelForRole(workflow: WorkflowDefinition | undefined, role: string, kind: Asset["kind"]) {
  const common: Record<string, string> = {
    images: "主图参考", referenceImages: "参考图片", referenceVideos: "参考视频", videos: "视频输入",
    audios: "音频输入", referenceAudios: "参考音频", "dynamic:image": "多图参考", "dynamic:video": "参考视频", "dynamic:audio": "参考音频",
    reference: "参考素材", "text-context": "连接文本上下文", "extra-text-context": "额外连接文本上下文",
  };
  return common[role] ?? workflowInputRoleLabel(workflow, role, kind);
}

export async function collectOptimizationContext(
  canvas: Canvas,
  nodeId: string,
  workflow: WorkflowDefinition | undefined,
  assets: Record<string, Asset>,
  options: { signal?: AbortSignal; textOnly?: boolean; promptField?: OptimizationPromptField } = {},
): Promise<OptimizationContext> {
  assertNotAborted(options.signal);
  const node = canvas.nodes.find(candidate => candidate.id === nodeId);
  if (!node) throw new Error("当前提示词节点已不存在。");
  // A canvas text editor is independent of its optional generation workflow.
  // Speech/utility contracts, lyrics and negative inputs belong to that workflow.
  if (optimizationPromptField(node, options.promptField) === "text") workflow = undefined;
  const original = readOptimizationPrompt(node, options.promptField);
  if (resolvePromptMentions(original, canvas, nodeId).missingMentions.length)
    throw new Error("提示词引用了已断开连接的素材，请重新连接或移除对应 @ 引用。");
  const mentions: Record<string, string> = {};
  const tokenMarkers = new Map<string, string>();
  let markerIndex = 0;
  const prompt = parsePromptMentions(original).map(part => {
    if (part.type === "text") return part.text;
    let marker = tokenMarkers.get(part.token);
    if (!marker) {
      do { marker = "__DRAW_MENTION_" + markerIndex++ + "__"; } while (original.includes(marker));
      tokenMarkers.set(part.token, marker); mentions[marker] = part.token;
    }
    return marker;
  }).join("");
  const edges = relatedEdges(canvas, nodeId);
  const roles = contextRoles(canvas, nodeId, workflow, assets);
  const textSlots = workflow?.parameters.filter(parameter => parameter.inputText) ?? [];
  const references: OptimizationReference[] = [];
  let textIndex = 0, imageCount = 0, requestBytes = 0;
  for (const edge of edges) {
    assertNotAborted(options.signal);
    const source = canvas.nodes.find(candidate => candidate.id === edge.source);
    if (!source) throw new Error("当前节点连接的素材已不存在，请检查连线。");
    const asset = source.data.assetId ? assets[source.data.assetId] : undefined;
    const kind = textNode(source) ? "text" : asset?.kind ?? (source.data.kind === "video" ? "video" : source.data.kind === "audio" ? "audio" : "image");
    let role = edge.data?.role && edge.data.role !== "auto" ? edge.data.role : roles.get(edge.id) ?? "reference";
    let roleLabel = labelForRole(workflow, role, kind);
    if (textNode(source)) {
      const slot = textSlots[textIndex++];
      role = slot ? "inputText:" + slot.key : textSlots.length ? "extra-text-context" : "text-context";
      roleLabel = slot ? "工作流独立文本字段「" + slot.label + "」" : labelForRole(workflow, role, "text");
    }
    const reference: OptimizationReference = { nodeId: source.id, edgeId: edge.id, title: source.data.title, kind, role, roleLabel };
    if (textNode(source)) reference.text = source.data.text ?? "";
    else if (asset?.kind === "text") reference.text = asset.text ?? "";
    else if (!options.textOnly && (kind === "image" || kind === "video")) {
      if (!asset) throw new OptimizationVisualError("连接素材「" + source.data.title + "」尚未准备好，请上传或等待上游生成，或明确选择仅文本优化。");
      if (imageCount + (kind === "video" ? 3 : 1) > optimizationMediaLimits.images)
        throw new OptimizationVisualError("视觉参考超过 16 张图片/视频采样帧。请减少连接素材，或明确选择仅文本优化。");
      try {
        const blob = await getBlob(asset.id, asset.mime);
        assertNotAborted(options.signal);
        reference.images = kind === "video" ? await videoVisionInputs(blob, options) : [{ dataUrl: await imageVisionInput(blob, options) }];
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new OptimizationVisualError("素材「" + source.data.title + "」读取失败：" + (error instanceof Error ? error.message : "未知错误"));
      }
      imageCount += reference.images.length;
      requestBytes += reference.images.reduce((bytes, image) => bytes + image.dataUrl.length, 0);
      if (requestBytes > optimizationMediaLimits.requestBytes)
        throw new OptimizationVisualError("视觉素材请求超过 20 MiB，请减少连接素材或压缩图片后重试。");
    }
    references.push(reference);
  }
  const inputTexts = textSlots.filter(parameter => !parameter.secret).map(parameter => {
    const connected = references.find(ref => ref.role === "inputText:" + parameter.key);
    const value = connected?.text ?? node.data.generation?.params[parameter.key] ?? parameter.default;
    return { key: parameter.key, label: parameter.label, text: typeof value === "string" ? value : "", connected: !!connected };
  });
  return { target: describeCanvasOptimizationTarget(canvas, node, workflow, assets, options.promptField), prompt,
    negativePrompt: optimizationPromptField(node, options.promptField) === "text" ? "" : node.data.generation?.negativePrompt ?? "", inputTexts, references, mentions };
}

/** Snapshot comparison is limited to the target and its direct input nodes, never unrelated canvas data. */
export function optimizationContextIdentity(canvas: Canvas, nodeId: string, workflow: WorkflowDefinition | undefined, assets: Record<string, Asset>): string {
  const node = canvas.nodes.find(candidate => candidate.id === nodeId);
  const edges = relatedEdges(canvas, nodeId);
  return JSON.stringify({
    canvasId: canvas.id, nodeId, target: node ? { kind: node.data.kind, text: node.data.text, generation: node.data.generation } : null,
    workflow: workflow ? { id: workflow.id, family: workflow.family, generationModels: workflow.generationModels, name: workflow.name, mode: workflow.mode, optimizationTarget: node ? describeCanvasOptimizationTarget(canvas, node, workflow, assets) : undefined, graph: activeOptimizationGraph(workflow.template, workflow.output.nodeId), output: workflow.output,
      inputSlots: workflow.inputSlots, dynamicReferences: workflow.dynamicReferences, parameters: workflow.parameters, mapping: workflow.mapping } : null,
    inputs: edges.map(edge => {
      const source = canvas.nodes.find(candidate => candidate.id === edge.source);
      const asset = source?.data.assetId ? assets[source.data.assetId] : undefined;
      return { edge: { id: edge.id, source: edge.source, role: edge.data?.role, order: edge.data?.order },
        source: source ? { kind: source.data.kind, title: source.data.title, text: source.data.text, assetId: source.data.assetId } : null,
        asset: asset ? { id: asset.id, kind: asset.kind, mime: asset.mime, size: asset.size, createdAt: asset.createdAt, text: asset.text } : null };
    }),
  });
}
