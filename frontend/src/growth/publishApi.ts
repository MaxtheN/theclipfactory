import { api, post, put } from "../api";

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
  | "submitted"
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
  /** Where it was posted (instagram, tiktok, youtube, …). */
  platform?: string;
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
  published_at?: string | null;
  platform_post_id?: string | null;
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
  platform?: string;
  youtube?: { title: string; visibility: YoutubeVisibility };
  tiktok?: Omit<TikTokSettings, "content_preview_confirmed" | "express_consent_given"> & { nickname?: string | null };
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

export type YoutubeVisibility = "public" | "unlisted" | "private";

/** What the creator chose in the TikTok step; TikTok requires every field on every post. */
export interface TikTokSettings {
  privacy_level: string;
  allow_comment: boolean;
  allow_duet: boolean;
  allow_stitch: boolean;
  content_preview_confirmed: boolean;
  express_consent_given: boolean;
}

/** Post package fields the server accepts for post and schedule (clip_factory/publish_api.PackageFields). */
export interface PackageFields {
  share_to_feed?: boolean;
  cover_time_ms?: number | null;
  /** Instagram only; the server rejects them for other platforms. */
  collaborators?: string[];
  youtube_title?: string | null;
  youtube_visibility?: YoutubeVisibility;
  tiktok?: TikTokSettings | null;
}

export interface PostTarget {
  id: string;
  display_name: string | null;
  verified_at?: string | null;
  platform: string;
  platform_label: string | null;
  /** Per-account permission from Settings; posting is refused until it is on. */
  publishing_permitted: boolean;
}

