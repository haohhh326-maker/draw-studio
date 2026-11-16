import type { AifisherWorkflowReadResult } from "./aifisher-reader-client";
import { isWorkflowCredentialFieldName } from "./credentials";

/** Resolve the canvas prompt from named fields and actual downstream roles, never widget positions. */
export function automaticPromptCandidate(read: AifisherWorkflowReadResult) {
  const graph = read.workflow ?? {};
  const promptName = /^(?:prompt|positive_prompt|positive_text|text|text_g|instruction|user_prompt)$/i;
  const candidates = read.bindingCandidates.filter(candidate => typeof candidate.value === "string"
    && !candidate.connected && !candidate.modelKind && !candidate.mediaKind && !candidate.options?.length
    && !isWorkflowCredentialFieldName(candidate.fieldName)
    && !/^(?:negative|negative_prompt|negative_text)$/i.test(candidate.fieldName)
    && (promptName.test(candidate.fieldName) || candidate.fieldName === "value" || candidate.control === "textarea"));
  const consumers = new Map<string, { nodeId: string; field: string }[]>();
  for (const [nodeId, node] of Object.entries(graph)) for (const [field, value] of Object.entries(node.inputs)) {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]) && graph[value[0]]) {
      consumers.set(value[0], [...(consumers.get(value[0]) ?? []), { nodeId, field }]);
    }
  }
  const roles = (nodeId: string) => {
    const found = new Set<string>(), visited = new Set<string>(), queue = [nodeId];
    while (queue.length) {
      const current = queue.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of consumers.get(current) ?? []) {
        if (/^(?:negative|negative_prompt|negative_text)$/i.test(edge.field)) found.add("negative");
        else if (/^(?:positive|positive_prompt|positive_text|prompt|user_prompt)$/i.test(edge.field)) found.add("positive");
        else queue.push(edge.nodeId);
      }
    }
    return found;
  };
  const scored = candidates.map(candidate => ({ candidate, roles: roles(candidate.nodeId) }));
  const positive = scored.filter(item => item.roles.has("positive") && !item.roles.has("negative"));
  if (positive.length === 1) return positive[0].candidate;
  if (positive.length > 1) return undefined;
  const named = scored.filter(item => promptName.test(item.candidate.fieldName) && !item.roles.has("negative"));
  return named.length === 1 ? named[0].candidate : undefined;
}
