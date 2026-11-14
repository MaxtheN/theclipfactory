import type {
  Campaign,
  Clip,
  Direction,
  Job,
  Observation,
  Profile,
  Settings,
  StrategyVersion,
  Video,
} from "../types";

import type { ProductionClip } from "./productionContracts";

/** Explicit review-only transport. Never calls fetch or the desktop service. */
const STORAGE_KEY = "growth-factory-preview-v1";
type PreviewObservation = Observation & { campaign_id: string };
type PendingRender = { job_id: string; due_at: number; clip: ProductionClip };
interface PreviewState {
  schema: 1;
  sequence: number;
  profiles: Profile[];
  campaigns: Campaign[];
  strategies: StrategyVersion[];
  observations: PreviewObservation[];
  videos: Video[];
  clips: ProductionClip[];
  jobs: Job[];
  pending: PendingRender[];
  settings: Settings;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const stamp = () => new Date().toISOString();
function fail(message: string): never {
  throw new Error(`Review preview: ${message}`);
}
const direction = (): Direction => ({
  angles: ["A clear point, without the long setup"],
  moment_selection:
    "Choose a self-contained source moment; preserve its meaning.",
  hooks: ["Claim first", "Question first"],
  pacing: "Let the central point arrive before the context.",
  duration_seconds: 30,
  framing: "fit",
  caption_style: "standard",
  editing_preferences:
    "Use readable captions; keep the speaker's meaning intact.",
  measurement_questions: [
    "Does a direct opening earn more full-episode visits?",
  ],
  next_experiments: [
    "Compare two opening treatments on the same source moment.",
  ],
  evidence_refs: [],
  limitations:
    "Illustrative creator-provided direction. No reference inspected and no audience result measured.",
  confidence: "low",
});

function seed(): PreviewState {
  const profiles: Profile[] = [
    {
      id: "preview-profile-allin",
      name: "All-In demo",
      audience: "Builders and founders",
      brand_context:
        "Illustrative All-In example; no affiliation or connected account.",
      objective: "traffic",
      primary_metric: "Full-episode visits",
      creative_preferences:
        "Clear claims, preserved context, restrained captions.",
    },
    {
      id: "preview-profile-test",
      name: "Test profile",
      audience: "A separate test audience",
      brand_context: "Independent local planning profile.",
      objective: "discovery",
      primary_metric: null,
      creative_preferences: "Keep this profile's direction separate.",
    },
  ];
  return {
    schema: 1,
    sequence: 1,
    profiles,
    campaigns: [
      {
        id: "preview-campaign",
        name: "All-In clips",
        brief: {
          audience: "Builders and founders",
          constraints: ["Preserve source meaning", "No invented speech"],
          requested_outputs: ["Two vertical hook variants"],
          measurement_intent:
            "Test full-episode visits; audience performance is not yet measured.",
        },
        profile_ids: profiles.map((p) => p.id),
        video_ids: ["preview-source-a", "preview-source-b"],
        active_strategy_id: null,
      },
    ],
    strategies: [
      {
        id: "preview-strategy-v1",
        campaign_id: "preview-campaign",
        version: 1,
        status: "proposed",
        base_version_id: null,
        reason:
          "Illustrative creator-provided opening test; ready for your review.",
        hypothesis: "",
        created_at: stamp(),
        approved_at: null,
        changed_profile_ids: profiles.map((p) => p.id),
        directions: Object.fromEntries(
          profiles.map((p) => [p.id, direction()]),
        ),
      },
    ],
    observations: [],
    clips: [],
    jobs: [],
    pending: [],
    videos: [
      {
        id: "preview-source-a",
        name: "All-In episode A · illustrative source",
        duration: 62,
        width: 1920,
        height: 1080,
        status: "ready",
        has_audio: false,
        created_at: stamp(),
      },
      {
        id: "preview-source-b",
        name: "All-In episode B · illustrative source",
        duration: 48,
        width: 1920,
        height: 1080,
        status: "ready",
        has_audio: false,
        created_at: stamp(),
      },
    ],
    settings: {
      brand: "Growth Factory",
      objective: "discovery",
      language: "en",
      autonomy: "review",
      publishing_enabled: false,
      ads_enabled: false,
      daily_budget: 0,
      total_budget: 0,
      graph_version: "preview",
      production_strategy: "team",
    },
  };
}

let memory: PreviewState | undefined;
function state(): PreviewState {
  if (memory) return memory;
  try {
    const saved = JSON.parse(
      localStorage.getItem(STORAGE_KEY) || "null",
    ) as PreviewState | null;
    if (
      saved?.schema === 1 &&
      Array.isArray(saved.campaigns) &&
      Array.isArray(saved.pending)
    )
      memory = saved;
  } catch {
    /* Private-mode storage can be unavailable; retain in memory. */
  }
  return (memory ??= seed());
}
function persist(s: PreviewState) {
  memory = s;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* Optional preview persistence. */
  }
}
export function resetPreview() {
  persist(seed());
}
const id = (s: PreviewState, kind: string) => `preview-${kind}-${++s.sequence}`;
const requireRecord = <T extends { id: string }>(
  rows: T[],
  identifier: string,
  kind: string,
): T => rows.find((r) => r.id === identifier) ?? fail(`${kind} not found.`);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail("Expected an object.");
const text = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;
const strings = (value: unknown): string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string")
    ? value
    : fail("Expected a list of strings.");

