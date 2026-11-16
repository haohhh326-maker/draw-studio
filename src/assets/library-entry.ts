import { useStore } from "../stores/store";
import type { Asset } from "../types";
import { libraryAssetRenamedName } from "./library-details";

type LibraryEntrySnapshot = Pick<Asset, "name" | "libraryCategory" | "inLibrary">;

export function normalizeLibraryCategory(category: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(category)) throw new Error("分类不能包含换行或控制字符。");
  const value = category.trim().replace(/\s+/gu, " ");
  if (value.length > 50) throw new Error("分类不能超过 50 个字符。");
  return value;
}

function libraryEntryTarget(projectId: string, assetId: string) {
  const state = useStore.getState();
  if (!state.projectOpen || state.navigating || state.project.id !== projectId) throw new Error("项目已切换，未修改资产库。");
  const asset = state.project.assets[assetId];
  if (!asset) throw new Error("素材已不存在，未修改资产库。");
  return { state, asset };
}

/** Commit the dialog as one change; opening or dismissing it never changes membership. */
export function saveLibraryAsset(projectId: string, assetId: string, draftName: string, category: string, expected?: LibraryEntrySnapshot): void {
  const { state, asset } = libraryEntryTarget(projectId, assetId);
  if (expected && (asset.name !== expected.name || asset.libraryCategory !== expected.libraryCategory || asset.inLibrary !== expected.inLibrary))
    throw new Error("素材信息已更新，请重新打开后保存。");
  const name = libraryAssetRenamedName(asset, draftName);
  const libraryCategory = normalizeLibraryCategory(category);
  const categoryUnchanged = libraryCategory ? asset.libraryCategory === libraryCategory : !Object.prototype.hasOwnProperty.call(asset, "libraryCategory");
  if (asset.inLibrary === true && asset.name === name && categoryUnchanged) return;
  const updated: Asset = { ...asset, name, inLibrary: true };
  if (libraryCategory) updated.libraryCategory = libraryCategory;
  else delete updated.libraryCategory;
  state.editProject(project => ({ ...project, assets: { ...project.assets, [assetId]: updated } }));
}

/** Remove only library membership. Canvas references, results and the blob remain usable. */
export function removeLibraryAsset(projectId: string, assetId: string): void {
  const { state, asset } = libraryEntryTarget(projectId, assetId);
  if (asset.inLibrary === false) return;
  state.editProject(project => ({ ...project, assets: { ...project.assets, [assetId]: { ...asset, inLibrary: false } } }));
}
