import { post } from "../api";
import type { GuidePage } from "./guideLinks";

export type HelpLink = { url: string; opened: boolean };

export const helpApi = {
  /** The engine opens the page in the system browser and returns the link either way. */
  open: (page: GuidePage = "", anchor = "") => post<HelpLink>("/api/help/open", { page, anchor }),
};
