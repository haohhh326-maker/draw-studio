import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FolderCog, ListFilter, Plus } from "lucide-react";
import "./workflow-management.css";

export function WorkflowSettingsMenu({ anchorRef, onAction, onClose, menuRef, placement = "above", align = "start", itemLabel = "工作流" }: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  onAction: (action: "edit" | "manage" | "add") => void;
  onClose: () => void;
  menuRef?: RefObject<HTMLDivElement | null>;
  placement?: "above" | "below";
  align?: "start" | "end";
  itemLabel?: "工作流" | "AI 应用" | "生成类型";
}) {
  const localMenu = useRef<HTMLDivElement>(null), menu = menuRef ?? localMenu, close = useRef(onClose);
  const [position, setPosition] = useState({ left: 16, top: 16, ready: false });
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    const element = menu.current, anchor = anchorRef.current;
    if (!element || !anchor) return;
    const place = () => {
      const trigger = anchor.getBoundingClientRect(), rect = element.getBoundingClientRect();
      const above = trigger.top - rect.height - 8, below = trigger.bottom + 8,
        maxTop = Math.max(16, window.innerHeight - rect.height - 16),
        preferredTop = placement === "below" ? below <= maxTop ? below : above : above >= 16 ? above : below;
      const left = Math.max(16, Math.min(align === "end" ? trigger.right - rect.width : trigger.left, window.innerWidth - rect.width - 16)),
        top = Math.max(16, Math.min(preferredTop, maxTop));
      setPosition(previous => previous.ready && previous.left === left && previous.top === top ? previous : { left, top, ready: true });
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(element); observer.observe(anchor);
    const movement = new MutationObserver(place), container = anchor.closest(".directory-popover, .generation-floating, .generation-anchor");
    if (container) movement.observe(container, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); movement.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchorRef, menu, placement, align]);
  useLayoutEffect(() => {
    // The first portal commit is hidden until its measured position is applied.
    if (position.ready) menu.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [position.ready, menu]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !anchorRef.current?.contains(event.target)) close.current(); };
    document.addEventListener("pointerdown", outside, true);
    return () => { document.removeEventListener("pointerdown", outside, true); if (anchorRef.current?.isConnected) anchorRef.current.focus({ preventScroll: true }); };
  }, [anchorRef, menu]);
  return createPortal(<div ref={menu} role="menu" aria-label={itemLabel + "设置"} className="workflow-settings-menu nodrag nopan nowheel"
    style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      // Canvas shortcuts must not cancel the selected node while this menu owns focus.
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      else if (event.key === "Tab") close.current();
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        if (!buttons.length) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    }}>
    <button role="menuitem" onClick={() => onAction("edit")}><ListFilter size={16} />编辑</button>
    <button role="menuitem" onClick={() => onAction("manage")}><FolderCog size={16} />管理{itemLabel}</button>
    <button role="menuitem" onClick={() => onAction("add")}><Plus size={16} />添加{itemLabel}</button>
  </div>, document.body);
}
