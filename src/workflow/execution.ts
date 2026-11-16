import type { WorkflowDefinition, Generation, ApiWorkflow } from "../types";
import { withLoraParameters } from "./lora-parameters";
import { selectPreferredOutputDescriptor } from "./output-policy";

/** Select a result branch without executing unrelated output nodes or batch branches. */
export function selectWorkflowOutput(
  definition: WorkflowDefinition,
  params: Generation["params"],
): WorkflowDefinition {
  // RunningHub owns its complete deployed graph. A selected contract must not
  // acquire extra LoRA bindings or local output-branch transformations.
  if (definition.muse || definition.importReader || definition.runninghub?.bindingMode === "selected") return definition;
  if (!definition.source || !definition.template) return withLoraParameters(definition);
  const explicit = definition.outputChoices?.find((o) => o.nodeId === params.__output);
  const selected = explicit ??
    selectPreferredOutputDescriptor(definition, definition.outputChoices?.length
      ? definition.outputChoices : [definition.output, ...(definition.additionalOutputs ?? [])]);
  const outputs = !explicit
    ? [selected, definition.output, ...(definition.additionalOutputs ?? [])].filter((output, index, all) =>
        all.findIndex(other => other.nodeId === output.nodeId && other.field === output.field) === index)
    : [selected];
  const graph = definition.template;
  const keep = new Set<string>();
  const issues = [...definition.source.issues];
  issues.push(
    ...(definition.outputChoices?.find((o) => o.nodeId === selected.nodeId)
      ?.issues ?? []),
  );
  const visiting = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) {
      issues.push("工作流存在循环连接：" + id);
      return;
    }
    if (keep.has(id)) return;
    const n = graph[id];
    if (!n) {
      issues.push("找不到连接节点：" + id);
      return;
    }
    keep.add(id);
    visiting.add(id);
    issues.push(...(definition.source?.nodeIssues?.[id] ?? []));
    for (const v of Object.values(n.inputs))
      if (
        Array.isArray(v) &&
        v.length === 2 &&
        typeof v[0] === "string" &&
        typeof v[1] === "number"
      )
        visit(v[0]);
    visiting.delete(id);
  }
  // Additional publishing outputs share the selected run. Explicit branch
  // choices remain exclusive, while default runs retain all declared results.
  for (const output of outputs) visit(output.nodeId);
  const indices = new Map<string, number>();
  const mapping = definition.mapping
    .filter((m) => keep.has(m.nodeId))
    .map((m) => {
      if (m.index === undefined) return m;
      const index = indices.get(m.semantic) ?? 0;
      indices.set(m.semantic, index + 1);
      return { ...m, index };
    });
  const mapped = new Set(mapping.map((m) => m.semantic));
  const template: ApiWorkflow = Object.fromEntries(
    Object.entries(graph).filter(([id]) => keep.has(id)),
  );
  const missingNodes = definition.source.missingNodes.filter((t) =>
    Object.values(template).some((n) => n.class_type === t),
  );
  const serialized = JSON.stringify(template).replaceAll("\\\\", "/");
  const missingModels = definition.source.missingModels.filter((name) =>
    serialized.includes(name),
  );
  return withLoraParameters({
    ...definition,
    template,
    output: selected,
    additionalOutputs: outputs.filter(output => output.nodeId !== selected.nodeId || output.field !== selected.field),
    mapping,
    parameters: definition.parameters.filter((p) => mapped.has(p.key)),
    requiredInputs: definition.requiredInputs.filter((s) => mapped.has(s)),
    optionalInputs: definition.optionalInputs.filter((s) => mapped.has(s)),
    source: {
      ...definition.source,
      issues: [...new Set(issues)],
      missingNodes,
      missingModels,
    },
  });
}

