import { endpoint, remove } from "../api";
import type { Clip } from "../types";

export interface Discarded {
  discarded: number;
  kept: number;
  /** Why the first kept clip could not be deleted, in the local service's words. */
  reason: string;
}

const parentOf = (clip: Clip) =>
  (clip as { parent_clip_id?: unknown }).parent_clip_id;

/**
 * Deletes clip files to free space on this Mac. The local service keeps a version that was
 * exported or that a later revision builds on; those are counted, and the rest still go.
 */
export async function discardClips(clips: Clip[]): Promise<Discarded> {
  const result: Discarded = { discarded: 0, kept: 0, reason: "" };
  // Revisions go before the versions they build on, or the service would refuse the parent.
  let rest = [...clips];
  while (rest.length) {
    const parents = new Set(rest.map(parentOf));
    const leaves = rest.filter((clip) => !parents.has(clip.id));
    if (!leaves.length) {
      result.kept += rest.length;
      break;
    }
    for (const clip of leaves) {
      try {
        await remove(endpoint("clips", clip.id));
        result.discarded += 1;
      } catch (e) {
        result.kept += 1;
        result.reason ||=
          e instanceof Error ? e.message : "The local service refused.";
      }
    }
    rest = rest.filter((clip) => parents.has(clip.id));
  }
  return result;
}

/** Deletes a source and everything made from it. The footage stays if any of its clips must be kept. */
export async function deleteEpisode(videoId: string, clips: Clip[]) {
  const result = await discardClips(clips);
  if (result.kept) return { ...result, deleted: false };
  await remove(endpoint("videos", videoId));
  return { ...result, deleted: true };
}
