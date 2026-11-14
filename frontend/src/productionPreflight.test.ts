import { describe, expect, it } from "vitest";
import { hasTranscript, jobContextId, sourceHasTranscript } from "./productionPreflight";

describe("source-aware production preflight", () => {
  it("reads unknown job context safely and treats empty transcript artifacts as unavailable", () => {
    for (const context of [null, [], "v1", { video_id: { bad: "v1" } }, { video_id: 1 }])
      expect(
        jobContextId({ id: "j", kind: "team", status: "queued", context }, "video_id"),
      ).toBeUndefined();
    expect(hasTranscript({})).toBe(false);
    expect(hasTranscript({ segments: [] })).toBe(true);
  });
  it("reads slim transcripts and prefers the explicit transcript flag", () => {
    expect(sourceHasTranscript({ has_transcript: true, transcript: null })).toBe(true);
    expect(sourceHasTranscript({ has_transcript: false, transcript: { text: "old" } })).toBe(false);
    expect(sourceHasTranscript({ transcript: { language: "en", text: "Hi", segment_count: 1 } })).toBe(true);
    expect(sourceHasTranscript({ transcript: null })).toBe(false);
  });
});
