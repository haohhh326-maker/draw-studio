import { afterEach, describe, expect, it, vi } from "vitest";
import { getMediaNodeSize, validMediaDimensions } from "../src/nodes/media-layout";
import { readMediaDimensions } from "../src/assets/assets";

afterEach(() => vi.unstubAllGlobals());

describe("media node layout", () => {
  it.each([[1920,1080],[1080,1920],[1000,1000],[300,200],[200,300]])("preserves %s × %s proportions within a bounded node", (width,height) => {
    const size = getMediaNodeSize(width,height);
    expect(size.width).toBeGreaterThanOrEqual(120);
    expect(size.height).toBeGreaterThanOrEqual(120);
    expect(size.width).toBeLessThanOrEqual(360);
    expect(size.height).toBeLessThanOrEqual(360);
    expect(Math.abs(size.width / size.height - width / height)).toBeLessThan(0.005);
  });
  it.each([[10000,10],[10,10000]])("keeps extreme %s × %s media readable using a contain box", (width,height) => {
    const size = getMediaNodeSize(width,height);
    expect(Math.min(size.width,size.height)).toBe(120);
    expect(Math.max(size.width,size.height)).toBe(360);
  });
  it.each([[undefined,undefined],[0,100],[100,0],[-1,20],[Infinity,20],[20,NaN]])("rejects unavailable or invalid %s × %s metadata", (width,height) => {
    expect(validMediaDimensions(width,height)).toBe(false);
    expect(getMediaNodeSize(width,height)).toEqual({width:200,height:180});
  });
});

describe("asset dimensions", () => {
  it("records decoded original image size and releases the bitmap", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap",vi.fn(async () => ({width:2160,height:3840,close})));
    expect(await readMediaDimensions(new Blob(["image"]),"image")).toEqual({width:2160,height:3840});
    expect(close).toHaveBeenCalledOnce();
  });
  it("keeps import usable when dimensions cannot be decoded", async () => {
    vi.stubGlobal("createImageBitmap",vi.fn(async () => { throw new Error("Unsupported image"); }));
    expect(await readMediaDimensions(new Blob(["broken"]),"image")).toBeUndefined();
    expect(await readMediaDimensions(new Blob(["audio"]),"audio")).toBeUndefined();
  });
});
