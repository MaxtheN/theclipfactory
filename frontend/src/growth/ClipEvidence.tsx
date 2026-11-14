import type { ReactNode } from "react";
import type { ProductionClip, TechnicalCheck } from "./productionContracts";
import { Disclosure, Pill } from "./parts";

const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const unknown = "Unknown";
const labels = {
  pass: "Pass",
  fail: "Failed",
  warn: "Warning",
  not_applicable: "Not applicable",
};
function readable(value: unknown): string {
  if (value === undefined) return "Not recorded";
  if (value === null) return "Not set";
  if (typeof value === "string") return value || "Empty";
  try {
    return JSON.stringify(value);
  } catch {
    return "Unavailable";
  }
}
function title(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span>{label}</span>
      <strong style={{ overflowWrap: "anywhere" }}>{children}</strong>
    </div>
  );
}
function Checks({ title, rows }: { title: string; rows?: TechnicalCheck[] }) {
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      {rows?.length ? (
        <div className="gf-review-checks">
          {rows.map((check, index) => (
            <div key={`${check.id}-${index}`}>
              <span>
                <strong>{check.label}</strong>
                {check.detail}
              </span>
              <Pill
                tone={
                  check.status === "pass"
                    ? "mint"
                    : check.status === "not_applicable"
                      ? "quiet"
                      : "sand"
                }
              >
                {labels[check.status]}
              </Pill>
            </div>
          ))}
        </div>
      ) : (
        <p>Checks not recorded. Status is unknown.</p>
      )}
    </section>
  );
}

