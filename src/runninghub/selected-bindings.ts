import type { WorkflowDefinition } from "../types";
import { cleanWorkflowCredentials, detectWorkflowCredentials } from "../workflow/credentials";

/** Keep the complete source, but authorize only selected controls and declared inputs. */
export function selectRunningHubBindings(workflow: WorkflowDefinition, keys?: string[]): WorkflowDefinition {
  if (!workflow.runninghub) throw new Error("只能为 RunningHub 工作流选择画布绑定。");
  const result = cleanWorkflowCredentials(workflow);
  const credentials = detectWorkflowCredentials(result);
  const credentialKeys = new Set(credentials.map(field => field.parameterKey).filter((key): key is string => !!key));
  const credentialTargets = new Set(credentials.map(field => JSON.stringify([field.nodeId, field.field])));
  const ordinary = result.parameters.filter(parameter => !parameter.secret && !parameter.inputText && !credentialKeys.has(parameter.key));
  const available = new Set(ordinary.map(parameter => parameter.key));
  // AI applications expose a public input contract, not their internal graph.
  // Every published parameter remains bound until the platform supports an
  // explicit omission contract for that field.
  const requested = result.runninghub!.kind === "app" ? ordinary.map(parameter => parameter.key)
    : keys ?? result.runninghub!.canvasParameterKeys ?? ordinary.map(parameter => parameter.key);
  const selected = [...new Set(requested)].filter(key => available.has(key));
  const retained = new Set(selected);
  for (const parameter of result.parameters)
    if (parameter.secret || parameter.inputText || credentialKeys.has(parameter.key)) retained.add(parameter.key);
  const inputSemantics = new Set(["prompt", "negativePrompt", ...result.requiredInputs, ...result.optionalInputs,
    ...(result.inputSlots ?? []).map(slot => slot.semantic)]);
  result.parameters = result.parameters.filter(parameter => retained.has(parameter.key) || inputSemantics.has(parameter.key));
  result.mapping = result.mapping.filter(mapping => retained.has(mapping.semantic) || inputSemantics.has(mapping.semantic)
    || mapping.semantic.startsWith("slot:") || credentialTargets.has(JSON.stringify([mapping.nodeId, mapping.field])));
  if (result.original) {
    const retainedParameters = new Set(result.parameters.map(parameter => parameter.key));
    result.original.parameterBindings = Object.fromEntries(Object.entries(result.original.parameterBindings)
      .filter(([key]) => retainedParameters.has(key)));
  }
  result.runninghub = { ...result.runninghub!, bindingMode: "selected", includeWorkflowJson: result.runninghub!.includeWorkflowJson ?? false, canvasParameterKeys: selected };
  delete result.runninghub.executionContract;
  return result;
}

/** Old node values cannot restore a control removed from a selected binding set. */
export function selectedRunningHubParameterValues(
  workflow: WorkflowDefinition,
  params: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  if (workflow.runninghub?.bindingMode !== "selected") return { ...params };
  const allowed = new Set(workflow.parameters.map(parameter => parameter.key));
  return Object.fromEntries(Object.entries(params).filter(([key]) => allowed.has(key)));
}
