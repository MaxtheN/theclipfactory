import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Clip, Job, TeamRun, Video } from "../types";
import { ApiError, endpoint, post } from "../api";
import { Storyboard } from "../components/Storyboard";
import { Stages } from "../pages/Home";
import type { FactoryState } from "../useFactory";
import type { Workspace } from "./useCampaignWorkspace";
import { workspaceApi, reviewPreview } from "./workspaceApi";
import { productionApi } from "./productionApi";
import { jobInScope, object } from "./productionState";
import { activeJob } from "../productionPreflight";
import { Icon } from "./Icon";
import { FactoryWorkflow } from "./FactoryWorkflow";
import { Disclosure, Pill, formatTime } from "./parts";
import { JourneyProgress } from "./JourneyProgress";
import { sourceLabel, SourceDetails } from "./sourcePresentation";

export type OpenProduction = (
  sourceId?: string,
  mode?: "manual" | "agent",
  clipId?: string,
) => void;

// Metadata only, never File objects or footage bytes. A profile/route remount
// must not lose a confirmed import whose campaign attachment still needs retry.
type ImportReceipt = { video: Video; attached: boolean };
type UnknownImport = { name: string; priorIds: string[] };
const pendingImports = new Map<string, ImportReceipt>();
const unknownImports = new Map<string, UnknownImport>();
type ImportPhase = "uploading" | "attaching" | "refreshing" | "ready" | null;

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
    pendingImports.get(w.campaign?.id || "")?.video,
  );
  const [pending, setPending] = useState<Video | undefined>(
    () => pendingImports.get(w.campaign?.id || "")?.video,
  );
  const [phase, setPhase] = useState<ImportPhase>(null);
  const [lastAdded, setLastAdded] = useState<Video>();
  const [refreshReturned, setRefreshReturned] = useState(false);
  const [unknown, setUnknown] = useState<UnknownImport | undefined>(() =>
    unknownImports.get(w.campaign?.id || ""),
  );
  const [checkingImport, setCheckingImport] = useState(false);
  const [checkedImport, setCheckedImport] = useState(false);
  const [runs, setRuns] = useState<TeamRun[]>([]);
  const [runError, setRunError] = useState("");
  const [runLoading, setRunLoading] = useState(false);
  const reloadRuns = useRef(() => {});
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const campaign = w.campaign;
  useEffect(() => {
    if (
      phase !== "refreshing" ||
      !refreshReturned ||
      w.loading ||
      factory.loading ||
      !campaign
    )
      return;
    setRefreshReturned(false);
    const receipt = pendingImports.get(campaign.id);
    const confirmed =
      receipt &&
      !w.error &&
      !factory.errors.videos &&
      campaign.video_ids.includes(receipt.video.id) &&
      factory.data.videos.some((v) => v.id === receipt.video.id);
    if (confirmed) {
      pendingImports.delete(campaign.id);
      imported.current = undefined;
      setPending(undefined);
      setLastAdded(receipt.video);
      setPhase("ready");
      // Keep the autopilot message if production already started for this source.
      setSuccess((current) =>
        autoStarted.current.has(receipt.video.id) && current
          ? current
          : "Source saved and attached to this workspace.",
      );
      w.clearNotice?.();
    } else {
      setPhase(null);
      setError(
        "Your saved source is retained. Refresh to confirm its attachment and local footage record.",
      );
    }
  }, [
    phase,
    refreshReturned,
    campaign,
    factory.data.videos,
    factory.errors.videos,
    factory.loading,
    w.error,
    w.loading,
  ]);
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
  const scopedJobs = factory.data.jobs.filter((j) =>
    jobInScope(j, scope, runs),
  );
  const jobs = scopedJobs.filter(activeJob);
  const latestJob = [...scopedJobs].sort((a, b) => {
    const time = (j: Job) =>
      Date.parse(j.updated_at || j.created_at || "") || 0;
    return time(b) - time(a);
  })[0];
  const failedJob =
    latestJob && ["failed", "cancelled"].includes(latestJob.status)
      ? latestJob
      : undefined;
  const result = object(latestJob?.result);
  const outputIds = [
    result?.clip_id,
    ...(Array.isArray(result?.clip_ids) ? result.clip_ids : []),
  ].filter((id): id is string => typeof id === "string");
  const waitingForOutputs =
    latestJob?.status === "completed" &&
    ["render", "production", "team"].includes(latestJob.kind) &&
    !clips.some((c) => outputIds.includes(c.id));
  function sourceForJob(job: Job) {
    const context = object(job.context);
    const id =
      typeof context?.video_id === "string"
        ? context.video_id
        : runs.find((r) => r.id === context?.team_run_id || r.job_id === job.id)
            ?.video_id;
    return typeof id === "string" && scope.sourceIds.includes(id)
      ? id
      : undefined;
  }
  const importing =
    phase === "uploading" || phase === "attaching" || phase === "refreshing";
  const recoveryBlocked =
    w.busy || w.loading || factory.loading || !campaign || importing;
  const candidates =
    checkedImport && unknown
      ? factory.data.videos.filter(
          (v) => !unknown.priorIds.includes(v.id) && v.name === unknown.name,
        )
      : [];
  const blocked =
    w.busy ||
    w.loading ||
    factory.loading ||
    !!w.error ||
    !!factory.errors.videos ||
    !campaign;
  // The production line as the local service reports it: one entry per source, with the stage
  // it is at and the model production will use.
  const line = factory.data.factory;
  const modelId = line?.model_id ?? "";
  const autopilot = factory.data.settings?.autonomy === "auto";
  const [seen, setSeen] = useState<Record<string, boolean>>({});
  const autoStarted = useRef(new Set<string>());
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
        await productionApi.campaignProduce(
          campaign.id,
          swarmRequest(source.id, strategyId),
        );
        reloadRuns.current();
        void factory.refresh();
        setSuccess(
          `Making clips from ${source.name}. They arrive below as they finish.`,
        );
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
      setError(
        e instanceof Error ? e.message : "The job could not be cancelled.",
      );
    }
  }
  /** Autopilot: with a direction approved, confirmed new footage goes straight into production. */
  async function autoProduce(video: Video) {
    const strategyId = campaign?.active_strategy_id;
    if (
      !campaign ||
      !autopilot ||
      !direction ||
      !strategyId ||
      !modelId ||
      reviewPreview
    )
      return;
    if (autoStarted.current.has(video.id)) return;
    autoStarted.current.add(video.id);
    try {
      await productionApi.campaignProduce(
        campaign.id,
        swarmRequest(video.id, strategyId),
      );
      reloadRuns.current();
      void factory.refresh();
      setSuccess(
        `${video.name} added. The factory is making clips from it now.`,
      );
    } catch (e) {
      setSuccess(
        `${video.name} added. Production did not start by itself: ${
          e instanceof Error ? e.message : "try Make clips."
        }`,
      );
    }
  }

  async function attach(file?: File) {
    if (
      lock.current ||
      (file ? blocked || importing || !!unknown : recoveryBlocked) ||
      (!file && !imported.current) ||
      !campaign
    )
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
    setLastAdded(undefined);
    setRefreshReturned(false);
    setPhase(imported.current ? "attaching" : "uploading");
    let added: Video | undefined;
    let failure = "";
    try {
      const ok = await w.run(
        async () => {
          try {
            let video = imported.current;
            if (!video && file) {
              const attempt = {
                name: file.name.slice(0, 240),
                priorIds: factory.data.videos.map((v) => v.id),
              };
              try {
                const uploaded = await workspaceApi.upload(file);
                if (
                  !uploaded ||
                  typeof uploaded.id !== "string" ||
                  !uploaded.id ||
                  uploaded.id.length > 128 ||
                  typeof uploaded.name !== "string" ||
                  !uploaded.name
                )
                  throw new Error("The saved source could not be confirmed.");
                video = {
                  id: uploaded.id,
                  name: uploaded.name,
                  duration: uploaded.duration,
                  width: uploaded.width,
                  height: uploaded.height,
                  has_audio: uploaded.has_audio,
                };
              } catch (e) {
                const rejected =
                  e instanceof ApiError &&
                  [400, 401, 403, 413, 415, 422, 429, 507].includes(e.status);
                if (!rejected) {
                  unknownImports.set(campaign.id, attempt);
                  setUnknown(attempt);
                  setCheckedImport(false);
                  throw new Error(
                    "The upload response was not confirmed. Check local footage before uploading again.",
                  );
                }
                throw e;
              }
              imported.current = video;
              pendingImports.set(campaign.id, { video, attached: false });
              setPending(video);
            }
            if (!video) throw new Error("Choose footage first.");
            setPhase("attaching");
            const latest = (await workspaceApi.campaigns()).find(
              (c) => c.id === campaign.id,
            );
            if (
              !latest ||
              !Array.isArray(latest.profile_ids) ||
              !latest.profile_ids.includes(w.profileId) ||
              !Array.isArray(latest.video_ids)
            )
              throw new Error(
                "The workspace changed. Refresh before attaching this footage.",
              );
            const sourceIds = [...new Set([...latest.video_ids, video.id])];
            if (sourceIds.length > 100)
              throw new Error(
                "This workspace reached its 100-source limit. Your saved source is retained; review workspace settings before attaching it.",
              );
            if (!latest.video_ids.includes(video.id)) {
              if (pendingImports.get(campaign.id)?.attached) {
                pendingImports.set(campaign.id, { video, attached: false });
                setPending({ ...video });
                throw new Error(
                  "This source is no longer attached to the workspace. Choose Attach imported footage to add it again deliberately.",
                );
              }
              const saved = await workspaceApi.save(
                {
                  name: latest.name,
                  brief: latest.brief,
                  profile_ids: [...latest.profile_ids],
                  video_ids: sourceIds,
                },
                latest.id,
              );
              if (
                !saved ||
                saved.id !== latest.id ||
                !Array.isArray(saved.video_ids) ||
                !saved.video_ids.includes(video.id) ||
                !Array.isArray(saved.profile_ids) ||
                !saved.profile_ids.includes(w.profileId)
              )
                throw new Error(
                  "Campaign attachment was not confirmed. Your saved source is retained; check the workspace before retrying.",
                );
            }
            pendingImports.set(campaign.id, { video, attached: true });
            added = video;
            setPhase("refreshing");
          } catch (e) {
            failure =
              e instanceof Error
                ? e.message
                : "The import could not be confirmed.";
            setError(failure);
            throw e;
          }
        },
        "Footage added to this workspace.",
        campaign.id,
      );
      if (ok && added) {
        setRefreshReturned(true);
        void autoProduce(added);
      } else {
        setPhase(null);
        setError(
          failure ||
            (imported.current
              ? "Your source is retained. Refresh the workspace to confirm its attachment."
              : "No import was confirmed. Refresh the workspace before trying again."),
        );
      }
    } finally {
      lock.current = false;
      if (picker.current) picker.current.value = "";
    }
  }

  async function checkImport() {
    if (checkingImport || importing || !campaign) return;
    setCheckingImport(true);
    try {
      await Promise.all([factory.refresh(["videos"]), w.load(campaign.id)]);
      setCheckedImport(true);
    } catch {
      setError(
        "Local footage could not be refreshed. Keep this upload pending and check again.",
      );
    } finally {
      setCheckingImport(false);
    }
  }
  function useSavedImport(video: Video) {
    if (!campaign || recoveryBlocked || checkingImport) return;
    pendingImports.set(campaign.id, { video, attached: false });
    unknownImports.delete(campaign.id);
    imported.current = video;
    setPending(video);
    setUnknown(undefined);
    setCheckedImport(false);
    setError("");
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
      <FactoryWorkflow />
      <div
        className={`gf-upload-stage gf-card${dragging ? " is-dragging" : ""}`}
        hidden={importing || !!pending || !!unknown || phase === "ready"}
        onDragOver={(e) => {
          e.preventDefault();
          if (!blocked && !pending && !unknown && !importing) setDragging(true);
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
          disabled={blocked || !!pending || !!unknown || importing}
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
          disabled={blocked || !!pending || !!unknown || importing}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void attach(file);
          }}
        />
        <p className="gf-upload-stage-note">
          {reviewPreview
            ? "Preview adds an illustrative placeholder; file contents stay unread."
            : "Saved on this Mac. Your engine’s automation settings still apply."}
        </p>
      </div>
      {error && (
        <p className="gf-message error" role="alert">
          {error}
        </p>
      )}
      {success && phase !== "ready" && (
        <p className="gf-message success" role="status">
          {success}
        </p>
      )}
      {importing && (
        <JourneyProgress
          label="Import"
          state={
            phase === "uploading"
              ? "uploading"
              : phase === "attaching"
                ? "attaching"
                : "refreshing"
          }
          step={0}
          title={
            phase === "uploading"
              ? "Saving your footage"
              : phase === "attaching"
                ? "Attaching saved footage"
                : "Confirming your workspace"
          }
          message={
            phase === "uploading"
              ? "Transferring the file and preparing its metadata. Waiting for local confirmation."
              : phase === "attaching"
                ? "Your source is saved. Adding it to this workspace."
                : "Confirming the saved source and campaign attachment."
          }
          receipts={
            phase === "refreshing"
              ? ["Source saved", "Campaign attachment confirmed"]
              : pending
                ? ["Source saved"]
                : []
          }
        />
      )}
      {phase === "ready" && lastAdded && (
        <JourneyProgress
          label="Import"
          state="ready"
          step={1}
          title="Footage is in"
          message={success}
          source={
            campaign?.video_ids.includes(lastAdded.id)
              ? sourceLabel(lastAdded.id, campaign.video_ids)
              : "New source"
          }
          receipts={["Source saved", "Campaign attachment confirmed"]}
          actions={
            <>
              <button
                className="gf-button"
                disabled={w.busy || w.loading}
                onClick={() => onProduce(lastAdded.id, "agent")}
              >
                Find clips
                <Icon name="arrow" size={15} />
              </button>
              <button
                className="gf-button ghost"
                disabled={w.busy || w.loading}
                onClick={() => onProduce(lastAdded.id, "manual")}
              >
                Choose a moment
              </button>
              <button
                className="gf-button ghost"
                disabled={blocked}
                onClick={() => {
                  setPhase(null);
                  picker.current?.click();
                }}
              >
                Add another video
              </button>
            </>
          }
        >
          <SourceDetails source={lastAdded} />
        </JourneyProgress>
      )}
      {pending && !importing && (
        <JourneyProgress
          label="Import recovery"
          state="error"
          step={0}
          title={
            pendingImports.get(campaign?.id || "")?.attached
              ? "Saved source needs a refresh"
              : "Your source is saved"
          }
          message={
            pendingImports.get(campaign?.id || "")?.attached
              ? "Attachment was confirmed. Refresh to reopen the saved source; the file will not be uploaded again."
              : "Campaign attachment still needs confirmation. Your next attempt reuses the saved source."
          }
          receipts={["Source saved"]}
          actions={
            <button
              type="button"
              className="gf-button secondary compact"
              disabled={recoveryBlocked}
              onClick={() => void attach()}
            >
              {pendingImports.get(campaign?.id || "")?.attached
                ? "Refresh saved source"
                : "Attach imported footage"}
            </button>
          }
        >
          <SourceDetails source={pending} />
        </JourneyProgress>
      )}
      {unknown && (
        <JourneyProgress
          label="Import recovery"
          state="uncertain"
          step={0}
          title="Let’s confirm your upload"
          message="The service did not confirm a source ID. Check local footage and choose the saved source before attaching it. Uploading again stays locked."
          actions={
            <button
              className="gf-button secondary"
              disabled={checkingImport || importing || w.busy || w.loading}
              onClick={() => void checkImport()}
            >
              {checkingImport
                ? "Checking local footage…"
                : "Check local footage"}
            </button>
          }
        >
          {checkedImport && (
            <div className="gf-import-candidates">
              {factory.errors.videos ? (
                <p role="alert">
                  Local footage is unavailable. Check again before assuming the
                  upload failed.
                </p>
              ) : candidates.length ? (
                <>
                  <p>
                    Confirm the original filename and source ID before choosing
                    a saved source.
                  </p>
                  {candidates.map((candidate) => (
                    <div className="gf-import-candidate" key={candidate.id}>
                      <SourceDetails source={candidate} />
                      <button
                        className="gf-button secondary compact"
                        disabled={recoveryBlocked || checkingImport}
                        onClick={() => useSavedImport(candidate)}
                      >
                        Use saved source {candidate.id.slice(0, 8)}
                      </button>
                    </div>
                  ))}
                </>
              ) : (
                <p>
                  No matching saved source is confirmed yet. Check again; the
                  original request may still be finishing.
                </p>
              )}
            </div>
          )}
        </JourneyProgress>
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
            <JourneyProgress
              key={job.id}
              label="Production"
              state="working"
              step={1}
              title={
                job.status === "queued"
                  ? "Your edits are queued"
                  : job.kind === "render"
                    ? "Shaping your edit"
                    : "Working through your footage"
              }
              message={
                job.message ||
                (job.status === "queued"
                  ? "Waiting for the local worker."
                  : "The local worker has not reported a detailed stage yet.")
              }
              progress={job.progress}
              source={
                sourceForJob(job)
                  ? sourceLabel(sourceForJob(job)!, scope.sourceIds)
                  : undefined
              }
              actions={
                <button
                  className="gf-button secondary compact"
                  disabled={w.busy || w.loading}
                  onClick={() => onProduce(sourceForJob(job), "agent")}
                >
                  View production
                  <Icon name="arrow" size={15} />
                </button>
              }
            >
              <Pill>{job.status}</Pill>
            </JourneyProgress>
          ))}
        </section>
      )}
      {!jobs.length && failedJob && (
        <JourneyProgress
          label="Production"
          state="error"
          step={1}
          title="Production needs attention"
          message={
            failedJob.error ||
            failedJob.message ||
            `The worker reported ${failedJob.status}. Review its saved status before retrying.`
          }
          actions={
            <button
              className="gf-button secondary"
              onClick={() => onProduce(sourceForJob(failedJob), "agent")}
            >
              Review production status
              <Icon name="arrow" size={15} />
            </button>
          }
        />
      )}
      {!jobs.length && !failedJob && waitingForOutputs && (
        <JourneyProgress
          label="Production"
          state="refreshing"
          step={1}
          title="Waiting for the saved edits"
          message="The worker reported completion, but no matching clip records are available in this workspace yet."
          actions={
            <button
              className="gf-button secondary"
              disabled={factory.loading}
              onClick={() => void factory.refresh(["jobs", "clips"])}
            >
              Refresh outputs
            </button>
          }
        />
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
              onClick={() => onReview(review[0])}
            >
              Review clips
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
                <span
                  className="gf-cut-art"
                  style={
                    reviewPreview || clip.provenance_mode === "preview_fixture"
                      ? undefined
                      : {
                          backgroundImage: `url(${endpoint("clips", clip.id, "cover")})`,
                        }
                  }
                >
                  <Icon name="play" size={28} />
                  <span>
                    {reviewPreview || clip.provenance_mode === "preview_fixture"
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
              const status = line?.sources.find(
                (item) => item.video_id === source.id,
              );
              const working =
                status?.state === "queued" || status?.state === "working";
              const ready =
                !!direction &&
                !!modelId &&
                !!status?.can_produce &&
                !w.busy &&
                !w.loading;
              // Counts are for this workspace: clips made elsewhere from the same file do not belong here.
              const own = clips.filter((c) => c.video_id === source.id);
              const waiting = own.filter((c) => !c.approved).length;
              const headline =
                !status ||
                working ||
                status.state === "failed" ||
                status.state === "cancelled"
                  ? status?.error || status?.headline
                  : waiting
                    ? `${waiting} clip${waiting === 1 ? "" : "s"} ready for review`
                    : own.length
                      ? `${own.length} clip${own.length === 1 ? "" : "s"} approved`
                      : "Ready to make clips";
              return (
                <div
                  className="gf-source-entry gf-footage-item"
                  key={source.id}
                >
                  <div className="gf-footage-row">
                    <span className="gf-footage-icon">
                      <Icon name="studio" size={22} />
                    </span>
                    <div className="gf-footage-copy">
                      <strong>
                        {sourceLabel(source.id, campaign?.video_ids || [])}
                      </strong>
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
                  <SourceDetails source={source} />
                  {status && (
                    <div className="gf-footage-line">
                      <div className="source-card-body">
                        <Stages source={status} />
                        <p className="gf-footage-status" role="status">
                          {headline}
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
                              current[source.id] === open
                                ? current
                                : { ...current, [source.id]: open },
                            );
                          }}
                        >
                          <summary>
                            <Icon name="play" />
                            What the factory saw · {
                              status.storyboard.scenes
                            }{" "}
                            scenes
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
