import type { WorkflowDefinition } from "../types";
import { inferMediaInputPolicy } from "./media-input-policy";

/** Refresh inferred contracts against this server, including imports made before optional inputs were supported. */
export function withServerMediaInputs(
  definition: WorkflowDefinition,
  info: Record<string, unknown>,
): WorkflowDefinition {
  if (definition.mediaInputMode !== "schema" || !definition.template || !definition.inputSlots?.length)
    return definition;
  const slots = new Set(definition.inputSlots.map(slot => slot.semantic));
  const bindings = definition.mapping.filter(mapping => slots.has(mapping.semantic));
  const roots = [definition.output.nodeId, ...(definition.additionalOutputs ?? []).map(output => output.nodeId)];
  const policy = inferMediaInputPolicy(definition.template, bindings, info, roots);
  const optional = new Set(policy.optionalSemantics);
  const inputSlots = definition.inputSlots.map(slot => ({ ...slot, required: !optional.has(slot.semantic) }));
  return {
    ...definition,
    inputSlots,
    mediaInputPolicy: policy,
    requiredInputs: [...definition.requiredInputs.filter(semantic => !slots.has(semantic)), ...inputSlots.filter(slot => slot.required).map(slot => slot.semantic)],
    optionalInputs: [...definition.optionalInputs.filter(semantic => !slots.has(semantic)), ...inputSlots.filter(slot => !slot.required).map(slot => slot.semantic)],
  };
}
