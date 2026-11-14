import { api, post } from "../api";

export type StrategistLayer = "craft" | "selection" | "campaign";
export type BeliefStatus =
  | "proposed"
  | "testing"
  | "supported"
  | "weakened"
  | "retired";

export interface BeliefEvidence {
  publication_id: string;
  snapshot_id: string;
  clip_id: string;
  metric: string;
  value: number;
  baseline: number;
  ratio: number | null;
  outcome: "supports" | "contradicts" | "tie";
  trigger?: string;
}

export interface Belief {
  id: string;
  profile_id: string;
  layer: StrategistLayer;
  statement: string;
  variable: string;
  value: string;
  direction: "increase" | "decrease";
  metric: string;
  confidence: number;
  uncertainty: number;
  status: BeliefStatus;
  evidence: BeliefEvidence[];
  counts: {
    matching: number;
    beats: number;
    misses: number;
    ties: number;
    prospective: number;
  };
  effect: { shrunken_log_ratio: number; typical_ratio: number };
  origin: "model" | "pattern_scan";
  rationale: string;
  created_at: string;
  updated_at: string;
}

export interface PortfolioSlot {
  slot: number;
  mode: "exploit" | "explore";
  belief_id: string;
  layer: StrategistLayer;
  variable: string;
  value: string;
  direction: "increase" | "decrease";
  rationale: string;
  score: number;
}

export interface Portfolio {
  slots: PortfolioSlot[];
  exploit: number;
  explore: number;
  seed: string;
}

export interface ModelReceipt {
  status:
    | "pending"
    | "held"
    | "abstained"
    | "proposed"
    | "skipped"
    | "failed"
    | "insufficient_evidence"
    | "not_used";
  reasons?: string[];
  label?: string;
  count?: number;
  attempts?: number;
}

export interface StrategistRun {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  trigger: string;
  layers: StrategistLayer[];
  progress: number;
  message: string;
  model: ModelReceipt;
  proposals: {
    status: string;
    id?: string;
    layer: StrategistLayer;
    detail?: string;
  }[];
  created_at: string;
  finished_at: string | null;
}

export interface CampaignProposal {
  id: string;
  campaign_id: string;
  status: "proposed" | "approved" | "rejected";
  summary: string;
  caveat: string;
  changes: {
    belief_id: string;
    variable: string;
    value: string;
    direction: string;
  }[];
}

export interface StrategistView {
  profile_id: string;
  target_metric: string | null;
  baseline: {
    statistic: string | null;
    posts: number;
    metrics: Record<string, number | null>;
  };
  beliefs: Belief[];
  portfolio: Portfolio | null;
  pending_proposals: {
    style_rules: {
      id: string;
      campaign_id: string;
      version: number;
      layer: StrategistLayer;
    }[];
    campaign: CampaignProposal[];
  };
  runs: StrategistRun[];
  measured_posts: number;
  due_layers: StrategistLayer[];
  caveat: string;
  simulated: false;
}

export interface SimulationStep {
  step: number;
  simulated: true;
  post: { id: string; tags: Record<string, string>; views: number };
  baseline_views: number | null;
  layers_run: StrategistLayer[];
  beliefs: (Pick<
    Belief,
    | "id"
    | "layer"
    | "statement"
    | "variable"
    | "value"
    | "direction"
    | "confidence"
    | "status"
  > & { matching: number })[];
  portfolio: Portfolio | null;
  new_proposals: { status: string; layer: StrategistLayer }[];
}

export interface Simulation {
  simulated: true;
  banner: string;
  seed: number;
  steps: SimulationStep[];
  caveat: string;
}

const base = (profileId: string) =>
  `/api/strategist/${encodeURIComponent(profileId)}`;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validView(value: unknown): value is StrategistView {
  return (
    isObject(value) &&
    value.simulated === false &&
    Array.isArray(value.beliefs) &&
    Array.isArray(value.runs) &&
    isObject(value.baseline) &&
    value.beliefs.every(
      (b) =>
        isObject(b) &&
        typeof b.id === "string" &&
        typeof b.confidence === "number" &&
        b.confidence >= 0 &&
        b.confidence <= 1,
    )
  );
}

export function validSimulation(value: unknown): value is Simulation {
  return (
    isObject(value) &&
    value.simulated === true &&
    Array.isArray(value.steps) &&
    value.steps.every((s) => isObject(s) && s.simulated === true)
  );
}

export const strategistApi = {
  view: async (profileId: string): Promise<StrategistView> => {
    const result = await api<unknown>(base(profileId));
    if (!validView(result))
      throw new Error(
        "The strategist returned an unexpected answer. Refresh before relying on it.",
      );
    return result;
  },
  run: (profileId: string, layer?: StrategistLayer) =>
    post<StrategistRun>(`${base(profileId)}/run`, layer ? { layer } : {}),
  retire: (beliefId: string, reason = "") =>
    post<Belief>(
      `/api/strategist/beliefs/${encodeURIComponent(beliefId)}/retire`,
      { reason },
    ),
  decide: (proposalId: string, approve: boolean, reason = "") =>
    post<CampaignProposal>(
      `/api/strategist/campaign-proposals/${encodeURIComponent(proposalId)}/decision`,
      { approve, reason },
    ),
  simulate: async (profileId: string, seed = 7, steps = 16) => {
    const result = await api<unknown>(`${base(profileId)}/simulate`, {
      method: "POST",
      body: JSON.stringify({ seed, steps }),
    });
    if (!validSimulation(result))
      throw new Error("The simulation answer was not labelled as synthetic.");
    return result;
  },
};
