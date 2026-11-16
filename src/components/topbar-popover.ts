export const CONNECTION_POPOVER_WIDTH = 385;
export const CONNECTION_POPOVER_HEIGHT = 79;
export const EXECUTION_POPOVER_WIDTH = 385;
export const EXECUTION_POPOVER_HEIGHT = 487;

/** Keep both popovers aligned at the same inset from the canvas's top and right. */
export function canvasPopoverBounds(preferredWidth: number, canvas?: Pick<DOMRect, "left" | "right" | "top">) {
  const margin = 16;
  const start = Math.max(0, canvas?.left ?? 0) + margin;
  const end = Math.min(window.innerWidth, canvas?.right ?? window.innerWidth) - margin;
  const width = Math.min(preferredWidth, Math.max(0, end - start));
  const top = Math.max(margin, Math.min((canvas?.top ?? 64) + margin, window.innerHeight - margin));
  return { left: Math.max(start, end - width), top, width, margin };
}
