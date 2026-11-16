import { useStore } from "../stores/store";

export function createDirectorNode(position?: { x: number; y: number }): string {
  const id = useStore.getState().addNode("director", position);
  useStore.setState({ selectedId: id, selectedEdgeId: null });
  return id;
}
