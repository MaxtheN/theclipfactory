import { useEffect, useRef, useState } from "react";
import { endpoint, post } from "../api";
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
  const [olderTests, setOlderTests] = useState(false);
  const [inspecting, setInspecting] = useState<Clip>();
  useEffect(() => {
    setInspecting(undefined);
    setOlderTests(false);
    setQuery("");
  }, [w.campaign?.id, w.profileId]);
  const ids = w.campaign?.video_ids || [];
  const sources = factory.data.videos.filter((v) => ids.includes(v.id));
  const clips = factory.data.clips.filter(
    (c) =>
      c.campaign_id === w.campaign?.id &&
      c.profile_id === w.profileId &&
      ids.includes(c.video_id),
  );
  // Undirected outputs stay playable locally without borrowing the active brand’s Studio direction.
  const loose = factory.data.clips.filter((c) => undirected(c, ids));
  const normalized = query.trim().toLocaleLowerCase();
  const allClips = [...new Map([...clips, ...loose].map(clip => [clip.id, clip])).values()];
  const olderCount = allClips.filter(clip => clip.made_without_speech).length;
  const libraryClips = allClips.filter(clip => olderTests || !clip.made_without_speech);
  const edits = newestFirst(libraryClips).filter((c) =>
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
            Clips<span>{libraryClips.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={tab === "wall"}
            onClick={() => setTab("wall")}
          >
            Clip wall<span>{libraryClips.length}</span>
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
      {olderCount > 0 && tab !== "footage" && (
        <details className="gf-library-older-tests">
          <summary>Older test drafts ({olderCount})</summary>
          <p>These drafts were generated without speech. They are kept separately from current clips.</p>
          <label><input type="checkbox" checked={olderTests} onChange={event => setOlderTests(event.target.checked)} /> Include older test drafts</label>
        </details>
      )}
      {inspecting && <QuickLook clip={inspecting} title={inspecting.hook || inspecting.name} onClose={() => setInspecting(undefined)} onDiscard={locked ? undefined : () => discard([inspecting])} discardLabel="Remove" />}
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
            clips={edits}
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
                    onReview={clip.campaign_id ? () => onReview(clip) : undefined}
                    reviewLabel="Edit / request change"
                    onDiscard={locked ? undefined : () => discard([clip])}
                    discardLabel="Remove"
                  />
                  <button
                    type="button"
                    className="gf-library-edit-open"
                    onClick={() => clip.campaign_id ? onReview(clip) : setInspecting(clip)}
                    aria-label={`${clip.campaign_id ? "Edit" : "Inspect"} ${clip.name}`}
                  >
                    <span className="gf-library-edit-copy">
                      <strong>{clip.name}</strong>
                      <span>{clip.hook || "Clip"}</span>
                      <small>
                        {formatTime(clip.start)}–{formatTime(clip.end)} ·{" "}
                        {sourceLabel(clip.video_id, ids)}
                      </small>
                    </span>
                    {(posted(clip) || clip.made_without_speech || clip.rank?.below_bar) && <Pill tone={posted(clip) ? "approved" : ""}>{posted(clip) ? "Posted" : clip.made_without_speech ? "Older test draft" : "Quality hold"}</Pill>}
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
                  : olderCount && !olderTests
                    ? "Generate fresh clips in Factory. Your older test drafts are available above."
                    : "Add footage in Factory to get your first clips."}
              </p>
              {!normalized && <button type="button" className="gf-button secondary" onClick={onFactory}>Go to Factory<Icon name="arrow" size={15} /></button>}
            </div>
          )}
        </>
      ) : (
        <>
          {footage.length ? (
            <div className="gf-episode-grid">
              {footage.map((source) => {
                // Counted like the Factory screen does: clips made before a direction existed are this episode's too.
                const made = libraryClips.filter((c) => c.video_id === source.id);
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
                            ? `${made.length} clips generated`
                            : made.length
                              ? "Clips generated"
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

type WallFilter = "All clips" | "Posted" | "Quality holds";
const wallFilters: WallFilter[] = ["All clips", "Posted", "Quality holds"];
const posted = (c: Clip) => !!(c.published_at || c.instagram_media_id);
function clipStatus(c: Clip) {
  if (posted(c)) return { label: "Posted", tone: "gf-status-posted" };
  if (c.made_without_speech) return { label: "Older test draft", tone: "gf-status-below" };
  if (c.rank?.below_bar) return { label: "Quality hold", tone: "gf-status-below" };
  return { label: "Generated", tone: "gf-status-generated" };
}
const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Vertical 9:16 cards: poster frame, score, hook and status. Hover previews muted; click opens review. */
function ReviewWall({
  clips,
  sourceIds,
  onReview,
  onFactory,
  onDiscard,
  locked,
}: {
  clips: Clip[];
  sourceIds: string[];
  onReview: (clip: Clip) => void;
  onFactory: () => void;
  /** Deletes the given clips' files after asking. */
  onDiscard: (clips: Clip[]) => void;
  locked: boolean;
}) {
  const [filter, setFilter] = useState<WallFilter>("All clips");
  const [hypothesis, setHypothesis] = useState("");
  const hypotheses = [
    ...new Set(clips.map((c) => c.hypothesis).filter((h): h is string => !!h)),
  ].sort();
  const scoped = newestFirst(clips).filter(
    (c) => !hypothesis || c.hypothesis === hypothesis,
  );
  const matches = (c: Clip, f: WallFilter) => f === "All clips" || (f === "Posted" ? posted(c) : !!c.rank?.below_bar || !!c.made_without_speech);
  const shown = scoped.filter((c) => matches(c, filter));
  if (!clips.length)
    return (
      <div className="gf-flow-empty">
        <Icon name="studio" size={26} />
        <h2>No clips yet</h2>
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
      </div>
      {shown.length ? (
        <div className="gf-wall-grid">
          {shown.map((clip) => (
            <WallCard
              key={clip.id}
              clip={clip}
              source={sourceLabel(clip.video_id, sourceIds)}
              // Clips without saved direction stay playable here without borrowing another workspace’s edit context.
              onReview={clip.campaign_id ? () => onReview(clip) : undefined}
              onDiscard={locked ? undefined : () => onDiscard([clip])}
            />
          ))}
        </div>
      ) : (
        <div className="gf-flow-empty">
          <Icon name="check" size={26} />
          <h2>{filter === "Quality holds" ? "No quality holds" : filter === "Posted" ? "Nothing posted yet" : "No matching clips"}</h2>
          <p>Generated clips stay here with their source, quality details, and edit history.</p>
          <button
            type="button"
            className="gf-button secondary"
            onClick={() => setFilter("All clips")}
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
  onDiscard,
}: {
  clip: Clip;
  source: string;
  /** Absent for clips with no direction: those open a quick look instead of the Studio. */
  onReview?: () => void;
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
        aria-label={onReview ? `Edit ${clip.name}` : `Play ${clip.hook || clip.name}`}
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
            {status.label !== "Generated" && <span className={`gf-pill ${status.tone}`}>{status.label}</span>}
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
      {looking && (
        <QuickLook
          clip={clip}
          title={clip.hook || clip.name}
          onClose={() => setLooking(false)}
          onReview={onReview}
          reviewLabel="Edit / request change"
          onDiscard={onDiscard}
          discardLabel="Remove"
        />
      )}
    </>
  );
}
