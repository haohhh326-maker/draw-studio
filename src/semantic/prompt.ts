import type { Canvas, TextInput, WorkflowDefinition } from "../types";
import { resolvePromptMentions } from "./mentions";

export function workflowUsesMainPrompt(workflow?: WorkflowDefinition): boolean {
  return workflow?.importReader?.environment !== "comfyui" || workflow.mapping.some(mapping => mapping.semantic === "prompt");
}

export function resolvePrompt(
  canvas: Canvas,
  nodeId: string,
  localPrompt: string,
  workflow?: WorkflowDefinition,
) {
  const usesMainPrompt = workflowUsesMainPrompt(workflow);
  const local = resolvePromptMentions(usesMainPrompt ? localPrompt : "", canvas, nodeId);
  const texts: TextInput[] = canvas.edges
    .filter((edge) => edge.target === nodeId)
    .sort((a, b) => (a.data?.order ?? 0) - (b.data?.order ?? 0))
    .flatMap((edge) => {
      const source = canvas.nodes.find((node) => node.id === edge.source);
      if (!source || (source.data.kind !== "text" && !(source.data.kind === "tool" && source.data.text !== undefined))) return [];
      return [
        {
          nodeId: source.id,
          edgeId: edge.id,
          order: edge.data?.order ?? 0,
          title: source.data.title,
          text: source.data.text ?? "",
        },
      ];
    });
  const slots = workflow?.parameters.filter(p => p.inputText) ?? [];
  const slotParams = Object.fromEntries(slots.flatMap((slot, index) => texts[index] ? [[slot.key, texts[index].text]] : []));
  return {
    texts,
    slotParams,
    extraSlotTexts: slots.length > 0 && texts.length > slots.length,
    missingMentions: local.missingMentions,
    prompt: usesMainPrompt ? [...(slots.length ? [] : texts.map((input) => input.text.trim())), local.text.trim()]
      .filter(Boolean).join("\n\n") : "",
  };
}
