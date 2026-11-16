import type { CredentialField, WorkflowDefinition } from "../types";

export type { CredentialField } from "../types";
export type WorkflowCredentialValues = Record<string, string>;

/** Match credential ports, never sampler tokens, token counts or keyframes. */
export function isWorkflowCredentialFieldName(name: string): boolean {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[\s.:-]+/g, "_");
  return /(?:^|_)(?:api_?key|access_?token|auth_?token|authorization|bearer_?token|secret_?key|client_?secret)(?:_\d+)?$/.test(normalized)
    || /^(?:api_?密钥|访问令牌|认证令牌|鉴权令牌|授权令牌|密钥)$/.test(normalized);
}

const idFor = (nodeId: string, field: string) => nodeId + ":" + encodeURIComponent(field);
const textInput = (value: unknown) => typeof value === "string" || value === null || value === undefined;

/** Source contracts and explicit secret metadata take precedence over labels. */
export function detectWorkflowCredentials(workflow: WorkflowDefinition): CredentialField[] {
  const fields = new Map<string, CredentialField>();
  const graph = workflow.template ?? {};
  const add = (field: CredentialField) => {
    if (!field.nodeId || !field.field) return;
    const node = graph[field.nodeId];
    // Linked ports are graph edges; replacing them with a key would change the workflow.
    if (node && !textInput(node.inputs[field.field])) return;
    const identity = field.nodeId + "\0" + field.field;
    const existing = fields.get(identity);
    fields.set(identity, existing ? { ...existing, ...field, parameterKey: field.parameterKey ?? existing.parameterKey } : field);
  };
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (!isWorkflowCredentialFieldName(field)) continue;
      let sourceId = nodeId, sourceField = field;
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && value[1] === 0) {
        const upstream = graph[value[0]];
        if (!upstream || !/^PrimitiveString(?:Multiline)?$/.test(upstream.class_type) || typeof upstream.inputs.value !== "string") continue;
        sourceId = value[0]; sourceField = "value";
      } else if (!textInput(value)) continue;
      const parameter = workflow.parameters.find(parameter => workflow.mapping.some(mapping => mapping.semantic === parameter.key && mapping.nodeId === sourceId && mapping.field === sourceField));
      add({ id: idFor(sourceId, sourceField), nodeId: sourceId, field: sourceField, label: parameter?.secret ? parameter.label : field,
        required: parameter?.required ?? true, ...(parameter ? { parameterKey: parameter.key } : {}) });
    }
  }
  for (const parameter of workflow.parameters) {
    if (!parameter.secret && !isWorkflowCredentialFieldName(parameter.key)) continue;
    const mapping = workflow.mapping.filter(mapping => mapping.semantic === parameter.key);
    for (const target of mapping) add({ id: idFor(target.nodeId, target.field), nodeId: target.nodeId, field: target.field,
      label: parameter.label || target.field, required: parameter.required ?? true, parameterKey: parameter.key });
  }
  for (const field of workflow.credentials ?? []) {
    if (field && typeof field.id === "string" && typeof field.nodeId === "string" && typeof field.field === "string") add({ ...field });
  }
  return [...fields.values()];
}

/** Strip author examples before storing a workflow or exposing ordinary controls.
 * By default the caller owns a writable copy. Catalog normalization may opt
 * into identity preservation when it only needs to inspect a clean workflow.
 */
