import { detectWorkflowFormat, editorWorkflowObjectInfo, MissingWorkflowNodeDefinitionError } from "./import-editor";
import type { ImportAnalysis } from "./import-analyzer";
import { inferWorkflowFamily } from "./import-classification";
import { apiWorkflowSourceGraph } from "./import-api";
import type { ImportEnvironmentReport } from "./import-environment-diagnostics";

type Data = Record<string, unknown>;
export type WorkflowImportDiagnostic = { code: string; message: string; nodeId?: string; classType?: string; field?: string };
export type WorkflowImportState = { status: "pending" | "ready"; format: "api" | "editor"; diagnostics: WorkflowImportDiagnostic[]; warnings: string[]; environmentReport?: ImportEnvironmentReport };
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const helpers = new Set(["Note", "MarkdownNote", "Reroute", "SetNode", "GetNode", "PrimitiveNode", "PrimitiveNodeValue", "Image Comparer (rgthree)", "Fast Groups Muter (rgthree)", "Fast Groups Bypasser (rgthree)", "FastGroupsBypasser", "FastGroupsMuter", "Power Puter (rgthree)", "Anything Everywhere", "Anything Everywhere3", "Anything Everywhere?"]);

/** A pending package still must contain a real, structurally valid editor file. */
export function validatePendingEditorSource(source: unknown): Data {
  if (detectWorkflowFormat(source) !== "editor") throw new Error("保存仅接受有效的普通 ComfyUI 工作流。");
  const raw = source as Data, root = object(raw.prompt) ? raw.prompt : raw;
  function check(graph: Data, label: string, formal = false) {
    if (!Array.isArray(graph.nodes) || (!formal && !graph.nodes.length)) throw new Error(label + "没有节点，不能作为工作流添加。");
    const nodes = new Map<string, Data>();
    for (const raw of graph.nodes) {
      if (!object(raw) || !["number", "string"].includes(typeof raw.id) || typeof raw.type !== "string" || !raw.type.trim() || nodes.has(String(raw.id))) throw new Error(label + "存在无效或重复节点。");
      if (raw.inputs !== undefined && (!Array.isArray(raw.inputs) || raw.inputs.some(port => !object(port) || typeof port.name !== "string"))) throw new Error(label + "节点输入记录无效。");
      nodes.set(String(raw.id), raw);
    }
    if (graph.links !== undefined && !Array.isArray(graph.links)) throw new Error(label + "连线列表无效。");
    const ids = new Set<string>();
    const virtual = formal ? new Set([String(object(graph.inputNode) ? graph.inputNode.id : -10), String(object(graph.outputNode) ? graph.outputNode.id : -20)]) : new Set<string>();
    for (const raw of (graph.links ?? []) as unknown[]) {
      const link = Array.isArray(raw) ? raw : object(raw) ? [raw.id, raw.origin_id, raw.origin_slot, raw.target_id, raw.target_slot] : [];
      if (link.length < 5 || ![link[0], link[1], link[3]].every(item => ["number", "string"].includes(typeof item)) || !Number.isInteger(link[2]) || Number(link[2]) < 0 || !Number.isInteger(link[4]) || Number(link[4]) < 0 || ids.has(String(link[0]))) throw new Error(label + "存在无效或重复连线。");
      if ((!nodes.has(String(link[1])) && !virtual.has(String(link[1]))) || (!nodes.has(String(link[3])) && !virtual.has(String(link[3])))) throw new Error(label + "连线指向不存在的节点。");
      ids.add(String(link[0]));
    }
    for (const node of nodes.values()) for (const port of (node.inputs ?? []) as Data[]) if (port.link !== null && port.link !== undefined && !ids.has(String(port.link))) throw new Error(label + "输入端口引用不存在的连线。");
  }
  check(root, "工作流");
  if (object(root.definitions) && Array.isArray(root.definitions.subgraphs)) for (const graph of root.definitions.subgraphs) { if (!object(graph)) throw new Error("子图记录无效。"); check(graph, "子图", true); }
  return root;
}

/** Pending means incomplete execution information, never an arbitrary JSON file. */
export function validatePendingWorkflowSource(source: unknown): Data {
  return detectWorkflowFormat(source) === "editor" ? validatePendingEditorSource(source) : apiWorkflowSourceGraph(source);
}

export function editorImportDiagnostics(source: unknown, info: Data | undefined, reason: unknown): WorkflowImportDiagnostic[] {
  const root = validatePendingEditorSource(source);
  let available: Data = info ?? {};
  try { available = editorWorkflowObjectInfo(source, info ?? {}); } catch { /* Keep the conversion error and missing contracts below. */ }
  const diagnostics: WorkflowImportDiagnostic[] = [];
  const seen = new Set<string>();
  function add(item: WorkflowImportDiagnostic) { const key = item.code + "\0" + (item.nodeId ?? "") + "\0" + (item.field ?? ""); if (!seen.has(key)) { seen.add(key); diagnostics.push(item); } }
  const definitions = object(root.definitions) && Array.isArray(root.definitions.subgraphs) ? new Map(root.definitions.subgraphs.filter(object).map(graph => [String(graph.id), graph])) : new Map<string, Data>();
  const legacy = object(root.extra) && object(root.extra.groupNodes) ? root.extra.groupNodes : {};
  function visit(graph: Data, prefix: string, ancestry: Set<string>, indexed = false) {
    if (!Array.isArray(graph.nodes)) return;
    graph.nodes.forEach((raw, index) => {
      if (!object(raw) || typeof raw.type !== "string" || raw.mode === 2 || raw.mode === 4 || helpers.has(raw.type)) return;
      const id = prefix + String(indexed ? index : raw.id);
      const definition = definitions.get(raw.type) ?? (/^workflow[>/]/.test(raw.type) && object(legacy[raw.type.slice(9)]) ? legacy[raw.type.slice(9)] as Data : undefined);
      if (definition) { if (!ancestry.has(raw.type)) visit(definition, id + ":", new Set(ancestry).add(raw.type), !definitions.has(raw.type)); return; }
      if (!object(available[raw.type])) add({ code: "missing-node-definition", nodeId: id, classType: raw.type, message: "节点 " + id + "（" + raw.type + "）缺少可准确还原参数名称与顺序的节点定义。" });
    });
  }
  visit(root, "", new Set());
  if (reason instanceof MissingWorkflowNodeDefinitionError) add({ code: "missing-node-definition", nodeId: reason.nodeId, classType: reason.nodeType, message: reason.message });
  else if (reason) add({ code: "conversion-incomplete", message: reason instanceof Error ? reason.message : String(reason) });
  if (!diagnostics.length) add({ code: "conversion-incomplete", message: "工作流的参数或输出信息不完整。" });
  return diagnostics;
}

