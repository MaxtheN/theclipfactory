import { describe, expect, it } from "vitest";
import type { Campaign, Clip, FactorySource, Job, TeamRun } from "../types";
import {
  applyReplay,
  deriveFactoryMap,
  replayableRun,
  replayEvents,
  replayFrame,
  runLedger,
  scopeAutomation,
  type MapInput,
  type StationId,
} from "./flowEvents";
import type { StrategistView } from "./strategistApi";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const at = (minutes: number) => new Date(NOW + minutes * 60000).toISOString();

const stage = (key: string, status: string, detail = "") => ({
  key,
  label: key,
  status: status as FactorySource["stages"][number]["status"],
  detail,
});
function source(over: Partial<FactorySource> = {}): FactorySource {
  return {
    video_id: "v1",
    name: "Episode 1",
    duration: 600,
    state: "idle",
    headline: "Ready to make clips",
    progress: null,
    stages: [
      stage("import", "done"),
      stage("listen", "done", "120 lines of speech"),
      stage("watch", "done", "12 scenes"),
      stage("select", "pending"),
      stage("edit", "pending"),
      stage("render", "pending"),
    ],
    job_id: null,
    run_id: null,
    clip_ids: [],
    unreviewed: 0,
    approved: 0,
    error: null,
    can_produce: true,
    blocked_reason: null,
    storyboard: { scenes: 12, vision: true, model_id: "m", updated_at: at(-60) },
    thumbnail: null,
    ...over,
  };
}
function run(over: Partial<TeamRun> & Record<string, unknown> = {}): TeamRun {
  return {
    id: "run-1",
    video_id: "v1",
    mode: "swarm",
    model_id: "qwen3-vl:4b",
    objective: "discovery",
    status: "needs_review",
    job_id: "job-1",
    revision_budget: 0,
    revision_count: 0,
    stop_reason: null,
    created_at: at(-30),
    started_at: at(-30),
    finished_at: at(-10),
    elapsed_seconds: 1200,
    resource_observations: null,
    clip_ids: ["c1", "c2", "c3"],
    plan: null,
    context: {},
    permissions: { publish: false, ads: false },
    tasks: [
      { id: "t1", role: "transcribe", label: "Source transcription", kind: "tool", status: "completed", iteration: 0, input_refs: [], output: null, error: null, started_at: at(-30), finished_at: at(-28) },
      { id: "t2", role: "watch", label: "Watch the footage", kind: "tool", status: "completed", iteration: 0, input_refs: [], output: { scenes: 12 }, error: null, started_at: at(-28), finished_at: at(-24) },
      { id: "t3", role: "swarm", label: "Idea swarm", kind: "agent", status: "completed", iteration: 0, input_refs: [], output: { ideas: 9, stretches: 6, clips: 3, failed_renders: 0, hypotheses: ["question"] }, error: null, started_at: at(-24), finished_at: at(-10) },
    ],
    ...over,
  } as TeamRun;
}
const clip = (id: string, over: Partial<Clip> = {}): Clip =>
  ({
    id,
    video_id: "v1",
    name: id,
    start: 0,
    end: 20,
    hook: `Hook ${id}`,
    caption: "",
    objective: "",
    approved: false,
    created_at: at(-20),
    ...over,
  }) as Clip;
const campaign = (brief: Partial<Campaign["brief"]> = {}): Campaign => ({
  id: "camp",
  name: "Camp",
  profile_ids: ["p"],
  video_ids: ["v1"],
  brief: {
    audience: "",
    constraints: [],
    requested_outputs: [],
    measurement_intent: "",
    ...brief,
  },
});
function input(over: Partial<MapInput> = {}): MapInput {
  return {
    sources: [],
    jobs: [],
    clips: [],
    runs: [],
    campaign: campaign(),
    versions: [],
    activeRulesId: null,
    automation: null,
    strategist: null,
    now: NOW,
    ...over,
  };
}
const station = (model: ReturnType<typeof deriveFactoryMap>, id: StationId) =>
  model.stations.find((s) => s.id === id)!;

describe("deriveFactoryMap: honest empty states", () => {
  it("shows nothing as working and says plainly what is missing", () => {
    const model = deriveFactoryMap(input());
    expect(model.stations).toHaveLength(12);
    expect(model.live).toBe(false);
    expect(model.edges.every((e) => !e.flowing)).toBe(true);
    expect(station(model, "footage").status).toBe("No footage yet — add an episode");
    expect(station(model, "footage").state).toBe("empty");
    expect(station(model, "scout").status).toMatch(/No run yet/);
    expect(station(model, "approve").status).toBe("Nothing to review yet");
    expect(station(model, "post").status).toBe("Nothing posted yet");
    expect(station(model, "measure").status).toBe("Nothing to measure yet");
    // Unavailable data is not "zero".
    expect(station(model, "strategist").status).toBe("Unavailable right now");
    expect(station(model, "brief").status).toMatch(/nothing to screen/);
    expect(model.returnArc.lit).toBe(false);
  });

  it("says there is nothing to learn yet when no post is measured", () => {
    const strategist = {
      measured_posts: 0,
      beliefs: [],
      runs: [],
      pending_proposals: { style_rules: [], campaign: [] },
    } as unknown as StrategistView;
    const model = deriveFactoryMap(input({ strategist }));
    expect(station(model, "strategist").status).toBe(
      "0 measured posts — nothing to learn yet",
    );
    expect(station(model, "strategist").state).toBe("empty");
  });
});

