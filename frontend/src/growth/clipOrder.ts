import type { Clip } from "../types";

export function newestFirst(clips: Clip[]) {
  return [...clips].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}
