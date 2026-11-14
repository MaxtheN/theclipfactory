import { useEffect, useState } from "react";
import { endpoint, post, put, remove } from "../api";
import type { Clip } from "../types";
import type { FactoryState } from "../useFactory";
import { Badge, Field, duration } from "./ui";
import { StructuredData } from "./StructuredData";
export function ClipReview({
  state,
  clip,
}: {
  state: FactoryState;
  clip: Clip;
}) {
  const reviewBlocked = !!clip.team_run_id && clip.team_review_status !== "pass";
  const [caption, setCaption] = useState(clip.caption || "");
  const [hook, setHook] = useState(clip.hook || "");
  const [rating, setRating] = useState("3");
  const [notes, setNotes] = useState("");
  const [coverError, setCoverError] = useState(false);
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
        {clip.team_run_id && <div className="render-warning">
          <p>Team run: {clip.team_run_id} · Critic review: {clip.team_review_status ?? "unknown"}</p>
          {reviewBlocked && <p role="alert">Unresolved critic warnings: failed or unknown review prevents approval. Review the ledger’s checks, evidence and revisions.</p>}
          <details><summary>Team critic findings</summary><StructuredData value={clip.team_findings} /></details>
          <p className="muted">A critic pass is not human approval. Revision history is in the Factory team ledger.</p>
        </div>}
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
        <Field label="Clip hook">
          <input value={hook} onChange={(e) => setHook(e.target.value)} />
        </Field>
        <Field label="Clip caption">
          <textarea
            rows={3}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />
        </Field>
        <div className="actions">
          <button
            className="secondary small"
            disabled={state.busy}
            onClick={() =>
              void state.run(
                () => put(endpoint("clips", clip.id), { hook, caption }),
                "Clip edits saved.",
              )
            }
          >
            Save edits
          </button>
          <button
            className="small"
            disabled={state.busy || (!clip.approved && reviewBlocked)}
            onClick={() => {
              if (!clip.approved && reviewBlocked) return;
              void state.run(
                () =>
                  put(endpoint("clips", clip.id), {
                    hook,
                    caption,
                    approved: !clip.approved,
                  }),
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
              <textarea
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
