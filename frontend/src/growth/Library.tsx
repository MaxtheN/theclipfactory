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
import { deleteEpisode, discardClips, exportedClipIds, type Discarded } from "./storage";
import { sourceHasActiveJob } from "../productionPreflight";
import type { LibraryViewStore } from "./libraryViewState";

export function Library({
  w,
  factory,
  onReview,
  onProduce,
  onFactory,
  view,
  onView,
  viewState,
}: {
  w: Workspace;
  factory: FactoryState;
  onReview: (clip: Clip) => void;
  onProduce: OpenProduction;
  onFactory: () => void;
  /** The open tab, when the shell drives it (another screen can open the wall directly). */
  view?: LibraryView;
  onView?: (view: LibraryView) => void;
  /** Filters kept by the shell for this campaign, so returning to Library restores them. */
  viewState?: { store: LibraryViewStore; key: string };
}) {
  const saved = viewState?.store.get(viewState.key);
  const [own, setOwn] = useState<LibraryView>(saved?.view ?? "edits");
  const tab = view ?? own;
  const setTab = (next: LibraryView) => {
    setOwn(next);
    viewState?.store.patch(viewState.key, { view: next });
    onView?.(next);
  };
  const [query, setQuery] = useState(saved?.query ?? "");
  const [olderTests, setOlderTests] = useState(saved?.olderTests ?? false);
  const [inspecting, setInspecting] = useState<Clip>();
  // A different campaign starts from its own filters; the first render keeps the restored ones.
  const scope = `${w.campaign?.id}|${w.profileId}`;
  const shownScope = useRef(scope);
  useEffect(() => {
    if (shownScope.current === scope) return;
    shownScope.current = scope;
    setInspecting(undefined);
    setOlderTests(false);
    setQuery("");
  }, [scope]);
  useEffect(() => {
    viewState?.store.patch(viewState.key, { query, olderTests });
  }, [viewState?.store, viewState?.key, query, olderTests]);
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
  async function discard(targets: Clip[], picked = false): Promise<boolean> {
    if (!targets.length) return false;
    const one = targets.length === 1 ? targets[0] : undefined;
    let question: string;
    if (one) {
      question = `Discard “${clipTitle(one)}”? The clip file is deleted from this Mac.`;
    } else {
      // The count names what is at stake: approved work, and exported versions the service keeps.
      const exported = await exportedClipIds();
      const approved = targets.filter((c) => c.approved).length;
      const kept = exported ? targets.filter((c) => exported.has(c.id)).length : 0;
      const stakes = [approved && `${approved} approved`, kept && `${kept} exported`].filter(Boolean).join(", ");
      question = `${picked ? "Delete" : "Discard"} ${count(targets.length)}${picked ? "" : " that were not approved"}${stakes ? ` (${stakes})` : ""}? Their files are deleted from this Mac. This cannot be undone.`;
      if (kept) question += ` Exported versions are kept so their exports can be verified.`;
      if (!exported) question += " Export history could not be read, so some exported clips may be kept.";
    }
    if (!window.confirm(question)) return false;
    void clear(async () => {
      const result = await discardClips(targets);
      return result.kept
        ? { ok: false, text: `${count(result.discarded)} discarded. ${notDeleted(result)}` }
        : { ok: true, text: `${count(result.discarded)} discarded.` };
    });
    return true;
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
      {inspecting && <QuickLook clip={inspecting} title={inspecting.hook || inspecting.name} onClose={() => setInspecting(undefined)} onDiscard={locked ? undefined : () => void discard([inspecting])} discardLabel="Remove" />}
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
            initial={saved}
            onFilters={(part) => viewState?.store.patch(viewState.key, part)}
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
                    onDiscard={locked ? undefined : () => void discard([clip])}
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

const clipTitle = (clip: Clip) => clip.hook || clip.name;
/** Names every clip the local service kept, grouped under its reason. */
function notDeleted({ failed, kept, reason }: Discarded) {
  if (!failed.length) return `${kept} kept: ${reason}`;
  const byReason = new Map<string, string[]>();
  for (const { clip, reason: why } of failed)
    byReason.set(why, [...(byReason.get(why) ?? []), `“${clipTitle(clip)}”`]);
  const groups = [...byReason].map(([why, names]) => {
    const listed = names.length > 5 ? `${names.slice(0, 5).join(", ")} and ${names.length - 5} more` : names.join(", ");
    return `${listed}: ${why}`;
  });
  return `Not deleted: ${groups.join(" ")}`;
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
  initial,
  onFilters,
}: {
  clips: Clip[];
  sourceIds: string[];
  onReview: (clip: Clip) => void;
  onFactory: () => void;
  /** Deletes the given clips' files after asking; false when the person declined. */
  onDiscard: (clips: Clip[], picked?: boolean) => Promise<boolean>;
  locked: boolean;
  /** Filters to restore when the creator returns. */
  initial?: { filter: string; hypothesis: string };
  onFilters?: (filters: { filter: WallFilter; hypothesis: string }) => void;
}) {
  const [filter, setFilter] = useState<WallFilter>(() =>
    wallFilters.find((f) => f === initial?.filter) ?? "All clips",
  );
  // Batch mode: cards toggle a selection instead of opening review.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [hypothesis, setHypothesis] = useState(initial?.hypothesis ?? "");
  const reportFilters = useRef(onFilters);
  reportFilters.current = onFilters;
  useEffect(() => {
    reportFilters.current?.({ filter, hypothesis });
  }, [filter, hypothesis]);
  const hypotheses = [
    ...new Set(clips.map((c) => c.hypothesis).filter((h): h is string => !!h)),
  ].sort();
  // A restored hypothesis applies only while it is still offered, so no filter hides clips unseen.
  const activeHypothesis = hypotheses.length > 1 && hypotheses.includes(hypothesis) ? hypothesis : "";
  const scoped = newestFirst(clips).filter(
    (c) => !activeHypothesis || c.hypothesis === activeHypothesis,
  );
  const matches = (c: Clip, f: WallFilter) => f === "All clips" || (f === "Posted" ? posted(c) : !!c.rank?.below_bar || !!c.made_without_speech);
  const shown = scoped.filter((c) => matches(c, filter));
  // Only clips on screen count: a filter, hypothesis, search or refresh that hides a clip also
  // drops it from the selection, so a delete never reaches clips the person cannot see.
  const chosen = shown.filter((c) => picked.has(c.id));
  const shownKey = shown.map((c) => c.id).join("\n");
  useEffect(() => {
    const visible = new Set(shownKey ? shownKey.split("\n") : []);
    setPicked((prev) => {
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [shownKey]);
  const allShown = shown.length > 0 && shown.every((c) => picked.has(c.id));
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  const [asking, setAsking] = useState(false);
  const deleteChosen = async () => {
    if (locked || asking) return;
    setAsking(true);
    try {
      if (await onDiscard(chosen, true)) stopSelecting();
    } finally {
      setAsking(false);
    }
  };
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
            value={activeHypothesis}
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
        {selecting ? (
          <div className="gf-wall-batch" role="group" aria-label="Selected clips">
            <span className="gf-wall-batch-count" aria-live="polite">
              {chosen.length} selected
            </span>
            <button
              type="button"
              className="gf-button ghost compact"
              disabled={!shown.length}
              onClick={() =>
                setPicked((prev) => {
                  const next = new Set(prev);
                  for (const c of shown) {
                    if (allShown) next.delete(c.id);
                    else next.add(c.id);
                  }
                  return next;
                })
              }
            >
              {allShown ? "Clear shown" : `Select all shown (${shown.length})`}
            </button>
            <button
              type="button"
              className="gf-button compact gf-wall-batch-delete"
              disabled={locked || asking || !chosen.length}
              onClick={() => void deleteChosen()}
            >
              <Icon name="trash" size={14} />
              {chosen.length ? `Delete ${chosen.length}` : "Delete"}
            </button>
            <button type="button" className="gf-button secondary compact" onClick={stopSelecting}>
              Done
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="gf-button secondary compact"
            disabled={locked}
            onClick={() => setSelecting(true)}
          >
            Select
          </button>
        )}
      </div>
      {shown.length ? (
        <div
          className={`gf-wall-grid${selecting ? " is-selecting" : ""}`}
          onKeyDown={(e) => {
            if (selecting && e.key === "Escape") stopSelecting();
          }}
        >
          {shown.map((clip) => (
            <WallCard
              key={clip.id}
              clip={clip}
              source={sourceLabel(clip.video_id, sourceIds)}
              // Clips without saved direction stay playable here without borrowing another workspace’s edit context.
              onReview={clip.campaign_id ? () => onReview(clip) : undefined}
              onDiscard={locked ? undefined : () => void onDiscard([clip])}
              selected={selecting ? picked.has(clip.id) : undefined}
              onToggle={() => toggle(clip.id)}
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
  selected,
  onToggle,
}: {
  clip: Clip;
  source: string;
  /** Absent for clips with no direction: those open a quick look instead of the Studio. */
  onReview?: () => void;
  onDiscard?: () => void;
  /** Set while the wall is in batch mode: the card toggles instead of opening. */
  selected?: boolean;
  onToggle?: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const selecting = selected !== undefined;
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
        className={`gf-wall-card${selected ? " is-selected" : ""}`}
        aria-label={
          selecting
            ? `Select ${clip.hook || clip.name}`
            : onReview
              ? `Edit ${clip.name}`
              : `Play ${clip.hook || clip.name}`
        }
        aria-pressed={selecting ? selected : undefined}
        onClick={selecting ? onToggle : (onReview ?? (() => setLooking(true)))}
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
          {selecting && (
            <span className="gf-wall-check" aria-hidden="true">
              {selected && <Icon name="check" size={14} />}
            </span>
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
