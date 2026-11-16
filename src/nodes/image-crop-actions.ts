import type { Asset } from "../types";
import { busyPhases } from "../types";
import { activeCanvas, taskForNode, useStore } from "../stores/store";
import { getMediaNodeSize, validMediaDimensions } from "./media-layout";
import { isAssetInLibrary } from "../assets/library-membership";

export type ImageCropSource = {
  projectId: string;
  canvasId: string;
  nodeId: string;
  assetId: string;
  asset: Asset;
};

function unfinished(node: Parameters<typeof taskForNode>[1]) {
  const task = taskForNode(useStore.getState().project, node);
  return busyPhases.includes(task.status) || task.status === "interrupted";
}

export function getImageCropSource(nodeId: string): ImageCropSource {
  const state = useStore.getState(), canvas = activeCanvas(state);
  if (state.navigating) throw new Error("正在切换项目，请稍后裁切图片。");
  const node = canvas.nodes.find(node => node.id === nodeId);
  const asset = node?.data.assetId ? state.project.assets[node.data.assetId] : undefined;
  if (!state.projectOpen || !node || asset?.kind !== "image") throw new Error("请先上传或生成图片。");
  if (unfinished(node)) throw new Error("请等待生成任务结束后裁切图片。");
  return { projectId: state.project.id, canvasId: canvas.id, nodeId, assetId: asset.id, asset: structuredClone(asset) };
}

function currentSource(source: ImageCropSource) {
  const state = useStore.getState();
  if (!state.projectOpen || state.navigating || state.project.id !== source.projectId || state.project.activeCanvasId !== source.canvasId)
    throw new Error("项目或画布已切换，未应用裁切。");
  const canvas = activeCanvas(state), node = canvas.nodes.find(node => node.id === source.nodeId);
  if (!node || node.data.assetId !== source.assetId || state.project.assets[source.assetId]?.kind !== "image")
    throw new Error("原图片已更换或移除，未应用裁切。");
  if (unfinished(node)) throw new Error("图片仍有未结束的生成任务，未应用裁切。");
  return { state, node };
}

/** Commit only the edited asset and its frame; input links and generation snapshots remain intact. */
export function applyImageCrop(source: ImageCropSource, croppedAsset: Asset): void {
  const { state, node } = currentSource(source);
  if (croppedAsset.kind !== "image" || !croppedAsset.mime.startsWith("image/") ||
    !/^[a-zA-Z0-9-]+$/.test(croppedAsset.id) || !croppedAsset.name || !Number.isFinite(croppedAsset.size) || croppedAsset.size <= 0 ||
    !validMediaDimensions(croppedAsset.width, croppedAsset.height) || !Number.isInteger(croppedAsset.width) || !Number.isInteger(croppedAsset.height))
    throw new Error("裁切结果无效，请重新裁切。");
  if (Object.hasOwn(state.project.assets, croppedAsset.id)) throw new Error("裁切结果必须保存为新素材，原图片保持不变。");
  const asset = { ...structuredClone(croppedAsset), inLibrary: isAssetInLibrary(state.project.assets[source.assetId], state.project) };
  const size = getMediaNodeSize(asset.width, asset.height);
  state.checkpoint();
  state.editProject(project => ({ ...project,
    assets: { ...project.assets, [asset.id]: asset },
    canvases: project.canvases.map(canvas => canvas.id !== source.canvasId ? canvas : { ...canvas,
      nodes: canvas.nodes.map(current => current.id !== source.nodeId ? current : {
        ...current, ...size, measured: { ...current.measured, ...size }, style: { ...current.style, ...size },
        data: { ...current.data, assetId: asset.id, mediaLayoutAssetId: asset.id,
          mediaEdit: { assetId: asset.id, taskId: node.data.generation?.taskId ?? null } },
      }),
    }),
  }));
}
