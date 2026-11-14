import type { Clip, Job, JsonObject, TeamRun, Video } from "../types";

export type OpeningTreatment = "text_overlay" | "cold_open";
/** Editing-craft options (clip_factory/craft.py CraftOptions); omitted ones use server defaults. */
export interface CraftRequest {
  loudness?: "off" | "normalize";
  jump_cuts?: "off" | "silences" | "silences_and_fillers";
  hook_format?: "overlay" | "title_card";
  caption_emphasis?: "off" | "keywords";
  emphasis_words?: string[];
  punch_in?: "off" | "emphasis";
  cover?: "first_frame" | "best_frame";
  crop_focus?: "fixed" | "auto_face";
  end_card?: "none" | "cta";
  cta_text?: string;
  structure?: "auto" | "linear" | "hook_first";
  payoff_start?: number | null;
  payoff_end?: number | null;
  transition?: "cut" | "zoom" | "flash";
  variants?: { variable: "hook" | "opening_treatment" | "caption_style" | "hook_format" | "structure"; values: string[] } | null;
}
export interface CampaignRenderRequest extends CraftRequest {
  expected_strategy_version_id?: string | null;
  video_id: string;
  profile_id: string;
  start?: number;
  end?: number | null;
  hook?: string | null;
  caption?: string;
  subtitles?: boolean;
  mode?: "direct" | "strategy";
  instructions?: string;
  opening_treatment?: OpeningTreatment | null;
  cold_open_start?: number | null;
  cold_open_end?: number | null;
  focus_x?: number;
  changed_variable?: string;
  parent_clip_id?: string | null;
  change_reason?: string;
  retry_of_job_id?: string | null;
}
export interface AgentProductionRequest {
  expected_strategy_version_id?: string | null;
  video_id: string;
  profile_id: string;
  // IDs are dynamic: installed Ollama models use ollama:<name>:<tag>.
  model_id: string;
  revision_budget?: number;
  /** swarm (default): covers the whole episode, ranked best first. team: "Deep edit", a few self-checked clips. */
  strategy?: "team" | "swarm";
  /** Optional creator guidance for this run ("what to look for"). */
  direction?: string;
}
export const DIRECTION_MAX = 500;
export interface TranscriptImportRequest {
  format: "srt" | "vtt" | "json";
  content: string;
  language?: string | null;
}
export interface ProductionVideo extends Video {
  transcript_origin?: "generated" | "imported" | null;
  transcript_model?: string | null;
  transcript_format?: "srt" | "vtt" | "json" | null;
  transcript_updated_at?: string | null;
}
export type CheckStatus = "pass" | "fail" | "warn" | "not_applicable";
export interface TechnicalCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}
export type Check = TechnicalCheck;
export interface TechnicalChecks {
  checked_at: string;
  playback_format: TechnicalCheck[];
  captions: TechnicalCheck[];
  playback_format_passed: boolean;
  caption_issues: string[];
  boundary_tolerance_seconds?: number;
}
export interface RenderCost {
  status: "known" | "unknown";
  amount?: number | null;
  currency?: string;
  basis?: string;
  excluded?: string[];
}
export interface RenderReceipt {
  job_id: string;
  started_at: string;
  finished_at: string;
  elapsed_seconds: number;
  attempt: number;
  retry_of_job_id?: string | null;
  ffmpeg_version?: string | null;
  encoder?: JsonObject | null;
  cost?: RenderCost | null;
}
export interface SourceSegment {
  role: "teaser" | "cold_open" | "main";
  start: number;
  end: number;
}
/** Legacy plans may omit newer decisions. Missing fields remain unknown. */
export interface StoredRenderPlan {
  start?: number;
  end?: number;
  hook?: string;
  caption?: string;
  objective?: string;
  subtitles?: boolean;
  format?: "vertical";
  framing?: "fit" | "fill" | "blur";
  caption_style?: "standard" | "high_contrast" | "pop";
  hook_overlay?: boolean;
  opening_treatment?: OpeningTreatment | "none" | null;
  cold_open_start?: number | null;
  cold_open_end?: number | null;
  focus_x?: number;
  changed_variable?: string;
}
export interface ProductionClip extends Clip {
  edit_plan?: StoredRenderPlan | null;
  opening_treatment?: OpeningTreatment | "none" | null;
  changed_variable?: string | null;
  source_segments?: SourceSegment[] | null;
  transcript_origin?: "generated" | "imported" | null;
  caption_cues?: number | null;
  focus_x?: number | null;
  framing?: "fit" | "fill" | "blur" | null;
  caption_style?: "standard" | "high_contrast" | "pop" | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  technical_checks?: TechnicalChecks | null;
  sha256?: string | null;
  bytes?: number | null;
  render_receipt?: RenderReceipt | null;
  parent_clip_id?: string | null;
  root_clip_id?: string | null;
  revision_number?: number | null;
  change_reason?: string | null;
  plan_changes?: Array<{
    field: string;
    before: unknown;
    after: unknown;
  }> | null;
  approved_at?: string | null;
}
export type JobStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";
export interface ProductionJob extends Job {
  status: JobStatus;
  started_at?: string | null;
  finished_at?: string | null;
}
export interface AgentProductionResponse {
  job: ProductionJob;
  run: TeamRun;
}
export interface ExportManifest extends JsonObject {
  schema: "clip-factory/export-manifest@1";
  export_id: string;
  video: JsonObject & { file: string; sha256: string; bytes: number };
  clip: JsonObject & { id: string; revision_number: number };
  review: JsonObject & { state: "approved"; approved_at: string | null };
  strategy: JsonObject;
}
/** The export is a local folder; the media endpoint downloads an MP4, not ZIP. */
export interface ExportRecord {
  id: string;
  clip_id: string;
  video_id: string;
  campaign_id: string | null;
  profile_id: string | null;
  revision_number: number;
  sha256: string;
  bytes: number;
  file: string;
  location: string;
  checksum_recorded_at_render: boolean;
  created_at: string;
  manifest?: ExportManifest;
}
export interface ProductionScope {
  campaign_id?: string | null;
  profile_id?: string | null;
  video_id?: string;
  strategy_version_id?: string | null;
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const text = (v: unknown): v is string => typeof v === "string";
const identifier = (v: unknown): v is string => text(v) && !!v.trim();
const nonnegative = (v: unknown): v is number => finite(v) && v >= 0;
const positiveInteger = (v: unknown): v is number =>
  nonnegative(v) && Number.isInteger(v) && v > 0;
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(text);
const timestamp = (v: unknown): v is string =>
  text(v) && Number.isFinite(Date.parse(v));
const checksum = (v: unknown): v is string =>
  text(v) && /^[a-f0-9]{64}$/i.test(v);
const optional = (
  v: Record<string, unknown>,
  key: string,
  check: (value: unknown) => boolean,
  nullable = true,
) => v[key] === undefined || (nullable && v[key] === null) || check(v[key]);

export class ProductionResponseError extends Error {
  constructor(detail: string) {
    super(
      `${detail} Refresh the saved resources to reconcile this response before retrying the action.`,
    );
    this.name = "ProductionResponseError";
  }
}
function requireShape(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new ProductionResponseError(detail);
}

export function parseTechnicalChecks(value: unknown): TechnicalChecks {
  const check = (v: unknown) =>
    object(v) &&
    identifier(v.id) &&
    text(v.label) &&
    text(v.detail) &&
    ["pass", "fail", "warn", "not_applicable"].includes(String(v.status));
  requireShape(
    object(value) &&
      timestamp(value.checked_at) &&
      Array.isArray(value.playback_format) &&
      value.playback_format.every(check) &&
      Array.isArray(value.captions) &&
      value.captions.every(check) &&
      typeof value.playback_format_passed === "boolean" &&
      strings(value.caption_issues) &&
      optional(value, "boundary_tolerance_seconds", nonnegative, false),
    "Invalid technical-check response.",
  );
  requireShape(
    value.playback_format.length > 0 && value.captions.length > 0,
    "Technical checks contain no measured playback or caption status.",
  );
  requireShape(
    value.playback_format_passed ===
      !value.playback_format.some(
        (c) => (c as TechnicalCheck).status === "fail",
      ),
    "Technical-check summary contradicts its playback checks.",
  );
  const issueIds = value.captions
    .filter((c) => ["fail", "warn"].includes((c as TechnicalCheck).status))
    .map((c) => (c as TechnicalCheck).id);
  requireShape(
    value.caption_issues.length === issueIds.length &&
      value.caption_issues.every((id) => issueIds.includes(id)),
    "Caption-issue summary contradicts its checks.",
  );
  return value as unknown as TechnicalChecks;
}

export function parseProductionJob(
  value: unknown,
  expectedId?: string,
  expectedKind?: string,
): ProductionJob {
  requireShape(
    object(value) &&
      identifier(value.id) &&
      identifier(value.kind) &&
      ["queued", "running", "completed", "failed", "cancelled"].includes(
        String(value.status),
      ) &&
      optional(value, "progress", (v) => finite(v) && v >= 0 && v <= 100) &&
      optional(value, "message", text) &&
      optional(value, "error", text) &&
      optional(value, "result", object) &&
      optional(value, "context", object) &&
      optional(value, "created_at", timestamp, false) &&
      optional(value, "updated_at", timestamp, false) &&
      optional(value, "started_at", timestamp) &&
      optional(value, "finished_at", timestamp) &&
      optional(value, "lane", (v) => v === "download" || v === "heavy", false),
    "Invalid production-job response.",
  );
  requireShape(
    !expectedId || value.id === expectedId,
    "The service returned another job.",
  );
  requireShape(
    !expectedKind || value.kind === expectedKind,
    "The service returned an unexpected job kind.",
  );
  if (value.kind === "render" && value.status === "completed")
    requireShape(
      object(value.result) && identifier(value.result.clip_id),
      "A completed render response has no clip identity.",
    );
  return value as unknown as ProductionJob;
}

function parsePlan(value: unknown): void {
  requireShape(object(value), "Invalid saved edit plan.");
  for (const key of ["start", "end", "cold_open_start", "cold_open_end"])
    requireShape(
      optional(value, key, nonnegative),
      "Invalid saved source range.",
    );
  for (const key of ["hook", "caption", "objective", "changed_variable"])
    requireShape(
      optional(value, key, text, false),
      "Invalid saved edit-plan text.",
    );
  for (const key of ["subtitles", "hook_overlay"])
    requireShape(
      optional(value, key, (v) => typeof v === "boolean", false),
      "Invalid saved edit-plan flag.",
    );
  requireShape(
    optional(value, "format", (v) => v === "vertical", false) &&
      optional(value, "framing", framing, false) &&
      optional(value, "caption_style", captionStyle, false) &&
      optional(value, "focus_x", (v) => finite(v) && v >= 0 && v <= 1, false) &&
      optional(value, "opening_treatment", (v) =>
        ["none", "text_overlay", "cold_open"].includes(String(v)),
      ),
    "Invalid saved production treatment.",
  );
}
function parseReceipt(value: unknown): void {
  requireShape(
    object(value) &&
      identifier(value.job_id) &&
      timestamp(value.started_at) &&
      timestamp(value.finished_at) &&
      nonnegative(value.elapsed_seconds) &&
      positiveInteger(value.attempt) &&
      optional(value, "retry_of_job_id", identifier) &&
      optional(value, "ffmpeg_version", text) &&
      optional(value, "encoder", object),
    "Invalid render receipt.",
  );
  requireShape(
    Date.parse(value.finished_at) >= Date.parse(value.started_at),
    "Render receipt finishes before it starts.",
  );
  if (value.cost !== undefined && value.cost !== null) {
    const cost = value.cost;
    requireShape(
      object(cost) &&
        ["known", "unknown"].includes(String(cost.status)) &&
        optional(cost, "amount", nonnegative) &&
        optional(cost, "currency", text, false) &&
        optional(cost, "basis", text, false) &&
        optional(cost, "excluded", strings, false),
      "Invalid render cost receipt.",
    );
    requireShape(
      cost.status !== "known" ||
        (nonnegative(cost.amount) && identifier(cost.currency)),
      "Known render cost lacks an amount or currency.",
    );
  }
}
/** Check only declared scope. Legacy missing fields remain missing, never inferred. */
export function assertProductionScope(
  value: Record<string, unknown>,
  scope: ProductionScope,
  requireExpected = false,
): void {
  for (const key of [
    "campaign_id",
    "profile_id",
    "video_id",
    "strategy_version_id",
  ] as const) {
    if (
      scope[key] !== undefined &&
      (requireExpected || value[key] !== undefined)
    )
      requireShape(
        value[key] === scope[key],
        `Response ${key} does not match the requested scope.`,
      );
  }
}
export function parseProductionClip(
  value: unknown,
  expectedId?: string,
  scope: ProductionScope = {},
): ProductionClip {
  requireShape(
    object(value) &&
      identifier(value.id) &&
      identifier(value.video_id) &&
      text(value.name) &&
      nonnegative(value.start) &&
      finite(value.end) &&
      value.end > value.start &&
      text(value.hook) &&
      text(value.caption) &&
      text(value.objective) &&
      typeof value.approved === "boolean",
    "Invalid clip response.",
  );
  requireShape(
    !expectedId || value.id === expectedId,
    "The service returned another clip version.",
  );
  assertProductionScope(value, scope, true);
  for (const key of [
    "campaign_id",
    "profile_id",
    "strategy_version_id",
    "team_run_id",
    "parent_clip_id",
    "root_clip_id",
  ])
    requireShape(optional(value, key, identifier), `Invalid clip ${key}.`);
  for (const key of ["created_at", "approved_at"])
    requireShape(optional(value, key, timestamp), `Invalid clip ${key}.`);
  for (const key of ["hook_rendered", "subtitles_burned"])
    requireShape(
      optional(value, key, (v) => typeof v === "boolean"),
      `Invalid clip ${key}.`,
    );
  for (const key of [
    "changed_variable",
    "change_reason",
    "warning",
    "creator_instructions",
    "provenance_mode",
  ])
    requireShape(optional(value, key, text), `Invalid clip ${key}.`);
  for (const key of ["bytes", "caption_cues"])
    requireShape(
      optional(value, key, (v) => nonnegative(v) && Number.isInteger(v)),
      `Invalid clip ${key}.`,
    );
  for (const key of ["width", "height", "duration"])
    requireShape(
      optional(value, key, (v) => finite(v) && v > 0),
      `Invalid clip ${key}.`,
    );
  requireShape(
    optional(value, "revision_number", positiveInteger) &&
      optional(value, "sha256", checksum) &&
      optional(value, "focus_x", (v) => finite(v) && v >= 0 && v <= 1) &&
      optional(value, "opening_treatment", (v) =>
        ["none", "text_overlay", "cold_open"].includes(String(v)),
      ) &&
      optional(value, "framing", framing) &&
      optional(value, "caption_style", captionStyle) &&
      optional(
        value,
        "transcript_origin",
        (v) => v === "generated" || v === "imported",
      ) &&
      optional(value, "team_review_status", (v) =>
        ["pass", "fail", "unknown", "not_applicable"].includes(String(v)),
      ),
    "Invalid clip production metadata.",
  );
  if (value.edit_plan !== undefined && value.edit_plan !== null)
    parsePlan(value.edit_plan);
  if (value.render_receipt !== undefined && value.render_receipt !== null)
    parseReceipt(value.render_receipt);
  if (value.technical_checks !== undefined && value.technical_checks !== null)
    parseTechnicalChecks(value.technical_checks);
  requireShape(
    optional(
      value,
      "source_segments",
      (v) =>
        Array.isArray(v) &&
        v.every(
          (s) =>
            object(s) &&
            ["teaser", "cold_open", "main"].includes(String(s.role)) &&
            nonnegative(s.start) &&
            finite(s.end) &&
            s.end > s.start,
        ),
    ) &&
      optional(
        value,
        "plan_changes",
        (v) =>
          Array.isArray(v) &&
          v.every(
            (c) =>
              object(c) && identifier(c.field) && "before" in c && "after" in c,
          ),
      ),
    "Invalid clip lineage or source segments.",
  );
  return value as unknown as ProductionClip;
}

export function parseProductionVideo(
  value: unknown,
  expectedId: string,
): ProductionVideo {
  requireShape(
    object(value) &&
      value.id === expectedId &&
      text(value.name) &&
      optional(value, "duration", (v) => finite(v) && v > 0) &&
      optional(value, "has_audio", (v) => typeof v === "boolean") &&
      optional(
        value,
        "transcript_origin",
        (v) => v === "generated" || v === "imported",
      ) &&
      optional(value, "transcript_model", text) &&
      optional(value, "transcript_format", (v) =>
        ["srt", "vtt", "json"].includes(String(v)),
      ) &&
      optional(value, "transcript_updated_at", timestamp),
    "Invalid source/transcript response.",
  );
  return value as unknown as ProductionVideo;
}
export function parseExportRecord(
  value: unknown,
  clip?: ProductionClip,
): ExportRecord {
  requireShape(
    object(value) &&
      identifier(value.id) &&
      identifier(value.clip_id) &&
      identifier(value.video_id) &&
      (value.campaign_id === null || identifier(value.campaign_id)) &&
      (value.profile_id === null || identifier(value.profile_id)) &&
      positiveInteger(value.revision_number) &&
      checksum(value.sha256) &&
      nonnegative(value.bytes) &&
      Number.isInteger(value.bytes) &&
      text(value.file) &&
      /^[^/\\]+\.mp4$/i.test(value.file) &&
      identifier(value.location) &&
      typeof value.checksum_recorded_at_render === "boolean" &&
      timestamp(value.created_at),
    "Invalid verified-export response.",
  );
  if (clip) {
    requireShape(
      value.clip_id === clip.id && value.video_id === clip.video_id,
      "The export belongs to another clip or source.",
    );
    assertProductionScope(
      value,
      { campaign_id: clip.campaign_id, profile_id: clip.profile_id },
      true,
    );
    requireShape(
      clip.revision_number == null ||
        value.revision_number === clip.revision_number,
      "The export belongs to another revision.",
    );
    requireShape(
      !clip.sha256 || value.sha256 === clip.sha256,
      "The export checksum does not match the reviewed clip.",
    );
  }
  if (value.manifest !== undefined) {
    const m = value.manifest;
    requireShape(
      object(m) &&
        m.schema === "clip-factory/export-manifest@1" &&
        m.export_id === value.id &&
        object(m.video) &&
        m.video.file === value.file &&
        m.video.sha256 === value.sha256 &&
        m.video.bytes === value.bytes &&
        object(m.clip) &&
        m.clip.id === value.clip_id &&
        m.clip.revision_number === value.revision_number &&
        object(m.review) &&
        m.review.state === "approved" &&
        (m.review.approved_at === null || timestamp(m.review.approved_at)) &&
        object(m.strategy) &&
        object(m.source) &&
        m.source.video_id === value.video_id,
      "Export manifest does not match the saved export.",
    );
    assertProductionScope(
      m.strategy,
      {
        campaign_id: value.campaign_id as string | null,
        profile_id: value.profile_id as string | null,
      },
      true,
    );
    if (clip?.strategy_version_id !== undefined)
      assertProductionScope(
        m.strategy,
        { strategy_version_id: clip.strategy_version_id },
        true,
      );
    if (m.technical_checks !== undefined && m.technical_checks !== null)
      parseTechnicalChecks(m.technical_checks);
    if (m.render_receipt !== undefined && m.render_receipt !== null)
      parseReceipt(m.render_receipt);
  }
  return value as unknown as ExportRecord;
}

// fit/fill are what a direction can ask for. Agent-made clips can also be "blur" (the whole
// picture over a blurred backdrop) and "pop" (word-by-word captions).
function framing(value: unknown) {
  return value === "fit" || value === "fill" || value === "blur";
}
function captionStyle(value: unknown) {
  return value === "standard" || value === "high_contrast" || value === "pop";
}

export function parseAgentProductionResponse(
  value: unknown,
  scope: ProductionScope = {},
  strategy: "team" | "swarm" = "swarm",
): AgentProductionResponse {
  requireShape(object(value), "Agent production requires a job/run envelope.");
  const job = parseProductionJob(value.job, undefined, strategy);
  const run = value.run;
  requireShape(
    object(run) &&
      identifier(run.id) &&
      identifier(run.video_id) &&
      run.job_id === job.id &&
      identifier(run.model_id) &&
      run.mode === strategy &&
      [
        "queued",
        "running",
        "needs_review",
        "failed",
        "cancelled",
        "interrupted",
        "completed",
      ].includes(String(run.status)) &&
      text(run.objective) &&
      nonnegative(run.revision_budget) &&
      Number.isInteger(run.revision_budget) &&
      run.revision_budget <= 2 &&
      nonnegative(run.revision_count) &&
      Number.isInteger(run.revision_count) &&
      strings(run.clip_ids) &&
      timestamp(run.created_at) &&
      optional(run, "started_at", timestamp) &&
      optional(run, "finished_at", timestamp) &&
      optional(run, "elapsed_seconds", nonnegative) &&
      optional(run, "stop_reason", text) &&
      object(run.permissions) &&
      run.permissions.publish === false &&
      run.permissions.ads === false &&
      Array.isArray(run.tasks),
    "Invalid agent-run response.",
  );
  for (const task of run.tasks)
    requireShape(
      object(task) &&
        identifier(task.id) &&
        identifier(task.role) &&
        text(task.label) &&
        ["agent", "tool"].includes(String(task.kind)) &&
        [
          "queued",
          "running",
          "completed",
          "failed",
          "cancelled",
          "skipped",
        ].includes(String(task.status)) &&
        nonnegative(task.iteration) &&
        Number.isInteger(task.iteration) &&
        strings(task.input_refs) &&
        (task.output === null || object(task.output)) &&
        (task.error === null || text(task.error)) &&
        (task.started_at === null || timestamp(task.started_at)) &&
        (task.finished_at === null || timestamp(task.finished_at)),
      "Invalid agent task response.",
    );
  assertProductionScope(run, { video_id: scope.video_id }, true);
  if (object(job.context))
    assertProductionScope(job.context, { video_id: scope.video_id });
  const scoped = scope.campaign_id != null || scope.profile_id != null || scope.strategy_version_id != null;
  if (scoped)
    requireShape(object(run.context) && object(run.context.campaign_snapshot), "The agent run has no frozen campaign context.");
  if (object(run.context) && object(run.context.campaign_snapshot))
    assertProductionScope(run.context.campaign_snapshot, scope, true);
  if (object(job.context) && job.context.team_run_id !== undefined)
    requireShape(
      job.context.team_run_id === run.id,
      "Job and agent run identities disagree.",
    );
  return { job, run: run as unknown as TeamRun };
}
