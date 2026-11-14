/**
 * The factory map's model: a pure function from real API records to the state of every
 * station. Nothing here invents work. A station without data says so in plain words.
 *
 * Inputs are exactly what the local service returns: /api/factory sources, /api/jobs,
 * /api/clips, /api/team/runs, /api/automation/state (+ accounts), /api/strategist/{profile}
 * and the workspace's Style-rules versions.
 */
import type {
  Campaign,
  Clip,
  FactorySource,
  Job,
  StrategyVersion,
  TeamRun,
  TeamTask,
} from "../types";
import type { StrategistView } from "./strategistApi";

export type StationId =
  | "footage"
  | "listen"
  | "watch"
  | "scout"
  | "brief"
  | "editor"
  | "critic"
  | "approve"
  | "post"
  | "measure"
  | "strategist"
  | "rules";
export type Family = "understand" | "create" | "judge" | "ship" | "learn";
/** idle = resting with data; empty = nothing has reached it yet; waiting = needs a person. */
export type StationState =
  | "idle"
  | "active"
  | "done"
  | "waiting"
  | "empty"
  | "failed";

export interface SheetRow {
  label: string;
  value: string;
}
export interface SheetSection {
  title: string;
  rows?: SheetRow[];
  items?: string[];
  note?: string;
}
export interface Station {
  id: StationId;
  title: string;
  agent: string;
  family: Family;
  state: StationState;
  /** One line of live status, from records. */
  status: string;
  counts: { label: string; value: string }[];
  /** The last thing this station produced, or "". */
  last: string;
  sheet: SheetSection[];
  /** Parallel lanes shown on the scout station (swarm stretches), 0 when unknown. */
  lanes: number;
  /** True in a replay for stations the replay does not cover. */
  dim?: boolean;
}
export interface FlowEdge {
  from: StationId;
  to: StationId;
  flowing: boolean;
}
export interface FactoryMapModel {
  stations: Station[];
  edges: FlowEdge[];
  /** Style rules → Scout: lit when a proposal is waiting. */
  returnArc: { lit: boolean; label: string };
  live: boolean;
  runId: string | null;
}

export type Row = Record<string, unknown> & { id: string };
export interface AutomationSnapshot {
  policies: Row[];
  publications: Row[];
  snapshots: Row[];
  work: Row[];
  accounts: Row[];
}
export interface MapInput {
  /** Sources of the current campaign only. */
  sources: FactorySource[];
  jobs: Job[];
  /** Clips of the current campaign and brand. */
  clips: Clip[];
  /** Runs of the current campaign's sources, any order. */
  runs: TeamRun[];
  campaign: Campaign | null;
  versions: StrategyVersion[];
  activeRulesId?: string | null;
  /** null = unavailable (not "zero"). */
  automation: AutomationSnapshot | null;
  strategist: StrategistView | null;
  now: number;
}

export const STATIONS: {
  id: StationId;
  title: string;
  agent: string;
  family: Family;
}[] = [
  { id: "footage", title: "Footage in", agent: "Intake", family: "understand" },
  { id: "listen", title: "Listen", agent: "Whisper transcript", family: "understand" },
  { id: "watch", title: "Watch", agent: "Vision storyboard", family: "understand" },
  { id: "scout", title: "Scout swarm", agent: "Scouts, one per stretch", family: "create" },
  { id: "brief", title: "Brief check", agent: "Must-avoid · key messages", family: "create" },
  { id: "editor", title: "Editor", agent: "Hook-first, captions, cuts", family: "create" },
  { id: "critic", title: "Critic + quality gate", agent: "Critic and ranker", family: "judge" },
  { id: "approve", title: "You approve", agent: "You", family: "judge" },
  { id: "post", title: "Post to Instagram", agent: "Publisher", family: "ship" },
  { id: "measure", title: "Measure", agent: "3 or 6-day window", family: "ship" },
  { id: "strategist", title: "Strategist", agent: "Craft · clip picking · timing", family: "learn" },
  { id: "rules", title: "Style rules update", agent: "Proposals you approve", family: "learn" },
];
export const FAMILY_LABEL: Record<Family, string> = {
  understand: "Understand",
  create: "Create",
  judge: "Judge",
  ship: "Ship",
  learn: "Learn",
};

/** Which station a ledger task belongs to. */
export const ROLE_STATION: Record<string, StationId> = {
  transcribe: "listen",
  watch: "watch",
  reuse_footage: "watch",
  closeup: "watch",
  swarm: "scout",
  producer: "scout",
  footage_analyst: "scout",
  shortlist: "scout",
  performance_analyst: "scout",
  baseline: "scout",
  creative_strategist: "editor",
  editor: "editor",
  render: "editor",
  critic: "critic",
};

const text = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const time = (v: unknown): number | null => {
  const t = Date.parse(text(v));
  return Number.isFinite(t) ? t : null;
};
const plural = (n: number, word: string, many = `${word}s`) =>
  `${n.toLocaleString()} ${n === 1 ? word : many}`;

