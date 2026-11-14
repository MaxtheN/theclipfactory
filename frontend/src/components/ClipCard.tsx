import { useEffect, useState } from "react";
import { endpoint, post, put, remove } from "../api";
import { activeJob, jobContextId, sourceHasActiveJob } from "../productionPreflight";
import type { Clip } from "../types";
import type { FactoryState } from "../useFactory";
import { Badge, Field, date, duration } from "./ui";

export type SelfCheck = {
  state: "none" | "passed" | "flagged" | "unavailable";
  label: string;
  findings: string[];
};
/** The factory's own review of a clip, in the words shown on the card. */
export function selfCheck(clip: Clip): SelfCheck {
  const findings = (Array.isArray(clip.team_findings) ? clip.team_findings : [])
    .map((finding: unknown) =>
      finding && typeof finding === "object" && "message" in finding
        ? finding.message
        : null,
    )
    .filter((message): message is string => typeof message === "string" && !!message.trim())
    .slice(0, 8)
    .map((message) => (message.length > 320 ? `${message.slice(0, 320)}…` : message));
  if (!clip.team_run_id || clip.team_review_status === "not_applicable")
    return { state: "none", label: "", findings: [] };
  if (clip.team_review_status === "pass")
    return { state: "passed", label: "Self-check passed", findings: [] };
  if (clip.team_review_status === "fail")
    return {
      state: "flagged",
      label: findings.length
        ? `Self-check flagged ${findings.length} issue${findings.length === 1 ? "" : "s"}`
        : "Self-check flagged issues",
      findings,
    };
  return { state: "unavailable", label: "Self-check unavailable", findings };
}
type Check = { label: string; status: string; detail: string };
function checks(value: unknown): Check[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record.playback_format, record.captions]
    .flatMap((group) => (Array.isArray(group) ? group : []))
    .filter(
      (item): item is Check =>
        !!item &&
        typeof item === "object" &&
        typeof (item as Check).label === "string" &&
        typeof (item as Check).status === "string",
    )
    .filter((item) => item.status !== "not_applicable");
}
function ClipDetails({
  state,
  clip,
  review,
  locked,
}: {
  state: FactoryState;
  clip: Clip;
  review: SelfCheck;
  locked: boolean;
}) {
  const [rating, setRating] = useState("3");
  const [notes, setNotes] = useState("");
  const [coverError, setCoverError] = useState(false);
  const technical = checks(clip.technical_checks);
  const source = state.data.videos.find((video) => video.id === clip.video_id);
  return (
    <details className="clip-more">
      <summary>More</summary>
      <p className="muted">
        From {source?.name ?? "a removed source"}, {duration(clip.start)}–
        {duration(clip.end)}
        {clip.subtitles_burned === true ? " · captions burned in" : ""}
        {clip.published_at ? ` · published ${date(clip.published_at)}` : ""}
      </p>
      {review.state !== "none" && (
        <>
          <button
            className="secondary small"
            disabled={state.busy || locked}
            onClick={() =>
              void state.run(
                () => post(endpoint("clips", clip.id, "team-review"), {}),
                "Self-check started. The result shows on the clip when it finishes.",
              )
            }
          >
            Run the self-check again
          </button>
          {locked && (
            <p className="muted">
              Save your edits and wait for running work on this clip first.
            </p>
          )}
        </>
      )}
      {technical.length > 0 && (
        <>
          <h4>Technical checks</h4>
          <ul className="check-list">
            {technical.map((item) => (
              <li key={`${item.label}-${item.status}`} data-status={item.status}>
                <strong>{item.label}</strong>
                <span>
                  {item.status === "pass" ? "OK" : item.status === "warn" ? "Check" : item.status}
                  {item.detail && item.status !== "pass" ? `: ${item.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>Cover frame</h4>
      {!coverError ? (
        <img
          className="cover-preview"
          src={endpoint("clips", clip.id, "cover")}
          alt={`Cover frame for ${clip.name}`}
          loading="lazy"
          onError={() => setCoverError(true)}
        />
      ) : (
        <p className="muted">No cover frame is available for this clip.</p>
      )}
      <a
        className="button secondary small"
        href={endpoint("clips", clip.id, "cover/download")}
        download
      >
        Download cover
      </a>
      <h4>Your rating</h4>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            await state.run(
              () =>
                post(endpoint("clips", clip.id, "feedback"), {
                  rating: Number(rating),
                  notes,
                }),
              "Rating saved. The factory uses it on later runs.",
            )
          )
            setNotes("");
        }}
      >
        <Field label="Rating">
          <select value={rating} onChange={(event) => setRating(event.target.value)}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option value={n} key={n}>
                {n} / 5
              </option>
            ))}
          </select>
        </Field>
        <Field label="What worked or did not">
          <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        <button className="small secondary" disabled={state.busy}>
          Save rating
        </button>
      </form>
    </details>
  );
}
/** One finished clip: watch it, fix the words, approve or discard. */
export function ClipCard({ state, clip }: { state: FactoryState; clip: Clip }) {
  const [hook, setHook] = useState(clip.hook || "");
  const [caption, setCaption] = useState(clip.caption || "");
  useEffect(() => {
    setHook(clip.hook || "");
    setCaption(clip.caption || "");
  }, [clip.id, clip.hook, clip.caption]);
  const review = selfCheck(clip);
  const burned = clip.hook_rendered === true;
  const dirty = hook !== (clip.hook || "") || caption !== (clip.caption || "");
  const clipBusy = state.data.jobs.some(
    (job) => activeJob(job) && jobContextId(job, "clip_id") === clip.id,
  );
  const locked = dirty || clipBusy || sourceHasActiveJob(state.data.jobs, clip.video_id);
  const needsAcknowledge = review.state === "flagged" || review.state === "unavailable";
  const why = [clip.reason, clip.moment_summary].find(
    (text): text is string => typeof text === "string" && !!text.trim(),
  );
  const title = clip.hook || clip.name || "Untitled clip";
  const length =
    Number.isFinite(clip.start) && Number.isFinite(clip.end)
      ? duration(clip.end - clip.start)
      : null;
  return (
    <article className="clip-tile" aria-label={`Clip: ${title}`}>
      <video
        controls
        preload="metadata"
        poster={endpoint("clips", clip.id, "cover")}
        src={endpoint("clips", clip.id, "media")}
        aria-label={`Preview of ${title}`}
        className="clip-tile-player"
      />
      <div className="clip-tile-body">
        <div className="clip-tile-status">
          {clip.approved ? (
            <Badge tone="success">Approved</Badge>
          ) : (
            <Badge>Needs review</Badge>
          )}
          {review.state !== "none" && (
            <Badge
              tone={
                review.state === "passed" ? "success" : review.state === "flagged" ? "danger" : ""
              }
            >
              {review.label}
            </Badge>
          )}
          {length && <span className="muted">{length}</span>}
        </div>
        {burned ? (
          <>
            <h3>{title}</h3>
            <p className="muted clip-tile-note">
              This hook is burned into the video, so it cannot be edited here.
            </p>
          </>
        ) : (
          <textarea
            className="clip-tile-hook"
            aria-label="Hook"
            placeholder="Add a hook"
            rows={2}
            value={hook}
            onChange={(event) => setHook(event.target.value.replace(/\n/g, " "))}
          />
        )}
        {why && (
          <p className="clip-tile-why">
            <strong>Why this moment</strong> {why}
          </p>
        )}
        {needsAcknowledge && (
          <div className="clip-tile-findings" role="note">
            {review.findings.length ? (
              <ul>
                {review.findings.map((message, index) => (
                  <li key={`${index}-${message}`}>{message}</li>
                ))}
              </ul>
            ) : (
              <p>
                {review.state === "flagged"
                  ? "The self-check found problems. Watch the clip before approving it."
                  : "The self-check could not finish for this clip. Watch it before approving it."}
              </p>
            )}
          </div>
        )}
        {clip.approved && clip.approval_override && (
          <p className="muted clip-tile-note">Approved with open self-check issues.</p>
        )}
        {clip.warning && <p className="muted clip-tile-note">{clip.warning}</p>}
        <Field label="Caption">
          <textarea
            rows={3}
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
          />
        </Field>
        <div className="clip-tile-actions">
          {dirty && (
            <button
              className="small"
              disabled={state.busy || clipBusy}
              onClick={() =>
                void state.run(
                  () =>
                    put(
                      endpoint("clips", clip.id),
                      burned ? { caption } : { hook, caption },
                    ),
                  review.state === "none"
                    ? "Changes saved."
                    : "Changes saved. The self-check no longer covers the new wording.",
                )
              }
            >
              Save changes
            </button>
          )}
          {clip.approved ? (
            <button
              className="secondary small"
              disabled={state.busy || clipBusy}
              onClick={() =>
                void state.run(
                  () => put(endpoint("clips", clip.id), { approved: false }),
                  "Approval removed.",
                )
              }
            >
              Undo approval
            </button>
          ) : (
            <button
              className={dirty ? "secondary small" : "small"}
              disabled={state.busy || clipBusy || dirty}
              onClick={() =>
                void state.run(
                  () =>
                    put(
                      endpoint("clips", clip.id),
                      needsAcknowledge
                        ? { approved: true, acknowledge_findings: true }
                        : { approved: true },
                    ),
                  "Clip approved.",
                )
              }
            >
              {needsAcknowledge ? "Approve anyway" : "Approve"}
            </button>
          )}
          <a
            className="button secondary small"
            href={endpoint("clips", clip.id, "download")}
            download
          >
            Download
          </a>
          <button
            className="danger-button small"
            disabled={state.busy || clipBusy}
            onClick={() => {
              if (window.confirm(`Discard “${title}”? The clip file is deleted.`))
                void state.run(() => remove(endpoint("clips", clip.id)), "Clip discarded.");
            }}
          >
            Discard
          </button>
        </div>
        {dirty && !clip.approved && (
          <p className="muted clip-tile-note">Save your changes before approving.</p>
        )}
        <ClipDetails state={state} clip={clip} review={review} locked={locked} />
      </div>
    </article>
  );
}
