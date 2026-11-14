/**
 * PREVIEW FIXTURES — design review only (VITE_REVIEW_PREVIEW builds, opt-in with
 * `?fixtures=flow`). They give the Factory map and Results realistic shapes to render.
 * Every record is labelled "Preview fixture"; none of it is real account data, and the
 * desktop app never loads this file (previewApi is only imported in review builds).
 */
const H = 3600000;
const MIN = 60000;

export function flowFixturesEnabled(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("fixtures") === "flow") {
      sessionStorage.setItem("gf-preview-fixtures", "flow");
      return true;
    }
    return sessionStorage.getItem("gf-preview-fixtures") === "flow";
  } catch {
    return false;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const PROFILE = "preview-profile-allin";
const CAMPAIGN = "preview-campaign";
const POLICY = "preview-fixture-policy";

function fixtures(now: number) {
  const t0 = now - 26 * MIN; // finished run on source B
  const t1 = now - 4 * MIN; // live run on source A
  const task = (
    id: string,
    role: string,
    label: string,
    status: string,
    start: number | null,
    end: number | null,
    output: Record<string, unknown> | null = null,
  ) => ({
    id,
    role,
    label,
    kind: role === "watch" || role === "transcribe" ? "tool" : "agent",
    status,
    iteration: 0,
    input_refs: ["source:preview-fixture"],
    output,
    error: null,
    started_at: start === null ? null : iso(start),
    finished_at: end === null ? null : iso(end),
  });
  const finished = {
    id: "preview-fixture-run-b",
    video_id: "preview-source-b",
    mode: "swarm",
    model_id: "qwen3-vl:4b",
    objective: "Preview fixture — illustrative run",
    status: "needs_review",
    job_id: "preview-fixture-job-b",
    revision_budget: 0,
    revision_count: 0,
    stop_reason: null,
    created_at: iso(t0),
    started_at: iso(t0),
    finished_at: iso(t0 + 19 * MIN),
    elapsed_seconds: 19 * 60,
    resource_observations: null,
    clip_ids: Array.from({ length: 11 }, (_, i) => `preview-fixture-clip-${i + 1}`),
    plan: null,
    context: {},
    permissions: { publish: false, ads: false },
    brief_rejections: [
      { step: "swarm", start: 412, end: 438, avoid: ["A1"], items: ["Preview fixture: competitor names"] },
      { step: "swarm", start: 1290, end: 1318, avoid: ["A2"], items: ["Preview fixture: pricing promises"] },
      { step: "swarm", start: 2210, end: 2240, avoid: ["A1"], items: ["Preview fixture: competitor names"] },
    ],
    ranking: { ranked: 11, above_bar: 8, below_bar: 3, duplicates: 1, top_picks: 5, review_target: 5 },
    tasks: [
      task("pf-b1", "transcribe", "Source transcription", "completed", t0, t0 + 2.5 * MIN),
      task("pf-b2", "watch", "Watch the footage", "completed", t0 + 2.5 * MIN, t0 + 7 * MIN, { scenes: 48 }),
      task("pf-b3", "swarm", "Idea swarm", "completed", t0 + 7 * MIN, t0 + 19 * MIN, {
        ideas: 12,
        stretches: 8,
        clips: 11,
        failed_renders: 0,
        hypotheses: ["bold_claim", "question", "story", "lesson"],
      }),
    ],
  };
  const live = {
    ...finished,
    id: "preview-fixture-run-a",
    video_id: "preview-source-a",
    status: "running",
    job_id: "preview-fixture-job-a",
    created_at: iso(t1),
    started_at: iso(t1),
    finished_at: null,
    elapsed_seconds: null,
    clip_ids: ["preview-fixture-clip-a1", "preview-fixture-clip-a2", "preview-fixture-clip-a3", "preview-fixture-clip-a4"],
    brief_rejections: [finished.brief_rejections[0]],
    ranking: undefined,
    tasks: [
      task("pf-a1", "transcribe", "Source transcription", "completed", t1, t1 + 40000),
      task("pf-a2", "watch", "Watch the footage", "completed", t1 + 40000, t1 + 95000, { scenes: 31 }),
      task("pf-a3", "swarm", "Idea swarm", "running", t1 + 95000, null),
    ],
  };
  const stage = (key: string, label: string, status: string, detail = "") => ({ key, label, status, detail });
  const factory = {
    autopilot: false,
    model_id: "qwen3-vl:4b",
    ready: true,
    blockers: [],
    sources: [
      {
        video_id: "preview-source-a",
        name: "All-In episode A · preview fixture",
        duration: 3720,
        created_at: iso(t1 - MIN),
        state: "working",
        headline: "Finding clips: part 3 of 6 · 4 clips ready",
        progress: 44,
        stages: [
          stage("import", "Import", "done"),
          stage("listen", "Listen", "done", "612 lines of speech"),
          stage("watch", "Watch", "done", "31 scenes"),
          stage("select", "Pick moments", "done"),
          stage("edit", "Write and check", "done"),
          stage("render", "Render", "active"),
        ],
        job_id: "preview-fixture-job-a",
        run_id: live.id,
        clip_ids: live.clip_ids,
        unreviewed: 0,
        approved: 0,
        error: null,
        can_produce: false,
        blocked_reason: "This source is already being worked on.",
        storyboard: { scenes: 31, vision: false, model_id: null, updated_at: iso(t1) },
        thumbnail: null,
      },
      {
        video_id: "preview-source-b",
        name: "All-In episode B · preview fixture",
        duration: 5100,
        created_at: iso(t0 - MIN),
        state: "needs_review",
        headline: "6 clips ready for review",
        progress: null,
        stages: [
          stage("import", "Import", "done"),
          stage("listen", "Listen", "done", "804 lines of speech"),
          stage("watch", "Watch", "done", "48 scenes"),
          stage("select", "Pick moments", "done"),
          stage("edit", "Write and check", "done"),
          stage("render", "Render", "done", "11 clips"),
        ],
        job_id: null,
        run_id: finished.id,
        clip_ids: finished.clip_ids,
        unreviewed: 6,
        approved: 2,
        error: null,
        can_produce: true,
        blocked_reason: null,
        storyboard: { scenes: 48, vision: true, model_id: "qwen3-vl:4b", updated_at: iso(t0) },
        thumbnail: null,
      },
    ],
  };
  const jobs = [
    {
      id: "preview-fixture-job-a",
      kind: "team",
      status: "running",
      progress: 44,
      message: "Finding clips: part 3 of 6 · 4 clips ready",
      context: { video_id: "preview-source-a", team_run_id: live.id },
      created_at: iso(t1),
    },
  ];
  const publications = [
    {
      id: "preview-fixture-pub-1",
      policy_id: POLICY,
      clip_id: "preview-fixture-clip-2",
      account_id: "preview-fixture-account",
      media_id: "17900000000000001",
      published_at: iso(now - 4.2 * 24 * H),
      next_due_at: iso(now - 4.2 * 24 * H + 6 * 24 * H),
      mapping_source: "user_confirmed",
    },
    {
      id: "preview-fixture-pub-2",
      policy_id: POLICY,
      clip_id: "preview-fixture-clip-5",
      account_id: "preview-fixture-account",
      media_id: "17900000000000002",
      published_at: iso(now - 1.4 * 24 * H),
      next_due_at: iso(now - 1.4 * 24 * H + 3 * 24 * H),
      mapping_source: "user_confirmed",
    },
  ];
  const snapshots = [
    {
      id: "preview-fixture-reading-1",
      policy_id: POLICY,
      publication_id: "preview-fixture-pub-1",
      clip_id: "preview-fixture-clip-2",
      collected_at: iso(now - 1.2 * 24 * H),
      window_start: publications[0].published_at,
      source: "Preview fixture",
      metrics: { views: 4210, likes: 188, shares: 21 },
      trigger: "schedule",
    },
  ];
  const automation = {
    health: { status: "ok", message: "Preview fixture" },
    policies: [
      {
        id: POLICY,
        campaign_id: CAMPAIGN,
        profile_id: PROFILE,
        account_id: "preview-fixture-account",
        cadence_days: 3,
        enabled: true,
        auto_drafts: true,
        allowed_changes: ["hook", "duration"],
      },
    ],
    publications,
    snapshots,
    work: [],
    experiments: [],
  };
  const memory = {
    baseline: {
      posts: 3,
      metrics: {
        views: { median: 2980, known_posts: 3 },
        likes: { median: 142, known_posts: 3 },
        shares: { median: 18, known_posts: 3 },
      },
    },
    experiments: [],
    comparisons: [],
    pending_rule_proposals: [],
    truncated: false,
  };
  const belief = (
    id: string,
    layer: string,
    statement: string,
    variable: string,
    value: string,
    confidence: number,
    status: string,
    matching: number,
  ) => ({
    id,
    profile_id: PROFILE,
    layer,
    statement,
    variable,
    value,
    direction: "increase",
    metric: "views",
    confidence,
    uncertainty: 1 - confidence / 2,
    status,
    evidence: [],
    counts: { matching, beats: Math.round(matching * confidence), misses: 0, ties: 0, prospective: 1 },
    effect: { shrunken_log_ratio: 0.2, typical_ratio: 1.2 },
    origin: "pattern_scan",
    rationale: "",
    created_at: iso(now - 3 * 24 * H),
    updated_at: iso(now - 24 * H),
  });
  const strategist = {
    profile_id: PROFILE,
    target_metric: "views",
    baseline: { statistic: "median", posts: 3, metrics: { views: 2980 } },
    beliefs: [
      belief("pf-belief-1", "craft", "Preview fixture: question hooks tend to beat your typical views", "hook_style", "question", 0.82, "supported", 3),
      belief("pf-belief-2", "craft", "Preview fixture: clips under 20 seconds tend to beat your typical views", "duration_bucket", "short", 0.62, "testing", 2),
      belief("pf-belief-3", "selection", "Preview fixture: story moments tend to beat your typical views", "moment_type", "story", 0.55, "testing", 2),
    ],
    portfolio: {
      slots: [
        { slot: 1, mode: "exploit", belief_id: "pf-belief-1", layer: "craft", variable: "hook_style", value: "question", direction: "increase", rationale: "", score: 0.82 },
        { slot: 2, mode: "exploit", belief_id: "pf-belief-1", layer: "craft", variable: "hook_style", value: "question", direction: "increase", rationale: "", score: 0.82 },
        { slot: 3, mode: "exploit", belief_id: "pf-belief-1", layer: "craft", variable: "hook_style", value: "question", direction: "increase", rationale: "", score: 0.82 },
        { slot: 4, mode: "explore", belief_id: "pf-belief-3", layer: "selection", variable: "moment_type", value: "story", direction: "increase", rationale: "", score: 0.4 },
      ],
      exploit: 3,
      explore: 1,
      seed: "preview",
    },
    pending_proposals: {
      style_rules: [{ id: "preview-fixture-rule", campaign_id: CAMPAIGN, version: 2, layer: "craft" }],
      campaign: [],
    },
    runs: [
      {
        id: "preview-fixture-strategist-run",
        status: "completed",
        trigger: "schedule",
        layers: ["craft"],
        progress: 100,
        message: "Done",
        model: { status: "not_used" },
        proposals: [],
        created_at: iso(now - 20 * H),
        finished_at: iso(now - 20 * H + MIN),
      },
    ],
    measured_posts: 3,
    due_layers: [],
    caveat: "Preview fixture. Observational: beliefs describe this account's own posts and do not prove cause.",
    simulated: false,
  };
  return { factory, runs: [live, finished], jobs, automation, memory, strategist };
}

/** Returns a fixture for this route, or undefined to fall through to the normal preview. */
export function flowFixture(path: string, method: string): unknown {
  if (!flowFixturesEnabled() || method !== "GET") return undefined;
  const f = fixtures(Date.now());
  if (path === "/api/factory") return f.factory;
  if (path === "/api/team/runs") return f.runs;
  if (path === "/api/jobs") return f.jobs;
  if (path === "/api/automation/state") return f.automation;
  if (path === "/api/automation/accounts")
    return [
      {
        id: "preview-fixture-account",
        profile_id: PROFILE,
        status: "active",
        display_name: "@allin_preview_fixture",
      },
    ];
  if (path === "/api/automation/settings") return { configured: true, auth_config_id: "" };
  if (path.startsWith("/api/automation/memory")) return f.memory;
  if (/^\/api\/strategist\/[^/]+$/.test(path)) return f.strategist;
  return undefined;
}
