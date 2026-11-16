import { beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Asset } from "../src/types";

const storage = vi.hoisted(() => ({
  blobs: new Map<string, Blob>(),
  writes: [] as string[],
}));
vi.mock("../src/projects/storage", () => ({
  getBlob: async (id: string) => {
    const blob = storage.blobs.get(id);
    if (!blob) throw new Error("missing");
    return blob;
  },
  putBlob: async (id: string, blob: Blob) => {
    storage.blobs.set(id, blob);
    storage.writes.push(id);
  },
}));
import {
  createDirectorMediaBridge,
  rewriteDirectorMediaPaths,
  stripDirectorPrompts,
} from "../src/director/media-bridge";

function setup(initial: Asset[] = []) {
  const assets = Object.fromEntries(initial.map((asset) => [asset.id, asset]));
  let media: Record<string, string> = {};
  const bridge = createDirectorMediaBridge({
    getAssets: () => assets,
    addAsset: (asset) => {
      assets[asset.id] = asset;
    },
    getMediaMap: () => media,
    setMediaMap: (next) => {
      media = next;
    },
  });
  return { bridge, assets, media: () => media };
}
const asset: Asset = {
  id: "test-image",
  name: "场景.png",
  mime: "image/png",
  kind: "image",
  size: 3,
  createdAt: 1000,
  width: 4,
  height: 3,
};
const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
});

