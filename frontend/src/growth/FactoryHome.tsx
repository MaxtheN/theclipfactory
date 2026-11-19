import { useEffect, useRef, useState, type DragEvent } from "react";
import { SHOW_FACTORY_MAP } from "./appEvents";
import { FirstRunInstagram } from "./FirstRunInstagram";
import { ClipStyleSheet } from "./ClipStyle";
import type { Clip, Job, TeamRun, Video } from "../types";
import { ApiError, endpoint, post } from "../api";
import { Storyboard } from "../components/Storyboard";
import { Stages } from "../components/Stages";
import type { FactoryState } from "../useFactory";
import { activeRulesId, type Workspace } from "./useCampaignWorkspace";
import { workspaceApi, reviewPreview } from "./workspaceApi";
import { productionApi } from "./productionApi";
import { jobInScope, object, undirected } from "./productionState";
import { activeJob } from "../productionPreflight";
import { Icon } from "./Icon";
import { Pill, formatTime } from "./parts";
import { JourneyProgress } from "./JourneyProgress";
import { reviewOrder } from "./clipRanking";
import { sourceLabel, SourceDetails } from "./sourcePresentation";
import { SpeechSetup, engineOf, speechBlocked } from "./SpeechSetup";
import { AgentSetup, agentsBlocker } from "./AgentSetup";
import { platformWords } from "../platform";

