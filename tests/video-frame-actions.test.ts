import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Asset, CanvasNode, Project } from "../src/types";
const mocks = vi.hoisted(() => ({ getBlob: vi.fn(), capture: vi.fn(), importAsset: vi.fn() }));
vi.mock("../src/projects/storage", () => ({ getBlob: mocks.getBlob, readRecord: async () => undefined,
  writeRecord: async () => {}, safeConnection: (value: object) => value }));
vi.mock("../src/projects/directory", () => ({ syncProjectDirectory: async () => {} }));
vi.mock("../src/workflow/library-client", () => ({ readWorkflowLibrary: async () => { throw new Error("offline"); } }));
vi.mock("../src/assets/assets", () => ({ importAsset: mocks.importAsset }));
vi.mock("../src/assets/video-frames", () => ({ captureVideoFrame: mocks.capture }));
import { useStore } from "../src/stores/store";
import { addVideoFrameToCanvas } from "../src/nodes/video-frame-actions";

const source: Asset = { id: "source-video", name: "source.mp4", kind: "video", mime: "video/mp4", size: 10, createdAt: 1, width: 1920, height: 1080 };
function project(): Project {
  const node: CanvasNode = { id: "video-node", type: "media", position: { x: 500, y: 200 }, style: { width: 360, height: 203 },
    data: { kind: "reference", title: "源视频", assetId: source.id } };
  return { version: 2, id: "p", name: "视频帧", scenes: [], activeCanvasId: "c", updatedAt: 1,
    canvases: [{ id: "c", name: "画布", sceneId: "s", viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node], edges: [] }],
    assets: { [source.id]: source }, tasks: {}, history: [] };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBlob.mockResolvedValue(new Blob(["video"], { type: "video/mp4" }));
  mocks.capture.mockResolvedValue({ blob: new Blob(["frame"], { type: "image/png" }), width: 1920, height: 1080, time: 0 });
  mocks.importAsset.mockImplementation(async (_blob: Blob, name: string) => ({ id: crypto.randomUUID(), name, kind: "image", mime: "image/png", size: 5, createdAt: 1 }));
  useStore.setState({ project: project(), projectOpen: true, ready: false, workflows: [], past: [], future: [], selectedId: null, selectedEdgeId: null });
});

