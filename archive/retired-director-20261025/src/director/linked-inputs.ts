import type { Asset, Canvas } from "../types";
import { directorAssetPath } from "./media-bridge";
import type { DirectorSnapshot } from "./upstream-host";

/** Canvas connections enter the same public slots used by the original widget. */
export function directorLinkedInputs(canvas: Canvas, nodeId: string, assets: Record<string, Asset>, snapshot: DirectorSnapshot, previousPaths: string[] = []) {
  const timeline = structuredClone(snapshot.timeline), old = new Set(previousPaths);
  const global = timeline.global ??= {};
  const sources = canvas.edges.filter(edge => edge.target === nodeId).sort((a, b) => (a.data?.order ?? 0) - (b.data?.order ?? 0))
    .map(edge => canvas.nodes.find(node => node.id === edge.source)?.data.assetId).filter((id): id is string => !!id)
    .map(id => assets[id]).filter(asset => asset && ["image", "video", "audio"].includes(asset.kind));
  const linkedPaths: string[] = [], media: Record<string, string> = {};
  for (const [kind, field, fileKey, limit] of [["image", "refs", "imageFile", 9], ["video", "refVideos", "videoFile", 3], ["audio", "refAudios", "audioFile", 3]] as const) {
    const refs: Record<string, any>[] = (global[field] ?? []).filter((ref: Record<string, any>) => !old.has(String(ref[fileKey] ?? "")));
    const capacityMessage = `导演台公共${kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"}最多支持 ${limit} 项，请减少连线或腾出素材槽。`;
    if (refs.length > limit) throw new Error(capacityMessage);
    for (const asset of sources.filter(asset => asset.kind === kind)) {
      const path = directorAssetPath(asset);
      media[path] = asset.id;
      if (refs.some(ref => ref[fileKey] === path)) continue;
      let index = 0;
      while (refs.some(ref => Number(ref.index ?? ref.slot) === index)) index++;
      if (refs.length >= limit || index >= limit) throw new Error(capacityMessage);
      refs.push({ index, [fileKey]: path, fileName: asset.name, subfolder: "", type: "input" });
      linkedPaths.push(path);
    }
    global[field] = refs;
  }
  if (sources.length) { global.commonEnabled = true; global.commonCollapsed = true; }
  const mode = String(snapshot.values.task_type ?? "r2v").split(/[\s—]/)[0];
  const workspace = timeline.batchWorkspaces?.[mode];
  if (workspace) workspace.globalCommon = { ...workspace.globalCommon, refs: structuredClone(global.refs), refVideos: structuredClone(global.refVideos), refAudios: structuredClone(global.refAudios), commonEnabled: global.commonEnabled, commonCollapsed: global.commonCollapsed, prompt: global.prompt ?? "" };
  return { timeline, linkedPaths, media };
}
