import { api, endpoint, post, put } from "../api";
import {
  assertProductionScope,
  parseAgentProductionResponse,
  parseExportRecord,
  parseProductionClip,
  parseProductionJob,
  parseProductionVideo,
  ProductionResponseError,
  type AgentProductionRequest,
  type AgentProductionResponse,
  type CampaignRenderRequest,
  type ExportRecord,
  type ProductionClip,
  type ProductionJob,
  type ProductionScope,
  type ProductionVideo,
  type TranscriptImportRequest,
} from "./productionContracts";

function resourceId(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error(
      "Choose a valid saved resource identity before continuing.",
    );
  return value;
}
const encodedId = (value: string) => encodeURIComponent(resourceId(value));
const campaignPath = (id: string, action: "render" | "produce") =>
  `/api/campaigns/${encodedId(id)}/${action}`;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const requireInput = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

function scopeOf(clip: ProductionClip): ProductionScope {
  return {
    video_id: clip.video_id,
    campaign_id: clip.campaign_id,
    profile_id: clip.profile_id,
    strategy_version_id: clip.strategy_version_id,
  };
}
function scopeOfRequest(
  campaignId: string,
  body: AgentProductionRequest | CampaignRenderRequest,
): ProductionScope {
  return {
    campaign_id: campaignId,
    profile_id: body.profile_id,
    video_id: body.video_id,
    ...(body.expected_strategy_version_id != null
      ? { strategy_version_id: body.expected_strategy_version_id }
      : {}),
  };
}
function validateContextRequest(
  campaignId: string,
  body: AgentProductionRequest | CampaignRenderRequest,
) {
  resourceId(campaignId);
  resourceId(body.video_id);
  resourceId(body.profile_id);
  if (body.expected_strategy_version_id != null)
    resourceId(body.expected_strategy_version_id);
}
function validateRenderRequest(
  campaignId: string,
  body: CampaignRenderRequest,
) {
  validateContextRequest(campaignId, body);
  const start = body.start ?? 0;
  requireInput(
    finite(start) && start >= 0,
    "Choose a nonnegative source start time.",
  );
  if (body.end != null)
    requireInput(
      finite(body.end) && body.end > start && body.end - start <= 180,
      "Choose a positive source range of at most 180 seconds.",
    );
  if (body.hook != null)
    requireInput(
      typeof body.hook === "string" && body.hook.length <= 250,
      "Keep the opening text within 250 characters.",
    );
  if (body.caption !== undefined)
    requireInput(
      typeof body.caption === "string" && body.caption.length <= 2200,
      "Keep post copy within 2200 characters.",
    );
  if (body.subtitles !== undefined)
    requireInput(
      typeof body.subtitles === "boolean",
      "Choose whether to render source subtitles.",
    );
  if (body.mode !== undefined)
    requireInput(
      ["direct", "strategy"].includes(body.mode),
      "Choose a supported campaign production mode.",
    );
  if (body.focus_x !== undefined)
    requireInput(
      finite(body.focus_x) && body.focus_x >= 0 && body.focus_x <= 1,
      "Crop focus must be between 0 and 1.",
    );
  if (body.instructions !== undefined)
    requireInput(
      typeof body.instructions === "string" && body.instructions.length <= 4000,
      "Keep creator instructions within 4000 characters.",
    );
  if (body.changed_variable !== undefined)
    requireInput(
      typeof body.changed_variable === "string" &&
        body.changed_variable.length <= 120,
      "Keep the changed-variable label within 120 characters.",
    );
  if (body.change_reason !== undefined)
    requireInput(
      typeof body.change_reason === "string" &&
        body.change_reason.length <= 2000,
      "Keep the revision reason within 2000 characters.",
    );
  if (body.opening_treatment != null)
    requireInput(
      ["text_overlay", "cold_open"].includes(body.opening_treatment),
      "Choose a supported opening treatment.",
    );
  if (body.opening_treatment === "text_overlay" && body.hook != null)
    requireInput(
      !!body.hook.trim(),
      "A text-overlay opening needs text or an approved strategy hook.",
    );
  if (body.opening_treatment === "cold_open") {
    requireInput(
      finite(body.cold_open_start) &&
        finite(body.cold_open_end) &&
        body.cold_open_start >= 0 &&
        body.cold_open_end > body.cold_open_start,
      "A cold open needs a positive source range.",
    );
    const length = body.cold_open_end! - body.cold_open_start!;
    requireInput(
      length >= 0.5 && length <= 10,
      "Keep the cold open between 0.5 and 10 seconds.",
    );
    if (body.end != null)
      requireInput(
        length + body.end - start <= 180,
        "Keep the cold open and main range within 180 seconds together.",
      );
  } else
    requireInput(
      body.cold_open_start == null && body.cold_open_end == null,
      "Cold-open source times require the cold-open treatment.",
    );
  if (body.parent_clip_id != null) {
    resourceId(body.parent_clip_id);
    requireInput(
      typeof body.change_reason === "string" && !!body.change_reason.trim(),
      "Describe the requested change to this exact parent revision.",
    );
  } else
    requireInput(
      !body.change_reason?.trim(),
      "A revision reason needs its parent clip identity.",
    );
  if (body.retry_of_job_id != null) resourceId(body.retry_of_job_id);
  // Source duration, approved strategy, meaningful plan delta, parent scope and
  // retry-chain limits are verified authoritatively by the existing backend.
}
function jobInScope(
  value: unknown,
  scope: ProductionScope,
  kind: string,
): ProductionJob {
  const job = parseProductionJob(value, undefined, kind);
  if (record(job.context)) assertProductionScope(job.context, scope);
  return job;
}
/** Does not turn missing critique/technical data into a pass. */
export function requireHumanReviewEligible(
  clip: ProductionClip,
): ProductionClip {
  const actual = parseProductionClip(clip, resourceId(clip.id));
  if (
    actual.team_run_id &&
    actual.team_review_status !== "not_applicable" &&
    actual.team_review_status !== "pass"
  )
    throw new Error(
      "This team clip needs a passing critique before human approval or export.",
    );
  return actual;
}

