/** Opening a canvas menu closes any other canvas or node menu. */
export const canvasContextMenuDismissEvent = "canvas-context-menu-dismiss";

export function dismissCanvasContextMenus() {
  document.dispatchEvent(new Event(canvasContextMenuDismissEvent));
}