function advance(s: PreviewState) {
  const ready = s.pending.filter((p) => p.due_at <= Date.now());
  for (const pending of ready) {
    const job = requireRecord(s.jobs, pending.job_id, "Job");
    if (job.status !== "cancelled") {
      job.status = "completed";
      job.progress = 100;
      job.updated_at = stamp();
      job.message = "Preview simulation completed. No video was rendered.";
      job.result = { clip_id: pending.clip.id, preview_fixture: true };
      s.clips.push(pending.clip);
    }
  }
  s.pending = s.pending.filter((p) => p.due_at > Date.now());
}

function validateDirection(value: unknown): Direction {
  const d = object(value);
  const arrays = [
    "angles",
    "hooks",
    "measurement_questions",
    "next_experiments",
    "evidence_refs",
  ];
  arrays.forEach((key) => strings(d[key]));
  if (
    !Number.isFinite(d.duration_seconds) ||
    Number(d.duration_seconds) < 1 ||
    Number(d.duration_seconds) > 180
  )
    fail("Invalid direction duration.");
  if (
    !["fit", "fill"].includes(text(d.framing)) ||
    !["standard", "high_contrast"].includes(text(d.caption_style))
  )
    fail("Invalid production preset.");
  if (!["low", "medium", "high"].includes(text(d.confidence)))
    fail("Invalid confidence.");
  if (
    !["moment_selection", "pacing", "editing_preferences", "limitations"].every(
      (key) => typeof d[key] === "string",
    )
  )
    fail("Invalid direction fields.");
  return copy(d) as unknown as Direction;
}

