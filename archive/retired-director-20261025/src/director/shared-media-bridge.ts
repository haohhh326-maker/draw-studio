import type { Asset, Project } from "../types";
import { useStore } from "../stores/store";
import { createDirectorMediaBridge, directorAssetPath } from "./media-bridge";

/** Collect media identities only; prompt drafts and connection settings never enter this map. */
export function directorProjectMediaMap(
  project: Pick<Project, "assets" | "canvases">,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const ambiguous = new Set<string>();
  const merge = (director: unknown) => {
    if (!director || typeof director !== "object") return;
    const media = (director as { media?: unknown }).media;
    if (!media || typeof media !== "object" || Array.isArray(media)) return;
    for (const [path, id] of Object.entries(media)) {
      if (
        !path ||
        typeof id !== "string" ||
        !project.assets[id] ||
        ambiguous.has(path)
      )
        continue;
      if (Object.hasOwn(result, path) && result[path] !== id) {
        delete result[path];
        ambiguous.add(path);
      } else result[path] = id;
    }
  };
  for (const canvas of project.canvases) {
    merge(canvas.director);
    for (const node of canvas.nodes) merge(node.data.director);
  }
  // Canonical paths identify an asset independently of which director first uploaded it.
  for (const asset of Object.values(project.assets))
    result[directorAssetPath(asset)] = asset.id;
  return result;
}

type MediaTransport = Pick<
  ReturnType<typeof createDirectorMediaBridge>,
  "fetchApi" | "apiURL" | "prepare"
> & {
  getMediaMap(): Record<string, string>;
};
export type SharedDirectorMediaBridge = MediaTransport & { release(): void };
type SharedEntry = { refs: number; transport: MediaTransport; destroy(): void };
const entries = new Map<string, SharedEntry>();

/** All inline directors in one project share the same local media URLs and pending reads. */
export function acquireDirectorMediaBridge(
  projectId: string,
): SharedDirectorMediaBridge {
  let entry = entries.get(projectId);
  if (!entry) {
    const requireProject = () => {
      const project = useStore.getState().project;
      if (project.id !== projectId || !entry || entry.refs <= 0)
        throw new DOMException("项目已切换或导演台已关闭。", "AbortError");
      return project;
    };
    const getMediaMap = () => directorProjectMediaMap(requireProject());
    const bridge = createDirectorMediaBridge({
      getAssets: () => requireProject().assets,
      addAsset: (asset: Asset) => {
        requireProject();
        useStore.getState().editProject((project) =>
          project.id === projectId
            ? {
                ...project,
                assets: { ...project.assets, [asset.id]: asset },
              }
            : project,
        );
      },
      getMediaMap,
      // Canonical paths are derived from project.assets, never stored on one host.
      setMediaMap() {},
    });
    const transport: MediaTransport = {
      async fetchApi(path, init) {
        requireProject();
        const response = await bridge.fetchApi(path, init);
        requireProject();
        return response;
      },
      apiURL(path) {
        if (
          useStore.getState().project.id !== projectId ||
          !entry ||
          entry.refs <= 0
        )
          return "data:,";
        return bridge.apiURL(path);
      },
      async prepare() {
        requireProject();
        await bridge.prepare();
        requireProject();
      },
      getMediaMap,
    };
    entry = { refs: 0, transport, destroy: () => bridge.destroy() };
    entries.set(projectId, entry);
  }
  entry.refs++;
  const acquired = entry;
  let released = false;
  return {
    ...acquired.transport,
    release() {
      if (released) return;
      released = true;
      if (--acquired.refs > 0) return;
      if (entries.get(projectId) === acquired) entries.delete(projectId);
      acquired.destroy();
    },
  };
}
