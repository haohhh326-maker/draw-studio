import type { AifisherBindingCandidate, AifisherWorkflowReadResult } from "./aifisher-reader-client";

type Data = Record<string, any>;
const record = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const groupCandidate = (candidate: AifisherBindingCandidate) => candidate.valueType === "ASSET_GROUP" || candidate.variableAssetGroup !== undefined;

/** Only recover real, already-wired loader slots. Variable expansion stays guarded. */
function originalLoaderSlots(read: AifisherWorkflowReadResult, candidate: AifisherBindingCandidate): AifisherBindingCandidate[] | undefined {
  const group = candidate.variableAssetGroup;
  if (!record(group) || group.schemaVersion !== 1 || group.strategy !== "optional-autogrow-direct-loaders"
    || group.targetNodeId !== candidate.nodeId || group.targetClassType !== candidate.classType
    || group.groupName !== candidate.fieldName || group.mediaKind !== candidate.mediaKind
    || !Array.isArray(group.branches) || !Number.isInteger(group.capacity) || group.capacity !== group.branches.length) return;
  const graph = read.workflow, target = graph?.[candidate.nodeId], definition = read.nodeDefinitions?.[candidate.classType];
  if (!graph || !target || target.class_type !== candidate.classType || !record(definition)) return;
  const optional = definition.input?.optional;
  function declaredConnection(connection: unknown, index?: number): connection is Data {
    if (!record(connection) || !record(optional)) return false;
    const spec = optional[connection.groupName];
    if (!Array.isArray(spec) || spec[0] !== "COMFY_AUTOGROW_V3" || !record(spec[1]?.template)) return false;
    const template = spec[1].template, required = template.input?.required;
    if (!record(required) || template.prefix !== connection.prefix || typeof template.prefix !== "string" || !template.prefix) return false;
    const types = Object.values(required).flatMap(spec => Array.isArray(spec) && typeof spec[0] === "string" ? [spec[0]] : []);
    if (types.length !== 1 || connection.childType !== undefined && connection.childType !== types[0]) return false;
    if (index !== undefined && (!Number.isInteger(template.max) || index >= template.max
      || connection.targetFieldName !== connection.groupName + "." + template.prefix + index)) return false;
    return true;
  }
  if (group.capacity === 0) {
    // An optional synthetic loader is a suggestion for a new route. Existing
    // references can instead arrive through a frame processor and a separate
    // soundtrack connection. Keep those declared, type-checked routes intact.
    const template = group.syntheticTemplate;
    if (group.minimumItems !== 0 || !record(template) || !Array.isArray(template.connections)
      || !template.connections.some(connection => record(connection) && connection.groupName === group.groupName)
      || !template.connections.every(connection => declaredConnection(connection))) return;
    for (const connection of template.connections) {
      const prefix = connection.groupName + "." + connection.prefix;
      for (const [field, value] of Object.entries(target.inputs)) {
        if (!field.startsWith(prefix)) continue;
        const index = field.slice(prefix.length);
        if (!/^(?:0|[1-9]\d*)$/.test(index) || !declaredConnection({ ...connection, targetFieldName: field }, Number(index))
          || !Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || !Number.isInteger(value[1]) || value[1] < 0) return;
        const source = graph[value[0]], sourceDefinition = source && read.nodeDefinitions?.[source.class_type];
        const spec = optional[connection.groupName], child = Object.values(spec[1].template.input.required)[0] as unknown[];
        if (!source || !record(sourceDefinition) || !Array.isArray(sourceDefinition.output) || sourceDefinition.output[value[1]] !== child[0]) return;
      }
    }
    return [];
  }
  if (!Number.isInteger(group.minimumItems) || group.minimumItems < 0 || group.minimumItems > group.capacity) return;
  const slots: AifisherBindingCandidate[] = [], seen = new Set<string>();
  for (const [index, branch] of group.branches.entries()) {
    if (!record(branch) || branch.index !== index || typeof branch.sourceNodeId !== "string" || typeof branch.assetFieldName !== "string"
      || !Array.isArray(branch.connections) || !branch.connections.length) return;
    const loader = graph[branch.sourceNodeId], loaderDefinition = read.nodeDefinitions?.[branch.sourceClassType];
    const key = branch.sourceNodeId + "\0" + branch.assetFieldName;
    if (seen.has(key) || !loader || loader.class_type !== branch.sourceClassType || typeof loader.inputs[branch.assetFieldName] !== "string"
      || !record(loaderDefinition) || !Array.isArray(loaderDefinition.output)) return;
    seen.add(key);
    const raw = read.analysis.candidateBindings.find(item => item.nodeId === branch.sourceNodeId && item.fieldName === branch.assetFieldName
      && item.classType === branch.sourceClassType && item.control === "asset" && item.mediaKind === candidate.mediaKind
      && Object.is(item.value, loader.inputs[branch.assetFieldName]));
    if (!raw) return;
    for (const connection of branch.connections) {
      if (!declaredConnection(connection, index) || !Number.isInteger(connection.outputIndex) || connection.outputIndex < 0) return;
      const value = target.inputs[connection.targetFieldName];
      const spec = optional[connection.groupName], child = Object.values(spec[1].template.input.required)[0] as unknown[];
      if (!Array.isArray(value) || value.length !== 2 || String(value[0]) !== branch.sourceNodeId || value[1] !== connection.outputIndex
        || loaderDefinition.output[connection.outputIndex] !== child[0]) return;
    }
    slots.push({ ...raw, id: raw.id ?? "source-slot:" + branch.sourceNodeId + ":" + branch.assetFieldName });
  }
  return slots;
}

export function aifisherCanvasBindingCandidates(read: AifisherWorkflowReadResult): AifisherBindingCandidate[] {
  return read.bindingCandidates.flatMap(candidate => groupCandidate(candidate) ? originalLoaderSlots(read, candidate) ?? [candidate] : [candidate]);
}

export function remainingUnsupportedAifisherAssetGroups(read: AifisherWorkflowReadResult) {
  return read.bindingCandidates.filter(candidate => groupCandidate(candidate) && originalLoaderSlots(read, candidate) === undefined);
}

/**
 * The legacy canvas collection runtime has one target and one route per media
 * kind. An upstream ASSET_GROUP can have several targets, synthetic loaders and
 * paired video/audio branches. Do not flatten that contract into a nonexistent
 * scalar port or discard any of its connections.
 */
export function assertAifisherVariableAssetsSupported(read: AifisherWorkflowReadResult): void {
  const groups = remainingUnsupportedAifisherAssetGroups(read);
  if (!groups.length) return;
  const diagnostics = groups.map(candidate => ({
    severity: "error" as const,
    code: "aifisher-variable-asset-runtime-required",
    nodeId: candidate.nodeId,
    field: candidate.fieldName,
    message: "AIFISHER 已读取节点 " + candidate.nodeId + "（" + candidate.classType + "）的动态素材组 " + candidate.fieldName
      + "；此组需要对应的 AIFISHER 动态素材执行方式，不能改写成普通文件输入。原始工作流和全部连接已保留。",
  }));
  const error = new Error(diagnostics.map(item => item.message).join("\n"));
  Object.assign(error, { code: "AIFISHER_VARIABLE_ASSET_RUNTIME_REQUIRED", diagnostics });
  throw error;
}
