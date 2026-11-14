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
    const { rerender } = render(<Results w={w} factory={factory} next={next} />);
    const header = screen.getByRole("list", { name: "Post, measure, learn" });
    expect(within(header).getByText("Post")).toBeTruthy();
    expect(screen.getByText("Nothing posted yet — approve a clip and post it")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "What we've learned" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Insights" }));
    expect(await screen.findByRole("heading", { name: "What we've learned" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Next experiment" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Waiting for you" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "See how it learns (simulated data)" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Accounts & tracking" }));
    const accounts = screen.getByRole("dialog", { name: "Instagram accounts" });
    expect(within(accounts).getByRole("heading", { name: "Connect, track and measure" })).toBeTruthy();
    fireEvent(accounts, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a result by hand" }));
    const manual = screen.getByRole("dialog", { name: "Add a result by hand" });
    fireEvent.change(within(manual).getByLabelText("What would we like to learn?"), { target: { value: "Does a direct opening help?" } });
    fireEvent.click(screen.getByRole("button", { name: "Close Add a result by hand" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a result by hand" }));
    expect(within(screen.getByRole("dialog", { name: "Add a result by hand" })).getByLabelText("What would we like to learn?")).toHaveValue("Does a direct opening help?");
    fireEvent.click(screen.getByRole("button", { name: "Close Add a result by hand" }));
    fireEvent.click(screen.getByRole("button", { name: "Posted clips" }));
    expect(screen.getByRole("heading", { name: "Posted clips" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "What we've learned" })).toBeNull();
    const text = screen.getByRole("list", { name: "Post, measure, learn" }).textContent ?? "";
    for (const word of [/No winner/i, /\bpolicy\b/i, /snapshot/i, /publication mapping/i, /PLAN THE NEXT/])
      expect(text).not.toMatch(word);
    for (const hash of ["#gf-accounts", "#connections"]) {
      window.history.replaceState(null, "", hash);
      rerender(<Results w={w} factory={factory} next={next} visible={false} />);
      rerender(<Results w={w} factory={factory} next={next} visible />);
      expect(await screen.findByRole("dialog", { name: "Instagram accounts" })).toBeTruthy();
      expect(window.location.hash).toBe(hash === "#gf-accounts" ? "" : hash);
      fireEvent.click(screen.getByRole("button", { name: "Close Instagram accounts" }));
    }
    window.history.replaceState(null, "", window.location.pathname);
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
