import { getMediaNodeSize } from "../nodes/media-layout";
import type { CanvasNode } from "../types";

/** Clear only the displayed result when a new task starts; stored assets and history stay intact. */
export function prepareGenerationNode(node: CanvasNode, taskId: string): CanvasNode {
  if (!node.data.generation) return node;
  const size = getMediaNodeSize();
  return {
    ...node,
    ...size,
    measured: { ...size },
    style: { ...node.style, ...size },
    data: {
      ...node.data,
      assetId: undefined,
      mediaEdit: undefined,
      mediaLayoutAssetId: undefined,
      generationFeedback: undefined,
      ...(node.data.kind === "tool" || node.data.kind === "text" ? { text: undefined } : {}),
      generation: { ...node.data.generation, taskId },
    },
  };
}
