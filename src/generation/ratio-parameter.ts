import type { Mapping, Parameter, WorkflowDefinition } from "../types";
import { commonAspectRatios, parameterRole } from "./parameter-actions";

// ComfyUI's ResolutionSelector indexes its ratio dictionary by these complete
// strings, rather than by the abbreviated ratios shown in the canvas control.
const resolutionSelectorRatios = [
  "1:1 (Square)",
  "2:3 (Portrait Photo)",
  "3:2 (Photo)",
  "3:4 (Portrait Standard)",
  "4:3 (Standard)",
  "9:16 (Portrait Widescreen)",
  "16:9 (Widescreen)",
  "21:9 (Ultrawide)",
];
const officialRatios = new Set(resolutionSelectorRatios);
const unique = (values: string[]) => [...new Set(values)];
const bareRatio = (value: string) => {
  const match = value.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
  return !!match && Number(match[1]) > 0 && Number(match[2]) > 0;
};

function ratioDestinations(parameter: Parameter, workflow: WorkflowDefinition): Mapping[] {
  const mappings = workflow.mapping.filter(mapping => mapping.semantic === parameter.key);
  const binding = workflow.original?.parameterBindings[parameter.key];
  if (!mappings.length && binding && typeof binding === "object" && !Array.isArray(binding)) {
    const original = binding as Record<string, unknown>;
    if (typeof original.nodeId === "string" && typeof original.path === "string" && original.path.startsWith("inputs."))
      mappings.push({ semantic: parameter.key, nodeId: original.nodeId, field: original.path.slice(7) });
  }
  const destinations: Mapping[] = [];
  const visit = (mapping: Mapping, ancestry: Set<string>) => {
    const node = workflow.template?.[mapping.nodeId];
    if (!node || ancestry.has(mapping.nodeId) || mapping.field !== "value" || !/^PrimitiveString(?:Multiline)?$/.test(node.class_type)) {
      destinations.push(mapping);
      return;
    }
    const seen = new Set(ancestry).add(mapping.nodeId);
    let forwarded = false;
    for (const [nodeId, consumer] of Object.entries(workflow.template ?? {})) for (const [field, input] of Object.entries(consumer.inputs)) {
      if (!Array.isArray(input) || input.length !== 2 || input[0] !== mapping.nodeId) continue;
      forwarded = true;
      if (input[1] === 0) visit({ ...mapping, nodeId, field }, seen);
      else destinations.push(mapping); // An unrecognized output cannot establish an enum contract.
    }
    if (!forwarded) destinations.push(mapping);
  };
  mappings.forEach(mapping => visit(mapping, new Set()));
  return destinations;
}

/** Return choices for the control only; saved definitions, values and bindings stay untouched. */
export function ratioParameterChoices(parameter: Parameter, value: string, workflow?: WorkflowDefinition): Parameter {
  const targets = workflow ? ratioDestinations(parameter, workflow) : [];
  const resolutionSelector = targets.length > 0 && targets.every(target =>
    target.field === "aspect_ratio" && workflow?.template?.[target.nodeId]?.class_type === "ResolutionSelector");
  const remoteConsumer = workflow?.runninghub?.billingMode === "consumer" && workflow.runninghub.kind !== "app";
  if (workflow?.runninghub?.parameterSchemaVersion === 2 && parameter.sourceControl && !(remoteConsumer && resolutionSelector)) return parameter;
  const result: Parameter = {
    ...parameter,
    ...(parameter.options ? { options: [...parameter.options] } : {}),
    ...(parameter.optionLabels ? { optionLabels: { ...parameter.optionLabels } } : {}),
    ...(parameter.optionValues ? { optionValues: { ...parameter.optionValues } } : {}),
  };
  if (!resolutionSelector && parameterRole(parameter, workflow) !== "ratio") return result;
  if (parameter.type === "select") {
    // A supplied schema wins, including restricted choices and value aliases.
    if (resolutionSelector) result.optionLabels = Object.fromEntries((result.options ?? []).map(option => {
      const wire = String(parameter.optionValues?.[option] ?? option);
      return [option, remoteConsumer && officialRatios.has(wire) ? wire.split(" ")[0]
        : parameter.optionLabels?.[option] ?? (officialRatios.has(option) ? option.split(" ")[0] : option)];
    }));
    return result;
  }
  if (parameter.type !== "text") return result;
  const currentValues = unique([value, String(parameter.default)]);
  if (resolutionSelector) {
    result.type = "select";
    result.options = unique([...resolutionSelectorRatios, ...currentValues]);
    result.optionLabels = Object.fromEntries(result.options.map(option => [
      option, parameter.optionLabels?.[option] ?? (officialRatios.has(option) ? option.split(" ")[0] : option),
    ]));
  } else {
    // Unknown ratio widgets may accept names such as "original" or decorated
    // values with their own meaning. Only suggest bare ratios for bare inputs.
    result.options = unique([...currentValues, ...(currentValues.every(bareRatio) ? commonAspectRatios : [])]);
  }
  return result;
}
