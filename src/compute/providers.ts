import type { CanvasNode, ComputeProvider, Connection, Generation, Project, RunningHubSite, WorkflowDefinition } from "../types";
import { museConnection, museWorkflows } from "../muse/catalog";

export const defaultRunningHubConnection: Connection = {
  name: "RunningHub", baseUrl: "https://www.runninghub.cn", token: "",
  authHeader: "Authorization", authPrefix: "Bearer ", timeoutMinutes: 60,
};
export const defaultRunningHubConnections: Record<RunningHubSite, Connection> = {
  cn: { ...defaultRunningHubConnection },
  ai: { ...defaultRunningHubConnection, baseUrl: "https://www.runninghub.ai" },
};
export function runningHubSite(baseUrl: string): RunningHubSite {
  const url = new URL(baseUrl);
  const host = url.hostname.replace(/^www\./, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port || !["/", ""].includes(url.pathname) || url.search || url.hash || !["runninghub.cn", "runninghub.ai"].includes(host))
    throw new Error("请选择 RunningHub 中国站或国际站。");
  return host === "runninghub.ai" ? "ai" : "cn";
}
export const computeEndpoint = (url: string) => url.trim().replace(/\/+$/, "");
export const isRunningHubProvider = (provider: ComputeProvider) => provider === "runninghub" || provider === "runninghub-workflow";
type ComputeState = {
  computeProvider: ComputeProvider;
  connection: Connection;
  runningHubConnection: Connection;
  workflows: WorkflowDefinition[];
  runningHubWorkflows: WorkflowDefinition[];
  runningHubConnections?: Record<RunningHubSite, Connection>;
};
const catalogs = new WeakMap<WorkflowDefinition[], Map<string, WorkflowDefinition[]>>();
/** Both catalog views need stable references for Zustand selectors. */
function providerWorkflows(state: ComputeState, selectionOnly: boolean): WorkflowDefinition[] {
  if (state.computeProvider === "muse") return museWorkflows;
  if (!isRunningHubProvider(state.computeProvider)) return state.workflows;
  const site = computeEndpoint(state.runningHubConnection.baseUrl);
  let sites = catalogs.get(state.runningHubWorkflows);
  if (!sites) { sites = new Map(); catalogs.set(state.runningHubWorkflows, sites); }
  const kind = state.computeProvider === "runninghub" ? "app" : "workflow";
  const key = (selectionOnly ? kind + ":" : "execution:") + site;
  let entries = sites.get(key);
  if (!entries) {
    entries = state.runningHubWorkflows.filter(w => w.runninghub && (!selectionOnly || (w.runninghub.kind ?? "workflow") === kind) && computeEndpoint(w.runninghub.baseUrl) === site);
    sites.set(key, entries);
  }
  return entries;
}
/** AI apps and remote workflow links have separate selection catalogs. */
export const activeWorkflows = (state: ComputeState): WorkflowDefinition[] => providerWorkflows(state, true);
/** Existing nodes retain their original API executor and site, including legacy workflows. */
export const executionWorkflows = (state: ComputeState): WorkflowDefinition[] => providerWorkflows(state, false);
export const activeConnection = (state: ComputeState): Connection =>
  state.computeProvider === "muse" ? museConnection : isRunningHubProvider(state.computeProvider) ? state.runningHubConnection : state.connection;
export const allWorkflows = (state: Pick<ComputeState, "workflows" | "runningHubWorkflows">) =>
  [...state.workflows, ...state.runningHubWorkflows, ...museWorkflows];

/** Existing cards own their provider; the toolbar value is only a default for new cards. */
export function generationComputeProvider(generation: Generation | undefined, workflows: WorkflowDefinition[], fallback: ComputeProvider): ComputeProvider {
  if (!generation) return fallback;
  if (generation.computeProvider) return generation.computeProvider;
  const definition = workflows.find(workflow => workflow.id === generation.workflowId);
  if (definition?.muse || generation.workflowId.startsWith("muse-")) return "muse";
  if (definition?.runninghub) return definition.runninghub.kind === "app" ? "runninghub" : "runninghub-workflow";
  if (generation.workflowId.startsWith("runninghub-")) return "runninghub";
  return definition || generation.workflowId ? "comfyui" : fallback;
}

