import type { Clip, Job, Model, SystemInfo, TeamRun, Video } from "../types";
import { activeJob, installedLlms, sourceHasActiveJob } from "../productionPreflight";

export interface ProductionScope { campaignId: string; profileId: string; sourceIds: string[] }
export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function clipInScope(clip: Clip, scope: ProductionScope) {
  return clip.campaign_id === scope.campaignId && clip.profile_id === scope.profileId && scope.sourceIds.includes(clip.video_id);
}
/**
 * A clip the engine made from this workspace's footage outside any workspace run: it has no
 * direction or profile, so it is shown with the footage and reviewed on the wall, not in the Studio.
 */
export function undirected(clip: Clip, sourceIds: readonly string[]) {
  return !clip.campaign_id && sourceIds.includes(clip.video_id);
}
export function jobInScope(job: Job, scope: ProductionScope, runs: TeamRun[] = []) {
  const context = object(job.context);
  if (!context || typeof context.video_id !== "string" || !scope.sourceIds.includes(context.video_id)) return false;
  if (context.campaign_id !== undefined || context.profile_id !== undefined)
    return context.campaign_id === scope.campaignId && context.profile_id === scope.profileId;
  const run = runs.find(r => r.id === context.team_run_id);
  const snapshot = object(object(run?.context)?.campaign_snapshot);
  return snapshot?.campaign_id === scope.campaignId && snapshot.profile_id === scope.profileId;
}

export function readiness(input: {
  source?: Video; system: SystemInfo | null; models: Model[]; jobs: Job[];
  modelId: string; approved: boolean; sourceAttached: boolean; subtitles: boolean;
  stale: boolean;
}) {
  const { source, system, models, jobs, modelId } = input;
  const shared: string[] = [];
  if (input.stale) shared.push("Refresh unavailable or stale workspace data first.");
  if (!input.approved) shared.push("Approve direction for this account profile first.");
  if (!source || !input.sourceAttached) shared.push("Attach and select footage from this campaign.");
  else if (source.duration == null || !Number.isFinite(source.duration) || source.duration <= 0) shared.push("This source has no usable duration. Check the imported file.");
  if (source && sourceHasActiveJob(jobs, source.id)) shared.push("This source already has queued or running work.");
  if (system?.ffmpeg !== true || system.ffprobe !== true) shared.push("Local FFmpeg and ffprobe are required for production.");
  const manual = [...shared], agent = [...shared];
  // Deterministic caption gate mirrors the server's presence check. Coverage and
  // timing are verified by actual caption checks after rendering, not assumed.
  const missingTranscript = !!source?.has_audio && source.transcript == null;
  if (input.subtitles && missingTranscript) manual.push("Captions need a source transcript. Import one, transcribe locally, or turn captions off.");
  const selected = installedLlms(models, { needsVision: true }).find(m => m.id === modelId);
  if (!selected) agent.push("Choose an installed model that can inspect video frames.");
  if (selected && selected.source !== "ollama" && !selected.id.startsWith("ollama:") && system?.model_runtime !== true) agent.push("Set up the local model runtime before using this model.");
  // Agent entry uses Python truthiness: empty legacy containers/strings count
  // as absent, while deterministic render only checks for null/missing.
  const transcript = source?.transcript;
  const hasAgentTranscript = Array.isArray(transcript) ? transcript.length > 0
    : transcript !== null && typeof transcript === "object" ? Object.keys(transcript).length > 0
    : !!transcript;
  const missingAgentTranscript = !!source?.has_audio && !hasAgentTranscript;
  if (missingAgentTranscript && (system?.model_runtime !== true || !models.some(m => m.id === "whisper-turbo" && m.installed === true))) agent.push("Agent production needs Whisper for this audio source, or an imported transcript.");
  return { manual, agent, canRender: manual.length === 0, canProduce: agent.length === 0, needsTranscript: missingTranscript };
}

export interface EditDraft {
  start: string; end: string; opening: "text_overlay" | "cold_open";
  coldStart: string; coldEnd: string; hook: string; focusX: number;
}
export function editErrors(draft: EditDraft, duration: number | null | undefined): string[] {
  const errors: string[] = [];
  const number = (s: string) => s.trim() !== "" && Number.isFinite(Number(s));
  const start = Number(draft.start), end = Number(draft.end);
  if (!number(draft.start) || !number(draft.end) || start < 0 || end <= start || end - start > 180 || (duration != null && end > duration)) errors.push("Choose a positive main range within the source, at most 180 seconds.");
  if (draft.opening === "text_overlay" && !draft.hook.trim()) errors.push("Add opening text for the overlay treatment.");
  if (draft.opening === "cold_open") {
    const a = Number(draft.coldStart), b = Number(draft.coldEnd);
    if (!number(draft.coldStart) || !number(draft.coldEnd) || a < 0 || b <= a || b-a < .5 || b-a > 10 || (duration != null && b > duration)) errors.push("Choose a cold open between 0.5 and 10 seconds inside the source.");
    else if (number(draft.start) && number(draft.end) && end-start+b-a > 180) errors.push("Cold open and main range together must be at most 180 seconds.");
  }
  if (!Number.isFinite(draft.focusX) || draft.focusX < 0 || draft.focusX > 1) errors.push("Crop focus must be between 0 and 1.");
  return errors;
}

export function retryBlocker(job: Job, jobs: Job[], scope: ProductionScope, direction?: { framing: string; caption_style: string }): string | null {
  const context = object(job.context), plan = object(context?.plan);
  if (!jobInScope(job, scope) || job.kind !== "render") return "This render belongs to another source, campaign or profile.";
  if (!["failed", "cancelled"].includes(job.status)) return "Only a failed or cancelled render can be retried.";
  if (!plan || typeof plan.start !== "number" || typeof plan.end !== "number") return "The saved render plan is unavailable. Choose a new edit.";
  const attempt = context?.attempt ?? 1;
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt >= 3) return "Three attempts is the limit. Change the plan or check the source.";
  if (jobs.some(j => object(j.context)?.retry_of_job_id === job.id)) return "This attempt already has a retry. Inspect its latest attempt.";
  if (!direction) return "Approve direction before retrying production.";
  if (plan.framing !== direction.framing || plan.caption_style !== direction.caption_style) return "The approved production settings changed. Start a new render instead.";
  return null;
}

const EDIT_FIELDS = ["start", "end", "hook", "subtitles", "framing", "caption_style", "hook_overlay", "opening_treatment", "cold_open_start", "cold_open_end", "focus_x"];
export function changedEditFields(before: unknown, after: unknown) {
  const a = object(before), b = object(after);
  if (!a || !b) return [];
  return EDIT_FIELDS.filter(key => key in b && a[key] !== b[key]);
}
export function reviewBlocker(clip: Clip, jobs: Job[], stale: boolean) {
  if (stale) return "Refresh clip and queue data before review.";
  if (sourceHasActiveJob(jobs, clip.video_id) || jobs.some(j => activeJob(j) && object(j.context)?.clip_id === clip.id)) return "Wait for this source or clip task to finish.";
  if (clip.team_run_id && clip.team_review_status !== "pass" && clip.team_review_status !== "not_applicable") return "Resolve the team critique before human approval.";
  return null;
}