export function clock(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = s % 60;
  return h
    ? `${h} h ${String(m).padStart(2, "0")} m`
    : `${m}:${String(r).padStart(2, "0")}`;
}
export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
function stamp(v: unknown): string {
  const t = time(v);
  return t === null ? "—" : new Date(t).toLocaleString();
}

const ACTIVE_RUN = new Set(["queued", "running"]);
/** Newest first by created_at. */
export function sortRuns(runs: TeamRun[]): TeamRun[] {
  return [...runs].sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || ""),
  );
}
const tasksOf = (run: TeamRun | null, roles: string[]) =>
  (run?.tasks ?? []).filter((t) => roles.includes(t.role));
const running = (tasks: TeamTask[]) => tasks.some((t) => t.status === "running");
function runField(run: TeamRun | null, key: string): unknown {
  return run ? (run as unknown as Record<string, unknown>)[key] : undefined;
}
function swarmOutput(run: TeamRun | null) {
  const out = obj(tasksOf(run, ["swarm"])[0]?.output);
  return out
    ? {
        ideas: num(out.ideas),
        stretches: num(out.stretches),
        clips: num(out.clips),
        failed: num(out.failed_renders),
        hypotheses: Array.isArray(out.hypotheses)
          ? out.hypotheses.filter((h): h is string => typeof h === "string")
          : [],
      }
    : null;
}
export function rankingOf(run: TeamRun | null) {
  const r = obj(runField(run, "ranking"));
  if (!r) return null;
  return {
    ranked: num(r.ranked) ?? 0,
    above: num(r.above_bar) ?? 0,
    below: num(r.below_bar) ?? 0,
    duplicates: num(r.duplicates) ?? 0,
    topPicks: num(r.top_picks) ?? 0,
  };
}
export function rejectionsOf(run: TeamRun | null) {
  const rows = runField(run, "brief_rejections");
  return (Array.isArray(rows) ? rows : [])
    .map(obj)
    .filter((r): r is Record<string, unknown> => !!r);
}
function taskTimes(tasks: TeamTask[]): SheetRow[] {
  return tasks.map((t) => {
    const a = time(t.started_at),
      b = time(t.finished_at);
    return {
      label: `${t.label} · ${t.status}`,
      value:
        a === null
          ? "Not started"
          : `${new Date(a).toLocaleTimeString()}${b !== null ? ` → ${new Date(b).toLocaleTimeString()} (${clock((b - a) / 1000)})` : " → running"}`,
    };
  });
}
/** "Finding clips: part 3 of 12 · 4 clips ready" → 12 */
function partsFromMessage(message: string): number {
  const m = /part \d+ of (\d+)/.exec(message);
  return m ? Number(m[1]) : 0;
}
function jobLine(job: Job | undefined): string {
  if (!job) return "";
  const p = num(job.progress);
  return `${text(job.message) || "Working"}${p !== null ? ` · ${Math.round(p)}%` : ""}`;
}

/** Publications and snapshots for the current campaign/brand (scoped by its policies). */
export function scopeAutomation(
  automation: AutomationSnapshot | null,
  campaignId: string | undefined,
  profileId: string,
): AutomationSnapshot | null {
  if (!automation) return null;
  const policies = automation.policies.filter(
    (p) => p.campaign_id === campaignId && p.profile_id === profileId,
  );
  const ids = new Set(policies.map((p) => p.id));
  const inScope = (r: Row) => ids.has(text(r.policy_id));
  return {
    policies,
    publications: automation.publications.filter(inScope),
    snapshots: automation.snapshots.filter(inScope),
    work: automation.work.filter(inScope),
    accounts: automation.accounts.filter(
      (a) => a.profile_id === profileId && a.status === "active",
    ),
  };
}

/** Pending rule proposals: Strategist's plus proposed workspace Style-rules versions. */
export function pendingRules(
  versions: StrategyVersion[],
  strategist: StrategistView | null,
) {
  const seen = new Map<string, { id: string; version: number | null; source: string }>();
  for (const v of versions)
    if (v.status === "proposed" && v.scope !== "campaign")
      seen.set(v.id, { id: v.id, version: v.version, source: "Style rules" });
  for (const r of strategist?.pending_proposals.style_rules ?? [])
    if (!seen.has(r.id))
      seen.set(r.id, {
        id: r.id,
        version: r.version,
        source: r.layer === "selection" ? "Selection" : "Craft",
      });
  return [...seen.values()];
}