/** Read-only evidence for this exact saved output; no review decisions or API calls. */
export function ClipEvidence({ clip }: { clip: ProductionClip }) {
  const checks = clip.technical_checks;
  const receipt = clip.render_receipt;
  const cost = receipt?.cost;
  const captionIssues = checks?.captions.filter(
    (check) => check.status === "fail" || check.status === "warn",
  );
  const captionStatus = !checks?.captions.length
    ? unknown
    : captionIssues?.length
      ? `${captionIssues.length} issue${captionIssues.length === 1 ? "" : "s"} to review`
      : checks.captions.every((check) => check.status === "not_applicable")
        ? "Not applicable"
        : "Checks passed";
  const critique =
    clip.team_review_status === "pass"
      ? "Pass"
      : clip.team_review_status === "fail"
        ? "Needs attention"
        : clip.team_review_status === "not_applicable"
          ? "Not applicable"
          : unknown;
  const rootId =
    clip.root_clip_id ||
    (clip.root_clip_id === null &&
    clip.parent_clip_id === null &&
    clip.revision_number === 1
      ? clip.id
      : undefined);
  const encoder = receipt?.encoder;
  const encoderName =
    typeof encoder?.video_codec === "string" ? encoder.video_codec : unknown;
  const knownCost =
    cost?.status === "known" &&
    number(cost.amount) &&
    typeof cost.currency === "string";
  return (
    <div
      className="gf-clip-evidence"
      aria-label="Evidence for this clip version"
    >
      {clip.provenance_mode === "preview_fixture" && (
        <Pill tone="sand">Illustrative record</Pill>
      )}
      <div className="gf-review-checks" aria-label="Review status summary">
        <Fact label="Playback & format">
          {checks?.playback_format_passed === true
            ? "Checks passed"
            : checks?.playback_format_passed === false
              ? "Checks failed"
              : unknown}
        </Fact>
        <Fact label="Transcript captions">{captionStatus}</Fact>
        <Fact label="Model critique">{critique}</Fact>
        <Fact label="Human acceptance">
          {clip.approved === true
            ? "Human approved"
            : clip.approved === false
              ? "Awaiting human review"
              : unknown}
        </Fact>
      </div>
      <p className="gf-small-note">
        Technical checks and model critique do not replace human review of this
        exact version.
      </p>
      <Disclosure title="Technical check details" icon="info">
        <Checks title="Playback and format" rows={checks?.playback_format} />
        <Checks title="Transcript captions" rows={checks?.captions} />
        <p>Checked at: {checks?.checked_at || unknown}</p>
        {number(checks?.boundary_tolerance_seconds) && (
          <p>
            Cut-boundary tolerance:{" "}
            {checks.boundary_tolerance_seconds.toFixed(4)} s per boundary.
          </p>
        )}
      </Disclosure>
      <Disclosure title="Version history & changes" icon="refresh">
        <div className="gf-review-checks">
          <Fact label="Version">
            {number(clip.revision_number)
              ? `Revision ${clip.revision_number}`
              : unknown}
          </Fact>
          <Fact label="Parent version">
            {clip.parent_clip_id ||
              (clip.parent_clip_id === null && clip.revision_number === 1
                ? "Original version"
                : unknown)}
          </Fact>
          <Fact label="Root version">{rootId || unknown}</Fact>
          <Fact label="Reason for change">
            {clip.change_reason?.trim() || "Not recorded"}
          </Fact>
          <Fact label="Human approval time">
            {clip.approved_at || "Not recorded"}
          </Fact>
        </div>
        {clip.plan_changes?.length ? (
          <div aria-label="Recorded edit changes">
            {clip.plan_changes.map((change, index) => (
              <p
                key={`${change.field}-${index}`}
                style={{ overflowWrap: "anywhere" }}
              >
                <strong>{title(change.field)}:</strong>{" "}
                {readable(change.before)} → {readable(change.after)}
              </p>
            ))}
          </div>
        ) : (
          <p>No edit-decision changes recorded.</p>
        )}
      </Disclosure>
      <Disclosure title="Processing receipt" icon="clock">
        <div className="gf-review-checks">
          <Fact label="Processing time">
            {number(receipt?.elapsed_seconds)
              ? `${receipt.elapsed_seconds.toFixed(1)} s`
              : unknown}
          </Fact>
          <Fact label="Render attempt">
            {number(receipt?.attempt) ? receipt.attempt : unknown}
          </Fact>
          <Fact label="Previous failed/cancelled job">
            {receipt?.retry_of_job_id || "Not recorded"}
          </Fact>
          <Fact label="Encoder">{encoderName}</Fact>
          <Fact label="Direct render cost">
            {knownCost
              ? `${cost.amount!.toFixed(2)} ${cost.currency}`
              : unknown}
          </Fact>
        </div>
        <p>{cost?.basis || "No processing-cost basis recorded."}</p>
        {!!cost?.excluded?.length && (
          <p>Excluded: {cost.excluded.map(title).join(", ")}.</p>
        )}
        <p className="gf-small-note">
          Processing time excludes queue wait and human work. Direct render cost
          is not the fully loaded cost per usable asset.
        </p>
        <p>
          Started: {receipt?.started_at || unknown}
          <br />
          Finished: {receipt?.finished_at || unknown}
        </p>
        <p>
          Job: {receipt?.job_id || unknown}
          <br />
          FFmpeg: {receipt?.ffmpeg_version || unknown}
        </p>
      </Disclosure>
      <Disclosure title="Source, crop & saved context" icon="studio">
        <div className="gf-review-checks">
          <Fact label="Clip identity">{clip.id}</Fact>
          <Fact label="Source identity">{clip.video_id}</Fact>
          <Fact label="Main source range">
            {clip.start.toFixed(2)}–{clip.end.toFixed(2)} s
          </Fact>
          <Fact label="Opening treatment">
            {clip.opening_treatment ? title(clip.opening_treatment) : unknown}
          </Fact>
          <Fact label="Changed variable">
            {clip.changed_variable
              ? title(clip.changed_variable)
              : "Not recorded"}
          </Fact>
          <Fact label="Framing">
            {clip.framing === "fit"
              ? "Fit · preserve full frame"
              : clip.framing === "fill"
                ? "Fill · vertical crop"
                : clip.framing === "blur"
                  ? "Whole frame over a blurred backdrop"
                  : unknown}
          </Fact>
          <Fact label="Horizontal crop focus">
            {clip.framing === "fit"
              ? "Not applicable to fit"
              : number(clip.focus_x)
                ? `${Math.round(clip.focus_x * 100)}% from left`
                : unknown}
          </Fact>
          <Fact label="Output dimensions">
            {number(clip.width) && number(clip.height)
              ? `${clip.width} × ${clip.height}`
              : unknown}
          </Fact>
          <Fact label="Output duration">
            {number(clip.duration) ? `${clip.duration.toFixed(2)} s` : unknown}
          </Fact>
          <Fact label="Transcript origin">
            {clip.transcript_origin ? title(clip.transcript_origin) : unknown}
          </Fact>
          <Fact label="Caption cues">
            {number(clip.caption_cues) ? clip.caption_cues : unknown}
          </Fact>
          <Fact label="Campaign / profile">
            {clip.campaign_id || unknown} / {clip.profile_id || unknown}
          </Fact>
          <Fact label="Strategy snapshot identity">
            {clip.strategy_version_id || unknown}
          </Fact>
          <Fact label="Output SHA-256">{clip.sha256 || unknown}</Fact>
        </div>
        {clip.source_segments?.length ? (
          <div aria-label="Rendered source segments">
            {clip.source_segments.map((segment, index) => (
              <p key={`${segment.role}-${index}`}>
                {title(segment.role)}: {segment.start.toFixed(2)}–
                {segment.end.toFixed(2)} s
              </p>
            ))}
          </div>
        ) : (
          <p>
            Rendered segment record: unknown. The main range above is the saved
            clip selection.
          </p>
        )}
      </Disclosure>
    </div>
  );
}