function propose(
  s: PreviewState,
  campaign: Campaign,
  body: Record<string, unknown>,
  hypothesis = "",
): StrategyVersion {
  const base = body.base_version_id ?? null;
  if (base !== campaign.active_strategy_id)
    fail("Strategy changed. Reload before proposing another version.");
  if (!text(body.reason).trim()) fail("Explain the proposed change.");
  const active = campaign.active_strategy_id
    ? requireRecord(s.strategies, campaign.active_strategy_id, "Strategy")
    : null;
  const changes = object(body.directions);
  const directions = copy(active?.directions ?? {});
  for (const [profileId, raw] of Object.entries(changes)) {
    if (!campaign.profile_ids.includes(profileId))
      fail("Direction belongs to another profile.");
    const d = validateDirection(raw);
    for (const ref of d.evidence_refs) {
      const observation = requireRecord(s.observations, ref, "Evidence");
      if (
        observation.campaign_id !== campaign.id ||
        observation.profile_id !== profileId
      )
        fail("Evidence belongs to another profile or campaign.");
    }
    directions[profileId] = d;
  }
  if (
    Object.keys(directions).length !== campaign.profile_ids.length ||
    campaign.profile_ids.some((p) => !directions[p])
  )
    fail("Initial direction is required for every campaign profile.");
  const versions = s.strategies.filter((v) => v.campaign_id === campaign.id);
  const version: StrategyVersion = {
    id: id(s, "strategy"),
    campaign_id: campaign.id,
    version: Math.max(0, ...versions.map((v) => v.version)) + 1,
    status: "proposed",
    base_version_id: campaign.active_strategy_id,
    reason: text(body.reason),
    hypothesis,
    created_at: stamp(),
    approved_at: null,
    changed_profile_ids: Object.keys(changes),
    directions,
  };
  s.strategies.unshift(version);
  return version;
}

