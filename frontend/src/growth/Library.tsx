import { useRef, useState } from "react";
import { endpoint, post, put } from "../api";
import { clipMediaUrl } from "./productionApi";
import type { Clip } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import type { FactoryState } from "../useFactory";
import { reviewPreview } from "./workspaceApi";
import { Icon } from "./Icon";
import { Pill, formatTime } from "./parts";
import type { LibraryView, OpenProduction } from "./FactoryHome";
import { SourceDetails, sourceLabel } from "./sourcePresentation";
import { ClipPreview, QuickLook } from "./ClipPreview";
import { newestFirst, undirected } from "./productionState";
import { deleteEpisode, discardClips } from "./storage";
import { SpeechlessChip } from "./SpeechSetup";
import { sourceHasActiveJob } from "../productionPreflight";

export function Library({
  w,
  factory,
  onReview,
  onProduce,
  onFactory,
  view,
  onView,
}: {
  w: Workspace;
  factory: FactoryState;
  onReview: (clip: Clip) => void;
  onProduce: OpenProduction;
  onFactory: () => void;
  /** The open tab, when the shell drives it (another screen can open the wall directly). */
  view?: LibraryView;
  onView?: (view: LibraryView) => void;
}) {
  const [own, setOwn] = useState<LibraryView>("edits");
  const tab = view ?? own;
  const setTab = (next: LibraryView) => {
    setOwn(next);
    onView?.(next);
  };
  const [query, setQuery] = useState("");
  const ids = w.campaign?.video_ids || [];
  const sources = factory.data.videos.filter((v) => ids.includes(v.id));
  const clips = factory.data.clips.filter(
    (c) =>
      c.campaign_id === w.campaign?.id &&
      c.profile_id === w.profileId &&
      ids.includes(c.video_id),
  );
  // Made from this footage by the engine with no direction: reviewed on the wall, not in the Studio.
  const loose = factory.data.clips.filter((c) => undirected(c, ids));
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
  // Freeing space: deleting is the one thing here that cannot be undone, so each path asks first
  // and says exactly what went and what the local service kept.
  const [clearing, setClearing] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string }>();
  const locked = clearing || w.busy || w.loading || factory.busy || factory.loading || !!factory.errors.videos || !!factory.errors.jobs || reviewPreview;
  async function clear(task: () => Promise<{ ok: boolean; text: string }>) {
    if (locked) return;
    setClearing(true);
    setOutcome(undefined);
    try {
      setOutcome(await task());
    } catch (e) {
      setOutcome({
        ok: false,
        text: e instanceof Error ? e.message : "Nothing was deleted.",
      });
    } finally {
      // The brand's own list changes when footage goes, so it is read again with the clips.
      await Promise.all([
        factory.refresh(["clips", "videos", "factory"]),
        w.campaign ? w.load(w.campaign.id).catch(() => undefined) : undefined,
      ]);
      setClearing(false);
    }
  }
  const count = (n: number) => `${n} clip${n === 1 ? "" : "s"}`;
  function discard(targets: Clip[]) {
    if (!targets.length) return;
    const one = targets.length === 1 ? targets[0] : undefined;
    const question = one
      ? `Discard “${one.hook || one.name}”? The clip file is deleted from this Mac.`
      : `Discard ${count(targets.length)} that were not approved? Their files are deleted from this Mac. This cannot be undone.`;
    if (!window.confirm(question)) return;
    void clear(async () => {
      const result = await discardClips(targets);
      return result.kept
        ? {
            ok: false,
            text: `${count(result.discarded)} discarded. ${result.kept} kept: ${result.reason}`,
          }
        : { ok: true, text: `${count(result.discarded)} discarded.` };
    });
  }
  function deleteSource(sourceId: string) {
    if (locked || sourceHasActiveJob(factory.data.jobs, sourceId)) return;
    const label = sourceLabel(sourceId, ids);
    // Everything made from the file goes with it, whichever brand or run made it.
    const made = factory.data.clips.filter((c) => c.video_id === sourceId);
    const approved = made.filter((c) => c.approved).length;
    const question = made.length
      ? `Delete ${label} and the ${count(made.length)} made from it${approved ? ` (${approved} approved)` : ""}? The footage and clip files are deleted from this Mac. This cannot be undone.`
      : `Delete ${label}? The footage file is deleted from this Mac. This cannot be undone.`;
    if (!window.confirm(question)) return;
    void clear(async () => {
      const result = await deleteEpisode(sourceId, made);
      return result.deleted
        ? {
            ok: true,
            text: made.length
              ? `${label} and its ${count(made.length)} were deleted.`
              : `${label} was deleted.`,
          }
        : {
            ok: false,
            text: `${label} was kept: ${result.kept} of its clips could not be deleted. ${result.reason}`,
          };
    });
  }
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
            Review wall
            <span>
              {[...clips, ...loose].filter((c) => !c.approved).length}
            </span>
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
      {outcome && (
        <p
          className={`gf-message ${outcome.ok ? "success" : "error"}`}
          role={outcome.ok ? "status" : "alert"}
        >
          {outcome.text}
        </p>
      )}
      {tab === "wall" ? (
        <div className="gf-review-wall">
          <ReviewWall
            factory={factory}
            clips={[...clips, ...loose]}
            sourceIds={ids}
            onReview={onReview}
            onFactory={onFactory}
            onDiscard={discard}
            locked={locked}
          />
        </div>
      ) : tab === "edits" ? (
        <>
          {edits.length ? (
            <div className="gf-library-edits">
              {edits.map((clip) => (
                <div className="gf-library-edit" key={clip.id}>
                  <ClipPreview
                    clip={clip}
                    className="gf-library-edit-art"
                    iconSize={24}
                    onReview={() => onReview(clip)}
                    onDiscard={locked ? undefined : () => discard([clip])}
                  />
                  <button
                    type="button"
                    className="gf-library-edit-open"
                    onClick={() => onReview(clip)}
                    aria-label={`Review ${clip.name}`}
                  >
                    <span className="gf-library-edit-copy">
                      <strong>{clip.name}</strong>
                      <span>{clip.hook || "Clip"}</span>
                      <small>
                        {formatTime(clip.start)}–{formatTime(clip.end)} ·{" "}
                        {sourceLabel(clip.video_id, ids)}
                      </small>
                    </span>
                    {clip.made_without_speech && <SpeechlessChip />}
                    <Pill tone={clip.approved ? "approved" : ""}>
                      {clip.approved ? "Approved" : "Needs review"}
                    </Pill>
                    <Icon name="arrow" size={16} />
                  </button>
                </div>
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
                  : loose.length
                    ? `${loose.length} clip${loose.length === 1 ? " was" : "s were"} made from this footage before a direction was approved. Play and approve them on the review wall.`
                    : "Add an episode in Factory to get your first clips."}
              </p>
              {!normalized &&
                (loose.length ? (
                  <button
                    type="button"
                    className="gf-button secondary"
                    onClick={() => setTab("wall")}
                  >
                    Open the review wall
                    <Icon name="arrow" size={15} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="gf-button secondary"
                    onClick={onFactory}
                  >
                    Go to Factory
                    <Icon name="arrow" size={15} />
                  </button>
                ))}
            </div>
          )}
        </>
      ) : (
        <>
          {footage.length ? (
            <div className="gf-episode-grid">
              {footage.map((source) => {
                // Counted like the Factory screen does: clips made before a direction existed are this episode's too.
                const made = [...clips, ...loose].filter((c) => c.video_id === source.id);
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
                        {source.has_audio === false
                          ? " · No speech in this footage"
                          : source.has_audio === true && source.transcript == null
                            ? " · Transcript not available"
                            : ""}
                      </p>
                      <div className="gf-episode-actions">
                        <SourceDetails source={source} disabled={locked || sourceHasActiveJob(factory.data.jobs, source.id)}
                          onRebuild={() => { void factory.run(() => post(endpoint("videos", source.id, "storyboard"), {}), "The factory is watching this video. The storyboard updates when it finishes."); }}
                          onDelete={() => deleteSource(source.id)} />
                        <button
                          type="button"
                          className="gf-button secondary compact"
                          disabled={w.busy || w.loading}
                          onClick={() => onProduce(source.id, "agent")}
                        >
                          Find clips
                          <Icon name="arrow" size={14} />
                        </button>
                        <button
                          type="button"
                          className="gf-button ghost compact"
                          disabled={locked || sourceHasActiveJob(factory.data.jobs, source.id)}
                          aria-label={`Delete ${sourceLabel(source.id, ids)}`}
                          onClick={() => deleteSource(source.id)}
                        >
                          Delete
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
  if (c.rank?.below_bar || c.made_without_speech) return { label: "Below the bar", tone: "gf-status-below" };
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
  onDiscard,
  locked,
}: {
  factory: FactoryState;
  clips: Clip[];
  sourceIds: string[];
  onReview: (clip: Clip) => void;
  onFactory: () => void;
  /** Deletes the given clips' files after asking. */
  onDiscard: (clips: Clip[]) => void;
  locked: boolean;
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
      !c.made_without_speech &&
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
        {filter === "Needs review" && shown.length > 0 && (
          <button
            type="button"
            className="gf-button ghost compact"
            disabled={locked || factory.busy}
            onClick={() => onDiscard(shown)}
          >
            Discard {shown.length} shown
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
              // Clips made with no direction cannot open in the Studio; they play here and are approved here.
              onReview={clip.campaign_id ? () => onReview(clip) : undefined}
              onApprove={() =>
                void factory.run(
                  () => put(endpoint("clips", clip.id), { approved: true }),
                  "Clip approved.",
                )
              }
              onDiscard={locked ? undefined : () => onDiscard([clip])}
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
  onApprove,
  onDiscard,
}: {
  clip: Clip;
  source: string;
  /** Absent for clips with no direction: those open a quick look instead of the Studio. */
  onReview?: () => void;
  onApprove: () => void;
  onDiscard?: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [looking, setLooking] = useState(false);
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
    <>
      <button
        type="button"
        className="gf-wall-card"
        aria-label={onReview ? `Review ${clip.name}` : `Play ${clip.hook || clip.name}`}
        onClick={onReview ?? (() => setLooking(true))}
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
          {clip.made_without_speech && (
            <span className="gf-wall-warning">
              <SpeechlessChip />
            </span>
          )}
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
      {looking && (
        <QuickLook
          clip={clip}
          title={clip.hook || clip.name}
          onClose={() => setLooking(false)}
          onReview={clip.approved ? undefined : onApprove}
          reviewLabel="Approve"
          onDiscard={onDiscard}
        />
      )}
    </>
  );
}
