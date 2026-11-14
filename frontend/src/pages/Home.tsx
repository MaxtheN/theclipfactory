import { useRef, useState } from "react";
import { endpoint, localMediaUrl, patch, post } from "../api";
import { ClipCard } from "../components/ClipCard";
import { Dropzone } from "../components/Dropzone";
import { Storyboard } from "../components/Storyboard";
import { Badge, Section, duration } from "../components/ui";
import { isTab, type Tab } from "../navigation";
import type { Clip, FactorySource, FactoryStage } from "../types";
import type { FactoryState } from "../useFactory";

const REVIEW_LIMIT = 6;
const stageWords: Record<FactoryStage["status"], string> = {
  done: "done",
  active: "in progress",
  pending: "not started",
  skipped: "skipped",
  failed: "failed",
};
export function newestFirst(clips: Clip[]) {
  return [...clips].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}
export function Autopilot({ state }: { state: FactoryState }) {
  const settings = state.data.settings;
  const on = settings?.autonomy === "auto";
  return (
    <div className="autopilot">
      <button
        role="switch"
        aria-checked={on}
        aria-label="Autopilot"
        className={`switch ${on ? "on" : ""}`}
        disabled={state.busy || !settings || !!state.errors.settings}
        onClick={() =>
          void state.run(
            () => patch("/api/settings", { autonomy: on ? "review" : "auto" }),
            on
              ? "Autopilot is off. Press Make clips on each video."
              : "Autopilot is on. New footage starts on its own.",
          )
        }
      >
        <span aria-hidden="true" />
      </button>
      <div>
        <strong>Autopilot {settings ? (on ? "on" : "off") : "unknown"}</strong>
        <small>
          {on
            ? "New footage starts on its own."
            : "You start each video with Make clips."}
        </small>
      </div>
    </div>
  );
}
function Stages({ source }: { source: FactorySource }) {
  const stages = Array.isArray(source.stages) ? source.stages : [];
  const current = stages.find((stage) => stage.status === "failed" || stage.status === "active");
  if (!stages.length) return null;
  return (
    <>
      <ol className="stage-track" aria-label={`Progress for ${source.name}`}>
        {stages.map((stage) => (
          <li
            key={stage.key}
            data-status={stage.status}
            aria-current={stage.status === "active" ? "step" : undefined}
          >
            <span className="stage-dot" aria-hidden="true" />
            <span className="stage-label">{stage.label}</span>
            <span className="visually-hidden">, {stageWords[stage.status] ?? stage.status}</span>
          </li>
        ))}
      </ol>
      {current?.detail && (
        <p className={current.status === "failed" ? "stage-detail error-text" : "stage-detail"}>
          {current.detail}
        </p>
      )}
    </>
  );
}
function SourceCard({
  state,
  source,
  onReview,
}: {
  state: FactoryState;
  source: FactorySource;
  onReview: (videoId: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const thumbnail = localMediaUrl(source.thumbnail);
  const working = source.state === "queued" || source.state === "working";
  const stopped = source.state === "failed" || source.state === "cancelled";
  const produce = (notice: string) =>
    void state.run(() => post(endpoint("videos", source.video_id, "produce"), {}), notice);
  const made = Array.isArray(source.clip_ids) ? source.clip_ids.length : 0;
  const toReview = source.unreviewed > 0 ? source.unreviewed : made;
  return (
    <article className="line-card" data-state={source.state} aria-label={source.name}>
      {thumbnail ? (
        <img className="line-thumb" src={thumbnail} alt="" loading="lazy" />
      ) : (
        <span className="line-thumb placeholder" aria-hidden="true">
          ▷
        </span>
      )}
      <div className="line-main">
        <div className="line-head">
          <h3>{source.name}</h3>
          <span className="muted">{duration(source.duration)}</span>
          {source.approved > 0 && <Badge tone="success">{source.approved} approved</Badge>}
        </div>
        <Stages source={source} />
        {source.headline && <p className="line-headline">{source.headline}</p>}
        {working && typeof source.progress === "number" && (
          <progress
            aria-label={`${source.name} progress`}
            max={100}
            value={Math.min(100, Math.max(0, source.progress))}
          />
        )}
        {stopped && (
          <p className="error-text" role="alert">
            {source.error ||
              (source.state === "cancelled"
                ? "Stopped before it finished."
                : "Something went wrong before any clip was made.")}
          </p>
        )}
        {source.state === "idle" && !source.can_produce && source.blocked_reason && (
          <p className="muted">{source.blocked_reason}</p>
        )}
        {source.storyboard && (
          <details
            className="line-saw"
            onToggle={(event) => {
              if (event.currentTarget.open) setOpened(true);
            }}
          >
            <summary>
              What the factory saw · {source.storyboard.scenes} scene
              {source.storyboard.scenes === 1 ? "" : "s"}
            </summary>
            {opened && (
              <Storyboard videoId={source.video_id} version={source.storyboard.updated_at} />
            )}
          </details>
        )}
      </div>
      <div className="line-action">
        {source.state === "idle" && (
          <button
            disabled={state.busy || !source.can_produce}
            onClick={() => produce("Started. Clips show up below when they are ready.")}
          >
            Make clips
          </button>
        )}
        {working && (
          <button
            className="secondary"
            disabled={state.busy || !source.job_id}
            onClick={() =>
              void state.run(
                () => post(endpoint("jobs", source.job_id!, "cancel")),
                "Stopping. Clips that already finished are kept.",
              )
            }
          >
            Cancel
          </button>
        )}
        {source.state === "needs_review" && (
          <button onClick={() => onReview(source.video_id)}>
            {toReview > 0
              ? `Review ${toReview} clip${toReview === 1 ? "" : "s"}`
              : "Review clips"}
          </button>
        )}
        {stopped && (
          <button
            disabled={state.busy || !source.can_produce}
            onClick={() => produce("Trying again.")}
          >
            Try again
          </button>
        )}
        {source.state === "done" && (
          <button
            className="secondary"
            disabled={state.busy || !source.can_produce}
            onClick={() => produce("Started. New clips show up below when they are ready.")}
          >
            Make more clips
          </button>
        )}
      </div>
    </article>
  );
}
/** The factory floor: add footage, watch it work, review what comes out. */
export function Home({
  state,
  navigate,
}: {
  state: FactoryState;
  navigate: (tab: Tab) => void;
}) {
  const [reviewSource, setReviewSource] = useState("");
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const factory = state.data.factory;
  const sources = Array.isArray(factory?.sources) ? factory.sources : [];
  const blockers = Array.isArray(factory?.blockers) ? factory.blockers : [];
  const autopilot = state.data.settings?.autonomy === "auto";
  const waiting = newestFirst(state.data.clips.filter((clip) => !clip.approved));
  const shown = waiting.filter((clip) => !reviewSource || clip.video_id === reviewSource);
  const filtered = sources.find((source) => source.video_id === reviewSource);
  const model = state.data.models.find((item) => item.id === factory?.model_id);
  const review = (videoId: string) => {
    setReviewSource(videoId);
    reviewHeading.current?.focus();
    reviewHeading.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
  return (
    <>
      <Dropzone
        state={state}
        title="Drop footage. Get clips."
        autopilot={autopilot}
        aside={<Autopilot state={state} />}
      >
        The factory watches and listens to the whole video, picks the best
        moments, and cuts vertical clips for you to approve.
      </Dropzone>
      {factory && !factory.ready && (
        <div className="banner readiness" role="status">
          <strong>The factory is not ready yet</strong>
          <ul>
            {blockers.map((blocker) => (
              <li key={blocker.code}>
                {blocker.message}{" "}
                {isTab(blocker.tab) && (
                  <button
                    className="secondary small"
                    onClick={() => navigate(blocker.tab as Tab)}
                  >
                    Open {blocker.tab}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {factory?.ready && (
        <p className="muted readiness-line">
          Ready. Using {model?.name || factory.model_id || "the default model"}.
        </p>
      )}
      {!factory && !state.loading && (
        <p className="muted readiness-line">
          The factory status is unavailable right now. Use Refresh to try again.
        </p>
      )}
      {!sources.length ? (
        factory && (
          <ol className="steps" aria-label="How it works">
            <li>
              <strong>Add footage</strong>
              <span>Long videos, raw phone clips, anything with good moments in it.</span>
            </li>
            <li>
              <strong>The factory works</strong>
              <span>It watches, listens, picks the moments and edits them.</span>
            </li>
            <li>
              <strong>You approve</strong>
              <span>Keep the clips you like. Download or publish them.</span>
            </li>
          </ol>
        )
      ) : (
        <section className="line" aria-label="Production line">
          <h2>Production line</h2>
          {sources.map((source) => (
            <SourceCard key={source.video_id} state={state} source={source} onReview={review} />
          ))}
        </section>
      )}
      {(waiting.length > 0 || sources.length > 0) && (
        <Section
          title="Ready for review"
          detail={
            waiting.length
              ? `${waiting.length} clip${waiting.length === 1 ? "" : "s"} waiting for you`
              : "Nothing is waiting"
          }
          action={
            waiting.length > 0 ? (
              <button className="secondary small" onClick={() => navigate("Clips")}>
                See all in Clips
              </button>
            ) : undefined
          }
        >
          <h3 ref={reviewHeading} tabIndex={-1} className="visually-hidden">
            Clips to review
          </h3>
          {reviewSource && (
            <p className="review-filter">
              Showing clips from {filtered?.name ?? "one video"}.{" "}
              <button className="text-button" onClick={() => setReviewSource("")}>
                Show all
              </button>
            </p>
          )}
          {!shown.length ? (
            <p className="muted">
              {reviewSource
                ? "No clips from this video are waiting."
                : "Finished clips land here."}
            </p>
          ) : (
            <div className="clip-tiles">
              {shown.slice(0, REVIEW_LIMIT).map((clip) => (
                <ClipCard key={clip.id} state={state} clip={clip} />
              ))}
            </div>
          )}
          {shown.length > REVIEW_LIMIT && (
            <p className="muted">
              Showing {REVIEW_LIMIT} of {shown.length}.{" "}
              <button className="text-button" onClick={() => navigate("Clips")}>
                See all in Clips
              </button>
            </p>
          )}
        </Section>
      )}
    </>
  );
}
