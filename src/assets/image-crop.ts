export type CropSize = { width: number; height: number };
export type CropPoint = { x: number; y: number };
export type CropRect = CropPoint & CropSize;
export type CropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const finite = (values: number[]) => values.every(Number.isFinite);
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
function checkedSize(size: CropSize) {
  if (!finite([size.width, size.height]) || size.width < 1 || size.height < 1) throw new Error("图片尺寸无效。");
}

export function fullImageCrop(size: CropSize): CropRect {
  checkedSize(size);
  return { x: 0, y: 0, width: size.width, height: size.height };
}

/** Selection coordinates always describe the original decoded image, independent of display scale. */
export function clampImageCrop(rect: CropRect, size: CropSize): CropRect {
  checkedSize(size);
  if (!finite([rect.x, rect.y, rect.width, rect.height])) throw new Error("裁切区域无效。");
  const x = clamp(rect.x, 0, size.width - 1), y = clamp(rect.y, 0, size.height - 1);
  return { x, y, width: clamp(rect.width, 1, size.width - x), height: clamp(rect.height, 1, size.height - y) };
}

export function moveImageCrop(rect: CropRect, delta: CropPoint, size: CropSize): CropRect {
  const current = clampImageCrop(rect, size);
  if (!finite([delta.x, delta.y])) return current;
  return { ...current, x: clamp(current.x + delta.x, 0, size.width - current.width), y: clamp(current.y + delta.y, 0, size.height - current.height) };
}

/** Dragging past the opposite edge stops at one source pixel instead of flipping the handles. */
export function resizeImageCrop(rect: CropRect, handle: CropHandle, delta: CropPoint, size: CropSize): CropRect {
  const current = clampImageCrop(rect, size);
  if (!finite([delta.x, delta.y])) return current;
  let left = current.x, top = current.y, right = left + current.width, bottom = top + current.height;
  if (handle.includes("w")) left = clamp(left + delta.x, 0, right - 1);
  if (handle.includes("e")) right = clamp(right + delta.x, left + 1, size.width);
  if (handle.includes("n")) top = clamp(top + delta.y, 0, bottom - 1);
  if (handle.includes("s")) bottom = clamp(bottom + delta.y, top + 1, size.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function imageCropFromPoints(start: CropPoint, end: CropPoint, size: CropSize): CropRect {
  checkedSize(size);
  if (!finite([start.x, start.y, end.x, end.y])) throw new Error("裁切位置无效。");
  const left = Math.min(clamp(start.x, 0, size.width), clamp(end.x, 0, size.width));
  const top = Math.min(clamp(start.y, 0, size.height), clamp(end.y, 0, size.height));
  return clampImageCrop({ x: left, y: top, width: Math.abs(clamp(end.x, 0, size.width) - clamp(start.x, 0, size.width)), height: Math.abs(clamp(end.y, 0, size.height) - clamp(start.y, 0, size.height)) }, size);
}

export function imageCropPoint(client: CropPoint, bounds: { left: number; top: number; width: number; height: number }, size: CropSize): CropPoint {
  checkedSize(size);
  if (!finite([client.x, client.y, bounds.left, bounds.top, bounds.width, bounds.height]) || bounds.width <= 0 || bounds.height <= 0) throw new Error("图片显示区域无效。");
  return { x: clamp((client.x - bounds.left) * size.width / bounds.width, 0, size.width), y: clamp((client.y - bounds.top) * size.height / bounds.height, 0, size.height) };
}

export function fittedCropImage(size: CropSize, bounds: CropSize): CropSize {
  checkedSize(size);
  if (!finite([bounds.width, bounds.height]) || bounds.width <= 0 || bounds.height <= 0) return { width: 1, height: 1 };
  const scale = Math.min(1, bounds.width / size.width, bounds.height / size.height);
  return { width: size.width * scale, height: size.height * scale };
}

/** Round the two boundaries together so the encoded PNG is an exact integer-pixel crop. */
export function imageCropPixels(rect: CropRect, size: CropSize): CropRect {
  const current = clampImageCrop(rect, size);
  const width = Math.floor(size.width), height = Math.floor(size.height);
  const x = clamp(Math.round(current.x), 0, width - 1), y = clamp(Math.round(current.y), 0, height - 1);
  const right = clamp(Math.round(current.x + current.width), x + 1, width), bottom = clamp(Math.round(current.y + current.height), y + 1, height);
  return { x, y, width: right - x, height: bottom - y };
}

/** Export from the natural image, never from a scaled thumbnail or canvas screenshot. */
export async function cropImagePng(image: HTMLImageElement, selection: CropRect): Promise<Blob> {
  if (!image.complete || image.naturalWidth < 1 || image.naturalHeight < 1) throw new Error("图片尚未载入，请稍后重试。");
  const rect = imageCropPixels(selection, { width: image.naturalWidth, height: image.naturalHeight });
  const canvas = document.createElement("canvas");
  canvas.width = rect.width; canvas.height = rect.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法裁切图片。");
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    return await new Promise<Blob>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("图片保存超时，请缩小裁切区域后重试。")), 15000);
      try {
        canvas.toBlob(blob => { clearTimeout(timeout); blob ? resolve(blob) : reject(new Error("无法保存裁切图片，请缩小区域后重试。")); }, "image/png");
      } catch (error) { clearTimeout(timeout); reject(error); }
    });
  } finally { canvas.width = 0; canvas.height = 0; }
}
