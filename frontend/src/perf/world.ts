import type {
  Campaign,
  Clip,
  FactoryLine,
  FactorySource,
  Job,
  Model,
  Profile,
  Settings,
  Video,
} from "../types";

/**
 * A deterministic, busy local service: a brand with many episodes, hundreds of clips and a long
 * job history. Sizes are chosen to look like a creator a few months in, not an empty install.
 */
export type WorldSize = { videos: number; clipsPerVideo: number; jobs: number };
export const BUSY: WorldSize = { videos: 40, clipsPerVideo: 10, jobs: 120 };

const ISO = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 3_600_000).toISOString();

export type World = {
  settings: Settings;
  models: Model[];
  videos: Video[];
  clips: Clip[];
  jobs: Job[];
  factory: FactoryLine;
  profiles: Profile[];
  campaigns: Campaign[];
  /** Requests served, by path without the query string. */
  hits: Map<string, number>;
};

export function createWorld(size: WorldSize = BUSY): World {
  const videos: Video[] = Array.from({ length: size.videos }, (_, v) => ({
    id: `v${v}`,
    name: `Episode ${v + 1}: a long conversation about building in public.mp4`,
    duration: 3600 + v * 13,
    width: 1920,
    height: 1080,
    has_audio: true,
    has_transcript: true,
    created_at: ISO(v),
    status: "ready",
    transcript: { language: "en", text: "Transcript ".repeat(20), segment_count: 400 },
  }));
  const clips: Clip[] = [];
  videos.forEach((video, v) => {
    for (let c = 0; c < size.clipsPerVideo; c++) {
      const n = v * size.clipsPerVideo + c;
      clips.push({
        id: `clip${n}`,
        video_id: video.id,
        campaign_id: "camp1",
        profile_id: "p1",
        strategy_version_id: "s1",
        name: `Clip ${n}: the moment everything changed`,
        start: c * 60,
        end: c * 60 + 32,
        hook: `Hook ${n}: nobody tells you this about shipping`,
        caption: `Caption ${n} with a few #tags and a call to action.`,
        objective: "discovery",
        approved: n % 3 === 0,
        status: "rendered",
        created_at: ISO(v + c / 10),
        reason: "Self-contained claim with a clear payoff.",
        hypothesis: n % 2 ? "A direct claim earns the stop." : "A question earns the stop.",
        rank: { score: 40 + (n % 60), position: c + 1, below_bar: n % 7 === 0 },
        team_review_status: "pass",
        provenance_mode: "model",
      });
    }
  });
  const jobs: Job[] = Array.from({ length: size.jobs }, (_, j) => ({
    id: `job${j}`,
    kind: j % 4 === 0 ? "render" : "produce",
    status: "completed",
    progress: 1,
    message: "Done",
    lane: "heavy",
    context: { video_id: `v${j % size.videos}` },
    created_at: ISO(j),
    updated_at: ISO(j + 1),
  }));
  const stage = (key: string, label: string): FactorySource["stages"][number] => ({ key, label, status: "done", detail: "" });
  const sources: FactorySource[] = videos.map((video, v) => ({
    video_id: video.id,
    name: video.name,
    duration: video.duration ?? 0,
    created_at: video.created_at,
    state: "needs_review",
    headline: "Clips ready for review",
    progress: null,
    stages: [
      stage("import", "Added"),
      stage("listen", "Listen"),
      stage("watch", "Watch"),
      stage("select", "Pick moments"),
      stage("edit", "Edit"),
      stage("render", "Make clips"),
    ],
    job_id: `job${v}`,
    run_id: null,
    clip_ids: clips.filter((c) => c.video_id === video.id).map((c) => c.id),
    unreviewed: 4,
    approved: 3,
    error: null,
    can_produce: true,
    blocked_reason: null,
    storyboard: null,
    thumbnail: null,
  }));
  return {
    settings: {
      brand: "Busy studio",
      objective: "discovery",
      language: "en",
      autonomy: "review",
      publishing_enabled: false,
      ads_enabled: false,
      daily_budget: 0,
      total_budget: 0,
      graph_version: "v22.0",
      clip_count: 4,
    },
    models: [
      { id: "qwen-small", name: "Qwen small", installed: true, status: "installed", vision: true },
      { id: "qwen-large", name: "Qwen large", installed: false, status: "available" },
    ],
    videos,
    clips,
    jobs,
    factory: { autopilot: false, model_id: "qwen-small", ready: true, blockers: [], sources },
    profiles: [
      {
        id: "p1",
        name: "Busy studio",
        audience: "Founders who ship",
        brand_context: "A podcast about building companies in public.",
        creative_preferences: "Direct, warm, no hype.",
        objective: "discovery",
        active_strategy_id: "s1",
      },
    ],
    campaigns: [
      {
        id: "camp1",
        name: "Autumn push",
        brief: {
          audience: "Founders",
          constraints: ["Keep context"],
          requested_outputs: ["Vertical clips"],
          measurement_intent: "Discovery",
        },
        profile_ids: ["p1"],
        video_ids: videos.map((v) => v.id),
        objective: "discovery",
      },
    ],
    hits: new Map(),
  };
}