describe("deriveFactoryMap: real work in progress", () => {
  it("activates the swarm stations and flows tokens only into working stations", () => {
    const live = run({
      status: "running",
      finished_at: null,
      clip_ids: ["c1", "c2"],
      brief_rejections: [{ step: "swarm", start: 10, end: 30, avoid: ["A1"], items: ["Prices"] }],
      tasks: [
        ...run().tasks.slice(0, 2),
        { ...run().tasks[2], status: "running", finished_at: null, output: null },
      ],
    });
    const job: Job = {
      id: "job-1",
      kind: "team",
      status: "running",
      progress: 40,
      message: "Finding clips: part 3 of 12 · 2 clips ready",
      context: { video_id: "v1" },
    };
    const model = deriveFactoryMap(
      input({
        sources: [source({ state: "working", job_id: "job-1" })],
        jobs: [job],
        runs: [live],
        clips: [clip("c1"), clip("c2")],
        campaign: campaign({ must_avoid: ["Prices"] }),
      }),
    );
    expect(model.live).toBe(true);
    expect(station(model, "scout").state).toBe("active");
    expect(station(model, "scout").status).toBe("Finding clips: part 3 of 12 · 2 clips ready");
    expect(station(model, "scout").lanes).toBe(8); // 12 stretches, capped at 8 lanes
    expect(station(model, "brief").state).toBe("active");
    expect(station(model, "brief").status).toBe("1 idea rejected by brief so far");
    expect(station(model, "editor").state).toBe("active");
    expect(station(model, "editor").status).toBe("2 clips rendered so far");
    const flowing = model.edges.filter((e) => e.flowing).map((e) => `${e.from}>${e.to}`);
    expect(flowing).toEqual(["watch>scout", "scout>brief", "brief>editor"]);
    // Idle downstream stations rest.
    expect(station(model, "critic").state).not.toBe("active");
  });

  it("uses the live job message for a transcription in progress", () => {
    const model = deriveFactoryMap(
      input({
        sources: [
          source({
            state: "working",
            job_id: "job-t",
            stages: [stage("import", "done"), stage("listen", "active")],
          }),
        ],
        jobs: [{ id: "job-t", kind: "transcribe", status: "running", progress: 12, message: "Listening: transcribing speech locally" }],
      }),
    );
    expect(station(model, "listen").state).toBe("active");
    expect(station(model, "listen").status).toBe("Listening: transcribing speech locally · 12%");
    expect(model.edges.find((e) => e.to === "listen")!.flowing).toBe(true);
  });
});

describe("deriveFactoryMap: finished run, review, posting and learning", () => {
  const strategist = {
    measured_posts: 3,
    beliefs: [
      { id: "b1", status: "supported", statement: "Question hooks beat the median", confidence: 0.9, counts: { matching: 3 } },
      { id: "b2", status: "retired", statement: "Old", confidence: 0.1, counts: { matching: 1 } },
    ],
    runs: [],
    pending_proposals: {
      style_rules: [{ id: "v2", campaign_id: "c", version: 2, layer: "craft" }],
      campaign: [],
    },
  } as unknown as StrategistView;
  const model = deriveFactoryMap(
    input({
      sources: [source({ state: "needs_review", unreviewed: 2, approved: 1 })],
      runs: [
        run({
          brief_rejections: [
            { step: "swarm", start: 1, end: 20, avoid: ["A1"], items: ["Prices"] },
            { step: "swarm", start: 40, end: 60, avoid: ["A1"], items: ["Prices"] },
            { step: "swarm", start: 80, end: 99, avoid: ["A1"], items: ["Prices"] },
          ],
          ranking: { ranked: 3, above_bar: 2, below_bar: 1, duplicates: 0, top_picks: 2 },
        }),
      ],
      clips: [clip("c1", { approved: true }), clip("c2"), clip("c3", { rank: { score: 30, position: 3, below_bar: true, reason: "Low interest" } })],
      campaign: campaign({ must_avoid: ["Prices"], key_messages: ["Ship faster"] }),
      automation: {
        policies: [],
        accounts: [{ id: "acct", status: "active", profile_id: "p" }],
        publications: [
          { id: "pub", policy_id: "pol", media_id: "1", clip_id: "c1", published_at: at(-2 * 1440), next_due_at: at(3 * 1440) },
        ],
        snapshots: [],
        work: [],
      },
      strategist,
    }),
  );
  it("summarises each station from the run's records", () => {
    expect(station(model, "scout").status).toBe("12 ideas from 6 stretches");
    expect(station(model, "brief").status).toBe("12 ideas · 3 rejected by brief");
    expect(station(model, "editor").status).toBe("3 clips cut");
    expect(station(model, "critic").status).toBe("2 above the bar · 1 below");
    expect(station(model, "critic").sheet.some((s) => s.items?.some((i) => i.includes("Low interest")))).toBe(true);
    expect(station(model, "approve").status).toBe("2 clips waiting for you");
    expect(station(model, "approve").state).toBe("waiting");
    expect(station(model, "post").status).toBe("1 post on Instagram");
    expect(station(model, "measure").status).toBe("Next measure: Nov 17");
    expect(station(model, "strategist").status).toBe("1 belief · 1 supported");
    expect(station(model, "rules").status).toBe("1 rule waiting for your approval");
    expect(model.live).toBe(false);
    expect(model.edges.every((e) => !e.flowing)).toBe(true);
  });
  it("lights the return arc when a proposal exists", () => {
    expect(model.returnArc.lit).toBe(true);
    expect(station(model, "brief").sheet[0].items).toContain("A1 · must avoid: Prices");
  });
});

