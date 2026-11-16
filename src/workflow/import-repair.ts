import type { ApiWorkflow } from "../types";
import { apiGraph } from "./library-converter";
import { convertEditorWorkflow, detectWorkflowFormat, workflowImportInputSchema } from "./import-editor";
import { validateImportGraph } from "./import-analyzer";

type Data = Record<string, unknown>;
export type ApiInputRepair = { nodeId: string; field: string; value: unknown };
export type ApiWorkflowRepair = { graph: ApiWorkflow; warnings: string[]; repairs: ApiInputRepair[] };
const record = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const wire = (value: unknown): value is [string, number] => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]) && value[1] >= 0;
const literal = (value: unknown): value is { __value__: unknown } => record(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "__value__");
const unwrap = (value: unknown) => literal(value) ? value.__value__ : value;
const scalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
const primitive = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3"]);
const typed = (spec: unknown): boolean => Array.isArray(spec) && typeof spec[0] === "string" && spec[0] !== "*" && spec[0] !== "COMFY_AUTOGROW_V3" && spec[0].split(",").some(type => !primitive.has(type.trim()));
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const equal = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const titleKey = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const modelValue = (value: unknown) => typeof value === "string" && /\.(safetensors|gguf|pt|pth|ckpt|bin|onnx)$/i.test(value);
function mismatch(detail: string): never { throw new Error("普通 JSON 与 API 工作流无法可靠配对：" + detail + "。请选择同一工作流的普通 JSON，或在 ComfyUI 中重新导出完整 API。"); }

type IndexedNode = { raw: Data; owner: string };
function editorIndex(source: Data): Map<string, IndexedNode> {
  const result = new Map<string, IndexedNode>();
  const definitions = new Map<string, Data>();
  const list = record(source.definitions) ? source.definitions.subgraphs : undefined;
  if (list !== undefined && !Array.isArray(list)) mismatch("子图定义格式不正确");
  for (const raw of (list ?? []) as unknown[]) {
    if (!record(raw) || typeof raw.id !== "string" || definitions.has(raw.id)) mismatch("子图定义缺少唯一 ID");
    definitions.set(raw.id, raw);
  }
  function visit(graph: Data, prefix: string, owner: string, ancestry: Set<string>) {
    if (!Array.isArray(graph.nodes)) mismatch("普通工作流缺少节点列表");
    for (const raw of graph.nodes) {
      if (!record(raw) || !["number", "string"].includes(typeof raw.id) || typeof raw.type !== "string") mismatch("普通工作流存在无效节点");
      const id = prefix + String(raw.id), top = owner || id;
      if (result.has(id)) mismatch("普通工作流节点 ID 重复：" + id);
      result.set(id, { raw, owner: top });
      const definition = definitions.get(raw.type);
      if (!definition) continue;
      if (ancestry.has(raw.type)) mismatch("子图递归定义：" + raw.type);
      visit(definition, id + ":", top, new Set(ancestry).add(raw.type));
    }
  }
  visit(source, "", "", new Set());
  return result;
}