const direction = {
  angles: ["A clear point"],
  moment_selection: "Self-contained moments.",
  hooks: ["Claim first"],
  pacing: "Point first.",
  duration_seconds: 30,
  framing: "fit",
  caption_style: "standard",
  editing_preferences: "Readable captions.",
  measurement_questions: [],
  next_experiments: [],
  evidence_refs: [],
  limitations: "",
};

function route(world: World, path: string): unknown {
  switch (path) {
    case "/api/system":
      return { os: "macos", platform: "darwin", apple_silicon: true, memory_gb: 32, ffmpeg: true, ffprobe: true, whisper: true, desktop: true, version: "perf" };
    case "/api/settings":
      return world.settings;
    case "/api/models":
      return world.models;
    case "/api/jobs":
      return world.jobs;
    case "/api/videos":
      return world.videos;
    case "/api/clips":
      return world.clips;
    case "/api/instagram/status":
      return { connected: false, publishing_available: false, ads_available: false, requirements: [] };
    case "/api/analytics":
      return { videos: [], summary: {}, notes: [], events: [] };
    case "/api/factory":
      return world.factory;
    case "/api/profiles":
      return world.profiles;
    case "/api/campaigns":
      return world.campaigns;
    case "/api/profiles/p1/strategies":
      return [
        {
          id: "s1",
          scope: "workspace",
          profile_id: "p1",
          campaign_id: null,
          version: 1,
          status: "approved",
          base_version_id: null,
          reason: "First rules",
          hypothesis: "Direct hooks",
          created_at: ISO(0),
          approved_at: ISO(1),
          changed_profile_ids: ["p1"],
          directions: { p1: direction },
        },
      ];
    case "/api/campaigns/camp1/observations":
      return [];
    case "/api/team/runs":
      return [];
    case "/api/publish-attempts":
    case "/api/post-schedules":
      return [];
    case "/api/cloud/status":
      return { configured: false, signed_in: false, email: null, workspace_id: null };
    default:
      return undefined;
  }
}

/** A fetch stand-in for the local service. Every response is freshly parsed, as over the wire. */
export function fetchFor(world: World) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = url.split("?")[0];
    world.hits.set(path, (world.hits.get(path) ?? 0) + 1);
    const body = route(world, path);
    const found = body !== undefined;
    const text = JSON.stringify(found ? body : { detail: "Not available in the benchmark." });
    return {
      ok: found,
      status: found ? 200 : 404,
      json: async () => JSON.parse(text),
      text: async () => text,
      headers: new Headers({ "content-type": "application/json" }),
    } as Response;
  };
}
