import type { ApiWorkflow } from "../types";
import { apiGraph, convertLibraryWorkflow } from "./library-converter";
import { workflowImportInputSchema } from "./import-editor";
import { inferMediaInputPolicy } from "./media-input-policy";
import { savedOutputContracts } from "./output-contracts";

type Data = Record<string, unknown>;
type Scalar = string | number | boolean;
export type ImportOutputKind = "image" | "video" | "audio" | "text" | "file";
export type ImportOutputBinding = { nodeId: string; field: string; kind: ImportOutputKind; label?: string };
export type ImportMediaBinding = { nodeId: string; field: string; kind: "image" | "video" | "audio"; label?: string; required?: boolean; pathMode?: "comfy-input" };
export type ImportBindings = { outputs?: ImportOutputBinding[]; mediaInputs?: ImportMediaBinding[] };
export type ImportAnalysis = {
  outputs: { nodeId: string; label: string; kind: ImportOutputKind; field: string; needsBinding?: boolean }[];
  fields: { nodeId: string; field: string; label: string; value: Scalar }[];
  prompts: { nodeId: string; field: string; label: string; value: string }[];
  inputs: (ImportMediaBinding & { label: string })[];
  warnings: string[];
  errors: string[];
};
export type ImportOptions = { id: string; name: string; family: string; outputNodeId?: string; promptKey?: string; bindings?: ImportBindings; preserveFullGraph?: boolean };

const asObject = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const scalar = (value: unknown): value is Scalar => typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
const literalWrapper = (value: unknown): value is { __value__: unknown } => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && "__value__" in value;
const connection = (value: unknown): value is [string, number] => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]);
const unique = (values: string[]) => [...new Set(values)];
const modelFile = (value: unknown): value is string => typeof value === "string" && /\.(safetensors|gguf|pt|pth|ckpt|bin|onnx)$/i.test(value);
const label = (id: string, graph: ApiWorkflow) => graph[id]._meta?.title || graph[id].class_type;

export const importOutputClasses = savedOutputContracts;

// These frontend helpers route or organize the graph rather than publish results.
// Keep exact supported helper semantics aligned with import-editor.ts's virtual/everywhere sets.
const virtualOutputHelpers = new Set([
  "Note", "MarkdownNote", "Reroute", "SetNode", "GetNode", "PrimitiveNode", "PrimitiveNodeValue",
  "Image Comparer (rgthree)", "Fast Groups Muter (rgthree)", "Fast Groups Bypasser (rgthree)",
  "FastGroupsBypasser", "FastGroupsMuter", "Power Puter (rgthree)",
  "Anything Everywhere", "Anything Everywhere3", "Anything Everywhere?",
]);

const mediaLoaders: Record<string, { kind: "image" | "video" | "audio"; fields: string[] }> = {
  LoadImage: { kind: "image", fields: ["image"] },
  LoadImageMask: { kind: "image", fields: ["image"] },
  "Image Load": { kind: "image", fields: ["image_path"] },
  VHS_LoadImagePath: { kind: "image", fields: ["image"] },
  LoadVideo: { kind: "video", fields: ["file", "video"] },
  VHS_LoadVideo: { kind: "video", fields: ["video"] },
  VHS_LoadVideoPath: { kind: "video", fields: ["video"] },
  LoadAudio: { kind: "audio", fields: ["audio"] },
  VHS_LoadAudio: { kind: "audio", fields: ["audio_file"] },
  VHS_LoadAudioUpload: { kind: "audio", fields: ["audio"] },
};

