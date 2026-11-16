import type { Asset, Canvas, CanvasNode, Project } from "../types";
import { getMediaNodeSize } from "../nodes/media-layout";
import { normalizeDirectorOutputKey } from "./output-identity";

type DirectorOutputIdentity = {
  sourceNodeId: string;
  taskId: string;
  fileKey: string;
};
function sameOutput(value: unknown, identity: DirectorOutputIdentity) {
  if (!value || typeof value !== "object") return false;
  const stored = value as DirectorOutputIdentity;
  return (
    stored.sourceNodeId === identity.sourceNodeId &&
    stored.taskId === identity.taskId &&
    normalizeDirectorOutputKey(stored.fileKey) ===
      normalizeDirectorOutputKey(identity.fileKey)
  );
}
function numeric(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
function positionForOutput(
  canvas: Canvas,
  source: CanvasNode,
  size: { width: number; height: number },
) {
  const width = numeric(
    source.measured?.width ?? source.width ?? source.style?.width,
    1160,
  );
  const x = source.position.x + width + 140;
  let y = source.position.y;
  // Move downward past existing boxes in this column, preserving prior user layout.
  for (;;) {
    const obstacles = canvas.nodes.filter((node) => {
      if (node.id === source.id || node.parentId) return false;
      const w = numeric(
        node.measured?.width ?? node.width ?? node.style?.width,
        200,
      );
      const h = numeric(
        node.measured?.height ?? node.height ?? node.style?.height,
        180,
      );
      return (
        x < node.position.x + w + 40 &&
        x + size.width + 40 > node.position.x &&
        y < node.position.y + h + 40 &&
        y + size.height + 40 > node.position.y
      );
    });
    if (!obstacles.length) return { x, y };
    y = Math.max(
      ...obstacles.map(
        (node) =>
          node.position.y +
          numeric(
            node.measured?.height ?? node.height ?? node.style?.height,
            180,
          ) +
          40,
      ),
    );
  }
}

/** Add or repair the result of one accepted task without duplicating nodes on resume. */
export function attachDirectorOutput(
  project: Project,
  options: {
    canvasId: string;
    nodeId?: string;
    taskId: string;
    fileKey: string;
    asset: Asset;
    index: number;
  },
): Project {
  const { canvasId, nodeId, taskId, fileKey, asset, index } = options;
  if (!nodeId) return project;
  const canvas = project.canvases.find((item) => item.id === canvasId);
  const source = canvas?.nodes.find((node) => node.id === nodeId);
  if (!canvas || !source) return project;
  const identity = { sourceNodeId: nodeId, taskId, fileKey };
  const existing = canvas.nodes.find((node) =>
    sameOutput(node.data.directorOutput, identity),
  );
  const size = getMediaNodeSize(asset.width, asset.height);
  const kind =
    asset.kind === "video"
      ? "video"
      : asset.kind === "audio"
        ? "audio"
        : "reference";
  const title =
    asset.kind === "video"
      ? "视频"
      : asset.kind === "audio"
        ? "音频"
        : asset.kind === "image"
          ? "图像"
          : "素材";
  let result: CanvasNode;
  if (existing) {
    result =
      existing.data.assetId === asset.id
        ? existing
        : {
            ...existing,
            data: {
              ...existing.data,
              assetId: asset.id,
              mediaLayoutAssetId: asset.id,
              kind,
              ...(asset.kind === "text" ? { text: asset.text || "" } : {}),
            },
          };
  } else {
    result = {
      id: crypto.randomUUID(),
      type: "media",
      position: positionForOutput(canvas, source, size),
      ...size,
      style: size,
      data: {
        kind,
        title: `${title} ${index + 1}`,
        assetId: asset.id,
        mediaLayoutAssetId: asset.id,
        directorOutput: identity,
        ...(asset.kind === "text" ? { text: asset.text || "" } : {}),
      },
    };
  }
  const edgeExists = canvas.edges.some(
    (edge) => edge.source === nodeId && edge.target === result.id,
  );
  // The director source handle resolves this asset for downstream nodes.
  // Keep the card size and user position independent from media dimensions.
  const updatedSource =
    source.data.assetId === asset.id
      ? source
      : {
          ...source,
          data: { ...source.data, assetId: asset.id },
        };
  if (result === existing && edgeExists && updatedSource === source)
    return project;
  const updated = {
    ...canvas,
    nodes: existing
      ? canvas.nodes.map((node) =>
          node.id === source.id
            ? updatedSource
            : node.id === existing.id
              ? result
              : node,
        )
      : [
          ...canvas.nodes.map((node) =>
            node.id === source.id ? updatedSource : node,
          ),
          result,
        ],
    edges: edgeExists
      ? canvas.edges
      : [
          ...canvas.edges,
          {
            id: crypto.randomUUID(),
            source: nodeId,
            target: result.id,
            data: { role: "auto" as const, order: index },
          },
        ],
  };
  return {
    ...project,
    canvases: project.canvases.map((item) =>
      item.id === canvasId ? updated : item,
    ),
  };
}
