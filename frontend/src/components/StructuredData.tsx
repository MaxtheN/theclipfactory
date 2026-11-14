// Model artifacts are data, never HTML, Markdown, links, or executable content.
// Bound both depth and breadth so a malformed artifact cannot swamp the UI.
export function StructuredData({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value == null) return <span className="unknown">Unknown</span>;
  if (typeof value !== "object") {
    const text = String(value);
    return <span className="artifact-text">{text.slice(0, 2000)}{text.length > 2000 ? "… [truncated]" : ""}</span>;
  }
  if (depth >= 6) return <span className="muted">Nested artifact omitted (depth limit).</span>;
  const entries = Object.entries(value).filter(([key]) => !/^(chain_of_thought|hidden_reasoning|reasoning|analysis_trace)$/i.test(key));
  if (!entries.length) return <span className="muted">No reported entries</span>;
  return <dl className="artifact-data">{entries.slice(0, 40).map(([key, item]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd><StructuredData value={item} depth={depth + 1} /></dd></div>)}{entries.length > 40 && <div>Additional entries omitted (display limit).</div>}</dl>;
}
