import { api, post } from "../api";

export type CheckStatus = "pass" | "fail" | "unknown";

export interface QualityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface QualityReport {
  clip_id: string;
  sha256: string | null;
  verdict: "pass" | "hold";
  reasons: string[];
  notes?: string[];
  checks: QualityCheck[];
  rubric: {
    hook_clarity: number | null;
    standalone_context: number | null;
    caption_legibility: number | null;
    technical: number | null;
  };
}

export type AttemptState =
  | "scheduled"
  | "created"
  | "uploading"
  | "uploaded"
  | "container_created"
  | "container_ready"
  | "published"
  | "mapped"
  | "failed"
  | "cancelled"
  | "unknown";

export interface PublishAttempt {
  id: string;
  clip_id: string;
  account_id: string;
  account_name?: string | null;
  sha256: string;
  caption: string;
  state: AttemptState;
  pending_effect: string | null;
  active: boolean;
  media_id: string | null;
  permalink: string | null;
  warnings: string[];
  error: { code: string; message: string } | null;
  mapping: { status: string; detail?: string };
  override_reason: string | null;
  updated_at: string;
  package?: PostPackageRecord;
  cover_mode?: "cover_url" | "thumb_offset" | null;
  scheduled_for?: string | null;
  schedule_id?: string | null;
  posted_at?: string | null;
}

/** What went out with an attempt, recorded for learning (cover source, caption hash, timing). */
export interface PostPackageRecord {
  caption_sha256: string;
  caption_chars: number;
  hashtags: string[];
  mentions: string[];
  cta: "link_in_bio" | null;
  share_to_feed: boolean;
  collaborators: string[];
  cover: { source: string; time_ms: number; sha256: string | null };
}

export interface PostLimits {
  caption_chars: number;
  hashtags: number;
  mentions: number;
  collaborators: number;
  collaborators_supported: boolean;
}

export interface PostPackageView {
  limits: PostLimits;
  auto_cover: { source: string; time_ms: number; url: string };
  candidates: { time_ms: number; url: string; auto: boolean }[];
  duration: number | null;
  collaborators_note: string;
}

export interface PostSchedule {
  id: string;
  clip_id: string;
  account_ids: string[];
  publish_at: string;
  timezone: string | null;
  status: "scheduled" | "submitted" | "cancelled";
  overdue_at: string | null;
  note: string;
  attempts: PublishAttempt[];
}

export interface PostOptions {
  share_to_feed: boolean;
  cover_time_ms: number | null;
}

export interface PostTargets {
  accounts: { id: string; display_name: string | null }[];
  cloud_configured: boolean;
  signed_in: boolean;
  attempts: PublishAttempt[];
  schedules?: PostSchedule[];
  default_caption: string;
}

const clipPath = (id: string, action: string) =>
  `/api/clips/${encodeURIComponent(id)}/${action}`;
