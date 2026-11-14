import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clipMediaUrl,
  exportManifestUrl,
  exportMediaUrl,
  productionApi,
} from "./productionApi";
import {
  parseExportRecord,
  parseProductionClip,
  parseProductionJob,
  parseTechnicalChecks,
  type CampaignRenderRequest,
  type ProductionClip,
  type TechnicalChecks,
} from "./productionContracts";

const at = "2026-11-14T10:00:00.000Z";
const sha = "a".repeat(64);
const clip = (changes: Partial<ProductionClip> = {}): ProductionClip => ({
  id: "clip-1",
  video_id: "video-1",
  name: "Claim first",
  start: 2,
  end: 32,
  hook: "Claim first",
  caption: "Post copy",
  objective: "discovery",
  approved: false,
  campaign_id: "campaign-1",
  profile_id: "profile-1",
  strategy_version_id: "strategy-1",
  ...changes,
});
const job = (changes: Record<string, unknown> = {}) => ({
  id: "job-1",
  kind: "render",
  status: "queued",
  progress: 0,
  result: null,
  context: {
    video_id: "video-1",
    campaign_id: "campaign-1",
    profile_id: "profile-1",
  },
  ...changes,
});
const checks = (): TechnicalChecks => ({
  checked_at: at,
  playback_format: [
    { id: "decode", label: "Full decode", status: "pass", detail: "Decoded" },
  ],
  captions: [
    {
      id: "source",
      label: "Transcript captions",
      status: "warn",
      detail: "No cue in this range",
    },
  ],
  playback_format_passed: true,
  caption_issues: ["source"],
  boundary_tolerance_seconds: 0.0333,
});
const exportRecord = (changes: Record<string, unknown> = {}) => ({
  id: "export-1",
  clip_id: "clip-1",
  video_id: "video-1",
  campaign_id: "campaign-1",
  profile_id: "profile-1",
  revision_number: 2,
  sha256: sha,
  bytes: 100,
  file: "claim-first-r2-clip-1.mp4",
  location: "/local/exports/export-1",
  checksum_recorded_at_render: true,
  created_at: at,
  manifest: {
    schema: "clip-factory/export-manifest@1",
    export_id: "export-1",
    video: { file: "claim-first-r2-clip-1.mp4", sha256: sha, bytes: 100 },
    clip: { id: "clip-1", revision_number: 2 },
    review: { state: "approved", approved_at: at },
    source: { video_id: "video-1" },
    strategy: {
      campaign_id: "campaign-1",
      profile_id: "profile-1",
      strategy_version_id: "strategy-1",
    },
  },
  ...changes,
});
const agentEnvelope = () => ({
  job: job({
    kind: "team",
    context: { video_id: "video-1", team_run_id: "run-1" },
  }),
  run: {
    id: "run-1",
    video_id: "video-1",
    job_id: "job-1",
    mode: "team",
    model_id: "ollama:qwen3-vl:8b",
    objective: "discovery",
    status: "queued",
    revision_budget: 2,
    revision_count: 0,
    stop_reason: null,
    created_at: at,
    started_at: null,
    finished_at: null,
    elapsed_seconds: null,
    resource_observations: {},
    clip_ids: [],
    plan: null,
    context: {
      campaign_snapshot: {
        campaign_id: "campaign-1",
        profile_id: "profile-1",
        video_id: "video-1",
        strategy_version_id: "strategy-1",
      },
    },
    permissions: { publish: false, ads: false },
    tasks: [],
  },
});
function respond(value: unknown, status = 200) {
  const fetch = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(value), { status })),
    );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe("production request boundary", () => {
  it("sends the complete campaign edit/lineage/retry body exactly once with session cookies", async () => {
    const fetch = respond(job());
    const body: CampaignRenderRequest = {
      expected_strategy_version_id: "strategy-1",
      video_id: "video-1",
      profile_id: "profile-1",
      start: 2,
      end: 32,
      hook: "Post hook",
      caption: "Post copy",
      subtitles: true,
      mode: "direct",
      instructions: "Creator-selected source.",
      opening_treatment: "cold_open",
      cold_open_start: 0.5,
      cold_open_end: 1.5,
      focus_x: 0.8,
      changed_variable: "opening_treatment",
      parent_clip_id: "parent-1",
      change_reason: "Try a real cold open",
      retry_of_job_id: "failed-1",
    };
    expect(
      (await productionApi.campaignRender("campaign-1", body)).status,
    ).toBe("queued");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/campaigns/campaign-1/render");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
    expect(fetch.mock.calls[0][1].credentials).toBe("same-origin");
    expect(fetch.mock.calls[0][1].headers.has("X-Clip-Token")).toBe(false);
  });
  it("encodes resource IDs into same-origin paths and never treats locations as media URLs", async () => {
    const fetch = respond(
      job({
        context: {
          campaign_id: "campaign/with?query",
          video_id: "video-1",
          profile_id: "profile-1",
        },
      }),
    );
    await productionApi.campaignRender("campaign/with?query", {
      video_id: "video-1",
      profile_id: "profile-1",
      start: 0,
      end: 1,
    });
    // Request scope is verified when a server context supplies a campaign ID.
    expect(fetch.mock.calls[0][0]).toBe(
      "/api/campaigns/campaign%2Fwith%3Fquery/render",
    );
  });
  it("returns native media/manifest URLs with exact encoded IDs", () => {
    expect(clipMediaUrl("clip/a?b")).toBe("/api/clips/clip%2Fa%3Fb/media");
    expect(exportMediaUrl("export/a#b")).toBe(
      "/api/exports/export%2Fa%23b/download",
    );
    expect(exportManifestUrl("export/a")).toBe(
      "/api/exports/export%2Fa/manifest",
    );
    expect(() => exportMediaUrl("..")).toThrow("valid saved resource");
    expect(() => exportMediaUrl("")).toThrow("valid saved resource");
  });
  it("rejects impossible cold opens and unexplained revisions before any request", async () => {
    const fetch = respond(job());
    const base = {
      video_id: "video-1",
      profile_id: "profile-1",
      start: 0,
      end: 30,
    };
    await expect(
      productionApi.campaignRender("campaign-1", {
        ...base,
        opening_treatment: "cold_open",
        cold_open_start: 0,
        cold_open_end: 0.2,
      }),
    ).rejects.toThrow("0.5 and 10");
    await expect(
      productionApi.campaignRender("campaign-1", {
        ...base,
        parent_clip_id: "parent-1",
      }),
    ).rejects.toThrow("Describe the requested change");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects wrong returned job scope and malformed/unknown job status", async () => {
    respond(job({ context: { video_id: "another-video" } }));
    await expect(
      productionApi.campaignRender("campaign-1", {
        video_id: "video-1",
        profile_id: "profile-1",
        end: 2,
      }),
    ).rejects.toThrow("video_id");
    expect(() => parseProductionJob(job({ status: "succeeded" }))).toThrow(
      "Invalid production-job",
    );
    expect(() =>
      parseProductionJob(job({ status: "completed", result: {} })),
    ).toThrow("no clip identity");
  });
  it("requires a Job for deterministic render and a job/run envelope for agent production", async () => {
    respond(agentEnvelope());
    await expect(
      productionApi.campaignRender("campaign-1", {
        video_id: "video-1",
        profile_id: "profile-1",
        end: 2,
      }),
    ).rejects.toThrow("production-job");
    respond(job({ kind: "team" }));
    await expect(
      productionApi.campaignProduce("campaign-1", {
        video_id: "video-1",
        profile_id: "profile-1",
        model_id: "ollama:qwen3-vl:8b",
      }),
    ).rejects.toThrow("production-job");
  });
  it("accepts dynamic Ollama IDs and checks job/run identity plus returned model", async () => {
    const value = agentEnvelope();
    const fetch = respond(value);
    const body = {
      expected_strategy_version_id: "strategy-1",
      video_id: "video-1",
      profile_id: "profile-1",
      model_id: "ollama:qwen3-vl:8b",
      revision_budget: 2,
    };
    expect(
      (await productionApi.campaignProduce("campaign-1", body)).run.id,
    ).toBe("run-1");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
    respond({ ...value, run: { ...value.run, job_id: "another-job" } });
    await expect(
      productionApi.campaignProduce("campaign-1", body),
    ).rejects.toThrow("agent-run");
    respond({ ...value, run: { ...value.run, model_id: "qwen-small" } });
    await expect(
      productionApi.campaignProduce("campaign-1", body),
    ).rejects.toThrow("different model");
  });
  it("passes optional run direction through and bounds it before sending", async () => {
    const fetch = respond(agentEnvelope());
    const body = {
      expected_strategy_version_id: "strategy-1",
      video_id: "video-1",
      profile_id: "profile-1",
      model_id: "ollama:qwen3-vl:8b",
      direction: "the spiciest takes on AI policy, under 40s",
    };
    await productionApi.campaignProduce("campaign-1", body);
    expect(JSON.parse(fetch.mock.calls[0][1].body).direction).toBe(body.direction);
    await expect(
      productionApi.campaignProduce("campaign-1", { ...body, direction: "x".repeat(501) }),
    ).rejects.toThrow("500 characters");
  });
  it.each([undefined, {}, {campaign_snapshot: null}, {campaign_snapshot: {}}])("rejects a scoped agent envelope with missing frozen context %j", async context => {
    const value=agentEnvelope();
    respond({...value,run:{...value.run,context}});
    await expect(productionApi.campaignProduce("campaign-1",{video_id:"video-1",profile_id:"profile-1",expected_strategy_version_id:"strategy-1",model_id:"ollama:qwen3-vl:8b"})).rejects.toThrow(/context|campaign_id/);
  });
  it("does not silently substitute a fixture, model or retry after a native failure", async () => {
    const fetch = respond(
      { detail: "Strategy changed. Review it first." },
      409,
    );
    await expect(
      productionApi.campaignRender("campaign-1", {
        video_id: "video-1",
        profile_id: "profile-1",
        end: 2,
      }),
    ).rejects.toThrow("Strategy changed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("exact review, clip metadata and technical checks", () => {
  it("preserves missing legacy checks, cost and revision information as unknown", () => {
    const result = parseProductionClip(clip());
    expect(result.technical_checks).toBeUndefined();
    expect(result.render_receipt).toBeUndefined();
    expect(result.revision_number).toBeUndefined();
    expect(parseTechnicalChecks(checks()).caption_issues).toEqual(["source"]);
  });
  it("rejects malformed or contradictory checks instead of displaying a pass", () => {
    expect(() =>
      parseTechnicalChecks({
        ...checks(),
        playback_format: [{ ...checks().playback_format[0], status: "good" }],
      }),
    ).toThrow("technical-check");
    expect(() =>
      parseTechnicalChecks({ ...checks(), playback_format_passed: false }),
    ).toThrow("contradicts");
    expect(() =>
      parseTechnicalChecks({ ...checks(), caption_issues: [] }),
    ).toThrow("contradicts");
    expect(() =>
      parseProductionClip(
        clip({ technical_checks: { ...checks(), captions: [] } }),
      ),
    ).toThrow("no measured");
  });
  it("review sends only the explicit human decision and verifies the returned exact clip", async () => {
    const fetch = respond(clip({ approved: true, approved_at: at }));
    expect((await productionApi.review(clip(), true)).approved).toBe(true);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ approved: true });
    respond(clip({ id: "wrong-clip", approved: true }));
    await expect(productionApi.review(clip(), true)).rejects.toThrow(
      "another clip version",
    );
  });
  it("blocks missing/failed team critique but allows withdrawal and baseline human review", async () => {
    const fetch = respond(
      clip({ team_run_id: "run-1", team_review_status: "unknown" }),
    );
    await expect(
      productionApi.review(
        clip({ team_run_id: "run-1", team_review_status: "unknown" }),
        true,
      ),
    ).rejects.toThrow("passing critique");
    expect(fetch).not.toHaveBeenCalled();
    await productionApi.review(
      clip({
        team_run_id: "run-1",
        team_review_status: "unknown",
        approved: true,
      }),
      false,
    );
    respond(
      clip({
        team_run_id: "baseline-1",
        team_review_status: "not_applicable",
        approved: true,
      }),
    );
    expect(
      (
        await productionApi.review(
          clip({
            team_run_id: "baseline-1",
            team_review_status: "not_applicable",
          }),
          true,
        )
      ).approved,
    ).toBe(true);
  });
  it("does not confuse a recheck job with human approval", async () => {
    respond(
      job({
        kind: "team_review",
        context: { video_id: "video-1", clip_id: "clip-1" },
      }),
    );
    expect(
      (
        await productionApi.recheck(
          clip({ team_run_id: "run-1", team_review_status: "unknown" }),
        )
      ).status,
    ).toBe("queued");
    respond(job({ kind: "team_review", context: { clip_id: "other-clip" } }));
    await expect(
      productionApi.recheck(clip({ team_run_id: "run-1" })),
    ).rejects.toThrow("another clip version");
  });
});

describe("verified exports and source actions", () => {
  it("requires explicit approval of the exact clip before creating an export", async () => {
    const fetch = respond(exportRecord());
    await expect(productionApi.createVerifiedExport(clip())).rejects.toThrow(
      "Approve this exact clip",
    );
    await expect(
      productionApi.createVerifiedExport(
        clip({
          approved: true,
          team_run_id: "run-1",
          team_review_status: "fail",
        }),
      ),
    ).rejects.toThrow("passing critique");
    expect(fetch).not.toHaveBeenCalled();
    const result = await productionApi.createVerifiedExport(
      clip({ approved: true, revision_number: 2, sha256: sha }),
    );
    expect(result.file.endsWith(".mp4")).toBe(true);
    expect(result.manifest?.schema).toBe("clip-factory/export-manifest@1");
    expect(fetch.mock.calls[0][0]).toBe("/api/clips/clip-1/export");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({});
  });
  it("rejects exports from another clip/source/strategy or checksum", async () => {
    const approved = clip({ approved: true, revision_number: 2, sha256: sha });
    for (const changes of [
      { clip_id: "other" },
      { video_id: "other" },
      { revision_number: 3 },
      { sha256: "b".repeat(64) },
    ]) {
      respond(exportRecord(changes));
      await expect(
        productionApi.createVerifiedExport(approved),
      ).rejects.toThrow();
    }
    const value = exportRecord();
    value.manifest.strategy.strategy_version_id = "another-strategy";
    expect(() => parseExportRecord(value, approved)).toThrow(
      "strategy_version_id",
    );
  });
  it("requires a matching manifest on a newly created export, and never retries uncertain writes", async () => {
    const fetch = respond(exportRecord({ manifest: undefined }));
    await expect(
      productionApi.createVerifiedExport(clip({ approved: true })),
    ).rejects.toThrow("no verifiable manifest");
    expect(fetch).toHaveBeenCalledTimes(1);
    const failed = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", failed);
    await expect(
      productionApi.createVerifiedExport(clip({ approved: true })),
    ).rejects.toThrow("Cannot reach");
    expect(failed).toHaveBeenCalledTimes(1);
  });
  it("loads export history filtered by exact clip identity", async () => {
    const fetch = respond([exportRecord({ manifest: undefined })]);
    expect(await productionApi.listExports("clip-1")).toHaveLength(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/exports?clip_id=clip-1");
    respond([exportRecord({ clip_id: "different", manifest: undefined })]);
    await expect(productionApi.listExports("clip-1")).rejects.toThrow(
      "another clip version",
    );
  });
  it("imports transcripts using the actual source route and rejects another source response", async () => {
    const body = {
      format: "srt" as const,
      content: "1\n00:00:00,000 --> 00:00:01,000\nWords\n",
      language: "en",
    };
    const video = {
      id: "video-1",
      name: "Source",
      transcript_origin: "imported",
      transcript: { segments: [{ start: 0, end: 1, text: "Words" }] },
    };
    const fetch = respond(video);
    expect(
      (await productionApi.importTranscript("video-1", body)).transcript_origin,
    ).toBe("imported");
    expect(fetch.mock.calls[0][0]).toBe("/api/videos/video-1/transcript");
    expect(fetch.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
    respond({ ...video, id: "wrong-source" });
    await expect(
      productionApi.importTranscript("video-1", body),
    ).rejects.toThrow("source/transcript");
  });
  it("reports transcription/cancellation job states without assuming completion", async () => {
    respond(job({ kind: "transcribe", context: { video_id: "video-1" } }));
    expect((await productionApi.transcribe("video-1")).status).toBe("queued");
    respond(job({ status: "running", message: "Cancellation requested" }));
    expect((await productionApi.cancelJob("job-1")).status).toBe("running");
    respond(job({ id: "wrong-job" }));
    await expect(productionApi.cancelJob("job-1")).rejects.toThrow(
      "another job",
    );
  });
});
