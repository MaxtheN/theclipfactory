import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Clip, TeamRun, Video } from "../types";
import type { FactoryState } from "../useFactory";
import type { Workspace } from "./useCampaignWorkspace";
import { workspaceApi, reviewPreview } from "./workspaceApi";
import { productionApi } from "./productionApi";
import { jobInScope } from "./productionState";
import { endpoint, post } from "../api";
import { Storyboard } from "../components/Storyboard";
import { Stages } from "../pages/Home";
import { activeJob } from "../productionPreflight";
import { Icon } from "./Icon";
import { Disclosure, Pill, formatTime } from "./parts";

export type OpenProduction = (
  sourceId?: string,
  mode?: "manual" | "agent",
  clipId?: string,
) => void;

// Metadata only, never File objects or footage bytes. A profile/route remount
// must not lose a confirmed import whose campaign attachment still needs retry.
const pendingImports = new Map<string, Video>();

export function FactoryHome({
  w,
  factory,
  onProduce,
  onReview,
  onLibrary,
  onDirection,
  active = true,
}: {
  w: Workspace;
  factory: FactoryState;
  onProduce: OpenProduction;
  onReview: (clip: Clip) => void;
  onLibrary: () => void;
  onDirection: () => void;
  active?: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const imported = useRef<Video | undefined>(
    pendingImports.get(w.campaign?.id || ""),
  );
  const [pending, setPending] = useState<Video | undefined>(() =>
    pendingImports.get(w.campaign?.id || ""),
  );
  const [runs, setRuns] = useState<TeamRun[]>([]);
  const [runError, setRunError] = useState("");
  const [runLoading, setRunLoading] = useState(false);
  const reloadRuns = useRef(() => {});
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const campaign = w.campaign;
  useEffect(() => {
    const receipt = campaign && pendingImports.get(campaign.id);
    if (receipt && campaign?.video_ids.includes(receipt.id)) {
      pendingImports.delete(campaign.id);
      imported.current = undefined;
      setPending(undefined);
    }
  }, [campaign?.id, campaign?.video_ids.join("|")]);
  useEffect(() => {
    if (!active || !campaign || !w.profileId) return;
    let alive = true,
      inflight = false;
    async function refresh() {
      if (!alive || inflight) return;
      inflight = true;
      setRunLoading(true);
      try {
        const result = await workspaceApi.teamRuns();
        if (alive) {
          setRuns(result);
          setRunError("");
        }
      } catch (e) {
        if (alive)
          setRunError(
            e instanceof Error ? e.message : "Agent run status is unavailable.",
          );
      } finally {
        inflight = false;
        if (alive) setRunLoading(false);
      }
    }
    reloadRuns.current = () => {
      void refresh();
    };
    void refresh();
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 4000);
    return () => {
      alive = false;
      window.clearInterval(interval);
      reloadRuns.current = () => {};
    };
  }, [active, campaign?.id, w.profileId]);
  const sources = factory.data.videos.filter((v) =>
    campaign?.video_ids.includes(v.id),
  );
  const clips = factory.data.clips.filter(
    (c) =>
      c.campaign_id === campaign?.id &&
      c.profile_id === w.profileId &&
      campaign?.video_ids.includes(c.video_id),
  );
  const review = clips.filter((c) => !c.approved);
  const direction = w.versions.find(
    (v) => v.id === campaign?.active_strategy_id,
  )?.directions[w.profileId];
  const scope = {
    campaignId: campaign?.id || "",
    profileId: w.profileId,
    sourceIds: campaign?.video_ids || [],
  };
  const jobs = factory.data.jobs.filter(
    (j) => jobInScope(j, scope, runs) && activeJob(j),
  );
  // The production line as the local service reports it: one entry per source, with the stage
  // it is at and the model production will use.
  const line = factory.data.factory;
  const modelId = line?.model_id ?? "";
  const autopilot = factory.data.settings?.autonomy === "auto";
  const [seen, setSeen] = useState<Record<string, boolean>>({});
  const swarmRequest = (videoId: string, strategyId: string) => ({
    expected_strategy_version_id: strategyId,
    video_id: videoId,
    profile_id: w.profileId,
    model_id: modelId,
    strategy: "swarm" as const,
  });
  /** Many clips from one source, each on its own hypothesis, under the approved direction. */
  async function makeClips(source: Video) {
    const strategyId = campaign?.active_strategy_id;
    if (!campaign || !direction || !strategyId || !modelId) return;
    setError("");
    setSuccess("");
    await w.run(
      async () => {
        await productionApi.campaignProduce(campaign.id, swarmRequest(source.id, strategyId));
        reloadRuns.current();
        void factory.refresh();
        setSuccess(`Making clips from ${source.name}. They arrive below as they finish.`);
      },
      "Production started.",
      campaign.id,
    );
  }
  async function cancel(jobId: string) {
    setError("");
    try {
      await post(endpoint("jobs", jobId, "cancel"));
      void factory.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The job could not be cancelled.");
    }
  }
  const blocked =
    w.busy ||
    w.loading ||
    factory.loading ||
    !!w.error ||
    !!factory.errors.videos ||
    !campaign;

  async function attach(file?: File) {
    if (lock.current || blocked || (!file && !imported.current) || !campaign)
      return;
    if (file && imported.current) {
      setError("Attach the imported footage before adding another video.");
      return;
    }
    if (file && campaign.video_ids.length >= 100) {
      setError(
        "This workspace already has 100 sources. Choose another workspace before importing more footage.",
      );
      return;
    }
    if (
      file &&
      !/\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(file.name) &&
      !file.type.startsWith("video/")
    ) {
      setError("Choose a video file such as MP4, MOV or WebM.");
      return;
    }
    lock.current = true;
    setError("");
    setSuccess("");
    try {
      await w.run(
        async () => {
          // Keep the confirmed import receipt if attachment fails. Retrying then
          // attaches this exact video instead of uploading the file a second time.
          let video = imported.current;
          if (!video && file) {
            const uploaded = await workspaceApi.upload(file);
            if (!uploaded?.id || uploaded.id.length > 128)
              throw new Error(
                "The import could not be confirmed. Refresh local footage before uploading again.",
              );
            video = {
              id: uploaded.id,
              name: uploaded.name,
              duration: uploaded.duration,
              width: uploaded.width,
              height: uploaded.height,
              has_audio: uploaded.has_audio,
            };
            imported.current = video;
            pendingImports.set(campaign.id, video);
            setPending(video);
          }
          if (!video) throw new Error("Choose footage first.");
          const latest = (await workspaceApi.campaigns()).find(
            (c) => c.id === campaign.id,
          );
          if (!latest || !latest.profile_ids.includes(w.profileId))
            throw new Error(
              "The workspace changed. Refresh before attaching this footage.",
            );
          const sourceIds = [...new Set([...latest.video_ids, video.id])];
          if (sourceIds.length > 100)
            throw new Error(
              "This workspace reached its 100-source limit. The imported file is retained; refresh workspace settings before attaching it.",
            );
          await workspaceApi.save(
            {
              name: latest.name,
              brief: latest.brief,
              profile_ids: [...latest.profile_ids],
              video_ids: sourceIds,
            },
            latest.id,
          );
          imported.current = undefined;
          if (pendingImports.get(campaign.id)?.id === video.id)
            pendingImports.delete(campaign.id);
          setPending(undefined);
          // Autopilot: with a direction already approved, new footage goes straight into production.
          const strategyId = latest.active_strategy_id;
          if (autopilot && direction && strategyId && modelId && !reviewPreview) {
            try {
              await productionApi.campaignProduce(latest.id, swarmRequest(video.id, strategyId));
              reloadRuns.current();
              setSuccess(`${video.name} added. The factory is making clips from it now.`);
              return;
            } catch (e) {
              setSuccess(
                `${video.name} added. Production did not start by itself: ${
                  e instanceof Error ? e.message : "try Make clips."
                }`,
              );
              return;
            }
          }
          setSuccess(`${video.name} added. Open production when you’re ready.`);
        },
        "Footage added to this workspace.",
        campaign.id,
      );
    } finally {
      lock.current = false;
      if (picker.current) picker.current.value = "";
    }
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 1) {
      setError("Add one video at a time so each import has a clear status.");
      return;
    }
    const file = event.dataTransfer.files[0];
    if (file) void attach(file);
  }

  return (
    <div className="gf-factory-home">
      <div
        className={`gf-upload-stage gf-card${dragging ? " is-dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!blocked && !pending) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={drop}
      >
        <span className="gf-upload-stage-icon" aria-hidden="true">
          <Icon name="upload" size={30} />
        </span>
        <div>
          <h2>Drop your footage here</h2>
          <p>A conversation, an interview, a story worth sharing.</p>
        </div>
        <button
          type="button"
          className="gf-button"
          disabled={blocked || !!pending}
          onClick={() => picker.current?.click()}
        >
          <Icon name="plus" size={16} />
          Choose video
        </button>
        <input
          ref={picker}
          className="gf-file-input"
          tabIndex={-1}
          aria-hidden="true"
          type="file"
          aria-label="Upload footage"
          accept="video/*,.mp4,.mov,.mkv,.webm,.m4v,.avi"
          disabled={blocked || !!pending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void attach(file);
          }}
        />
        <p className="gf-upload-stage-note">
          {reviewPreview
            ? "Preview adds an illustrative placeholder; file contents stay unread."
            : "Stored on this Mac. Importing does not start a render."}
        </p>
      </div>
      {error && (
        <p className="gf-message error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="gf-flow-receipt" role="status">
          <Icon name="check" size={15} />
          {success}
        </p>
      )}
      {pending && (
        <div className="gf-flow-recovery" role="status">
          <div>
            <strong>{pending.name} is imported</strong>
            <p>
              It still needs to be attached to this workspace. Your next attempt
              reuses the imported file.
            </p>
          </div>
          <button
            type="button"
            className="gf-button secondary compact"
            disabled={blocked}
            onClick={() => void attach()}
          >
            Attach imported footage
          </button>
        </div>
      )}

      {runError && (
        <div className="gf-flow-recovery" role="status">
          <div>
            <strong>Agent run status is unavailable</strong>
            <p>
              {runError} Refresh before assuming that production has finished.
            </p>
          </div>
          <button
            type="button"
            className="gf-button secondary compact"
            disabled={runLoading}
            onClick={() => reloadRuns.current()}
          >
            Check run status
          </button>
        </div>
      )}
      {jobs.length > 0 && (
        <section className="gf-live-work" aria-label="Current production">
          {jobs.map((job) => (
            <div className="gf-live-job" key={job.id}>
              <span className="gf-spinner" aria-hidden="true" />
              <div>
                <strong>
                  {job.kind === "render"
                    ? "Rendering an edit"
                    : "Working on your footage"}
                </strong>
                <p>
                  {job.message ||
                    (job.status === "queued"
                      ? "Queued on this Mac"
                      : "Local production is running")}
                </p>
              </div>
              <Pill>{job.status}</Pill>
              {typeof job.progress === "number" &&
                Number.isFinite(job.progress) && (
                  <progress
                    aria-label="Production progress"
                    max={100}
                    value={Math.max(0, Math.min(100, job.progress))}
                  />
                )}
            </div>
          ))}
        </section>
      )}

      {review.length > 0 && (
        <section
          className="gf-home-section"
          aria-labelledby="factory-review-heading"
        >
          <header>
            <div>
              <span className="gf-eyebrow">NEXT UP</span>
              <h2 id="factory-review-heading">
                Ready for your review{" "}
                <span className="gf-inline-count">{review.length}</span>
              </h2>
            </div>
            <button
              type="button"
              className="gf-button ghost compact"
              onClick={onLibrary}
            >
              All edits
              <Icon name="arrow" size={15} />
            </button>
          </header>
          <div className="gf-cut-grid">
            {review.slice(0, 3).map((clip) => (
              <button
                type="button"
                key={clip.id}
                className="gf-cut-card"
                onClick={() => onReview(clip)}
              >
                <span className="gf-cut-art">
                  <Icon name="play" size={28} />
                  <span>
                    {reviewPreview
                      ? "Illustrative edit"
                      : formatTime(clip.end - clip.start)}
                  </span>
                </span>
                <span className="gf-cut-copy">
                  <strong>{clip.hook || clip.name}</strong>
                  <small>{clip.name}</small>
                  <span>
                    Review this edit
                    <Icon name="arrow" size={14} />
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section
        className="gf-home-section"
        aria-labelledby="factory-footage-heading"
      >
        <header>
          <div>
            <span className="gf-eyebrow">IN THIS WORKSPACE</span>
            <h2 id="factory-footage-heading">
              Your footage{" "}
              <span className="gf-inline-count">{sources.length}</span>
            </h2>
          </div>
          {sources.length > 0 && (
            <button
              type="button"
              className="gf-button ghost compact"
              onClick={onLibrary}
            >
              Open Library
              <Icon name="arrow" size={15} />
            </button>
          )}
        </header>
        {!sources.length ? (
          <div className="gf-flow-empty">
            <Icon name="studio" size={24} />
            <p>
              Your first video starts the loop. Add footage above, then choose
              how to produce your clips.
            </p>
          </div>
        ) : (
          <div className="gf-footage-list">
            {sources.map((source) => {
              const status = line?.sources.find((item) => item.video_id === source.id);
              const working = status?.state === "queued" || status?.state === "working";
              const ready =
                !!direction && !!modelId && !!status?.can_produce && !w.busy && !w.loading;
              return (
                <div className="gf-footage-item" key={source.id}>
                  <div className="gf-footage-row">
                    <span className="gf-footage-icon">
                      <Icon name="studio" size={22} />
                    </span>
                    <div className="gf-footage-copy">
                      <strong>{source.name}</strong>
                      <span>
                        {reviewPreview
                          ? "Illustrative source"
                          : formatTime(source.duration)}
                        {source.has_audio === true && source.transcript == null
                          ? " · Transcript needed for captions"
                          : ""}
                      </span>
                    </div>
                    {status &&
                      (working && status.job_id ? (
                        <button
                          type="button"
                          className="gf-button secondary compact"
                          onClick={() => void cancel(status.job_id!)}
                        >
                          Cancel
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="gf-button primary compact"
                          disabled={!ready}
                          title={
                            !direction
                              ? "Approve the creative direction first."
                              : !modelId
                                ? "Set up a local model in Advanced tools → Models."
                                : status.blocked_reason || undefined
                          }
                          onClick={() => void makeClips(source)}
                        >
                          Make clips
                        </button>
                      ))}
                    <button
                      type="button"
                      className="gf-button secondary compact"
                      disabled={w.busy || w.loading}
                      onClick={() => onProduce(source.id, "agent")}
                    >
                      Find clips
                      <Icon name="arrow" size={15} />
                    </button>
                  </div>
                  {status && (
                    <div className="gf-footage-line">
                      <div className="source-card-body">
                        <Stages source={status} />
                        <p className="gf-footage-status" role="status">
                          {status.error || status.headline}
                        </p>
                        {typeof status.progress === "number" && (
                          <progress
                            aria-label={`Progress for ${source.name}`}
                            max={100}
                            value={Math.min(100, Math.max(0, status.progress))}
                          />
                        )}
                      </div>
                      {status.storyboard && (
                        <details
                          className="gf-disclosure"
                          onToggle={(event) => {
                            const open = event.currentTarget.open;
                            setSeen((current) =>
                              current[source.id] === open ? current : { ...current, [source.id]: open },
                            );
                          }}
                        >
                          <summary>
                            <Icon name="play" />
                            What the factory saw · {status.storyboard.scenes} scenes
                            <Icon name="down" size={15} />
                          </summary>
                          {seen[source.id] && (
                            <Storyboard
                              videoId={source.id}
                              version={status.storyboard.updated_at}
                            />
                          )}
                        </details>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {sources.length > 0 && !direction && (
        <div className="gf-direction-nudge">
          <Icon name="info" size={18} />
          <div>
            <strong>One direction to review before production</strong>
            <p>
              Your workspace context is saved. Review the creative direction
              before the first run.
            </p>
          </div>
          <button
            type="button"
            className="gf-button secondary compact"
            disabled={w.busy}
            onClick={onDirection}
          >
            Review direction
          </button>
        </div>
      )}
      <Disclosure title="How the factory loop works" icon="refresh">
        <div className="gf-loop-explainer">
          <p>
            Upload footage → let local agents inspect it and plan concepts →
            review rendered options → approve and export → bring performance
            back into the next test.
          </p>
          <p>
            External precedent research is not connected. A three-day follow-up
            needs connected performance data and the app running; it is not
            scheduled automatically.
          </p>
          <button
            type="button"
            className="gf-button ghost compact"
            disabled={w.busy || !sources.length}
            onClick={() => onProduce(sources[0]?.id, "manual")}
          >
            Choose a source moment yourself
            <Icon name="arrow" size={14} />
          </button>
        </div>
      </Disclosure>
    </div>
  );
}
