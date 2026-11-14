import { api, post } from "../api";

/** "Give us your website — we'll draft your brand brief": client + pure draft → onboarding mapping. */

export type ResearchStage =
  | "opening"
  | "reading"
  | "found"
  | "voice"
  | "drafting"
  | "done"
  | "failed";

export interface ResearchEvent {
  stage: ResearchStage;
  label: string;
  at: number;
  host?: string;
  page?: { url: string; label: string; title: string };
  count?: number;
  labels?: string[];
  repair?: boolean;
}

export interface DraftEvidence {
  field: string;
  quote: string;
  page_url: string;
}

export interface BrandDraft {
  brand_name: string;
  one_liner: string;
  audience: string;
  voice: { adjectives: string[]; do: string; dont: string } | null;
  must_avoid: string[];
  key_messages: string[];
  topics: string[];
  suggested_goal: { objective: string; metric: string } | null;
  cta: { text: string; link: string | null } | null;
  brand_kit: {
    primary_color: string | null;
    accent_color: string | null;
    logo_url: string | null;
    sources?: Record<string, string>;
  };
  social: Array<{ network: string; url: string }>;
  evidence: DraftEvidence[];
  dropped: string[];
  pages: Array<{ url: string; label: string; title: string }>;
  source_url: string;
}

export interface Research {
  id: string;
  url: string;
  status: "running" | "done" | "failed" | "cancelled";
  stage: ResearchStage;
  progress: number;
  events: ResearchEvent[];
  draft: BrandDraft | null;
  error: string | null;
  error_kind: "fetch" | "held" | "abstain" | "model" | "cancelled" | null;
  waiting: boolean;
  timings: Record<string, number>;
}

export const websiteBriefApi = {
  start: (url: string) => post<Research>("/api/brand-research", { url }),
  get: (id: string) =>
    api<Research>(`/api/brand-research/${encodeURIComponent(id)}`),
  cancel: (id: string) =>
    post<Research>(`/api/brand-research/${encodeURIComponent(id)}/cancel`),
};
export type WebsiteBriefApi = typeof websiteBriefApi;

/** What the creator edits on the review screen. Lists are one item per line. */
export interface EditableBrief {
  brandName: string;
  oneLiner: string;
  audience: string;
  objective: string;
  metric: string;
  adjectives: string;
  voiceDo: string;
  voiceDont: string;
  keyMessages: string;
  topics: string;
  mustAvoid: string;
  ctaText: string;
  ctaLink: string;
}

/** Filled into onboarding (brand, audience, goal, voice & boundaries) and the first campaign brief. */
export interface WebsiteBriefResult {
  name: string;
  audience: string;
  objective: string;
  metric: string;
  /** Creative direction: tone and the do line. */
  voice: string;
  /** Voice & boundary lines for the workspace (one per line). */
  boundaries: string[];
  brief: {
    key_messages: string[];
    must_include: string[];
    must_avoid: string[];
    cta: string;
    cta_link: string | null;
    tone: string;
    context: string;
  };
  brandKit: BrandDraft["brand_kit"] | null;
  sourceUrl: string;
}

export const GOALS: Array<{ objective: string; label: string; metric: string }> =
  [
    { objective: "awareness", label: "Reach new people", metric: "reach" },
    {
      objective: "traffic",
      label: "Drive full-episode visits",
      metric: "full_episode_visits",
    },
    {
      objective: "leads",
      label: "Generate qualified leads",
      metric: "qualified_leads",
    },
    { objective: "engagement", label: "Grow engagement", metric: "engagement_rate" },
    { objective: "followers", label: "Grow followers", metric: "follower_growth" },
    { objective: "sales", label: "Drive sales", metric: "sales" },
    { objective: "discovery", label: "Explore first · Discovery", metric: "" },
  ];

