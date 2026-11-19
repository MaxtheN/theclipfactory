import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, endpoint, post } from "../api";
import type { Campaign, Clip, FactoryLine, Job } from "../types";
import type { FactoryState } from "../useFactory";
import { Icon } from "./Icon";
import { PanelDialog } from "./PanelDialog";
import type { SettingsSection } from "./SettingsScreen";
import "./activity.css";

/** The screen that holds a Job's outputs or its recovery actions. */
export type ActivityTarget =
  | { to: "source"; videoId: string }
  | { to: "clip"; clip: Clip }
  | { to: "settings"; section: SettingsSection }
  | { to: "results" }
  | { to: "research" };

/** The subset of a publish attempt (GET /api/publish-attempts) the Activity Center reads. */
export interface PublishAttemptSummary {
  id: string;
  clip_id?: string | null;
  campaign_id?: string | null;
  account_name?: string | null;
  state: string;
  error?: string | null;
  created_at?: string;
  updated_at?: string;
  history?: { at?: string; state?: string; note?: string }[];
}

export interface ActivityItem {
  id: string;
  type: string;
  campaign?: string;
  stage: string;
  status: "active" | "failed" | "done" | "cancelled" | "waiting";
  updatedAt?: string;
  progress?: number;
  reason?: string;
  failedStage?: string;
  /** "production" also discloses that finished clips are kept. */
  cancel?: { jobId: string; production: boolean };
  target?: ActivityTarget;
}

const PRODUCTION = new Set(["swarm", "team", "pipeline", "baseline"]);
/** Jobs whose external effects cannot be stopped part-way; they are never offered for cancellation. */
const NO_CANCEL = new Set(["publish", "reconcile", "paid_preflight"]);
const MODELS = new Set(["download", "speech_setup", "runtime", "inference", "narration"]);
const RESULTS = new Set(["insights", "paid_insights", "paid_preflight", "learning_analysis", "strategist", "publish", "reconcile"]);
const labels: Record<string, string> = {
  swarm: "Production run",
  pipeline: "Production run",
  team: "Team production run",
  baseline: "Baseline production run",
  transcribe: "Listening",
  analyze: "Moment analysis",
  storyboard: "Watch pass",
  render: "Render",
  download: "Model download",
  speech_setup: "Speech setup",
  runtime: "Runtime setup",
  inference: "Local inference",
  narration: "Narration",
  publish: "Instagram post",
  reconcile: "Post check",
  insights: "Results check",
  paid_insights: "Paid results check",
  paid_preflight: "Ad preflight",
  learning_analysis: "Learning analysis",
  brand_research: "Brand research",
  creative_assessment: "Creative score",
  factory_build: "Factory upgrade",
  post_copy: "Post copy",
  reference_research: "Reference research",
  strategist: "Strategist",
};
const attemptStages: Record<string, string> = {
  scheduled: "Scheduled",
  created: "Queued to post",
  uploading: "Uploading",
  uploaded: "Uploaded",
  container_created: "Instagram is processing",
  container_ready: "Ready to publish",
  published: "Published",
  mapped: "Posted",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Outcome unknown",
};
const RECENT_MS = 24 * 60 * 60 * 1000;
const SEEN_KEY = "gf-activity-seen-v1";

const typeOf = (kind: string) =>
  labels[kind] ?? kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const time = (iso?: string) => (iso ? Date.parse(iso) : NaN);
const context = (job: Job) =>
  (job.context && typeof job.context === "object" ? job.context : {}) as Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

function campaignFor(campaigns: Campaign[], clips: Clip[], ids: { video?: string; clip?: string; campaign?: string }) {
  const id = ids.campaign ?? clips.find((c) => c.id === ids.clip)?.campaign_id ?? undefined;
  if (id) return campaigns.find((c) => c.id === id)?.name;
  if (ids.video) return campaigns.find((c) => c.video_ids.includes(ids.video!))?.name;
  return undefined;
}

function failedStageOf(job: Job, line: FactoryLine | null) {
  const source = line?.sources.find((s) => s.job_id === job.id);
  return source?.stages.find((s) => s.status === "failed")?.label;
}

function targetOf(kind: string, ctx: Record<string, unknown>, clips: Clip[]): ActivityTarget | undefined {
  const clipId = text(ctx.clip_id);
  const clip = clipId ? clips.find((c) => c.id === clipId) : undefined;
  if (RESULTS.has(kind)) return { to: "results" };
  if (clip) return { to: "clip", clip };
  const video = text(ctx.video_id);
  if (video) return { to: "source", videoId: video };
  if (MODELS.has(kind)) return { to: "settings", section: "models" };
  if (kind === "reference_research") return { to: "research" };
  return undefined;
}

