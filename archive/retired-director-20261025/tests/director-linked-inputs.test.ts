import { describe, expect, it } from "vitest";
import type { Asset, Canvas, MediaKind } from "../src/types";
import type { DirectorSnapshot } from "../src/director/upstream-host";
import { directorLinkedInputs } from "../src/director/linked-inputs";
import { directorAssetPath } from "../src/director/media-bridge";

const asset = (id: string, kind: MediaKind = "image"): Asset => ({ id, name: `${id}.${kind === "image" ? "png" : kind === "video" ? "mp4" : "wav"}`, kind, mime: `${kind}/*`, size: 1, createdAt: 1 });
function input(entries: { asset: Asset; order: number }[]) {
  const canvas: Canvas = { id: "canvas", name: "画布", sceneId: "scene", viewport: { x: 0, y: 0, zoom: 1 },
    nodes: entries.map(({ asset }, index) => ({ id: `source-${index}`, position: { x: 0, y: 0 }, data: { title: asset.name, kind: "reference", assetId: asset.id } })),
    edges: entries.map(({ order }, index) => ({ id: `edge-${index}`, source: `source-${index}`, target: "director", data: { role: "auto", order } })),
  };
  const assets = Object.fromEntries(entries.map(entry => [entry.asset.id, entry.asset]));
  return { canvas, assets };
}
const snapshot = (global: Record<string, unknown> = {}): DirectorSnapshot => ({ values: { task_type: "r2v — 参考主体生视频(Reference to Video)" }, timeline: { global, segments: [{ prompt: "Keep session prompt", frameCount: 121 }] } });

