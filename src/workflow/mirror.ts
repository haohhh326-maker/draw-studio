import compressed from "./mirror-data.gz.json" with { type: "json" };
import { gunzipSync, strFromU8 } from "fflate";
import modelFields from "./model-options.json" with { type: "json" };
import type { WorkflowDefinition, Generation, ApiWorkflow } from "../types";

export const mirrorInventory = JSON.parse(
  strFromU8(
    gunzipSync(Uint8Array.from(atob(compressed), (c) => c.charCodeAt(0))),
  ),
) as {
  importedAt: string;
  summary: Record<string, number>;
  workflows: WorkflowDefinition[];
  models: {
    path: string;
    name: string;
    category: string;
    size: number;
    available: boolean;
    symlink: boolean;
    workflows: string[];
  }[];
};
export const mirrorWorkflows = mirrorInventory.workflows.filter(
  (w) => !w.source?.excluded,
);

/** Loader-specific choices, rather than placing every weight into every selector. */
export function withModelParameters(
  original: WorkflowDefinition,
): WorkflowDefinition {
  if (!original.template || original.source) return original;
  const w = structuredClone(original);
  for (const [nodeId, node] of Object.entries(w.template!)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (
        typeof value !== "string" ||
        w.mapping.some((m) => m.nodeId === nodeId && m.field === field)
      )
        continue;
      const options = (modelFields as Record<string, string[]>)[
        node.class_type + "." + field
      ];
      if (!options?.length) continue;
      const key = "model:" + nodeId + ":" + field;
      w.parameters.push({
        key,
        label: field,
        group: "模型与 LoRA · " + node.class_type + " " + nodeId,
        model: true,
        type: "select",
        default: value,
        options: [...new Set([value, ...options])],
        advanced: true,
      });
      w.mapping.push({ semantic: key, nodeId, field });
    }
  }
  return w;
}

/** Select a result branch without executing unrelated output nodes or batch branches. */
export function selectWorkflowOutput(
  definition: WorkflowDefinition,
  params: Generation["params"],
): WorkflowDefinition {
  if (!definition.source || !definition.template) return definition;
  const selected =
    definition.outputChoices?.find((o) => o.nodeId === params.__output) ??
    definition.output;
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
  visit(selected.nodeId);
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
  return {
    ...definition,
    template,
    output: selected,
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
  };
}

export function workflowAvailability(w: WorkflowDefinition) {
  if (w.source?.excluded) return "训练已排除";
  const selected = selectWorkflowOutput(w, {});
  if (!w.template || selected.source?.issues.length) return "待适配";
  if (
    selected.source?.missingNodes.length ||
    selected.source?.missingModels.length
  )
    return "依赖待准备";
  return w.source || w.verification === "not-run"
    ? "已导入 · 未试跑"
    : "已接入";
}
