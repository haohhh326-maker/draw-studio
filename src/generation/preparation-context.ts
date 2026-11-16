import { activeConnection, nodeComputeState } from "../compute/providers";
import type { useStore } from "../stores/store";

/** A pending submission belongs to this card and its inputs. Moving cards,
 * selecting another provider, or receiving another task's output cannot cancel it. */
export function generationPreparationIdentity(state: ReturnType<typeof useStore.getState>, canvasId: string, nodeId: string): string {
  const scoped = nodeComputeState(state, canvasId, nodeId);
  const canvas = state.project.canvases.find(item => item.id === canvasId);
  const node = canvas?.nodes.find(item => item.id === nodeId);
  const generation = node?.data.generation;
  if (!canvas || !node || !generation) return "missing";
  const connection = activeConnection(scoped);
  return JSON.stringify({
    projectId: state.project.id, projectOpen: state.projectOpen, navigating: state.navigating,
    canvasId, nodeId, kind: node.data.kind, provider: scoped.computeProvider,
    connection: [connection.baseUrl, connection.token, connection.authHeader, connection.authPrefix],
    // taskId and feedback are written by task creation itself, not user input.
    generation: [generation.workflowId, generation.prompt, generation.negativePrompt, generation.params, generation.runningHubInstanceType],
    inputs: canvas.edges.filter(edge => edge.target === nodeId).map(edge => {
      const source = canvas.nodes.find(item => item.id === edge.source);
      const asset = source?.data.assetId ? state.project.assets[source.data.assetId] : undefined;
      return {
        edge: [edge.id, edge.source, edge.data?.role, edge.data?.order],
        source: source && [source.data.kind, source.data.title, source.data.text, source.data.assetId],
        asset: asset && [asset.id, asset.kind, asset.name, asset.mime, asset.size, asset.createdAt, asset.text],
      };
    }),
  });
}
