/**
 * User-guide links with no API dependency (previewApi imports this; importing ../api here would
 * deadlock tests that build the ../api mock from previewApi).
 */

/** Pages of the user guide (docs/guide/*.md, rendered on the website under /guide/). "" is the index. */
export type GuidePage =
  | ""
  | "getting-started"
  | "factory"
  | "factory-map"
  | "library"
  | "studio"
  | "results"
  | "references"
  | "brand-profile"
  | "posting"
  | "models"
  | "settings-privacy"
  | "plans"
  | "faq"
  | "self-hosting";

export const GUIDE_URL = "https://growth-factory-landing.vercel.app/guide/";
export const HELP_EVENT = "gf-help";

export function guideLink(page: GuidePage | string = "", anchor = "") {
  return `${GUIDE_URL}${page}${anchor ? `#${anchor}` : ""}`;
}

/** Ask the sidebar Help control to open a guide page (used by ⌘K and in-context links). */
export function requestHelp(page: GuidePage = "", anchor = "") {
  window.dispatchEvent(new CustomEvent(HELP_EVENT, { detail: { page, anchor } }));
}
