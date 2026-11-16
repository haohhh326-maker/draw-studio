import { beforeEach, describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => new Map<string, Blob>());
vi.mock("../src/projects/storage", () => ({
  putBlob: async (id: string, blob: Blob) => { stored.set(id, blob); },
  getBlob: async (id: string) => stored.get(id),
}));
import { importAsset } from "../src/assets/assets";

beforeEach(() => stored.clear());

describe("asset imports preserve every output format", () => {
  it.each([
    ["scene.glb", "model/gltf-binary"],
    ["font.woff2", "font/woff2"],
    ["points.custom", "chemical/x-custom-points"],
    ["weights.safetensors", "application/octet-stream"],
    ["unknown.dat", ""],
    ["unknown.constructor", ""],
    ["unknown.__proto__", ""],
    ["png", ""],
  ])("stores %s as a file without changing any bytes", async (name, type) => {
    const bytes = new Uint8Array([0, 255, 254, 128, 13, 10, 1]);
    const asset = await importAsset(new Blob([bytes], { type }), name);
    const original = stored.get(asset.id)!;

    expect(asset).toMatchObject({ name, kind: "file", mime: type || "application/octet-stream", size: bytes.byteLength, inLibrary: false });
    expect(asset.text).toBeUndefined();
    expect(original.type).toBe(asset.mime);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    ["result.png", "audio/wav", "audio"],
    ["result.wav", "video/webm", "video"],
    ["result.mp4", "image/png", "image"],
    ["result.mp4", "application/pdf", "file"],
    ["result.png", "application/json", "file"],
    ["result.png", "model/gltf-binary", "file"],
  ])("classifies %s by its concrete MIME %s", async (name, mime, kind) => {
    const source = new Blob([new Uint8Array([0, 1, 255])], { type: mime });
    const asset = await importAsset(source, name);

    expect(asset).toMatchObject({ name, kind, mime, size: source.size });
    expect(await stored.get(asset.id)!.arrayBuffer()).toEqual(await source.arrayBuffer());
  });

  it.each([
    ["result.PNG", "", "image/png", "image"],
    ["result.mp4", "application/octet-stream", "video/mp4", "video"],
    ["result.flac", "binary/octet-stream", "audio/flac", "audio"],
    ["result.txt", "application/octet-stream; charset=utf-8", "text/plain", "text"],
  ])("uses %s to classify an unspecified or generic MIME", async (name, type, mime, kind) => {
    const source = new Blob(["原始内容\r\n"], { type });
    const asset = await importAsset(source, name);

    expect(asset).toMatchObject({ name, kind, mime });
    expect(stored.get(asset.id)!.type).toBe(mime);
    expect(await stored.get(asset.id)!.arrayBuffer()).toEqual(await source.arrayBuffer());
    if (kind === "text") expect(asset.text).toBe("原始内容\r\n");
  });

  it("keeps a text MIME and original text even when the filename looks like media", async () => {
    const source = new Blob(["第一行\r\nsecond line\n"], { type: "text/plain; charset=utf-8" });
    const asset = await importAsset(source, "result.mp4");

    expect(asset).toMatchObject({ kind: "text", mime: source.type, text: "第一行\r\nsecond line\n" });
    expect(await stored.get(asset.id)!.arrayBuffer()).toEqual(await source.arrayBuffer());
  });

  it.each(["image/png", "text/plain"])("honors an explicit file hint for %s", async type => {
    const source = new Blob(["original"], { type });
    const asset = await importAsset(source, "attachment.png", "file");

    expect(asset).toMatchObject({ kind: "file", mime: type });
    expect(asset.text).toBeUndefined();
    expect(await stored.get(asset.id)!.arrayBuffer()).toEqual(await source.arrayBuffer());
  });
});
