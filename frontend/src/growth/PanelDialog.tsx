import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";
import "./panel-dialog.css";

/** A controlled native modal. Children stay mounted so closing never discards a draft. */
export function PanelDialog({ open, onClose, title, description, children, size = "default" }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  size?: "default" | "wide";
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const id = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    } else if (!open && element.open) {
      element.close();
      if (opener.current?.isConnected) opener.current.focus();
      opener.current = null;
    }
  }, [open]);
  useEffect(() => () => {
    if (opener.current?.isConnected) opener.current.focus();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`gf-panel-dialog${size === "wide" ? " gf-panel-dialog-wide" : ""}`}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      <header className="gf-panel-dialog-heading">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {description && <p id={`${id}-description`}>{description}</p>}
        </div>
        <button type="button" className="gf-panel-dialog-close" aria-label={`Close ${title}`} onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="gf-panel-dialog-body">{children}</div>
    </dialog>
  );
}
