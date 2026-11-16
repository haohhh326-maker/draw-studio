export const localTransferDragType = "application/x-draw-studio-local-files";

export type LocalTransferDrag = { bucket: string; paths: string[] };

export function createLocalTransferDrag(bucket: string, path: string, selection: ReadonlySet<string>): LocalTransferDrag {
  // Dragging one of the checked rows transfers the complete selection. An
  // unchecked row starts a new selection, matching desktop file managers.
  return { bucket, paths: selection.has(path) ? [...selection] : [path] };
}

export function isLocalTransferDrag(value: string, expected: LocalTransferDrag): boolean {
  // Only the drag started by this panel can upload. Plain text, external files,
  // another panel, and a payload changed during the drag are never interpreted
  // as local disk paths.
  return value === JSON.stringify(expected);
}
