import type { ApiWorkflow } from "../types";
import { apiGraph } from "./library-converter";
import { workflowImportInputSchema } from "./import-editor";
import { validateImportGraph } from "./import-analyzer";
import { repairApiWorkflowFromEditor } from "./import-repair";

type Data = Record<string, unknown>;
type Wire = [string, number];
export type ApiPreparationRepair = {
  nodeId: string;
  field: string;
  value: unknown;
  evidence: "embedded-editor" | "broadcast" | "schema-default" | "unique-type";
};
export type ApiPreparationDiagnostic = {
  severity: "warning" | "error";
  code: string;
  message: string;
  nodeId?: string;
  field?: string;
  candidates?: Wire[];
};
export type PreparedApiWorkflow = {
  graph: ApiWorkflow;
  warnings: string[];
  repairs: ApiPreparationRepair[];
  diagnostics: ApiPreparationDiagnostic[];
  errors: string[];
};
const record = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const wire = (value: unknown): value is Wire => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]) && value[1] >= 0;
const scalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
const primitives = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3"]);
const broadcastClasses = new Set(["Anything Everywhere", "Anything Everywhere3"]);
const modelFile = (value: unknown) => typeof value === "string" && /\.(safetensors|gguf|pt|pth|ckpt|bin|onnx)$/i.test(value);
const unique = <T,>(values: T[]) => [...new Set(values)];

function specification(raw: unknown): { type: unknown; options: Data } {
  if (!Array.isArray(raw)) return { type: undefined, options: {} };
  const options = record(raw[1]) ? raw[1] : {};
  if (raw[0] === "COMFY_MATCHTYPE_V3") {
    const template = record(options.template) ? options.template : {};
    const allowed = template.allowed_types;
    return { type: typeof allowed === "string" ? allowed : Array.isArray(allowed) && allowed.every(type => typeof type === "string") ? allowed.join(",") : "*", options };
  }
  return { type: raw[0], options };
}
function connectionType(raw: unknown): string | undefined {
  const { type } = specification(raw);
  if (typeof type !== "string" || type === "*" || type.startsWith("COMFY_") || type.split(",").some(item => primitives.has(item.trim()))) return undefined;
  return type;
}
function compatible(expected: string, actual: unknown): boolean {
  // Wildcards do not prove a recoverable link. Leave them for the plugin.
  return typeof actual === "string" && actual !== "*" && !actual.startsWith("COMFY_") && actual.split(",").every(type => expected.split(",").map(item => item.trim()).includes(type.trim()));
}
function editorValue(value: unknown): Data | undefined {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return undefined; }
  }
  return record(parsed) && Array.isArray(parsed.nodes) ? parsed : undefined;
}
function embeddedEditors(source: Data): Data[] {
  const extra = record(source.extra_data) ? source.extra_data : {};
  const png = record(source.extra_pnginfo) ? source.extra_pnginfo : {};
  const extraPng = record(extra.extra_pnginfo) ? extra.extra_pnginfo : {};
  const metadata = record(source.metadata) ? source.metadata : {};
  // Some single-file envelopes save editor nodes beside an authoritative prompt.
  // Remove prompt only in this metadata copy so format detection sees the editor.
  const topEditor = record(source.prompt) && Array.isArray(source.nodes) ? Object.fromEntries(Object.entries(source).filter(([key]) => key !== "prompt")) : undefined;
  return [topEditor, source.workflow, png.workflow, extraPng.workflow, metadata.workflow].map(editorValue).filter((value): value is Data => !!value);
}
function declaredDefault(raw: unknown, field: string): unknown {
  const { type, options } = specification(raw);
  // Expanded V3 keys use dotted prefixes; the leaf retains the original file/model contract.
  field = field.split(".").at(-1)!;
  const enumValues = Array.isArray(type) ? type : type === "COMBO" ? options.options : type === "COMFY_DYNAMICCOMBO_V3" && Array.isArray(options.options) ? options.options.map(entry => record(entry) ? entry.key : undefined) : undefined;
  // A weight/file selection is an author decision, including a singleton list.
  if ((Array.isArray(enumValues) && enumValues.some(modelFile)) || options.image_upload || options.video_upload || options.audio_upload || options.upload || /(?:model|weight|lora|vae|clip|checkpoint|ckpt|encoder).*(?:name|file|path)$|^(?:model|unet|vae|clip|lora|checkpoint|ckpt)$/i.test(field) || /^(?:file(?:name|_path)?|path|directory|folder|(?:image|video|audio)(?:_name|_file|_path)?)$/i.test(field)) return undefined;
  let value = options.default;
  if (!Object.hasOwn(options, "default") && Array.isArray(enumValues) && enumValues.length === 1) value = enumValues[0];
  if (!scalar(value) || modelFile(value)) return undefined;
  if (type === "COMFY_DYNAMICCOMBO_V3" && (!Array.isArray(options.options) || options.options.filter(entry => record(entry) && entry.key === value).length !== 1)) return undefined;
  if (Array.isArray(enumValues)) return enumValues.includes(value) ? value : undefined;
  if (type === "INT" && (!Number.isSafeInteger(value) || typeof value !== "number")) return undefined;
  if (type === "FLOAT" && typeof value !== "number") return undefined;
  if (type === "STRING" && typeof value !== "string") return undefined;
  if (type === "BOOLEAN" && typeof value !== "boolean") return undefined;
  if (!primitives.has(String(type))) return undefined;
  if (typeof value === "number" && ((typeof options.min === "number" && value < options.min) || (typeof options.max === "number" && value > options.max))) return undefined;
  return value;
}

