import { useEffect, useRef, useState } from "react";
import { endpoint, put } from "../api";
import { activeJob, sourceHasActiveJob } from "../productionPreflight";
import type { FactoryState } from "../useFactory";
import type { Workspace } from "./useCampaignWorkspace";
import { reviewPreview, workspaceApi } from "./workspaceApi";
import {
  Disclosure,
  Empty,
  Field,
  FieldGroup,
  Pill,
  Poster,
  PreviewNote,
  PrimaryAction,
  formatTime,
} from "./parts";
import { Icon } from "./Icon";

export function Studio({
  w,
  factory,
  next,
  preferredSource,
}: {
  w: Workspace;
  factory: FactoryState;
  next: () => void;
  preferredSource?: string;
}) {
  const sources = factory.data.videos.filter((v) =>
    w.campaign?.video_ids.includes(v.id),
  );
  const [sourceId, setSourceId] = useState(
    preferredSource || sources[0]?.id || "",
  );
  const [selectedId, setSelectedId] = useState("");
  const [start, setStart] = useState("0"),
    [end, setEnd] = useState("30");
  const [hook, setHook] = useState("");
  const [feedback, setFeedback] = useState("");
  const [revision, setRevision] = useState(false);
  const [freshProduction, setFreshProduction] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const clips = factory.data.clips.filter(
    (c) => c.campaign_id === w.campaign?.id && c.profile_id === w.profileId,
  );
  const selected = freshProduction
    ? undefined
    : clips.find((c) => c.id === selectedId) || clips[0];
  const active = w.versions.find(
    (v) => v.id === w.campaign?.active_strategy_id,
  );
  const direction = active?.directions[w.profileId];
  const source = sources.find((v) => v.id === sourceId);
  const stale =
    factory.loading ||
    !!factory.errors.videos ||
    !!factory.errors.jobs ||
    !!factory.errors.clips ||
    w.loading ||
    !!w.error;
  const sourceBusy = sourceHasActiveJob(factory.data.jobs, sourceId);
  const selectedBusy = selected
    ? sourceHasActiveJob(factory.data.jobs, selected.video_id)
    : false;
  const renderReady =
    !!direction &&
    !!source &&
    !stale &&
    !w.busy &&
    !sourceBusy &&
    !factory.errors.system &&
    factory.data.system?.ffmpeg === true &&
    factory.data.system?.ffprobe === true;
  const rangeReady =
    start.trim() !== "" &&
    end.trim() !== "" &&
    Number.isFinite(+start) &&
    Number.isFinite(+end) &&
    +start >= 0 &&
    +end > +start &&
    +end - +start <= 180 &&
    (source?.duration == null || +end <= source.duration);
  const teamPass =
    !selected?.team_run_id ||
    selected.team_review_status === "pass" ||
    selected.team_review_status === "not_applicable";
  const canReview =
    !!selected && !stale && !w.busy && !selectedBusy && teamPass;
  const jobs = factory.data.jobs.filter((j) => activeJob(j));
  const video = useRef<HTMLVideoElement>(null);
  const priorClipIds = useRef(new Set(clips.map((c) => c.id)));
  const outputVersion = w.versions.find(
    (v) => v.id === selected?.strategy_version_id,
  );
  useEffect(() => {
    const fresh = clips.filter((c) => !priorClipIds.current.has(c.id));
    if (fresh.length) {
      setSelectedId(fresh[fresh.length - 1].id);
      setFreshProduction(false);
    }
    priorClipIds.current = new Set(clips.map((c) => c.id));
  }, [clips.map((c) => c.id).join("|")]);
  useEffect(() => {
    if (preferredSource && sources.some((s) => s.id === preferredSource)) {
      setSourceId(preferredSource);
      setFreshProduction(true);
      setRevision(false);
      setStart("0");
      setEnd(
        String(
          Math.min(
            30,
            sources.find((s) => s.id === preferredSource)?.duration || 30,
          ),
        ),
      );
      setHook("");
    }
  }, [preferredSource, active?.id]);
  useEffect(() => {
    if (!sourceId && sources[0]) setSourceId(sources[0].id);
  }, [sources, sourceId]);
  useEffect(() => {
    setPlaybackError("");
  }, [selected?.id]);
  if (!w.campaign)
    return (
      <Empty title="Your studio is waiting" icon="studio">
        Save a campaign and approve its direction to begin.
      </Empty>
    );
  async function render() {
    if (!renderReady || !rangeReady || !w.campaign || !active) return;
    const ok = await w.run(
      () =>
        workspaceApi.render(w.campaign!.id, {
          expected_strategy_version_id: active.id,
          video_id: sourceId,
          profile_id: w.profileId,
          start: +start,
          end: +end,
          hook: hook || direction?.hooks[0] || "",
          caption: "",
          subtitles: true,
          mode: "direct",
          instructions: revision
            ? `Revision of ${selected?.id}: ${feedback}`
            : "Creator-selected moment within this campaign.",
        }),
      reviewPreview
        ? "Sample job queued. This preview simulates the handoff; it does not render footage."
        : "Render queued. The completed version will appear here for fresh review.",
    );
    if (ok) setRevision(false);
  }
  return (
    <div className="gf-studio-grid">
      <section className="gf-card gf-edit-surface">
        <div className="gf-card-header">
          <div>
            <span className="gf-overline">YOUR CREATIVE WORKBENCH</span>
            <h2>
              {selected
                ? "See it. Feel it. Refine it."
                : "Let's make the first cut."}
            </h2>
          </div>
          <Pill tone={selected?.approved ? "mint" : "quiet"}>
            {selected?.approved
              ? "Human approved"
              : selected
                ? "Needs your eyes"
                : "Awaiting first render"}
          </Pill>
        </div>
        <div className="gf-studio-media">
          {reviewPreview ? (
            <div className="gf-preview-film">
              <Poster />
              <div className="gf-film-caption">
                <Pill>ILLUSTRATIVE EDIT</Pill>
                <strong>
                  {selected?.hook || "The next great idea is in here."}
                </strong>
                <small>Preview artwork · not rendered footage</small>
              </div>
            </div>
          ) : selected ? (
            <video
              key={selected.id}
              ref={video}
              controls
              preload="metadata"
              src={endpoint("clips", selected.id, "media")}
              aria-label={`Review ${selected.name}`}
              onError={() =>
                setPlaybackError(
                  "This video could not be played. Check the output file in the local service before approval.",
                )
              }
            />
          ) : (
            <div className="gf-empty-film">
              <Icon name="studio" size={38} />
              <h3>From conversation to creation.</h3>
              <p>
                Select a source moment. Your first rendered clip will appear
                here.
              </p>
            </div>
          )}
          <div className="gf-media-context">
            <span className="gf-overline">
              {selected ? "CURRENT OUTPUT" : "OUTPUT PREVIEW"}
            </span>
            <h3>{selected?.name || "Your first vertical edit"}</h3>
            <p>
              {selected
                ? `${formatTime(selected.start)} — ${formatTime(selected.end)}`
                : "9:16 · Original audio · Readable captions"}
            </p>
            <div className="gf-media-rule" />
            <span>STRATEGY</span>
            <strong>
              {selected
                ? outputVersion
                  ? `Version ${outputVersion.version}`
                  : "Version unavailable"
                : active
                  ? `Version ${active.version}`
                  : "Not approved yet"}
            </strong>
            <span>PROFILE</span>
            <strong>
              {w.profiles.find((p) => p.id === w.profileId)?.name}
            </strong>
            {reviewPreview && <PreviewNote />}
          </div>
        </div>
        {playbackError && (
          <div className="gf-inline-error" role="alert">
            {playbackError}
          </div>
        )}
        <div className="gf-clip-strip">
          {clips.length > 0 && (
            <button
              onClick={() => {
                setFreshProduction(true);
                setRevision(false);
                setHook("");
              }}
            >
              <Icon name="plus" size={14} />
              <strong>New cut</strong>
            </button>
          )}
          {clips.length ? (
            clips.map((c, i) => (
              <button
                className={selected?.id === c.id ? "selected" : ""}
                key={c.id}
                onClick={() => {
                  setSelectedId(c.id);
                  setRevision(false);
                  setFreshProduction(false);
                }}
              >
                <span>{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{c.name}</strong>
                  <small>{c.approved ? "Approved" : "Ready for review"}</small>
                </div>
                <Icon name={c.approved ? "check" : "play"} size={15} />
              </button>
            ))
          ) : (
            <span className="gf-small-note">
              Completed versions will stay here. Revisions never replace the
              original.
            </span>
          )}
        </div>
        {jobs.length > 0 && (
          <div className="gf-job-progress" role="status">
            <span className="gf-spinner" />
            <div>
              <strong>
                {reviewPreview
                  ? "Simulating a render handoff"
                  : "Production in progress"}
              </strong>
              <span>
                {jobs[0].message || jobs[0].kind} · {jobs[0].status}
              </span>
            </div>
            <progress
              aria-label="Production progress"
              max={100}
              value={
                typeof jobs[0].progress === "number"
                  ? jobs[0].progress
                  : undefined
              }
            />
          </div>
        )}
        {factory.data.jobs
          .filter((j) => j.status === "failed")
          .slice(0, 1)
          .map((j) => (
            <div key={j.id} className="gf-inline-error" role="alert">
              Last job failed:{" "}
              {j.error || j.message || "Inspect the run in Workspace tools."} No
              output is assumed.
            </div>
          ))}
      </section>
      <aside className="gf-card gf-review-inspector">
        <div className="gf-card-header">
          <div>
            <span className="gf-overline">
              {selected && !revision ? "THE HUMAN TOUCH" : "THE EDIT PLAN"}
            </span>
            <h2>
              {selected && !revision
                ? "Make the call."
                : revision
                  ? "A little closer."
                  : "Shape the first cut."}
            </h2>
            <p>
              {selected && !revision
                ? "The agent can make it. You decide if it's ready."
                : "A clear moment, with its meaning intact."}
            </p>
          </div>
        </div>
        {!selected || revision ? (
          <div className="gf-form-fields">
            <FieldGroup title="Source & moment">
              <Field label="Source footage">
                {(id) => (
                  <select
                    id={id}
                    value={sourceId}
                    onChange={(e) => {
                      setSourceId(e.target.value);
                      setStart("0");
                      const s = sources.find((v) => v.id === e.target.value);
                      setEnd(String(Math.min(30, s?.duration || 30)));
                    }}
                  >
                    <option value="" disabled>
                      Choose a source
                    </option>
                    {sources.map((s) => (
                      <option value={s.id} key={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <div className="gf-form-pair">
                <Field label="Start (seconds)">
                  {(id) => (
                    <input
                      id={id}
                      type="number"
                      min="0"
                      step="0.1"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  )}
                </Field>
                <Field label="End (seconds)">
                  {(id) => (
                    <input
                      id={id}
                      type="number"
                      min="0"
                      step="0.1"
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                    />
                  )}
                </Field>
              </div>
            </FieldGroup>
            <FieldGroup title="Edit treatment">
              <Field label="Opening treatment">
                {(id) => (
                  <select
                    id={id}
                    value={hook || direction?.hooks[0] || ""}
                    onChange={(e) => setHook(e.target.value)}
                  >
                    {(direction?.hooks.length
                      ? direction.hooks
                      : ["Choose approved direction first"]
                    ).map((h) => (
                      <option value={h} key={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {revision && (
                <Field label="What would make it better?">
                  {(id) => (
                    <textarea
                      id={id}
                      value={feedback}
                      onChange={(e) => setFeedback(e.target.value)}
                      placeholder="Start two seconds later. Keep captions static."
                      rows={3}
                    />
                  )}
                </Field>
              )}
              <div className="gf-spec-row">
                <span>FORMAT</span>
                <strong>Vertical · 9:16</strong>
                <span>CAPTIONS</span>
                <strong>Source subtitles</strong>
              </div>
            </FieldGroup>
            {!renderReady && (
              <p className="gf-help">
                {!direction
                  ? "Approve a direction in Research first."
                  : !source
                    ? "Attach footage in Setup first."
                    : sourceBusy
                      ? "This source already has a job running."
                      : "Rendering needs current queue/source data and available FFmpeg tools. Open Workspace tools to check the environment."}
              </p>
            )}
            {!rangeReady && source && (
              <p className="gf-help">
                Choose a positive source range of at most 180 seconds, within
                the video's duration.
              </p>
            )}
            <PrimaryAction
              full
              label={
                w.busy
                  ? "Queuing…"
                  : revision
                    ? "Render a new revision"
                    : "Make the first cut"
              }
              hoverLabel={
                revision
                  ? "Make the next version shine"
                  : "Let’s make a great cut"
              }
              disabled={
                !renderReady || !rangeReady || (revision && !feedback.trim())
              }
              onClick={() => void render()}
            />
            {revision && (
              <button
                className="gf-button ghost full"
                onClick={() => setRevision(false)}
              >
                Back to review
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="gf-review-checks">
              <div>
                <Icon name="check" />
                <span>
                  Source linked
                  <strong>
                    {factory.data.videos.find((s) => s.id === selected.video_id)
                      ?.name || selected.video_id}
                  </strong>
                </span>
              </div>
              <div>
                <Icon name={selected.subtitles_burned ? "check" : "info"} />
                <span>
                  Caption processing
                  <strong>
                    {reviewPreview
                      ? "Simulated check"
                      : selected.subtitles_burned
                        ? "Subtitles included"
                        : "Not confirmed"}
                  </strong>
                </span>
              </div>
              <div>
                <Icon name={teamPass ? "check" : "info"} />
                <span>
                  Technical critique
                  <strong>
                    {reviewPreview
                      ? "Simulated check"
                      : selected.team_run_id
                        ? selected.team_review_status || "Unknown"
                        : "Human review required"}
                  </strong>
                </span>
              </div>
            </div>
            {!teamPass && (
              <p className="gf-help">
                Unresolved team critique blocks approval. Inspect or recheck it
                in Workspace tools.
              </p>
            )}
            {selected.warning && <p className="gf-help">{selected.warning}</p>}
            <Disclosure title="Edit plan & source" icon="studio">
              <p>{selected.hook}</p>
              <p>
                Source range: {formatTime(selected.start)}–
                {formatTime(selected.end)}
              </p>
              <p>Strategy: {selected.strategy_version_id || "Not linked"}</p>
              <p>
                {selected.creator_instructions ||
                  "No additional instructions recorded."}
              </p>
            </Disclosure>
            <Disclosure title="Run details" icon="clock">
              <p>Clip: {selected.id}</p>
              <p>
                Review:{" "}
                {selected.approved ? "Human approved" : "Awaiting human review"}
              </p>
              <p>Processing cost: unknown</p>
              <p>
                {reviewPreview
                  ? "All processing and checks are simulated."
                  : "Check the production ledger for actual inputs, outputs and timings."}
              </p>
            </Disclosure>
            <div className="gf-inspector-footer">
              {selected.approved ? (
                <>
                  <a
                    className={`gf-button full ${!canReview || playbackError ? "disabled" : ""}`}
                    aria-disabled={!canReview || !!playbackError}
                    href={
                      reviewPreview || !canReview || playbackError
                        ? undefined
                        : endpoint("clips", selected.id, "download")
                    }
                    download
                    onClick={(e) => {
                      if (reviewPreview) {
                        e.preventDefault();
                        void w.run(async () => {
                          throw new Error(
                            "Preview clips are illustrative. Connect the native service to export a real MP4.",
                          );
                        }, "");
                      } else if (!canReview || playbackError)
                        e.preventDefault();
                    }}
                  >
                    <Icon name="download" size={16} />
                    {reviewPreview
                      ? "Export · native app only"
                      : "Export approved MP4"}
                  </a>
                  <button className="gf-button ghost full" onClick={next}>
                    Review the results
                    <Icon name="arrow" size={15} />
                  </button>
                </>
              ) : (
                <PrimaryAction
                  full
                  label="Approve this clip"
                  hoverLabel="Approve a keeper"
                  disabled={!canReview || !!playbackError}
                  onClick={() =>
                    void w.run(
                      () =>
                        put(endpoint("clips", selected.id), { approved: true }),
                      reviewPreview
                        ? "Sample clip approved. No actual media is being accepted."
                        : "This exact clip is approved. Your export is ready.",
                    )
                  }
                />
              )}
              <button
                className="gf-button secondary full"
                disabled={w.busy}
                onClick={() => {
                  setRevision(true);
                  setSourceId(selected.video_id);
                  setStart(String(selected.start));
                  setEnd(String(selected.end));
                }}
              >
                Request a change
                <Icon name="settings" size={15} />
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
