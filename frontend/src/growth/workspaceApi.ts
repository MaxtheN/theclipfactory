import { api, post, put } from "../api";
import type {
  Campaign,
  Direction,
  Job,
  Observation,
  Profile,
  StrategyVersion,
  Video,
} from "../types";

export const reviewPreview = import.meta.env.VITE_REVIEW_PREVIEW === "true";
export const campaignUrl = (id: string, action = "") =>
  `/api/campaigns/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
export type CampaignInput = Pick<
  Campaign,
  "name" | "brief" | "profile_ids" | "video_ids"
>;
export type ProfileInput = Omit<Profile, "id">;
export type ObservationInput = Omit<Observation, "id" | "profile_id">;
export interface RenderInput {
  expected_strategy_version_id: string;
  video_id: string;
  profile_id: string;
  start: number;
  end: number;
  hook: string;
  caption: string;
  subtitles: boolean;
  mode: "direct" | "strategy";
  instructions: string;
}
export async function checkedList<T extends { id: string }>(
  path: string,
): Promise<T[]> {
  const result: unknown = await api(path);
  if (
    !Array.isArray(result) ||
    result.some((r) => !r || typeof r !== "object" || typeof r.id !== "string")
  )
    throw new Error(
      "The service returned an invalid list. Refresh before continuing.",
    );
  return result as T[];
}
// One integration seam. These are the existing native API contracts; no remote
// origin, desktop token, model call or automatic fallback is introduced here.
export const workspaceApi = {
  profiles: () => checkedList<Profile>("/api/profiles"),
  campaigns: () => checkedList<Campaign>("/api/campaigns"),
  strategies: (id: string) =>
    checkedList<StrategyVersion>(campaignUrl(id, "strategies")),
  observations: (id: string) =>
    checkedList<Observation>(campaignUrl(id, "observations")),
  profile: (body: ProfileInput) => post<Profile>("/api/profiles", body),
  save: (body: CampaignInput, id?: string) =>
    id
      ? put<Campaign>(campaignUrl(id), body)
      : post<Campaign>("/api/campaigns", body),
  upload: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return api<Video>("/api/videos", { method: "POST", body });
  },
  propose: (
    id: string,
    base: string | null,
    directions: Record<string, Direction>,
    reason: string,
  ) =>
    post<StrategyVersion>(campaignUrl(id, "strategies"), {
      base_version_id: base,
      directions,
      reason,
    }),
  approve: (id: string, version: string) =>
    post<StrategyVersion>(
      campaignUrl(id, `strategies/${encodeURIComponent(version)}/approve`),
    ),
  reject: (id: string, version: string) =>
    post<StrategyVersion>(
      campaignUrl(id, `strategies/${encodeURIComponent(version)}/reject`),
      { reason: "Creator requested a different direction." },
    ),
  render: (id: string, body: RenderInput) =>
    post<Job>(campaignUrl(id, "render"), body),
  observe: (id: string, body: ObservationInput) =>
    post<Observation>(campaignUrl(id, "observations"), body),
  learn: (
    id: string,
    body: {
      profile_id: string;
      observation_ids: string[];
      hypothesis: string;
      reason: string;
      base_version_id: string;
      proposed_direction: Direction;
    },
  ) => post<StrategyVersion>(campaignUrl(id, "learning"), body),
};

export const initialDirection = (): Direction => ({
  angles: ["A useful idea for builders"],
  moment_selection:
    "A self-contained source moment with a clear point and payoff.",
  hooks: ["Claim first", "Question first"],
  pacing: "Put the point before the setup; preserve the speaker's meaning.",
  duration_seconds: 30,
  framing: "fit",
  caption_style: "standard",
  editing_preferences: "Readable captions. Original audio. No invented speech.",
  measurement_questions: [],
  next_experiments: [],
  evidence_refs: [],
  confidence: "low",
  limitations:
    "Creator-provided creative hypothesis. No reference inspection or audience improvement established.",
});
