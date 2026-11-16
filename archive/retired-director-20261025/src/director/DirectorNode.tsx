import { lazy, memo, Suspense } from "react";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { Clapperboard, GripHorizontal, Trash2 } from "lucide-react";
import { deleteDirectorNode, isDirectorDeleteKey, selectDirectorNode } from "./node-actions";
import { useStore } from "../stores/store";
import type { CanvasNode } from "../types";
import "./director.css";
const DirectorPanel = lazy(() => import("./DirectorPanel").then(module => ({ default: module.DirectorPanel })));

export const DirectorNode = memo(function DirectorNode({ id, data, selected }: NodeProps<CanvasNode>) {
  // Imported project copies retain canvas/node IDs. Their editor, drafts and
  // captured save owner must still be new instances in the destination project.
  const panelKey = useStore(state => JSON.stringify([state.project.id, state.project.activeCanvasId, id]));
  return <div className={"director-node" + (selected ? " is-selected" : "")} tabIndex={-1} onPointerDownCapture={event => {
    selectDirectorNode(id);
    if (!(event.target as HTMLElement).closest("input,textarea,select,[contenteditable],[role=textbox],button,a,video,audio")) event.currentTarget.focus({ preventScroll: true });
  }} onKeyDown={event => {
    if (!["Delete", "Backspace"].includes(event.key)) return;
    event.stopPropagation();
    if (isDirectorDeleteKey(event.nativeEvent)) {
      event.preventDefault();
      deleteDirectorNode(id);
    }
  }}>
    <NodeResizer isVisible={selected} minWidth={640} minHeight={420} lineStyle={{ borderColor: "transparent" }} handleStyle={{ width: 7, height: 7, background: "#4fff8f", border: "none" }} />
    <div className="node-caption"><span><GripHorizontal size={16} /><Clapperboard size={16} />{data.title}</span><span>DIRECTOR<button type="button" className="director-node-delete nodrag nopan" title="删除导演台" aria-label="删除导演台" onClick={event => { event.stopPropagation(); deleteDirectorNode(id); }}><Trash2 size={15} /></button></span></div>
    <Handle type="target" position={Position.Left} />
    <Handle type="source" position={Position.Right} />
    <div className="director-node-body nodrag nopan nowheel" onWheel={event => event.stopPropagation()}>
      <div className="director-inline"><Suspense fallback={<div className="director-loading">正在打开导演台…</div>}><DirectorPanel key={panelKey} nodeId={id} /></Suspense></div>
    </div>
  </div>;
});
