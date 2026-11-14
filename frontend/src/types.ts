export type JsonObject = Record<string, unknown>;
export interface SystemInfo {
  platform?: string;
  apple_silicon?: boolean | null;
  memory_gb?: number | null;
  free_disk_gb?: number | null;
  ffmpeg?: boolean | null;
  ffprobe?: boolean | null;
  whisper?: boolean | null;
  model_runtime?: boolean | string | null;
  ollama?: boolean | null;
  desktop?: boolean | null;
  data_dir?: string;
}
export const objectives = [
  "discovery",
  "awareness",
  "engagement",
  "followers",
  "traffic",
  "leads",
  "sales",
  "custom",
] as const;
export interface Settings {
  production_strategy?: "swarm" | "team" | "baseline";
  brand: string;
  objective: string;
  language: string;
  /** "auto": new footage starts production by itself. "review": you press Make clips. */
  autonomy: string;
  /** "" lets the factory pick an installed model. */
  default_model?: string;
  /** How many clips to aim for per source (1–6). */
  clip_count?: number;
  publishing_enabled: boolean;
  ads_enabled: boolean;
  daily_budget: number;
  total_budget: number;
  graph_version: string;
  custom_event?: string;
}
export interface Model {
  id: string;
  name: string;
  repo?: string;
  kind?: string;
  license?: string;
  estimated_gb?: number | null;
  installed?: boolean;
  status?: string;
  source?: "ollama";
  vision?: boolean;
}
export interface Job {
  lane?: "download" | "heavy";
  context?: unknown;
  id: string;
  kind: string;
  status: string;
  progress?: number | null;
  message?: string | null;
  error?: string | null;
  result?: JsonObject | null;
  created_at?: string;
  updated_at?: string;
}
export interface Candidate {
  start: number;
  end: number;
  hook?: string;
  caption?: string;
  reason?: string;
  objective?: string;
}
export interface StoryboardSummary {
  scenes: number;
  vision: boolean;
  model_id: string | null;
  updated_at: string;
}
export interface Video {
  has_audio?: boolean | null;
  id: string;
  name: string;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  size?: number | null;
  created_at?: string;
  /** List responses carry a slim {language, text, segment_count}; older services sent the full transcript. */
  transcript?: unknown;
  has_transcript?: boolean;
  storyboard?: StoryboardSummary | null;
  analysis?: unknown;
  status?: string;
}
export interface Clip {
  hook_rendered?: boolean;
  campaign_id?: string | null;
  profile_id?: string | null;
  strategy_version_id?: string | null;
  strategy_snapshot?: unknown;
  edit_plan?: unknown;
  provenance_mode?: string | null;
  creator_instructions?: string | null;
  team_run_id?: string | null;
  team_review_status?: "pass" | "fail" | "unknown" | "not_applicable" | null;
  team_findings?: unknown;
  /** Why the factory picked this moment. */
  reason?: string;
  moment_summary?: string;
  /** Swarm clips: the reason a viewer is expected to stop scrolling. */
  hypothesis?: string | null;
  scene_refs?: string[];
  approval_override?: { at: string; review_status: string } | null;
  technical_checks?: unknown;
  id: string;
  video_id: string;
  name: string;
  start: number;
  end: number;
  hook: string;
  caption: string;
  objective: string;
  approved: boolean;
  created_at?: string;
  status?: string;
  instagram_media_id?: string | null;
  published_at?: string | null;
  instagram_account_id?: string | null;
  publish_attempt?: string | null;
  warning?: string | null;
  subtitles_burned?: boolean | null;
}
export interface InstagramStatus {
  connected?: boolean;
  account?: unknown;
  publishing_available?: boolean;
  ads_available?: boolean;
  requirements?: unknown[];
  oauth_configured?: boolean;
}
export interface AnalyticsRow {
  clip_id: string;
  name?: string;
  objective?: string;
  organic?: Record<string, number | null>;
  paid?: Record<string, number | null>;
  attribution?: unknown;
  source?: string | null;
  updated_at?: string | null;
}
export interface Analytics {
  videos?: AnalyticsRow[];
  summary?: JsonObject;
  notes?: unknown[];
  events?: unknown[];
}
export type StageStatus = "done" | "active" | "pending" | "skipped" | "failed";
export interface FactoryStage {
  key: string;
  label: string;
  status: StageStatus;
  detail: string;
}
export type SourceState =
  | "idle"
  | "queued"
  | "working"
  | "needs_review"
  | "done"
  | "failed"
  | "cancelled";
