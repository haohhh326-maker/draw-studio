import type { PropsWithChildren } from "react";
import icon from "../../build/desktop/icon-source.png";
import "./desktop-frame.css";

export function DesktopFrame({ children, customTitleBar = false }: PropsWithChildren<{ customTitleBar?: boolean }>) {
  if (!customTitleBar) return children;
  return <div className="desktop-frame">
    <header className="desktop-titlebar" aria-label="Draw studio 标题栏">
      <img src={icon} alt="" width={18} height={18} draggable={false} />
      <span>Draw studio</span>
    </header>
    <div className="desktop-frame-content">{children}</div>
  </div>;
}