/** Resolve the target card, never the currently focused card or global toolbar selection. */
export function nodeComputeState<T extends ComputeState & { project: Project }>(state: T, canvasId: string, nodeId: string): T {
  const generation = state.project.canvases.find(canvas => canvas.id === canvasId)?.nodes.find(node => node.id === nodeId)?.data.generation;
  const computeProvider = generationComputeProvider(generation, allWorkflows(state), state.computeProvider);
  let connection = state.runningHubConnection;
  if (isRunningHubProvider(computeProvider) && generation) {
    const definition = state.runningHubWorkflows.find(workflow => workflow.id === generation.workflowId);
    if (definition?.runninghub && computeEndpoint(definition.runninghub.baseUrl) !== computeEndpoint(connection.baseUrl)) {
      const site = runningHubSite(definition.runninghub.baseUrl);
      connection = state.runningHubConnections?.[site] ?? defaultRunningHubConnections[site];
    }
  }
  return computeProvider === state.computeProvider && connection === state.runningHubConnection ? state
    : { ...state, computeProvider, runningHubConnection: connection };
}

/** Pin old cards to their saved workflow on load, without rebinding any workflow or parameter. */
export function restoreNodeComputeProviders(project: Project, workflows: WorkflowDefinition[], fallback: ComputeProvider): Project {
  let changed = false;
  const canvases = project.canvases.map(canvas => {
    let canvasChanged = false;
    const nodes = canvas.nodes.map(node => {
      const generation = node.data.generation;
      if (!generation || generation.computeProvider) return node;
      changed = canvasChanged = true;
      return { ...node, data: { ...node.data, generation: { ...generation,
        computeProvider: generationComputeProvider(generation, workflows, fallback),
      } } };
    });
    return canvasChanged ? { ...canvas, nodes } : canvas;
  });
  return changed ? { ...project, canvases } : project;
}

/** Switch one card while remembering its provider-specific workflow and parameters. */
export function nodeForComputeProvider(node: CanvasNode, provider: ComputeProvider, workflows: WorkflowDefinition[], fallback: ComputeProvider): CanvasNode {
  const generation = node.data.generation;
  if (!generation) return node;
  const previous = generationComputeProvider(generation, workflows, fallback);
  if (previous === provider) return generation.computeProvider === provider ? node
    : { ...node, data: { ...node.data, generation: { ...generation, computeProvider: provider } } };
  const providerSelections = { ...generation.providerSelections, [previous]: {
    workflowId: generation.workflowId, params: { ...generation.params },
  } };
  const selection = providerSelections[provider];
  const selected = workflows.find(workflow => workflow.id === selection?.workflowId);
  const valid = selected && (provider === "muse" ? !!selected.muse
    : provider === "runninghub-workflow" ? !!selected.runninghub && selected.runninghub.kind !== "app"
    : provider === "runninghub" ? selected.runninghub?.kind === "app" : !selected.runninghub && !selected.muse);
  const museDefault = provider === "muse" ? museWorkflows.find(workflow => workflow.output.kind ===
    (node.data.kind === "video" ? "video" : node.data.kind === "image-generation" ? "image" : node.data.kind === "audio" ? "audio" : "")) : undefined;
  return { ...node, data: { ...node.data, generationFeedback: undefined, generation: {
    ...generation, computeProvider: provider, providerSelections,
    workflowId: valid ? selection!.workflowId : museDefault?.id ?? "",
    params: valid ? { ...selection!.params } : museDefault ? { aspectRatio: "auto" } : {},
  } } };
}

export function projectForNodeComputeProvider(project: Project, canvasId: string, nodeId: string, provider: ComputeProvider, workflows: WorkflowDefinition[], fallback: ComputeProvider): Project {
  const canvas = project.canvases.find(canvas => canvas.id === canvasId);
  const node = canvas?.nodes.find(node => node.id === nodeId);
  if (!canvas || !node) return project;
  const updated = nodeForComputeProvider(node, provider, workflows, fallback);
  if (updated === node) return project;
  return { ...project, canvases: project.canvases.map(item => item === canvas
    ? { ...canvas, nodes: canvas.nodes.map(item => item === node ? updated : item) } : item) };
}
