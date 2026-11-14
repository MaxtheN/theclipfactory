import { describe, expect, it } from "vitest";
import type { Clip } from "../types";
import type { DemoResult } from "./demoStore";
import { simulateResults } from "./demoResults";

const clip = (id: string, hook: string): Clip =>
  ({ id, video_id: "v", name: id, start: 0, end: 20 + id.length, hook, caption: "", objective: "", approved: false, profile_id: "p" }) as Clip;
const sim = (id: string, hold: number, outcome: "win" | "steady" | "loss") => ({
  clip_id: id, hook: `${id}?`, score: 80, seconds: 30, media_url: "", cover_url: `/c/${id}`, outcome, opening: "question" as const,
  simulated: { metrics: { views: 2000, completion_rate: 0.5, hold_3s: hold } },
});
const demo = {
  ran_at: "2026-11-14T12:00:00Z",
  after: null,
  plan: {
    profile_id: "p",
    baseline: { metrics: { views: 1600, completion_rate: 0.41, hold_3s: 0.52 } },
    clips: [sim("a", 0.71, "win"), sim("b", 0.55, "steady"), sim("c", 0.35, "loss")],
    clip_count: 22, source_minutes: 10,
    beliefs: [{ id: "q", headline: "Question hooks hold viewers", confidence: 0.75, detail: "+37% 3-sec hold", status: "active",
      counts: { matching: 2, beats: 2 }, evidence: [{ clip_id: "a", value: 0.71, baseline: 0.52, outcome: "beat" }] }],
    recut: { clip_id: "c", before_kind: "setup", before_hook: "x", after_kind: "question", after_hook: "y?", payoff_start: 1, payoff_end: 2, rule: "", next_test: "Jump cuts" },
    engine: "", honesty: "",
  },
} as unknown as DemoResult;

describe("simulated Results around the learning-loop demo", () => {
  const clips = ["a", "b", "c", ...Array.from({ length: 19 }, (_, i) => `k${i}`)].map((id) => clip(id, `Hook ${id} why?`));
  it("covers every real clip deterministically and keeps the demo's numbers", () => {
    const one = simulateResults(demo, clips);
    expect(one).toEqual(simulateResults(demo, clips));
    expect(one.posts).toHaveLength(22);
    expect(one.posts.find((p) => p.clip_id === "a")?.metrics.hold_3s).toBe(0.71);
    expect(one.posts.find((p) => p.clip_id === "c")?.metrics.hold_3s).toBe(0.35);
    const others = one.posts.filter((p) => !p.role).map((p) => p.metrics.hold_3s);
    expect(Math.max(...others)).toBeLessThan(0.71);
    expect(Math.min(...others)).toBeGreaterThan(0.35);
    const span = Date.parse(demo.ran_at) - Math.min(...one.posts.map((p) => Date.parse(p.posted_at)));
    expect(span).toBeLessThanOrEqual(11 * 86_400_000);
  });
  it("learns eight beliefs led by the demo's own, each citing clips", () => {
    const { beliefs } = simulateResults(demo, clips);
    expect(beliefs).toHaveLength(8);
    expect(beliefs[0]).toMatchObject({ headline: "Question hooks hold viewers", confidence: 0.75 });
    beliefs.forEach((b) => expect(b.support.length).toBeGreaterThan(0));
  });
});
