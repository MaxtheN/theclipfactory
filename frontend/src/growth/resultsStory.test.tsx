import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { api, post, put } from "../api";
import type { FactoryState } from "../useFactory";
import { Results } from "./Results";
import {
  experimentLines,
  postedRows,
  ratioChip,
  resultsStory,
} from "./resultsModel";
import { strategistApi } from "./strategistApi";
import type { Workspace } from "./useCampaignWorkspace";
import type { DemoResult } from "./demoStore";

vi.mock("../api", () => ({ api: vi.fn(), post: vi.fn(), put: vi.fn() }));

const nativeDialogs = { showModal: HTMLDialogElement.prototype.showModal, close: HTMLDialogElement.prototype.close };
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterAll(() => Object.assign(HTMLDialogElement.prototype, nativeDialogs));

const NOW = Date.parse("2026-11-14T12:00:00Z");
const day = 86400000;
const pub = (id: string, dueInDays: number) => ({
  id,
  policy_id: "pol",
  media_id: id,
  clip_id: "clip",
  published_at: new Date(NOW - day).toISOString(),
  next_due_at: new Date(NOW + dueInDays * day).toISOString(),
});

describe("resultsStory header", () => {
  it("nothing posted: tells you to approve and post", () => {
    const story = resultsStory({ approvedClips: 0, posted: 0, publications: [], snapshots: [], learned: 0, pendingRules: 0, now: NOW });
    expect(story.current).toBe("post");
    expect(story.headline).toBe("Nothing posted yet — approve a clip and post it");
    expect(story.steps.map((s) => s.state)).toEqual(["current", "upcoming", "upcoming"]);
  });
  it("posted but not measured: says how many are measuring and when", () => {
    const story = resultsStory({
      approvedClips: 2,
      posted: 2,
      publications: [pub("a", 3), pub("b", 5)],
      snapshots: [],
      learned: 0,
      pendingRules: 0,
      now: NOW,
    });
    expect(story.current).toBe("measure");
    expect(story.headline).toBe("Waiting: 2 posts measuring, next check Nov 17");
    expect(story.steps[0].state).toBe("done");
  });
  it("measured: counts what was learned and what waits for approval", () => {
    const story = resultsStory({
      approvedClips: 2,
      posted: 2,
      publications: [pub("a", 3)],
      snapshots: [{ id: "s", publication_id: "a" }],
      learned: 3,
      pendingRules: 1,
      now: NOW,
    });
    expect(story.current).toBe("learn");
    expect(story.headline).toBe("Learned 3 things — 1 rule waiting for your approval");
  });
  it("measured with no pattern yet is said plainly", () => {
    const story = resultsStory({
      approvedClips: 1,
      posted: 1,
      publications: [pub("a", 3)],
      snapshots: [{ id: "s", publication_id: "a" }],
      learned: 0,
      pendingRules: 0,
      now: NOW,
    });
    expect(story.headline).toBe("Measured 1 post — not enough to learn from yet");
  });
});

describe("plain-language pieces", () => {
  it("never turns unknown into zero", () => {
    expect(ratioChip("views", null, 100).label).toBe("views: unknown");
    expect(ratioChip("views", 50, null).label).toBe("50 views · no typical yet");
    const up = ratioChip("views", 150, 100);
    expect(up.label).toBe("150 views · 1.5× typical");
    expect(up.tone).toBe("up");
  });
  it("explains each queued experiment in one sentence", () => {
    const slot = (mode: "exploit" | "explore", value: string) => ({
      slot: 1,
      mode,
      belief_id: "b",
      layer: "craft" as const,
      variable: "hook_style",
      value,
      direction: "increase" as const,
      rationale: "",
      score: 1,
    });
    expect(
      experimentLines([slot("exploit", "question"), slot("exploit", "question"), slot("explore", "number")], "views"),
    ).toEqual([
      "Keep using question hooks on the next 2 clips: so far they have beaten your typical views.",
      "Test: try number hooks on the next clip to see whether it beats your typical views.",
    ]);
  });
  it("posted rows carry the window and the demo override label", () => {
    const rows = postedRows({
      publications: [{ ...pub("a", 2), demo_override: { due_at: new Date(NOW + 2 * day).toISOString(), real_elapsed_hours: 5 } }],
      snapshots: [],
      policies: [{ id: "pol", cadence_days: 3 }],
      accounts: [{ id: "acct", display_name: "@me" }],
      clips: [],
      baseline: [],
      now: NOW,
    });
    expect(rows[0].windowLabel).toBe("Day 1 of 3 · next reading Nov 16");
    expect(rows[0].demo).toBe(true);
    expect(rows[0].demoHours).toBe(5);
  });
});

