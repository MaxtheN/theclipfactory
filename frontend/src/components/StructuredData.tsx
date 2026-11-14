import type { ReactNode } from "react";
// Model artifacts are data, never HTML, Markdown, links, or executable content.
// A shared budget bounds the whole tree, not just each branch.
export function StructuredData({ value }: { value: unknown }) {
  const budget = { nodes: 200, characters: 12000 };
  function render(item: unknown, depth = 0): ReactNode {
    if (budget.nodes-- <= 0 || budget.characters <= 0)
      return <span className="muted">Artifact omitted (display limit).</span>;
    if (item == null) return <span className="unknown">Unknown</span>;
    if (typeof item !== "object") {
      const text = String(item);
      const shown = text.slice(0, Math.min(2000, budget.characters));
      budget.characters -= shown.length;
      return (
        <span className="artifact-text">
          {shown}
          {text.length > shown.length ? "… [truncated]" : ""}
        </span>
      );
    }
    if (depth >= 6)
      return (
        <span className="muted">Nested artifact omitted (depth limit).</span>
      );
    const entries = Object.entries(item).filter(
      ([key]) =>
        !/^(chain_of_thought|hidden_reasoning|reasoning|analysis_trace)$/i.test(
          key,
        ),
    );
    if (!entries.length)
      return <span className="muted">No reported entries</span>;
    const children: ReactNode[] = [];
    for (const [key, child] of entries.slice(0, 40)) {
      if (budget.nodes <= 0 || budget.characters <= 0) {
        children.push(
          <div key="display-limit">
            Additional entries omitted (display limit).
          </div>,
        );
        break;
      }
      const label = key.slice(0, 120).replaceAll("_", " ");
      budget.characters -= label.length;
      children.push(
        <div key={key}>
          <dt>{label}</dt>
          <dd>{render(child, depth + 1)}</dd>
        </div>,
      );
    }
    return (
      <dl className="artifact-data">
        {children}
        {entries.length > 40 && (
          <div>Additional entries omitted (display limit).</div>
        )}
      </dl>
    );
  }
  return <>{render(value)}</>;
}
