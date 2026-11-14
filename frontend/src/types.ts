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
