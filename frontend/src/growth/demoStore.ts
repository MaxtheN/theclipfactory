import type { LearningDemoPlan } from "./LearningLoopDemo";

/** The learning-loop demo's outcome, kept apart from real account history (this browser only). */
export type DemoResult = {
  plan: LearningDemoPlan;
  after: null | { clip_id: string; media_url: string; hook?: string };
  ran_at: string;
};

const key = (profileId: string) => `growth-learning-demo-v1:${profileId}`;

export function loadDemoResult(profileId: string): DemoResult | null {
  try {
    const raw = localStorage.getItem(key(profileId));
    const parsed = raw ? (JSON.parse(raw) as DemoResult) : null;
    return parsed?.plan?.recut?.after_hook ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDemoResult(profileId: string, result: DemoResult) {
  try {
    localStorage.setItem(key(profileId), JSON.stringify(result));
  } catch {
    /* The demo still plays; Results just will not remember it. */
  }
}

export function clearDemoResult(profileId: string) {
  try {
    localStorage.removeItem(key(profileId));
  } catch {
    /* nothing to clear */
  }
}