export function deriveFactoryMap(input: MapInput): FactoryMapModel {
  const { sources, jobs, clips, campaign, strategist } = input;
  const runs = sortRuns(input.runs);
  const run = runs.find((r) => ACTIVE_RUN.has(r.status)) ?? runs[0] ?? null;
  const runLive = !!run && ACTIVE_RUN.has(run.status);
  const stageOf = (key: string) =>
    sources.map((s) => ({
      source: s,
      stage: s.stages.find((st) => st.key === key),
    }));
  const jobFor = (s: FactorySource) =>
    jobs.find(
      (j) =>
        (s.job_id && j.id === s.job_id) ||
        (ACTIVE_RUN.has(j.status) &&
          obj(j.context)?.video_id === s.video_id),
    );
  const liveJob = run
    ? jobs.find((j) => j.id === run.job_id && ACTIVE_RUN.has(j.status))
    : undefined;
  const runMessage = text(liveJob?.message);
  const stations = new Map<StationId, Station>();
  const put = (
    id: StationId,
    fields: Partial<Station> & Pick<Station, "state" | "status">,
  ) => {
    const def = STATIONS.find((s) => s.id === id)!;
    stations.set(id, {
      ...def,
      counts: [],
      last: "",
      sheet: [],
      lanes: 0,
      ...fields,
    });
  };

  // ── Footage in
  const footageSeconds = sources.reduce((a, s) => a + (s.duration || 0), 0);
  const newest = [...sources].sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || ""),
  )[0];
  put("footage", {
    state: sources.length ? "done" : "empty",
    status: sources.length
      ? `${plural(sources.length, "episode")} · ${clock(footageSeconds)} of footage`
      : "No footage yet — add an episode",
    counts: sources.length
      ? [{ label: "episodes", value: String(sources.length) }]
      : [],
    last: newest ? newest.name : "",
    sheet: sources.length
      ? [
          {
            title: "Episodes in this campaign",
            rows: sources.map((s) => ({
              label: s.name,
              value: `${clock(s.duration)} · ${s.headline} · ${s.video_id}`,
            })),
          },
        ]
      : [{ title: "Nothing yet", note: "Add an episode in Factory to start the line." }],
  });

  // ── Listen / Watch: per-source stages, with the live job message when active
  for (const [id, key, verb] of [
    ["listen", "listen", "transcribed"],
    ["watch", "watch", "watched"],
  ] as const) {
    const rows = stageOf(key);
    const activeRow = rows.find((r) => r.stage?.status === "active");
    const failedRow = rows.find((r) => r.stage?.status === "failed");
    const done = rows.filter((r) => r.stage?.status === "done");
    const skipped = rows.filter((r) => r.stage?.status === "skipped");
    const scenes = sources.reduce((a, s) => a + (s.storyboard?.scenes ?? 0), 0);
    const roleTasks = tasksOf(run, id === "listen" ? ["transcribe"] : ["watch", "reuse_footage", "closeup"]);
    let state: StationState = "empty",
      status = sources.length ? "Waiting for footage to reach it" : "Waiting for footage";
    if (activeRow) {
      state = "active";
      status =
        jobLine(jobFor(activeRow.source)) ||
        (id === "listen" ? "Transcribing on this Mac" : "Watching the footage");
    } else if (failedRow) {
      state = "failed";
      status = failedRow.stage?.detail || "Stopped here";
    } else if (done.length) {
      state = "done";
      status =
        id === "listen"
          ? `${done.length} of ${plural(sources.length, "episode")} ${verb}`
          : `${plural(scenes, "scene")} watched`;
    } else if (skipped.length) {
      state = "idle";
      status = skipped[0].stage?.detail || "Skipped";
    }
    put(id, {
      state,
      status,
      counts:
        id === "watch" && scenes
          ? [{ label: "scenes", value: String(scenes) }]
          : done.length
            ? [{ label: "episodes", value: `${done.length}/${sources.length}` }]
            : [],
      last: done[0]?.stage?.detail || "",
      sheet: [
        {
          title: id === "listen" ? "Transcripts" : "Storyboards",
          rows: rows.map((r) => ({
            label: r.source.name,
            value: `${r.stage?.status ?? "pending"}${r.stage?.detail ? ` · ${r.stage.detail}` : ""}${id === "watch" && r.source.storyboard ? ` · ${r.source.storyboard.vision ? "vision model" : "sound and motion only"}` : ""}`,
          })),
          note: rows.length ? undefined : "No episodes yet.",
        },
        ...(roleTasks.length
          ? [{ title: `Latest run ${run!.id}`, rows: taskTimes(roleTasks) }]
          : []),
      ],
    });
  }

  // ── Scout swarm (swarm) or the footage analyst team (team mode)
  const swarmTasks = tasksOf(run, ["swarm"]);
  const teamScouts = tasksOf(run, ["producer", "footage_analyst", "shortlist", "performance_analyst", "baseline"]);
  const scoutTasks = swarmTasks.length ? swarmTasks : teamScouts;
  const swarm = swarmOutput(run);
  const selectActive = stageOf("select").some((r) => r.stage?.status === "active");
  const scoutActive = runLive && (running(scoutTasks) || selectActive);
  const lanes = Math.min(
    8,
    swarm?.stretches ?? partsFromMessage(runMessage) ?? 0,
  );
  put("scout", {
    agent: run?.mode === "team" ? "Producer + footage analyst" : "Scouts, one per stretch",
    state: scoutActive
      ? "active"
      : scoutTasks.some((t) => t.status === "failed")
        ? "failed"
        : scoutTasks.some((t) => t.status === "completed")
          ? "done"
          : run
            ? "idle"
            : "empty",
    status: scoutActive
      ? runMessage || "Scouts are reading the episode"
      : swarm
        ? `${plural((swarm.ideas ?? 0) + rejectionsOf(run).length, "idea")} from ${plural(swarm.stretches ?? 0, "stretch", "stretches")}`
        : scoutTasks.some((t) => t.status === "completed")
          ? "Moments picked"
          : run
            ? "Waiting for the footage to be watched"
            : "No run yet — produce clips from an episode",
    counts: swarm
      ? [
          { label: "stretches", value: String(swarm.stretches ?? 0) },
          { label: "ideas", value: String(swarm.ideas ?? 0) },
        ]
      : [],
    last: swarm?.hypotheses.length
      ? `Angles: ${swarm.hypotheses.map((h) => h.replace(/_/g, " ")).join(", ")}`
      : "",
    lanes,
    sheet: run
      ? [
          {
            title: "Run",
            rows: [
              { label: "Run ID", value: run.id },
              { label: "Mode", value: run.mode === "swarm" ? "Whole episode, best first" : run.mode === "team" ? "Deep edit" : "Baseline" },
              { label: "Model", value: `${run.model_id} (on this Mac)` },
              { label: "Status", value: run.status.replace(/_/g, " ") },
            ],
          },
          { title: "Timings", rows: taskTimes(scoutTasks) },
          ...(swarm?.hypotheses.length
            ? [{ title: "Angles the scouts used", items: swarm.hypotheses.map((h) => h.replace(/_/g, " ")) }]
            : []),
        ]
      : [{ title: "No run yet", note: "Scouts start when an episode is produced." }],
  });

  // ── Brief check
  const brief = campaign?.brief;
  const avoid = brief?.must_avoid ?? [];
  const messages = brief?.key_messages ?? [];
  const rejections = rejectionsOf(run);
  const screening = avoid.length > 0 || messages.length > 0;
  const proposed = swarm ? (swarm.ideas ?? 0) + rejections.length : null;
  put("brief", {
    state: !screening
      ? "idle"
      : scoutActive
        ? "active"
        : run && scoutTasks.some((t) => t.status === "completed")
          ? "done"
          : run
            ? "idle"
            : "empty",
    status: !screening
      ? "No must-avoid list or key messages — nothing to screen"
      : proposed !== null
        ? `${plural(proposed, "idea")} · ${rejections.length} rejected by brief`
        : run
          ? `${plural(rejections.length, "idea")} rejected by brief so far`
          : `${plural(avoid.length, "must-avoid item")} ready to screen`,
    counts: screening
      ? [
          { label: "must-avoid", value: String(avoid.length) },
          { label: "rejected", value: String(rejections.length) },
        ]
      : [],
    last: rejections.length
      ? `Rejected: ${text((rejections[rejections.length - 1].items as unknown[] | undefined)?.[0]) || "a must-avoid item"}`
      : "",
    sheet: [
      {
        title: "Brief block (excerpt)",
        items: [
          ...messages.map((m, i) => `M${i + 1} · key message: ${m}`),
          ...avoid.map((a, i) => `A${i + 1} · must avoid: ${a}`),
          ...(brief?.cta ? [`CTA: ${brief.cta}`] : []),
        ],
        note: screening
          ? "Must-avoid is enforced in code: an idea whose words hit an item is dropped before rendering."
          : "This campaign's brief has no must-avoid items or key messages. Add them in Campaign brief.",
      },
      ...(rejections.length
        ? [
            {
              title: `Rejected ideas (${rejections.length})`,
              rows: rejections.slice(0, 20).map((r) => ({
                label: `${text(r.step) || "idea"} · ${clock(num(r.start))}–${clock(num(r.end))}`,
                value: (Array.isArray(r.items) ? r.items : Array.isArray(r.avoid) ? r.avoid : [])
                  .map(text)
                  .filter(Boolean)
                  .join("; ") || "Must-avoid item",
              })),
            },
          ]
        : []),
    ],
  });

  // ── Editor
  const runClipIds = run?.clip_ids ?? [];
  const renderTasks = tasksOf(run, ["render", "editor", "creative_strategist"]);
  const renderStage = stageOf("render").some((r) => r.stage?.status === "active");
  const editorActive =
    runLive && (running(renderTasks) || renderStage || (running(swarmTasks) && !/^Ranking/.test(runMessage)));
  const renders = tasksOf(run, ["render"]);
  const runClips = clips.filter((c) => runClipIds.includes(c.id));
  const newestClip = [...runClips].sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || ""),
  )[0];
  put("editor", {
    state: editorActive
      ? "active"
      : renderTasks.some((t) => t.status === "failed") && !runClipIds.length
        ? "failed"
        : runClipIds.length
          ? "done"
          : run
            ? "idle"
            : "empty",
    status: editorActive
      ? renders.length
        ? `Rendering clip ${renders.filter((t) => t.status === "completed").length + 1}/${renders.length}`
        : `${plural(runClipIds.length, "clip")} rendered so far`
      : runClipIds.length
        ? `${plural(runClipIds.length, "clip")} cut${swarm?.failed ? ` · ${swarm.failed} render${swarm.failed === 1 ? "" : "s"} failed` : ""}`
        : run
          ? "Nothing rendered yet"
          : "No clips yet",
    counts: runClipIds.length
      ? [{ label: "clips", value: String(runClipIds.length) }]
      : [],
    last: newestClip ? `“${newestClip.hook || newestClip.name}”` : "",
    sheet: [
      {
        title: "Clips from the latest run",
        rows: runClips.slice(0, 24).map((c) => ({
          label: c.hook || c.name,
          value: `${clock(c.end - c.start)} · ${c.hypothesis ? c.hypothesis.replace(/_/g, " ") + " · " : ""}${c.id}`,
        })),
        note: runClips.length ? "Every clip is 9:16 with burned captions; the hook comes first when a payoff sentence exists." : "No clips in this campaign from the latest run.",
      },
      ...(renderTasks.length ? [{ title: "Timings", rows: taskTimes(renderTasks) }] : []),
    ],
  });

  // ── Critic + quality gate
  const ranking = rankingOf(run);
  const critics = tasksOf(run, ["critic"]);
  const criticActive = runLive && (running(critics) || /^Ranking/.test(runMessage));
  const reviewed = runClips.filter((c) => c.team_review_status && c.team_review_status !== "not_applicable");
  const passes = reviewed.filter((c) => c.team_review_status === "pass").length;
  const findings = runClips.flatMap((c) =>
    (Array.isArray(c.team_findings) ? c.team_findings : [])
      .map(obj)
      .filter((f): f is Record<string, unknown> => !!f)
      .map((f) => `${c.hook || c.name}: ${text(f.category)} · ${text(f.message)}`),
  );
  const belowReasons = runClips
    .filter((c) => c.rank?.below_bar)
    .map((c) => `${c.hook || c.name}: ${c.rank?.reason || c.rank?.why || "under the quality floor"}${c.rank?.duplicate_of ? " (similar to a better clip)" : ""}`);
  put("critic", {
    state: criticActive
      ? "active"
      : ranking || reviewed.length || critics.some((t) => t.status === "completed")
        ? "done"
        : run
          ? "idle"
          : "empty",
    status: criticActive
      ? runMessage || "Checking clips"
      : ranking
        ? `${ranking.above} above the bar · ${ranking.below} below`
        : reviewed.length
          ? `${passes} passed · ${reviewed.length - passes} need another look`
          : runLive
            ? "Ranks every clip once rendering ends"
            : run
              ? "Nothing judged yet"
              : "Nothing to judge yet",
    counts: ranking
      ? [
          { label: "top picks", value: String(ranking.topPicks) },
          { label: "duplicates", value: String(ranking.duplicates) },
        ]
      : [],
    last: ranking ? `${ranking.ranked} ranked best first` : "",
    sheet: [
      ...(ranking
        ? [
            {
              title: "Quality gate",
              rows: [
                { label: "Ranked", value: String(ranking.ranked) },
                { label: "Above the bar", value: String(ranking.above) },
                { label: "Below the bar (kept, not deleted)", value: String(ranking.below) },
                { label: "Near-duplicates merged", value: String(ranking.duplicates) },
                { label: "Top picks", value: String(ranking.topPicks) },
              ],
              note: "Score: 40% storyboard interest, 20% brief fit, 15% critic, 15% technical, 10% hook. Floor 50.",
            },
          ]
        : []),
      ...(findings.length ? [{ title: "Critic findings", items: findings.slice(0, 20) }] : []),
      ...(belowReasons.length ? [{ title: "Below the bar", items: belowReasons.slice(0, 20) }] : []),
      ...(critics.length ? [{ title: "Timings", rows: taskTimes(critics) }] : []),
      ...(!ranking && !findings.length && !critics.length
        ? [{ title: "Nothing yet", note: "The ranker scores clips after they are rendered." }]
        : []),
    ],
  });

  // ── You approve
  const waiting = sources.reduce((a, s) => a + (s.unreviewed || 0), 0);
  const approved = sources.reduce((a, s) => a + (s.approved || 0), 0);
  const waitingClips = clips
    .filter((c) => !c.approved && !c.rank?.below_bar)
    .sort((a, b) => (b.rank?.score ?? -1) - (a.rank?.score ?? -1));
  put("approve", {
    state: waiting ? "waiting" : approved ? "done" : "empty",
    status: waiting
      ? `${plural(waiting, "clip")} waiting for you`
      : approved
        ? `${plural(approved, "clip")} approved`
        : "Nothing to review yet",
    counts: [
      { label: "waiting", value: String(waiting) },
      { label: "approved", value: String(approved) },
    ],
    last: "",
    sheet: [
      {
        title: "Waiting for your review (best first)",
        rows: waitingClips.slice(0, 20).map((c) => ({
          label: c.hook || c.name,
          value: `${c.rank ? `score ${Math.round(c.rank.score)} · ` : ""}${c.id}`,
        })),
        note: "Nothing is approved for you. Each clip needs your own decision in Studio.",
      },
    ],
  });

  // ── Post / Measure (only real tracking records)
  const auto = input.automation;
  const postedClips = clips.filter((c) => c.instagram_media_id || c.published_at);
  const publications = auto?.publications ?? [];
  const postedIds = new Set([
    ...postedClips.map((c) => c.instagram_media_id || c.id),
    ...publications.map((p) => text(p.media_id) || p.id),
  ]);
  const posted = postedIds.size;
  put("post", {
    state: posted ? "done" : approved ? "waiting" : "empty",
    status: posted
      ? `${plural(posted, "post")} on Instagram`
      : approved
        ? "Nothing posted yet — post an approved clip"
        : "Nothing posted yet",
    counts: auto
      ? [
          { label: auto.accounts.length === 1 ? "account" : "accounts", value: String(auto.accounts.length) },
          { label: "tracked", value: String(publications.length) },
        ]
      : [],
    last: "",
    sheet: [
      {
        title: "Posts",
        rows: [
          ...publications.map((p) => ({
            label: `Post ${text(p.media_id)}`,
            value: `${stamp(p.published_at)} · clip ${text(p.clip_id)} · account ${text(p.account_id)}`,
          })),
          ...postedClips
            .filter((c) => !publications.some((p) => p.clip_id === c.id))
            .map((c) => ({
              label: c.hook || c.name,
              value: `${c.published_at ? stamp(c.published_at) : "posted"} · not tracked yet`,
            })),
        ],
        note: auto
          ? "Posting always needs your approval. Paid spending is off."
          : "Tracking data is unavailable right now.",
      },
    ],
  });
  const snapshots = auto?.snapshots ?? [];
  const measured = new Set(snapshots.map((s) => text(s.publication_id))).size;
  const dues = publications
    .map((p) => time(p.next_due_at))
    .filter((t): t is number => t !== null && t > input.now)
    .sort((a, b) => a - b);
  const workRunning = (auto?.work ?? []).some((w) =>
    ["running", "queued", "retry"].includes(text(w.status)),
  );
  put("measure", {
    state: workRunning
      ? "active"
      : !publications.length
        ? "empty"
        : measured
          ? "done"
          : "idle",
    status: workRunning
      ? "Reading the latest numbers from Instagram"
      : !publications.length
        ? "Nothing to measure yet"
        : dues.length
          ? `Next measure: ${shortDate(dues[0])}`
          : `${plural(measured, "post")} measured`,
    counts: publications.length
      ? [
          { label: "measured", value: String(measured) },
          { label: "waiting", value: String(dues.length) },
        ]
      : [],
    last: "",
    sheet: [
      {
        title: "Measurements",
        rows: snapshots.slice(0, 12).map((s) => ({
          label: `${stamp(s.collected_at)}${s.trigger === "demo_override" ? " · demo override (measured early)" : ""}`,
          value: Object.entries(obj(s.metrics) ?? {})
            .map(([k, v]) => `${k.replace(/_/g, " ")} ${num(v)?.toLocaleString() ?? "unknown"}`)
            .join(" · ") + ` · ${s.id}`,
        })),
        note: snapshots.length
          ? "Counts are cumulative and never summed. Unknown stays unknown."
          : "No measurement has been taken yet.",
      },
      ...(dues.length
        ? [{ title: "Coming up", items: dues.map((d) => `Measure on ${new Date(d).toLocaleString()}`) }]
        : []),
    ],
  });

  // ── Strategist
  const sRun = strategist?.runs[0];
  const sActive = !!sRun && ACTIVE_RUN.has(sRun.status);
  const beliefs = (strategist?.beliefs ?? []).filter((b) => b.status !== "retired");
  const supported = beliefs.filter((b) => b.status === "supported").length;
  put("strategist", {
    state: !strategist
      ? "idle"
      : sActive
        ? "active"
        : !strategist.measured_posts
          ? "empty"
          : beliefs.length
            ? "done"
            : "idle",
    status: !strategist
      ? "Unavailable right now"
      : sActive
        ? `${sRun!.message || "Reviewing measured posts"} (${sRun!.progress}%)`
        : !strategist.measured_posts
          ? "0 measured posts — nothing to learn yet"
          : beliefs.length
            ? `${plural(beliefs.length, "belief")} · ${supported} supported`
            : `${plural(strategist.measured_posts, "measured post")} · no pattern yet`,
    counts: strategist
      ? [
          { label: "measured", value: String(strategist.measured_posts) },
          { label: "beliefs", value: String(beliefs.length) },
        ]
      : [],
    last: beliefs[0]?.statement ?? "",
    sheet: strategist
      ? [
          {
            title: "Beliefs (observational, not proof)",
            rows: beliefs.slice(0, 12).map((b) => ({
              label: b.statement,
              value: `${Math.round(b.confidence * 100)}% · ${b.status} · ${b.counts.matching} posts`,
            })),
            note: beliefs.length ? undefined : "Beliefs appear after posts are measured.",
          },
          ...(sRun
            ? [
                {
                  title: "Latest Strategist run",
                  rows: [
                    { label: "Run ID", value: sRun.id },
                    { label: "Status", value: sRun.status },
                    { label: "Local model", value: sRun.model?.status?.replace(/_/g, " ") || "—" },
                    { label: "Started", value: stamp(sRun.created_at) },
                  ],
                },
              ]
            : []),
        ]
      : [{ title: "Unavailable", note: "The Strategist could not be read. Nothing is assumed." }],
  });

  // ── Style rules update (return arc)
  const pending = pendingRules(input.versions, strategist);
  const campaignProposals = strategist?.pending_proposals.campaign.length ?? 0;
  const activeRules = input.versions.find((v) => v.id === input.activeRulesId);
  put("rules", {
    state: pending.length ? "waiting" : activeRules ? "done" : "empty",
    status: pending.length
      ? `${plural(pending.length, "rule")} waiting for your approval`
      : activeRules
        ? `Rules v${activeRules.version} in use · no change proposed`
        : "No rules approved yet",
    counts: pending.length
      ? [{ label: "waiting", value: String(pending.length) }]
      : [],
    last: "",
    sheet: [
      {
        title: "Waiting for your approval",
        rows: pending.map((p) => ({
          label: `${p.source} change${p.version !== null ? ` · version ${p.version}` : ""}`,
          value: p.id,
        })),
        note: "Nothing changes until you approve it in Style rules.",
      },
      ...(campaignProposals
        ? [{ title: "Campaign proposals", note: `${campaignProposals} waiting in Results.` }]
        : []),
    ],
  });

  const ordered = STATIONS.map((s) => stations.get(s.id)!);
  // Swarm work is concurrent: while scouts run, the brief check and the editor work too.
  if (scoutActive && run?.mode === "swarm") {
    for (const id of ["brief", "editor"] as const) {
      const st = stations.get(id)!;
      if (id === "brief" && !screening) continue;
      st.state = "active";
    }
  }
  return {
    stations: ordered,
    edges: edgesFor(ordered),
    returnArc: {
      lit: pending.length > 0 || campaignProposals > 0,
      label: pending.length
        ? `${plural(pending.length, "proposal")} → next scouts`
        : "Approved rules guide the next scouts",
    },
    live: runLive || ordered.some((s) => s.state === "active"),
    runId: run?.id ?? null,
  };
}

