/**
 * Layout primitives for the growth app.
 *
 * Spacing belongs to the parent: Stack, Cluster and Grid set the gap between
 * their children and reset child margins, so a screen never needs one-off
 * margins. Panel owns padding, Section owns the heading-to-content rhythm.
 * Every value comes from the spacing tokens in tokens.css.
 *
 * Copy rules that go with these:
 * - A section has a short title, an optional count and at most one line of meta.
 * - Caveats and explanations go in an InfoTip, not in visible paragraphs.
 * - Empty states are one line plus, at most, one action (EmptyLine).
 */
import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";
import "./layout.css";

export type Gap = "xs" | "sm" | "md" | "lg";

type BoxProps = HTMLAttributes<HTMLElement> & {
  as?: ElementType;
  children?: ReactNode;
};

function cx(...names: (string | false | null | undefined)[]) {
  return names.filter(Boolean).join(" ");
}

/** Vertical rhythm: xs 6, sm 12, md 16, lg 32. */
export function Stack({
  as: Tag = "div",
  gap = "md",
  className,
  children,
  ...rest
}: BoxProps & { gap?: Gap }) {
  return (
    <Tag className={cx("gf-ui-stack", className)} data-gap={gap} {...rest}>
      {children}
    </Tag>
  );
}

/** A wrapping row of controls or chips. */
export function Cluster({
  as: Tag = "div",
  gap = "sm",
  justify = "start",
  className,
  children,
  ...rest
}: BoxProps & { gap?: Gap; justify?: "start" | "between" | "end" }) {
  return (
    <Tag
      className={cx("gf-ui-cluster", className)}
      data-gap={gap}
      data-justify={justify}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** Responsive card grid: as many columns of at least `min` px as fit. */
export function Grid({
  as: Tag = "div",
  min = 260,
  className,
  children,
  style,
  ...rest
}: BoxProps & { min?: number }) {
  return (
    <Tag
      className={cx("gf-ui-grid", className)}
      style={{ ...style, ["--gf-ui-grid-min" as string]: `${min}px` }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** A bordered surface. Padding: default 24, compact 16, none. */
export function Panel({
  as: Tag = "div",
  padding = "default",
  tone = "raised",
  className,
  children,
  ...rest
}: BoxProps & {
  padding?: "default" | "compact" | "none";
  tone?: "raised" | "dashed" | "plain";
}) {
  return (
    <Tag
      className={cx("gf-ui-panel", className)}
      data-padding={padding}
      data-tone={tone}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** Small number beside a title. */
export function Count({ children }: { children: ReactNode }) {
  return <span className="gf-ui-count">{children}</span>;
}

/** Explanations and caveats, one click away instead of on the page. */
export function InfoTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details className="gf-ui-infotip">
      <summary aria-label={label} title={label}>
        <Icon name="info" size={14} />
      </summary>
      <div className="gf-ui-infotip-body">{children}</div>
    </details>
  );
}

/** One muted line for "nothing here", with at most one action. */
export function EmptyLine({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="gf-ui-empty-line">
      <span>{children}</span>
      {action}
    </div>
  );
}

/** A one-line status message. */
export function StatusLine({
  tone = "neutral",
  children,
  alert = false,
}: {
  tone?: "neutral" | "running" | "warning" | "danger";
  children: ReactNode;
  alert?: boolean;
}) {
  return (
    <p className="gf-ui-status-line" data-tone={tone} role={alert ? "alert" : "status"}>
      {children}
    </p>
  );
}

/**
 * A titled block: title, optional count and info tip, one line of meta and
 * actions on the right; the body follows at the section-head gap.
 */
export function Section({
  title,
  titleId,
  level = 2,
  count,
  meta,
  info,
  infoLabel,
  actions,
  as: Tag = "section",
  className,
  children,
  ...rest
}: Omit<BoxProps, "title"> & {
  title: ReactNode;
  titleId?: string;
  level?: 2 | 3;
  count?: ReactNode;
  meta?: ReactNode;
  info?: ReactNode;
  infoLabel?: string;
  actions?: ReactNode;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  const hasCount = count !== undefined && count !== null && count !== false;
  return (
    <Tag
      className={cx("gf-ui-section", className)}
      data-level={level}
      aria-labelledby={titleId}
      {...rest}
    >
      <header className="gf-ui-section-head">
        <div className="gf-ui-section-heading">
          <div className="gf-ui-section-title-row">
            <Heading id={titleId} className="gf-ui-section-title">
              {title}
            </Heading>
            {hasCount && <Count>{count}</Count>}
            {info && (
              <InfoTip label={infoLabel ?? "About this section"}>{info}</InfoTip>
            )}
          </div>
          {meta && <p className="gf-ui-section-meta">{meta}</p>}
        </div>
        {actions && <div className="gf-ui-section-actions">{actions}</div>}
      </header>
      {children}
    </Tag>
  );
}

/** A row inside a list: content on the left, one action on the right. */
export function ListRow({
  children,
  action,
  as: Tag = "div",
  className,
  ...rest
}: BoxProps & { action?: ReactNode }) {
  return (
    <Tag className={cx("gf-ui-list-row", className)} {...rest}>
      <div className="gf-ui-list-row-body">{children}</div>
      {action && <div className="gf-ui-list-row-action">{action}</div>}
    </Tag>
  );
}

/** A row of labelled numbers, e.g. a typical post or a run summary. */
export function StatRow({
  items,
  className,
}: {
  items: { label: ReactNode; value: ReactNode; key?: string }[];
  className?: string;
}) {
  return (
    <dl className={cx("gf-ui-stat-row", className)}>
      {items.map((item, i) => (
        <div key={item.key ?? i} className="gf-ui-stat">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
