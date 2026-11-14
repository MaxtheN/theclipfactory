import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Icon } from "./Icon";
import "./journey-progress.css";

export function JourneyProgress({
  state,
  step,
  title,
  message,
  source,
  progress,
  receipts = [],
  actions,
  children,
  label = "Production journey",
  current = true,
}: {
  state:
    | "uploading"
    | "attaching"
    | "refreshing"
    | "ready"
    | "working"
    | "review"
    | "error"
    | "uncertain";
  step: 0 | 1 | 2;
  title: string;
  message: string;
  source?: string;
  progress?: number | null;
  receipts?: string[];
  actions?: ReactNode;
  children?: ReactNode;
  label?: string;
  /** false: steps before `step` are complete and none is in progress (idle, waiting on the creator). */
  current?: boolean;
}) {
  const pending = ["uploading", "attaching", "refreshing", "working"].includes(
    state,
  );
  const measured = typeof progress === "number" && Number.isFinite(progress);
  return (
    <section
      className="gf-production-journey"
      data-state={state}
      aria-label={label}
    >
      <ol
        className="gf-production-journey-steps"
        aria-label="Production stages"
      >
        {["Add footage", "Produce edits", "Review"].map((name, index) => (
          <li
            key={name}
            className={
              index < step
                ? "is-complete"
                : index === step && current
                  ? "is-current"
                  : ""
            }
            aria-current={index === step && current ? "step" : undefined}
          >
            <span className="gf-production-journey-marker" aria-hidden="true">
              {index < step ? <Check size={12} /> : index + 1}
            </span>
            <span className="gf-production-journey-step-label">{name}</span>
          </li>
        ))}
      </ol>
      <div className="gf-production-journey-status">
        <span className="gf-production-journey-symbol" aria-hidden="true">
          <Icon
            name={
              state === "error" || state === "uncertain"
                ? "info"
                : state === "review"
                  ? "play"
                  : state === "ready"
                    ? "check"
                    : "studio"
            }
            size={23}
          />
        </span>
        <div className="gf-production-journey-copy" role="status">
          {source && (
            <span className="gf-production-journey-source">{source}</span>
          )}
          <h3 className="gf-production-journey-heading">{title}</h3>
          <p>{message}</p>
        </div>
      </div>
      {pending && (
        <progress
          className="gf-production-journey-progress"
          aria-label={`${label} progress`}
          aria-valuetext={message}
          max={100}
          value={measured ? Math.max(0, Math.min(100, progress)) : undefined}
        />
      )}
      {!!receipts.length && (
        <ul className="gf-production-journey-receipts">
          {receipts.map((receipt) => (
            <li key={receipt}>
              <Check size={12} aria-hidden="true" />
              {receipt}
            </li>
          ))}
        </ul>
      )}
      {children}
      {actions && (
        <div className="gf-production-journey-actions">{actions}</div>
      )}
    </section>
  );
}