export function edgesFor(stations: Station[]): FlowEdge[] {
  const active = new Set(stations.filter((s) => s.state === "active").map((s) => s.id));
  return stations.slice(1).map((s, i) => ({
    from: stations[i].id,
    to: s.id,
    // Tokens move only into a station that is doing real work right now.
    flowing: active.has(s.id),
  }));
}

// ───────────────────────── Run ledger

export interface RunLedger {
  runId: string;
  mode: string;
  status: string;
  model: string;
  startedAt: string | null;
  totalSeconds: number | null;
  stages: { station: StationId; title: string; seconds: number; running: boolean }[];
  produced: number;
  kept: number;
  belowBar: number;
  waiting: number;
  approvals: number;
  overrides: number;
  cost: { inference: string; note: string; excluded: string[] };
}
export function runLedger(run: TeamRun, clips: Clip[], now: number): RunLedger {
  const per = new Map<StationId, { seconds: number; running: boolean }>();
  for (const t of run.tasks) {
    const station = ROLE_STATION[t.role];
    const a = time(t.started_at);
    if (!station || a === null) continue;
    const b = time(t.finished_at) ?? (t.status === "running" ? now : null);
    if (b === null) continue;
    const row = per.get(station) ?? { seconds: 0, running: false };
    row.seconds += Math.max(0, (b - a) / 1000);
    row.running ||= t.status === "running";
    per.set(station, row);
  }
  const mine = clips.filter((c) => run.clip_ids.includes(c.id));
  const ranking = rankingOf(run);
  const kept = mine.filter((c) => c.approved).length;
  const belowBar = ranking?.below ?? mine.filter((c) => c.rank?.below_bar).length;
  const a = time(run.started_at),
    b = time(run.finished_at);
  return {
    runId: run.id,
    mode: run.mode,
    status: run.status,
    model: run.model_id,
    startedAt: run.started_at,
    totalSeconds:
      num(run.elapsed_seconds) ??
      (a !== null ? ((b ?? now) - a) / 1000 : null),
    stages: STATIONS.filter((s) => per.has(s.id)).map((s) => ({
      station: s.id,
      title: s.title,
      ...per.get(s.id)!,
    })),
    produced: run.clip_ids.length,
    kept,
    belowBar,
    waiting: Math.max(0, mine.filter((c) => !c.approved && !c.rank?.below_bar).length),
    approvals: kept,
    overrides: mine.filter((c) => c.approval_override).length,
    cost: {
      inference: "$0",
      note: `Model fees: none. ${run.model_id} runs on this Mac.`,
      excluded: [
        "Electricity and the Mac itself",
        "Your review time",
        "Instagram and any paid promotion (off)",
      ],
    },
  };
}

