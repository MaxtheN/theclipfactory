import { AutoTextarea } from "./AutoTextarea";
import { useEffect, useRef, useState } from "react";
import { endpoint, post, put, remove } from "../api";
import type { Clip, Job } from "../types";
import type { FactoryState } from "../useFactory";
import { Badge, Field, duration } from "./ui";
import { StructuredData } from "./StructuredData";
import {
  activeJob,
  jobContextId,
  sourceHasActiveJob,
} from "../productionPreflight";
export function ClipReview({
  state,
  clip,
}: {
  state: FactoryState;
  clip: Clip;
}) {
  const teamReviewed =
    !!clip.team_run_id && clip.team_review_status !== "not_applicable";
  const [caption, setCaption] = useState(clip.caption || "");
  const [hook, setHook] = useState(clip.hook || "");
  const [rating, setRating] = useState("3");
  const [notes, setNotes] = useState("");
  const [coverError, setCoverError] = useState(false);
  const [recheckJob, setRecheckJob] = useState<Job | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState("");
  const recheckLock = useRef(false);
  const dirty = hook !== (clip.hook || "") || caption !== (clip.caption || "");
  const currentReviewJob =
    state.data.jobs.find((job) => job.id === recheckJob?.id) ?? recheckJob;
  const sourceBusy = sourceHasActiveJob(state.data.jobs, clip.video_id);
  const clipBusy = state.data.jobs.some(
    (job) => activeJob(job) && jobContextId(job, "clip_id") === clip.id,
  );
  const reviewActive =
    rechecking || (currentReviewJob != null && activeJob(currentReviewJob));
  useEffect(() => {
    setRecheckJob(null);
    setRecheckError("");
  }, [clip.id]);
  const reviewStale =
    state.loading || !!state.errors.clips || !!state.errors.jobs;
  const reviewBlocked =
    teamReviewed &&
    (clip.team_review_status !== "pass" ||
      dirty ||
      reviewActive ||
      clipBusy ||
      sourceBusy ||
      reviewStale);
  const recheckReady =
    teamReviewed &&
    !dirty &&
    !reviewActive &&
    !sourceBusy &&
    !clipBusy &&
    !reviewStale &&
    !state.errors.system &&
    !state.errors.models &&
    !state.errors.videos &&
    state.data.system?.model_runtime === true;
  async function recheck() {
    if (!recheckReady || recheckLock.current) return;
    recheckLock.current = true;
    setRechecking(true);
    setRecheckError("");
    try {
      await state.run(async () => {
        try {
          const job = await post<Job>(
            endpoint("clips", clip.id, "team-review"),
            {},
          );
          if (
            !job ||
            typeof job.id !== "string" ||
            typeof job.status !== "string"
          )
            throw new Error(
              "Invalid critique job response. Refresh the queue to check whether the request was accepted.",
            );
          setRecheckJob(job);
        } catch (e) {
          setRecheckError(
            e instanceof Error ? e.message : "Critique request failed.",
          );
          throw e;
        }
      }, "Team critique recheck queued for saved content using the run model. No verdict or approval is implied; inspect job progress and refreshed critic findings.");
    } finally {
      recheckLock.current = false;
      setRechecking(false);
    }
  }
  useEffect(() => {
    setCaption(clip.caption || "");
    setHook(clip.hook || "");
  }, [clip.id, clip.caption, clip.hook]);
  return (
    <article className="clip-card">
      <video
        controls
        preload="metadata"
        src={endpoint("clips", clip.id, "media")}
        aria-label={`Clip preview ${clip.name}`}
        className="clip-player"
      />
      <div className="clip-content">
        <div className="row">
          <h3>{clip.name}</h3>
          <Badge tone={clip.approved ? "success" : ""}>
            {clip.approved ? "Approved" : "Needs review"}
          </Badge>
        </div>
        <p className="muted">
          {duration(clip.start)} — {duration(clip.end)} ·{" "}
          {clip.objective || "Unknown objective"} ·{" "}
          {clip.status || "Unknown status"}
        </p>
        {clip.warning && (
          <p className="render-warning" role="alert">
            Render warning: {clip.warning}
          </p>
        )}
        <p className="muted">
          Subtitles burned in:{" "}
          {clip.subtitles_burned === true
            ? "Yes"
            : clip.subtitles_burned === false
              ? "No"
              : "Unknown"}
        </p>
        {clip.team_run_id && (
          <div className="render-warning">
            <p>
              Team run: {clip.team_run_id} · Critic review:{" "}
              {clip.team_review_status ?? "unknown"}
            </p>
            {teamReviewed && clip.team_review_status !== "pass" && (
              <p role="alert">
                Unresolved critic warnings: failed or unknown review prevents
                approval here. Review the ledger’s checks, evidence and
                revisions, or approve it anyway from the Clips page.
              </p>
            )}
            {teamReviewed && dirty && (
              <p role="alert">
                Hook or caption differs from the reviewed content. Save edits,
                then recheck team critique before approval.
              </p>
            )}
            {clip.team_review_status === "not_applicable" && (
              <p className="muted">
                Baseline output: team critique is not applicable. Human approval
                is still required.
              </p>
            )}
            {teamReviewed && (
              <>
                <button
                  className="secondary small"
                  disabled={state.busy || !recheckReady}
                  onClick={() => void recheck()}
                >
                  {rechecking
                    ? "Requesting critique…"
                    : "Recheck team critique"}
                </button>
                <p className="muted">
                  Recheck runs one explicit critic on saved clip content using
                  the run model. Backend verifies model installation and ledger
                  eligibility; there is no automatic pass or approval.
                </p>
                {dirty && (
                  <p className="muted">
                    Save edits before requesting a recheck.
                  </p>
                )}
                {!recheckReady && !dirty && (
                  <p className="muted">
                    Recheck requires a ready local runtime, fresh
                    source/model/clip/queue data and no active task for this
                    source or clip. Backend also requires a finished, cancelled
                    or interrupted ledger.
                  </p>
                )}
                {recheckError && (
                  <p role="alert" className="error-text">
                    {recheckError}
                  </p>
                )}
                {currentReviewJob && (
                  <div role="status">
                    <p>
                      Critique job: {currentReviewJob.status} ·{" "}
                      {currentReviewJob.id}
                    </p>
                    {activeJob(currentReviewJob) && (
                      <progress
                        aria-label="Team critique progress"
                        max="100"
                        value={
                          typeof currentReviewJob.progress === "number" &&
                          Number.isFinite(currentReviewJob.progress)
                            ? Math.min(
                                100,
                                Math.max(0, currentReviewJob.progress),
                              )
                            : undefined
                        }
                      />
                    )}
                    {currentReviewJob.message && (
                      <p>{currentReviewJob.message}</p>
                    )}
                    {currentReviewJob.error && (
                      <p role="alert" className="error-text">
                        {currentReviewJob.error}
                      </p>
                    )}
                    <p>
                      Only refreshed critic findings determine review status.
                      Every clip still needs human approval.
                    </p>
                  </div>
                )}
              </>
            )}
            <details>
              <summary>Team critic findings</summary>
              <StructuredData value={clip.team_findings} />
            </details>
            <p className="muted">
              A critic pass is not human approval. Revision history is in the
              Studio team ledger.
            </p>
          </div>
        )}
        {clip.publish_attempt && (
          <p className="muted">
            Publish attempt recorded: {clip.publish_attempt}. Reconcile with
            Meta before retrying.
          </p>
        )}
        <details>
          <summary>Cover frame</summary>
          <p className="muted">
            A frame from the rendered clip. No invented text overlays.
          </p>
          {!coverError ? (
            <img
              className="cover-preview"
              src={endpoint("clips", clip.id, "cover")}
              alt={`Cover frame for ${clip.name}`}
              loading="lazy"
              onError={() => setCoverError(true)}
            />
          ) : (
            <p role="alert" className="error-text">
              Cover unavailable. The backend did not provide a cover image.
            </p>
          )}
          <a
            className="button secondary small"
            href={endpoint("clips", clip.id, "cover/download")}
            download
          >
            Download cover
          </a>
        </details>
        <Field
          label="Clip hook"
          hint={
            clip.hook_rendered
              ? "Burned into this video. Render a new campaign output to change it; the original stays unchanged."
              : undefined
          }
        >
          <AutoTextarea
            rows={1}
            value={hook}
            disabled={clip.hook_rendered === true}
            onChange={(e) => setHook(e.target.value)}
          />
        </Field>
        <Field label="Clip caption">
          <AutoTextarea
            rows={3}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />
        </Field>
        <div className="actions">
          <button
            className="secondary small"
            disabled={state.busy || clipBusy || reviewActive}
            onClick={() =>
              void state.run(
                () => put(endpoint("clips", clip.id), { hook, caption }),
                teamReviewed
                  ? "Clip edits saved. Changed content invalidates team critique; recheck before approval."
                  : "Clip edits saved.",
              )
            }
          >
            Save edits
          </button>
          <button
            className="small"
            disabled={
              state.busy || clipBusy || (!clip.approved && reviewBlocked)
            }
            onClick={() => {
              if (!clip.approved && reviewBlocked) return;
              void state.run(
                () =>
                  put(
                    endpoint("clips", clip.id),
                    clip.approved
                      ? { approved: false }
                      : teamReviewed
                        ? { approved: true }
                        : { hook, caption, approved: true },
                  ),
                clip.approved
                  ? "Approval removed."
                  : "Clip approved. Publishing still requires explicit setup.",
              );
            }}
          >
            {clip.approved ? "Remove approval" : "Approve clip"}
          </button>
          <a
            className="button secondary small"
            href={endpoint("clips", clip.id, "download")}
            download
          >
            Download
          </a>
          <button
            className="danger-button small"
            disabled={state.busy}
            onClick={() => {
              if (window.confirm(`Permanently delete “${clip.name}”?`))
                void state.run(
                  () => remove(endpoint("clips", clip.id)),
                  "Clip deleted.",
                );
            }}
          >
            Delete
          </button>
        </div>
        <details>
          <summary>Creator feedback</summary>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await state.run(
                  () =>
                    post(endpoint("clips", clip.id, "feedback"), {
                      rating: Number(rating),
                      notes,
                    }),
                  "Creator feedback recorded.",
                )
              )
                setNotes("");
            }}
          >
            <Field label="Clip rating">
              <select
                value={rating}
                onChange={(e) => setRating(e.target.value)}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option value={n} key={n}>
                    {n} / 5
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Feedback notes">
              <AutoTextarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
            <button className="small secondary" disabled={state.busy}>
              Record feedback
            </button>
          </form>
        </details>
        {clip.published_at && (
          <p className="muted">Published: {clip.published_at}</p>
        )}
      </div>
    </article>
  );
}
