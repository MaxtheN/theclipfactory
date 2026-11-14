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
  production_strategy?: "team" | "baseline";
  brand: string;
  objective: string;
  language: string;
  autonomy: string;
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
export interface Video {
  has_audio?: boolean | null;
  id: string;
  name: string;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  size?: number | null;
  created_at?: string;
  transcript?: unknown;
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
export interface Data {
  system: SystemInfo | null;
  settings: Settings | null;
  models: Model[];
  jobs: Job[];
  videos: Video[];
  clips: Clip[];
  instagram: InstagramStatus | null;
  analytics: Analytics | null;
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
  mode: "team" | "baseline";
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
