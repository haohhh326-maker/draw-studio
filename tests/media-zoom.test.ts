import { describe, expect, it } from "vitest";
import { initialMediaZoom, mediaWheelPixels, panMediaBy, zoomMediaAtPoint } from "../src/assets/media-zoom";

describe("media wheel zoom", () => {
  const size = { width: 400, height: 300 };
  it("enlarges around the pointed media coordinate", () => {
    const point = { x: 240, y: 100 };
    const next = zoomMediaAtPoint(initialMediaZoom, -200, point, size);
    expect(next.scale).toBeGreaterThan(1);
    expect((point.x - next.x) / next.scale).toBeCloseTo(point.x);
    expect((point.y - next.y) / next.scale).toBeCloseTo(point.y);
  });
  it("returns to the complete picture when zoomed out", () => {
    const enlarged = zoomMediaAtPoint(initialMediaZoom, -500, { x: 200, y: 150 }, size);
    let next = enlarged;
    for (let i = 0; i < 4; i++) next = zoomMediaAtPoint(next, 500, { x: 200, y: 150 }, size);
    expect(next).toEqual(initialMediaZoom);
  });
  it("limits repeated wheel zoom while keeping content in bounds", () => {
    let next = initialMediaZoom;
    for (let i = 0; i < 20; i++) next = zoomMediaAtPoint(next, -500, { x: 500, y: -50 }, size);
    expect(next.scale).toBe(8);
    expect(next.x).toBeGreaterThanOrEqual(-400 * 7);
    expect(next.x).toBeLessThanOrEqual(0);
    expect(next.y).toBeGreaterThanOrEqual(-300 * 7);
    expect(next.y).toBeLessThanOrEqual(0);
  });
  it("normalizes mouse and page scroll units", () => {
    expect(mediaWheelPixels(-1, 0, 300)).toBe(-1);
    expect(mediaWheelPixels(-1, 1, 300)).toBe(-16);
    expect(mediaWheelPixels(-1, 2, 300)).toBe(-300);
  });
  it("ignores invalid wheel input and unavailable layout", () => {
    expect(zoomMediaAtPoint(initialMediaZoom, NaN, { x: 0, y: 0 }, size)).toBe(initialMediaZoom);
    expect(zoomMediaAtPoint(initialMediaZoom, -10, { x: 0, y: 0 }, { width: 0, height: 300 })).toBe(initialMediaZoom);
  });
});

describe("enlarged media panning", () => {
  const size = { width: 400, height: 300 };
  it("reveals another part of the media without changing magnification", () => {
    expect(panMediaBy({ scale: 2, x: -200, y: -150 }, { x: 70, y: -40 }, size))
      .toEqual({ scale: 2, x: -130, y: -190 });
  });
  it("stops at every edge even when dragged outside the viewport", () => {
    const enlarged = { scale: 2, x: -200, y: -150 };
    expect(panMediaBy(enlarged, { x: 1000, y: 1000 }, size)).toEqual({ scale: 2, x: 0, y: 0 });
    expect(panMediaBy(enlarged, { x: -1000, y: -1000 }, size)).toEqual({ scale: 2, x: -400, y: -300 });
  });
  it("does not move a complete picture or accept invalid movement", () => {
    expect(panMediaBy(initialMediaZoom, { x: -100, y: -100 }, size)).toBe(initialMediaZoom);
    const enlarged = { scale: 2, x: -200, y: -150 };
    expect(panMediaBy(enlarged, { x: NaN, y: 10 }, size)).toBe(enlarged);
    expect(panMediaBy(enlarged, { x: 10, y: 10 }, { width: 0, height: 0 })).toBe(enlarged);
  });
  it("keeps the media within the smaller viewport after leaving fullscreen", () => {
    expect(panMediaBy({ scale: 2, x: -1000, y: -700 }, { x: 0, y: 0 }, size))
      .toEqual({ scale: 2, x: -400, y: -300 });
  });
});