/** Read the saved API contract without guessing fields or interpreting plugin data. */
export function apiWorkflowSourceGraph(source: unknown): ApiWorkflow {
  if (!record(source)) throw new Error("API 工作流必须为对象。");
  // A bare prompt may carry editor metadata beside node entries. Strip only
  // recognized metadata, never an unrecognized plugin or malformed node.
  const metadataKeys = new Set(["workflow", "extra_pnginfo", "extra_data", "metadata"]);
  const input = record(source.prompt) ? source.prompt : Object.fromEntries(Object.entries(source).filter(([key, value]) => !metadataKeys.has(key) || (record(value) && (Object.hasOwn(value, "class_type") || Object.hasOwn(value, "inputs")))));
  return apiGraph(input);
}

/** Prepare one API file. Existing API values and every branch remain authoritative. */
export function prepareApiWorkflow(source: unknown, info?: Data): PreparedApiWorkflow {
  if (!record(source)) throw new Error("API 工作流必须为对象。");
  const editors = embeddedEditors(source);
  let graph = apiWorkflowSourceGraph(source);
  const diagnostics: ApiPreparationDiagnostic[] = [], repairs: ApiPreparationRepair[] = [], warnings: string[] = [];
  const objectInfo = info ?? {};
  function diagnose(severity: "warning" | "error", code: string, message: string, nodeId?: string, field?: string, candidates?: Wire[]) {
    diagnostics.push({ severity, code, message, ...(nodeId ? { nodeId } : {}), ...(field ? { field } : {}), ...(candidates ? { candidates: structuredClone(candidates) } : {}) });
  }
  function repair(nodeId: string, field: string, value: unknown, evidence: ApiPreparationRepair["evidence"]) {
    if (Object.hasOwn(graph[nodeId].inputs, field)) return;
    graph[nodeId].inputs[field] = structuredClone(value);
    repairs.push({ nodeId, field, value: structuredClone(value), evidence });
    warnings.push("已依据" + ({ "embedded-editor": "本文件编辑器元数据", broadcast: "本文件明确广播连接", "schema-default": "云端节点默认值", "unique-type": "本文件唯一类型兼容来源" }[evidence]) + "补充 " + nodeId + "." + field + "；已有 API 输入保持原值。");
  }
  if (editors.length > 1 && new Set(editors.map(editor => JSON.stringify(editor))).size > 1) diagnose("warning", "embedded-editor-ambiguous", "本文件包含不同的编辑器元数据，未采用其中任一份恢复连接。");
  else if (editors.length && Object.keys(objectInfo).length) {
    try {
      const embedded = repairApiWorkflowFromEditor(graph, editors[0], objectInfo);
      for (const item of embedded.repairs) repairs.push({ ...item, evidence: "embedded-editor" });
      graph = embedded.graph;
      warnings.push(...embedded.warnings.map(message => message.replace(/配对普通工作流|普通工作流|配对节点/g, "本文件编辑器元数据")));
    } catch (error) {
      diagnose("warning", "embedded-editor-invalid", "本文件编辑器元数据无法可靠恢复连接，已保留 API 原值：" + (error instanceof Error ? error.message.replace(/请选择同一工作流的普通 JSON，或在 ComfyUI 中重新导出完整 API。/, "可在 ComfyUI 中重新导出完整 API。") : String(error)));
    }
  }
  // Seed root defaults, then let the schema expander request required nested selectors.
  // The expander applies compatibility rules before requesting any default.
  for (const [id, node] of Object.entries(graph)) {
    const rawSchema = objectInfo[node.class_type];
    if (!record(rawSchema) || !record(rawSchema.input) || !record(rawSchema.input.required)) continue;
    for (const [field, raw] of Object.entries(rawSchema.input.required)) {
      if (Object.hasOwn(node.inputs, field)) continue;
      const value = declaredDefault(raw, field);
      if (value !== undefined) repair(id, field, value, "schema-default");
    }
  }
  const schemas = new Map<string, { required: Data; optional: Data }>();
  for (const [id, node] of Object.entries(graph)) {
    try { schemas.set(id, workflowImportInputSchema(node, objectInfo[node.class_type], (field, raw) => {
      const value = declaredDefault(raw, field);
      if (value !== undefined) repair(id, field, value, "schema-default");
    })); }
    catch (error) { diagnose("error", "schema-invalid", "节点 " + id + " 的输入定义无法展开：" + (error instanceof Error ? error.message : String(error)), id); }
  }
  const outputCache = new Map<string, unknown>();
  function outputType(id: string, index: number, stack = new Set<string>()): unknown {
    const key = id + "\0" + index;
    if (outputCache.has(key)) return outputCache.get(key);
    if (stack.has(key) || !graph[id]) return undefined;
    const raw = objectInfo[graph[id].class_type], schema = record(raw) ? raw : {};
    const type = Array.isArray(schema.output) ? schema.output[index] : undefined;
    if (type !== "COMFY_MATCHTYPE_V3") return type;
    const group = Array.isArray(schema.output_matchtypes) ? schema.output_matchtypes[index] : undefined;
    if (typeof group !== "string") return undefined;
    const fields = { ...schemas.get(id)?.required, ...schemas.get(id)?.optional };
    const types: string[] = [];
    for (const [field, spec] of Object.entries(fields)) {
      if (!Array.isArray(spec) || spec[0] !== "COMFY_MATCHTYPE_V3") continue;
      const options = record(spec[1]) ? spec[1] : {}, template = record(options.template) ? options.template : {};
      if (template.template_id !== group) continue;
      const value = graph[id].inputs[field];
      const resolved = wire(value) ? outputType(value[0], value[1], new Set(stack).add(key)) : typeof value === "string" ? "STRING" : typeof value === "boolean" ? "BOOLEAN" : typeof value === "number" ? Number.isInteger(value) ? "INT" : "FLOAT" : undefined;
      if (typeof resolved === "string" && resolved !== "*" && !resolved.startsWith("COMFY_")) types.push(resolved);
    }
    const result = unique(types).length === 1 ? types[0] : undefined;
    outputCache.set(key, result);
    return result;
  }
  function reaches(sourceId: string, targetId: string, seen = new Set<string>()): boolean {
    if (sourceId === targetId) return true;
    if (seen.has(sourceId) || !graph[sourceId]) return false;
    seen.add(sourceId);
    return Object.values(graph[sourceId].inputs).some(value => wire(value) && reaches(value[0], targetId, seen));
  }
  function broadcasts(wanted: string, targetId: string): { candidates: Wire[]; reason?: string } {
    const candidates = new Map<string, Wire>();
    for (const [id, node] of Object.entries(graph)) {
      if (!/Everywhere/i.test(node.class_type)) continue;
      const incoming = Object.entries(node.inputs).filter(([, value]) => wire(value));
      const matching = incoming.filter(([, value]) => compatible(wanted, outputType((value as Wire)[0], (value as Wire)[1])));
      const unknown = incoming.some(([, value]) => {
        const type = outputType((value as Wire)[0], (value as Wire)[1]);
        return typeof type !== "string" || type === "*" || type.startsWith("COMFY_");
      });
      if (!matching.length && !unknown) continue;
      if (!broadcastClasses.has(node.class_type)) return { candidates: [], reason: "广播节点 " + id + " 使用未支持的特殊传播规则 " + node.class_type };
      const data = node as unknown as Data, meta = record(data._meta) ? data._meta : {};
      const properties = record(data.properties) ? data.properties : {}, metaProperties = record(meta.properties) ? meta.properties : {};
      const settings = [properties, metaProperties, properties.ue_properties, metaProperties.ue_properties, meta.ue_properties].filter(record).flatMap(Object.entries);
      const restriction = [...settings, ...Object.entries(node.inputs).filter(([field]) => !/^anything\d*$/.test(field))].some(([field, value]) => (/regex$/.test(field) && value !== null && value !== undefined && value !== "" && value !== ".*") || (["group_restricted", "color_restricted", "priority", "repeated_type_rule", "send_to_any", "string_to_combo"].includes(field) && Boolean(value)));
      const restrictedWidgets = Array.isArray(data.widgets_values) && data.widgets_values.some(value => value !== null && value !== undefined && value !== "" && value !== ".*");
      if (restriction || restrictedWidgets) return { candidates: [], reason: "广播节点 " + id + " 带有范围、筛选或优先级限制，不能安全按全局类型恢复" };
      if (unknown) return { candidates: [], reason: "广播节点 " + id + " 存在未确定输出类型，无法证明唯一传播来源" };
      for (const [field, value] of matching) {
        if (!/^anything\d*$/.test(field)) return { candidates: [], reason: "广播节点 " + id + " 输入契约无法识别" };
        const link = value as Wire;
        if (reaches(link[0], targetId)) return { candidates: [], reason: "广播连接会形成循环" };
        candidates.set(JSON.stringify(link), link);
      }
    }
    return { candidates: [...candidates.values()] };
  }
  // Only missing required fields can use global uniqueness. Optional links are
  // restored exclusively from explicit broadcaster/editor evidence.
  for (const [id, node] of Object.entries(graph)) {
    const fields = schemas.get(id);
    if (!fields) continue;
    for (const [field, raw] of Object.entries({ ...fields.required, ...fields.optional })) {
      if (Object.hasOwn(node.inputs, field)) continue;
      const required = Object.hasOwn(fields.required, field), expected = connectionType(raw);
      if (!expected) {
        if (!required) continue;
        const value = declaredDefault(raw, field);
        if (value !== undefined) repair(id, field, value, "schema-default");
        else diagnose("error", "missing-widget", "缺少必填输入 " + id + "." + field + "；节点定义没有可可靠使用的默认值，未选择模型、文件或参数。", id, field);
        continue;
      }
      const broadcast = broadcasts(expected, id);
      if (broadcast.reason || broadcast.candidates.length > 1) {
        if (required || broadcast.candidates.length || broadcast.reason) diagnose(required ? "error" : "warning", "broadcast-ambiguous", "未恢复 " + id + "." + field + "：" + (broadcast.reason ?? "存在多个类型兼容广播来源，无法唯一确定"), id, field, broadcast.candidates);
        continue;
      }
      if (broadcast.candidates.length === 1) {
        repair(id, field, broadcast.candidates[0], "broadcast");
        outputCache.clear();
        continue;
      }
      if (!required) continue;
      const candidates: Wire[] = [];
      const unknownSources: string[] = [];
      for (const [sourceId, sourceNode] of Object.entries(graph)) {
        if (reaches(sourceId, id)) continue;
        const schema = objectInfo[sourceNode.class_type];
        if (!record(schema) || !Array.isArray(schema.output)) {
          if (!/Everywhere/i.test(sourceNode.class_type)) unknownSources.push(sourceId);
          continue;
        }
        schema.output.forEach((_, index) => {
          const type = outputType(sourceId, index);
          if (compatible(expected, type)) candidates.push([sourceId, index]);
          else if (typeof type !== "string" || type === "*" || type.startsWith("COMFY_")) unknownSources.push(sourceId);
        });
      }
      if (candidates.length === 1 && !unknownSources.length) {
        repair(id, field, candidates[0], "unique-type");
        outputCache.clear();
      } else diagnose("error", "connection-unresolved", "未恢复 " + id + "." + field + "（" + expected + "）：" + (unknownSources.length ? "节点 " + unknownSources.join("、") + " 的输出类型未确定，无法证明来源唯一" : candidates.length ? "存在 " + candidates.length + " 个类型兼容来源，无法唯一确定" : "本文件没有可确认且不成环的类型兼容来源") + "；请从 ComfyUI 重新导出包含此连接的 API。", id, field, candidates);
    }
  }
  const validation = validateImportGraph(graph, Object.keys(objectInfo).length ? objectInfo : undefined);
  for (const message of validation.errors) diagnose("error", "graph-invalid", message);
  warnings.push(...validation.warnings);
  warnings.push(...diagnostics.filter(item => item.severity === "warning").map(item => item.message));
  return { graph, repairs, warnings: unique(warnings), diagnostics, errors: unique(diagnostics.filter(item => item.severity === "error").map(item => item.message)) };
}
