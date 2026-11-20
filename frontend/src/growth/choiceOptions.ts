// Presets for pill pickers. Short, common answers so people choose instead of type;
// "Add your own" covers everything else.

export const AUDIENCE = [
  "Founders",
  "Builders and engineers",
  "Investors",
  "Marketers",
  "Creators",
  "Product managers",
  "Executives",
  "Small business owners",
  "Students",
  "Curious listeners",
] as const;

export const TONE = [
  "Dry and specific",
  "Warm",
  "Energetic",
  "Bold",
  "Playful",
  "Calm",
  "Authoritative",
  "No hype",
] as const;

/** Stored as the metric keys the factory already uses. */
export const METRIC_LABELS: Readonly<Record<string, string>> = {
  reach: "Reach",
  views: "Views",
  full_episode_visits: "Full-episode visits",
  engagement_rate: "Engagement rate",
  follower_growth: "Follower growth",
  qualified_leads: "Qualified leads",
  link_clicks: "Link clicks",
  shares: "Shares",
  saves: "Saves",
  sales: "Sales",
};
export const METRIC = Object.keys(METRIC_LABELS);

export const CTA = [
  "Listen to the full episode",
  "Follow for more",
  "Subscribe",
  "Link in bio",
  "Join the newsletter",
  "Book a demo",
  "Comment your take",
] as const;

/** Rules every edit should respect (one per line). */
export const EDIT_RULES = [
  "Never cut mid-sentence",
  "Keep the speaker's context",
  "No misleading claims",
  "No clickbait",
  "No profanity",
  "Credit the guest",
  "No medical or financial advice",
] as const;

export const MUST_AVOID = [
  "Politics",
  "Market predictions",
  "Medical advice",
  "Profanity",
  "Competitor names",
  "Unverified claims",
  "Personal details",
] as const;

export const MUST_INCLUDE = [
  "The guest's name",
  "The show name",
  "A clear takeaway",
  "The call to action",
] as const;

/** Creative direction for the editing agents. */
export const CREATIVE_NOTES = [
  "Lead with a clear claim",
  "Open on a question",
  "Favour stories over opinions",
  "End on a payoff",
  "Keep context intact",
  "Keep it under 40 seconds",
  "Fast cuts",
  "Let moments breathe",
] as const;

export const LOOK_FOR = [
  "Strong opinions",
  "Surprising facts",
  "Personal stories",
  "Practical advice",
  "Funny moments",
  "Emotional moments",
  "Hot takes",
] as const;

export const CLIP_FEEDBACK = [
  "Stronger hook",
  "Shorter",
  "Longer",
  "Different moment",
  "More context",
  "End sooner",
  "Cut the pauses",
  "Bigger captions",
  "Fewer captions",
  "Better framing",
] as const;

export const LEARN = [
  "Does a question hook beat a statement?",
  "Do shorter clips finish more?",
  "Do captions help?",
  "Does a cold open work?",
  "Which topics travel?",
] as const;

export const NEXT_EDIT = [
  "Open on the claim",
  "Cut to under 30 seconds",
  "Add a cold open",
  "New hook text",
  "Tighter pauses",
  "Bigger captions",
] as const;

export const ANGLE = [
  "Put the point before the context",
  "Contrarian take",
  "Personal story",
  "How-to",
  "Numbers first",
  "Myth vs fact",
] as const;

export const WHY_TRY = [
  "Similar clips performed well",
  "We haven't tested it yet",
  "The audience asked for it",
  "It fits the goal",
] as const;

export const OVERRIDE_REASON = [
  "I reviewed it myself",
  "The score misread the clip",
  "It's time-sensitive",
  "Approved by the brand",
] as const;
