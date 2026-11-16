import type { ApiWorkflow, RunningHubBindingContract, RunningHubExecutionContract, RunningHubPublicFieldContract, WorkflowDefinition } from "../types";
import type { RunningHubAiApp, RunningHubAppField } from "./client";
import { cleanWorkflowCredentials, detectWorkflowCredentials, isWorkflowCredentialFieldName } from "../workflow/credentials";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identity = (nodeId: string, field: string) => JSON.stringify([nodeId, field]);
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const own = (value: object, field: string) => Object.hasOwn(value, field);
const isLink = (value: unknown): value is [string, number] => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]) && value[1] >= 0;

/** Stable JSON preserves array order and every JSON value; object insertion order is irrelevant. */
function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const normalize = (input: unknown, depth: number): unknown => {
    if (depth > 80) throw new Error("RunningHub 工作流结构过深，无法生成执行快照。");
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (!input || typeof input !== "object" || active.has(input)) throw new Error("RunningHub 工作流包含无法规范化的数据，请重新读取。");
    active.add(input);
    let result: unknown;
    if (Array.isArray(input)) result = input.map(item => normalize(item, depth + 1));
    else result = Object.fromEntries(Object.keys(input).sort().filter(key => (input as Record<string, unknown>)[key] !== undefined)
      .map(key => [key, normalize((input as Record<string, unknown>)[key], depth + 1)]));
    active.delete(input);
    return result;
  };
  return JSON.stringify(normalize(value, 0));
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function requireGraph(value: unknown): ApiWorkflow {
  if (!record(value) || !Object.keys(value).length || Object.entries(value).some(([id, node]) =>
    !id || !record(node) || typeof node.class_type !== "string" || !node.class_type.trim() || !record(node.inputs)))
    throw new Error("RunningHub 缺少完整的执行图，请重新读取工作流。");
  return value as ApiWorkflow;
}

