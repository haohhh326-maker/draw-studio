import type { Canvas, CanvasNode, Project, RetiredToolArchive, RetiredTools } from "../types";

const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
type RetirementSnapshot = RetiredToolArchive["snapshots"][number];

function archive(tools: RetiredTools | undefined, snapshot: RetirementSnapshot): RetiredTools {
  const previous = tools?.director;
  const snapshots = previous?.snapshots ?? [];
  // An old undo snapshot or a repeated import must not multiply the recovery record.
  const serialized = JSON.stringify(snapshot);
  const duplicate = snapshots.some(item => JSON.stringify(item) === serialized);
  return { ...tools, director: { ...previous, version: 1, executable: false,
    snapshots: duplicate ? snapshots : [...snapshots, structuredClone(snapshot)],
  } };
}

/** Remove the retired UI from live state while preserving its original receipts and media references. */
export function retireDirectorCanvas(canvas: Canvas): Canvas {
  const legacy = canvas as Canvas & { director?: unknown };
  const canvasFields: Record<string, unknown> = {};
  if ((canvas.kind as string | undefined) === "director") canvasFields.kind = canvas.kind;
  if (owns(canvas, "director")) canvasFields.director = legacy.director;

  const removed: CanvasNode[] = [];
  const nodeFields: NonNullable<RetirementSnapshot["nodeFields"]> = [];
  let nodes: CanvasNode[] | undefined;
  // Ordinary canvas edits pass through here on every drag. Allocate a changed
  // node list only when a retired node or field actually needs to be removed.
  for (let index = 0; index < canvas.nodes.length; index++) {
    const node = canvas.nodes[index], data = node.data;
    if ((data.kind as string) === "director" || (node.type as string | undefined) === "director") {
      removed.push(node);
      nodes ??= canvas.nodes.slice(0, index);
      continue;
    }
    if (owns(data, "director")) {
      const { director, ...ordinaryData } = data;
      nodeFields.push({ nodeId: node.id, fields: { director } });
      nodes ??= canvas.nodes.slice(0, index);
      nodes.push({ ...node, data: ordinaryData });
    } else nodes?.push(node);
  }
  const removedIds = new Set(removed.map(node => node.id));
  // Also reject edges arriving alone from a stale history entry after their nodes were retired.
  for (const snapshot of canvas.retiredTools?.director?.snapshots ?? [])
    for (const node of snapshot.nodes ?? [])
      if (typeof node.id === "string") removedIds.add(node.id);
  const edges = removedIds.size ? canvas.edges.filter(edge => removedIds.has(edge.source) || removedIds.has(edge.target)) : [];
  if (!Object.keys(canvasFields).length && !removed.length && !edges.length && !nodeFields.length) return canvas;

  const { director: _, ...rest } = legacy;
  if (canvasFields.kind === "director") delete rest.kind;
  const snapshot: RetirementSnapshot = {
    ...(Object.keys(canvasFields).length ? { canvasFields } : {}),
    ...(removed.length ? { nodes: removed as unknown as Record<string, unknown>[] } : {}),
    ...(edges.length ? { edges } : {}),
    ...(nodeFields.length ? { nodeFields } : {}),
  };
  return { ...rest, nodes: nodes ?? canvas.nodes,
    edges: edges.length ? canvas.edges.filter(edge => !removedIds.has(edge.source) && !removedIds.has(edge.target)) : canvas.edges,
    retiredTools: archive(canvas.retiredTools, snapshot),
  };
}

/** Shared by load, import, direct edits and undo/redo; never reconstructs a retired node. */
export function retireDirectorProject(project: Project): Project {
  const legacy = project as Project & { director?: unknown };
  let canvases: Canvas[] | undefined;
  for (let index = 0; index < project.canvases.length; index++) {
    const canvas = project.canvases[index], retired = retireDirectorCanvas(canvas);
    if (retired !== canvas) canvases ??= project.canvases.slice(0, index);
    canvases?.push(retired);
  }
  const hasProjectFields = owns(project, "director");
  if (!hasProjectFields && !canvases) return project;
  const { director, ...rest } = legacy;
  return { ...rest, canvases: canvases ?? project.canvases,
    ...(hasProjectFields ? { retiredTools: archive(project.retiredTools, { projectFields: { director } }) } : {}),
  };
}
