export type MediaDimensions = { width: number; height: number };

export function validMediaDimensions(width?: number, height?: number): boolean {
  return typeof width === "number" && typeof height === "number" &&
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

/** Fit typical media exactly; exceptionally thin media uses a minimum-size contain box. */
export function getMediaNodeSize(width?: number, height?: number): MediaDimensions {
  if (!validMediaDimensions(width,height)) return {width:200,height:180};
  const scale = Math.min(360 / width!,360 / height!);
  return {
    width:Math.max(120,Math.round(width! * scale)),
    height:Math.max(120,Math.round(height! * scale)),
  };
}