describe("scopeAutomation", () => {
  it("keeps only this campaign and brand's records and active accounts", () => {
    const scoped = scopeAutomation(
      {
        policies: [
          { id: "mine", campaign_id: "c", profile_id: "p" },
          { id: "other", campaign_id: "c", profile_id: "q" },
        ],
        publications: [
          { id: "a", policy_id: "mine" },
          { id: "b", policy_id: "other" },
        ],
        snapshots: [],
        work: [],
        accounts: [
          { id: "x", profile_id: "p", status: "active" },
          { id: "y", profile_id: "q", status: "active" },
        ],
      },
      "c",
      "p",
    );
    expect(scoped!.publications.map((r) => r.id)).toEqual(["a"]);
    expect(scoped!.accounts.map((r) => r.id)).toEqual(["x"]);
    expect(scopeAutomation(null, "c", "p")).toBeNull();
  });
});

describe("replay of recorded events", () => {
  it("is unavailable without a finished, timestamped run", () => {
    expect(replayableRun([])).toBeNull();
    expect(replayableRun([run({ status: "running" })])).toBeNull();
    expect(
      replayableRun([run({ tasks: run().tasks.map((t) => ({ ...t, started_at: null, finished_at: null })) })]),
    ).toBeNull();
    expect(replayableRun([run()])!.id).toBe("run-1");
  });
  it("plays back only the run's own timestamps", () => {
    const r = run();
    const events = replayEvents(r, [clip("c1", { created_at: at(-15) }), clip("other", { created_at: at(-14) })]);
    // 3 starts + 3 finishes + 1 clip of this run (the other clip is not in the run).
    expect(events).toHaveLength(7);
    expect(events[0].at).toBe(Date.parse(at(-30)));
    const early = replayFrame(events, 60000);
    expect([...early.active]).toEqual(["listen"]);
    const mid = replayFrame(events, 10 * 60000); // -20 min: swarm running, one clip at -15? not yet
    expect(mid.active.has("scout")).toBe(true);
    expect(mid.done.has("listen")).toBe(true);
    expect(mid.clips).toBe(0);
    const end = replayFrame(events, 20 * 60000);
    expect(end.finished).toBe(true);
    expect(end.clips).toBe(1);
    const base = deriveFactoryMap(input({ runs: [r] }));
    const overlay = applyReplay(base, mid, r);
    expect(overlay.stations.find((s) => s.id === "editor")!.state).toBe("active");
    expect(overlay.stations.find((s) => s.id === "approve")!.dim).toBe(true);
    expect(overlay.stations.every((s) => s.dim || s.status.startsWith("Replay"))).toBe(true);
  });
});

describe("runLedger", () => {
  it("reports time per stage, clips and human actions with local cost", () => {
    const ledger = runLedger(
      run({ ranking: { ranked: 3, above_bar: 2, below_bar: 1 } }),
      [clip("c1", { approved: true }), clip("c2"), clip("c3", { rank: { score: 20, position: 3, below_bar: true } })],
      NOW,
    );
    expect(ledger.stages.map((s) => [s.station, Math.round(s.seconds)])).toEqual([
      ["listen", 120],
      ["watch", 240],
      ["scout", 840],
    ]);
    expect(ledger.totalSeconds).toBe(1200);
    expect(ledger.produced).toBe(3);
    expect(ledger.kept).toBe(1);
    expect(ledger.belowBar).toBe(1);
    expect(ledger.waiting).toBe(1);
    expect(ledger.approvals).toBe(1);
    expect(ledger.cost.inference).toBe("$0");
    expect(ledger.cost.excluded.length).toBeGreaterThan(0);
  });
});
