import type { Clip, ClipRank } from "../types";

/** A rank record as the swarm stored it, or undefined for unranked (older or team) clips. */
export function rankOf(clip: Pick<Clip, "rank">): ClipRank | undefined {
  const rank = clip.rank;
  return rank && typeof rank === "object" && typeof rank.score === "number" ? rank : undefined;
}

export function belowBar(clip: Pick<Clip, "rank" | "approved">): boolean {
  // An approved clip is always shown, whatever its score said.
  return !clip.approved && rankOf(clip)?.below_bar === true;
}

/**
 * The review list, best first: ranked clips by their position, then unranked clips in their
 * original order. Clips under the quality floor are returned separately (hidden by default),
 * never dropped.
 */
export function reviewOrder<T extends Clip>(clips: T[]): { above: T[]; below: T[] } {
  const indexed = clips.map((clip, index) => ({ clip, index }));
  const key = ({ clip, index }: { clip: T; index: number }) => {
    const rank = rankOf(clip);
    return rank && typeof rank.position === "number" ? [0, rank.position, index] : rank ? [1, -rank.score, index] : [2, 0, index];
  };
  const sorted = indexed.sort((a, b) => {
    const x = key(a), y = key(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }).map(item => item.clip);
  return { above: sorted.filter(c => !belowBar(c)), below: sorted.filter(belowBar) };
}
