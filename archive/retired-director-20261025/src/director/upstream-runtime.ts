/** ComfyUI host boundaries for the unmodified MiniMax Director UI. */
export type DirectorTransport = {
  fetchApi(path: string, init?: RequestInit): Promise<Response>;
  apiURL(path: string): string;
};

export type DirectorExtension = {
  name: string;
  beforeRegisterNodeDef?: (nodeType: any, definition: any) => Promise<void> | void;
  loadedGraphNode?: (node: any) => Promise<void> | void;
};

const extensions = new Map<string, DirectorExtension>();
const events = new EventTarget();
const hosts = new Map<object, { transport: DirectorTransport; graph: any }>();
const currentTransport = () => hosts.values().next().value?.transport;
const graphs = () => [...hosts.values()].map(host => host.graph);
const sharedGraph = {
  get _nodes(): any[] { return graphs().flatMap(graph => graph?._nodes ?? graph?.nodes ?? []); },
  get nodes(): any[] { return this._nodes; },
  get links() { return Object.assign({}, ...graphs().map(graph => graph?.links ?? {})); },
  getNodeById(id: string | number) { return this._nodes.find(node => String(node.id) === String(id)) ?? null; },
  setDirtyCanvas(...args: unknown[]) { for (const graph of graphs()) graph?.setDirtyCanvas?.(...args); },
  change(...args: unknown[]) { for (const graph of graphs()) graph?.change?.(...args); },
};

export const upstreamApp: any = {
  graph: null,
  canvas: { graph: null },
  registerExtension(extension: DirectorExtension) { extensions.set(extension.name, extension); },
};

export const upstreamApi = {
  fetchApi(path: string, init?: RequestInit) {
    const transport = currentTransport();
    if (!transport) return Promise.reject(new Error("导演台已经关闭。"));
    return transport.fetchApi(path, init);
  },
  apiURL(path: string) { return currentTransport()?.apiURL(path) ?? ""; },
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
};

export function directorExtension() {
  const extension = extensions.get("ComfyUI.MiniMaxH3DirectorPlugin");
  if (!extension) throw new Error("导演台原版界面没有完成加载。");
  return extension;
}

export function attachDirectorTransport(key: object, value: DirectorTransport, graph: any) {
  // The original UI's API module is shared. Concurrent editors must therefore
  // use one project media bridge, never an arbitrary last-mounted node bridge.
  const other = [...hosts.entries()].find(([otherKey]) => otherKey !== key)?.[1].transport;
  if (other && (other.fetchApi !== value.fetchApi || other.apiURL !== value.apiURL))
    throw new Error("同一画布的导演台必须共享项目素材连接。");
  hosts.set(key, { transport: value, graph });
  upstreamApp.graph = sharedGraph;
  upstreamApp.canvas.graph = sharedGraph;
}

export function detachDirectorTransport(key: object) {
  hosts.delete(key);
  if (!hosts.size) {
    upstreamApp.graph = null;
    upstreamApp.canvas.graph = null;
  }
}
