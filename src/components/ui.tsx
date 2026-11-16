import type { ReactNode, ButtonHTMLAttributes } from "react";
import { X } from "lucide-react";
export function IconButton({
  title,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className ? `icon-button ${className}` : "icon-button"}
      title={title}
      aria-label={title}
      {...props}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={"modal " + (wide ? "wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <div>
            <span className="eyebrow">Draw studio / WORKSPACE</span>
            <h2>{title}</h2>
          </div>
          <IconButton title="关闭" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}
