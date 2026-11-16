import { analyzeWorkflow } from "../vendor/aifisher/server/workflowRuntime/workflowFormat.js";
import { deriveBindingCandidates } from "../vendor/aifisher/server/workflowRuntime/workflowBindingCompiler.js";

type Data = Record<string, any>;
const record = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value);
const dynamic = (spec: unknown): spec is unknown[] => Array.isArray(spec) && /^COMFY_DYNAMICCOMBO(?:_V\d+)?$/i.test(String(spec[0]));
const scalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
const unsafe = (key: string) => ["__proto__", "constructor", "prototype"].includes(key);

/**
 * ComfyUI V3 serializes the selected branch as dotted API inputs. Give the
 * unchanged upstream reader that concrete schema, separately for each node:
 * two instances of the same class may select different branches.
 * This is a temporary reading contract; neither the graph nor raw definitions
 * are edited, and no branch defaults or missing inputs are invented.
 */
function expandedDefinition(definition: Data, inputs: Data): { definition: Data; fields: Set<string> } | undefined {
  if (!record(definition.input)) return;
  const input: Data = { ...definition.input,
    required: { ...(record(definition.input.required) ? definition.input.required : {}) },
    optional: { ...(record(definition.input.optional) ? definition.input.optional : {}) } };
  const fields = new Set<string>();
  function expand(field: string, spec: unknown[], section: "required" | "optional", depth: number): void {
    if (depth > 32 || !dynamic(spec) || !record(spec[1]) || !Array.isArray(spec[1].options)) return;
    const options = spec[1].options;
    if (!options.length || !options.every(option => record(option) && scalar(option.key)
      && (option.inputs === undefined || record(option.inputs)))) return;
    const keys = options.map(option => option.key);
    if (new Set(keys).size !== keys.length) return;
    input[section][field] = [keys, { ...spec[1], options: keys }];
    fields.add(field);
    const selected = options.find(option => Object.is(option.key, inputs[field]));
    if (!selected || !record(selected.inputs)) return;
    for (const childSection of ["required", "optional"] as const) {
      const children = selected.inputs[childSection];
      if (!record(children)) continue;
      for (const [child, childSpec] of Object.entries(children)) {
        if (!child || unsafe(child) || !Array.isArray(childSpec)) continue;
        const path = field + "." + child;
        // A declared top-level field is authoritative; do not overwrite it
        // with a different dynamic contract sharing its dotted name.
        if (Object.hasOwn(input.required, path) || Object.hasOwn(input.optional, path)) continue;
        input[childSection][path] = childSpec;
        fields.add(path);
        expand(path, childSpec, childSection, depth + 1);
      }
    }
  }
  for (const section of ["required", "optional"] as const)
    for (const [field, spec] of Object.entries(input[section]))
      if (!unsafe(field) && dynamic(spec)) expand(field, spec, section, 0);
  return fields.size ? { definition: { ...definition, input }, fields } : undefined;
}

function rangeWarnings(nodeId: string, inputs: Data, definition: Data, fields: Set<string>): Data[] {
  const warnings: Data[] = [];
  for (const fieldName of fields) {
    if (!Object.hasOwn(inputs, fieldName)) continue;
    const value = inputs[fieldName];
    if (Array.isArray(value)) continue;
    const spec = definition.input.required[fieldName] ?? definition.input.optional[fieldName];
    const options = record(spec?.[1]) ? spec[1] : {};
    if (!["INT", "FLOAT", "NUMBER", "DOUBLE"].includes(spec?.[0])) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || spec[0] === "INT" && !Number.isInteger(value)
      || typeof options.min === "number" && value < options.min
      || typeof options.max === "number" && value > options.max)
      warnings.push({ code: "INVALID_INPUT_VALUE", nodeId, fieldName });
  }
  return warnings;
}

export function applyDynamicWorkflowSchema(workflow: Data, objectInfo: Data | undefined, analysis: Data, bindingCandidates: Data[]) {
  if (!objectInfo) return { analysis, bindingCandidates };
  let result = analysis, candidates = bindingCandidates;
  for (const [nodeId, node] of Object.entries(workflow)) {
    const definition = objectInfo[node.class_type];
    if (!record(definition) || !record(node.inputs)) continue;
    const expanded = expandedDefinition(definition, node.inputs);
    if (!expanded) continue;
    const schema = { ...objectInfo, [node.class_type]: expanded.definition };
    const nodeAnalysis = analyzeWorkflow(workflow, "comfy-api", { objectInfo: schema });
    const warnings = nodeAnalysis.warnings.filter((warning: Data) => warning.nodeId === nodeId);
    for (const warning of rangeWarnings(nodeId, node.inputs, expanded.definition, expanded.fields))
      if (!warnings.some((item: Data) => item.code === warning.code && item.fieldName === warning.fieldName)) warnings.push(warning);
    result = { ...result,
      warnings: [...result.warnings.filter((warning: Data) => warning.nodeId !== nodeId), ...warnings],
      candidateBindings: [...result.candidateBindings.filter((candidate: Data) => candidate.nodeId !== nodeId),
        ...nodeAnalysis.candidateBindings.filter((candidate: Data) => candidate.nodeId === nodeId)] };
    const nodeCandidates = deriveBindingCandidates({ executionPlan: workflow, nodeDefinitions: schema })
      .filter((candidate: Data) => candidate.nodeId === nodeId);
    candidates = [...candidates.filter(candidate => candidate.nodeId !== nodeId), ...nodeCandidates];
  }
  return { analysis: result, bindingCandidates: candidates };
}
