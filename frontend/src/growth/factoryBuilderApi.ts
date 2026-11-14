import { api, post } from "../api";

/** Backend: clip_factory/capabilities.py + factory_builder.py (the factory that improves itself). */
export type RequestStatus =
  | "detected"
  | "work_order"
  | "building"
  | "ready_for_review"
  | "merged"
  | "rejected";

export interface Evidence {
  source: string;
  id: string;
  quote: string;
  at?: string;
  by?: string;
}

export interface WorkOrder {
  title: string;
  user_story: string;
  demand_count: number;
  demo: boolean;
  buildable: boolean;
  not_buildable_reason?: string | null;
  interface: string;
  acceptance_tests: string[];
  constraints: string[];
  files: string[];
  markdown: string;
}

export interface CapabilityRequest {
  id: string;
  capability: string;
  label: string;
  evidence: Evidence[];
  demand_count: number;
  status: RequestStatus;
  demo: boolean;
  buildable: boolean;
  work_order: WorkOrder | null;
  build_id: string | null;
  issue_url?: string | null;
  created_at: string;
  updated_at: string;
}

export interface BuildStep {
  name: string;
  ok: boolean;
  output?: string;
  sandbox?: string;
  seconds?: number;
}

export interface FactoryBuild {
  id: string;
  request_id: string;
  capability: string;
  status: "building" | "ready_for_review" | "failed" | "discarded";
  branch: string;
  base_branch: string;
  base_commit: string;
  commit: string | null;
  diff?: string | null;
  test_log: string | null;
  sample_path: string | null;
  render_check?: { ok: boolean; mean_abs_diff?: number; changed_pixels?: number } | null;
  attempts: { n: number; ok: boolean; summary?: string | null; steps: BuildStep[] }[];
  model: { provider: string; model: string } | null;
  usage: { calls: number; cost_usd: number; prompt_tokens: number; completion_tokens: number } | null;
  error: string | null;
  demo: boolean;
  pushed?: boolean;
  pr_url?: string | null;
  created_at: string;
  updated_at: string;
}

export interface BuilderSummary {
  total: number;
  ideas: number;
  building: number;
  ready_for_review: number;
  merged: number;
  by_status: Record<RequestStatus, number>;
}

export interface FactoryBuilderView {
  requests: CapabilityRequest[];
  builds: FactoryBuild[];
  summary: BuilderSummary;
  can_build: boolean;
  repo: { branch: string; push_remote: string; push_repo: string | null; origin_repo: string | null } | null;
  gh: { available: boolean; authenticated: boolean; reason: string | null };
}

export interface PrPlan {
  remote: string;
  repo: string | null;
  base: string;
  head: string;
  commands: string[];
  blocked: string | null;
  gh: { authenticated: boolean; reason: string | null };
}

const base = "/api/factory-builder";
const req = (id: string) => `${base}/requests/${encodeURIComponent(id)}`;
const bld = (id: string) => `${base}/builds/${encodeURIComponent(id)}`;

export const factoryBuilderApi = {
  view: () => api<FactoryBuilderView>(base),
  scan: () => post<FactoryBuilderView>(`${base}/scan`, {}),
  demo: () => post<FactoryBuilderView>(`${base}/demo`, {}),
  workOrder: (id: string) => post<CapabilityRequest>(`${req(id)}/work-order`, {}),
  /** Explicit "File as GitHub issue" click only. */
  fileIssue: (id: string) =>
    post<{ filed: boolean; url?: string | null; reason?: string; markdown?: string }>(`${req(id)}/issue`, {
      confirm: true,
    }),
  /** Explicit "Build it" click only. */
  build: (id: string) => post<FactoryBuild>(`${req(id)}/build`, { confirm: true }),
  reject: (id: string) => post<CapabilityRequest>(`${req(id)}/reject`, {}),
  detail: (id: string) => api<FactoryBuild>(bld(id)),
  prPlan: (id: string) => api<PrPlan>(`${bld(id)}/pr-plan`),
  /** Explicit "Push & open draft PR" click only. */
  push: (id: string) => post<FactoryBuild>(`${bld(id)}/push`, { confirm: true }),
  discard: (id: string) => post<FactoryBuild>(`${bld(id)}/discard`, {}),
  sampleUrl: (id: string) => `${bld(id)}/sample`,
  extensions: () =>
    api<{ extensions: { capability: string; label: string; description: string; provenance: string }[] }>(
      "/api/extensions",
    ),
};

export const SOURCE_LABEL: Record<string, string> = {
  reference_observation: "Reference",
  reference_pattern: "Reference pattern",
  critic_finding: "Critic",
  change_request: "Change request",
  feedback: "Feedback",
  strategist_belief: "Strategist",
  demo: "Demo",
};

export const STATUS_LABEL: Record<RequestStatus, string> = {
  detected: "Idea",
  work_order: "Work order",
  building: "Building",
  ready_for_review: "Ready for review",
  merged: "Merged",
  rejected: "Rejected",
};

/** One line for the Factory map's "Factory builder" station. */
export function builderStatus(view: FactoryBuilderView | null): {
  state: "idle" | "active" | "waiting" | "empty" | "done";
  status: string;
  counts: { label: string; value: string }[];
} {
  if (!view) return { state: "idle", status: "Unavailable right now", counts: [] };
  const s = view.summary;
  if (!s.total) return { state: "empty", status: "No upgrade ideas yet", counts: [] };
  const parts = [
    s.ideas ? `${s.ideas} upgrade idea${s.ideas === 1 ? "" : "s"}` : "",
    s.building ? `${s.building} building` : "",
    s.ready_for_review ? `${s.ready_for_review} ready for review` : "",
    s.merged ? `${s.merged} merged` : "",
  ].filter(Boolean);
  return {
    state: s.building ? "active" : s.ready_for_review ? "waiting" : s.ideas ? "idle" : "done",
    status: parts.join(" · ") || "Nothing open",
    counts: [
      { label: "ideas", value: String(s.ideas) },
      ...(s.building ? [{ label: "building", value: String(s.building) }] : []),
      ...(s.ready_for_review ? [{ label: "review", value: String(s.ready_for_review) }] : []),
    ],
  };
}