export interface FactorySource {
  video_id: string;
  name: string;
  duration: number;
  created_at?: string;
  state: SourceState;
  headline: string;
  progress: number | null;
  stages: FactoryStage[];
  job_id: string | null;
  run_id: string | null;
  clip_ids: string[];
  unreviewed: number;
  approved: number;
  error: string | null;
  can_produce: boolean;
  blocked_reason: string | null;
  storyboard: StoryboardSummary | null;
  thumbnail: string | null;
}
export interface FactoryBlocker {
  code: string;
  message: string;
  tab: string | null;
}
/** GET /api/factory: the production line, computed by the local service. */
export interface FactoryLine {
  autopilot: boolean;
  model_id: string | null;
  ready: boolean;
  blockers: FactoryBlocker[];
  sources: FactorySource[];
}
export interface StoryboardFrame {
  time: number;
  url: string;
}
export interface StoryboardScene {
  index: number;
  start: number;
  end: number;
  usable: boolean;
  score: number;
  motion: number;
  loudness: number | null;
  peak_time: number;
  cuts: number;
  speech: string;
  visual: string | null;
  action: "none" | "low" | "medium" | "high" | null;
  on_screen_text: string[];
  highlight: number | null;
  highlight_reason: string;
  frames: StoryboardFrame[];
}
/** GET /api/videos/{id}/storyboard: what the factory saw and heard in a source. */
export interface Storyboard {
  video_id: string;
  version?: number;
  model_id: string | null;
  vision: boolean;
  created_at?: string;
  elapsed_seconds?: number;
  duration: number;
  signals: { interval: number; motion: number[]; loudness: (number | null)[] };
  scenes: StoryboardScene[];
  limitations: string;
}
export interface Data {
  system: SystemInfo | null;
  settings: Settings | null;
  models: Model[];
  jobs: Job[];
  videos: Video[];
  clips: Clip[];
  instagram: InstagramStatus | null;
  analytics: Analytics | null;
  factory: FactoryLine | null;
}
export type Resource = keyof Data;

export interface AdAccount {
  id: string;
  name?: string;
  currency?: string;
  [key: string]: unknown;
}
export interface AdAccounts {
  accounts: AdAccount[];
  supported?: boolean;
  note?: string;
}
export interface AdInsights {
  rows: unknown[];
  source?: unknown;
  attribution?: unknown;
  note?: string;
}

export interface TeamTask {
  id: string;
  role: string;
  label: string;
  kind: "agent" | "tool";
  status: string;
  iteration: number;
  input_refs: string[];
  output: JsonObject | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}
export interface TeamRun {
  id: string;
  video_id: string;
  mode: "swarm" | "team" | "baseline";
  model_id: string;
  objective: string;
  status: string;
  job_id: string;
  revision_budget: number;
  revision_count: number;
  stop_reason: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  elapsed_seconds: number | null;
  resource_observations: unknown;
  clip_ids: string[];
  plan: unknown;
  context: unknown;
  permissions: { publish: false; ads: false };
  tasks: TeamTask[];
}
export interface TeamComparison {
  video_id: string;
  runs: Array<
    Pick<
      TeamRun,
      | "id"
      | "mode"
      | "status"
      | "model_id"
      | "objective"
      | "elapsed_seconds"
      | "clip_ids"
      | "resource_observations"
    > & {
      feedback: unknown;
      outcomes: unknown;
      comparable: boolean | null;
    }
  >;
  notes: string[];
}

export interface Profile {
  id: string;
  name: string;
  audience: string;
  brand_context: string;
  objective: string;
  primary_metric: string | null;
  creative_preferences: string;
}
export interface CampaignBrief {
  audience: string;
  constraints: string[];
  requested_outputs: string[];
  measurement_intent: string;
}
export interface Campaign {
  id: string;
  name: string;
  brief: CampaignBrief;
  profile_ids: string[];
  video_ids: string[];
  active_strategy_id: string | null;
}
export interface Direction {
  angles: string[];
  moment_selection: string;
  hooks: string[];
  pacing: string;
  duration_seconds: number;
  framing: "fit" | "fill";
  caption_style: "standard" | "high_contrast";
  editing_preferences: string;
  measurement_questions: string[];
  next_experiments: string[];
  evidence_refs: string[];
  limitations: string;
  confidence: "low" | "medium" | "high";
}
export interface StrategyVersion {
  id: string;
  campaign_id: string;
  version: number;
  status: "proposed" | "approved" | "rejected";
  base_version_id: string | null;
  reason: string;
  hypothesis: string;
  created_at: string;
  approved_at: string | null;
  changed_profile_ids: string[];
  directions: Record<string, Direction>;
}
export interface Observation {
  id: string;
  profile_id: string;
  clip_id: string;
  metric: string;
  value: number | null;
  unit: string;
  source: "manual_import";
  publication_reference: string;
  window_start: string;
  window_end: string;
  collected_at: string;
  notes: string;
}