describe("video frame canvas actions", () => {
  it.each([["first", "首帧", "firstFrame"], ["last", "尾帧", "lastFrame"]] as const)("adds %s as a proportional image with an explicit role, retaining the source video", async (frame, title, role) => {
    const before = useStore.getState().project;
    const id = await addVideoFrameToCanvas("video-node", frame);
    const current = useStore.getState().project, canvas = current.canvases[0];
    expect(canvas.nodes[0].data).toEqual(before.canvases[0].nodes[0].data);
    expect(current.assets[source.id]).toEqual(source);
    const node = canvas.nodes.find(node => node.id === id)!;
    expect(node.data).toMatchObject({ kind: "reference", title, videoFrame: frame, videoFrameSourceAssetId: source.id });
    expect(node.style).toEqual({ width: 360, height: 203 });
    expect(current.assets[node.data.assetId!]).toMatchObject({ kind: "image", width: 1920, height: 1080 });
    expect(canvas.edges).toMatchObject([{ source: id, target: "video-node", data: { role } }]);
    expect(useStore.getState().selectedId).toBe(id);
    expect(useStore.getState().past).toHaveLength(1);
    useStore.getState().undo(); expect(useStore.getState().project.canvases[0].nodes).toHaveLength(1);
    useStore.getState().redo(); expect(useStore.getState().project.canvases[0].edges[0].data?.role).toBe(role);
  });
  it("places both roles separately and reuses an extracted frame on repeat clicks", async () => {
    const first = await addVideoFrameToCanvas("video-node", "first");
    const last = await addVideoFrameToCanvas("video-node", "last");
    expect(await addVideoFrameToCanvas("video-node", "first")).toBe(first);
    const canvas = useStore.getState().project.canvases[0];
    expect(canvas.nodes).toHaveLength(3); expect(canvas.edges).toHaveLength(2);
    const firstNode = canvas.nodes.find(node => node.id === first)!;
    const lastNode = canvas.nodes.find(node => node.id === last)!;
    expect(lastNode.position.y - firstNode.position.y).toBeGreaterThanOrEqual(203 + 24);
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });
  it("deduplicates simultaneous clicks and restores a removed frame connection", async () => {
    const first = addVideoFrameToCanvas("video-node", "first");
    expect(addVideoFrameToCanvas("video-node", "first")).toBe(first);
    const id = await first;
    useStore.getState().editCanvas(canvas => ({ ...canvas, edges: [] }));
    expect(await addVideoFrameToCanvas("video-node", "first")).toBe(id);
    expect(useStore.getState().project.canvases[0].edges).toHaveLength(1);
    expect(mocks.capture).toHaveBeenCalledOnce();
  });
  it("extracts a fresh frame after its image was replaced, retaining that image but reconnecting the genuine frame", async () => {
    const first = await addVideoFrameToCanvas("video-node", "first");
    const originalFrame = useStore.getState().project.canvases[0].nodes.find(node => node.id === first)!;
    expect(originalFrame.data.videoFrameAssetId).toBe(originalFrame.data.assetId);
    const replacement: Asset = { id: "other-image", name: "other.png", kind: "image", mime: "image/png", size: 3, createdAt: 2 };
    useStore.getState().addAsset(replacement, { x: 0, y: 0 }, first);
    const fresh = await addVideoFrameToCanvas("video-node", "first");
    expect(fresh).not.toBe(first);
    const canvas = useStore.getState().project.canvases[0];
    expect(canvas.nodes).toHaveLength(3);
    expect(canvas.nodes.find(node => node.id === first)?.data.assetId).toBe(replacement.id);
    expect(canvas.edges).toMatchObject([{ source: fresh, target: "video-node", data: { role: "firstFrame" } }]);
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });
  it("does not write the extracted frame into another project after an asynchronous switch", async () => {
    let finish!: (value: unknown) => void;
    mocks.capture.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const extraction = addVideoFrameToCanvas("video-node", "first");
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    useStore.setState({ project: { ...project(), id: "other" } });
    finish({ blob: new Blob(), width: 1920, height: 1080, time: 0 });
    await expect(extraction).rejects.toThrow("已切换");
    expect(mocks.importAsset).not.toHaveBeenCalled();
    expect(useStore.getState().project.canvases[0].nodes).toHaveLength(1);
  });
  it("rejects a replaced video and leaves task/history snapshots and the canvas unchanged", async () => {
    let finish!: (value: unknown) => void;
    mocks.capture.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const extraction = addVideoFrameToCanvas("video-node", "last");
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    useStore.getState().patchNode("video-node", { assetId: "replacement" });
    const changed = useStore.getState().project;
    finish({ blob: new Blob(), width: 1920, height: 1080, time: 9.999 });
    await expect(extraction).rejects.toThrow("已更换");
    expect(useStore.getState().project).toBe(changed);
    expect(useStore.getState().project.tasks).toEqual({}); expect(useStore.getState().project.history).toEqual([]);
  });
  it("leaves no empty image node when local decoding fails", async () => {
    mocks.capture.mockRejectedValueOnce(new Error("无法解码"));
    const before = useStore.getState().project;
    await expect(addVideoFrameToCanvas("video-node", "first")).rejects.toThrow("无法解码");
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
  });
  it("resolves grouped source coordinates before placing extracted top-level nodes", async () => {
    useStore.getState().editCanvas(canvas => ({ ...canvas, nodes: [
      { id: "group", type: "group", position: { x: 1000, y: 800 }, data: { kind: "group", title: "组" } },
      { ...canvas.nodes[0], parentId: "group" },
    ] }));
    const id = await addVideoFrameToCanvas("video-node", "first");
    const image = useStore.getState().project.canvases[0].nodes.find(node => node.id === id)!;
    expect(image.parentId).toBeUndefined(); expect(image.position).toEqual({ x: 1060, y: 1000 });
  });
});