describe("Results page", () => {
  afterEach(() => vi.restoreAllMocks());
  it("leads with the story and avoids old jargon", async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/automation/state")
        return { policies: [], publications: [], snapshots: [], work: [], experiments: [] };
      if (path === "/api/automation/accounts") return [];
      if (path === "/api/automation/settings") return { configured: false };
      return null;
    });
    vi.spyOn(strategistApi, "view").mockResolvedValue({
      profile_id: "p",
      target_metric: "views",
      baseline: { statistic: null, posts: 0, metrics: {} },
      beliefs: [],
      portfolio: null,
      pending_proposals: { style_rules: [], campaign: [] },
      runs: [],
      measured_posts: 0,
      due_layers: [],
      caveat: "",
      simulated: false,
    });
    const w = {
      campaign: { id: "c", video_ids: [], brief: {}, profile_ids: ["p"] },
      profileId: "p",
      profiles: [{ id: "p", active_strategy_id: null }],
      versions: [],
      observations: [],
      busy: false,
      loading: false,
      error: "",
    } as unknown as Workspace;
    const factory = { loading: false, errors: {}, data: { clips: [], videos: [], jobs: [] } } as unknown as FactoryState;
    const next = vi.fn();
    const onRehearse = vi.fn();
    const onAccounts = vi.fn();
    render(<Results w={w} factory={factory} next={next} onRehearse={onRehearse} onAccounts={onAccounts} />);
    expect(screen.getByText("Posted")).toBeTruthy();
    expect(screen.getByText("Measuring")).toBeTruthy();
    expect(screen.getByText("Learned")).toBeTruthy();
    expect(screen.getByText("Nothing posted yet — approve a clip and post it")).toBeTruthy();
    // Nothing recorded: an explicit empty state, never simulated history.
    const start = screen.getByRole("region", { name: "No results yet" });
    expect(within(start).getByRole("button", { name: "Connect accounts" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "What we learned" })).toBeNull();
    expect(screen.queryByText("Simulated")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Posted clips" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Run the learning loop/ })).toBeNull();
    fireEvent.click(within(start).getByRole("button", { name: "Try Demo Mode (simulated data)" }));
    expect(onRehearse).toHaveBeenCalledOnce();
    expect(document.querySelector("iframe")).toBeNull();
    expect(await screen.findByRole("heading", { name: "Strategist" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "See how it learns (simulated data)" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Connected accounts are owned by Settings > Accounts and connections; Results links there.
    fireEvent.click(screen.getByRole("button", { name: /Accounts: connect/ }));
    fireEvent.click(within(start).getByRole("button", { name: "Connect accounts" }));
    expect(onAccounts).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(start).getByRole("button", { name: "Add a result by hand" }));
    const manual = screen.getByRole("dialog", { name: "Add a result by hand" });
    fireEvent.change(within(manual).getByLabelText("What would we like to learn?"), { target: { value: "Does a direct opening help?" } });
    fireEvent.click(screen.getByRole("button", { name: "Close Add a result by hand" }));
    fireEvent.click(within(start).getByRole("button", { name: "Add a result by hand" }));
    expect(within(screen.getByRole("dialog", { name: "Add a result by hand" })).getByLabelText("What would we like to learn?")).toHaveValue("Does a direct opening help?");
    fireEvent.click(screen.getByRole("button", { name: "Close Add a result by hand" }));
    const text = document.querySelector(".gf-results-top")?.textContent ?? "";
    for (const word of [/No winner/i, /\bpolicy\b/i, /snapshot/i, /publication mapping/i, /PLAN THE NEXT/])
      expect(text).not.toMatch(word);
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
  const emptyWorkspace = () =>
    ({
      campaign: { id: "c", video_ids: [], brief: {}, profile_ids: ["p"] },
      profileId: "p",
      profiles: [{ id: "p", active_strategy_id: null }],
      versions: [],
      observations: [],
      busy: false,
      loading: false,
      error: "",
    }) as unknown as Workspace;
  const emptyFactory = { loading: false, errors: {}, data: { clips: [], videos: [], jobs: [] } } as unknown as FactoryState;
  const quietStrategist = () =>
    vi.spyOn(strategistApi, "view").mockResolvedValue({
      profile_id: "p", target_metric: "views", baseline: { statistic: null, posts: 0, metrics: {} }, beliefs: [], portfolio: null,
      pending_proposals: { style_rules: [], campaign: [] }, runs: [], measured_posts: 0, due_layers: [], caveat: "", simulated: false,
    });
  const demoClip = (id: string, hold: number, outcome: "win" | "steady" | "loss") => ({
    clip_id: id, hook: `${id}?`, score: 80, seconds: 30, media_url: "", cover_url: `/c/${id}`, outcome, opening: "question" as const,
    simulated: { metrics: { views: 2000, completion_rate: 0.5, hold_3s: hold } },
  });
  const storedDemo = {
    ran_at: "2026-11-14T12:00:00Z",
    after: null,
    plan: {
      profile_id: "p",
      baseline: { metrics: { views: 1600, completion_rate: 0.41, hold_3s: 0.52 } },
      clips: [demoClip("a", 0.71, "win"), demoClip("b", 0.55, "steady"), demoClip("c", 0.35, "loss")],
      clip_count: 22, source_minutes: 10,
      beliefs: [{ id: "q", headline: "Question hooks hold viewers", confidence: 0.75, detail: "+37% 3-sec hold", status: "active",
        counts: { matching: 2, beats: 2 }, evidence: [{ clip_id: "a", value: 0.71, baseline: 0.52, outcome: "beat" }] }],
      recut: { clip_id: "c", before_kind: "setup", before_hook: "x", after_kind: "question", after_hook: "y?", payoff_start: 1, payoff_end: 2, rule: "", next_test: "Jump cuts" },
      engine: "", honesty: "",
    },
  } as unknown as DemoResult;

  it("says when tracking fails even before anything is recorded", async () => {
    vi.mocked(api).mockImplementation(async (path: string) => (path === "/api/automation/accounts" ? [] : null));
    quietStrategist();
    render(<Results w={emptyWorkspace()} factory={emptyFactory} next={vi.fn()} onRehearse={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Tracking data is unavailable right now\. Results will update/);
    expect(screen.getByRole("heading", { name: "No results yet" })).toBeTruthy();
    expect(screen.queryByText("Simulated")).toBeNull();
  });

  it("keeps a stored demo out of real results and labels Demo Mode until it is exited", async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/automation/state") return { policies: [], publications: [], snapshots: [], work: [], experiments: [] };
      if (path === "/api/automation/accounts") return [];
      return null;
    });
    quietStrategist();
    const onExitDemo = vi.fn();
    const props = { w: emptyWorkspace(), factory: emptyFactory, next: vi.fn(), onRehearse: vi.fn(), demo: storedDemo, onExitDemo };
    const { rerender } = render(<Results {...props} />);
    // A demo result on hand is not enough: Demo Mode is off, so only real records show.
    expect(screen.getByRole("heading", { name: "No results yet" })).toBeTruthy();
    expect(screen.queryByText("Simulated")).toBeNull();
    expect(screen.queryByText("Question hooks hold viewers")).toBeNull();
    rerender(<Results {...props} demoMode />);
    expect(screen.getByText(/^Demo Mode\./)).toBeTruthy();
    expect(screen.getAllByText("Simulated").length).toBeGreaterThanOrEqual(2); // banner + every simulated block
    expect(screen.getByText("Question hooks hold viewers")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "No results yet" })).toBeNull();
    expect(screen.queryByText(/^Strategist and tools/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Exit Demo Mode" }));
    expect(onExitDemo).toHaveBeenCalledOnce();
    rerender(<Results {...props} demoMode={false} />);
    expect(screen.queryByText("Simulated")).toBeNull();
    expect(screen.getByRole("heading", { name: "No results yet" })).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
});
