import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Position, type EdgeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { CanvasFlowSelection, FlowEdge } from "../src/canvas/FlowEdge";
import { flowNodeSelectionKey, isEdgeConnectedToSelection } from "../src/canvas/flow-edge-selection";
import type { CanvasEdge } from "../src/types";

const props: EdgeProps<CanvasEdge> = {
  id: "image-video", source: "image", target: "video", type: "default",
  sourceX: 0, sourceY: 0, targetX: 300, targetY: 80,
  sourcePosition: Position.Right, targetPosition: Position.Left,
  data: { role: "firstFrame", order: 1 },
};
const render = (selected: string[] = [], overrides: Partial<EdgeProps<CanvasEdge>> = {}) => renderToStaticMarkup(
  createElement(CanvasFlowSelection.Provider, { value: new Set(selected) }, createElement(FlowEdge, { ...props, ...overrides })),
);

describe("node selection and connected edge flow", () => {
  it("combines the panel's selected ID with every multi-selected node, excluding stale IDs", () => {
    const nodes = [{ id: "video", selected: true }, { id: "image" }, { id: "audio", selected: true }];
    expect(JSON.parse(flowNodeSelectionKey(nodes, "image"))).toEqual(["audio", "image", "video"]);
    expect(JSON.parse(flowNodeSelectionKey(nodes, "missing"))).toEqual(["audio", "video"]);
    expect(nodes).toEqual([{ id: "video", selected: true }, { id: "image" }, { id: "audio", selected: true }]);
  });

  it("keeps the context key stable across node movement and source-array order changes", () => {
    const nodes = [{ id: "video", selected: true, position: { x: 0, y: 0 } }, { id: "image", selected: true, position: { x: 1, y: 1 } }];
    expect(flowNodeSelectionKey(nodes, null)).toBe(flowNodeSelectionKey([...nodes].reverse().map(node => ({ ...node, position: { x: 500, y: 500 } })), null));
  });

  it("highlights incoming and outgoing direct connections without propagating to the next node", () => {
    const selection = new Set(["video"]);
    expect(isEdgeConnectedToSelection({ source: "image", target: "video" }, selection)).toBe(true);
    expect(isEdgeConnectedToSelection({ source: "video", target: "output" }, selection)).toBe(true);
    expect(isEdgeConnectedToSelection({ source: "output", target: "final" }, selection)).toBe(false);
    expect(isEdgeConnectedToSelection(props, new Set())).toBe(false);
  });

  it("leaves unselected and edge-only selections white, retaining the wide click target", () => {
    const markup = render([], { selected: true, animated: true, style: { stroke: "blue", strokeDasharray: "5 5" } });
    expect(markup).toContain("canvas-flow-edge-base");
    expect(markup).toContain("stroke:var(--canvas-edge-base)");
    expect(markup).toContain("stroke-width:2");
    expect(markup).toContain("stroke-dasharray:none");
    expect(markup).toContain('class="react-flow__edge-interaction"');
    expect(markup).toContain('stroke-width="20"');
    expect(markup).not.toContain("canvas-flow-edge-highlight");
  });

  it.each(["image", "video"])("adds a non-intercepting overlay when endpoint %s is selected and removes it when cleared", selected => {
    const markup = render([selected]);
    expect(markup).toContain("canvas-flow-edge-highlight");
    expect(markup).toContain('pointer-events="none" aria-hidden="true"');
    const paths = markup.match(/\sd="([^"]+)"/g)!;
    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(1);
    expect(render()).not.toContain("canvas-flow-edge-highlight");
    expect(render(["unrelated"])).not.toContain("canvas-flow-edge-highlight");
  });

  it("preserves endpoint markers, labels and configured hit width without changing input-role data", () => {
    const original = structuredClone(props);
    const markup = render(["image"], { markerStart: "url(#start)", markerEnd: "url(#end)", label: "首帧", interactionWidth: 30 });
    expect(markup).toContain('marker-start="url(#start)"');
    expect(markup).toContain('marker-end="url(#end)"');
    expect(markup).toContain("首帧");
    expect(markup).toContain('stroke-width="30"');
    expect(props).toEqual(original);
  });
});