/** Jobs and publishing attempts as one list: active first, then the last day's work. */
export function activityItems(
  jobs: Job[],
  attempts: PublishAttemptSummary[],
  { campaigns, clips, line, now = Date.now() }: { campaigns: Campaign[]; clips: Clip[]; line: FactoryLine | null; now?: number },
): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const job of jobs) {
    const ctx = context(job);
    const status: ActivityItem["status"] =
      job.status === "queued" || job.status === "running" ? "active"
        : job.status === "failed" ? "failed"
          : job.status === "cancelled" ? "cancelled" : "done";
    const updatedAt = job.updated_at ?? job.created_at;
    if (status !== "active" && !(now - time(updatedAt) < RECENT_MS)) continue;
    items.push({
      id: `job:${job.id}`,
      type: typeOf(job.kind),
      campaign: campaignFor(campaigns, clips, { video: text(ctx.video_id), clip: text(ctx.clip_id), campaign: text(ctx.campaign_id) }),
      stage: job.status === "queued" ? "Queued" : job.message || (status === "done" ? "Completed" : job.status),
      status,
      updatedAt,
      progress: job.status === "running" && typeof job.progress === "number" && Number.isFinite(job.progress)
        ? Math.max(0, Math.min(100, job.progress)) : undefined,
      reason: status === "failed" ? job.error || "No reason was reported." : undefined,
      failedStage: status === "failed" ? failedStageOf(job, line) : undefined,
      cancel: status === "active" && !NO_CANCEL.has(job.kind) ? { jobId: job.id, production: PRODUCTION.has(job.kind) } : undefined,
      target: targetOf(job.kind, ctx, clips),
    });
  }
  for (const attempt of attempts) {
    const updatedAt = attempt.updated_at ?? attempt.created_at;
    const failed = attempt.state === "failed" || attempt.state === "unknown";
    const status: ActivityItem["status"] = failed ? "failed"
      : attempt.state === "mapped" || attempt.state === "published" ? "done"
        : attempt.state === "cancelled" ? "cancelled"
          : attempt.state === "scheduled" ? "waiting" : "active";
    if (status !== "active" && status !== "waiting" && !(now - time(updatedAt) < RECENT_MS)) continue;
    const before = [...(attempt.history ?? [])].reverse().find((h) => h.state && h.state !== "failed" && h.state !== "unknown")?.state;
    items.push({
      id: `post:${attempt.id}`,
      type: attempt.account_name ? `Instagram post to ${attempt.account_name}` : "Instagram post",
      campaign: campaignFor(campaigns, clips, { clip: attempt.clip_id ?? undefined, campaign: attempt.campaign_id ?? undefined }),
      stage: attemptStages[attempt.state] ?? attempt.state,
      status,
      updatedAt,
      reason: failed
        ? attempt.error || (attempt.state === "unknown" ? "The outcome is unknown. Check the post on Instagram before trying again." : "No reason was reported.")
        : undefined,
      failedStage: failed && before ? attemptStages[before] ?? before : undefined,
      target: { to: "results" },
    });
  }
  const rank = (i: ActivityItem) => (i.status === "active" ? 0 : i.status === "waiting" ? 1 : 2);
  return items
    .sort((a, b) => rank(a) - rank(b) || (time(b.updatedAt) || 0) - (time(a.updatedAt) || 0))
    .slice(0, 40);
}