const attemptPath = (id: string, action?: string) =>
  `/api/publish-attempts/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

/** States where the publish lane is (or may be) still doing something. */
export const inFlight = (a: PublishAttempt) =>
  a.active && !["mapped", "failed", "cancelled", "unknown", "scheduled"].includes(a.state);

/** States a human may continue from without risking a duplicate post. */
export const canResume = (a: PublishAttempt) =>
  !a.active &&
  (["created", "uploaded", "container_created", "container_ready"].includes(a.state) ||
    (a.state === "published" && a.mapping.status !== "mapped"));

export const stateLabel: Record<AttemptState, string> = {
  scheduled: "Scheduled",
  created: "Queued",
  uploading: "Uploading video",
  uploaded: "Hosted; creating Reel",
  container_created: "Instagram is processing",
  container_ready: "Ready to publish",
  published: "Posted",
  mapped: "Posted · learning tracks it",
  failed: "Not posted",
  cancelled: "Cancelled",
  unknown: "Outcome unknown · check status",
};

export const publishApi = {
  quality: (clipId: string, refresh = false) =>
    api<QualityReport>(`${clipPath(clipId, "quality")}${refresh ? "?refresh=true" : ""}`),
  targets: (clipId: string) => api<PostTargets>(clipPath(clipId, "post-targets")),
  post: (
    clipId: string,
    body: {
      account_id: string;
      caption: string;
      sha256: string;
      override_reason?: string;
      share_to_feed?: boolean;
      cover_time_ms?: number | null;
    },
  ) => post<PublishAttempt>(clipPath(clipId, "post"), body),
  postPackage: (clipId: string) => api<PostPackageView>(clipPath(clipId, "post-package")),
  schedule: (
    clipId: string,
    body: {
      account_ids: string[];
      captions: Record<string, string>;
      sha256: string;
      publish_at: string;
      timezone: string;
      override_reason?: string;
      share_to_feed: boolean;
      cover_time_ms: number | null;
    },
  ) => post<PostSchedule>(clipPath(clipId, "schedule-post"), body),
  decide: (id: string, action: "post_now" | "reschedule" | "cancel", publish_at?: string) =>
    post<PostSchedule>(`/api/post-schedules/${encodeURIComponent(id)}/decision`, {
      action,
      ...(publish_at ? { publish_at } : {}),
    }),
  attempt: (id: string) => api<PublishAttempt>(attemptPath(id)),
  reconcile: (id: string) => post<PublishAttempt>(attemptPath(id, "reconcile")),
  resume: (id: string) => post<PublishAttempt>(attemptPath(id, "resume")),
};

// ------------------------------------------------------------------ caption package helpers

/** Same counting rules as the server (clip_factory/post_package.py). */
export const hashtagsOf = (text: string) =>
  [...text.matchAll(/(?:^|(?<=\s))#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]);
export const mentionsOf = (text: string) =>
  [...text.matchAll(/(?:^|(?<=\s))@([A-Za-z0-9_.]+)/g)].map((m) => m[1]);
export const LINK_IN_BIO = "Link in bio.";
export const hasLinkInBio = (text: string) => text.toLowerCase().includes("link in bio");

/** Add or remove one hashtag; added tags go on a final hashtag line. */
export function toggleHashtag(text: string, tag: string): string {
  const pattern = new RegExp(`(^|\\s)#${tag.replace(/[^\p{L}\p{N}_]/gu, "")}(?![\\p{L}\\p{N}_])`, "u");
  if (pattern.test(text)) return text.replace(pattern, "$1").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trimEnd();
  const lines = text.trimEnd().split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (last.trim() && last.trim().split(/\s+/).every((w) => w.startsWith("#")))
    return [...lines.slice(0, -1), `${last.trimEnd()} #${tag}`].join("\n");
  return `${text.trimEnd()}${text.trim() ? "\n\n" : ""}#${tag}`;
}

/** Put "Link in bio." before a trailing hashtag line, or at the end. */
export function addLinkInBio(text: string): string {
  if (hasLinkInBio(text)) return text;
  const lines = text.trimEnd().split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (lines.length > 1 && last.trim().split(/\s+/).every((w) => w.startsWith("#")))
    return [...lines.slice(0, -1), "", LINK_IN_BIO, "", last].join("\n").replace(/\n{3,}/g, "\n\n");
  return `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${LINK_IN_BIO}`;
}

export interface CaptionCheck {
  chars: number;
  hashtags: number;
  mentions: number;
  problems: string[];
}

export function checkCaption(text: string, limits: Pick<PostLimits, "caption_chars" | "hashtags" | "mentions">): CaptionCheck {
  const chars = text.length, hashtags = hashtagsOf(text).length, mentions = mentionsOf(text).length;
  const problems: string[] = [];
  if (chars > limits.caption_chars) problems.push(`Captions are limited to ${limits.caption_chars.toLocaleString()} characters.`);
  if (hashtags > limits.hashtags) problems.push(`Instagram allows at most ${limits.hashtags} hashtags.`);
  if (mentions > limits.mentions) problems.push(`Instagram allows at most ${limits.mentions} mentions.`);
  return { chars, hashtags, mentions, problems };
}

export const DEFAULT_LIMITS: PostLimits = {
  caption_chars: 2200, hashtags: 30, mentions: 20, collaborators: 3, collaborators_supported: false,
};

/** Local wall-clock suggestions; returned as Date objects in the person's own timezone. */
export function scheduleSuggestions(now: Date): { label: string; at: Date }[] {
  const tonight = new Date(now); tonight.setHours(19, 0, 0, 0);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const out: { label: string; at: Date }[] = [];
  if (tonight.getTime() - now.getTime() > 5 * 60_000) out.push({ label: "Tonight 7pm", at: tonight });
  out.push({ label: "Tomorrow 9am", at: tomorrow });
  return out;
}

/** "2026-11-14T19:00" for <input type="datetime-local"> in local time. */
export function localInputValue(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Local datetime-local value → ISO string with the local UTC offset (the server needs an offset). */
export function withOffset(local: string): string | null {
  const at = new Date(local);
  if (!local || Number.isNaN(at.getTime())) return null;
  const minutes = -at.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${localInputValue(at)}:00${sign}${pad(minutes / 60)}:${pad(minutes % 60)}`;
}

export const localTimezone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"; } catch { return "local time"; }
};
