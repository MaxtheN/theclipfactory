import type { LibraryView } from "./FactoryHome";

/** What Library restores when the creator comes back to it: filters, view and scroll. */
export type LibrarySnapshot = {
  view?: LibraryView;
  query: string;
  olderTests: boolean;
  filter: string;
  hypothesis: string;
  scrollTop: number;
};

export type LibraryViewStore = {
  get(key: string): LibrarySnapshot;
  patch(key: string, part: Partial<LibrarySnapshot>): void;
};

const EMPTY: LibrarySnapshot = { query: "", olderTests: false, filter: "All clips", hypothesis: "", scrollTop: 0 };

/**
 * Library view state held above the Library stage, keyed by campaign, so it survives both a trip
 * to another destination and a campaign switch. Memory only: a relaunch starts fresh.
 */
export function createLibraryViewStore(): LibraryViewStore {
  const saved = new Map<string, LibrarySnapshot>();
  return {
    get: (key) => saved.get(key) ?? EMPTY,
    patch: (key, part) => saved.set(key, { ...(saved.get(key) ?? EMPTY), ...part }),
  };
}
