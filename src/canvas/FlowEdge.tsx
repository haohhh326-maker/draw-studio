import { createContext, memo, useContext } from "react";
import { BaseEdge, getBezierPath, getSimpleBezierPath, getSmoothStepPath, getStraightPath, type EdgeProps } from "@xyflow/react";
import type { CanvasEdge } from "../types";
import { isEdgeConnectedToSelection } from "./flow-edge-selection";
import "./flow-edge.css";

export const CanvasFlowSelection = createContext<ReadonlySet<string>>(new Set());

/** Selection only changes this overlay; the stored edge and its input role stay intact. */
export const FlowEdge = memo(function FlowEdge(props: EdgeProps<CanvasEdge>) {
  const selectedNodes = useContext(CanvasFlowSelection);
  const flowing = isEdgeConnectedToSelection(props, selectedNodes);
  const geometry = {
    sourceX: props.sourceX, sourceY: props.sourceY, sourcePosition: props.sourcePosition,
    targetX: props.targetX, targetY: props.targetY, targetPosition: props.targetPosition,
  };
  const [path, labelX, labelY] = props.type === "straight" ? getStraightPath(geometry)
    : props.type === "step" || props.type === "smoothstep" ? getSmoothStepPath({ ...geometry,
      borderRadius: props.type === "step" ? 0 : props.pathOptions?.borderRadius,
      offset: props.pathOptions?.offset, stepPosition: props.pathOptions?.stepPosition,
    })
    : props.type === "simplebezier" ? getSimpleBezierPath(geometry)
    : getBezierPath({ ...geometry, curvature: props.pathOptions?.curvature });
  return <>
    <BaseEdge id={props.id} path={path} className="canvas-flow-edge-base"
      style={{ ...props.style, stroke: "var(--canvas-edge-base)", strokeWidth: 2, strokeDasharray: "none", strokeDashoffset: 0, animation: "none" }}
      interactionWidth={props.interactionWidth} markerStart={props.markerStart} markerEnd={props.markerEnd}
      labelX={labelX} labelY={labelY} label={props.label} labelStyle={props.labelStyle}
      labelShowBg={props.labelShowBg} labelBgStyle={props.labelBgStyle}
      labelBgPadding={props.labelBgPadding} labelBgBorderRadius={props.labelBgBorderRadius} />
    {flowing && <path d={path} fill="none" className="canvas-flow-edge-highlight" pointerEvents="none" aria-hidden="true" />}
  </>;
});
