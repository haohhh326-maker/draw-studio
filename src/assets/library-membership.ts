import type { Asset, Project } from "../types";

const generatedCache = new WeakMap<Project["history"], WeakMap<Project["tasks"], ReadonlySet<string>>>();

/** Legacy projects did not store membership separately from generated results. */
export function generatedAssetIds(project: Pick<Project, "history" | "tasks">): ReadonlySet<string> {
  let histories = generatedCache.get(project.history);
  if (!histories) { histories = new WeakMap(); generatedCache.set(project.history, histories); }
  const cached = histories.get(project.tasks);
  if (cached) return cached;
  const generated = new Set([
    ...project.history.flatMap(entry => entry.outputs),
    ...Object.values(project.tasks).flatMap(task => [
      ...task.outputs,
      ...(task.downloadedOutputs?.map(output => output.asset.id) ?? []),
      ...(task.outputTextAsset ? [task.outputTextAsset.id] : []),
    ]),
  ]);
  histories.set(project.tasks, generated);
  return generated;
}

export function isAssetInLibrary(asset: Asset, project: Pick<Project, "history" | "tasks">, generated?: ReadonlySet<string>): boolean {
  return asset.inLibrary ?? !(generated ?? generatedAssetIds(project)).has(asset.id);
}

export function libraryAssets(project: Pick<Project, "assets" | "history" | "tasks">): Asset[] {
  const generated = generatedAssetIds(project);
  return Object.values(project.assets).filter(asset => isAssetInLibrary(asset, project, generated));
}
