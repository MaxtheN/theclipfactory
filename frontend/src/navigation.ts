/** The local setup screens kept beside the Growth Factory shell. */
export const tabs = ["Models", "Settings"] as const;
export type Tab = (typeof tabs)[number];
/** Names in the Growth Factory icon set (growth/Icon.tsx). */
export const icons: Record<Tab, string> = {
  Models: "spark",
  Settings: "settings",
};
export const descriptions: Record<Tab, string> = {
  Models: "The local models that power the factory.",
  Settings: "Brand, defaults, and what the factory may do on its own.",
};
export const STORAGE_KEY = "clip-factory-tab";
export function isTab(value: unknown): value is Tab {
  return typeof value === "string" && (tabs as readonly string[]).includes(value);
}
/** The saved tab. A saved name of a screen that no longer exists here opens Models. */
export function initialTab(): Tab {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isTab(saved) ? saved : "Models";
  } catch {
    return "Models";
  }
}
export function rememberTab(tab: Tab) {
  try {
    localStorage.setItem(STORAGE_KEY, tab);
  } catch {
    /* UI preferences are optional. */
  }
}