function readSeen() {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

const shortTime = (iso?: string) => {
  const at = time(iso);
  return Number.isFinite(at)
    ? new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "Time not reported";
};

const finished: Record<ActivityItem["status"], string> = {
  active: "started",
  waiting: "is waiting",
  done: "finished",
  failed: "failed",
  cancelled: "was cancelled",
};

/** The shell's single place for what the factory is doing and what failed. */
export function ActivityCenter({
  factory,
  campaigns,
  disabled = false,
  openRequest = 0,
  onOpen,
}: {
  factory: FactoryState;
  campaigns: Campaign[];
  disabled?: boolean;
  /** Increment to open the panel from elsewhere (quick actions). */
  openRequest?: number;
  onOpen: (target: ActivityTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const [attempts, setAttempts] = useState<PublishAttemptSummary[]>([]);
  const [attemptsError, setAttemptsError] = useState(false);
  const [seen, setSeen] = useState(readSeen);
  const [announcement, setAnnouncement] = useState("");
  const [cancelError, setCancelError] = useState("");
  const loadAttempts = useCallback(async () => {
    try {
      const rows = await api<PublishAttemptSummary[]>("/api/publish-attempts");
      setAttempts(Array.isArray(rows) ? rows : []);
      setAttemptsError(false);
    } catch {
      setAttemptsError(true);
    }
  }, []);
  useEffect(() => {
    void loadAttempts();
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadAttempts();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [loadAttempts]);

  const jobsUnavailable = !!factory.errors.jobs;
  const items = useMemo(
    () => activityItems(jobsUnavailable ? [] : factory.data.jobs, attempts, {
      campaigns,
      clips: factory.data.clips,
      line: factory.data.factory,
    }),
    [jobsUnavailable, factory.data.jobs, factory.data.clips, factory.data.factory, attempts, campaigns],
  );
  const active = items.filter((i) => i.status === "active").length;
  const attention = items.some((i) => i.status === "failed" && (time(i.updatedAt) || Infinity) > seen);

  // Announce each status change once; the first load is not a change.
  const previous = useRef<Map<string, ActivityItem["status"]> | null>(null);
  useEffect(() => {
    const now = new Map(items.map((i) => [i.id, i.status]));
    if (previous.current) {
      const changed = items.filter((i) => previous.current!.get(i.id) !== i.status && (previous.current!.has(i.id) || i.status === "active"));
      if (changed.length)
        setAnnouncement(changed.slice(0, 3).map((i) => `${i.type} ${finished[i.status]}.`).join(" "));
    }
    previous.current = now;
  }, [items]);

  function show() {
    setOpen(true);
    setCancelError("");
    void loadAttempts();
    const stamp = Date.now();
    setSeen(stamp);
    try {
      localStorage.setItem(SEEN_KEY, String(stamp));
    } catch {
      /* preference only */
    }
  }
  const lastRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === lastRequest.current) return;
    lastRequest.current = openRequest;
    show();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open only on a new request
  }, [openRequest]);
  async function cancel(item: ActivityItem) {
    if (!item.cancel) return;
    const question = item.cancel.production
      ? `Stop this ${item.type.toLowerCase()}? Clips that are already finished are kept.`
      : `Cancel this ${item.type.toLowerCase()}?`;
    if (!window.confirm(question)) return;
    setCancelError("");
    try {
      await post(endpoint("jobs", item.cancel.jobId, "cancel"));
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : "Cancellation could not be requested.");
    } finally {
      void factory.refresh(["jobs", "factory"]);
    }
  }

  const label = `Activity: ${active ? `${active} active` : "nothing running"}${attention ? ", a failure needs attention" : ""}`;
  const current = items.filter((i) => i.status === "active" || i.status === "waiting");
  const recent = items.filter((i) => i.status !== "active" && i.status !== "waiting");
  const row = (item: ActivityItem) => (
    <li key={item.id} className={`gf-activity-item is-${item.status}`}>
      <div className="gf-activity-row">
        <strong>{item.type}</strong>
        <span className={`gf-pill quiet gf-activity-status is-${item.status}`}>
          {item.status === "active" ? "Running" : item.status === "waiting" ? "Waiting" : item.status === "failed" ? "Failed" : item.status === "cancelled" ? "Cancelled" : "Done"}
        </span>
      </div>
      <p className="gf-activity-meta">
        {item.campaign && <span>{item.campaign}</span>}
        {item.status !== "failed" && <span>{item.stage}</span>}
        <span>Updated {shortTime(item.updatedAt)}</span>
      </p>
      {item.progress !== undefined && (
        <label className="gf-activity-progress">
          <span>{Math.round(item.progress)}% reported</span>
          <progress max={100} value={item.progress} />
        </label>
      )}
      {item.status === "failed" && (
        <p className="gf-activity-failure">
          <strong>{item.failedStage ? `Failed while ${item.failedStage.toLowerCase()}` : "Failed (stage not reported)"}:</strong> {item.reason}
        </p>
      )}
      {(item.target || item.cancel) && (
        <div className="gf-activity-actions">
          {item.target && (
            <button type="button" className="gf-button secondary compact" onClick={() => { setOpen(false); onOpen(item.target!); }}>
              {item.status === "failed" ? "Open to fix" : "Open"}
              <Icon name="arrow" size={14} />
            </button>
          )}
          {item.cancel && (
            <button type="button" className="gf-button ghost compact" disabled={factory.busy} onClick={() => void cancel(item)}>
              Cancel
            </button>
          )}
        </div>
      )}
    </li>
  );

  return (
    <>
      <button
        type="button"
        className={`gf-command-trigger gf-activity-trigger${attention ? " has-attention" : ""}`}
        aria-label={label}
        aria-haspopup="dialog"
        title={label}
        disabled={disabled}
        onClick={show}
      >
        <Icon name="clock" size={16} />
        <span>Activity</span>
        {active > 0 && <span className="gf-activity-count" aria-hidden="true">{active}</span>}
        {attention && <span className="gf-activity-alert" aria-hidden="true" />}
      </button>
      <p className="gf-activity-sr" role="status" aria-live="polite">{announcement}</p>
      <PanelDialog open={open && !disabled} onClose={() => setOpen(false)} title="Activity" description="What the factory is doing on this Mac, and what needs you.">
        <div className="gf-activity">
          {jobsUnavailable && (
            <p className="gf-help" role="alert">Job status unavailable: {factory.errors.jobs}. Reconnect to the local service to see production, render and model jobs.</p>
          )}
          {attemptsError && <p className="gf-help" role="alert">Posting status unavailable. Instagram posts may be missing from this list.</p>}
          {cancelError && <p className="gf-message error" role="alert">{cancelError}</p>}
          {!items.length && !jobsUnavailable && <p className="gf-activity-empty">Nothing is running. Recent jobs from the last day appear here.</p>}
          {current.length > 0 && <section aria-label="Active jobs"><h3>Active</h3><ul>{current.map(row)}</ul></section>}
          {recent.length > 0 && <section aria-label="Recent jobs"><h3>Recent</h3><ul>{recent.map(row)}</ul></section>}
        </div>
      </PanelDialog>
    </>
  );
}
