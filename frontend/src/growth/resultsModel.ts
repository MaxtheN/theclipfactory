/**
 * Results in plain words: pure functions from saved records to the page's story.
 * Post → Measure → Learn. No number here is invented; unknown stays unknown.
 */
import type { Clip } from "../types";
import { shortDate, type Row } from "./flowEvents";
import type { PortfolioSlot } from "./strategistApi";

const text = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const time = (v: unknown): number | null => {
  const t = Date.parse(text(v));
  return Number.isFinite(t) ? t : null;
};
const plural = (n: number, word: string, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;

export type StoryStep = "post" | "measure" | "learn";
export interface StoryInput {
  approvedClips: number;
  /** Posts on Instagram (tracked or posted from the app). */
  posted: number;
  publications: Row[];
  snapshots: Row[];
  /** Non-retired beliefs with at least one measured post. */
  learned: number;
  pendingRules: number;
  now: number;
}
export interface Story {
  current: StoryStep;
  headline: string;
  steps: { key: StoryStep; label: string; note: string; state: "done" | "current" | "upcoming" }[];
}

export function nextCheck(publications: Row[], now: number): number | null {
  const due = publications
    .map((p) => time(p.next_due_at))
    .filter((t): t is number => t !== null && t > now)
    .sort((a, b) => a - b);
  return due[0] ?? null;
}

export function resultsStory(i: StoryInput): Story {
  const measured = new Set(i.snapshots.map((s) => text(s.publication_id)))
    .size;
  const measuring = i.publications.filter(
    (p) => !i.snapshots.some((s) => s.publication_id === p.id),
  ).length;
  const due = nextCheck(i.publications, i.now);
  let current: StoryStep, headline: string;
  if (!i.posted) {
    current = "post";
    headline = i.approvedClips
      ? `Nothing posted yet — post one of your ${plural(i.approvedClips, "approved clip")} and track it`
      : "Nothing posted yet — approve a clip and post it";
  } else if (!measured) {
    current = "measure";
    headline = `Waiting: ${plural(Math.max(measuring, 1), "post")} measuring${due ? `, next check ${shortDate(due)}` : ""}`;
  } else {
    current = "learn";
    const rules = i.pendingRules
      ? ` — ${plural(i.pendingRules, "rule")} waiting for your approval`
      : "";
    headline = i.learned
      ? `Learned ${plural(i.learned, "thing")}${rules}`
      : `Measured ${plural(measured, "post")} — not enough to learn from yet${rules}`;
  }
  const order: StoryStep[] = ["post", "measure", "learn"];
  const at = order.indexOf(current);
  const notes: Record<StoryStep, string> = {
    post: i.posted ? `${plural(i.posted, "post")} live` : "Approve, then post",
    measure: measured
      ? `${plural(measured, "post")} measured${due ? ` · next ${shortDate(due)}` : ""}`
      : due
        ? `Next check ${shortDate(due)}`
        : "After 3 or 6 days",
    learn: i.learned
      ? `${plural(i.learned, "belief")}${i.pendingRules ? ` · ${i.pendingRules} to approve` : ""}`
      : "From your own posts",
  };
  return {
    current,
    headline,
    steps: order.map((key, n) => ({
      key,
      label: key === "post" ? "Post" : key === "measure" ? "Measure" : "Learn",
      note: notes[key],
      state: n < at ? "done" : n === at ? "current" : "upcoming",
    })),
  };
}

export interface Ratio {
  metric: string;
  value: number | null;
  typical: number | null;
  ratio: number | null;
  label: string;
  tone: "up" | "down" | "even" | "unknown";
}
/** value vs the account's typical (median). Unknown never becomes zero. */
export function ratioChip(metric: string, value: number | null, typical: number | null): Ratio {
  const name = metric.replace(/_/g, " ");
  if (value === null)
    return { metric, value, typical, ratio: null, label: `${name}: unknown`, tone: "unknown" };
  if (typical === null || typical <= 0)
    return {
      metric,
      value,
      typical,
      ratio: null,
      label: `${value.toLocaleString()} ${name} · no typical yet`,
      tone: "unknown",
    };
  const ratio = value / typical;
  const rounded = Math.round(ratio * 10) / 10;
  return {
    metric,
    value,
    typical,
    ratio,
    label: `${value.toLocaleString()} ${name} · ${rounded.toFixed(1)}× typical`,
    tone: rounded > 1.05 ? "up" : rounded < 0.95 ? "down" : "even",
  };
}

export interface PostedRow {
  id: string;
  mediaId: string;
  clipId: string;
  title: string;
  /** The clip is not in this library (deleted, or posted elsewhere): the title is a placeholder. */
  untitled: boolean;
  account: string;
  postedAt: number | null;
  /** 0..1 progress through the current measurement window. */
  window: number;
  windowLabel: string;
  measuredAt: number | null;
  chips: Ratio[];
  demo: boolean;
  demoHours: number | null;
  permalink: string | null;
}
export function postedRows(args: {
  publications: Row[];
  snapshots: Row[];
  policies: Row[];
  accounts: Row[];
  clips: Clip[];
  baseline: { name: string; median: number | null }[];
  now: number;
}): PostedRow[] {
  return args.publications
    .map((p): PostedRow => {
      const policy = args.policies.find((x) => x.id === p.policy_id);
      const cadence = num(policy?.cadence_days) ?? 3;
      const posted = time(p.published_at);
      const due = time(p.next_due_at);
      const start = due !== null ? due - cadence * 86400000 : posted;
      const latest = args.snapshots
        .filter((s) => s.publication_id === p.id)
        .sort((a, b) => (time(b.collected_at) ?? 0) - (time(a.collected_at) ?? 0))[0];
      const metrics = obj(latest?.metrics) ?? {};
      const chips = Object.entries(metrics)
        .slice(0, 4)
        .map(([name, v]) =>
          ratioChip(name, num(v), args.baseline.find((b) => b.name === name)?.median ?? null),
        );
      const span = due !== null && start !== null ? due - start : 0;
      const window = span > 0 ? Math.min(1, Math.max(0, (args.now - start!) / span)) : 1;
      const day = Math.min(cadence, Math.max(1, Math.ceil((window * span) / 86400000)));
      const clip = args.clips.find((c) => c.id === p.clip_id);
      const account = args.accounts.find((a) => a.id === p.account_id);
      const override = obj(p.demo_override);
      const demo = latest?.trigger === "demo_override" || (!!override && text(override.due_at) === text(p.next_due_at));
      return {
        id: p.id,
        mediaId: text(p.media_id),
        clipId: text(p.clip_id),
        title: clip?.hook || clip?.name || "Untitled post",
        untitled: !(clip?.hook || clip?.name),
        account: text(account?.display_name) || text(p.account_id) || "Instagram",
        postedAt: posted,
        window,
        windowLabel:
          due === null
            ? "Measurement finished"
            : due <= args.now
              ? "Measuring now"
              : `Day ${day} of ${cadence} · next reading ${shortDate(due)}`,
        measuredAt: time(latest?.collected_at),
        chips,
        demo,
        demoHours: num(latest?.real_elapsed_hours) ?? num(override?.real_elapsed_hours),
        permalink: null,
      };
    })
    .sort((a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0));
}

const VALUE_WORDS: Record<string, Record<string, string>> = {
  hook_style: {
    quote: "quote hooks",
    question: "question hooks",
    number: "number hooks",
    how_to: "how-to hooks",
    statement: "statement hooks",
  },
  duration_bucket: {
    short: "short clips (under 20 s)",
    medium: "medium clips (20–40 s)",
    long: "long clips (over 40 s)",
  },
  opening_type: {
    text_overlay: "a text opening",
    cold_open: "a cold open",
    hook_first: "hook-first openings",
  },
  caption_style: {
    standard: "plain captions",
    high_contrast: "high-contrast captions",
    pop: "word-by-word captions",
  },
  framing: { fit: "full-frame framing", fill: "cropped vertical framing" },
  day_type: { weekday: "weekday posts", weekend: "weekend posts" },
};
/** "hook_style" + "question" → "question hooks". */
export function phrase(variable: string, value: string): string {
  const known = VALUE_WORDS[variable]?.[value];
  if (known) return known;
  const v = value.replace(/_/g, " ");
  if (variable === "moment_type") return `${v} moments`;
  if (variable === "posting_window") return `posting in the ${v} (UTC)`;
  if (variable === "speaker_role") return `clips led by the ${v}`;
  return `${variable.replace(/_/g, " ")}: ${v}`;
}
/** One plain sentence per queued experiment. */
export function experimentSentence(slot: PortfolioSlot, metric: string | null): string {
  const what = phrase(slot.variable, slot.value);
  const m = metric ? metric.replace(/_/g, " ") : "results";
  if (slot.mode === "explore")
    return `Test: try ${what} on the next clip to see whether it beats your typical ${m}.`;
  return slot.direction === "decrease"
    ? `Avoid ${what} on the next clip: so far they have come in under your typical ${m}.`
    : `Keep using ${what} on the next clip: so far they have beaten your typical ${m}.`;
}
/** Collapses identical queue slots: "Test: … on the next 2 clips". */
export function experimentLines(slots: PortfolioSlot[], metric: string | null): string[] {
  const groups = new Map<string, { slot: PortfolioSlot; n: number }>();
  for (const slot of slots) {
    const key = `${slot.mode}|${slot.variable}|${slot.value}|${slot.direction}`;
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { slot, n: 1 });
  }
  return [...groups.values()].map(({ slot, n }) =>
    n > 1
      ? experimentSentence(slot, metric).replace("on the next clip", `on the next ${n} clips`)
      : experimentSentence(slot, metric),
  );
}
