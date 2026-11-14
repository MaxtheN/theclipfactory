import { endpoint, post } from "../api";
import type { FactoryState } from "../useFactory";
import { Badge, Empty, Section, date, ReadOnlyValue } from "./ui";
export function Jobs({
  state,
  compact = false,
}: {
  state: FactoryState;
  compact?: boolean;
}) {
  const jobs = compact ? state.data.jobs.slice(0, 5) : state.data.jobs;
  return (
    <Section
      title="Production queue"
      detail="Up to 3 parallel model downloads · 1 heavy job · updates every 4 seconds"
    >
      {!jobs.length ? (
        <Empty
          title={
            state.errors.jobs || state.loading
              ? "Queue status unknown"
              : "The queue is clear"
          }
        >
          {state.errors.jobs || state.loading
            ? "Reconnect to the local service to load production jobs. No idle state is assumed."
            : "Upload a source, analyze a moment, or install a model to begin."}
        </Empty>
      ) : (
        <div className="job-list">
          {jobs.map((job) => (
            <article className="job" key={job.id}>
              <div className="row">
                <strong>{job.kind || "Job"}</strong>
                <Badge
                  tone={
                    job.status === "failed"
                      ? "danger"
                      : job.status === "completed"
                        ? "success"
                        : ""
                  }
                >
                  {job.status || "Unknown"}
                </Badge>
              </div>
              <small className="muted">
                {job.lane === "download" ? "Download lane · " : job.lane === "heavy" ? "Heavy lane · " : ""}
                {date(job.created_at)} · {job.id}
              </small>
              {["queued", "running"].includes(job.status) && (
                <>
                  <progress
                    aria-label={`${job.kind} progress`}
                    max="100"
                    value={
                      typeof job.progress === "number" &&
                      Number.isFinite(job.progress)
                        ? Math.min(100, Math.max(0, job.progress))
                        : undefined
                    }
                  />
                  <button
                    className="small secondary"
                    disabled={state.busy}
                    onClick={() =>
                      void state.run(
                        () => post(endpoint("jobs", job.id, "cancel")),
                        "Cancellation requested.",
                      )
                    }
                  >
                    Cancel job
                  </button>
                </>
              )}
              {job.message && <p>{job.message}</p>}
              {job.error && (
                <p className="error-text" role="alert">
                  {job.error}
                </p>
              )}
              {job.result && (
                <details>
                  <summary>Job result</summary>
                  <ReadOnlyValue value={job.result} />
                </details>
              )}
            </article>
          ))}
        </div>
      )}
    </Section>
  );
}
