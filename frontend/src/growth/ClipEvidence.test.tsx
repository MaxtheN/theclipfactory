import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ClipEvidence } from "./ClipEvidence";
import type { ProductionClip } from "./productionContracts";

const clip = (changes: Partial<ProductionClip> = {}): ProductionClip => ({
  id: "clip-1",
  video_id: "source-1",
  name: "An exact version",
  start: 2,
  end: 32,
  hook: "Claim first",
  caption: "",
  objective: "discovery",
  approved: false,
  ...changes,
});

describe("read-only clip evidence", () => {
  it("keeps legacy missing checks and receipts unknown rather than inventing success", () => {
    render(<ClipEvidence clip={clip()} />);
    const summary = screen.getByLabelText("Review status summary");
    expect(within(summary).getAllByText("Unknown")).toHaveLength(3);
    expect(
      within(summary).getByText("Awaiting human review"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checks passed")).not.toBeInTheDocument();
    expect(screen.queryByText("0.00 USD")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Rendered segment record: unknown/),
    ).toBeInTheDocument();
  });
  it("separates measured checks, caption warnings, critique and human review", () => {
    render(
      <ClipEvidence
        clip={clip({
          team_run_id: "run-1",
          team_review_status: "pass",
          technical_checks: {
            checked_at: "2026-11-14T10:00:00Z",
            playback_format_passed: true,
            caption_issues: ["display_time"],
            playback_format: [
              {
                id: "decode",
                label: "Full decode",
                status: "pass",
                detail: "Every frame decoded.",
              },
            ],
            captions: [
              {
                id: "display_time",
                label: "Readable display time",
                status: "warn",
                detail: "Two cues flash too quickly.",
              },
            ],
          },
        })}
      />,
    );
    const summary = screen.getByLabelText("Review status summary");
    expect(within(summary).getByText("Checks passed")).toBeInTheDocument();
    expect(within(summary).getByText("1 issue to review")).toBeInTheDocument();
    expect(within(summary).getByText("Pass")).toBeInTheDocument();
    expect(
      within(summary).getByText("Awaiting human review"),
    ).toBeInTheDocument();
    expect(screen.getByText("Two cues flash too quickly.")).toBeInTheDocument();
    expect(screen.queryByText("Human approved")).not.toBeInTheDocument();
  });
  it("shows exact lineage and cash-cost basis without implying savings or a full production cost", () => {
    render(
      <ClipEvidence
        clip={clip({
          approved: true,
          revision_number: 2,
          parent_clip_id: "parent-1",
          root_clip_id: "root-1",
          change_reason: "Start later",
          plan_changes: [{ field: "start", before: 0, after: 2 }],
          strategy_version_id: "strategy-2",
          render_receipt: {
            job_id: "job-1",
            started_at: "2026-11-14T10:00:00Z",
            finished_at: "2026-11-14T10:00:03Z",
            elapsed_seconds: 3,
            attempt: 2,
            retry_of_job_id: "failed-1",
            encoder: { video_codec: "libx264" },
            cost: {
              status: "known",
              amount: 0,
              currency: "USD",
              basis: "Local FFmpeg only.",
              excluded: ["hardware", "human time"],
            },
          },
          source_segments: [
            { role: "cold_open", start: 0, end: 1 },
            { role: "main", start: 2, end: 32 },
          ],
          opening_treatment: "cold_open",
          framing: "fill",
          focus_x: 0.8,
          width: 1080,
          height: 1920,
        })}
      />,
    );
    expect(screen.getByText("Human approved")).toBeInTheDocument();
    expect(screen.getByText("Revision 2")).toBeInTheDocument();
    expect(screen.getByText("parent-1")).toBeInTheDocument();
    expect(screen.getByText("root-1")).toBeInTheDocument();
    expect(screen.getByText("Start later")).toBeInTheDocument();
    expect(screen.getByText("0.00 USD")).toBeInTheDocument();
    expect(screen.getByText("Local FFmpeg only.")).toBeInTheDocument();
    expect(
      screen.getByText(/Excluded: Hardware, Human time/),
    ).toBeInTheDocument();
    expect(screen.getByText(/not the full cost per asset/)).toBeInTheDocument();
    expect(screen.getByText("80% from left")).toBeInTheDocument();
    expect(screen.getByText("strategy-2")).toBeInTheDocument();
    expect(screen.getByText("Cold open: 0.00–1.00 s")).toBeInTheDocument();
  });
  it("labels fixture records and exposes no decision/action controls", () => {
    render(
      <ClipEvidence clip={clip({ provenance_mode: "preview_fixture" })} />,
    );
    expect(screen.getByText("Illustrative record")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Approve|Export|Publish/ }),
    ).not.toBeInTheDocument();
  });
});
