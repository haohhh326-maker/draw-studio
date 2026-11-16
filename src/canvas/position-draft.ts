import type { NodeChange, XYPosition } from "@xyflow/react";
import type { CanvasNode } from "../types";

const flushers = new Set<(finish: boolean) => void>();

/** All save entrances, including desktop shutdown, must capture visible positions. */
export function flushCanvasPositionDrafts(finish = false) {
  for (const flush of flushers) flush(finish);
}

export function registerCanvasPositionFlush(flush: (finish: boolean) => void) {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

/** Drag coordinates are transient. Never keep whole node snapshots here: a
 * generation may finish, or a node may be removed/reparented during the gesture. */
export class CanvasPositionDraft {
  private readonly positions = new Map<string, { position: XYPosition; parentId?: string; dragging?: boolean }>();
  constructor(readonly projectId: string, readonly canvasId: string) {}

  record(changes: NodeChange<CanvasNode>[], nodes: CanvasNode[]) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    for (const change of changes) {
      if (change.type !== "position") continue;
      const node = byId.get(change.id);
      if (!node) continue;
      const previous = this.positions.get(change.id);
      this.positions.set(change.id, {
        position: change.position ?? previous?.position ?? node.position,
        parentId: node.parentId,
        dragging: change.dragging ?? previous?.dragging,
      });
    }
  }

  merge(nodes: CanvasNode[], finished = false): CanvasNode[] {
    let changed = false;
    const merged = nodes.map(node => {
      const draft = this.positions.get(node.id);
      if (!draft || draft.parentId !== node.parentId) return node;
      const dragging = finished ? false : draft.dragging;
      if (node.position.x === draft.position.x && node.position.y === draft.position.y &&
        (dragging === undefined || !!node.dragging === dragging)) return node;
      changed = true;
      return { ...node, position: draft.position, ...(dragging === undefined ? {} : { dragging }) };
    });
    return changed ? merged : nodes;
  }
}
