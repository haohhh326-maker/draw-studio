import { describe, expect, it, vi } from "vitest";
import { clampImageCrop, cropImagePng, fittedCropImage, fullImageCrop, imageCropFromPoints, imageCropPixels, imageCropPoint, moveImageCrop, resizeImageCrop, type CropHandle } from "../src/assets/image-crop";

const size = { width: 1000, height: 800 };
const rect = { x: 200, y: 150, width: 400, height: 300 };
describe("image crop natural-pixel coordinates", () => {
  it("starts with the full original image and fits portrait/landscape without distorting or upscaling", () => {
    expect(fullImageCrop(size)).toEqual({ x: 0, y: 0, ...size });
    expect(fittedCropImage(size, { width: 500, height: 300 })).toEqual({ width: 375, height: 300 });
    expect(fittedCropImage({ width: 100, height: 300 }, { width: 500, height: 500 })).toEqual({ width: 100, height: 300 });
    expect(() => fullImageCrop({ width: 0, height: 50 })).toThrow("尺寸无效");
  });
  it("converts screen positions at a scaled image to source coordinates and clamps outside points", () => {
    const bounds = { left: 50, top: 60, width: 250, height: 200 };
    expect(imageCropPoint({ x: 100, y: 135 }, bounds, size)).toEqual({ x: 200, y: 300 });
    expect(imageCropPoint({ x: -500, y: 5000 }, bounds, size)).toEqual({ x: 0, y: 800 });
    expect(() => imageCropPoint({ x: 0, y: 0 }, { ...bounds, width: 0 }, size)).toThrow("显示区域无效");
  });
  it("moves without changing dimensions and stops at every image boundary", () => {
    expect(moveImageCrop(rect, { x: -9999, y: -9999 }, size)).toEqual({ ...rect, x: 0, y: 0 });
    expect(moveImageCrop(rect, { x: 9999, y: 9999 }, size)).toEqual({ ...rect, x: 600, y: 500 });
    expect(rect).toEqual({ x: 200, y: 150, width: 400, height: 300 });
  });
  it.each(["n", "ne", "e", "se", "s", "sw", "w", "nw"] as CropHandle[])("keeps the %s handle inside bounds and stops before crossing the opposite edge", handle => {
    for (const delta of [{ x: -10000, y: -10000 }, { x: 10000, y: 10000 }, { x: .75, y: -.25 }]) {
      const result = resizeImageCrop(rect, handle, delta, size);
      expect(result.x).toBeGreaterThanOrEqual(0); expect(result.y).toBeGreaterThanOrEqual(0);
      expect(result.width).toBeGreaterThanOrEqual(1); expect(result.height).toBeGreaterThanOrEqual(1);
      expect(result.x + result.width).toBeLessThanOrEqual(size.width); expect(result.y + result.height).toBeLessThanOrEqual(size.height);
      if (!handle.includes("w")) expect(result.x).toBe(rect.x);
      if (!handle.includes("e")) expect(result.x + result.width).toBe(rect.x + rect.width);
      if (!handle.includes("n")) expect(result.y).toBe(rect.y);
      if (!handle.includes("s")) expect(result.y + result.height).toBe(rect.y + rect.height);
    }
  });
  it("supports drawing a rectangle in any direction and guarantees a source pixel at the image corner", () => {
    expect(imageCropFromPoints({ x: 600, y: 500 }, { x: 200, y: 150 }, size)).toEqual({ x: 200, y: 150, width: 400, height: 350 });
    expect(imageCropFromPoints({ x: 1000, y: 800 }, { x: 1000, y: 800 }, size)).toEqual({ x: 999, y: 799, width: 1, height: 1 });
    expect(clampImageCrop({ x: 900, y: 750, width: 500, height: 500 }, size)).toEqual({ x: 900, y: 750, width: 100, height: 50 });
  });
  it("rounds boundaries into positive integer pixels without extending outside a 1px image", () => {
    expect(imageCropPixels({ x: 999.7, y: 799.8, width: .01, height: .01 }, size)).toEqual({ x: 999, y: 799, width: 1, height: 1 });
    expect(imageCropPixels({ x: .1, y: .2, width: .3, height: .4 }, { width: 1, height: 1 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(() => imageCropPixels({ ...rect, x: NaN }, size)).toThrow("区域无效");
  });
  it("draws from natural source pixels and encodes PNG, releasing canvas dimensions", async () => {
    const drawImage = vi.fn(), png = new Blob(["png"], { type: "image/png" });
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob: vi.fn((callback: (blob: Blob) => void) => callback(png)) };
    vi.stubGlobal("document", { createElement: () => canvas });
    const image = { complete: true, naturalWidth: 4000, naturalHeight: 3000 } as HTMLImageElement;
    try {
      expect(await cropImagePng(image, { x: 1000, y: 750, width: 1200, height: 900 })).toBe(png);
      expect(drawImage).toHaveBeenCalledWith(image, 1000, 750, 1200, 900, 0, 0, 1200, 900);
      expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
      expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
  it("reports encoding failures so the user can retry", async () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toBlob: (callback: (blob: null) => void) => callback(null) };
    vi.stubGlobal("document", { createElement: () => canvas });
    try {
      await expect(cropImagePng({ complete: true, naturalWidth: 10, naturalHeight: 10 } as HTMLImageElement, fullImageCrop({ width: 10, height: 10 }))).rejects.toThrow("无法保存裁切图片");
      expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
});