function route(
  s: PreviewState,
  path: string,
  method: string,
  body: Record<string, unknown>,
  rawBody: BodyInit | null | undefined,
): unknown {
  const parts = path
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  const [, resource, identifier, action, subId, decision] = parts;
  if (method === "GET" && parts.length === 2) {
    if (resource === "system")
      return {
        platform: "Review preview",
        apple_silicon: null,
        memory_gb: null,
        free_disk_gb: null,
        ffmpeg: true,
        ffprobe: true,
        whisper: false,
        model_runtime: false,
        desktop: false,
        data_dir: "Browser-only preview fixtures",
      };
    if (resource === "models") return [];
    if (resource === "analytics")
      return {
        videos: [],
        summary: {},
        events: [],
        notes: ["Review preview: no live analytics."],
      };
    if (resource === "settings") return s.settings;
    if (resource === "jobs") return s.jobs;
    if (resource === "videos") return s.videos;
    if (resource === "clips") return s.clips;
    if (resource === "profiles") return s.profiles;
    if (resource === "campaigns") return s.campaigns;
  }
  if (method === "GET" && path === "/api/instagram/status")
    return {
      connected: false,
      publishing_available: false,
      ads_available: false,
      oauth_configured: false,
      requirements: [
        "Preview only; no account connection or external actions.",
      ],
    };
  if (method === "GET" && path === "/api/team/runs") return [];
  if (method === "GET" && resource === "exports") return [];
  if (method === "POST" && resource === "clips" && action === "export")
    fail("Illustrative clips have no native media. No export was created.");
  if (resource === "settings" && method === "PUT")
    return Object.assign(s.settings, body, {
      publishing_enabled: false,
      ads_enabled: false,
    });
  if (resource === "profiles") {
    if (method === "GET" && identifier && parts.length === 3)
      return requireRecord(s.profiles, identifier, "Profile");
    if (
      (method === "POST" && !identifier) ||
      (method === "PUT" && identifier && parts.length === 3)
    ) {
      if (!text(body.name).trim()) fail("Name the profile.");
      const objective = text(body.objective, "discovery");
      const primary_metric = text(body.primary_metric).trim() || null;
      if (objective !== "discovery" && !primary_metric)
        fail("Choose a primary metric.");
      const profile: Profile = {
        id: identifier ?? id(s, "profile"),
        name: text(body.name),
        audience: text(body.audience),
        brand_context: text(body.brand_context),
        objective,
        primary_metric,
        creative_preferences: text(body.creative_preferences),
      };
      if (identifier)
        Object.assign(
          requireRecord(s.profiles, identifier, "Profile"),
          profile,
        );
      else s.profiles.push(profile);
      return profile;
    }
  }
  if (resource === "videos" && !identifier && method === "POST") {
    const file = rawBody instanceof FormData ? rawBody.get("file") : null;
    if (!(file instanceof File)) fail("Select a video file.");
    const source: Video = {
      id: id(s, "source"),
      name: `${file.name} · preview only`,
      duration: 60,
      width: 1920,
      height: 1080,
      has_audio: false,
      status: "ready",
      size: file.size,
      created_at: stamp(),
    };
    s.videos.push(source);
    return source;
  }
  if (
    resource === "clips" &&
    identifier &&
    method === "PUT" &&
    parts.length === 3
  ) {
    const clip = requireRecord(s.clips, identifier, "Clip");
    if (
      body.hook !== undefined &&
      body.hook !== clip.hook &&
      clip.hook_rendered
    )
      fail("Render a new version to change the burned hook.");
    if (
      body.approved === true &&
      clip.team_run_id &&
      !["pass", "not_applicable"].includes(clip.team_review_status ?? "unknown")
    )
      fail("Unresolved critique prevents approval.");
    if (typeof body.caption === "string" && body.caption !== clip.caption) {
      clip.caption = body.caption;
      clip.approved = false;
    }
    if (typeof body.approved === "boolean") {
      clip.approved = body.approved;
      clip.approved_at = body.approved ? stamp() : null;
    }
    return clip;
  }
  if (
    resource === "clips" &&
    identifier &&
    action === "feedback" &&
    method === "POST"
  ) {
    requireRecord(s.clips, identifier, "Clip");
    return {
      id: id(s, "feedback"),
      clip_id: identifier,
      ...body,
      preview_fixture: true,
    };
  }
  if (
    resource === "jobs" &&
    identifier &&
    action === "cancel" &&
    method === "POST"
  ) {
    const job = requireRecord(s.jobs, identifier, "Job");
    if (["queued", "running"].includes(job.status)) {
      job.status = "cancelled";
      job.message = "Preview simulation cancelled.";
    }
    return job;
  }
  if (resource === "campaigns") {
    if (
      (method === "POST" && !identifier) ||
      (method === "PUT" && identifier && !action)
    ) {
      if (!text(body.name).trim()) fail("Name the campaign.");
      const profile_ids = strings(body.profile_ids),
        video_ids = strings(body.video_ids);
      if (!profile_ids.length) fail("Select a profile.");
      profile_ids.forEach((p) => requireRecord(s.profiles, p, "Profile"));
      video_ids.forEach((v) => requireRecord(s.videos, v, "Source"));
      const old = identifier
        ? requireRecord(s.campaigns, identifier, "Campaign")
        : null;
      if (
        old &&
        (old.profile_ids.some((p) => !profile_ids.includes(p)) ||
          old.video_ids.some((v) => !video_ids.includes(v)))
      )
        fail("Retain existing membership for production history.");
      const brief = object(body.brief);
      const campaign: Campaign = {
        id: identifier ?? id(s, "campaign"),
        name: text(body.name),
        profile_ids,
        video_ids,
        active_strategy_id: old?.active_strategy_id ?? null,
        brief: {
          audience: text(brief.audience),
          constraints: strings(brief.constraints ?? []),
          requested_outputs: strings(brief.requested_outputs ?? []),
          measurement_intent: text(brief.measurement_intent),
        },
      };
      if (old) Object.assign(old, campaign);
      else s.campaigns.push(campaign);
      return campaign;
    }
    if (!identifier) fail("Campaign not found.");
    const campaign = requireRecord(s.campaigns, identifier, "Campaign");
    if (method === "GET" && !action) return campaign;
    if (action === "strategies") {
      if (method === "GET" && !subId)
        return s.strategies
          .filter((v) => v.campaign_id === identifier)
          .sort((a, b) => b.version - a.version);
      if (method === "POST" && !subId) return propose(s, campaign, body);
      if (
        method === "POST" &&
        subId &&
        ["approve", "reject"].includes(decision)
      ) {
        const version = requireRecord(s.strategies, subId, "Strategy");
        if (
          version.campaign_id !== campaign.id ||
          version.status !== "proposed"
        )
          fail("Only this campaign's proposed strategy can be reviewed.");
        if (decision === "approve") {
          if (version.base_version_id !== campaign.active_strategy_id)
            fail("Strategy changed. Reload and review the conflict.");
          if (campaign.profile_ids.some((p) => !version.directions[p]))
            fail("Review direction for every profile.");
          version.status = "approved";
          version.approved_at = stamp();
          campaign.active_strategy_id = version.id;
        } else version.status = "rejected";
        return version;
      }
    }
    if (action === "observations" && method === "GET")
      return s.observations.filter((o) => o.campaign_id === campaign.id);
    if (action === "observations" && method === "POST") {
      const clip = requireRecord(s.clips, text(body.clip_id), "Clip");
      if (
        !clip.approved ||
        clip.campaign_id !== campaign.id ||
        !clip.profile_id
      )
        fail("Select an approved clip in this campaign.");
      const dates = [body.window_start, body.window_end, body.collected_at].map(
        (d) => Date.parse(text(d)),
      );
      if (
        dates.some((d) => !Number.isFinite(d)) ||
        dates[1] <= dates[0] ||
        dates[2] < dates[1] ||
        dates[2] > Date.now()
      )
        fail("Use a positive observation window and collection time after it.");
      if (
        ![body.metric, body.unit, body.publication_reference].every((v) =>
          text(v).trim(),
        )
      )
        fail("Metric, unit and publication reference are required.");
      const value = body.value == null ? null : Number(body.value);
      if (value !== null && (!Number.isFinite(value) || value < 0))
        fail("Observed value must be non-negative or unknown.");
      const observation: PreviewObservation = {
        id: id(s, "observation"),
        campaign_id: campaign.id,
        profile_id: clip.profile_id,
        clip_id: clip.id,
        metric: text(body.metric),
        value,
        unit: text(body.unit),
        source: "manual_import",
        publication_reference: text(body.publication_reference),
        window_start: text(body.window_start),
        window_end: text(body.window_end),
        collected_at: text(body.collected_at),
        notes: `Preview simulation. ${text(body.notes)}`,
      };
      s.observations.push(observation);
      return observation;
    }
    if (action === "learning" && method === "POST") {
      const profileId = text(body.profile_id),
        refs = strings(body.observation_ids);
      if (!refs.length) fail("Select known-value observations.");
      refs.forEach((ref) => {
        const o = requireRecord(s.observations, ref, "Observation");
        if (
          o.campaign_id !== campaign.id ||
          o.profile_id !== profileId ||
          o.value === null
        )
          fail("Evidence must have a known value for this profile.");
      });
      const d = validateDirection(body.proposed_direction);
      d.evidence_refs = [...new Set([...d.evidence_refs, ...refs])];
      return propose(
        s,
        campaign,
        {
          base_version_id: body.base_version_id,
          reason: body.reason,
          directions: { [profileId]: d },
        },
        text(body.hypothesis),
      );
    }
    if (action === "render" && method === "POST") {
      const videoId = text(body.video_id),
        profileId = text(body.profile_id);
      if (
        !campaign.video_ids.includes(videoId) ||
        !campaign.profile_ids.includes(profileId)
      )
        fail("Select this campaign's source and profile.");
      if (
        !campaign.active_strategy_id ||
        body.expected_strategy_version_id !== campaign.active_strategy_id
      )
        fail("Approve the current strategy before rendering.");
      const strategy = requireRecord(
        s.strategies,
        campaign.active_strategy_id,
        "Strategy",
      );
      const d = strategy.directions[profileId];
      const source = requireRecord(s.videos, videoId, "Source");
      const start = Number(body.start ?? 0),
        end =
          body.end == null
            ? Math.min(source.duration ?? 0, start + d.duration_seconds)
            : Number(body.end);
      if (
        ![start, end].every(Number.isFinite) ||
        start < 0 ||
        end <= start ||
        end > (source.duration ?? 0) ||
        end - start > 180
      )
        fail("Choose a positive range within the source.");
      if (
        s.jobs.some(
          (j) =>
            ["queued", "running"].includes(j.status) &&
            object(j.context).video_id === videoId,
        )
      )
        fail("A preview job is already active for this source.");
      const clip: ProductionClip = {
        id: id(s, "clip"),
        video_id: videoId,
        name: "Preview clip · simulated output",
        start,
        end,
        hook: text(body.hook, d.hooks[0] ?? ""),
        caption: text(body.caption),
        objective: requireRecord(s.profiles, profileId, "Profile").objective,
        approved: false,
        status: "ready",
        created_at: stamp(),
        campaign_id: campaign.id,
        profile_id: profileId,
        strategy_version_id: strategy.id,
        strategy_snapshot: copy(d),
        edit_plan: {
          start,
          end,
          hook: text(body.hook, d.hooks[0] ?? ""),
          caption: text(body.caption),
          subtitles: body.subtitles === true,
          format: "vertical",
          framing: d.framing,
          caption_style: d.caption_style,
          hook_overlay: body.opening_treatment !== "cold_open",
          opening_treatment: body.opening_treatment === "cold_open" ? "cold_open" : "text_overlay",
          cold_open_start: typeof body.cold_open_start === "number" ? body.cold_open_start : null,
          cold_open_end: typeof body.cold_open_end === "number" ? body.cold_open_end : null,
          focus_x: typeof body.focus_x === "number" ? body.focus_x : .5,
          changed_variable: text(body.changed_variable),
        },
        provenance_mode: "preview_fixture",
        creator_instructions: text(body.instructions),
        parent_clip_id: typeof body.parent_clip_id === "string" ? body.parent_clip_id : null,
        root_clip_id: typeof body.parent_clip_id === "string" ? (s.clips.find(c => c.id === body.parent_clip_id)?.root_clip_id || body.parent_clip_id) : null,
        revision_number: typeof body.parent_clip_id === "string" ? 1 + (s.clips.find(c => c.id === body.parent_clip_id)?.revision_number || 1) : 1,
        change_reason: text(body.change_reason),
        hook_rendered: true,
        team_review_status: "not_applicable",
        subtitles_burned: null,
        warning:
          "Illustrative review fixture. No real video, captions or technical checks were produced.",
      };
      const job: Job = {
        id: id(s, "job"),
        kind: "render",
        lane: "heavy",
        status: "queued",
        progress: 0,
        message:
          "Simulating a render for interface review; no media processing.",
        error: null,
        result: null,
        context: {
          video_id: videoId,
          campaign_id: campaign.id,
          profile_id: profileId,
          plan: copy(clip.edit_plan),
          attempt: 1,
          parent_clip_id: clip.parent_clip_id,
          retry_of_job_id: null,
          preview_fixture: true,
        },
        created_at: stamp(),
        updated_at: stamp(),
      };
      s.jobs.unshift(job);
      s.pending.push({ job_id: job.id, due_at: Date.now() + 1200, clip });
      return job;
    }
  }
  return fail(`Unsupported ${method} ${path}. No external action was taken.`);
}

export async function previewRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!path.startsWith("/api/")) fail("Only preview API routes are supported.");
  const s = state();
  advance(s);
  let body: Record<string, unknown> = {};
  if (typeof options.body === "string") {
    try {
      body = object(JSON.parse(options.body));
    } catch {
      fail("Invalid JSON body.");
    }
  }
  const result = route(
    s,
    path,
    (options.method ?? "GET").toUpperCase(),
    body,
    options.body,
  );
  persist(s);
  return copy(result) as T;
}
