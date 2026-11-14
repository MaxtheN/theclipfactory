import type { Clip } from "../types";
import type { DemoResult } from "./demoStore";

/**
 * A deterministic, SIMULATED Results dataset built from the brand's real clips around the
 * learning-loop demo. The demo's three clips keep exactly the numbers the demo showed; every
 * other number is derived from the demo's own baseline. Display only: never written anywhere.
 */
export type SimMetrics = { views: number; hold_3s: number; avg_watch: number; saves: number; shares: number };
export type SimPost = {
  clip_id: string;
  hook: string;
  cover_url: string;
  posted_at: string;
  metrics: SimMetrics;
  role: "win" | "steady" | "loss" | null;
};
export type SimBelief = { id: string; headline: string; confidence: number; detail: string; support: string[] };
export type SimResults = { posts: SimPost[]; typical: SimMetrics; beliefs: SimBelief[] };

const DAY = 86_400_000;

/** Stable 0..1 from a string (FNV-1a). */
function unit(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

const avgWatch = (completion: number) => Math.round((0.28 + completion * 0.62) * 1000) / 1000;
const seconds = (clip: Clip) => Math.max(0, (clip.end ?? 0) - (clip.start ?? 0));
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Every current clip of the brand (re-edits included), with real thumbnails and hooks. */
export function brandClips(clips: Clip[], profileId: string): Clip[] {
  return clips.filter((c) => c.profile_id === profileId && !(c as Clip & { archived_at?: string | null }).archived_at);
}

export function simulateResults(demo: DemoResult, clips: Clip[]): SimResults {
  const { plan } = demo;
  const base = plan.baseline.metrics;
  const typical: SimMetrics = {
    views: base.views,
    hold_3s: base.hold_3s,
    avg_watch: avgWatch(base.completion_rate),
    saves: Math.round(base.views * 0.011),
    shares: Math.round(base.views * 0.0045),
  };
  const end = Date.parse(demo.ran_at) || Date.now();
  const demoIds = new Set(plan.clips.map((c) => c.clip_id));
  const pool = [...clips.filter((c) => !demoIds.has(c.id))].sort((a, b) => a.id.localeCompare(b.id));

  const posts: SimPost[] = plan.clips.map((c) => {
    const m = c.simulated.metrics;
    const r = unit(`${c.clip_id}:social`);
    const lift = m.hold_3s / base.hold_3s;
    return {
      clip_id: c.clip_id,
      hook: c.hook,
      cover_url: c.cover_url,
      posted_at: new Date(end - 3 * DAY - Math.round(r * 6) * 3_600_000).toISOString(),
      metrics: {
        views: m.views,
        hold_3s: m.hold_3s,
        avg_watch: avgWatch(m.completion_rate),
        saves: Math.round(typical.saves * lift * (0.9 + r * 0.3)),
        shares: Math.round(typical.shares * lift * (0.85 + r * 0.3)),
      },
      role: c.outcome,
    };
  });
  pool.forEach((clip, i) => {
    const r = (k: string) => unit(`${clip.id}:${k}`);
    // Between the demo's underperformer and winner, so the demo's story stays the extremes.
    const hold = Math.round(base.hold_3s * (0.76 + r("hold") * 0.46) * 1000) / 1000;
    const lift = hold / base.hold_3s;
    const day = Math.floor((i * 10) / Math.max(1, pool.length)) + r("day") * 0.6;
    posts.push({
      clip_id: clip.id,
      hook: clip.hook || clip.name,
      cover_url: `/api/clips/${encodeURIComponent(clip.id)}/cover`,
      posted_at: new Date(end - day * DAY - Math.round(r("hour") * 10) * 3_600_000).toISOString(),
      metrics: {
        views: Math.round(base.views * lift * (0.6 + r("views") * 0.8)),
        hold_3s: hold,
        avg_watch: Math.round(avgWatch(base.completion_rate) * lift * (0.9 + r("watch") * 0.2) * 1000) / 1000,
        saves: Math.round(typical.saves * lift * (0.5 + r("saves") * 1.1)),
        shares: Math.round(typical.shares * lift * (0.5 + r("shares") * 1.1)),
      },
      role: null,
    });
  });
  posts.sort((a, b) => b.posted_at.localeCompare(a.posted_at));

  const byId = new Map(clips.map((c) => [c.id, c]));
  const duration = (p: SimPost) => {
    const real = byId.get(p.clip_id);
    return real ? seconds(real) : plan.clips.find((c) => c.clip_id === p.clip_id)?.seconds ?? 0;
  };
  const hour = (p: SimPost) => new Date(p.posted_at).getHours();
  /** Up to four clips matching the trait that beat typical on the metric, best first. */
  const cite = (match: (p: SimPost) => boolean, metric: keyof SimMetrics) => {
    const beat = posts.filter((p) => p.metrics[metric] > typical[metric]);
    const hits = beat.filter(match);
    return (hits.length >= 2 ? hits : beat).sort((a, b) => b.metrics[metric] - a.metrics[metric]).slice(0, 4);
  };
  const lift = (group: SimPost[], metric: keyof SimMetrics) => {
    const mean = group.reduce((s, p) => s + p.metrics[metric], 0) / Math.max(1, group.length);
    return Math.max(1, Math.round((mean / typical[metric] - 1) * 100));
  };

  const lead = plan.beliefs.find((b) => b.counts.matching > 0) ?? plan.beliefs[0];
  const leadIds = lead.evidence.filter((e) => e.outcome !== "loss").map((e) => e.clip_id);
  const beliefs: SimBelief[] = [
    {
      id: lead.id,
      headline: lead.headline,
      confidence: lead.confidence,
      detail: lead.detail,
      support: [...new Set([...leadIds, ...cite((p) => p.hook.includes("?"), "hold_3s").map((p) => p.clip_id)])].slice(0, 4),
    },
  ];
  const rest: [string, string, (p: SimPost) => boolean, keyof SimMetrics, string, number][] = [
    ["pacing", "Cutting pauses keeps people watching", (p) => duration(p) > 0 && duration(p) < 40, "avg_watch", "avg watch", 0.71],
    ["length", "Clips under 35 seconds finish more often", (p) => duration(p) > 0 && duration(p) < 35, "avg_watch", "avg watch", 0.68],
    ["topic", "Personal stories beat general tips", (p) => /\b(i|my|me|we)\b/i.test(p.hook), "saves", "saves", 0.64],
    ["time", "Evening posts reach more people", (p) => hour(p) >= 17 && hour(p) <= 21, "views", "views", 0.61],
    ["caption", "Short captions earn more shares", (p) => words(p.hook) <= 7, "shares", "shares", 0.58],
    ["cover", "Face-forward covers get more taps", (p) => unit(`${p.clip_id}:face`) > 0.4, "views", "views", 0.55],
    ["speaker", "Talking to camera holds better", (p) => unit(`${p.clip_id}:camera`) > 0.35, "hold_3s", "3-sec hold", 0.52],
  ];
  for (const [id, headline, match, metric, label, confidence] of rest) {
    const group = cite(match, metric);
    beliefs.push({ id: `sim-${id}`, headline, confidence, detail: `+${lift(group, metric)}% ${label}`, support: group.map((p) => p.clip_id) });
  }
  return { posts, typical, beliefs };
}
