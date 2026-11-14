import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { TeamComparison, TeamRun } from "../types";
import { Section, Unknown } from "./ui";
import { StructuredData } from "./StructuredData";
import { runPath, validRuns } from "./TeamLedger";
export function TeamComparisons({ videoId }: { videoId: string }) {
  const [data, setData] = useState<TeamComparison | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, unknown>>({});
  const [snapshotErrors, setSnapshotErrors] = useState<Record<string, string>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function load() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await api<TeamComparison>(
        `/api/team/comparisons?video_id=${encodeURIComponent(videoId)}`,
      );
      if (
        !result ||
        result.video_id !== videoId ||
        !Array.isArray(result.runs) ||
        result.runs.some(
          (r) =>
            !r ||
            ["id", "mode", "status", "model_id", "objective"].some(
              (key) =>
                typeof (r as unknown as Record<string, unknown>)[key] !==
                "string",
            ),
        ) ||
        !Array.isArray(result.notes) ||
        result.notes.some((n) => typeof n !== "string")
      )
        throw new Error("Invalid comparison response from local service.");
      // Summaries have no source/config snapshot: inspect each durable run explicitly.
      const entries = await Promise.all(
        result.runs.map(async (r) => {
          try {
            const run = await api<unknown>(runPath(r.id));
            if (
              !validRuns([run]) ||
              (run as TeamRun).id !== r.id ||
              (run as TeamRun).video_id !== videoId
            )
              throw new Error("Invalid or mismatched run snapshot.");
            return { id: r.id, context: (run as TeamRun).context };
          } catch (e) {
            return {
              id: r.id,
              error: e instanceof Error ? e.message : "Snapshot unavailable.",
            };
          }
        }),
      );
      if (alive.current) {
        setData(result);
        setError("");
        setSnapshots(
          Object.fromEntries(
            entries.filter((e) => !e.error).map((e) => [e.id, e.context]),
          ),
        );
        setSnapshotErrors(
          Object.fromEntries(
            entries.filter((e) => e.error).map((e) => [e.id, e.error!]),
          ),
        );
      }
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof ApiError && e.status === 404
            ? "Comparison route unavailable. Update the local service."
            : e instanceof Error
              ? e.message
              : "Comparisons unavailable.",
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Section
      title="Team / baseline comparison"
      detail="Matching snapshots and observed results, not a performance-lift claim"
    >
      <p className="muted">
        Comparability is reported by the backend. Unknown timings, memory and
        metrics stay unknown. Observations and creator feedback do not establish
        causation, success or ROI.
      </p>
      <button
        className="secondary small"
        disabled={busy}
        onClick={() => void load()}
      >
        {busy ? "Loading comparisons…" : "Load comparisons"}
      </button>
      {error && (
        <p role="alert" className="error-text">
          {error}{" "}
          {data ? "Last loaded comparison is stale." : "No comparison loaded."}
        </p>
      )}
      {!data && !busy && !error && (
        <p className="muted">
          Load this source’s recorded comparisons explicitly.
        </p>
      )}
      {data && (
        <>
          <p>Comparison source: {data.video_id}</p>
          <StructuredData value={data.notes} />
          {!data.runs.length && <p>No comparison runs reported.</p>}
          {data.runs.map((r) => (
            <article className="ledger-task" key={r.id}>
              <h3>
                {r.mode} · {r.status}
              </h3>
              <p>
                Run: {r.id} · Model: {r.model_id || "Unknown"} · Objective:{" "}
                {r.objective || "Unknown"}
              </p>
              <p>
                Comparable:{" "}
                {r.comparable === true
                  ? "Yes"
                  : r.comparable === false
                    ? "No — snapshots do not match"
                    : "Unknown"}{" "}
                · Elapsed: <Unknown value={r.elapsed_seconds} suffix=" s" />
              </p>
              <details open>
                <summary>Source/config snapshot</summary>
                {snapshotErrors[r.id] ? (
                  <p className="error-text">
                    Snapshot unavailable: {snapshotErrors[r.id]}. Comparability
                    cannot be independently inspected.
                  </p>
                ) : (
                  <StructuredData value={snapshots[r.id]} />
                )}
              </details>
              <details>
                <summary>
                  Model / memory snapshots and resource observations
                </summary>
                <StructuredData value={r.resource_observations} />
              </details>
              <details>
                <summary>Observed outcomes (unknown is not zero)</summary>
                <StructuredData value={r.outcomes} />
              </details>
              <details>
                <summary>Creator feedback</summary>
                <StructuredData value={r.feedback} />
              </details>
              <details>
                <summary>Clip references</summary>
                <StructuredData value={r.clip_ids} />
              </details>
            </article>
          ))}
        </>
      )}
    </Section>
  );
}