export type OpenProduction = (
  sourceId?: string,
  mode?: "manual" | "agent",
  clipId?: string,
) => void;
export type LibraryView = "edits" | "wall" | "footage";

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
  onSettings,
  active = true,
}: {
  w: Workspace;
  factory: FactoryState;
  onProduce: OpenProduction;
  onReview: (clip: Clip) => void;
  onLibrary: (view?: LibraryView) => void;
  onDirection: () => void;
  /** Opens Settings > Models, where a local model is set up. */
  onSettings?: () => void;
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
          : autopilot && !direction
            ? "Source saved. The factory starts making clips from it as soon as you pick a clip style."
            : "Source saved and added to this brand.",
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
  // Clips made from this footage without a direction belong on this screen too.
  const loose = factory.data.clips.filter((c) =>
    undirected(c, campaign?.video_ids || []),
  );
  /** Directed edits are reviewed in the Studio; the rest on the Library's review wall. */
  const openReview = (clip: Clip) =>
    clip.campaign_id ? onReview(clip) : onLibrary("wall");
  // Every campaign inherits its workspace's approved Style rules.
  const rulesId = activeRulesId(w);
  const direction = w.versions.find((v) => v.id === rulesId)?.directions[
    w.profileId
  ];
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
  /** The "Episode added" card follows the source's real job state, never what was hoped for. */
  const added = (() => {
    const status = lastAdded
      ? factory.data.factory?.sources.find((s) => s.video_id === lastAdded.id)
      : undefined;
    const ready = lastAdded
      ? reviewOrder(
          [...clips, ...loose].filter(
            (c) => c.video_id === lastAdded.id && !c.approved,
          ),
        ).above
      : [];
    if (status?.state === "queued" || status?.state === "working")
      return {
        state: "working" as const,
        step: 1 as const,
        current: true,
        message: status.headline,
        progress: status.progress,
      };
    if (ready.length)
      return {
        state: "review" as const,
        step: 2 as const,
        current: true,
        message: `${ready.length} clip${ready.length === 1 ? "" : "s"} ready`,
        review: ready[0],
      };
    if (status?.state === "failed" || status?.state === "cancelled")
      return {
        state: "error" as const,
        step: 1 as const,
        current: true,
        message: status.error || status.headline,
      };
    const notStarted =
      !!lastAdded && success.includes("did not start by itself") ? success : "";
    return {
      state: "ready" as const,
      step: 1 as const,
      current: false,
      message:
        notStarted ||
        (status && !status.can_produce && status.blocked_reason) ||
        "Ready. Press Find clips.",
    };
  })();
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
    const strategyId = rulesId;
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
  async function autoProduce(
    video: Video,
    started = `${video.name} added and queued for production. Its progress shows below.`,
  ) {
    const strategyId = rulesId;
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
      setSuccess(started);
    } catch (e) {
      setSuccess(
        `Production of ${video.name} did not start by itself: ${
          e instanceof Error ? e.message : "try Find clips."
        }`,
      );
    }
  }
  // Footage is often added before a clip style is approved, and autopilot cannot run without one.
  // The moment a style is approved, sources nothing has been made from start on their own.
  const directed = useRef<boolean | null>(null); // null until the workspace has loaded once
  useEffect(() => {
    if (w.loading || !campaign) return;
    const before = directed.current;
    directed.current = !!direction;
    if (before !== false || !direction) return;
    for (const source of sources) {
      const status = line?.sources.find((item) => item.video_id === source.id);
      if (
        status?.state === "idle" &&
        status.can_produce &&
        !status.run_id &&
        !factory.data.clips.some((c) => c.video_id === source.id)
      )
        void autoProduce(
          source,
          `Style approved. ${source.name} is queued for production. Its progress shows below.`,
        );
    }
  }, [w.loading, campaign?.id, !!direction]);

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
        "This brand already has 100 sources. Remove or archive some before importing more footage.",
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
                "Your brand changed. Refresh before adding this footage.",
              );
            const sourceIds = [...new Set([...latest.video_ids, video.id])];
            if (sourceIds.length > 100)
              throw new Error(
                "This brand reached its 100-source limit. Your saved source is kept; free a slot before adding it.",
              );
            if (!latest.video_ids.includes(video.id)) {
              if (pendingImports.get(campaign.id)?.attached) {
                pendingImports.set(campaign.id, { video, attached: false });
                setPending({ ...video });
                throw new Error(
                  "This source is no longer in this brand. Choose Attach imported footage to add it again deliberately.",
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
                  "Adding it to your brand was not confirmed. Your saved source is kept; refresh before retrying.",
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
        "Footage added.",
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
              ? "Your source is kept. Refresh to confirm it was added."
              : "No import was confirmed. Refresh before trying again."),
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
    if (file) firstClip(file);
  }
  /** First episode: start the import, then show the Factory map so the stations can be watched. */
  function firstClip(file: File) {
    const first = !sources.length;
    void attach(file);
    if (first) window.dispatchEvent(new Event(SHOW_FACTORY_MAP));
  }

  return (
    <div className="gf-factory-home">
      <div
        className={`gf-upload-stage gf-card${dragging ? " is-dragging" : ""}${sources.length ? " is-compact" : " is-first-run"}`}
        hidden={importing || !!pending || !!unknown}
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
          <Icon name="upload" size={26} />
        </span>
        {sources.length ? (
          <div>
            <h2>Add an episode</h2>
            <p>Drop a video here, or choose a file.</p>
          </div>
        ) : (
          <div>
            <h2>Drop an episode — your first clips in a few minutes</h2>
            <p>
              About a few minutes per 10 minutes of footage.
            </p>
          </div>
        )}
        <button
          type="button"
          className="gf-button"
          disabled={blocked || !!pending || !!unknown || importing}
          onClick={() => picker.current?.click()}
        >
          <Icon name="plus" size={16} />
          Add episode
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
            if (file) firstClip(file);
          }}
        />
      </div>
      {/* No approved Style rules yet: pick a clip style right here instead of a dead end. */}
      {!direction && sources.length > 0 && (
        <ClipStyleSheet w={w} onFullRules={onDirection} />
      )}
      {/* No local model: name the owning Settings section instead of a dead end. */}
      {/* Off the Mac: Ollama, the model download or the hardware check, with alternatives. */}
      {!!direction && agentsBlocker(factory) && <AgentSetup factory={factory} />}
      {line && !modelId && !!direction && onSettings && !agentsBlocker(factory) && (
        <p className="gf-message" role="status">
          Finding clips needs a local model.{" "}
          <button type="button" className="gf-link-button" onClick={onSettings}>
            Open Settings → Models
          </button>
        </p>
      )}
      {/* First run: the one-time engine downloads, with progress, before footage can be heard. */}
      {speechBlocked(engineOf(factory)) && (
        <SpeechSetup factory={factory} variant="engine" />
      )}
      {!sources.length && !importing && !pending && !unknown && w.profileId && (
        <FirstRunInstagram profileId={w.profileId} />
      )}
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
                : "Adding it to your brand"
          }
          message={
            phase === "uploading"
              ? `Saving the file on ${platformWords().computer}.`
              : phase === "attaching"
                ? "Saved. Adding it to your brand."
                : "Confirming the episode is attached."
          }
          receipts={
            phase === "refreshing"
              ? ["Source saved", "Added to your brand"]
              : pending
                ? ["Source saved"]
                : []
          }
        />
      )}
      {phase === "ready" && lastAdded && (
        <JourneyProgress
          label="Import"
          state={added.state}
          step={added.step}
          current={added.current}
          title="Episode added"
          message={added.message}
          progress={added.progress}
          source={
            campaign?.video_ids.includes(lastAdded.id)
              ? sourceLabel(lastAdded.id, campaign.video_ids)
              : "New source"
          }
          receipts={["Source saved", "Added to your brand"]}
          actions={
            added.review ? (
              <button
                className="gf-button primary"
                onClick={() => openReview(added.review!)}
              >
                Review
                <Icon name="arrow" size={15} />
              </button>
            ) : (
              <button
                className="gf-button"
                disabled={w.busy || w.loading}
                onClick={() => onProduce(lastAdded.id, "agent")}
              >
                {added.state === "working" ? "View production" : "Find clips"}
                <Icon name="arrow" size={15} />
              </button>
            )
          }
        />
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
              : "Adding it to your brand still needs confirmation. Your next attempt reuses the saved source."
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
          message="The worker reported completion, but no matching clips are here yet."
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

      {sources.length > 0 && (
        <section
          className="gf-home-section gf-episodes"
          aria-labelledby="factory-footage-heading"
        >
          <header>
            <h2 id="factory-footage-heading">
              Episodes <span className="gf-inline-count">{sources.length}</span>
            </h2>
          </header>
          <div className="gf-footage-list">
            {sources.map((source, index) => {
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
              // Counts cover this workspace's edits and what the engine made from this file with no direction;
              // another workspace's edits of the same file do not belong here.
              const own = [...clips, ...loose].filter(
                (c) => c.video_id === source.id && !c.made_without_speech,
              );
              // Best first; clips under the quality floor stay saved but are not counted here.
              const ordered = reviewOrder(own.filter((c) => !c.approved));
              const unreviewed = ordered.above;
              const lowCount = ordered.below.length;
              const illustrative = unreviewed.some(
                (c) => reviewPreview || c.provenance_mode === "preview_fixture",
              );
              const label = sourceLabel(source.id, campaign?.video_ids || []);
              const headline =
                !status ||
                working ||
                status.state === "failed" ||
                status.state === "cancelled"
                  ? status?.error || status?.headline
                  : unreviewed.length
                    ? `${unreviewed.length} clip${unreviewed.length === 1 ? "" : "s"} ready${lowCount ? ` · ${lowCount} below the bar` : ""}`
                    : lowCount
                      ? `${lowCount} clip${lowCount === 1 ? "" : "s"} below the bar`
                      : own.length
                      ? `${own.length} clip${own.length === 1 ? "" : "s"} generated`
                      : status.blocked_code?.startsWith("asr_") && status.blocked_reason
                        ? status.blocked_reason
                        : "Ready to make clips";
              let action;
              if (working && status?.job_id)
                action = (
                  <button
                    type="button"
                    className="gf-button ghost compact"
                    onClick={() => void cancel(status.job_id!)}
                  >
                    Cancel
                  </button>
                );
              else if (unreviewed.length)
                action = (
                  <button
                    type="button"
                    className="gf-button primary compact"
                    onClick={() => openReview(unreviewed[0])}
                  >
                    Open {unreviewed.length} clip
                    {unreviewed.length === 1 ? "" : "s"}
                    <Icon name="arrow" size={15} />
                  </button>
                );
              else if (status && !working)
                action = (
                  <button
                    type="button"
                    className="gf-button secondary compact"
                    disabled={!ready}
                    title={
                      !direction
                        ? "Pick your clip style first."
                        : !modelId
                          ? "Set up a local model in Settings → Models."
                          : status.blocked_reason || undefined
                    }
                    onClick={() => void makeClips(source)}
                  >
                    Find clips
                  </button>
                );
              else if (!status)
                action = (
                  <button
                    type="button"
                    className="gf-button secondary compact"
                    disabled={w.busy || w.loading}
                    onClick={() => onProduce(source.id, "agent")}
                  >
                    Find clips
                    <Icon name="arrow" size={15} />
                  </button>
                );
              return (
                <div
                  className="gf-source-entry gf-footage-item"
                  key={source.id}
                >
                  <div className="gf-footage-row">
                    <span className="gf-footage-icon">
                      <Icon name="studio" size={20} />
                    </span>
                    <div className="gf-footage-copy">
                      <strong>{label}</strong>
                      <span>
                        {reviewPreview
                          ? "Illustrative source"
                          : formatTime(source.duration)}
                        {source.has_audio === false
                          ? " · No speech in this footage"
                          : source.has_audio === true && source.transcript == null
                            ? " · Speech not transcribed yet"
                            : ""}
                      </span>
                    </div>
                    {illustrative && <Pill tone="sand">Illustrative edit</Pill>}
                    {action}
                    {(status || unreviewed.length > 0) && (
                      <button
                        type="button"
                        className="gf-icon-button gf-row-open"
                        aria-label={`Open ${label} in the studio`}
                        title="Open in the studio"
                        disabled={w.busy || w.loading}
                        onClick={() => onProduce(source.id, "agent")}
                      >
                        <Icon name="arrow" size={16} />
                      </button>
                    )}
                    {!(status || unreviewed.length > 0) && (
                      // Keeps every row's main action on the same right edge.
                      <span className="gf-row-open-spacer" aria-hidden="true" />
                    )}
                  </div>
                  {status && (
                    <div className="gf-footage-line">
                      <div className="source-card-body">
                        {working && <Stages source={status} />}
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
        </section>
      )}
    </div>
  );
}
