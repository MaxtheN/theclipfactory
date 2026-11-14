export const groups = [
  { label: "Make", tabs: ["Factory", "Clips", "Footage"] },
  { label: "Grow", tabs: ["Campaigns", "Results", "Instagram"] },
  { label: "Setup", tabs: ["Studio", "Models", "Settings"] },
] as const;
export type Tab = (typeof groups)[number]["tabs"][number];
export const tabs: readonly Tab[] = groups.flatMap((group) => [...group.tabs]);
export const icons: Record<Tab, string> = {
  Factory: "◈",
  Clips: "▣",
  Footage: "▤",
  Campaigns: "▦",
  Results: "↗",
  Instagram: "◎",
  Studio: "✂",
  Models: "⬡",
  Settings: "⚙",
};
export const descriptions: Record<Tab, string> = {
  Factory: "Drop footage in. The factory finds the moments and makes the clips.",
  Clips: "Every clip the factory made. Approve the ones you want to post.",
  Footage: "Your source videos and what the factory saw in each one.",
  Campaigns: "Saved audiences and creative direction for repeat work.",
  Results: "How published clips performed.",
  Instagram: "Connect an account and publish approved clips.",
  Studio: "Manual control: pick a range yourself and inspect each run.",
  Models: "The local models that power the factory.",
  Settings: "Brand, defaults, and what the factory may do on its own.",
};
export const STORAGE_KEY = "clip-factory-tab";
/** Names from before the navigation was regrouped. */
const renamed: Record<string, Tab> = {
  Dashboard: "Factory",
  Library: "Footage",
};
const LAYOUT_KEY = "clip-factory-nav";
const LAYOUT = "2";
export function isTab(value: unknown): value is Tab {
  return typeof value === "string" && (tabs as readonly string[]).includes(value);
}
/**
 * The saved tab, translated from the old layout: there "Factory" was the manual
 * editor, which is now Studio. Reading has no side effects; rememberTab() marks
 * the storage as current so the translation happens once.
 */
export function initialTab(): Tab {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const current = localStorage.getItem(LAYOUT_KEY) === LAYOUT;
    if (saved && Object.hasOwn(renamed, saved)) return renamed[saved];
    if (!current && saved === "Factory") return "Studio";
    return isTab(saved) ? saved : "Factory";
  } catch {
    return "Factory";
  }
}
export function rememberTab(tab: Tab) {
  try {
    localStorage.setItem(STORAGE_KEY, tab);
    localStorage.setItem(LAYOUT_KEY, LAYOUT);
  } catch {
    /* UI preferences are optional. */
  }
}