beforeEach(() => {
  storage.blobs.clear();
  storage.writes.length = 0;
});
describe("director local media bridge", () => {
  it("removes prompts from every nested workspace and serialized timeline without mutating the session", () => {
    const input = {
      prompt: "privateA",
      global_prompt: "privateB",
      negativePrompt: "privateC",
      step: 10,
      timeline_data: JSON.stringify({
        global: { prompt: "privateD" },
        batchWorkspaces: [{ negative_prompt: "privateE", prompt: "privateF" }],
        mode: "r2v",
      }),
    };
    const clean = stripDirectorPrompts(input);
    expect(JSON.stringify(clean)).not.toContain("private");
    expect(clean.step).toBe(10);
    expect(JSON.parse(clean.timeline_data).mode).toBe("r2v");
    expect(input.prompt).toBe("privateA");
  });
  it("rewrites media paths and nested JSON without corrupting labels or duplicated subfolders", () => {
    const missing: string[] = [];
    const result = rewriteDirectorMediaPaths(
      {
        refs: [
          {
            imageFile: "extra/a.png",
            subfolder: "extra",
            fileName: "a.png",
            slot: 3,
          },
        ],
        timeline_data: '{"video":{"videoFile":"lost.mp4"}}',
        label: "extra/a.png",
      },
      (path) => (path === "extra/a.png" ? "canvas/a/image.png" : undefined),
      missing,
    );
    expect(result.refs[0]).toEqual({
      imageFile: "canvas/a/image.png",
      subfolder: "canvas/a",
      fileName: "image.png",
      type: "input",
      slot: 3,
    });
    expect(result.label).toBe("extra/a.png");
    expect(missing).toEqual(["lost.mp4"]);
    expect(JSON.parse(result.timeline_data).video.videoFile).toBe("");
  });
  it("prepares real local blob URLs and lists existing images with upstream schema", async () => {
    storage.blobs.set(asset.id, new Blob(["img"], { type: asset.mime }));
    const { bridge } = setup([asset]);
    await bridge.prepare();
    const list = await (
      await bridge.fetchApi("/minimax/director/list_input_media?kind=image")
    ).json();
    expect(list.items[0]).toMatchObject({
      name: "场景.png",
      relPath: "canvas/test-image/场景.png",
      type: "input",
      width: 4,
      height: 3,
      modified: 1,
    });
    expect(
      bridge.apiURL(
        "/view?filename=%E5%9C%BA%E6%99%AF.png&subfolder=canvas/test-image",
      ),
    ).toMatch(/^blob:/);
    expect(storage.writes).toEqual([]);
    bridge.destroy();
  });
  it("exports only sanitized JSON with original media bytes and imports a portable pack", async () => {
    storage.blobs.set(asset.id, new Blob(["img"], { type: asset.mime }));
    const first = setup([asset]);
    await first.bridge.prepare();
    const payload = {
      timeline: {
        version: 5,
        global: {
          prompt: "privateA",
          refs: [{ imageFile: "canvas/test-image/场景.png" }],
        },
        segments: [
          { prompt: "privateB", negativePrompt: "privateC", frameCount: 124 },
        ],
        batchWorkspaces: { r2v: { timeline_data: '{"prompt":"privateD"}' } },
      },
      widgets: {
        task_type: "r2v — 参考主体生视频",
        global_prompt: "privateE",
        steps: 25,
      },
    };
    const preview = await (
      await first.bridge.fetchApi(
        "/minimax/director/export_pack",
        post({ ...payload, dryRun: true }),
      )
    ).json();
    expect(preview).toMatchObject({
      totalBytes: 3,
      fileCount: 1,
      missing: [],
      taskType: "r2v",
    });
    const response = await first.bridge.fetchApi(
      "/minimax/director/export_pack",
      post(payload),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    const pack = await response.blob(),
      files = unzipSync(new Uint8Array(await pack.arrayBuffer()));
    for (const [name, bytes] of Object.entries(files))
      if (name.endsWith(".json"))
        expect(strFromU8(bytes)).not.toContain("private");
    expect(strFromU8(files["extra/Media1.png"])).toBe("img");
    const second = setup(),
      form = new FormData();
    form.append("file", pack, "test.mmxpack.zip");
    const importedResponse = await second.bridge.fetchApi(
      "/minimax/director/import_pack",
      { method: "POST", body: form },
    );
    expect(importedResponse.status).toBe(200);
    const imported = await importedResponse.json();
    expect(imported.timeline.global.refs[0].imageFile).toMatch(
      /^canvas\/[a-z0-9-]+\/Media1.png$/,
    );
    expect(imported.timeline.segments[0]).toMatchObject({
      prompt: "",
      negativePrompt: "",
      frameCount: 124,
    });
    expect(imported.widgets.steps).toBe(25);
    expect(imported.missing).toEqual([]);
    expect(Object.values(second.assets)).toHaveLength(1);
    expect(storage.writes).toHaveLength(1);
    expect(await storage.blobs.get(storage.writes[0])!.text()).toBe("img");
    expect(payload.timeline.global.prompt).toBe("privateA");
    first.bridge.destroy();
    second.bridge.destroy();
  });
  it("clears original pack prompt fields before exposing its timeline and never saves pack JSON blobs", async () => {
    const bytes = zipSync({
      "pack.json": strToU8(
        '{"format":"minimax-h3-director-pack","widgets":{"global_prompt":"privateB"}}',
      ),
      "timeline.json": strToU8(
        '{"global":{"prompt":"privateA"},"segments":[{"prompt":"privateC"}]}',
      ),
    });
    const { bridge } = setup(),
      body = new FormData();
    body.append("pack", new Blob([bytes]), "source.zip");
    const data = await (
      await bridge.fetchApi("/minimax/director/import_pack", {
        body,
        method: "POST",
      })
    ).json();
    expect(JSON.stringify(data)).not.toContain("private");
    expect(storage.writes).toEqual([]);
    bridge.destroy();
  });
  it("keeps chunked zip bytes transient until import and reconstructs all chunks in order", async () => {
    const bytes = zipSync({
      "timeline.json": strToU8(
        '{"global":{"prompt":"privateA"},"segments":[]}',
      ),
    });
    const { bridge } = setup();
    let uploaded: any;
    const parts = [bytes.slice(0, 20), bytes.slice(20)];
    for (const index of [1, 0]) {
      const form = new FormData();
      form.append("upload_id", "pack-test");
      form.append("filename", "pack.zip");
      form.append("chunk_index", String(index));
      form.append("total_chunks", "2");
      form.append("chunk", new Blob([parts[index]]));
      uploaded = await (
        await bridge.fetchApi("/minimax/director/upload_chunk", {
          body: form,
          method: "POST",
        })
      ).json();
    }
    expect(uploaded.name).toBe("pack.zip");
    expect(storage.writes).toEqual([]);
    const result = await (
      await bridge.fetchApi(
        "/minimax/director/import_pack",
        post({ filename: uploaded.name, subfolder: uploaded.subfolder }),
      )
    ).json();
    expect(result.timeline.global.prompt).toBe("");
    expect(storage.writes).toEqual([]);
    bridge.destroy();
  });
  it("rejects archive traversal and unsupported LoRA directory without returning fake success", async () => {
    const { bridge } = setup(),
      form = new FormData();
    form.append(
      "pack",
      new Blob([
        zipSync({
          "../escape.png": strToU8("x"),
          "timeline.json": strToU8("{}"),
        }),
      ]),
      "bad.zip",
    );
    const response = await bridge.fetchApi("/minimax/director/import_pack", {
      body: form,
      method: "POST",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("无效文件路径");
    expect(storage.writes).toEqual([]);
    const lora = await bridge.fetchApi("/object_info/LoraLoader");
    expect(lora.status).toBe(503);
    expect(await lora.text()).toContain("未连接云端 LoRA");
    bridge.destroy();
  });
});
