import type { Asset } from "../types";
import { useStore } from "../stores/store";
import { validMediaDimensions } from "../nodes/media-layout";

const extensions: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/ogg": ".ogg", "audio/flac": ".flac", "audio/aac": ".aac", "audio/mp4": ".m4a",
  "text/plain": ".txt", "text/markdown": ".md", "text/csv": ".csv", "text/vtt": ".vtt",
  "application/json": ".json", "application/pdf": ".pdf", "application/zip": ".zip",
};

/** The editable title excludes its existing extension, which remains immutable. */
export function libraryAssetNameParts(asset: Pick<Asset, "name" | "mime">) {
  const match = /^(.*\S)(\.[a-z\d][a-z\d_-]*)$/i.exec(asset.name);
  return match ? { title: match[1], extension: match[2] }
    : { title: asset.name, extension: extensions[asset.mime.split(";")[0].trim().toLowerCase()] ?? "" };
}

export function libraryAssetRenamedName(asset: Pick<Asset, "name" | "mime">, draft: string): string {
  const { extension } = libraryAssetNameParts(asset);
  let title = draft.trim();
  // Pasting the full filename is harmless; do not duplicate its protected suffix.
  if (extension && title.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase())) title = title.slice(0, -extension.length).trim();
  if (!title) throw new Error("名称不能为空。");
  if (/[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(title) || /[. ]$/u.test(title)) throw new Error("名称不能包含文件路径、特殊符号或以句点结尾。");
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(title)) throw new Error("请使用其他素材名称。");
  const name = title + extension;
  if (name.length > 255) throw new Error("素材名称不能超过 255 个字符。");
  return name;
}

/** Rename metadata only: blob keys, input bindings, nodes and task snapshots stay intact. */
export function renameLibraryAsset(projectId: string, assetId: string, draft: string, expectedName?: string): string {
  const state = useStore.getState();
  if (!state.projectOpen || state.navigating || state.project.id !== projectId) throw new Error("项目已切换，未修改素材名称。");
  const asset = state.project.assets[assetId];
  if (!asset) throw new Error("素材已不存在，未修改名称。");
  if (expectedName !== undefined && asset.name !== expectedName) throw new Error("素材名称已更新，请重新编辑。");
  const name = libraryAssetRenamedName(asset, draft);
  if (name !== asset.name) state.editProject(project => ({ ...project, assets: { ...project.assets, [assetId]: { ...project.assets[assetId], name } } }));
  return name;
}

export function libraryAssetAspectRatio(asset: Pick<Asset, "kind" | "width" | "height">): string | undefined {
  if (!["image", "video"].includes(asset.kind) || !validMediaDimensions(asset.width, asset.height)) return undefined;
  const ratio = asset.width! / asset.height!;
  return Number.isFinite(ratio) && ratio > 0 ? `${asset.width} / ${asset.height}` : undefined;
}

/** A library preview may learn legacy dimensions without resizing existing canvas nodes. */
export function rememberLibraryAssetDimensions(projectId: string, assetId: string, width: number, height: number): void {
  if (!validMediaDimensions(width, height) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return;
  const state = useStore.getState(), asset = state.project.assets[assetId];
  if (!state.projectOpen || state.navigating || state.project.id !== projectId || !asset || !["image", "video"].includes(asset.kind)) return;
  if (asset.width === width && asset.height === height) return;
  state.editProject(project => ({ ...project, assets: { ...project.assets, [assetId]: { ...project.assets[assetId], width, height } } }));
}
