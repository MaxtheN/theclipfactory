import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, post } from "../api";
import type { TeamRun, Video } from "../types";
import { Badge, Field, Section, Unknown, date } from "./ui";
import { StructuredData } from "./StructuredData";
const active = (status: string) => ["queued", "running"].includes(status);
export const runPath = (id: string) =>
  `/api/team/runs/${encodeURIComponent(id)}`;
export function validRuns(value: unknown): value is TeamRun[] {
  return (
    Array.isArray(value) &&
    value.every(
      (r) =>
        r &&
        typeof r.id === "string" &&
        typeof r.video_id === "string" &&
        ["team", "baseline", "swarm"].includes(r.mode) &&
        typeof r.status === "string" &&
        typeof r.model_id === "string" &&
        typeof r.objective === "string" &&
        (r.stop_reason == null || typeof r.stop_reason === "string") &&
        Array.isArray(r.tasks) &&
        r.tasks.every((t: unknown) => {
          if (!t || typeof t !== "object") return false;
          const task = t as Record<string, unknown>;
          return (
            ["id", "role", "label", "status"].every(
              (key) => typeof task[key] === "string",
            ) &&
            ["agent", "tool"].includes(task.kind as string) &&
            Array.isArray(task.input_refs) &&
            task.input_refs.every((ref) => typeof ref === "string") &&
            (task.error == null || typeof task.error === "string")
          );
        }),
    )
  );
}
export function TeamLedger({
  videos,
  sourceId,
  refreshToken = 0,
}: {
  videos: Video[];
  sourceId?: string;
  refreshToken?: number;
}) {
  const [runs, setRuns] = useState<TeamRun[] | null>(null);
  const [filter, setFilter] = useState(sourceId ?? "");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const [requested, setRequested] = useState<string[]>([]);
  const mounted = useRef(false);
  const inflight = useRef(false);
  const cancelLocks = useRef(new Set<string>());
  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const result = await api<unknown>("/api/team/runs");
      if (!validRuns(result))
        throw new Error("Invalid team ledger response from local service.");
      if (mounted.current) {
        setRuns(result);
        setError("");
      }
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof ApiError && e.status === 404
            ? "Team ledger route unavailable. Update the local service to enable team mode."
            : e instanceof Error
              ? e.message
              : "Ledger unavailable.",
        );
    } finally {
      inflight.current = false;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    if (mounted.current) void load();
  }, [refreshToken, load]);
  useEffect(() => {
    setFilter(sourceId ?? "");
    setSelected("");
  }, [sourceId]);
  const filtered = (runs ?? []).filter((r) => !filter || r.video_id === filter);
  const run = filtered.find((r) => r.id === selected) ?? filtered[0];
  async function cancel(run: TeamRun) {
    if (error || !active(run.status) || cancelLocks.current.has(run.id)) return;
    cancelLocks.current.add(run.id);
    setPending((ids) => [...ids, run.id]);
    setNotice("");
    try {
      const updated = await post<TeamRun>(`${runPath(run.id)}/cancel`);
      if (
        !validRuns([updated]) ||
        updated.id !== run.id ||
        updated.video_id !== run.video_id
      )
        throw new Error(
          "Invalid cancellation response. Reload to check run status before retrying.",
        );
      if (mounted.current) {
        setRuns((old) =>
          (old ?? []).map((r) => (r.id === updated.id ? updated : r)),
        );
        setRequested((ids) => [...ids, run.id]);
        setNotice(
          "Cancellation requested. Active work may finish before cancellation becomes final; completed local outputs are preserved.",
        );
      }
    } catch (e) {
      cancelLocks.current.delete(run.id);
      if (mounted.current)
        setNotice(
          `Cancellation request failed: ${e instanceof Error ? e.message : "Retry after reloading."}`,
        );
    } finally {
      if (mounted.current)
        setPending((ids) => ids.filter((id) => id !== run.id));
      await load();
    }
  }
  return (
    <Section
      title="Team ledger"
      detail="Inspectable artifacts and evidence — no hidden reasoning"
      action={
        <button className="secondary small" onClick={() => void load()}>
          Reload ledger
        </button>
      }
    >
      <p className="muted">
        One heavy worker serializes local model calls and rendering; roles do
        not imply parallel GPU inference. No publish or spend tools. Every
        output needs human review. Restarted work may be interrupted, not
        silently resumed.
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}{" "}
          {runs
            ? "Last loaded ledger is stale; cancellation is disabled until refreshed."
            : "No ledger data loaded."}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <Field label="Ledger source filter">
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setSelected("");
          }}
        >
          <option value="">All sources</option>
          {Array.from(
            new Set([
              ...videos.map((v) => v.id),
              ...(runs ?? []).map((r) => r.video_id),
            ]),
          ).map((id) => (
            <option key={id} value={id}>
              {videos.find((v) => v.id === id)?.name ?? id}
            </option>
          ))}
        </select>
      </Field>
      {!runs && !error && <p role="status">Loading team ledger…</p>}
      {runs && !filtered.length && (
        <p className="muted">No runs reported for this source.</p>
      )}
      {run && (
        <>
          <Field label="Ledger run">
            <select
              value={run.id}
              onChange={(e) => setSelected(e.target.value)}
            >
              {filtered.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.mode} · {r.status} · {r.id}
                </option>
              ))}
            </select>
          </Field>
          <div className="row">
            <h3>{run.mode} run</h3>
            <Badge>{run.status}</Badge>
          </div>
          <p>
            Model: {run.model_id || "Unknown"} · Objective:{" "}
            {run.objective || "Unknown"}
          </p>
          <p>
            Revisions: {run.revision_count ?? "Unknown"} /{" "}
            {run.revision_budget ?? "Unknown"} · Stop reason:{" "}
            {run.stop_reason || "Not reported"}
          </p>
          <p className="muted">
            Created: {date(run.created_at)} · Started: {date(run.started_at)} ·
            Finished: {date(run.finished_at)} · Elapsed:{" "}
            <Unknown value={run.elapsed_seconds} suffix=" s" />
          </p>
          <p className="muted">
            needs_review means local production finished, not approved or
            published. Unknown/failed critic checks block approval; a model pass
            is not human approval.
          </p>
          <button
            className="secondary small"
            disabled={
              !!error ||
              !active(run.status) ||
              pending.includes(run.id) ||
              requested.includes(run.id)
            }
            onClick={() => void cancel(run)}
          >
            {pending.includes(run.id)
              ? "Requesting cancellation…"
              : requested.includes(run.id) && active(run.status)
                ? "Cancellation requested"
                : "Cancel run"}
          </button>
          <details>
            <summary>Plan</summary>
            <StructuredData value={run.plan} />
          </details>
          <details>
            <summary>Source/config context snapshot</summary>
            <StructuredData value={run.context} />
          </details>
          <details>
            <summary>Model / memory resource observations</summary>
            <StructuredData value={run.resource_observations} />
          </details>
          <details>
            <summary>Clip lineage and permissions</summary>
            <StructuredData
              value={{ clip_ids: run.clip_ids, permissions: run.permissions }}
            />
          </details>
          <h3>Tasks and revisions</h3>
          {!run.tasks.length && <p className="muted">No tasks reported yet.</p>}
          {run.tasks.slice(0, 100).map((task) => (
            <article className="ledger-task" key={task.id}>
              <div className="row">
                <h4>{task.label || task.role}</h4>
                <Badge>{task.status}</Badge>
              </div>
              <p>
                {task.role} · {task.kind} · Iteration{" "}
                {task.iteration ?? "Unknown"}
              </p>
              <p className="muted">
                Started: {date(task.started_at)} · Finished:{" "}
                {date(task.finished_at)}
              </p>
              <details>
                <summary>Input references</summary>
                <StructuredData value={task.input_refs} />
              </details>
              {task.error && (
                <p role="alert" className="error-text">
                  {task.error}
                </p>
              )}
              {task.role === "critic" && (
                <div className="render-warning">
                  <strong>
                    Critic checks and findings (fail/unknown are unresolved)
                  </strong>
                  <StructuredData value={task.output} />
                </div>
              )}
              {task.role !== "critic" && (
                <details>
                  <summary>Structured output</summary>
                  <StructuredData value={task.output} />
                </details>
              )}
            </article>
          ))}
          {run.tasks.length > 100 && (
            <p>Additional tasks omitted (display limit).</p>
          )}
        </>
      )}
    </Section>
  );
}
