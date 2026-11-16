/** A DOM-independent representation of the prompt editor and selection fragments. */
export type PromptDocumentNode =
  | { type: "text"; text: string }
  | { type: "mention"; token: string }
  | { type: "break" }
  | { type: "element"; block: boolean; children: PromptDocumentNode[] };

/**
 * Preserve editable text and atomic mention tokens while removing the browser's
 * final caret placeholder. Selection fragments can opt out of that final trim.
 */
export function serializePromptDocument(
  node: PromptDocumentNode,
  trimPlaceholder = true,
): string {
  if (node.type === "text") return node.text.replace(/\u00a0/g, " ");
  if (node.type === "mention") return node.token;
  if (node.type === "break") return "\n";

  let value = "";
  let previousBlock = false;
  let hasContent = false;
  for (const child of node.children) {
    const block = child.type === "element" && child.block;
    // Empty blocks still occupy a line between their neighboring blocks.
    if (hasContent && (previousBlock || (block && !value.endsWith("\n")))) {
      value += "\n";
    }
    // Block wrappers have their own caret placeholder; inline wrappers do not.
    value += serializePromptDocument(child, block);
    previousBlock = block;
    hasContent = true;
  }

  const last = node.children.at(-1);
  if (
    trimPlaceholder &&
    (last?.type === "break" ||
      (last?.type === "text" && last.text.endsWith("\n")))
  ) {
    value = value.slice(0, -1);
  }
  return value;
}
