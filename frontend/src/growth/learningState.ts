import { objectives, type Direction, type Profile, type Observation, type TeamTask } from "../types";
import { object } from "./productionState";

export type LearningEdit =
  | { kind: "opening"; value: string }
  | { kind: "duration"; value: number }
  | { kind: "framing"; value: "fit" | "fill" }
  | { kind: "captions"; value: "standard" | "high_contrast" }
  | { kind: "selection"; value: string };

export function applyLearningEdit(current: Direction, edit: LearningEdit): Direction {
  const result: Direction = { ...current, angles:[...current.angles], hooks:[...current.hooks], measurement_questions:[...current.measurement_questions],next_experiments:[...current.next_experiments],evidence_refs:[...current.evidence_refs],confidence:"low",limitations:"Observations motivate this next test; no causal audience improvement has been established." };
  if (edit.kind === "opening") {
    if (!edit.value.trim() || edit.value.trim().length > 250) throw new Error("Use opening text between 1 and 250 characters.");
    result.hooks = [edit.value.trim(), ...current.hooks.slice(1)];
  } else if (edit.kind === "duration") {
    if (!Number.isFinite(edit.value) || edit.value < 1 || edit.value > 180) throw new Error("Target duration must be between 1 and 180 seconds.");
    result.duration_seconds = edit.value;
  } else if (edit.kind === "framing") result.framing = edit.value;
  else if (edit.kind === "captions") result.caption_style = edit.value;
  else {
    if (!edit.value.trim() || edit.value.length > 4000) throw new Error("Describe a source-selection rule of at most 4000 characters.");
    result.moment_selection = edit.value.trim();
  }
  return result;
}

/** A manual render cannot interpret descriptive planning rules. */
export function nextProductionMode(before: Direction, after: Direction): "manual" | "agent" {
  return ["moment_selection", "pacing", "angles", "editing_preferences"].some(key => JSON.stringify(before[key as keyof Direction]) !== JSON.stringify(after[key as keyof Direction])) ? "agent" : "manual";
}

export function profileGoalBody(profile: Profile, objective: string, primaryMetric: string) {
  if (!(objectives as readonly string[]).includes(objective)) throw new Error("Choose a supported production objective.");
  if (objective !== "discovery" && !primaryMetric.trim()) throw new Error("This objective needs a primary metric.");
  if (primaryMetric.trim().length > 200) throw new Error("Keep the metric name within 200 characters.");
  // GET profiles contain production_history. Strict PUT bodies must never spread
  // those read-only fields, and changing this profile must not update another.
  return { name:profile.name,audience:profile.audience,brand_context:profile.brand_context,creative_preferences:profile.creative_preferences,objective,primary_metric:objective === "discovery" ? null : primaryMetric.trim() };
}

export interface EvidenceRecommendation { recommendation:string; limitation:string; observationIds:string[]; otherEvidenceRefs:string[] }
export function performanceRecommendations(task: TeamTask, observations: Observation[]): EvidenceRecommendation[] {
  if (task.role !== "performance_analyst" || task.status !== "completed") return [];
  const rows = object(task.output)?.recommendations;
  if (!Array.isArray(rows)) return [];
  const known = new Set(observations.filter(o=>typeof o.value === "number" && Number.isFinite(o.value)).map(o=>o.id));
  return rows.slice(0,4).flatMap(row=>{
    const value = object(row);
    if (!value || typeof value.recommendation !== "string" || !value.recommendation.trim() || typeof value.limitation !== "string" || !Array.isArray(value.evidence_refs) || !value.evidence_refs.every(ref=>typeof ref === "string")) return [];
    const refs = value.evidence_refs as string[];
    const observationIds = [...new Set(refs.flatMap(ref=>ref.startsWith("event:") && known.has(ref.slice(6)) ? [ref.slice(6)] : []))];
    return [{ recommendation:value.recommendation,limitation:value.limitation,observationIds,otherEvidenceRefs:refs.filter(ref=>!ref.startsWith("event:") || !known.has(ref.slice(6))) }];
  });
}