describe("director canvas linked inputs", () => {
  it("maps edge order into separate public image, video and audio slots without displacing manual choices", () => {
    const images = [asset("image-first"), asset("image-second")], video = asset("video", "video"), audio = asset("audio", "audio");
    const { canvas, assets } = input([{ asset: images[1], order: 4 }, { asset: audio, order: 1 }, { asset: images[0], order: 2 }, { asset: video, order: 3 }]);
    const original = snapshot({ refs: [{ index: 2, imageFile: "manual.png" }], refVideos: [{ slot: 1, videoFile: "manual.mp4" }], refAudios: [] });
    const before = structuredClone(original);
    const result = directorLinkedInputs(canvas, "director", assets, original);
    expect(result.timeline.global.refs).toEqual([
      { index: 2, imageFile: "manual.png" },
      { index: 0, imageFile: directorAssetPath(images[0]), fileName: images[0].name, subfolder: "", type: "input" },
      { index: 1, imageFile: directorAssetPath(images[1]), fileName: images[1].name, subfolder: "", type: "input" },
    ]);
    expect(result.timeline.global.refVideos[1]).toMatchObject({ index: 0, videoFile: directorAssetPath(video) });
    expect(result.timeline.global.refAudios[0]).toMatchObject({ index: 0, audioFile: directorAssetPath(audio) });
    expect(result.media).toEqual(Object.fromEntries([...images, video, audio].map(item => [directorAssetPath(item), item.id])));
    expect(result.timeline.global.commonEnabled).toBe(true);
    expect(original).toEqual(before);
    expect(canvas.edges.map(edge => edge.data!.order)).toEqual([4, 1, 2, 3]);
  });

  it("disconnects only previously injected public entries while preserving hand-picked and per-group media", () => {
    const linked = asset("linked"), manual = asset("manual");
    const { canvas, assets } = input([{ asset: linked, order: 1 }]);
    const initial = snapshot({ refs: [{ index: 4, imageFile: directorAssetPath(manual) }], refAudios: [{ index: 1, audioFile: "manual.wav" }] });
    initial.timeline.segments[0].refs = [{ index: 0, imageFile: directorAssetPath(linked) }];
    const connected = directorLinkedInputs(canvas, "director", assets, initial);
    canvas.edges = [];
    const disconnected = directorLinkedInputs(canvas, "director", assets, { ...initial, timeline: connected.timeline }, connected.linkedPaths);
    expect(disconnected.timeline.global.refs).toEqual([{ index: 4, imageFile: directorAssetPath(manual) }]);
    expect(disconnected.timeline.global.refAudios).toEqual(initial.timeline.global.refAudios);
    expect(disconnected.timeline.segments).toEqual(initial.timeline.segments);
    expect(disconnected.linkedPaths).toEqual([]); expect(disconnected.media).toEqual({});
  });

  it("does not take ownership of an existing hand-picked copy of a linked asset", () => {
    const existing = asset("already-manual"), { canvas, assets } = input([{ asset: existing, order: 1 }, { asset: existing, order: 2 }]);
    const initial = snapshot({ refs: [{ index: 5, imageFile: directorAssetPath(existing), note: "manual" }] });
    const connected = directorLinkedInputs(canvas, "director", assets, initial);
    expect(connected.linkedPaths).toEqual([]); expect(connected.timeline.global.refs).toEqual(initial.timeline.global.refs);
    canvas.edges = [];
    expect(directorLinkedInputs(canvas, "director", assets, { ...initial, timeline: connected.timeline }, connected.linkedPaths).timeline.global.refs).toEqual(initial.timeline.global.refs);
  });

  it.each([["image", 9], ["video", 3], ["audio", 3]] as const)("rejects excess %s links instead of silently truncating at %i slots", (kind, limit) => {
    const { canvas, assets } = input(Array.from({ length: limit + 1 }, (_, index) => ({ asset: asset(`asset-${index}`, kind), order: index + 1 })));
    const initial = snapshot(), before = structuredClone(initial);
    expect(() => directorLinkedInputs(canvas, "director", assets, initial)).toThrow(`最多支持 ${limit} 项`);
    expect(initial).toEqual(before);
  });

  it.each([9, 10])("rejects adding to %i imported manual slots even when their indices leave a hole", count => {
    const item = asset("new-image"), { canvas, assets } = input([{ asset: item, order: 1 }]);
    const initial = snapshot({ refs: Array.from({ length: count }, (_, index) => ({ index: index + 1, imageFile: `manual-${index}.png` })) });
    expect(() => directorLinkedInputs(canvas, "director", assets, initial)).toThrow("最多支持 9 项");
  });

  it("synchronizes the current batch workspace while preserving other modes and session prompts", () => {
    const item = asset("picture"), { canvas, assets } = input([{ asset: item, order: 1 }]);
    const initial = snapshot({ prompt: "Keep current common prompt", refs: [] });
    initial.timeline.batchWorkspaces = {
      r2v: { segments: [{ prompt: "Group prompt", frameCount: 121 }], globalCommon: { prompt: "stale", refs: [], otherSetting: 7 } },
      i2v: { segments: [{ prompt: "Another mode" }], globalCommon: { refs: [{ index: 0, imageFile: "other-mode.png" }] } },
    };
    const before = structuredClone(initial);
    const result = directorLinkedInputs(canvas, "director", assets, initial);
    expect(result.timeline.batchWorkspaces.r2v.globalCommon).toMatchObject({ refs: result.timeline.global.refs, refVideos: [], refAudios: [], commonEnabled: true, commonCollapsed: true, prompt: "Keep current common prompt", otherSetting: 7 });
    expect(result.timeline.batchWorkspaces.r2v.globalCommon.refs).not.toBe(result.timeline.global.refs);
    expect(result.timeline.batchWorkspaces.r2v.segments).toEqual(before.timeline.batchWorkspaces.r2v.segments);
    expect(result.timeline.batchWorkspaces.i2v).toEqual(before.timeline.batchWorkspaces.i2v);
    expect(initial).toEqual(before);
  });

  it("reorders managed slots, deduplicates repeated assets and ignores unrelated or unusable sources", () => {
    const first = asset("one"), second = asset("two"), { canvas, assets } = input([{ asset: first, order: 1 }, { asset: second, order: 2 }, { asset: first, order: 3 }, { asset: asset("text", "text"), order: 4 }]);
    canvas.edges.push({ id: "missing", source: "absent", target: "director", data: { role: "auto", order: 0 } });
    canvas.edges.push({ id: "unrelated", source: "source-3", target: "another-node", data: { role: "auto", order: 0 } });
    const initial = snapshot(), connected = directorLinkedInputs(canvas, "director", assets, initial);
    expect(connected.linkedPaths).toHaveLength(2);
    canvas.edges[0].data!.order = 5;
    const reordered = directorLinkedInputs(canvas, "director", assets, { ...initial, timeline: connected.timeline }, connected.linkedPaths);
    expect(reordered.timeline.global.refs.map((ref: any) => [ref.index, ref.imageFile])).toEqual([[0, directorAssetPath(second)], [1, directorAssetPath(first)]]);
  });
});
