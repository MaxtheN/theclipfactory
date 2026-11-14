import type { Job } from "./types";
export function activeJob(job: Job) {
  return ["queued", "running"].includes(job.status);
}
export function jobContextId(job: Job, field: "video_id" | "clip_id") {
  const context = job.context;
  if (!context || typeof context !== "object" || Array.isArray(context))
    return undefined;
  const value = (context as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}
export function sourceHasActiveJob(jobs: Job[], videoId: string) {
  // A source-bound job of any kind holds the backend's video lock. Model-only
  // downloads and unrelated jobs do not block this source.
  return jobs.some(
    (job) => activeJob(job) && jobContextId(job, "video_id") === videoId,
  );
}

export function hasTranscript(value: unknown) {
  if (typeof value === "string" || Array.isArray(value))
    return value.length > 0;
  return !!value && typeof value === "object" && Object.keys(value).length > 0;
}
