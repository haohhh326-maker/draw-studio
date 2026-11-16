import type { ApiWorkflow, Mapping, Parameter, WorkflowDefinition } from "../types";

export type LoraParameterTarget = {
  kind: "model" | "strength";
  nodeId: string;
  field: string;
  /** A loader stack may expose several independently selectable LoRAs. */
  slot?: string;
};

const primitiveFields = /^(?:value|string|int|integer|float|number)$/i;
const isPrimitive = (node: ApiWorkflow[string] | undefined) => !!node && /primitive/i.test(node.class_type);
const isLink = (value: unknown): value is [string, number] => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";

function modelSlot(field: string, node: ApiWorkflow[string]): { slot?: string } | undefined {
  const named = field.match(/^lora[_-]?(?:name|model(?:[_-]?name)?|file(?:[_-]?name)?)(?:[_-]?(\d+))?$/i);
  if (named) return named[1] ? { slot: named[1] } : {};
  // rgthree and several custom loaders use lora_01 or lora_0 rather than lora_name.
  const indexed = field.match(/^lora[_-](\d+)$/i);
  if (/lora/i.test(node.class_type) && indexed) return { slot: indexed[1] };
  if (/lora/i.test(node.class_type) && /^lora$/i.test(field)) return {};
  return undefined;
}

function strengthSlot(field: string): { slot?: string } | undefined {
  const match = field.match(/^(?:(?:lora|model|clip|text)[_-])?(?:strength|scale|weight|alpha)(?:[_-](?:model|clip|text))?(?:[_-](\d+))?$/i);
  if (match) return match[1] ? { slot: match[1] } : {};
  const indexed = field.match(/^lora[_-](\d+)[_-](?:strength|scale|weight|alpha)$/i);
  return indexed ? { slot: indexed[1] } : undefined;
}

/** Identify explicit filename ports and only the strengths paired with those ports. */
function loraTargets(workflow: WorkflowDefinition): LoraParameterTarget[] {
  const targets: LoraParameterTarget[] = [];
  for (const [nodeId, node] of Object.entries(workflow.template ?? {})) {
    const models = Object.keys(node.inputs).flatMap(field => {
      const slot = modelSlot(field, node);
      return slot ? [{ kind: "model" as const, nodeId, field, ...slot }] : [];
    });
    if (!models.length) continue;
    targets.push(...models);
    for (const field of Object.keys(node.inputs)) {
      const slot = strengthSlot(field);
      if (slot && models.some(model => model.slot === slot.slot)) targets.push({ kind: "strength", nodeId, field, ...slot });
    }
  }
  return targets;
}

