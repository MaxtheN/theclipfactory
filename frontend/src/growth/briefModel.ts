import type { CampaignBrief } from "../types";

/** Limits mirror clip_factory/brief.py so the form rejects what the service would. */
export const BRIEF_LIMITS = {
  messages: 5,
  message: 160,
  topics: 8,
  topic: 120,
  cta: 80,
  link: 500,
  tone: 300,
  references: 5,
  note: 160,
  context: 1500,
  audience: 4000,
} as const;

export type FullBrief = Required<Omit<CampaignBrief, "cta_link">> & {
  cta_link: string | null;
};

export const emptyBrief = (): FullBrief => ({
  audience: "",
  key_messages: [],
  cta: "",
  cta_link: null,
  must_include: [],
  must_avoid: [],
  tone: "",
  references: [],
  deliverables: {
    clip_count: null,
    max_duration_seconds: null,
    platforms: ["instagram_reels"],
  },
  context: "",
  measurement_intent: "",
  constraints: [],
  requested_outputs: [],
});

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Every field present, in the service's order, from any saved shape (older briefs included). */
export function normalizeBrief(raw: Partial<CampaignBrief> | null | undefined): FullBrief {
  const base = emptyBrief();
  if (!raw || typeof raw !== "object") return base;
  const deliverables = (raw.deliverables || {}) as Partial<FullBrief["deliverables"]>;
  return {
    audience: text(raw.audience),
    key_messages: strings(raw.key_messages),
    cta: text(raw.cta),
    cta_link: text(raw.cta_link) || null,
    must_include: strings(raw.must_include),
    must_avoid: strings(raw.must_avoid),
    tone: text(raw.tone),
    references: Array.isArray(raw.references)
      ? raw.references
          .filter((r) => r && typeof r.url === "string")
          .map((r) => ({ url: r.url, note: text(r.note) }))
      : [],
    deliverables: {
      clip_count: count(deliverables.clip_count),
      max_duration_seconds: count(deliverables.max_duration_seconds),
      platforms: ["instagram_reels"],
    },
    context: text(raw.context),
    measurement_intent: text(raw.measurement_intent),
    constraints: strings(raw.constraints),
    requested_outputs: strings(raw.requested_outputs),
  };
}

export const sameBrief = (a: Partial<CampaignBrief> | undefined, b: Partial<CampaignBrief> | undefined) =>
  JSON.stringify(normalizeBrief(a)) === JSON.stringify(normalizeBrief(b));

const httpLink = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
};

function chips(values: string[], what: string, max: number, length: number): string | null {
  if (values.length > max) return `Use up to ${max} ${what}.`;
  if (values.some((v) => !v.trim())) return `${what[0].toUpperCase()}${what.slice(1)} can't be blank.`;
  if (values.some((v) => v.length > length)) return `Keep each of the ${what} within ${length} characters.`;
  if (new Set(values.map((v) => v.trim().toLowerCase())).size !== values.length) return `Remove repeated ${what}.`;
  return null;
}

/** The first problem a person should fix, or null when the service will accept the brief. */
export function briefProblem(brief: FullBrief): string | null {
  const L = BRIEF_LIMITS;
  const problem =
    chips(brief.key_messages, "key messages", L.messages, L.message) ||
    chips(brief.must_include, "must-include topics", L.topics, L.topic) ||
    chips(brief.must_avoid, "must-avoid topics", L.topics, L.topic);
  if (problem) return problem;
  const avoid = new Set(brief.must_avoid.map((v) => v.trim().toLowerCase()));
  if (brief.must_include.some((v) => avoid.has(v.trim().toLowerCase())))
    return "A topic can't be both must-include and must-avoid.";
  if (brief.cta.length > L.cta) return `Keep the call to action within ${L.cta} characters.`;
  if (brief.cta_link && !brief.cta.trim()) return "Add call-to-action text for the link.";
  if (brief.cta_link && (brief.cta_link.length > L.link || !httpLink(brief.cta_link)))
    return "Use a full https:// link for the call to action.";
  if (brief.tone.length > L.tone) return `Keep tone notes within ${L.tone} characters.`;
  if (brief.context.length > L.context) return `Keep context within ${L.context.toLocaleString()} characters.`;
  if (brief.audience.length > L.audience) return "Keep the target audience within 4,000 characters.";
  if (brief.references.length > L.references) return `Use up to ${L.references} references.`;
  if (brief.references.some((r) => !httpLink(r.url) || r.url.length > L.link))
    return "Each reference needs a full https:// link.";
  if (brief.references.some((r) => r.note.length > L.note)) return `Keep reference notes within ${L.note} characters.`;
  const { clip_count, max_duration_seconds } = brief.deliverables;
  if (clip_count !== null && (!Number.isInteger(clip_count) || clip_count < 1 || clip_count > 50))
    return "Choose between 1 and 50 clips.";
  if (max_duration_seconds !== null && (max_duration_seconds < 5 || max_duration_seconds > 180))
    return "Choose a maximum length between 5 and 180 seconds.";
  return null;
}

/** The request body: trimmed text, nothing the service would reject as blank. */
export function briefBody(brief: FullBrief): FullBrief {
  const trim = (values: string[]) => values.map((v) => v.trim());
  return {
    ...brief,
    audience: brief.audience.trim(),
    key_messages: trim(brief.key_messages),
    cta: brief.cta.trim(),
    cta_link: brief.cta_link?.trim() || null,
    must_include: trim(brief.must_include),
    must_avoid: trim(brief.must_avoid),
    tone: brief.tone.trim(),
    references: brief.references.map((r) => ({ url: r.url.trim(), note: r.note.trim() })),
    context: brief.context.trim(),
  };
}

const VERB: Record<string, string> = {
  awareness: "reach",
  engagement: "grow",
  followers: "grow followers",
  traffic: "drive",
  leads: "generate",
  sales: "drive",
  custom: "",
};
const FALLBACK: Record<string, string> = {
  discovery: "explore and learn",
  awareness: "reach new people",
  engagement: "deepen engagement",
  followers: "grow followers",
  traffic: "drive visits",
  leads: "generate leads",
  sales: "drive sales",
  custom: "custom goal",
};

/** "Goal: drive full-episode visits · CTA: Listen to the full episode · Avoid: market predictions". */
export function briefSummary(
  brief: Partial<CampaignBrief> | undefined,
  objective = "discovery",
  metric?: string | null,
): string {
  const b = normalizeBrief(brief);
  const metricText = (metric || "").replace(/_/g, " ").trim();
  const goal =
    objective !== "discovery" && metricText && objective !== "followers"
      ? `${VERB[objective] ?? ""} ${metricText}`.trim()
      : (FALLBACK[objective] ?? objective);
  const parts = [`Goal: ${goal}`];
  if (b.cta) parts.push(`CTA: ${b.cta}`);
  if (b.must_avoid.length) parts.push(`Avoid: ${b.must_avoid.slice(0, 3).join(", ")}`);
  else if (b.key_messages.length) parts.push(`Message: ${b.key_messages[0]}`);
  return parts.join(" · ");
}
