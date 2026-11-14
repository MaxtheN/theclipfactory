import { useId, type ReactNode } from "react";
import { Icon } from "./Icon";
import { reviewPreview } from "./workspaceApi";
export function PrimaryAction({
  label,
  disabled,
  onClick,
  full = false,
  intent = "advance",
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  full?: boolean;
  intent?: "advance" | "direction" | "approve" | "produce" | "iterate";
}) {
  const icon = {
    advance: "send",
    direction: "arrow",
    approve: "check",
    produce: "play",
    iterate: "refresh",
  }[intent];
  return (
    <button
      type="button"
      className={`gf-button gf-primary-action${full ? " full" : ""}`}
      data-intent={intent}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="gf-action-text">{label}</span>
      <span className="gf-action-icon" aria-hidden="true">
        <Icon name={icon} size={17} />
      </span>
    </button>
  );
}
export function FieldGroup({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={`gf-field-group ${className}`}>
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: (id: string) => ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="gf-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <small>{hint}</small>}
    </div>
  );
}
export function Pill({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`gf-pill ${tone}`}>{children}</span>;
}
export function Disclosure({
  title,
  children,
  icon = "info",
  open = false,
}: {
  title: string;
  children: ReactNode;
  icon?: string;
  open?: boolean;
}) {
  return (
    <details className="gf-disclosure" open={open || undefined}>
      <summary>
        <Icon name={icon} />
        {title}
        <Icon name="down" size={15} />
      </summary>
      <div className="gf-disclosure-body">{children}</div>
    </details>
  );
}
export function Poster({
  compact = false,
  variant = 0,
}: {
  compact?: boolean;
  variant?: number;
}) {
  return (
    <div
      className={`gf-podcast-art ${compact ? "compact" : ""} variant-${variant}`}
      aria-label="Illustrative All-In source artwork"
    >
      <div className="gf-art-orbit" />
      <div className="gf-art-dot" />
      <span className="gf-art-label">THE CONVERSATION</span>
      <strong>
        ALL<span>—</span>IN<span className="gf-art-period">.</span>
      </strong>
      <div className="gf-wave" aria-hidden="true">
        {Array.from({ length: 30 }, (_, i) => (
          <i
            key={i}
            style={{ height: `${12 + Math.abs(Math.sin(i * 1.4)) * 38}px` }}
          />
        ))}
      </div>
      <span className="gf-art-footer">
        {compact ? "EXAMPLE SOURCE" : "A DIFFERENT PERSPECTIVE"}
      </span>
    </div>
  );
}
export function PreviewNote() {
  return reviewPreview ? (
    <span className="gf-small-note">
      <Icon name="info" size={13} />
      Illustrative content · no footage rendered
    </span>
  ) : null;
}
export function Empty({
  title,
  children,
  icon = "folder",
}: {
  title: string;
  children: ReactNode;
  icon?: string;
}) {
  return (
    <div className="gf-empty">
      <span>
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function formatTime(n: number | undefined | null) {
  if (n == null || !Number.isFinite(n)) return "Duration unknown";
  return `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
}
