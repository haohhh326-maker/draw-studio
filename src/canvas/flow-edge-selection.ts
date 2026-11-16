type SelectableNode = { id: string; selected?: boolean };

/** A stable key keeps edge selection context unchanged while nodes are dragged. */
export function flowNodeSelectionKey(nodes: readonly SelectableNode[], selectedId: string | null) {
  return JSON.stringify([...new Set(nodes.filter(node => node.selected || node.id === selectedId).map(node => node.id))].sort());
}

export function isEdgeConnectedToSelection(edge: { source: string; target: string }, selectedNodes: ReadonlySet<string>) {
  return selectedNodes.has(edge.source) || selectedNodes.has(edge.target);
}
