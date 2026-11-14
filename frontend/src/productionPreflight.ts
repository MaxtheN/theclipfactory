import type { Job, Model } from "./types";
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

export function installedLlms(models: Model[], { needsVision = false } = {}) {
  return models.filter(
    (m) =>
      m.installed === true &&
      (m.id.startsWith("qwen") || m.kind === "llm") &&
      // Clip analysis sends video frames; text-only Ollama models would fail.
      !(needsVision && m.vision === false),
  );
}

export function isOllamaModel(id: string) {
  return id.startsWith("ollama:");
}

/** Keep the user's pick while it is installed; otherwise fall back to the first ready LLM. */
export function usableModel(current: string, installed: Model[]) {
  if (installed.some((m) => m.id === current) || !installed.length)
    return current;
  return installed[0].id;
}

/**
 * The MLX runtime is needed for MLX LLMs and for Whisper transcription.
 * An Ollama LLM on a source that needs no transcription runs without it.
 */
export function runtimeSatisfied(
  modelRuntime: unknown,
  modelId: string,
  needsWhisper: boolean,
) {
  return modelRuntime === true || (isOllamaModel(modelId) && !needsWhisper);
}
