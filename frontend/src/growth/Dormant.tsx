import { memo, useState, type ReactNode } from "react";

/**
 * Destinations stay mounted while hidden so their Unsaved Drafts, filters and scroll survive. A
 * hidden destination does not need to follow every poll, though: inside Dormant it skips
 * re-rendering until it is shown again, when it renders once with the latest data. It still
 * renders on the way out (so it sees its own `active` flag turn off) and whenever its scope (the
 * brand and campaign it belongs to) changes, so keyed remounts happen at once.
 *
 * A destination is first mounted when it is first shown: one nobody has opened has nothing to
 * keep, and building every screen up front made launch slow.
 */
export const Dormant = memo(
  function Dormant({ active, children }: { active: boolean; scope: string | number; children: ReactNode }) {
    const [opened, setOpened] = useState(active);
    if (active && !opened) setOpened(true);
    return opened || active ? <>{children}</> : null;
  },
  (prev, next) => !prev.active && !next.active && prev.scope === next.scope,
);
