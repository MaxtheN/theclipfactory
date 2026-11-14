import { useRef, useState } from "react";
import { endpoint, put } from "../api";
import { newestFirst } from "../pages/Home";
import { clipMediaUrl } from "./productionApi";
import type { Clip } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import type { FactoryState } from "../useFactory";
import { reviewPreview } from "./workspaceApi";
import { Icon } from "./Icon";
import { Pill, formatTime } from "./parts";
import type { OpenProduction } from "./FactoryHome";
import { SourceDetails, sourceLabel } from "./sourcePresentation";

export function Library({
  w,
  factory,
  onReview,
  onProduce,
  onFactory,
}: {
  w: Workspace;
  factory: FactoryState;
  onReview: (clip: Clip) => void;
  onProduce: OpenProduction;
  onFactory: () => void;
}) {
  const [tab, setTab] = useState<"edits" | "wall" | "footage">("edits");
  const [query, setQuery] = useState("");
  const ids = w.campaign?.video_ids || [];
  const sources = factory.data.videos.filter((v) => ids.includes(v.id));
  const clips = factory.data.clips.filter(
    (c) =>
      c.campaign_id === w.campaign?.id &&
      c.profile_id === w.profileId &&
      ids.includes(c.video_id),
  );
  const normalized = query.trim().toLocaleLowerCase();
  const edits = clips.filter((c) =>
    `${c.name} ${c.hook} ${sourceLabel(c.video_id, ids)} ${sources.find((s) => s.id === c.video_id)?.name || ""}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
  const footage = sources.filter((v) =>
    `${sourceLabel(v.id, ids)} ${v.name}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
  return (
    <section className="gf-library" aria-label="Library">
      <div className="gf-library-toolbar">
        <div className="gf-library-tabs" role="group" aria-label="Library view">
          <button
            type="button"
            aria-pressed={tab === "edits"}
            onClick={() => setTab("edits")}
          >
            Clips<span>{clips.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={tab === "wall"}
            onClick={() => setTab("wall")}
          >
            Review wall<span>{clips.filter((c) => !c.approved).length}</span>
          </button>
          <button
            type="button"
            aria-pressed={tab === "footage"}
            onClick={() => setTab("footage")}
          >
            Episodes<span>{sources.length}</span>
          </button>
        </div>
        <label className="gf-library-filter">
          <Icon name="research" size={16} />
          <input
            type="search"
            aria-label="Filter library"
            placeholder="Filter by name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {tab === "wall" ? (
        <div className="gf-review-wall">
          <ReviewWall
            factory={factory}
            clips={clips}
            sourceIds={ids}
            onReview={onReview}
            onFactory={onFactory}
          />
        </div>
      ) : tab === "edits" ? (
        <>
          {edits.length ? (
            <div className="gf-library-edits">
              {edits.map((clip) => (
                <button
                  type="button"
                  className="gf-library-edit"
                  key={clip.id}
                  onClick={() => onReview(clip)}
                  aria-label={`Review ${clip.name}`}
                >
                  <span className="gf-library-edit-art">
                    <Icon name="play" size={24} />
                    <small>
                      {reviewPreview ||
                      clip.provenance_mode === "preview_fixture"
                        ? "Illustrative edit"
                        : formatTime(clip.end - clip.start)}
                    </small>
                  </span>
                  <span className="gf-library-edit-copy">
                    <strong>{clip.name}</strong>
                    <span>{clip.hook || "Clip"}</span>
                    <small>
                      {formatTime(clip.start)}–{formatTime(clip.end)} ·{" "}
                      {sourceLabel(clip.video_id, ids)}
                    </small>
                  </span>
                  <Pill tone={clip.approved ? "approved" : ""}>
                    {clip.approved ? "Approved" : "Needs review"}
                  </Pill>
                  <Icon name="arrow" size={16} />
                </button>
              ))}
            </div>
          ) : (
            <div className="gf-flow-empty">
              <Icon name="studio" size={26} />
              <h2>
                {normalized ? "No matching clips" : "No clips yet"}
              </h2>
              <p>
                {normalized
                  ? "Try a different name or opening."
                  : "Add an episode in Factory to get your first clips."}
              </p>
              {!normalized && (
                <button
                  type="button"
                  className="gf-button secondary"
                  onClick={onFactory}
                >
                  Go to Factory
                  <Icon name="arrow" size={15} />
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          {footage.length ? (
            <div className="gf-episode-grid">
              {footage.map((source) => {
                const made = clips.filter((c) => c.video_id === source.id);
                const waiting = made.filter((c) => !c.approved).length;
                return (
                  <article className="gf-episode-card" key={source.id}>
                    <div className="gf-episode-thumb">
                      {reviewPreview ? (
                        <span className="gf-wall-placeholder">
                          <Icon name="headphones" size={28} />
                        </span>
                      ) : (
                        <video
                          muted
                          playsInline
                          preload="metadata"
                          src={`${endpoint("videos", source.id, "media")}#t=8`}
                          aria-hidden="true"
                          tabIndex={-1}
                        />
                      )}
                      <span className="gf-wall-duration">
                        {reviewPreview ? "Illustrative" : formatTime(source.duration)}
                      </span>
                    </div>
                    <div className="gf-episode-body">
                      <div className="gf-episode-title">
                        <strong>{sourceLabel(source.id, ids)}</strong>
                        <Pill
                          tone={
                            waiting
                              ? "sand"
                              : made.length
                                ? "mint"
                                : "quiet"
                          }
                        >
                          {waiting
                            ? `${waiting} to review`
                            : made.length
                              ? "All reviewed"
                              : "No clips yet"}
                        </Pill>
                      </div>
                      <p className="gf-episode-meta">
                        <span className="gf-num">
                          {made.length} clip{made.length === 1 ? "" : "s"}
                        </span>
                        {source.has_audio === true && source.transcript == null
                          ? " · Transcript not available"
                          : ""}
                      </p>
                      <div className="gf-episode-actions">
                        <SourceDetails source={source} />
                        <button
                          type="button"
                          className="gf-button secondary compact"
                          disabled={w.busy || w.loading}
                          onClick={() => onProduce(source.id, "agent")}
                        >
                          Find clips
                          <Icon name="arrow" size={14} />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="gf-flow-empty">
              <Icon name="folder" size={26} />
              <h2>
                {normalized
                  ? "No matching episodes"
                  : "No episodes yet"}
              </h2>
              <p>
                {normalized
                  ? "Try another name."
                  : "Add an episode in Factory."}
              </p>
              {!normalized && (
                <button
                  type="button"
                  className="gf-button secondary"
                  onClick={onFactory}
                >
                  Go to Factory
                  <Icon name="arrow" size={15} />
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

type WallFilter = "Needs review" | "Approved" | "Posted" | "All";
const wallFilters: WallFilter[] = ["Needs review", "Approved", "Posted", "All"];
const posted = (c: Clip) => !!(c.published_at || c.instagram_media_id);
function clipStatus(c: Clip) {
  if (posted(c)) return { label: "Posted", tone: "gf-status-posted" };
  if (c.approved) return { label: "Approved", tone: "gf-status-approved" };
  if (c.rank?.below_bar) return { label: "Below the bar", tone: "gf-status-below" };
  return { label: "Needs review", tone: "gf-status-review" };
}
const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Vertical 9:16 cards: poster frame, score, hook and status. Hover previews muted; click opens review. */
function ReviewWall({
  factory,
  clips,
  sourceIds,
  onReview,
  onFactory,
}: {
  factory: FactoryState;
  clips: Clip[];
  sourceIds: string[];
  onReview: (clip: Clip) => void;
  onFactory: () => void;
}) {
  const [filter, setFilter] = useState<WallFilter>("Needs review");
  const [hypothesis, setHypothesis] = useState("");
  const hypotheses = [
    ...new Set(clips.map((c) => c.hypothesis).filter((h): h is string => !!h)),
  ].sort();
  const scoped = newestFirst(clips).filter(
    (c) => !hypothesis || c.hypothesis === hypothesis,
  );
  const matches = (c: Clip, f: WallFilter) =>
    f === "All"
      ? true
      : f === "Posted"
        ? posted(c)
        : f === "Approved"
          ? c.approved && !posted(c)
          : !c.approved;
  const shown = scoped.filter((c) => matches(c, filter));
  // Bulk approval only covers clips whose self-check passed and that cleared the bar; the rest need a person.
  const approvable = shown.filter(
    (c) =>
      !c.approved &&
      !c.rank?.below_bar &&
      (!c.team_run_id ||
        c.team_review_status === "not_applicable" ||
        c.team_review_status === "pass"),
  );
  if (!clips.length)
    return (
      <div className="gf-flow-empty">
        <Icon name="studio" size={26} />
        <h2>Nothing to review yet</h2>
        <p>Add an episode in Factory and new clips land here.</p>
        <button type="button" className="gf-button secondary" onClick={onFactory}>
          Go to Factory
          <Icon name="arrow" size={15} />
        </button>
      </div>
    );
  return (
    <>
      <div className="gf-wall-toolbar" role="group" aria-label="Filter clips">
        {wallFilters.map((name) => (
          <button
            type="button"
            key={name}
            className="gf-wall-filter"
            aria-pressed={filter === name}
            onClick={() => setFilter(name)}
          >
            {name}
            <span>{scoped.filter((c) => matches(c, name)).length}</span>
          </button>
        ))}
        {hypotheses.length > 1 && (
          <select
            aria-label="Filter by hypothesis"
            value={hypothesis}
            onChange={(e) => setHypothesis(e.target.value)}
          >
            <option value="">All hypotheses</option>
            {hypotheses.map((name) => (
              <option key={name} value={name}>
                {name.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        )}
        <span className="gf-wall-spacer" />
        {approvable.length > 1 && (
          <button
            type="button"
            className="gf-button secondary compact"
            disabled={factory.busy}
            onClick={() =>
              void factory.run(async () => {
                for (const clip of approvable)
                  await put(endpoint("clips", clip.id), { approved: true });
              }, `${approvable.length} clips approved.`)
            }
          >
            <Icon name="check" size={14} />
            Approve all {approvable.length} shown
          </button>
        )}
      </div>
      {shown.length ? (
        <div className="gf-wall-grid">
          {shown.map((clip) => (
            <WallCard
              key={clip.id}
              clip={clip}
              source={sourceLabel(clip.video_id, sourceIds)}
              onReview={() => onReview(clip)}
            />
          ))}
        </div>
      ) : (
        <div className="gf-flow-empty">
          <Icon name="check" size={26} />
          <h2>
            {filter === "Needs review"
              ? "You're all caught up"
              : `Nothing ${filter === "All" ? "here" : filter.toLowerCase()} yet`}
          </h2>
          <p>
            {filter === "Needs review"
              ? "Every clip here has been reviewed."
              : "Clips show up here as you review and post them."}
          </p>
          <button
            type="button"
            className="gf-button secondary"
            onClick={() => setFilter("All")}
          >
            Show all clips
          </button>
        </div>
      )}
    </>
  );
}

function WallCard({
  clip,
  source,
  onReview,
}: {
  clip: Clip;
  source: string;
  onReview: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const status = clipStatus(clip);
  const illustrative =
    reviewPreview || clip.provenance_mode === "preview_fixture";
  const score = clip.rank?.score;
  function preview(on: boolean) {
    const v = video.current;
    if (!v) return;
    try {
      if (on && !reducedMotion()) void v.play()?.catch(() => undefined);
      else {
        v.pause();
        v.currentTime = 0.5;
      }
    } catch {
      /* media is optional; the card still opens review */
    }
  }
  return (
    <button
      type="button"
      className="gf-wall-card"
      aria-label={`Review ${clip.name}`}
      onClick={onReview}
      onMouseEnter={() => preview(true)}
      onMouseLeave={() => preview(false)}
      onFocus={() => preview(true)}
      onBlur={() => preview(false)}
    >
      <span className="gf-wall-media">
        {illustrative ? (
          <span className="gf-wall-placeholder">
            <Icon name="play" size={26} />
          </span>
        ) : (
          <video
            ref={video}
            muted
            loop
            playsInline
            preload="metadata"
            src={`${clipMediaUrl(clip.id)}#t=0.5`}
            aria-hidden="true"
            tabIndex={-1}
          />
        )}
        <span className="gf-wall-chips">
          {typeof score === "number" ? (
            <span className="gf-pill gf-wall-score" title="Agent score out of 100">
              {Math.round(score)}
            </span>
          ) : (
            <span />
          )}
          <span className={`gf-pill ${status.tone}`}>{status.label}</span>
        </span>
        <span className="gf-wall-duration">
          {illustrative ? "Illustrative" : formatTime(clip.end - clip.start)}
        </span>
      </span>
      <span className="gf-wall-copy">
        <strong>{clip.hook || clip.name}</strong>
        <small>
          {clip.name} · {source}
        </small>
      </span>
    </button>
  );
}
