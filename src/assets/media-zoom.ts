export type MediaZoom = { scale: number; x: number; y: number };
export const initialMediaZoom: MediaZoom = { scale: 1, x: 0, y: 0 };

/** Move enlarged media with the pointer, stopping at the viewport edges. */
export function panMediaBy(
  current: MediaZoom,
  delta: { x: number; y: number },
  size: { width: number; height: number },
): MediaZoom {
  if (current.scale <= 1 || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)
    || size.width <= 0 || size.height <= 0) return current;
  return {
    scale: current.scale,
    x: Math.max(-size.width * (current.scale - 1), Math.min(0, current.x + delta.x)),
    y: Math.max(-size.height * (current.scale - 1), Math.min(0, current.y + delta.y)),
  };
}

/** Keep the media under the pointer while zooming, without exposing empty edges. */
export function zoomMediaAtPoint(
  current: MediaZoom,
  delta: number,
  point: { x: number; y: number },
  size: { width: number; height: number },
): MediaZoom {
  if (!Number.isFinite(delta) || size.width <= 0 || size.height <= 0) return current;
  const scale = Math.max(1, Math.min(8, current.scale * Math.exp(-Math.max(-600, Math.min(600, delta)) * 0.002)));
  if (scale === 1) return { ...initialMediaZoom };
  if (scale === current.scale) return current;
  const ratio = scale / current.scale;
  const x = point.x - (point.x - current.x) * ratio;
  const y = point.y - (point.y - current.y) * ratio;
  return {
    scale,
    x: Math.max(-size.width * (scale - 1), Math.min(0, x)),
    y: Math.max(-size.height * (scale - 1), Math.min(0, y)),
  };
}

export function mediaWheelPixels(delta: number, mode: number, height: number): number {
  return mode === 1 ? delta * 16 : mode === 2 ? delta * height : delta;
}