function shape(value: unknown): Pick<RunningHubBindingContract, "inputShape" | "valueType"> {
  if (isLink(value)) return { inputShape: "link" };
  if (value === null) return { inputShape: "scalar", valueType: "null" };
  if (["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("RunningHub 输入不是有效数值。");
    return { inputShape: "scalar", valueType: typeof value as "string" | "number" | "boolean" };
  }
  return { inputShape: "structured" };
}

function bindingTargets(workflow: WorkflowDefinition, graph: ApiWorkflow): RunningHubBindingContract[] {
  const fields = [...workflow.mapping.map(({ nodeId, field }) => ({ nodeId, field })),
    ...detectWorkflowCredentials(workflow).map(({ nodeId, field }) => ({ nodeId, field }))];
  const targets = new Map<string, RunningHubBindingContract>();
  for (const { nodeId, field } of fields) {
    const node = graph[nodeId];
    if (!node || !own(node.inputs, field)) throw new Error("RunningHub 绑定目标不存在：" + nodeId + "." + field + "。请重新读取或调整绑定。");
    const input = shape(node.inputs[field]);
    if (input.inputShape !== "scalar") throw new Error("RunningHub 绑定不能覆盖节点连接或结构：" + nodeId + "." + field + "。请重新调整绑定。");
    targets.set(identity(nodeId, field), { nodeId, classType: node.class_type, field, ...input });
  }
  for (const output of [workflow.output, ...(workflow.additionalOutputs ?? [])]) {
    if (!graph[output.nodeId]) throw new Error("RunningHub 输出节点不存在：" + output.nodeId + "。请重新读取工作流。");
    if (output.prefix && typeof graph[output.prefix.nodeId]?.inputs[output.prefix.field] !== "string")
      throw new Error("RunningHub 输出前缀绑定已失效，请重新调整绑定。");
  }
  return [...targets.values()].sort((a, b) => compare(identity(a.nodeId, a.field), identity(b.nodeId, b.field)));
}

function sourceDescription(workflow: WorkflowDefinition) {
  // The credential cleaner follows PrimitiveString credential sources as well as direct ports.
  const clean = cleanWorkflowCredentials(workflow), graph = requireGraph(clean.template);
  const nodes = Object.entries(graph).map(([nodeId, node]) => ({ nodeId, classType: node.class_type }))
    .sort((a, b) => compare(a.nodeId, b.nodeId));
  return { graph, nodes, targets: bindingTargets(clean, graph) };
}

/** Execution semantics are separate from graph values and the per-node result selection. */
function bindingDescription(workflow: WorkflowDefinition) {
  const ordered = <T>(values: T[]) => values.sort((a, b) => compare(canonicalJson(a), canonicalJson(b)));
  return {
    ...(workflow.runninghub?.bindingMode === "selected" ? { bindingMode: "selected", includeWorkflowJson: workflow.runninghub.includeWorkflowJson === true } : {}),
    mapping: ordered(workflow.mapping.map(item => ({ semantic: item.semantic, nodeId: item.nodeId, field: item.field,
      index: item.index, pathMode: item.pathMode, serialization: item.serialization, maxItems: item.maxItems }))),
    slots: ordered((workflow.inputSlots ?? []).map(slot => ({ semantic: slot.semantic, kind: slot.kind, required: slot.required }))),
    requiredInputs: [...workflow.requiredInputs].sort(), optionalInputs: [...workflow.optionalInputs].sort(),
    mediaInputMode: workflow.mediaInputMode ?? null,
    mediaInputs: ordered((workflow.runninghub?.mediaInputs ?? []).map(input => ({ nodeId: input.nodeId, field: input.field,
      required: input.required, ...(own(input, "emptyValue") ? { emptyValue: input.emptyValue } : {}) }))),
    credentials: ordered(detectWorkflowCredentials(workflow).map(field => ({ nodeId: field.nodeId, field: field.field,
      required: field.required, parameterKey: field.parameterKey }))),
  };
}

/** An older project may reuse a catalog snapshot only for the identical execution source. */
export function sameRunningHubExecutionSource(left: WorkflowDefinition, right: WorkflowDefinition): boolean {
  if (!left.runninghub || !right.runninghub) return false;
  const signature = (workflow: WorkflowDefinition) => {
    const source = sourceDescription(workflow), rh = workflow.runninghub!;
    return canonicalJson({ graph: source.graph,
      bindings: bindingDescription(workflow),
      output: workflow.output, additionalOutputs: workflow.additionalOutputs ?? [],
      site: rh.baseUrl.replace(/\/$/, ""), id: rh.workflowId, kind: rh.kind ?? "workflow", apiVersion: rh.apiVersion ?? "v1",
    });
  };
  try { return signature(left) === signature(right); } catch { return false; }
}

const declaredTypes: Record<string, string> = { INT: "integer", INTEGER: "integer", FLOAT: "number", DOUBLE: "number", NUMBER: "number", BOOL: "boolean", BOOLEAN: "boolean", STRING: "string", TEXT: "string" };
const widgetType = /^(?:INT|INTEGER|FLOAT|DOUBLE|NUMBER|BOOL|BOOLEAN|STRING|TEXT|IMAGE|MASK|VIDEO|AUDIO|COMBO|SELECT|LIST|ENUM)$/i;
function decodedFieldData(field: RunningHubAppField): unknown {
  if (typeof field.fieldData !== "string") return field.fieldData;
  try { return JSON.parse(field.fieldData); } catch { return undefined; }
}
function isWidgetTuple(data: unknown): data is [string, Record<string, unknown>] {
  return Array.isArray(data) && data.length === 2 && typeof data[0] === "string" && widgetType.test(data[0]) && record(data[1])
    && !["index", "value", "id", "name", "label"].some(key => own(data[1], key));
}
function fieldDataSettings(data: unknown): Record<string, unknown> {
  return record(data) ? data : isWidgetTuple(data) ? data[1] : {};
}
function originalOptions(data: unknown): unknown {
  if (record(data)) {
    for (const key of ["options", "choices", "values", "list"]) if (Array.isArray(data[key])) return data[key];
    return;
  }
  if (!Array.isArray(data) || !data.length) return;
  if (Array.isArray(data[0])) return data[0];
  if (isWidgetTuple(data))
    return originalOptions(data[1]);
  return data;
}
const choiceMetadata = new Set(["default", "defaultValue", "description", "descriptionEn", "name", "label", "tooltip", "placeholder", "multiline", "min", "max", "step", "minimum", "maximum", "required", "optional", "image_upload", "video_upload", "audio_upload", "round", "precision", "randomize"]);
const wireChoice = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
const presentationKeys = new Set(["name", "label", "description", "descriptionEn", "displayName", "title", "tooltip", "placeholder", "default", "defaultValue"]);
function opaqueOption(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(opaqueOption);
  if (!record(value)) return value;
  // A label-only unknown entry has no proven wire value: keep its fingerprint rather than guessing.
  const hasContractData = Object.keys(value).some(key => !presentationKeys.has(key));
  return Object.fromEntries(Object.entries(value).filter(([key]) => !hasContractData || !presentationKeys.has(key)).map(([key, item]) => [key, opaqueOption(item)]));
}

/** Display labels and widget defaults are not choices. Unknown entries remain explicit fingerprints. */
async function optionContract(raw: unknown): Promise<unknown> {
  if (raw === undefined) return undefined;
  const values = new Map<string, string | number | boolean>(), opaque: unknown[] = [];
  for (const item of Array.isArray(raw) ? raw : [raw]) {
    if (wireChoice(item)) { values.set(canonicalJson(item), item); continue; }
    if (record(item)) {
      const key = ["index", "value", "id"].find(name => own(item, name) && item[name] !== null && item[name] !== undefined);
      if (key) {
        const value = item[key];
        if (wireChoice(value)) values.set(canonicalJson(value), value);
        else opaque.push({ choiceField: key, value });
        continue;
      }
      const keys = Object.keys(item);
      if (keys.length && keys.every(name => choiceMetadata.has(name)) && keys.some(name => !["name", "label", "description", "descriptionEn", "tooltip", "placeholder"].includes(name))) continue;
    }
    opaque.push(item);
  }
  const sortedValues = [...values].sort(([a], [b]) => compare(a, b)).map(([, value]) => value);
  if (!sortedValues.length && !opaque.length) return undefined;
  const opaqueFingerprints = [...new Set(await Promise.all(opaque.map(item => sha256(opaqueOption(item)))))].sort();
  return { values: sortedValues, ...(opaqueFingerprints.length ? { unrecognizedCount: opaque.length, opaqueFingerprints } : {}) };
}
function numericBound(primary: unknown, fallback: unknown): number | undefined {
  const value = primary ?? fallback;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function publicFields(app: RunningHubAiApp): Promise<RunningHubPublicFieldContract[]> {
  const seen = new Set<string>();
  const fields = await Promise.all(app.nodeInfoList.map(async field => {
    const key = identity(field.nodeId, field.fieldName);
    if (!field.nodeId || !field.fieldName || seen.has(key)) throw new Error("RunningHub AI 应用公开参数无效或重复，请重新读取。");
    seen.add(key);
    const secret = field.secret === true || isWorkflowCredentialFieldName(field.fieldName)
      || isWorkflowCredentialFieldName(field.description ?? "") || /^(?:PASSWORD|SECRET|API_KEY|ACCESS_TOKEN)$/i.test(field.fieldType ?? "");
    const data = decodedFieldData(field), settings = fieldDataSettings(data);
    const rawType = field.fieldType?.trim().toUpperCase() || (isWidgetTuple(data) ? data[0].toUpperCase() : "");
    const type = rawType ? declaredTypes[rawType] ?? rawType.toLowerCase() : secret ? "string" : field.fieldValue === null ? "string" : typeof field.fieldValue;
    const invalidJson = typeof field.fieldData === "string" && field.fieldData.trim() && data === undefined;
    const options = secret ? undefined : await optionContract(invalidJson ? [{ invalidFieldData: field.fieldData }] : originalOptions(data));
    const result: RunningHubPublicFieldContract = { nodeId: field.nodeId, fieldName: field.fieldName, type,
      required: field.required ?? settings.required === true, secret };
    if (options !== undefined) result.options = options;
    for (const key of ["min", "max", "step"] as const) {
      const value = numericBound(field[key], settings[key] ?? settings[key === "min" ? "minimum" : key === "max" ? "maximum" : "step"]);
      if (value !== undefined) result[key] = value;
    }
    if (!secret && own(field, "mediaEmptyValue") && (field.mediaEmptyValue === null || typeof field.mediaEmptyValue === "string")) result.mediaEmptyValue = field.mediaEmptyValue;
    return result;
  }));
  return fields.sort((a, b) => compare(identity(a.nodeId, a.fieldName), identity(b.nodeId, b.fieldName)));
}

/** Capture a sanitized source graph and bindings; no account or node Key is stored here. */
export async function attachRunningHubExecutionContract(workflow: WorkflowDefinition, app?: RunningHubAiApp): Promise<WorkflowDefinition> {
  if (!workflow.runninghub) throw new Error("只能为 RunningHub 工作流生成执行快照。");
  const result = cleanWorkflowCredentials(workflow), source = sourceDescription(result);
  const isApp = result.runninghub!.kind === "app";
  if (isApp && !app) throw new Error("请先重新读取 AI 应用公开参数，再保存执行快照。");
  const contract: RunningHubExecutionContract = { version: 1, scope: isApp ? "public-inputs" : "full-graph",
    sourceHash: await sha256(source.graph), bindingHash: await sha256(bindingDescription(result)), nodeCount: source.nodes.length, nodes: source.nodes, targets: source.targets };
  if (isApp && app) {
    const fields = await publicFields(app);
    contract.publicFieldCount = fields.length;
    contract.publicSchema = { hash: await sha256(fields), fields };
  }
  result.runninghub!.executionContract = contract;
  return result;
}

/** Rebind the identical verified source without inventing a fresh public application schema. */
export async function rebindRunningHubExecutionContract(workflow: WorkflowDefinition, previous: WorkflowDefinition): Promise<WorkflowDefinition> {
  const old = previous.runninghub, next = workflow.runninghub;
  if (!old?.executionContract || !next) throw new Error("请先重新读取 RunningHub 工作流并保存有效的执行快照。");
  await validateRunningHubExecutionGraph(previous);
  const previousSource = sourceDescription(previous), source = sourceDescription(workflow);
  if (old.workflowId !== next.workflowId || old.baseUrl.replace(/\/$/, "") !== next.baseUrl.replace(/\/$/, "")
    || (old.kind ?? "workflow") !== (next.kind ?? "workflow") || (old.apiVersion ?? "v1") !== (next.apiVersion ?? "v1")
    || canonicalJson(previousSource.graph) !== canonicalJson(source.graph))
    throw new Error("RunningHub 执行源已变化，请重新读取后再保存绑定。");
  const result = cleanWorkflowCredentials(workflow), contract: RunningHubExecutionContract = {
    version: 1, scope: next.kind === "app" ? "public-inputs" : "full-graph",
    sourceHash: await sha256(source.graph), bindingHash: await sha256(bindingDescription(result)),
    nodeCount: source.nodes.length, nodes: source.nodes, targets: source.targets,
  };
  if (next.kind === "app") {
    const schema = old.executionContract.publicSchema;
    if (!schema || !Array.isArray(schema.fields) || old.executionContract.publicFieldCount !== schema.fields.length || schema.hash !== await sha256(schema.fields))
      throw new Error("RunningHub AI 应用缺少有效的公开参数快照，请重新读取后再保存绑定。");
    contract.publicFieldCount = schema.fields.length;
    contract.publicSchema = structuredClone(schema);
  }
  result.runninghub!.executionContract = contract;
  return result;
}

/** Validate local integrity only: a full JSON submission need not match a remote template. */
export async function validateRunningHubExecutionGraph(workflow: WorkflowDefinition, runtimeGraph?: ApiWorkflow): Promise<void> {
  const source = sourceDescription(workflow), contract = workflow.runninghub?.executionContract;
  if (contract) {
    if (contract.version !== 1 || !["full-graph", "public-inputs"].includes(contract.scope)
      || contract.scope !== (workflow.runninghub?.kind === "app" ? "public-inputs" : "full-graph")
      || contract.nodeCount !== source.nodes.length || canonicalJson(contract.nodes) !== canonicalJson(source.nodes)
      || canonicalJson(contract.targets) !== canonicalJson(source.targets) || contract.sourceHash !== await sha256(source.graph)
      || workflow.runninghub?.bindingMode === "selected" && !contract.bindingHash
      || contract.bindingHash !== undefined && contract.bindingHash !== await sha256(bindingDescription(workflow)))
      throw new Error("RunningHub 已保存的执行图或绑定发生变化，请重新读取或保存工作流后再运行。");
  }
  if (!runtimeGraph) return;
  const runtime = requireGraph(runtimeGraph);
  const selected = workflow.runninghub?.bindingMode === "selected" && workflow.runninghub.kind !== "app";
  const targets = new Set(source.targets.map(target => identity(target.nodeId, target.field)));
  if (selected && (Object.keys(runtime).length !== source.nodes.length || Object.keys(runtime).some(nodeId => !own(source.graph, nodeId))))
    throw new Error("RunningHub 执行图节点集合变化。未提交任务。");
  const media = new Set(workflow.runninghub?.mediaInputs?.map(field => identity(field.nodeId, field.field)) ?? []);
  for (const [nodeId, node] of Object.entries(source.graph)) {
    const current = runtime[nodeId];
    if (!current || current.class_type !== node.class_type) throw new Error("RunningHub 执行图节点缺失或类型变化：" + nodeId + "。未提交任务。");
    if (selected && (Object.keys(current.inputs).length !== Object.keys(node.inputs).length || Object.keys(current.inputs).some(field => !own(node.inputs, field))))
      throw new Error("RunningHub 执行图字段集合变化：" + nodeId + "。未提交任务。");
    for (const [field, value] of Object.entries(node.inputs)) {
      if (!own(current.inputs, field)) throw new Error("RunningHub 执行图输入缺失：" + nodeId + "." + field + "。未提交任务。");
      const before = shape(value), after = shape(current.inputs[field]);
      if (before.inputShape !== after.inputShape || before.inputShape === "link" && canonicalJson(value) !== canonicalJson(current.inputs[field]))
        throw new Error("RunningHub 执行图连接或输入结构变化：" + nodeId + "." + field + "。未提交任务。");
      if (selected && !targets.has(identity(nodeId, field)) && canonicalJson(value) !== canonicalJson(current.inputs[field]))
        throw new Error("RunningHub 未选字段发生变化：" + nodeId + "." + field + "。请重新保存绑定后再运行。未提交任务。");
    }
  }
  for (const target of source.targets) {
    const actual = shape(runtime[target.nodeId].inputs[target.field]);
    const mediaScalar = media.has(identity(target.nodeId, target.field)) && ["string", "null"].includes(actual.valueType ?? "") && ["string", "null"].includes(target.valueType ?? "");
    if (actual.inputShape !== "scalar" || actual.valueType !== target.valueType && !mediaScalar)
      throw new Error("RunningHub 绑定输入类型变化：" + target.nodeId + "." + target.field + "。请重新调整绑定。");
  }
}

/** ID-only execution must still refer to the entire source the user reviewed. */
export async function validateRunningHubRemoteWorkflow(workflow: WorkflowDefinition, remoteGraph: ApiWorkflow): Promise<void> {
  await validateRunningHubExecutionGraph(workflow);
  const source = sourceDescription(workflow), remote = requireGraph(remoteGraph);
  const changed = () => new Error("RunningHub 远程工作流已变化，请重新读取并确认绑定后再运行。未提交任务。");
  if (Object.keys(remote).length !== source.nodes.length || Object.keys(remote).some(nodeId => !own(source.graph, nodeId))) throw changed();
  for (const [nodeId, node] of Object.entries(source.graph)) {
    const fields = remote[nodeId].inputs;
    // Check before credential cleaning, which deliberately writes a blank value
    // to known secret ports and must not conceal a deleted remote input.
    if (Object.keys(fields).length !== Object.keys(node.inputs).length || Object.keys(fields).some(field => !own(node.inputs, field))) throw changed();
  }
  const sanitized = cleanWorkflowCredentials({ ...workflow, template: remote }).template!;
  const [localHash, remoteHash] = await Promise.all([sha256(source.graph), sha256(sanitized)]);
  if (localHash !== remoteHash) throw changed();
}

/** Compare the public field contract, never author examples, prompt defaults or titles. */
export async function validateRunningHubPublicSchema(workflow: WorkflowDefinition, app: RunningHubAiApp): Promise<void> {
  const saved = workflow.runninghub?.executionContract?.publicSchema;
  if (!saved) return; // Older saved applications retain their existing execution path.
  if (saved.hash !== await sha256(await publicFields(app)))
    throw new Error("RunningHub AI 应用的公开参数已变化，请重新读取并确认绑定后再运行。未提交任务。");
}
