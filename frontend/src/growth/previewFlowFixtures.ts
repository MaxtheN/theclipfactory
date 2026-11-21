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
const POLICY_TIKTOK = "preview-fixture-policy-tiktok";
const POLICY_X = "preview-fixture-policy-x";
const IG = "preview-fixture-account";
const TIKTOK = "preview-fixture-tiktok";
const YOUTUBE = "preview-fixture-youtube";
const X = "preview-fixture-x";

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
  // Posts across accounts for the Account Map: Instagram has two pages of clips, TikTok holds a
  // cross-post of clip-2, YouTube has nothing yet and the X account is no longer connected.
  const pub = (
    n: number,
    policy: string,
    account: string,
    clip: string,
    daysAgo: number,
    dueAfterDays: number | null,
  ) => {
    const at = now - daysAgo * 24 * H;
    return {
      id: `preview-fixture-pub-${n}`,
      policy_id: policy,
      clip_id: clip,
      account_id: account,
      media_id: `179000000000000${String(n).padStart(2, "0")}`,
      published_at: iso(at),
      next_due_at: dueAfterDays === null ? null : iso(at + dueAfterDays * 24 * H),
      mapping_source: "user_confirmed",
    };
  };
  const publications = [
    pub(1, POLICY, IG, "preview-fixture-clip-2", 4.2, 6),
    pub(2, POLICY, IG, "preview-fixture-clip-5", 1.4, 3),
    pub(3, POLICY, IG, "preview-fixture-clip-1", 6.5, null),
    pub(4, POLICY, IG, "preview-fixture-clip-3", 8.8, null),
    pub(5, POLICY, IG, "preview-fixture-clip-4", 11, null),
    pub(6, POLICY, IG, "preview-fixture-clip-6", 13.5, null),
    pub(7, POLICY, IG, "preview-fixture-clip-7", 16, null),
    pub(8, POLICY_TIKTOK, TIKTOK, "preview-fixture-clip-2", 3.9, 6),
    pub(9, POLICY_TIKTOK, TIKTOK, "preview-fixture-clip-8", 7.1, null),
    pub(10, POLICY_TIKTOK, TIKTOK, "preview-fixture-clip-9", 0.6, 3),
    pub(11, POLICY_X, X, "preview-fixture-clip-10", 18, null),
  ];
  const reading = (
    n: number,
    publication: (typeof publications)[number],
    ageDays: number,
    metrics: Record<string, number>,
  ) => ({
    id: `preview-fixture-reading-${n}`,
    policy_id: publication.policy_id,
    publication_id: publication.id,
    clip_id: publication.clip_id,
    collected_at: iso(now - ageDays * 24 * H),
    window_start: publication.published_at,
    source: "Preview fixture",
    metrics,
    trigger: "schedule",
  });
  // pub-2 and pub-10 are still inside their first window: no reading yet.
  const snapshots = [
    reading(1, publications[0], 1.2, { views: 4210, likes: 188, shares: 21 }),
    reading(3, publications[2], 3.5, { views: 6120, likes: 301, shares: 44 }),
    reading(4, publications[3], 5.8, { views: 2980, likes: 139, shares: 17 }),
    reading(5, publications[4], 8, { views: 1840, likes: 76, shares: 9 }),
    reading(6, publications[5], 10.5, { views: 3550, likes: 162, shares: 23 }),
    reading(7, publications[6], 13, { views: 2410, likes: 98, shares: 12 }),
    reading(8, publications[7], 0.9, { views: 12800, likes: 905, shares: 132 }),
    reading(9, publications[8], 4.1, { views: 5400, likes: 344, shares: 38 }),
    reading(11, publications[10], 15, { views: 760, likes: 31, shares: 2 }),
  ];
  const automation = {
    health: { status: "ok", message: "Preview fixture" },
    policies: [
      {
        id: POLICY,
        campaign_id: CAMPAIGN,
        profile_id: PROFILE,
        account_id: IG,
        cadence_days: 3,
        enabled: true,
        auto_drafts: true,
        allowed_changes: ["hook", "duration"],
      },
      {
        id: POLICY_TIKTOK,
        campaign_id: CAMPAIGN,
        profile_id: PROFILE,
        account_id: TIKTOK,
        cadence_days: 3,
        enabled: true,
        auto_drafts: false,
        allowed_changes: ["hook"],
      },
      {
        id: POLICY_X,
        campaign_id: CAMPAIGN,
        profile_id: PROFILE,
        account_id: X,
        cadence_days: 3,
        enabled: false,
        auto_drafts: false,
        allowed_changes: [],
      },
    ],
    publications,
    snapshots,
    work: [],
    experiments: [],
  };
  const memory = {
    baseline: {
      posts: 9,
      metrics: {
        views: { median: 2980, known_posts: 9 },
        likes: { median: 142, known_posts: 9 },
        shares: { median: 18, known_posts: 9 },
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
      { id: IG, profile_id: PROFILE, status: "active", platform: "instagram", display_name: "@allin_preview_fixture" },
      { id: TIKTOK, profile_id: PROFILE, status: "active", platform: "tiktok", display_name: "@allin.clips.preview" },
      { id: YOUTUBE, profile_id: PROFILE, status: "active", platform: "youtube", display_name: "All-In Clips (preview)" },
      { id: X, profile_id: PROFILE, status: "disconnected", platform: "twitter", display_name: "@allin_old_preview" },
    ];
  if (path === "/api/automation/settings") return { configured: true, auth_config_id: "" };
  if (path.startsWith("/api/automation/memory")) return f.memory;
  if (/^\/api\/strategist\/[^/]+$/.test(path)) return f.strategist;
  return undefined;
}