export function pendingWorkflowPackage(source: unknown, id: string, name: string, info: Data | undefined, reason: unknown) {
  const format = detectWorkflowFormat(source), root = validatePendingWorkflowSource(source);
  const diagnostics = format === "editor" ? editorImportDiagnostics(source, info, reason) : apiImportDiagnostics(root, reason);
  const allNodes: Data[] = format === "editor" ? [...root.nodes as Data[]] : Object.values(root).filter(object).map(node => ({ ...node, type: node.class_type }));
  if (format === "editor" && object(root.definitions) && Array.isArray(root.definitions.subgraphs)) root.definitions.subgraphs.filter(object).forEach(graph => { if (Array.isArray(graph.nodes)) allNodes.push(...graph.nodes.filter(object)); });
  if (format === "editor" && object(root.extra) && object(root.extra.groupNodes)) Object.values(root.extra.groupNodes).filter(object).forEach(graph => { if (Array.isArray(graph.nodes)) allNodes.push(...graph.nodes.filter(object)); });
  const enabled = allNodes.filter(node => node.mode !== 2 && node.mode !== 4);
  const types = enabled.map(node => String(node.type));
  const kind = types.some(type => ["VHS_VideoCombine", "SaveVideo"].includes(type)) ? "video" : types.some(type => /^SaveAudio/.test(type)) ? "audio" : types.includes("easy showAnything") ? "text" : types.some(type => ["SaveImage", "SaveImageAdvanced", "PreviewImage"].includes(type)) ? "image" : "file";
  const models = new Set<string>();
  function weights(value: unknown) { if (typeof value === "string" && /\.(safetensors|gguf|pt|pth|ckpt|bin|onnx)$/i.test(value)) models.add(value); else if (Array.isArray(value)) value.forEach(weights); else if (object(value)) Object.values(value).forEach(weights); }
  enabled.forEach(node => {
    // Until fields are bound, only loader widgets and explicit model declarations
    // establish weight references; a prompt ending with a filename does not.
    if (format === "api" && object(node.inputs)) Object.entries(node.inputs).filter(([field]) => /model|weight|lora|vae|clip|checkpoint|ckpt|unet|encoder/i.test(field)).forEach(([, value]) => weights(value));
    else if (/Loader|lora|checkpoint|unet|vae|clip/i.test(String(node.type))) weights(node.widgets_values);
    const properties = object(node.properties) ? node.properties : {};
    if (Array.isArray(properties.models)) properties.models.filter(object).forEach(model => weights(model.name));
  });
  const warnings = ["原始 JSON 已完整保留；连接对应工作站后可重新读取节点定义，继续自动转换。"];
  const importState: WorkflowImportState = { status: "pending", format, diagnostics, warnings };
  const analysis: ImportAnalysis = { outputs: [], inputs: [], fields: [], prompts: [], errors: diagnostics.map(item => item.message), warnings };
  const config: Data = { schemaVersion: 1, id, version: "1.0.0", nameLabel: name, primaryCategoryLabel: inferWorkflowFamily(root, { name, kind }), nodeKind: kind, runnerType: "comfyui", inputs: [], parameters: [], importState, execution: { file: "execution.api.json", modelRequirementsFile: "model.requirements.json" } };
  return { graph: undefined, config, requirements: { schemaVersion: 1, items: [...models].map(model => ({ name: model, required: true })) }, warnings, analysis, importState };
}

/** API files already name their inputs; unfamiliar plugins must never be rewritten. */
function apiImportDiagnostics(graph: Data, reason: unknown): WorkflowImportDiagnostic[] {
  const reported = object(reason) && Array.isArray(reason.diagnostics) ? reason.diagnostics.filter(object) : [];
  const diagnostics = reported.filter(item => item.severity === "error" && typeof item.message === "string").map(item => {
    const nodeId = typeof item.nodeId === "string" ? item.nodeId : undefined;
    const node = nodeId && object(graph[nodeId]) ? graph[nodeId] as Data : undefined;
    return { code: typeof item.code === "string" ? item.code : "conversion-incomplete", message: String(item.message),
      ...(nodeId ? { nodeId } : {}), ...(node && typeof node.class_type === "string" ? { classType: node.class_type } : {}),
      ...(typeof item.field === "string" ? { field: item.field } : {}) };
  });
  if (!diagnostics.length) diagnostics.push({ code: "conversion-incomplete", message: reason instanceof Error ? reason.message : "工作流的参数或输出信息不完整。" });
  return diagnostics;
}

/** Compatibility for callers that specifically register ordinary editor files. */
export function pendingEditorPackage(source: unknown, id: string, name: string, info: Data | undefined, reason: unknown) {
  validatePendingEditorSource(source);
  return pendingWorkflowPackage(source, id, name, info, reason);
}