/** Upload metadata is an explicit file contract; names alone do not prove one. */
function uploadKind(spec: unknown): ImportMediaBinding["kind"] | undefined {
  const options = schemaSpec(spec).options;
  for (const kind of ["image", "video", "audio"] as const) if (options[kind + "_upload"] === true || options.upload === kind) return kind;
  return undefined;
}
const nonMediaFields = /prompt|text|instruction|message|description|caption|prose|story|content|system|positive|negative|model|weight|lora|vae|clip|checkpoint|ckpt|encoder|token|key|filename_prefix|save_output/i;
function mediaFileKind(value: unknown): ImportMediaBinding["kind"] | undefined {
  if (typeof value !== "string" || /[\r\n]/.test(value)) return undefined;
  if (/\.(png|jpe?g|webp|avif|bmp|tiff?|gif)(?:[?#].*)?$/i.test(value)) return "image";
  if (/\.(mp4|mov|webm|avi|mkv|mpe?g|m4v)(?:[?#].*)?$/i.test(value)) return "video";
  if (/\.(mp3|wav|ogg|flac|m4a|aac|opus)(?:[?#].*)?$/i.test(value)) return "audio";
  return undefined;
}
function inferredMediaKind(node: ApiWorkflow[string], field: string, info?: Data): ImportMediaBinding["kind"] | undefined {
  if (nonMediaFields.test(field)) return undefined;
  const kind = mediaFileKind(node.inputs[field]);
  if (!kind) return undefined;
  const outputs = asObject(info?.[node.class_type]).output;
  // Video frame loaders commonly expose IMAGE plus AUDIO rather than VIDEO.
  if (!Array.isArray(outputs) || !outputs.some(type => ["IMAGE", "VIDEO", "AUDIO"].includes(String(type)))) return undefined;
  return kind;
}
function autoMedia(graph: ApiWorkflow, info?: Data, outputIds: string[] = []): ImportAnalysis["inputs"] {
  const result: ImportAnalysis["inputs"] = [];
  for (const [id, node] of Object.entries(graph)) {
    const loader = mediaLoaders[node.class_type];
    const knownField = loader?.fields.find(field => typeof node.inputs[field] === "string");
    if (loader && knownField) result.push({ nodeId: id, field: knownField, kind: loader.kind, label: label(id, graph) + " · " + id, required: true });
    let fields: Data;
    try { fields = inputSchema(info, node); } catch { continue; } // Validation reports malformed schemas.
    for (const [field, value] of Object.entries(node.inputs)) {
      const spec = fields[field], kind = uploadKind(spec) ?? inferredMediaKind(node, field, info);
      const metadata = schemaSpec(spec).options;
      const pathMode = metadata.pathMode === "comfy-input" || metadata.path_mode === "comfy-input" ? "comfy-input" as const : undefined;
      const existing = result.find(input => input.nodeId === id && input.field === field);
      if (existing && pathMode) existing.pathMode = pathMode;
      if (kind && typeof value === "string" && !existing) result.push({ nodeId: id, field, kind, label: label(id, graph) + " · " + id + "." + field, required: true, ...(pathMode ? { pathMode } : {}) });
    }
  }
  const policy = inferMediaInputPolicy(graph, result.map((input, index) => ({ ...input, semantic: "slot:input" + (index + 1) })), info ?? {}, outputIds);
  const optional = new Set(policy.optionalSemantics);
  return result.map((input, index) => ({ ...input, required: !optional.has("slot:input" + (index + 1)) }));
}

// These core input contracts also catch incomplete API exports while offline.
const coreRequired: Record<string, Record<string, string>> = {
  KSampler: { model: "MODEL", positive: "CONDITIONING", negative: "CONDITIONING", latent_image: "LATENT" },
  KSamplerAdvanced: { model: "MODEL", positive: "CONDITIONING", negative: "CONDITIONING", latent_image: "LATENT" },
  VAEDecode: { samples: "LATENT", vae: "VAE" },
  VAEDecodeTiled: { samples: "LATENT", vae: "VAE" },
  VAEEncode: { pixels: "IMAGE", vae: "VAE" },
  VAEEncodeTiled: { pixels: "IMAGE", vae: "VAE" },
  CLIPTextEncode: { clip: "CLIP" },
  TextEncodeQwenImage21: { clip: "CLIP" },
  TextEncodeQwenImageEdit: { clip: "CLIP" },
  TextEncodeQwenImageEditPlus: { clip: "CLIP" },
  SaveImage: { images: "IMAGE" }, SaveImageAdvanced: { images: "IMAGE" }, PreviewImage: { images: "IMAGE" },
  SaveVideo: { video: "VIDEO" }, VHS_VideoCombine: { images: "IMAGE" },
  SaveAudio: { audio: "AUDIO" }, SaveAudioMP3: { audio: "AUDIO" }, SaveAudioAdvanced: { audio: "AUDIO" },
};
const primitiveTypes = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3"]);
const connectionTypes = new Set(["MODEL", "CLIP", "VAE", "IMAGE", "MASK", "LATENT", "AUDIO", "VIDEO", "CONDITIONING", "CONTROL_NET", "CLIP_VISION", "CLIP_VISION_OUTPUT", "UPSCALE_MODEL", "STYLE_MODEL", "SAMPLER", "SIGMAS", "GUIDER", "NOISE"]);
const requiresConnection = (type: string) => type.split(",").every(item => connectionTypes.has(item.trim()));
function inputSchema(info: Data | undefined, node: ApiWorkflow[string]): Data {
  const inputs = workflowImportInputSchema(node, info?.[node.class_type]);
  return { ...inputs.required, ...inputs.optional };
}
function schemaSpec(value: unknown): { type: unknown; options: Data } {
  if (!Array.isArray(value)) return { type: undefined, options: {} };
  const options = asObject(value[1]);
  if (value[0] === "COMBO" && Array.isArray(options.options) && options.options.every(scalar)) return { type: options.options, options };
  if (value[0] === "COMFY_MATCHTYPE_V3") {
    const allowed = asObject(options.template).allowed_types;
    return { type: typeof allowed === "string" ? allowed : Array.isArray(allowed) && allowed.every(type => typeof type === "string") ? allowed.join(",") : "*", options };
  }
  if (value[0] === "COMFY_DYNAMICCOMBO_V3" && Array.isArray(options.options)) {
    const choices = options.options.map(option => asObject(option).key);
    if (choices.every(scalar)) return { type: choices, options };
  }
  return { type: value[0], options };
}
function stableSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSchema);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableSchema(item)]));
  return value;
}
function branchStructure(value: unknown): unknown {
  const input = asObject(value);
  return Object.fromEntries(["required", "optional"].map(section => [section, Object.fromEntries(Object.entries(asObject(input[section])).map(([field, raw]) => {
    if (!Array.isArray(raw)) return [field, raw];
    const options = Object.fromEntries(Object.entries(asObject(raw[1])).filter(([key]) => !["default", "tooltip", "display_name"].includes(key)));
    if (raw[0] === "COMFY_DYNAMICCOMBO_V3" && Array.isArray(options.options)) options.options = options.options.map(option => ({ key: asObject(option).key, inputs: branchStructure(asObject(option).inputs) }));
    if (raw[0] === "COMFY_AUTOGROW_V3") options.template = { ...asObject(options.template), input: branchStructure(asObject(options.template).input) };
    return [field, [raw[0], options]];
  }))]));
}
/** Canvas controls describe the imported branch; compatible branches can share them. */
function dynamicChoices(rawSpec: unknown, selected: unknown): { choices: Scalar[]; limited: boolean } | undefined {
  if (!Array.isArray(rawSpec) || rawSpec[0] !== "COMFY_DYNAMICCOMBO_V3") return undefined;
  const options = asObject(rawSpec[1]).options;
  if (!Array.isArray(options)) return undefined;
  const current = options.find(option => asObject(option).key === selected);
  if (!current) return undefined;
  const signature = JSON.stringify(stableSchema(branchStructure(asObject(current).inputs)));
  const compatible = options.filter(option => JSON.stringify(stableSchema(branchStructure(asObject(option).inputs))) === signature);
  return { choices: compatible.map(option => asObject(option).key).filter(scalar), limited: compatible.length !== options.length };
}
function acceptsType(expected: unknown, actual: unknown) {
  if (typeof expected !== "string" || typeof actual !== "string" || expected === "*" || actual === "*") return true;
  return expected.split(",").map(type => type.trim()).some(type => actual.split(",").map(type => type.trim()).includes(type));
}

export function validateImportGraph(graph: ApiWorkflow, info?: Data, mediaBindings?: ImportMediaBinding[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const hasInfo = Boolean(info && Object.keys(info).length);
  if (!hasInfo) warnings.push("未读取云端节点定义；已检查工作流结构，节点和模型仍需连接 ComfyUI 后确认。");
  const schemas = new Map<string, { required: Data; optional: Data }>();
  for (const [id, node] of Object.entries(graph)) {
    try { schemas.set(id, workflowImportInputSchema(node, info?.[node.class_type])); }
    catch (error) { errors.push("节点输入定义无法解析（" + id + "）：" + (error instanceof Error ? error.message : String(error))); }
  }
  const resolvedTypes = new Map<string, unknown>();
  function outputType(id: string, index: number, resolving = new Set<string>()): unknown {
    const key = id + "\0" + index;
    if (resolvedTypes.has(key)) return resolvedTypes.get(key);
    if (resolving.has(key)) return undefined; // Cycle detection below supplies the structural error.
    const node = graph[id];
    if (!node) return undefined;
    const schema = asObject(info?.[node.class_type]);
    const rawType = Array.isArray(schema.output) ? schema.output[index] : undefined;
    if (rawType !== "COMFY_MATCHTYPE_V3") return rawType;
    const group = Array.isArray(schema.output_matchtypes) ? schema.output_matchtypes[index] : undefined;
    if (typeof group !== "string") return rawType;
    const fields = { ...schemas.get(id)?.required, ...schemas.get(id)?.optional };
    const matches = Object.entries(fields).filter(([, spec]) => Array.isArray(spec) && spec[0] === "COMFY_MATCHTYPE_V3" && asObject(asObject(spec[1]).template).template_id === group);
    if (!matches.length) return rawType;
    const next = new Set(resolving).add(key);
    const concrete: string[] = [];
    for (const [field] of matches) {
      const value = node.inputs[field];
      const resolved = connection(value) ? outputType(value[0], value[1], next)
        : literalWrapper(value) ? (Array.isArray(value.__value__) ? "LIST" : typeof value.__value__ === "string" ? "STRING" : typeof value.__value__ === "boolean" ? "BOOLEAN" : typeof value.__value__ === "number" ? Number.isInteger(value.__value__) ? "INT" : "FLOAT" : undefined)
        : typeof value === "string" ? "STRING" : typeof value === "boolean" ? "BOOLEAN" : typeof value === "number" ? Number.isInteger(value) ? "INT" : "FLOAT" : undefined;
      if (typeof resolved === "string" && resolved !== "*" && resolved !== "COMFY_MATCHTYPE_V3") concrete.push(resolved);
    }
    const kinds = unique(concrete);
    if (kinds.length > 1) errors.push("匹配端口类型不一致：" + id + " 模板 " + group + " 收到 " + kinds.join("、"));
    const declared = unique(matches.map(([, spec]) => schemaSpec(spec).type).filter((type): type is string => typeof type === "string"));
    const resolved = kinds.length === 1 ? kinds[0] : kinds.length > 1 ? kinds.join(",") : declared.includes("*") ? "*" : declared.length ? declared.join(",") : rawType;
    resolvedTypes.set(key, resolved);
    return resolved;
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) { errors.push("工作流存在循环连接：" + id); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const [field, value] of Object.entries(graph[id].inputs)) {
      if (!connection(value)) continue;
      if (!graph[value[0]]) { errors.push("连接引用不存在的节点：" + id + "." + field + " → " + value[0]); continue; }
      if (value[1] < 0) { errors.push("连接输出索引无效：" + id + "." + field); continue; }
      const sourceOutput = asObject(info?.[graph[value[0]].class_type]).output;
      if (Array.isArray(sourceOutput) && value[1] >= sourceOutput.length) errors.push("连接输出索引超出节点范围：" + id + "." + field);
      const targetFields = { ...schemas.get(id)?.required, ...schemas.get(id)?.optional };
      const targetType = schemaSpec(targetFields[field]).type;
      const sourceType = outputType(value[0], value[1]);
      if (Array.isArray(sourceOutput) && !acceptsType(targetType, sourceType)) errors.push("连接类型不匹配：" + id + "." + field + " 需要 " + String(targetType) + "，收到 " + String(sourceType));
      visit(value[0]);
    }
    visiting.delete(id); visited.add(id);
  }
  for (const [id, node] of Object.entries(graph)) {
    const nodeInfo = asObject(info?.[node.class_type]);
    if (hasInfo && !Object.keys(nodeInfo).length) warnings.push("当前节点定义未包含：" + node.class_type + "（" + id + "）；原始 API 输入已保留，缓存缺项不代表服务端一定未安装。");
    const declaredRequired = asObject(nodeInfo.input).required;
    const required = declaredRequired && typeof declaredRequired === "object" && !Array.isArray(declaredRequired)
      ? schemas.get(id)?.required ?? {}
      : Object.fromEntries(Object.entries(coreRequired[node.class_type] ?? {}).map(([field, type]) => [field, [type]]));
    for (const [field, rawSpec] of Object.entries(required)) {
      const spec = schemaSpec(rawSpec), value = node.inputs[field];
      const nullLiteral = spec.type === "JSON" || (spec.options.__canvas_literal === true && typeof spec.type === "string" && !requiresConnection(spec.type) && !primitiveTypes.has(spec.type));
      if (!(field in node.inputs) || (value === null && !nullLiteral) || value === undefined) {
        errors.push("缺少必填输入：" + label(id, graph) + "（" + id + "）." + field); continue;
      }
      if (connection(value) || literalWrapper(value)) continue;
      // forceInput controls frontend widgets; API primitive literals remain valid.
      if (typeof spec.type === "string" && requiresConnection(spec.type)) errors.push("缺少必需连接：" + label(id, graph) + "（" + id + "）." + field);
    }
    const fields = { ...schemas.get(id)?.required, ...schemas.get(id)?.optional };
    for (const [field, rawValue] of Object.entries(node.inputs)) {
      if (connection(rawValue)) continue;
      const value = literalWrapper(rawValue) ? rawValue.__value__ : rawValue;
      const { type, options } = schemaSpec(fields[field]);
      if (typeof type === "string" && type !== "*" && !primitiveTypes.has(type) && !requiresConnection(type) && !literalWrapper(rawValue)) warnings.push("自定义输入类型「" + type + "」的字面值已保留：" + id + "." + field + "；需由 ComfyUI 节点验证。");
      if (dynamicChoices(fields[field], value)?.limited) warnings.push("动态组合「" + label(id, graph) + " · " + field + "」仅支持已导入的参数结构；切换其他分支需在 ComfyUI 中更改后重新导入。");
      if (type === "INT" && (typeof value !== "number" || !Number.isInteger(value))) errors.push("整数参数无效：" + id + "." + field);
      if (type === "FLOAT" && (typeof value !== "number" || !Number.isFinite(value))) errors.push("数值参数无效：" + id + "." + field);
      if (type === "STRING" && typeof value !== "string") errors.push("文本参数无效：" + id + "." + field);
      if (type === "BOOLEAN" && typeof value !== "boolean") errors.push("布尔参数无效：" + id + "." + field);
      if (typeof value === "number" && (!Number.isFinite(value) || ((/seed/i.test(field) || type === "INT") && !Number.isSafeInteger(value)))) errors.push("数值超出安全整数范围：" + id + "." + field);
      if (typeof value === "number" && typeof options.min === "number" && value < options.min && !(field === "seed" && value === -1)) errors.push("参数低于最小值：" + id + "." + field);
      if (typeof value === "number" && typeof options.max === "number" && value > options.max) errors.push("参数超过最大值：" + id + "." + field);
      if (Array.isArray(type) && scalar(value) && !type.includes(value)) {
        const media = mediaLoaders[node.class_type];
        const manual = mediaBindings?.some(input => input.nodeId === id && input.field === field);
        if (manual || (mediaBindings === undefined && (media?.fields.includes(field) || uploadKind(fields[field]) || inferredMediaKind(node, field, info)))) continue; // Uploaded paths replace original local filenames.
        const message = "云端选项未包含：" + id + "." + field + " = " + String(value);
        if (modelFile(value)) warnings.push(message + "；导入后需准备对应模型。");
        else errors.push(message);
      }
    }
    visit(id);
  }
  return { errors: unique(errors), warnings: unique(warnings) };
}

function negativeBranches(graph: ApiWorkflow): Set<string> {
  const negative = new Set<string>(), positive = new Set<string>();
  function ancestors(id: string, target: Set<string>) {
    if (target.has(id) || !graph[id]) return;
    target.add(id);
    Object.values(graph[id].inputs).forEach(value => { if (connection(value)) ancestors(value[0], target); });
  }
  Object.values(graph).forEach(node => {
    Object.entries(node.inputs).forEach(([field, value]) => {
      if (connection(value) && /^(negative|negative_conditioning)$/.test(field)) ancestors(value[0], negative);
      if (connection(value) && /^(positive|positive_conditioning)$/.test(field)) ancestors(value[0], positive);
    });
  });
  return new Set([...negative].filter(id => !positive.has(id)));
}
function feedsField(graph: ApiWorkflow, id: string, accepts: (node: ApiWorkflow[string], field: string) => boolean): boolean {
  return Object.values(graph).some(node => Object.entries(node.inputs).some(([field, value]) => connection(value) && value[0] === id && value[1] === 0 && accepts(node, field)));
}
function promptField(id: string, field: string, graph: ApiWorkflow, negative: Set<string>) {
  if (/negative|system|template|filename|path|model|token|key/i.test(field)) return false;
  const node = graph[id];
  if (negative.has(id) || /negative|负面|负向|反向/i.test(node._meta?.title ?? "")) return false;
  if (field === "value" && ["PrimitiveString", "PrimitiveStringMultiline"].includes(node.class_type)) return feedsField(graph, id, (target, input) => /^(prompt|positive_prompt|positive_text|instruction|user_prompt|user_message)$/.test(input) || (/^(text|text_g|text_l)$/.test(input) && /encode|prompt|text|llm|qwen/i.test(target.class_type)));
  return /^(prompt|positive_prompt|positive_text|instruction|user_prompt|user_message)$/.test(field) || (/^(text|text_g|text_l)$/.test(field) && /encode|prompt|text|llm|qwen/i.test(node.class_type));
}

/** Execute the union of explicit output roots, preserving original links. */
function outputBranch(graph: ApiWorkflow, outputNodeIds: string[]): ApiWorkflow {
  const selected = new Set<string>();
  function add(id: string) {
    if (selected.has(id) || !graph[id]) return;
    selected.add(id);
    Object.values(graph[id].inputs).forEach(value => { if (connection(value)) add(value[0]); });
  }
  outputNodeIds.forEach(add);
  return Object.fromEntries(Object.entries(graph).filter(([id]) => selected.has(id)));
}

function outputBindingErrors(graph: ApiWorkflow, outputs: ImportOutputBinding[]): string[] {
  const errors: string[] = [], seen = new Set<string>();
  if (!outputs.length) errors.push("请至少绑定一个工作流输出。");
  for (const output of outputs) {
    if (!Object.hasOwn(graph, output.nodeId)) errors.push("输出绑定节点不存在：" + output.nodeId);
    if (typeof output.field !== "string" || !output.field.trim()) errors.push("请填写输出的 history 字段：" + output.nodeId);
    if (!["image", "video", "audio", "text", "file"].includes(output.kind)) errors.push("输出绑定类型无效：" + output.nodeId);
    const key = output.nodeId + "\0" + output.field;
    if (seen.has(key)) errors.push("重复输出绑定：" + output.nodeId + "." + output.field);
    seen.add(key);
  }
  return errors;
}
function mediaBindingErrors(graph: ApiWorkflow, inputs: ImportMediaBinding[]): string[] {
  const errors: string[] = [], seen = new Set<string>();
  for (const input of inputs) {
    const node = Object.hasOwn(graph, input.nodeId) ? graph[input.nodeId] : undefined;
    if (!node || !Object.hasOwn(node.inputs, input.field) || typeof node.inputs[input.field] !== "string") errors.push("素材绑定必须指向现有文本文件字段，不能覆盖连接：" + input.nodeId + "." + input.field);
    if (!["image", "video", "audio"].includes(input.kind)) errors.push("素材绑定类型无效：" + input.nodeId + "." + input.field);
    if (input.required !== undefined && typeof input.required !== "boolean") errors.push("素材必填设置无效：" + input.nodeId + "." + input.field);
    if (input.pathMode !== undefined && input.pathMode !== "comfy-input") errors.push("素材路径模式无效：" + input.nodeId + "." + input.field);
    const key = input.nodeId + "\0" + input.field;
    if (seen.has(key)) errors.push("重复素材绑定：" + input.nodeId + "." + input.field);
    seen.add(key);
  }
  return errors;
}

export function analyzeWorkflowImport(rawGraph: ApiWorkflow, info?: Data, outputNodeId?: string, bindings?: ImportBindings, preserveFullGraph = false): ImportAnalysis {
  const result: ImportAnalysis = { outputs: [], fields: [], prompts: [], inputs: [], warnings: [], errors: [] };
  let graph: ApiWorkflow;
  try { graph = apiGraph(rawGraph); } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); return result; }
  for (const [id, node] of Object.entries(graph)) {
    if (virtualOutputHelpers.has(node.class_type)) continue;
    const output = importOutputClasses[node.class_type];
    if (output) result.outputs.push({ nodeId: id, label: label(id, graph) + " · " + id, ...output });
    else if (asObject(info?.[node.class_type]).output_node === true) result.outputs.push({ nodeId: id, label: label(id, graph) + " · " + id, kind: "file", field: "*" });
  }
  const offline = !info || !Object.keys(info).length;
  if (offline || !result.outputs.length) {
    const upstream = new Set(Object.values(graph).flatMap(node => Object.values(node.inputs).filter(connection).map(link => link[0])));
    for (const [id, node] of Object.entries(graph)) if (!virtualOutputHelpers.has(node.class_type) && !upstream.has(id) && !result.outputs.some(output => output.nodeId === id) && asObject(info?.[node.class_type]).output_node !== false) {
      result.outputs.push({ nodeId: id, label: label(id, graph) + " · " + id, kind: "file", field: "*" });
      result.warnings.push((offline ? "离线" : "云端缺少输出节点元信息，") + "暂按终端节点「" + label(id, graph) + " · " + id + "」收集结果；该节点需在服务端注册为真实输出节点。");
    }
  }
  if (bindings?.outputs !== undefined) {
    result.errors.push(...outputBindingErrors(graph, bindings.outputs));
    // Explicit bindings override discovered contracts and may use any existing node.
    const explicitIds = new Set(bindings.outputs.map(output => output.nodeId));
    result.outputs = result.outputs.filter(output => !explicitIds.has(output.nodeId));
    result.outputs.push(...bindings.outputs.map(output => ({ ...output, label: output.label || (graph[output.nodeId] ? label(output.nodeId, graph) + " · " + output.nodeId : output.nodeId) })));
  }
  const selected = bindings?.outputs !== undefined ? bindings.outputs.map(output => output.nodeId) : outputNodeId ? [outputNodeId] : result.outputs.length === 1 ? [result.outputs[0].nodeId] : [];
  if (selected.some(id => !Object.hasOwn(graph, id))) { result.errors.push("所选输出节点不存在。"); return result; }
  if (selected.length && !preserveFullGraph) graph = outputBranch(graph, selected);
  if (bindings?.mediaInputs !== undefined) result.errors.push(...mediaBindingErrors(graph, bindings.mediaInputs));
  const validation = validateImportGraph(graph, info, bindings?.mediaInputs);
  result.errors.push(...validation.errors); result.warnings.push(...validation.warnings);
  result.inputs = bindings?.mediaInputs !== undefined ? bindings.mediaInputs.map(input => ({ ...input, label: input.label || (graph[input.nodeId] ? label(input.nodeId, graph) + " · " + input.nodeId + "." + input.field : input.nodeId), required: input.required !== false })) : autoMedia(graph, info, selected.length ? selected : result.outputs.map(output => output.nodeId));
  const negative = negativeBranches(graph);
  for (const [id, node] of Object.entries(graph)) {
    const media = mediaLoaders[node.class_type];
    if (bindings?.mediaInputs === undefined && media && !media.fields.some(field => typeof node.inputs[field] === "string" || connection(node.inputs[field]))) result.errors.push("素材加载器缺少文件输入：" + label(id, graph) + "（" + id + "）");
    for (const [field, value] of Object.entries(node.inputs)) {
      if (scalar(value)) result.fields.push({ nodeId: id, field, value, label: label(id, graph) + " · " + id + "." + field });
      if (typeof value === "string" && promptField(id, field, graph, negative)) result.prompts.push({ nodeId: id, field, value, label: label(id, graph) + " · " + id + "." + field });
    }
  }
  if (!result.prompts.length) {
    const mediaKeys = new Set(result.inputs.map(input => input.nodeId + "\0" + input.field));
    const candidates = result.fields.filter(field => {
      if (typeof field.value !== "string" || !field.value.trim() || mediaKeys.has(field.nodeId + "\0" + field.field) || negative.has(field.nodeId) || modelFile(field.value) || mediaFileKind(field.value)) return false;
      if (/(?:^|[_.])(?:aspect_?ratio|ratio|width|height)(?:$|[_.])/i.test(field.field) || /^\s*\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?(?:\s*\([^\n]*\))?\s*$/.test(field.value)) return false;
      if (/system|negative|template|model|weight|lora|vae|clip|checkpoint|ckpt|token|secret|key|file|path|src|directory|folder|sampler|scheduler|format|resolution|seed|save_output|dtype|precision|device|mode|method|preset|version|backend|provider|url/i.test(field.field)) return false;
      if (/^(?:[a-z]+:\/\/|[a-z]:[\\/]|[\\/])/i.test(field.value)) return false;
      let spec: unknown;
      try { spec = inputSchema(info, graph[field.nodeId])[field.field]; } catch { return false; }
      const type = schemaSpec(spec).type;
      return !Array.isArray(type) && type !== "COMBO";
    });
    if (candidates.length === 1) {
      const candidate = candidates[0];
      result.prompts.push({ ...candidate, value: candidate.value as string });
    }
  }
  if (!result.outputs.length) result.warnings.push("未自动发现输出契约；可手动绑定任意节点及其 history 输出字段。");
  if (result.outputs.some(output => output.field === "*")) result.warnings.push("自定义输出将在执行后从 history 自动识别媒体、文本及文件；若节点使用特殊返回结构，可选配置具体结果字段。");
  if (result.prompts.length > 1) result.warnings.push("检测到多个提示词字段，原值将保留为可编辑参数；可选指定一个画布主提示词。");
  if (result.outputs.some(output => graph[output.nodeId]?.class_type === "PreviewImage")) result.warnings.push("选择图像预览输出时，将在执行副本中补充 SaveImage，原始工作流保持不变。");
  result.errors = unique(result.errors); result.warnings = unique(result.warnings);
  return result;
}

const fieldLabels: Record<string, string> = {
  seed: "种子", noise_seed: "种子", steps: "步数", cfg: "CFG", width: "宽度", height: "高度", batch_size: "批次", denoise: "降噪强度",
  sampler_name: "采样器", scheduler: "调度器", negative_prompt: "负面提示词", system_prompt: "系统提示词", prompt: "提示词", text: "文本", aspect_ratio: "比例", megapixels: "百万像素", duration: "时长", frame_rate: "帧率",
};
const primaryFields = new Set(["seed", "noise_seed", "width", "height", "aspect_ratio", "megapixels", "duration"]);
function modelDirectory(classType: string, field: string): string | undefined {
  if (/lora/i.test(field + classType)) return "loras";
  if (/vae/i.test(field + classType)) return "vae";
  if (/clip|text_encoder/i.test(field + classType)) return "text_encoders";
  if (/controlnet/i.test(field + classType)) return "controlnet";
  if (/unet|diffusion/i.test(field + classType)) return "diffusion_models";
  if (/checkpoint|ckpt/i.test(field + classType)) return "checkpoints";
  return undefined;
}

export function buildWorkflowImport(rawGraph: ApiWorkflow, options: ImportOptions, info?: Data): { graph: ApiWorkflow; config: Data; requirements: Data; warnings: string[] } {
  const original = apiGraph(rawGraph), all = analyzeWorkflowImport(original, info, undefined, undefined, options.preserveFullGraph);
  if (!options.id.trim() || !options.name.trim() || !options.family.trim()) throw new Error("请填写工作流名称和系列。");
  const automatic = options.outputNodeId ? all.outputs.filter(output => output.nodeId === options.outputNodeId) : all.outputs;
  const outputs: ImportOutputBinding[] = options.bindings?.outputs !== undefined ? options.bindings.outputs : automatic;
  if (!outputs.length && all.errors.length) throw new Error(all.errors.join("\n"));
  if (!outputs.length) throw new Error("请选择工作流输出节点，或手动绑定输出节点及 history 字段。");
  const bindingErrors = outputBindingErrors(original, outputs);
  if (bindingErrors.length) throw new Error(bindingErrors.join("\n"));
  const output = outputs[0];
  const analysis = analyzeWorkflowImport(original, info, output.nodeId, { ...options.bindings, outputs }, options.preserveFullGraph);
  if (analysis.errors.length) throw new Error(analysis.errors.join("\n"));
  // Remote workflows retain their entire deployed graph even when the canvas
  // collects only selected outputs. Scan every original input for its bindings.
  const graph = options.preserveFullGraph ? structuredClone(original) : outputBranch(original, outputs.map(output => output.nodeId));
  const mainPrompt = options.promptKey === "" ? undefined : options.promptKey !== undefined ? analysis.fields.find(field => field.nodeId + "." + field.field === options.promptKey && typeof field.value === "string") : analysis.prompts.length === 1 ? analysis.prompts[0] : undefined;
  if (options.promptKey && !mainPrompt) throw new Error("所选提示词必须指向现有文本字段，不能覆盖连接。");
  if (mainPrompt && analysis.inputs.some(input => input.nodeId === mainPrompt.nodeId && input.field === mainPrompt.field)) throw new Error("主提示词与素材输入不能绑定同一字段。");
  const warnings = [...analysis.warnings];
  const executionOutputs = outputs.map(output => {
    const outputNode = graph[output.nodeId];
    let outputId = output.nodeId;
    if (outputNode.class_type === "PreviewImage" && output.field === "images" && output.kind === "image") {
      let suffix = 1; outputId = "canvas-save-" + output.nodeId;
      while (graph[outputId]) outputId = "canvas-save-" + output.nodeId + "-" + suffix++;
      graph[outputId] = { class_type: "SaveImage", inputs: { images: structuredClone(outputNode.inputs.images), filename_prefix: "infinite-canvas/result" } };
    }
    if (graph[outputId].class_type === "VHS_VideoCombine") graph[outputId].inputs.save_output = true;
    return { nodeId: outputId, field: output.field, kind: output.kind };
  });
  const binding = (nodeId: string, field: string) => ({ target: "comfyui", nodeId, path: "inputs." + field });
  const inputs = analysis.inputs.map((input, index) => ({ id: "input" + (index + 1), name: input.label, dataType: input.kind, required: input.required !== false, binding: { ...binding(input.nodeId, input.field), ...(input.pathMode ? { pathMode: input.pathMode } : {}) } }));
  const mediaKeys = new Set(analysis.inputs.map(input => input.nodeId + "." + input.field));
  const outputIds = new Set([...outputs, ...executionOutputs].map(output => output.nodeId));
  const parameters: Data[] = [], usedKeys = new Set<string>();
  const models: { name: string; relativePath?: string; required: boolean }[] = [];
  let seedAssigned = false;
  for (const [id, node] of Object.entries(graph)) {
    const schemas = inputSchema(info, node);
    for (const [field, value] of Object.entries(node.inputs)) {
      if (modelFile(value) && !models.some(model => model.name === value)) {
        const directory = modelDirectory(node.class_type, field);
        models.push({ name: value, ...(directory ? { relativePath: "models/" + directory + "/" + value.replace(/\\/g, "/") } : {}), required: true });
      }
      if (!scalar(value) || mediaKeys.has(id + "." + field) || (mainPrompt?.nodeId === id && mainPrompt.field === field) || ((outputIds.has(id) || importOutputClasses[node.class_type]) && ["filename_prefix", "save_output"].includes(field))) continue;
      if (typeof value === "number" && /seed/i.test(field) && !Number.isSafeInteger(value)) throw new Error("种子超出安全整数范围：" + id + "." + field);
      let key = field;
      const primitiveSeed = field === "value" && ["PrimitiveInt", "PrimitiveInteger"].includes(node.class_type) && feedsField(graph, id, (_target, input) => /^(seed|noise_seed)$/.test(input));
      const seed = (/^(seed|noise_seed)$/.test(field) || primitiveSeed) && typeof value === "number";
      if (seed && !seedAssigned) { key = "seed"; seedAssigned = true; }
      else if (usedKeys.has(key) || key === "prompt" || key === "negativePrompt" || (!seed && key === "seed") || key.startsWith("slot:")) key = "input:" + id + ":" + field;
      if (usedKeys.has(key)) {
        const base = key; let suffix = 2;
        while (usedKeys.has(key)) key = base + ":" + suffix++;
      }
      usedKeys.add(key);
      const forwarded = field === "value" && /^Primitive(?:Int|Integer|Float|String)(?:Multiline)?$/.test(node.class_type)
        ? Object.values(graph).flatMap(target => Object.entries(target.inputs).filter(([, input]) => connection(input) && input[0] === id && input[1] === 0).map(([input]) => ({ field: input, spec: inputSchema(info, target)[input] }))) : [];
      const forwardedFields = new Set(forwarded.map(input => input.field));
      const presentationField = forwardedFields.size === 1 ? [...forwardedFields][0] : field;
      const specification = forwarded.length === 1 && forwarded[0].spec !== undefined ? forwarded[0].spec : schemas[field];
      const { type: schemaType, options: bounds } = schemaSpec(specification);
      const compatible = dynamicChoices(specification, value);
      const enumOptions = compatible ? compatible.choices : Array.isArray(schemaType) && schemaType.every(scalar) ? [...new Set<Scalar>([...schemaType, value])] : undefined;
      const type = enumOptions ? "enum" : seed ? "seed" : typeof value === "boolean" ? "boolean" : typeof value === "number" ? (schemaType === "INT" || Number.isInteger(value) ? "integer" : "float") : "string";
      const param: Data = { id: key, type, label: (seed ? "种子" : fieldLabels[presentationField] ?? presentationField) + (key === field || key === "seed" ? "" : " · " + id), defaultValue: value, binding: binding(id, field), ui: { placement: (primaryFields.has(presentationField) || seed) && !modelFile(value) ? "primary" : "advanced", ...(typeof value === "string" && (/prompt|text|instruction|message/i.test(presentationField) || value.includes("\n")) ? { multiline: true } : {}) } };
      if (enumOptions) param.options = enumOptions.map(option => ({ value: option, label: String(option) }));
      if (modelFile(value)) param.model = true;
      if (bounds.secret === true || bounds.password === true) { param.secret = true; param.required = bounds.optional !== true; }
      for (const range of ["min", "max", "step"] as const) if (typeof bounds[range] === "number" && Number.isFinite(bounds[range])) {
        if (range === "max" && (type === "integer" || seed) && !Number.isSafeInteger(bounds[range])) continue;
        param[range] = bounds[range];
      }
      if (seed) { param.min = Math.min(Number(param.min ?? 0), Number(value)); param.max = Math.max(Number(param.max ?? Number.MAX_SAFE_INTEGER), Number(value)); param.step = 1; }
      parameters.push(param);
    }
  }
  const config: Data = {
    schemaVersion: 1, id: options.id.trim(), version: "1.0.0", nameLabel: options.name.trim(), primaryCategoryLabel: options.family.trim(),
    nodeKind: output.kind, runnerType: "comfyui", inputs, parameters,
    mediaInputMode: options.bindings?.mediaInputs !== undefined ? "explicit" : "schema",
    ...(options.bindings?.mediaInputs === undefined ? { mediaInputPolicy: inferMediaInputPolicy(graph, analysis.inputs.map((input, index) => ({ ...input, semantic: "slot:input" + (index + 1) })), info ?? {}, executionOutputs.map(output => output.nodeId)) } : {}),
    ...(mainPrompt ? { prompt: { required: false, binding: binding(mainPrompt.nodeId, mainPrompt.field) } } : {}),
    execution: { file: "execution.api.json", modelRequirementsFile: "model.requirements.json", output: executionOutputs[0], ...(executionOutputs.length > 1 ? { outputs: executionOutputs } : {}) },
  };
  const requirements = { schemaVersion: 1, items: models };
  // Validate the generated contract with the same adapter used by directory reading.
  convertLibraryWorkflow(config, graph, requirements, { sourcePath: "import", folder: options.id, configSha256: "", executionSha256: "", executionStatus: "plain" });
  return { graph, config, requirements, warnings: unique(warnings) };
}
