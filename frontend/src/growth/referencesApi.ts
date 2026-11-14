import { api, post } from "../api";

/** Reference research ("Research what works") and per-clip post copy. */

export type ReferenceStatus =
  | "stored"
  | "linked"
  | "not_inspected"
  | "missing"
  | "failed"
  | "analyzed";

export interface ReferenceFrame {
  time: number;
  file: string;
  described: boolean;
  visual: string | null;
  on_screen_text: string[];
}

export interface ReferenceItem {
  id: string;
  kind: "upload" | "url";
  media_kind: "reference";
  name: string;
  note: string;
  url: string | null;
  file: string | null;
  duration?: number;
  status: ReferenceStatus;
  status_reason: string;
  measurements?: {
    duration: number;
    time_to_first_word: number | null;
    words_per_second: number | null;
    cuts: number[] | null;
    cuts_per_minute: number | null;
    integrated_lufs: number | null;
    structure: { guess: string };
  };
  frames?: ReferenceFrame[];
  vision_note?: string;
  transcript_note?: string;
}

export interface Evidence {
  kind: "quote" | "frame" | "measurement";
  start: number;
  end: number;
  quote?: string;
  frame_time?: number;
  value?: number;
}

export interface ReferenceObservation {
  id: string;
  reference_id: string;
  statement: string;
  basis: string;
  evidence: Evidence;
}

export type Variable = "hook" | "opening_treatment" | "caption_style" | "hook_format" | "structure";

export interface ReferencePattern {
  pattern: string;
  supported_by: string[];
  reference_ids: string[];
  hypothesis: string;
  variable: Variable;
  value_a: string;
  value_b: string;
}

export interface Plan {
  label: "A" | "B";
  role: "control" | "pattern";
  variable: Variable;
  variable_label: string;
  value: string;
  summary: string;
  hook: string;
  source: { clip_id: string; start: number; end: number; opening: string } | null;
}

export interface CandidateClip {
  id: string;
  hook: string;
  start: number;
  end: number;
  name: string;
  reference_research_id?: string | null;
}

export interface Research {
  id: string;
  campaign_id: string;
  profile_id: string;
  status: "draft" | "queued" | "analyzing" | "ready" | "abstained" | "failed";
  references: ReferenceItem[];
  target_clip_id: string | null;
  observations: ReferenceObservation[];
  pattern: ReferencePattern | null;
  plans: Plan[];
  limits: string[];
  abstained: { status: string; reason: string } | null;
  holds: string[];
  error?: string | null;
  job: { id: string; status: string; progress: number; message: string; error: string | null } | null;
  candidate_clips: CandidateClip[];
  direction: {
    clip_id: string;
    job_id: string;
    proposal_id: string | null;
    proposal_error: string | null;
  } | null;
  timings?: Record<string, number>;
}

const base = (id: string) => `/api/reference-research/${encodeURIComponent(id)}`;

export const referencesApi = {
  list: (campaignId: string) =>
    api<Research[]>(`/api/campaigns/${encodeURIComponent(campaignId)}/reference-research`),
  start: (campaignId: string, profileId: string) =>
    post<Research>(`/api/campaigns/${encodeURIComponent(campaignId)}/reference-research`, {
      profile_id: profileId,
    }),
  get: (id: string) => api<Research>(base(id)),
  upload: (id: string, file: File, note = "") => {
    const form = new FormData();
    form.append("file", file);
    form.append("note", note);
    return api<Research>(`${base(id)}/references`, { method: "POST", body: form });
  },
  link: (id: string, url: string, note = "") => post<Research>(`${base(id)}/links`, { url, note }),
  note: (id: string, refId: string, note: string) =>
    api<Research>(`${base(id)}/references/${encodeURIComponent(refId)}`, {
      method: "PATCH",
      body: JSON.stringify({ note }),
    }),
  remove: (id: string, refId: string) =>
    api<Research>(`${base(id)}/references/${encodeURIComponent(refId)}`, { method: "DELETE" }),
  analyze: (id: string, targetClipId: string | null) =>
    post<Research>(`${base(id)}/analyze`, targetClipId ? { target_clip_id: targetClipId } : {}),
  use: (id: string, clipId: string | null) =>
    post<Research>(`${base(id)}/use`, clipId ? { clip_id: clipId } : {}),
  mediaUrl: (id: string, refId: string) => `${base(id)}/references/${encodeURIComponent(refId)}/media`,
  frameUrl: (id: string, file: string) => `${base(id)}/frames/${encodeURIComponent(file)}`,
};

export const busy = (r: Research | undefined) => !!r && (r.status === "queued" || r.status === "analyzing");

export interface PostCopy {
  caption: string;
  hashtags: string[];
  source: "model" | "template";
  label: string;
  model_id: string | null;
  fallback_reason: string | null;
  checks: string[];
  generated_at: string;
}

export interface PostCopyView {
  clip_id: string;
  post_copy: PostCopy | null;
  job: { id: string; status: string; message: string; error: string | null } | null;
}

export const postCopyApi = {
  get: (clipId: string) => api<PostCopyView>(`/api/clips/${encodeURIComponent(clipId)}/post-copy`),
  regenerate: (clipId: string, mode: "model" | "template" = "model") =>
    post<PostCopyView>(`/api/clips/${encodeURIComponent(clipId)}/post-copy`, { mode }),
};

export const seconds = (n: number) => `${n.toFixed(1)}s`;