export function editableFrom(draft: BrandDraft): EditableBrief {
  return {
    brandName: draft.brand_name || "",
    oneLiner: draft.one_liner || "",
    audience: draft.audience || "",
    objective: draft.suggested_goal?.objective || "discovery",
    metric: draft.suggested_goal?.metric || "",
    adjectives: (draft.voice?.adjectives || []).join(", "),
    voiceDo: draft.voice?.do || "",
    voiceDont: draft.voice?.dont || "",
    keyMessages: (draft.key_messages || []).join("\n"),
    topics: (draft.topics || []).join("\n"),
    mustAvoid: (draft.must_avoid || []).join("\n"),
    ctaText: draft.cta?.text || "",
    ctaLink: draft.cta?.link || "",
  };
}

const clip = (value: string, max: number) => value.trim().slice(0, max).trim();

/** One item per line, trimmed, clipped, de-duplicated (case-insensitive), capped. */
export function lines(value: string, max: number, each: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split("\n")) {
    const item = clip(raw.replace(/^[-•*]\s*/, ""), each);
    const key = item.toLocaleLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length === max) break;
  }
  return out;
}

/** Map the edited draft to onboarding fields and a valid campaign brief (backend Brief limits). */
export function briefFromDraft(
  edited: EditableBrief,
  draft?: BrandDraft | null,
): WebsiteBriefResult {
  const mustAvoid = lines(edited.mustAvoid, 8, 120);
  const avoided = new Set(mustAvoid.map((v) => v.toLocaleLowerCase()));
  // A topic cannot be both must-include and must-avoid; the boundary wins.
  const topics = lines(edited.topics, 8, 120).filter(
    (t) => !avoided.has(t.toLocaleLowerCase()),
  );
  const adjectives = lines(edited.adjectives.replace(/,/g, "\n"), 5, 40);
  const tone = clip(adjectives.join(", "), 300);
  const cta = clip(edited.ctaText, 80);
  const link = edited.ctaLink.trim();
  const objective = GOALS.some((g) => g.objective === edited.objective)
    ? edited.objective
    : "discovery";
  const voiceDo = clip(edited.voiceDo, 240);
  const voiceDont = clip(edited.voiceDont, 240);
  const boundaries = [
    voiceDo && `Do: ${voiceDo}`,
    voiceDont && `Don't: ${voiceDont}`,
    ...mustAvoid.map((item) => `Avoid: ${item}`),
  ].filter(Boolean) as string[];
  return {
    name: clip(edited.brandName, 200),
    audience: clip(edited.audience, 3000),
    objective,
    metric: objective === "discovery" ? "" : clip(edited.metric, 200),
    voice: [tone && `${tone[0].toUpperCase()}${tone.slice(1)}.`, voiceDo]
      .filter(Boolean)
      .join(" ")
      .slice(0, 4000),
    boundaries,
    brief: {
      key_messages: lines(edited.keyMessages, 5, 160),
      must_include: topics,
      must_avoid: mustAvoid,
      cta,
      cta_link: cta && /^https:\/\/\S+$/i.test(link) ? link.slice(0, 500) : null,
      tone,
      context: clip(edited.oneLiner, 1500),
    },
    brandKit: draft?.brand_kit ?? null,
    sourceUrl: draft?.source_url ?? "",
  };
}

/** Friendly, present-tense copy for a real stage event. */
export function statusLine(event: ResearchEvent, host: string): string {
  switch (event.stage) {
    case "opening":
      return `Opening ${event.host || host}…`;
    case "reading":
      return `Reading ${event.page?.label === "Home" ? `'${event.page.title || host}'` : `'${event.page?.label || "a page"}'`}…`;
    case "found":
      return `Found ${event.count ?? 1} page${event.count === 1 ? "" : "s"}`;
    case "voice":
      return "Listening for your voice…";
    case "drafting":
      return event.repair ? "Tidying up the draft…" : "Drafting your brief…";
    case "done":
      return "Your draft is ready";
    default:
      return event.label;
  }
}
