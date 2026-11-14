import { describe, expect, it } from "vitest";
import { briefBody, briefProblem, briefSummary, emptyBrief, normalizeBrief, sameBrief } from "./briefModel";

const legacy = { audience: "Builders", constraints: ["Keep meaning"], requested_outputs: [], measurement_intent: "" };

describe("campaign brief model", () => {
  it("reads old briefs complete and compares by value", () => {
    const full = normalizeBrief(legacy);
    expect(full.constraints).toEqual(["Keep meaning"]);
    expect(full.key_messages).toEqual([]);
    expect(full.deliverables.platforms).toEqual(["instagram_reels"]);
    expect(sameBrief(legacy, full)).toBe(true);
    expect(sameBrief(legacy, { ...legacy, cta: "Go" })).toBe(false);
  });
  it("mirrors the service's validation", () => {
    const ok = { ...emptyBrief(), key_messages: ["One"], cta: "Listen", cta_link: "https://example.com/ep" };
    expect(briefProblem(ok)).toBeNull();
    expect(briefProblem({ ...ok, key_messages: ["a", "b", "c", "d", "e", "f"] })).toMatch(/up to 5/);
    expect(briefProblem({ ...ok, key_messages: ["Same", "same"] })).toMatch(/repeated/);
    expect(briefProblem({ ...ok, cta_link: "javascript:alert(1)" })).toMatch(/https/);
    expect(briefProblem({ ...ok, cta: "", cta_link: "https://example.com" })).toMatch(/text/);
    expect(briefProblem({ ...ok, references: [{ url: "ftp://x", note: "" }] })).toMatch(/https/);
    expect(briefProblem({ ...ok, deliverables: { ...ok.deliverables, clip_count: 0 } })).toMatch(/1 and 50/);
    expect(briefProblem({ ...ok, context: "x".repeat(1501) })).toMatch(/1,500/);
    expect(briefBody({ ...ok, cta: "  Listen  ", cta_link: "  " }).cta_link).toBeNull();
  });
  it("summarises goal, CTA and avoid list on one line", () => {
    const brief = { ...legacy, cta: "Listen to the full episode", must_avoid: ["market predictions"] };
    expect(briefSummary(brief, "traffic", "full-episode_visits")).toBe(
      "Goal: drive full-episode visits · CTA: Listen to the full episode · Avoid: market predictions",
    );
    expect(briefSummary(legacy)).toBe("Goal: explore and learn");
    expect(briefSummary({ ...legacy, key_messages: ["Agents need review"] }, "awareness")).toBe(
      "Goal: reach new people · Message: Agents need review",
    );
  });
});
