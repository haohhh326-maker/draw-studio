import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "../components/ui";

/** A compact editor attached to the generating node's settings button. */
export function GenerationSettingsPopover({ anchorRef, onClose, children }: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null), close = useRef(onClose);
  const restoreFocus = useRef(false);
  const [position, setPosition] = useState({ left: 16, top: 16, ready: false });
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);

  useLayoutEffect(() => {
    const element = panel.current, anchor = anchorRef.current;
    if (!element || !anchor) return;
    const place = () => {
      const trigger = anchor.getBoundingClientRect(), rect = element.getBoundingClientRect();
      const margin = 16, gap = 8;
      const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
      const above = trigger.top - rect.height - gap, below = trigger.bottom + gap;
      const preferredTop = above >= margin ? above : below <= maxTop ? below : above;
      const left = Math.max(margin, Math.min(trigger.right - rect.width, maxLeft));
      const top = Math.max(margin, Math.min(preferredTop, maxTop));
      setPosition(previous => previous.ready && previous.left === left && previous.top === top
        ? previous : { left, top, ready: true });
    };
    place();
    const frame = requestAnimationFrame(place);
    const resize = new ResizeObserver(place);
    resize.observe(element);
    resize.observe(anchor);
    const container = anchor.closest(".generation-floating, .generation-anchor");
    const movement = new MutationObserver(place);
    if (container) {
      resize.observe(container);
      movement.observe(container, { attributes: true, attributeFilter: ["style"] });
    }
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect(); movement.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (position.ready) panel.current?.focus({ preventScroll: true });
  }, [position.ready]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || panel.current?.contains(target) || anchorRef.current?.contains(target)) return;
      // ParameterSelect portals its listbox to body. Only this editor's owned
      // listboxes count as inside; an unrelated menu must still dismiss it.
      const controls = panel.current?.querySelectorAll<HTMLElement>('[role="combobox"][aria-controls]') ?? [];
      for (const control of controls) {
        const ids = control.getAttribute("aria-controls")?.trim().split(/\s+/) ?? [];
        if (ids.some(id => document.getElementById(id)?.contains(target))) return;
      }
      close.current();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      const anchor = anchorRef.current;
      if (restoreFocus.current && anchor?.isConnected) {
        const trigger = anchor instanceof HTMLButtonElement ? anchor : anchor.querySelector<HTMLButtonElement>("button");
        trigger?.focus({ preventScroll: true });
      }
    };
  }, [anchorRef]);

  const dismiss = () => { restoreFocus.current = true; close.current(); };
  return createPortal(<div ref={panel} role="dialog" aria-label="生成设置" tabIndex={-1}
    className="generation-settings-popover nodrag nopan nowheel"
    style={{ position: "fixed", left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onWheel={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      // A nested listbox handles Escape before it can reach this editor.
      if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) { event.preventDefault(); dismiss(); }
    }}>
    <header><strong>生成设置</strong><IconButton title="关闭生成设置" onClick={dismiss}><X size={15} /></IconButton></header>
    {children}
  </div>, document.body);
}