function primitiveInput(node: ApiWorkflow[string], kind: LoraParameterTarget["kind"]): string | undefined {
  const candidates = Object.keys(node.inputs).filter(field => primitiveFields.test(field) && (isLink(node.inputs[field]) || typeof node.inputs[field] === (kind === "model" ? "string" : "number")));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Find the editable scalar behind a primitive without replacing any graph connection. */
function scalarBinding(workflow: WorkflowDefinition, target: LoraParameterTarget): { nodeId: string; field: string; value: string | number } | undefined {
  let nodeId = target.nodeId, field = target.field;
  const visited = new Set<string>();
  while (true) {
    const node = workflow.template?.[nodeId], marker = nodeId + "\0" + field;
    if (!node || visited.has(marker)) return undefined;
    visited.add(marker);
    const value = node.inputs[field];
    if (target.kind === "model" && typeof value === "string") return { nodeId, field, value };
    if (target.kind === "strength" && typeof value === "number" && Number.isFinite(value)) return { nodeId, field, value };
    if (!isLink(value) || value[1] !== 0) return undefined;
    const source = workflow.template?.[value[0]];
    if (!isPrimitive(source)) return undefined;
    const sourceField = primitiveInput(source!, target.kind);
    if (!sourceField) return undefined;
    nodeId = value[0]; field = sourceField;
  }
}

function mappingsFor(parameter: Parameter, workflow: WorkflowDefinition): Mapping[] {
  const mappings = workflow.mapping.filter(mapping => mapping.semantic === parameter.key);
  if (mappings.length) return mappings;
  const binding = workflow.original?.parameterBindings[parameter.key];
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return [];
  const { nodeId, path } = binding as Record<string, unknown>;
  return typeof nodeId === "string" && typeof path === "string" && path.startsWith("inputs.") ? [{ semantic: parameter.key, nodeId, field: path.slice(7) }] : [];
}

/** Consumer identities remain available when a parameter is bound to a shared primitive. */
export function identifyLoraParameter(parameter: Parameter, workflow: WorkflowDefinition): LoraParameterTarget[] {
  const bindings = mappingsFor(parameter, workflow);
  return loraTargets(workflow).filter(target => {
    const scalar = scalarBinding(workflow, target);
    return !!scalar && bindings.some(mapping => mapping.nodeId === scalar.nodeId && mapping.field === scalar.field);
  });
}

/** Expose actual saved LoRA inputs omitted from a workflow's authored parameter configuration. */
export function withLoraParameters(workflow: WorkflowDefinition): WorkflowDefinition {
  if (!workflow.template) return workflow;
  const parameters = [...workflow.parameters], mapping = [...workflow.mapping];
  for (const target of loraTargets(workflow)) {
    const scalar = scalarBinding(workflow, target);
    if (!scalar || mapping.some(item => item.nodeId === scalar.nodeId && item.field === scalar.field)) continue;
    const base = "lora:" + scalar.nodeId + ":" + scalar.field;
    let key = base, suffix = 2;
    while (parameters.some(parameter => parameter.key === key) || mapping.some(item => item.semantic === key)) key = base + ":" + suffix++;
    parameters.push({ key, label: target.kind === "model" ? "LoRA 模型" : /clip|text/i.test(target.field) ? "LoRA 强度（文本）" : /model/i.test(target.field) ? "LoRA 强度（模型）" : "LoRA 强度", type: target.kind === "model" ? "text" : "number", default: scalar.value, advanced: true, group: "LoRA", ...(target.kind === "model" ? { model: true } : { step: .01 }) });
    mapping.push({ semantic: key, nodeId: scalar.nodeId, field: scalar.field });
  }
  return parameters.length === workflow.parameters.length ? workflow : { ...workflow, parameters, mapping };
}

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function serverChoices(info: Record<string, unknown>, workflow: WorkflowDefinition, target: { nodeId: string; field: string }): string[] | undefined {
  const type = workflow.template?.[target.nodeId]?.class_type;
  const input = object(object(type ? info[type] : undefined)?.input);
  const specification = object(input?.required)?.[target.field] ?? object(input?.optional)?.[target.field];
  if (!Array.isArray(specification)) return undefined;
  const options = Array.isArray(specification[0]) ? specification[0] : specification[0] === "COMBO" ? object(specification[1])?.options : undefined;
  return Array.isArray(options) && options.every(value => typeof value === "string") ? [...new Set(options as string[])] : undefined;
}

function filenameConsumers(parameter: Parameter, workflow: WorkflowDefinition, targets: LoraParameterTarget[]): { nodeId: string; field: string }[] {
  const consumers = [...targets];
  const visit = (nodeId: string, ancestry: Set<string>) => {
    if (ancestry.has(nodeId)) return;
    const seen = new Set(ancestry).add(nodeId);
    for (const [consumerId, node] of Object.entries(workflow.template ?? {})) for (const [field, value] of Object.entries(node.inputs)) {
      if (!isLink(value) || value[0] !== nodeId || value[1] !== 0) continue;
      if (isPrimitive(node) && primitiveFields.test(field)) visit(consumerId, seen);
      else consumers.push({ kind: "model", nodeId: consumerId, field });
    }
  };
  for (const mapping of mappingsFor(parameter, workflow)) if (isPrimitive(workflow.template?.[mapping.nodeId]) && primitiveFields.test(mapping.field)) visit(mapping.nodeId, new Set());
  return [...new Map(consumers.map(consumer => [consumer.nodeId + "\0" + consumer.field, consumer])).values()];
}

/** LoRA choices come from each loader's real filename contract, including shared primitive consumers. */
export function withServerLoraChoices(workflow: WorkflowDefinition, objectInfo: Record<string, unknown>): WorkflowDefinition {
  const enriched = withLoraParameters(workflow);
  let changed = false;
  const parameters = enriched.parameters.map(parameter => {
    const targets = identifyLoraParameter(parameter, enriched).filter(target => target.kind === "model");
    if (!targets.length || typeof parameter.default !== "string") return parameter;
    const lists = filenameConsumers(parameter, enriched, targets).map(target => serverChoices(objectInfo, enriched, target));
    // Missing consumer contracts cannot safely expand a shared primitive's selectable values.
    if (lists.some(list => !list)) return parameter;
    const compatible = lists[0]!.filter(name => lists.every(list => list!.includes(name)));
    // Keep the saved filename visible even if its file is absent from the connected engine.
    const options = [...new Set([parameter.default, ...compatible])];
    const labels = Object.fromEntries(options.flatMap(value => {
      const previous = parameter.options?.find(option => (parameter.optionValues?.[option] ?? option) === value);
      const label = previous ? parameter.optionLabels?.[previous] ?? (previous !== value ? previous : undefined) : undefined;
      return label ? [[value, label]] : [];
    }));
    if (parameter.type === "select" && parameter.model === true && !parameter.optionValues && JSON.stringify(parameter.options) === JSON.stringify(options) && JSON.stringify(parameter.optionLabels ?? {}) === JSON.stringify(labels)) return parameter;
    changed = true;
    const { optionValues: _values, optionLabels: _labels, ...rest } = parameter;
    return { ...rest, type: "select" as const, model: true, options, ...(Object.keys(labels).length ? { optionLabels: labels } : {}) };
  });
  return changed ? { ...enriched, parameters } : enriched;
}

export function hasLoraModels(workflow: WorkflowDefinition): boolean {
  return workflow.parameters.some(parameter => identifyLoraParameter(parameter, workflow).some(target => target.kind === "model"));
}