export function cleanWorkflowCredentials(workflow: WorkflowDefinition, options: { preserveIdentity?: boolean } = {}): WorkflowDefinition {
  const fields = detectWorkflowCredentials(workflow);
  const parameterKeys = new Set(fields.map(field => field.parameterKey).filter((key): key is string => !!key));
  const bindingTargetsCredential = (binding: unknown) => {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
    const target = binding as Record<string, unknown>;
    return fields.some(field => target.nodeId === field.nodeId && target.path === "inputs." + field.field);
  };
  const exampleKeys = ["value", "default", "defaultValue", "fieldValue"];
  const bindingHasExample = (binding: unknown) => {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
    return Object.entries(binding).some(([name, value]) =>
      (exampleKeys.includes(name) || isWorkflowCredentialFieldName(name)) && value !== "");
  };
  const parametersNeedCleaning = workflow.parameters.some(parameter =>
    (parameter.secret || parameterKeys.has(parameter.key)) &&
    (!parameter.secret || parameter.default !== "" || !!parameter.options?.length ||
      !!(parameter.optionLabels && Object.keys(parameter.optionLabels).length) ||
      !!(parameter.optionValues && Object.keys(parameter.optionValues).length)));
  const graphNeedsCleaning = fields.some(credential => {
    const node = workflow.template?.[credential.nodeId];
    if (!node) return false;
    const value = node.inputs[credential.field];
    return textInput(value) && value !== "";
  });
  const original = workflow.original;
  const bindingsNeedCleaning = !!original && (
    Object.entries(original.parameterBindings).some(([key, binding]) =>
      (parameterKeys.has(key) || bindingTargetsCredential(binding)) && bindingHasExample(binding)) ||
    original.inputs.some(input => bindingTargetsCredential(input.binding) && bindingHasExample(input.binding)));
  const metadataNeedsCleaning = (fields.length > 0 || !!workflow.credentials) &&
    JSON.stringify(workflow.credentials ?? []) !== JSON.stringify(fields);
  // Most definitions contain no credentials. Keep the historical writable-copy
  // contract for callers that add bindings or snapshots after cleaning.
  if (!parametersNeedCleaning && !graphNeedsCleaning && !bindingsNeedCleaning && !metadataNeedsCleaning)
    return options.preserveIdentity ? workflow : structuredClone(workflow);
  const result = structuredClone(workflow);
  result.parameters = result.parameters.map(parameter => parameter.secret || parameterKeys.has(parameter.key)
    ? { ...parameter, secret: true, default: "", ...(parameter.options ? { options: [] } : {}), ...(parameter.optionLabels ? { optionLabels: {} } : {}), ...(parameter.optionValues ? { optionValues: {} } : {}) }
    : parameter);
  for (const credential of fields) {
    const node = result.template?.[credential.nodeId];
    if (node && textInput(node.inputs[credential.field])) node.inputs[credential.field] = "";
  }
  // Bindings normally contain only target/nodeId/path. Some imported configs
  // append examples there; clear only values attached to a proven secret port.
  const cleanBindingExamples = (binding: unknown) => {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) return;
    const target = binding as Record<string, unknown>;
    for (const name of Object.keys(target)) {
      if (exampleKeys.includes(name) || isWorkflowCredentialFieldName(name)) target[name] = "";
    }
  };
  if (result.original) {
    for (const [key, binding] of Object.entries(result.original.parameterBindings)) {
      if (parameterKeys.has(key) || bindingTargetsCredential(binding)) cleanBindingExamples(binding);
    }
    for (const input of result.original.inputs) if (bindingTargetsCredential(input.binding)) cleanBindingExamples(input.binding);
  }
  if (fields.length || result.credentials) result.credentials = fields;
  return result;
}

/** Local keys are inserted only into an execution copy, after ordinary parameters. */
export function applyWorkflowCredentials(workflow: WorkflowDefinition, values: WorkflowCredentialValues): WorkflowDefinition {
  // The default cleaner returns an execution copy even without credential fields.
  const result = cleanWorkflowCredentials(workflow);
  const runtimeValues = credentialParameterValues(result, values);
  for (const credential of detectWorkflowCredentials(result)) {
    const node = result.template?.[credential.nodeId];
    if (node && textInput(node.inputs[credential.field])) node.inputs[credential.field] = values[credential.id]?.trim() ?? "";
  }
  result.parameters = result.parameters.map(parameter => Object.hasOwn(runtimeValues, parameter.key) ? { ...parameter, default: runtimeValues[parameter.key] } : parameter);
  return result;
}

export function credentialParameterValues(workflow: WorkflowDefinition, values: WorkflowCredentialValues): Record<string, string> {
  return Object.fromEntries(detectWorkflowCredentials(workflow).filter(field => !!field.parameterKey).map(field => [field.parameterKey!, values[field.id]?.trim() ?? ""]));
}

export function missingWorkflowCredentials(workflow: WorkflowDefinition, values: WorkflowCredentialValues): CredentialField[] {
  return detectWorkflowCredentials(workflow).filter(field => field.required && !values[field.id]?.trim());
}

/** Errors may contain upstream request echoes; never return stored key values. */
export function redactWorkflowCredentialText(text: string, values: WorkflowCredentialValues): string {
  const secrets = [...new Set(Object.values(values).map(value => value.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of secrets) {
    for (const variant of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) result = result.split(variant).join("[已隐藏密钥]");
  }
  return result;
}
