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
  | "created"
  | "uploading"
  | "uploaded"
  | "container_created"
  | "container_ready"
  | "published"
  | "mapped"
  | "failed"
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
}

export interface PostTargets {
  accounts: { id: string; display_name: string | null }[];
  cloud_configured: boolean;
  signed_in: boolean;
  attempts: PublishAttempt[];
  default_caption: string;
}

const clipPath = (id: string, action: string) =>
  `/api/clips/${encodeURIComponent(id)}/${action}`;
const attemptPath = (id: string, action?: string) =>
  `/api/publish-attempts/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

/** States where the publish lane is (or may be) still doing something. */
export const inFlight = (a: PublishAttempt) =>
  a.active && !["mapped", "failed", "unknown"].includes(a.state);

/** States a human may continue from without risking a duplicate post. */
export const canResume = (a: PublishAttempt) =>
  !a.active &&
  (["created", "uploaded", "container_created", "container_ready"].includes(a.state) ||
    (a.state === "published" && a.mapping.status !== "mapped"));

export const stateLabel: Record<AttemptState, string> = {
  created: "Queued",
  uploading: "Uploading video",
  uploaded: "Hosted; creating Reel",
  container_created: "Instagram is processing",
  container_ready: "Ready to publish",
  published: "Posted",
  mapped: "Posted · learning tracks it",
  failed: "Not posted",
  unknown: "Outcome unknown · check status",
};

export const publishApi = {
  quality: (clipId: string, refresh = false) =>
    api<QualityReport>(`${clipPath(clipId, "quality")}${refresh ? "?refresh=true" : ""}`),
  targets: (clipId: string) => api<PostTargets>(clipPath(clipId, "post-targets")),
  post: (
    clipId: string,
    body: { account_id: string; caption: string; sha256: string; override_reason?: string },
  ) => post<PublishAttempt>(clipPath(clipId, "post"), body),
  attempt: (id: string) => api<PublishAttempt>(attemptPath(id)),
  reconcile: (id: string) => post<PublishAttempt>(attemptPath(id, "reconcile")),
  resume: (id: string) => post<PublishAttempt>(attemptPath(id, "resume")),
};
