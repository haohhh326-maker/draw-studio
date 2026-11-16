import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useInternalNode, useReactFlow, useViewport } from "@xyflow/react";
import { useOptimizationPanel } from "../prompt-optimization/settings-panel-state";

type Attachment = {
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  offsetX: number;
  offsetY: number;
};

/** Keep the opening placement attached to the node instead of reclamping on every pan. */
export function GenerationContainer({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const viewport = useViewport();
  const settingsOpen = useOptimizationPanel(state => state.open);
  const node = useInternalNode(nodeId);
  const { getInternalNode, flowToScreenPosition } = useReactFlow();
  const panel = useRef<HTMLDivElement>(null);
  const attachment = useRef<Attachment | null>(null);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const follow = () => {
      const anchor = getInternalNode(nodeId);
      const nodeWidth = anchor?.measured.width, nodeHeight = anchor?.measured.height;
      // New nodes open before React Flow has measured their actual dimensions.
      // Wait for that measurement so their first layout isn't mistaken for a pan.
      if (!anchor || !nodeWidth || !nodeHeight) return;
      const point = flowToScreenPosition({
        x: anchor.internals.positionAbsolute.x + nodeWidth / 2,
        y: anchor.internals.positionAbsolute.y + nodeHeight,
      });
      const width = element.offsetWidth, height = element.offsetHeight;
      const dock = settingsOpen && window.innerWidth >= 1000 ? document.querySelector(".optimization-settings")?.getBoundingClientRect() : undefined;
      const viewportWidth = dock?.left ?? window.innerWidth, viewportHeight = window.innerHeight;
      const centerX = point.x, anchorTop = point.y + 24;
      let current = attachment.current;
      if (!current || current.width !== width || current.height !== height ||
        current.viewportWidth !== viewportWidth || current.viewportHeight !== viewportHeight) {
        const margin = 16;
        const minTop = Math.max(margin, (document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0) + margin);
        const left = Math.max(margin, Math.min(centerX - width / 2, Math.max(margin, viewportWidth - width - margin)));
        const top = Math.max(minTop, Math.min(anchorTop, Math.max(minTop, viewportHeight - height - margin)));
        current = { width, height, viewportWidth, viewportHeight, offsetX: left - centerX, offsetY: top - anchorTop };
        attachment.current = current;
      }
      // A pan or node drag moves both surfaces by the same amount. Only opening,
      // panel resizing and window resizing choose a new on-screen placement.
      element.style.left = centerX + current.offsetX + "px";
      element.style.top = anchorTop + current.offsetY + "px";
      element.style.visibility = "visible";
    };
    follow();
    const frame = requestAnimationFrame(follow);
    const resize = new ResizeObserver(follow);
    resize.observe(element);
    window.addEventListener("resize", follow);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener("resize", follow);
    };
  }, [nodeId, node?.internals.positionAbsolute.x, node?.internals.positionAbsolute.y,
    node?.measured.width, node?.measured.height, getInternalNode, flowToScreenPosition,
    viewport.x, viewport.y, viewport.zoom, settingsOpen]);

  return createPortal(<div ref={panel} className="generation-floating generation-clamped"
      style={{ position: "fixed", left: 16, top: 16, zIndex: 900, visibility: "hidden" }}>
      {children}
    </div>, document.body);
}