// ───────────────────────── Demo replay (recorded events only)

export interface ReplayEvent {
  at: number;
  station: StationId;
  kind: "start" | "finish" | "clip";
  label: string;
}
/** Events from a run's own timestamps: task start/finish and each clip's creation time. */
export function replayEvents(run: TeamRun, clips: Clip[]): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  for (const t of run.tasks) {
    const station = ROLE_STATION[t.role];
    if (!station) continue;
    const a = time(t.started_at),
      b = time(t.finished_at);
    if (a !== null) events.push({ at: a, station, kind: "start", label: t.label });
    if (a !== null && b !== null && b >= a)
      events.push({ at: b, station, kind: "finish", label: t.label });
  }
  for (const c of clips) {
    if (!run.clip_ids.includes(c.id)) continue;
    const at = time(c.created_at);
    if (at !== null) events.push({ at, station: "editor", kind: "clip", label: c.hook || c.name });
  }
  return events.sort((x, y) => x.at - y.at);
}
/** The newest finished run with at least one recorded start and finish. */
export function replayableRun(runs: TeamRun[]): TeamRun | null {
  return (
    sortRuns(runs).find(
      (r) =>
        !ACTIVE_RUN.has(r.status) &&
        r.tasks.some((t) => time(t.started_at) !== null && time(t.finished_at) !== null),
    ) ?? null
  );
}
export interface ReplayFrame {
  active: Set<StationId>;
  done: Set<StationId>;
  clips: number;
  /** Real (recorded) milliseconds since the first event. */
  recordedMs: number;
  durationMs: number;
  finished: boolean;
}
export const REPLAY_SPEED = 10;
export function replayDuration(events: ReplayEvent[]): number {
  return events.length ? events[events.length - 1].at - events[0].at : 0;
}
/** State at `recordedMs` after the first event. */
export function replayFrame(events: ReplayEvent[], recordedMs: number): ReplayFrame {
  const durationMs = replayDuration(events);
  const t0 = events[0]?.at ?? 0;
  const cut = t0 + recordedMs;
  const open = new Map<StationId, number>();
  const done = new Set<StationId>();
  let clips = 0;
  for (const e of events) {
    if (e.at > cut) break;
    if (e.kind === "start") open.set(e.station, (open.get(e.station) ?? 0) + 1);
    else if (e.kind === "finish") {
      const n = (open.get(e.station) ?? 1) - 1;
      if (n <= 0) open.delete(e.station);
      else open.set(e.station, n);
      done.add(e.station);
    } else clips++;
  }
  const active = new Set(open.keys());
  return { active, done, clips, recordedMs, durationMs, finished: recordedMs >= durationMs };
}
const REPLAY_STATIONS: StationId[] = ["footage", "listen", "watch", "scout", "brief", "editor", "critic"];
/** Overlay a replay frame on the real model; stations after the critic are dimmed. */
export function applyReplay(
  model: FactoryMapModel,
  frame: ReplayFrame,
  run: TeamRun,
): FactoryMapModel {
  const swarming = run.mode === "swarm" && frame.active.has("scout");
  const rejections = rejectionsOf(run).length;
  const stations = model.stations.map((s): Station => {
    if (!REPLAY_STATIONS.includes(s.id)) return { ...s, dim: true };
    let active = frame.active.has(s.id);
    let done = frame.done.has(s.id) || s.id === "footage";
    if (swarming && (s.id === "editor" || (s.id === "brief" && s.state !== "idle")))
      active = true;
    if (run.mode === "swarm" && frame.done.has("scout") && (s.id === "brief" || s.id === "editor" || s.id === "critic"))
      done = true;
    const status = active
      ? s.id === "editor"
        ? `Replay · ${plural(frame.clips, "clip")} rendered`
        : `Replay · working`
      : done
        ? s.id === "editor"
          ? `Replay · ${plural(Math.max(frame.clips, run.clip_ids.length), "clip")} cut`
          : s.id === "brief" && rejections
            ? `Replay · ${rejections} rejected by brief`
            : `Replay · done`
        : "Replay · not reached yet";
    return {
      ...s,
      state: active ? "active" : done ? "done" : "idle",
      status,
    };
  });
  return { ...model, stations, edges: edgesFor(stations), live: true, runId: run.id };
}
