import type { WorkflowDefinition } from "../types";
import { detectWorkflowCredentials } from "../workflow/credentials";

/** Ordinary controls that may be selected for canvas bindings. */
export function runningHubSelectableParameters(workflow: WorkflowDefinition) {
  const credentials = new Set(
    detectWorkflowCredentials(workflow).map((field) => field.parameterKey),
  );
  return workflow.parameters.filter(
    (parameter) =>
      !parameter.secret &&
      !parameter.inputText &&
      !credentials.has(parameter.key),
  );
}

export function runningHubCanvasParameterKeys(
  workflow: WorkflowDefinition,
  selected?: string[],
  previous?: WorkflowDefinition,
) {
  const available = new Set(
    runningHubSelectableParameters(workflow).map((parameter) => parameter.key),
  );
  if (selected === undefined) return [...available];
  const bindingTargets = (definition: WorkflowDefinition, key: string) => JSON.stringify(definition.mapping
    .filter(mapping => mapping.semantic === key).map(mapping => JSON.stringify([mapping.nodeId,
      definition.runninghub?.kind === "app" ? null : definition.template?.[mapping.nodeId]?.class_type, mapping.field,
      mapping.index ?? null, mapping.serialization ?? null, mapping.pathMode ?? null])).sort());
  const byTarget = new Map<string, string[]>();
  for (const parameter of runningHubSelectableParameters(workflow)) {
    const target = bindingTargets(workflow, parameter.key);
    byTarget.set(target, [...(byTarget.get(target) ?? []), parameter.key]);
  }
  return [...new Set(selected.flatMap(key => {
    if (available.has(key)) return [key];
    if (!previous) return [];
    const target = bindingTargets(previous, key);
    const matches = target !== "[]" ? byTarget.get(target) : undefined;
    return matches?.length === 1 ? matches : [];
  }))];
}

export function runningHubSourceSummary(
  workflow: WorkflowDefinition,
): { label: string; version?: string } | undefined {
  const source = workflow.runninghub;
  if (!source) return;
  if (!workflow.template) return { label: "尚未读取输入结构" };
  const version = source.executionContract?.sourceHash;
  const media =
    workflow.inputSlots?.length ??
    new Set(
      [...workflow.requiredInputs, ...workflow.optionalInputs].filter(
        (semantic) => semantic !== "prompt" && semantic !== "negativePrompt",
      ),
    ).size;
  const inputs =
    media +
    Number(workflow.mapping.some((mapping) => mapping.semantic === "prompt"));
  const outputs = new Set(
    [workflow.output, ...(workflow.additionalOutputs ?? [])].map((output) =>
      JSON.stringify([output.nodeId, output.field, output.kind]),
    ),
  ).size;
  const parameters = runningHubSelectableParameters(workflow).length;
  return {
    label: `输入 ${inputs} 项 · 输出 ${outputs} 项 · 可调参数 ${parameters} 项`,
    version,
  };
}