/** Existing native-only transport; writes are attempted once and never retried here. */
export const productionApi = {
  async importTranscript(
    videoId: string,
    body: TranscriptImportRequest,
  ): Promise<ProductionVideo> {
    resourceId(videoId);
    requireInput(
      ["srt", "vtt", "json"].includes(body.format) &&
        typeof body.content === "string" &&
        body.content.length > 0 &&
        body.content.length <= 2_000_000,
      "Supply an SRT, VTT or JSON transcript within the source import limit.",
    );
    if (body.language != null)
      requireInput(
        /^[A-Za-z-]{2,12}$/.test(body.language),
        "Use a supported language code.",
      );
    const video = parseProductionVideo(
      await put<unknown>(endpoint("videos", videoId, "transcript"), body),
      videoId,
    );
    if (
      video.transcript_origin !== "imported" ||
      !record(video.transcript) ||
      !Array.isArray(video.transcript.segments) ||
      !video.transcript.segments.length ||
      video.transcript.segments.some(
        (cue) =>
          !record(cue) ||
          !finite(cue.start) ||
          !finite(cue.end) ||
          cue.start < 0 ||
          cue.end <= cue.start ||
          typeof cue.text !== "string",
      )
    )
      throw new ProductionResponseError(
        "The imported transcript could not be verified on this source.",
      );
    return video;
  },
  async transcribe(videoId: string): Promise<ProductionJob> {
    resourceId(videoId);
    return jobInScope(
      await post<unknown>(endpoint("videos", videoId, "transcribe")),
      { video_id: videoId },
      "transcribe",
    );
  },
  async campaignRender(
    campaignId: string,
    body: CampaignRenderRequest,
  ): Promise<ProductionJob> {
    validateRenderRequest(campaignId, body);
    return jobInScope(
      await post<unknown>(campaignPath(campaignId, "render"), body),
      scopeOfRequest(campaignId, body),
      "render",
    );
  },
  async campaignProduce(
    campaignId: string,
    body: AgentProductionRequest,
  ): Promise<AgentProductionResponse> {
    validateContextRequest(campaignId, body);
    resourceId(body.model_id);
    if (body.revision_budget !== undefined)
      requireInput(
        Number.isInteger(body.revision_budget) &&
          body.revision_budget >= 0 &&
          body.revision_budget <= 2,
        "Choose a revision budget between 0 and 2.",
      );
    const result = parseAgentProductionResponse(
      await post<unknown>(campaignPath(campaignId, "produce"), body),
      scopeOfRequest(campaignId, body),
    );
    if (result.run.model_id !== body.model_id)
      throw new ProductionResponseError(
        "The agent run uses a different model than requested.",
      );
    return result;
  },
  async review(
    clip: ProductionClip,
    approved: boolean,
  ): Promise<ProductionClip> {
    requireInput(
      typeof approved === "boolean",
      "Choose an explicit human approval or withdrawal decision.",
    );
    const actual = approved
      ? requireHumanReviewEligible(clip)
      : parseProductionClip(clip, resourceId(clip.id));
    const result = parseProductionClip(
      await put<unknown>(endpoint("clips", actual.id), { approved }),
      actual.id,
      scopeOf(actual),
    );
    if (result.approved !== approved)
      throw new ProductionResponseError(
        "The saved human review does not match the requested decision.",
      );
    return result;
  },
  async recheck(clip: ProductionClip): Promise<ProductionJob> {
    const actual = parseProductionClip(clip, resourceId(clip.id));
    requireInput(
      !!actual.team_run_id && actual.team_review_status !== "not_applicable",
      "A critique recheck needs this clip's retained team run.",
    );
    const job = jobInScope(
      await post<unknown>(endpoint("clips", actual.id, "team-review")),
      { video_id: actual.video_id },
      "team_review",
    );
    if (
      record(job.context) &&
      job.context.clip_id !== undefined &&
      job.context.clip_id !== actual.id
    )
      throw new ProductionResponseError(
        "The critique job belongs to another clip version.",
      );
    return job;
  },
  async listExports(clip?: ProductionClip | string): Promise<ExportRecord[]> {
    const actual =
      typeof clip === "object"
        ? parseProductionClip(clip, resourceId(clip.id))
        : undefined;
    const clipId = typeof clip === "string" ? resourceId(clip) : actual?.id;
    const path = `/api/exports${clipId ? `?clip_id=${encodeURIComponent(clipId)}` : ""}`;
    const value: unknown = await api(path);
    if (!Array.isArray(value))
      throw new ProductionResponseError("Invalid export-history response.");
    return value.map((row) => {
      const item = parseExportRecord(row, actual);
      if (clipId && item.clip_id !== clipId)
        throw new ProductionResponseError(
          "Export history contains another clip version.",
        );
      return item;
    });
  },
  async createVerifiedExport(clip: ProductionClip): Promise<ExportRecord> {
    const actual = requireHumanReviewEligible(clip);
    requireInput(
      actual.approved === true,
      "Approve this exact clip version before exporting it.",
    );
    const item = parseExportRecord(
      await post<unknown>(endpoint("clips", actual.id, "export")),
      actual,
    );
    if (!item.manifest)
      throw new ProductionResponseError(
        "The export response has no verifiable manifest.",
      );
    return item;
  },
  async cancelJob(jobId: string): Promise<ProductionJob> {
    resourceId(jobId);
    // A running cancellation response may remain running while the worker stops.
    return parseProductionJob(
      await post<unknown>(endpoint("jobs", jobId, "cancel")),
      jobId,
    );
  },
};

export const clipMediaUrl = (clipId: string) =>
  endpoint("clips", resourceId(clipId), "media");
export const exportMediaUrl = (exportId: string) =>
  `/api/exports/${encodedId(exportId)}/download`;
export const exportManifestUrl = (exportId: string) =>
  `/api/exports/${encodedId(exportId)}/manifest`;