export interface PostTargets {
  accounts: PostTarget[];
  cloud_configured: boolean;
  signed_in: boolean;
  /** The app-wide posting switch in Settings. */
  publishing_enabled: boolean;
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
  (["created", "uploaded", "submitted"].includes(a.state) ||
    (a.state === "published" && a.mapping.status !== "mapped"));

export const stateLabel: Record<AttemptState, string> = {
  scheduled: "Scheduled",
  created: "Queued",
  uploading: "Uploading video",
  uploaded: "Uploaded; ready to post",
  submitted: "Sent · the platform is processing",
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
    body: PackageFields & {
      account_id: string;
      caption: string;
      sha256: string;
      override_reason?: string;
    },
  ) => post<PublishAttempt>(clipPath(clipId, "post"), body),
  postPackage: (clipId: string) => api<PostPackageView>(clipPath(clipId, "post-package")),
  schedule: (
    clipId: string,
    body: PackageFields & {
      account_ids: string[];
      captions: Record<string, string>;
      sha256: string;
      publish_at: string;
      timezone: string;
      override_reason?: string;
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
  tiktokCreatorInfo: (accountId: string) =>
    api<TikTokCreatorInfo>(`${accountPath(accountId)}/tiktok-creator-info`),
};

// ------------------------------------------------------------------ connected posting accounts

export type PostingAccountStatus = "active" | "unbound" | "needs_reconnect" | "disconnected";

/** A social account connected through Growth Factory cloud (clip_factory/posting_accounts.view). */
export interface PostingAccount {
  id: string;
  provider: string;
  platform: string;
  platform_label: string | null;
  zernio_account_id: string;
  profile_id: string | null;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  status: PostingAccountStatus;
  publishing_permitted: boolean | null;
  verified_at: string | null;
  updated_at: string | null;
}

export interface ConnectStart {
  request_id: string;
  platform: string;
  status: "pending";
  /** False when the system browser could not be opened; show auth_url instead. */
  opened: boolean;
  auth_url: string;
}

export interface ConnectProgress {
  request_id: string;
  platform: string;
  /** ambiguous: several new accounts appeared, so the person picks which one is theirs. */
  status: "pending" | "connected" | "ambiguous" | "expired";
  account: PostingAccount | null;
}

export interface TikTokOption { value: string; label: string }
export interface TikTokInteraction { enabled: boolean; required?: boolean; default?: boolean; label?: string }
export interface TikTokCreatorInfo {
  creator?: { nickname?: string; isVerified?: boolean; canPostMore?: boolean };
  privacyLevels?: TikTokOption[];
  postingLimits?: {
    maxVideoDurationSec?: number;
    interactionSettings?: Partial<Record<TikTokToggle, TikTokInteraction | null>>;
  };
}
export const TIKTOK_TOGGLES = ["allow_comment", "allow_duet", "allow_stitch"] as const;
export type TikTokToggle = (typeof TIKTOK_TOGGLES)[number];

const accountPath = (id: string) => `/api/posting/accounts/${encodeURIComponent(id)}`;

export const postingApi = {
  accounts: (refresh = false) =>
    api<PostingAccount[]>(`/api/posting/accounts${refresh ? "?refresh=true" : ""}`),
  connect: (platform: string, profileId: string) =>
    post<ConnectStart>("/api/posting/connect", { platform, profile_id: profileId }),
  progress: (requestId: string) =>
    api<ConnectProgress>(`/api/posting/connect/${encodeURIComponent(requestId)}`),
  bind: (id: string, profileId: string) =>
    put<PostingAccount>(`${accountPath(id)}/binding`, { profile_id: profileId }),
  permit: (id: string, permitted: boolean) =>
    put<PostingAccount>(`${accountPath(id)}/permission`, { publishing_permitted: permitted }),
  disconnect: (id: string) =>
    api<{ id: string; status: "disconnected" }>(accountPath(id), { method: "DELETE" }),
};

/** Platforms Growth Factory cloud can connect, in the order Settings offers them. */
export const PLATFORMS: { id: string; label: string }[] = [
  { id: "instagram", label: "Instagram" },
  { id: "tiktok", label: "TikTok" },
  { id: "youtube", label: "YouTube" },
  { id: "facebook", label: "Facebook" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "twitter", label: "X" },
  { id: "threads", label: "Threads" },
];
export const platformLabel = (platform?: string | null) =>
  PLATFORMS.find((p) => p.id === platform)?.label ?? (platform || "Instagram");

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

/** Caption limits per platform; mirrors clip_factory/publisher.CAPTION_LIMITS. */
export const CAPTION_LIMITS: Record<string, number> = {
  instagram: 2200, tiktok: 2200, youtube: 5000, facebook: 63206, linkedin: 3000, twitter: 280, threads: 500,
};

export interface CaptionLimits {
  caption_chars: number;
  /** Only Instagram limits hashtags and mentions. */
  hashtags: number | null;
  mentions: number | null;
}

export function limitsFor(platform = "instagram"): CaptionLimits {
  const caption_chars = CAPTION_LIMITS[platform] ?? 2200;
  return platform === "instagram"
    ? { caption_chars, hashtags: 30, mentions: 20 }
    : { caption_chars, hashtags: null, mentions: null };
}

export function checkCaption(text: string, platform = "instagram"): CaptionCheck {
  const limits = limitsFor(platform), label = platformLabel(platform);
  const chars = text.length, hashtags = hashtagsOf(text).length, mentions = mentionsOf(text).length;
  const problems: string[] = [];
  if (chars > limits.caption_chars) problems.push(`${label} captions are limited to ${limits.caption_chars.toLocaleString()} characters.`);
  if (limits.hashtags !== null && hashtags > limits.hashtags) problems.push(`${label} allows at most ${limits.hashtags} hashtags.`);
  if (limits.mentions !== null && mentions > limits.mentions) problems.push(`${label} allows at most ${limits.mentions} mentions.`);
  return { chars, hashtags, mentions, problems };
}

export const DEFAULT_LIMITS: PostLimits = {
  caption_chars: 2200, hashtags: 30, mentions: 20, collaborators: 3, collaborators_supported: true,
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