/** Restore only absent API inputs from a verified companion editor branch. */
export function repairApiWorkflowFromEditor(apiSource: unknown, editorSource: unknown, objectInfo: Record<string, unknown>): ApiWorkflowRepair {
  if (detectWorkflowFormat(apiSource) !== "api") throw new Error("待修复文件必须是 ComfyUI API JSON。");
  if (detectWorkflowFormat(editorSource) !== "editor") throw new Error("配对文件必须是 ComfyUI 普通 JSON。");
  if (!record(objectInfo) || !Object.keys(objectInfo).length) throw new Error("恢复连接前需要读取 ComfyUI 节点定义。");
  const graph = apiGraph(apiSource);
  const editorRoot = editorSource as Data;
  const editor = record(editorRoot.prompt) ? editorRoot.prompt : editorRoot;
  const indexed = editorIndex(editor);
  const warnings: string[] = [];
  function identity(id: string, node: ApiWorkflow[string], required: boolean) {
    const matched = indexed.get(id);
    if (!matched) {
      if (required) mismatch("相关节点 " + id + " 在普通工作流中不存在");
      warnings.push("API 节点 " + id + " 不在配对普通工作流中；该无关节点保持原样。");
      return;
    }
    if (matched.raw.type !== node.class_type) mismatch("节点 " + id + " 类型不一致（API " + node.class_type + "，普通 JSON " + String(matched.raw.type) + "）");
    if (matched.raw.mode === 2 || matched.raw.mode === 4) mismatch("API 节点 " + id + " 在普通工作流中已禁用或旁路");
    const actualTitle = node._meta?.title;
    const customTitle = matched.raw.title;
    const schema = objectInfo[node.class_type];
    if (typeof actualTitle === "string" && actualTitle.trim()) {
      if (typeof customTitle === "string" && customTitle.trim()) {
        if (actualTitle !== customTitle) warnings.push("节点 " + id + " 的自定义标题与普通工作流不同，已保留 API 元信息；配对依据为节点 ID、类型及相关输入连接。");
      } else if (record(schema) && typeof schema.display_name === "string") {
        if (![node.class_type, schema.display_name].some(title => titleKey(title) === titleKey(actualTitle))) warnings.push("节点 " + id + " 的默认显示标题与当前节点定义不同，已按 ID 与类型验证并保留 API 元信息。");
      }
    }
  }
  // Validate common identities without trying to execute or convert unknown
  // output branches. Extra API nodes are retained, never inferred from labels.
  for (const [id, node] of Object.entries(graph)) identity(id, node, false);
  const roots: string[] = [];
  const missing: { nodeId: string; field: string }[] = [];
  for (const [id, node] of Object.entries(graph)) {
    const schema = objectInfo[node.class_type];
    if (!record(schema)) continue;
    // A missing dynamic selector may prevent expanding the API schema. Its
    // explicit editor value can still select the branch during conversion.
    let inputs: { required: Data; optional: Data };
    try { inputs = workflowImportInputSchema(node, schema); }
    catch (reason) {
      if (!indexed.has(id)) throw reason;
      const input = record(schema.input) ? schema.input : {};
      inputs = { required: record(input.required) ? input.required : {}, optional: record(input.optional) ? input.optional : {} };
    }
    let needsBranch = false;
    for (const [field, spec] of Object.entries(inputs.required)) {
      if (!typed(spec) || Object.hasOwn(node.inputs, field)) continue;
      needsBranch = true;
      missing.push({ nodeId: id, field });
    }
    const matched = indexed.get(id);
    if (matched) {
      const saved = matched.raw.widgets_values;
      const fields = { ...inputs.required, ...inputs.optional };
      const declaredWidgets = Object.entries(fields).filter(([, spec]) => Array.isArray(spec) &&
        (Array.isArray(spec[0]) || primitive.has(String(spec[0]))) && !(record(spec[1]) && spec[1].forceInput));
      const missingWidget = record(saved)
        ? Object.keys(saved).some(field => !Object.hasOwn(node.inputs, field) &&
          (Object.hasOwn(fields, field) || Object.keys(fields).some(parent => field.startsWith(parent + "."))))
        : Array.isArray(saved) && saved.length > 0 && declaredWidgets.some(([field]) => !Object.hasOwn(node.inputs, field));
      const missingExplicitLink = Array.isArray(matched.raw.inputs) && matched.raw.inputs.some(port => record(port) &&
        typeof port.name === "string" && port.link !== null && port.link !== undefined && !Object.hasOwn(node.inputs, port.name));
      needsBranch ||= missingWidget || missingExplicitLink;
    }
    if (!needsBranch) continue;
    identity(id, node, true);
    if (matched!.owner !== id) mismatch("嵌套节点 " + id + " 无法作为独立修复根；请直接导入完整普通工作流");
    roots.push(id);
  }
  if (!roots.length) return { graph, repairs: [], warnings: [...new Set(warnings)] };
  const converted = convertEditorWorkflow(editorSource, objectInfo, [...new Set(roots)]);
  const repairs: ApiInputRepair[] = [];
  for (const [id, restored] of Object.entries(converted.graph)) {
    identity(id, restored, true);
    const existing = graph[id];
    if (!existing) continue;
    if (existing.class_type !== restored.class_type) mismatch("恢复依赖节点 " + id + " 与 API 类型冲突");
    const schema = workflowImportInputSchema(restored, objectInfo[existing.class_type]);
    const fields = { ...schema.required, ...schema.optional };
    for (const [field, value] of Object.entries(existing.inputs)) {
      const counterpart = restored.inputs[field];
      if (equal(unwrap(value), unwrap(counterpart))) continue;
      if (wire(value)) mismatch("已有连接 " + id + "." + field + " 与普通工作流不一致");
      if (counterpart === undefined) continue;
      const spec = fields[field];
      const primitiveType = Array.isArray(spec) && typeof spec[0] === "string" && primitive.has(spec[0]);
      if (wire(counterpart)) {
        // API literals are legal for primitive inputs even if the editor used
        // an upstream text/number node. Preserve the API's authoritative value.
        if (!literal(value) && (!primitiveType || !["string", "number", "boolean"].includes(typeof value))) mismatch("已有输入 " + id + "." + field + " 与普通工作流连接冲突");
      } else if (modelValue(unwrap(value)) || modelValue(unwrap(counterpart)) ||
        (Array.isArray(spec) && (Array.isArray(spec[0]) || spec[0] === "COMFY_DYNAMICCOMBO_V3")) ||
        !["string", "number", "boolean"].includes(typeof unwrap(value)) || typeof unwrap(value) !== typeof unwrap(counterpart)) {
        mismatch("已有输入 " + id + "." + field + " 与普通工作流不一致");
      }
      warnings.push("配对节点 " + id + "." + field + " 的控件或文本输入不同，已保留 API 原值。");
    }
    for (const [field, value] of Object.entries(restored.inputs)) {
      if (Object.hasOwn(existing.inputs, field) || !Object.hasOwn(fields, field) || (!wire(value) && !scalar(unwrap(value)))) continue;
      repairs.push({ nodeId: id, field, value: structuredClone(value) });
    }
  }
  for (const item of missing) if (!repairs.some(repair => repair.nodeId === item.nodeId && repair.field === item.field))
    throw new Error("普通工作流未能唯一恢复 " + item.nodeId + "." + item.field + " 的连接；未修改 API。");
  const added = new Set<string>();
  function dependency(id: string) {
    if (graph[id]) return;
    const restored = converted.graph[id];
    if (!restored) throw new Error("恢复连接依赖不存在的节点 " + id + "；未修改 API。");
    identity(id, restored, true);
    graph[id] = structuredClone(restored);
    added.add(id);
    for (const value of Object.values(restored.inputs)) if (wire(value)) dependency(value[0]);
  }
  for (const repair of repairs) {
    if (wire(repair.value)) dependency(repair.value[0]);
    graph[repair.nodeId].inputs[repair.field] = structuredClone(repair.value);
    warnings.push("已依据配对普通工作流恢复 " + repair.nodeId + "." + repair.field + (wire(repair.value) ? " 的连接。" : " 的保存值。"));
  }
  for (const id of added) warnings.push("已补入恢复连接所需的普通工作流节点 " + id + "（" + graph[id].class_type + "）。");
  const related = Object.fromEntries(Object.keys(converted.graph).filter(id => graph[id]).map(id => [id, graph[id]]));
  const validation = validateImportGraph(related, objectInfo);
  if (validation.errors.length) throw new Error("恢复后的相关执行分支仍无效：" + validation.errors.join("；") + "。未修改原 API。");
  return { graph, repairs, warnings: [...new Set([...warnings, ...converted.warnings, ...validation.warnings])] };
}
