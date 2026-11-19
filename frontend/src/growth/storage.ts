import { api, endpoint, remove } from "../api";
import type { Clip } from "../types";

export interface Discarded {
  discarded: number;
  kept: number;
  /** Why the first kept clip could not be deleted, in the local service's words. */
  reason: string;
  /** Every clip that was not deleted, with the local service's reason. */
  failed: { clip: Clip; reason: string }[];
}

/**
 * Ids of clip versions that were exported. The local service keeps those when asked to delete
 * them, so a delete question can say so up front. Undefined when the history cannot be read.
 */
export async function exportedClipIds(): Promise<Set<string> | undefined> {
  try {
    const rows: unknown = await api("/api/exports");
    if (!Array.isArray(rows)) return undefined;
    return new Set(
      rows
        .map((row) => (row && typeof row === "object" ? (row as { clip_id?: unknown }).clip_id : undefined))
        .filter((id): id is string => typeof id === "string"),
    );
  } catch {
    return undefined;
  }
}

const parentOf = (clip: Clip) =>
  (clip as { parent_clip_id?: unknown }).parent_clip_id;

/**
 * Deletes clip files to free space on this Mac. The local service keeps a version that was
 * exported or that a later revision builds on; those are counted, and the rest still go.
 */
export async function discardClips(clips: Clip[]): Promise<Discarded> {
  const result: Discarded = { discarded: 0, kept: 0, reason: "", failed: [] };
  // Revisions go before the versions they build on, or the service would refuse the parent.
  let rest = [...clips];
  while (rest.length) {
    const parents = new Set(rest.map(parentOf));
    const leaves = rest.filter((clip) => !parents.has(clip.id));
    if (!leaves.length) {
      const reason = "Later revisions build on this version.";
      result.kept += rest.length;
      result.reason ||= reason;
      result.failed.push(...rest.map((clip) => ({ clip, reason })));
      break;
    }
    for (const clip of leaves) {
      try {
        await remove(endpoint("clips", clip.id));
        result.discarded += 1;
      } catch (e) {
        const reason = e instanceof Error ? e.message : "The local service refused.";
        result.kept += 1;
        result.reason ||= reason;
        result.failed.push({ clip, reason });
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
