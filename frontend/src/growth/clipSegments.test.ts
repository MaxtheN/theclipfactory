import { describe, expect, it } from "vitest";
import { parseProductionClip } from "./productionContracts";

describe("clip source segments", () => {
  it("accepts the hook-first teaser segment the renderer records", () => {
    const clip = {
      id: "c1",
      video_id: "v1",
      path: "clips/c1.mp4",
      name: "Clip 1",
      start: 196.42,
      end: 226.19,
      hook: "Why now? Why at all?",
      caption: "Why now?",
      objective: "traffic",
      approved: false,
      source_segments: [
        { role: "teaser", start: 215.98, end: 218.78 },
        { role: "main", start: 196.42, end: 218.82 },
        { role: "main", start: 219.39, end: 226.19 },
      ],
    };
    expect(() => parseProductionClip(clip as never)).not.toThrow();
  });

  it("still rejects an unknown segment role", () => {
    const clip = {
      id: "c1",
      video_id: "v1",
      path: "clips/c1.mp4",
      name: "Clip 1",
      start: 196.42,
      end: 226.19,
      hook: "Why now? Why at all?",
      caption: "Why now?",
      objective: "traffic",
      approved: false,
      source_segments: [{ role: "mystery", start: 0, end: 1 }],
    };
    expect(() => parseProductionClip(clip as never)).toThrow(/source segments/);
  });
});
