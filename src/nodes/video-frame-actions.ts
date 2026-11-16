import { importAsset } from "../assets/assets";
import { captureVideoFrame, type VideoFrame } from "../assets/video-frames";
import { getBlob } from "../projects/storage";
import { activeCanvas, createNode, taskForNode, useStore } from "../stores/store";
import { busyPhases, type Canvas, type CanvasNode, type Project, type Role } from "../types";
import { getMediaNodeSize } from "./media-layout";

const inFlight = new Map<string, Promise<string>>();
const frameRole = (frame: VideoFrame): Role => frame === "first" ? "firstFrame" : "lastFrame";
const frameName = (frame: VideoFrame) => frame === "first" ? "首帧" : "尾帧";

function sourceSnapshot(nodeId: string) {
  const state = useStore.getState();
  const canvas = activeCanvas(state);
  const node = canvas.nodes.find(node => node.id === nodeId);
  const asset = node?.data.assetId ? state.project.assets[node.data.assetId] : undefined;
  if (!state.projectOpen || !node || asset?.kind !== "video") throw new Error("请先上传或生成视频。");
  if (busyPhases.includes(taskForNode(state.project, node).status)) throw new Error("请等待视频生成结束后提取帧。");
  return { projectId: state.project.id, canvasId: canvas.id, nodeId, assetId: asset.id, asset };
}

function currentSource(source: ReturnType<typeof sourceSnapshot>) {
  const state = useStore.getState();
  if (!state.projectOpen || state.project.id !== source.projectId || state.project.activeCanvasId !== source.canvasId)
    throw new Error("项目或画布已切换，未添加视频帧。");
  const canvas = activeCanvas(state);
  const node = canvas.nodes.find(node => node.id === source.nodeId);
  if (!node || node.data.assetId !== source.assetId) throw new Error("原视频已更换或移除，未添加视频帧。");
  if (busyPhases.includes(taskForNode(state.project, node).status)) throw new Error("视频正在生成，未修改输入连线。");
  return { state, canvas, node };
}

function existingFrame(project: Project, canvas: Canvas, source: ReturnType<typeof sourceSnapshot>, frame: VideoFrame) {
  return canvas.nodes.find(node => node.data.videoFrameSourceNodeId === source.nodeId &&
    node.data.videoFrameSourceAssetId === source.assetId && node.data.videoFrame === frame &&
    node.data.videoFrameAssetId === node.data.assetId &&
    project.assets[node.data.assetId ?? ""]?.kind === "image");
}

function absolutePosition(node: CanvasNode, nodes: CanvasNode[]) {
  const position = { ...node.position };
  const visited = new Set([node.id]);
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodes.find(node => node.id === parentId);
    if (!parent) break;
    position.x += parent.position.x;
    position.y += parent.position.y;
    parentId = parent.parentId;
  }
  return position;
}

function framePosition(canvas: Canvas, source: CanvasNode, size: { width: number; height: number }, frame: VideoFrame) {
  const origin = absolutePosition(source, canvas.nodes);
  const position = { x: origin.x - size.width - 80, y: origin.y + (frame === "last" ? size.height + 48 : 0) };
  const overlaps = () => canvas.nodes.some(node => {
    if (node.data.kind === "group") return false;
    const point = absolutePosition(node, canvas.nodes);
    const width = Number(node.measured?.width ?? node.width ?? node.style?.width) || 200;
    const height = Number(node.measured?.height ?? node.height ?? node.style?.height) || 180;
    return position.x < point.x + width + 24 && position.x + size.width + 24 > point.x &&
      position.y < point.y + height + 24 && position.y + size.height + 24 > point.y;
  });
  for (let attempt = 0; attempt < 100 && overlaps(); attempt++) position.y += size.height + 48;
  return position;
}

function selectExisting(source: ReturnType<typeof sourceSnapshot>, frame: VideoFrame, node: CanvasNode): string {
  const { state, canvas } = currentSource(source);
  const role = frameRole(frame);
  const connected = canvas.edges.some(edge => edge.source === node.id && edge.target === source.nodeId && edge.data?.role === role);
  state.editCanvas(canvas => ({ ...canvas,
    nodes: canvas.nodes.map(item => ({ ...item, selected: item.id === node.id })),
    edges: connected ? canvas.edges : [
      ...canvas.edges.filter(edge => edge.source !== node.id || edge.target !== source.nodeId),
      { id: crypto.randomUUID(), source: node.id, target: source.nodeId, data: { role, order: Date.now() } },
    ],
  }), !connected);
  useStore.setState({ selectedId: node.id, selectedEdgeId: null });
  return node.id;
}

/** Add a reusable PNG input and an explicit first/last-frame connection to the original video node. */
export function addVideoFrameToCanvas(nodeId: string, frame: VideoFrame): Promise<string> {
  let source: ReturnType<typeof sourceSnapshot>;
  try { source = sourceSnapshot(nodeId); } catch (error) { return Promise.reject(error); }
  const key = [source.projectId, source.canvasId, nodeId, source.assetId, frame].join(":");
  const pending = inFlight.get(key);
  if (pending) return pending;
  const operation = (async () => {
    const initial = currentSource(source);
    const existing = existingFrame(initial.state.project, initial.canvas, source, frame);
    if (existing) return selectExisting(source, frame, existing);
    const blob = await getBlob(source.assetId, source.asset.mime);
    currentSource(source);
    const captured = await captureVideoFrame(blob, frame);
    currentSource(source);
    const imported = await importAsset(captured.blob, frameName(frame) + ".png");
    const { state, canvas, node: video } = currentSource(source);
    const previous = existingFrame(state.project, canvas, source, frame);
    if (previous) return selectExisting(source, frame, previous);
    const asset = { ...imported, width: captured.width, height: captured.height };
    const size = getMediaNodeSize(captured.width, captured.height);
    const position = framePosition(canvas, video, size, frame);
    const node = createNode("reference", 1, position.x, position.y, state.workflows);
    const image: CanvasNode = { ...node, ...size, style: size, selected: true, data: { ...node.data,
      title: frameName(frame), assetId: asset.id, mediaLayoutAssetId: asset.id,
      videoFrameSourceNodeId: source.nodeId, videoFrameSourceAssetId: source.assetId, videoFrame: frame, videoFrameAssetId: asset.id,
    } };
    state.checkpoint();
    state.editProject(project => ({ ...project, assets: { ...project.assets, [asset.id]: asset },
      canvases: project.canvases.map(item => item.id !== source.canvasId ? item : { ...item,
        nodes: [...item.nodes.map(item => ({ ...item, selected: false })), image],
        edges: [...item.edges.filter(edge => edge.target !== source.nodeId || edge.data?.role !== frameRole(frame) ||
          !item.nodes.some(node => node.id === edge.source && node.data.videoFrameSourceNodeId === source.nodeId && node.data.videoFrame === frame)),
          { id: crypto.randomUUID(), source: image.id, target: source.nodeId,
          data: { role: frameRole(frame), order: Date.now() } }],
      }),
    }));
    useStore.setState({ selectedId: image.id, selectedEdgeId: null });
    return image.id;
  })();
  inFlight.set(key, operation);
  void operation.finally(() => { if (inFlight.get(key) === operation) inFlight.delete(key); }).catch(() => {});
  return operation;
}
