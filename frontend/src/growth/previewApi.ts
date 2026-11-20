import type {
  Campaign,
  CampaignBrief,
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
import type { PostingAccount, TikTokCreatorInfo } from "./publishApi";
import { normalizeBrief } from "./briefModel";
import { flowFixture } from "./previewFlowFixtures";

/** Explicit review-only transport. Never calls fetch or the desktop service. */
const STORAGE_KEY = "growth-factory-preview-v2";
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
      creative_preferences:
        "Clear claims, preserved context, restrained captions.",
      active_strategy_id: null,
    },
    {
      id: "preview-profile-test",
      name: "Test profile",
      audience: "A separate test audience",
      brand_context: "Independent local planning profile.",
      creative_preferences: "Keep this profile's direction separate.",
      active_strategy_id: null,
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
        objective: "traffic",
        primary_metric: "Full-episode visits",
        notes: "",
      },
    ],
    strategies: [
      // One workspace rule set per profile; only the All-In workspace has a draft.
      {
        id: "preview-strategy-v1",
        scope: "workspace",
        profile_id: profiles[0].id,
        campaign_id: null,
        version: 1,
        status: "proposed",
        base_version_id: null,
        reason:
          "Illustrative creator-provided opening test; ready for your review.",
        hypothesis: "",
        created_at: stamp(),
        approved_at: null,
        changed_profile_ids: [profiles[0].id],
        directions: { [profiles[0].id]: direction() },
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
      production_strategy: "swarm",
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

/** Save a PROPOSED workspace rule set. Never approves it. */
function propose(
  s: PreviewState,
  profile: Profile,
  body: Record<string, unknown>,
  hypothesis = "",
): StrategyVersion {
  const base = body.base_version_id ?? null;
  const active = profile.active_strategy_id ?? null;
  if (base !== active)
    fail("Style rules changed. Reload before proposing another version.");
  if (!text(body.reason).trim()) fail("Explain the proposed change.");
  const d = validateDirection(body.direction);
  for (const ref of d.evidence_refs) {
    const observation = requireRecord(s.observations, ref, "Evidence");
    if (observation.profile_id !== profile.id)
      fail("Evidence belongs to another brand.");
  }
  const versions = s.strategies.filter((v) => v.profile_id === profile.id);
  const version: StrategyVersion = {
    id: id(s, "strategy"),
    scope: "workspace",
    profile_id: profile.id,
    campaign_id: null,
    version: Math.max(0, ...versions.map((v) => v.version)) + 1,
    status: "proposed",
    base_version_id: active,
    reason: text(body.reason),
    hypothesis,
    created_at: stamp(),
    approved_at: null,
    changed_profile_ids: [profile.id],
    directions: { [profile.id]: d },
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
  if (method === "GET" && path === "/api/publish-attempts") return [];
  if (method === "GET" && path === "/api/post-schedules") return [];
  if (method === "GET" && path === "/api/posting/accounts") return copy(PREVIEW_ACCOUNTS);
  if (method === "GET" && /^\/api\/posting\/accounts\/[^/]+\/tiktok-creator-info$/.test(path))
    return previewCreatorInfo;
  if (method === "GET" && resource === "exports") return [];
  if (
    method === "GET" &&
    resource === "clips" &&
    identifier &&
    parts.length === 4 &&
    action &&
    ["quality", "post-targets", "post-package", "post-copy"].includes(action)
  )
    return previewPostPackage(requireRecord(s.clips, identifier, "Clip"), action);
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
      if (!text(body.name).trim()) fail("Name the brand.");
      const old = identifier
        ? requireRecord(s.profiles, identifier, "Profile")
        : null;
      // Workspace fields only; goals live on campaigns.
      const profile: Profile = {
        id: identifier ?? id(s, "profile"),
        name: text(body.name),
        audience: text(body.audience),
        brand_context: text(body.brand_context),
        creative_preferences: text(body.creative_preferences),
        active_strategy_id: old?.active_strategy_id ?? null,
        // Omitted keeps the saved brand kit, as the local service does.
        brand_kit:
          "brand_kit" in body
            ? ((body.brand_kit as Profile["brand_kit"]) ?? null)
            : (old?.brand_kit ?? null),
      };
      if (old) Object.assign(old, profile);
      else s.profiles.push(profile);
      return profile;
    }
    if (identifier && action === "strategies") {
      const profile = requireRecord(s.profiles, identifier, "Profile");
      if (method === "GET" && !subId)
        return s.strategies
          .filter((v) => v.profile_id === identifier)
          .sort((a, b) => b.version - a.version);
      if (method === "POST" && !subId) return propose(s, profile, body);
      if (
        method === "POST" &&
        subId &&
        ["approve", "reject"].includes(decision)
      ) {
        const version = requireRecord(s.strategies, subId, "Strategy");
        if (version.profile_id !== profile.id || version.status !== "proposed")
          fail("Only this brand's proposed style rules can be reviewed.");
        if (decision === "approve") {
          if (version.base_version_id !== (profile.active_strategy_id ?? null))
            fail("Style rules changed. Reload and review the conflict.");
          version.status = "approved";
          version.approved_at = stamp();
          profile.active_strategy_id = version.id;
        } else version.status = "rejected";
        return version;
      }
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
      if (!profile_ids.length) fail("Select a brand.");
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
      const brief = body.brief === undefined && old ? {} : object(body.brief);
      const campaign: Campaign = {
        id: identifier ?? id(s, "campaign"),
        name: text(body.name),
        profile_ids,
        video_ids,
        objective:
          body.objective === undefined
            ? (old?.objective ?? "discovery")
            : text(body.objective, "discovery"),
        primary_metric:
          body.primary_metric === undefined
            ? (old?.primary_metric ?? null)
            : text(body.primary_metric).trim() || null,
        notes: body.notes === undefined ? (old?.notes ?? "") : text(body.notes),
        // Omitted brief keeps the saved one, as the service does; every field is kept.
        brief:
          body.brief === undefined && old
            ? old.brief
            : normalizeBrief({
                ...(brief as Partial<CampaignBrief>),
                audience: text(brief.audience),
                constraints: strings(brief.constraints ?? []),
                requested_outputs: strings(brief.requested_outputs ?? []),
                measurement_intent: text(brief.measurement_intent),
              }),
      };
      if (campaign.objective !== "discovery" && !campaign.primary_metric)
        fail("Choose a primary metric.");
      if (campaign.objective === "discovery") campaign.primary_metric = null;
      if (old) Object.assign(old, campaign);
      else s.campaigns.push(campaign);
      return campaign;
    }
    if (!identifier) fail("Campaign not found.");
    const campaign = requireRecord(s.campaigns, identifier, "Campaign");
    if (method === "GET" && !action) return campaign;
    if (action === "strategies") {
      if (method === "GET" && !subId) return [];
      fail("Style rules belong to the brand now.");
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
          fail("Evidence must have a known value for this brand.");
      });
      const d = validateDirection(body.proposed_direction);
      d.evidence_refs = [...new Set([...d.evidence_refs, ...refs])];
      return propose(
        s,
        requireRecord(s.profiles, profileId, "Profile"),
        {
          base_version_id: body.base_version_id,
          reason: body.reason,
          direction: d,
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
        fail("Select this campaign's source and brand.");
      const rules = requireRecord(s.profiles, profileId, "Profile")
        .active_strategy_id;
      if (!rules || body.expected_strategy_version_id !== rules)
        fail("The approved style rules changed or are missing. Reload before rendering.");
      const strategy = requireRecord(s.strategies, rules, "Strategy");
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
        objective: campaign.objective ?? "discovery",
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
          opening_treatment:
            body.opening_treatment === "cold_open"
              ? "cold_open"
              : "text_overlay",
          cold_open_start:
            typeof body.cold_open_start === "number"
              ? body.cold_open_start
              : null,
          cold_open_end:
            typeof body.cold_open_end === "number" ? body.cold_open_end : null,
          focus_x: typeof body.focus_x === "number" ? body.focus_x : 0.5,
          changed_variable: text(body.changed_variable),
        },
        provenance_mode: "preview_fixture",
        creator_instructions: text(body.instructions),
        parent_clip_id:
          typeof body.parent_clip_id === "string" ? body.parent_clip_id : null,
        root_clip_id:
          typeof body.parent_clip_id === "string"
            ? s.clips.find((c) => c.id === body.parent_clip_id)?.root_clip_id ||
              body.parent_clip_id
            : null,
        revision_number:
          typeof body.parent_clip_id === "string"
            ? 1 +
              (s.clips.find((c) => c.id === body.parent_clip_id)
                ?.revision_number || 1)
            : 1,
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
  // Opt-in, clearly labelled design fixtures for the Factory map and Results (?fixtures=flow).
  const fixture = flowFixture(path, (options.method ?? "GET").toUpperCase());
  if (fixture !== undefined) return fixture as T;
  if (path === "/api/factory")
    return {
      autopilot: false,
      model_id: null,
      ready: false,
      blockers: [
        {
          code: "preview",
          message: "Review preview: production runs only in the desktop app.",
          tab: null,
        },
      ],
      sources: [],
    } as T;
  if (path.startsWith("/api/cloud/")) return previewCloud(path, options) as T;
  // The Strategist reads real measured posts; the preview has none, so it
  // shows the honest empty state rather than an unsupported-route error.
  const strategist = /^\/api\/strategist\/([^/]+)$/.exec(path);
  if (strategist && (options.method ?? "GET").toUpperCase() === "GET")
    return {
      profile_id: decodeURIComponent(strategist[1]),
      target_metric: null,
      baseline: { statistic: null, posts: 0, metrics: {} },
      beliefs: [],
      portfolio: null,
      pending_proposals: { style_rules: [], campaign: [] },
      runs: [],
      measured_posts: 0,
      due_layers: [],
      caveat: "Review preview: no measured posts. The Strategist learns from posts measured in the desktop app.",
      simulated: false,
    } as T;
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

/** Review preview of the optional account. Off unless localStorage
 * "gf.preview.cloud" is "1"; then sign-in/up succeed locally. The password in
 * the request body is never read or kept. */
let previewCloudEmail: string | null = null;
function previewCloud(path: string, options: RequestInit) {
  let configured = false;
  try {
    configured = localStorage.getItem("gf.preview.cloud") === "1";
  } catch {
    /* preview preference only */
  }
  if (configured && (path === "/api/cloud/sign-in" || path === "/api/cloud/sign-up")) {
    try {
      const body = JSON.parse(String(options.body ?? "{}")) as { email?: unknown };
      previewCloudEmail = typeof body.email === "string" ? body.email : null;
    } catch {
      previewCloudEmail = null;
    }
  }
  if (path === "/api/cloud/sign-out") previewCloudEmail = null;
  return {
    configured,
    signed_in: configured && !!previewCloudEmail,
    email: configured ? previewCloudEmail : null,
    workspace_id: configured && previewCloudEmail ? "preview-workspace" : null,
  };
}

/** Illustrative frame art (inline SVG) so the cover strip and phone preview render without media. */
function previewFrame(hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 160"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 32% 34%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 28% 16%)"/></linearGradient></defs><rect width="90" height="160" fill="url(#g)"/><circle cx="45" cy="58" r="17" fill="hsl(${hue} 20% 70%)" opacity=".55"/><rect x="22" y="80" width="46" height="60" rx="18" fill="hsl(${hue} 20% 70%)" opacity=".4"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Post package for the review preview: illustrative data only; posting itself stays unsupported. */
function previewPostPackage(clip: ProductionClip, action: string): unknown {
  const times = [1200, 4300, 8000, 12500, 17000, 22400];
  if (action === "quality")
    return {
      clip_id: clip.id,
      sha256: clip.sha256 ?? null,
      verdict: "hold",
      reasons: [
        "No captions burned in (illustrative preview: nothing was rendered)",
        "Technical checks did not run on preview artwork",
      ],
      notes: ["Review preview fixture."],
      checks: [],
      rubric: { hook_clarity: 4, standalone_context: 3, caption_legibility: null, technical: 2 },
    };
  if (action === "post-targets")
    return {
      accounts: PREVIEW_ACCOUNTS.filter((a) => a.status === "active").map((a) => ({
        id: a.id, display_name: a.display_name, verified_at: a.verified_at, platform: a.platform,
        platform_label: a.platform_label, publishing_permitted: a.publishing_permitted === true,
      })),
      cloud_configured: true,
      signed_in: true,
      // The review preview never posts.
      publishing_enabled: false,
      attempts: [],
      schedules: [],
      default_caption: clip.caption || clip.hook || "",
    };
  if (action === "post-copy")
    return {
      clip_id: clip.id,
      post_copy: {
        caption: `${clip.hook || clip.name}\n\nFour panels, one call, and the question nobody wanted to answer on air. Full episode on the channel.`,
        hashtags: ["allin", "podcast", "ai", "startups", "venturecapital"],
        source: "template",
        label: "Illustrative copy",
        model_id: null,
        fallback_reason: null,
        checks: [],
        generated_at: stamp(),
      },
      job: null,
    };
  return {
    limits: { caption_chars: 2200, hashtags: 30, mentions: 20, collaborators: 3, collaborators_supported: true },
    auto_cover: { source: "preview", time_ms: times[1], url: previewFrame(192) },
    candidates: times.map((t, i) => ({ time_ms: t, url: previewFrame(170 + i * 22), auto: i === 1 })),
    duration: 30,
    collaborators_note: "Instagram only: up to 3 public Business or Creator usernames. A rejected invite does not stop the post.",
  };
}

// Illustrative connected accounts: one allowed, one not yet allowed, one waiting to be linked.
const PREVIEW_ACCOUNTS: PostingAccount[] = [
  { id: "6a0000000000000000000001", platform: "instagram", platform_label: "Instagram", display_name: "allin_clips", status: "active", publishing_permitted: true },
  { id: "6a0000000000000000000002", platform: "tiktok", platform_label: "TikTok", display_name: "allin.clips", status: "active", publishing_permitted: false },
  { id: "6a0000000000000000000003", platform: "youtube", platform_label: "YouTube", display_name: "All-In Clips", status: "unbound", publishing_permitted: false },
].map((a) => ({
  ...a, provider: "zernio", zernio_account_id: a.id, username: a.display_name, avatar_url: null,
  profile_id: a.status === "active" ? "preview-profile-allin" : null, verified_at: "2026-11-01T12:00:00+00:00",
  updated_at: "2026-11-01T12:00:00+00:00",
})) as PostingAccount[];

const previewCreatorInfo: TikTokCreatorInfo = {
  creator: { nickname: "allin.clips", isVerified: false, canPostMore: true },
  privacyLevels: [
    { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
    { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" },
    { value: "SELF_ONLY", label: "Only me" },
  ],
  postingLimits: {
    maxVideoDurationSec: 600,
    interactionSettings: {
      allow_comment: { enabled: true, label: "Allow Comment" },
      allow_duet: { enabled: true, label: "Allow Duet" },
      allow_stitch: { enabled: false, label: "Allow Stitch" },
    },
  },
};
