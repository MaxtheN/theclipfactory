import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Campaigns, defaultDirection } from "./Campaigns";
import { clip, testState } from "../test-state";
import type { Campaign, Observation, Profile, StrategyVersion } from "../types";

afterEach(() => vi.unstubAllGlobals());
const profiles: Profile[] = [
  {
    id: "p1",
    name: "Educators",
    audience: "Teachers",
    brand_context: "Clear and helpful",
    objective: "discovery",
    primary_metric: null,
    creative_preferences: "Explain one idea",
  },
  {
    id: "p2",
    name: "Founders",
    audience: "Startup founders",
    brand_context: "Practical",
    objective: "engagement",
    primary_metric: "saves",
    creative_preferences: "Fast demonstrations",
  },
];
const campaign: Campaign = {
  id: "c1",
  name: "Launch",
  brief: {
    audience: "Two audiences",
    constraints: ["No invented claims"],
    requested_outputs: ["Two clips"],
    measurement_intent: "Explore saves",
  },
  profile_ids: ["p1", "p2"],
  video_ids: ["v1", "v2"],
  active_strategy_id: null,
};
const strategy: StrategyVersion = {
  id: "s1",
  campaign_id: "c1",
  version: 1,
  status: "proposed",
  base_version_id: null,
  reason: "Initial intent",
  hypothesis: "",
  created_at: "2026-11-14",
  approved_at: null,
  changed_profile_ids: ["p1", "p2"],
  directions: {
    p1: { ...defaultDirection(), hooks: ["Teach this"], duration_seconds: 20 },
    p2: {
      ...defaultDirection(),
      hooks: ["Build this"],
      duration_seconds: 45,
      framing: "fill",
    },
  },
};
const observations: Observation[] = [
  {
    id: "o1",
    profile_id: "p1",
    clip_id: "clip1",
    metric: "saves",
    value: null,
    unit: "count",
    source: "manual_import",
    publication_reference: "real-post-1",
    window_start: "2026-11-01",
    window_end: "2026-11-02",
    collected_at: "2026-11-03",
    notes: "Not available yet",
  },
  {
    id: "o2",
    profile_id: "p2",
    clip_id: "clip2",
    metric: "views",
    value: 100,
    unit: "count",
    source: "manual_import",
    publication_reference: "real-post-2",
    window_start: "2026-11-01",
    window_end: "2026-11-02",
    collected_at: "2026-11-03",
    notes: "Imported dashboard value",
  },
];
function harness(approved = false) {
  const db = {
    profiles: structuredClone(profiles),
    campaigns: [structuredClone(campaign)],
    strategies: [structuredClone(strategy)],
    observations: structuredClone(observations),
  };
  if (approved) {
    db.campaigns[0].active_strategy_id = "s1";
    db.strategies[0].status = "approved";
  }
  let failure: ((path: string, method: string) => boolean) | undefined;
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    const method = options?.method || "GET";
    if (failure?.(path, method))
      return new Response('{"detail":"Offline or conflict"}', { status: 409 });
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    let result: unknown = { id: "created" };
    if (method === "GET") {
      if (path === "/api/profiles") result = db.profiles;
      else if (path === "/api/campaigns") result = db.campaigns;
      else if (path.endsWith("/strategies"))
        result = db.strategies.filter(
          (s) => s.campaign_id === path.split("/")[3],
        );
      else if (path.endsWith("/observations")) result = db.observations;
      else throw new Error(`Unexpected read ${path}`);
    } else if (path === "/api/profiles") {
      const saved = { ...body, id: `p${db.profiles.length + 1}` };
      db.profiles.push(saved);
      result = saved;
    } else if (path === "/api/campaigns") {
      const saved = { ...body, id: "c3", active_strategy_id: null };
      db.campaigns.push(saved);
      result = saved;
    } else if (path === "/api/profiles/p1") {
      db.profiles[0] = { ...body, id: "p1" };
      result = db.profiles[0];
    } else if (path === "/api/campaigns/c1") {
      db.campaigns[0] = { ...db.campaigns[0], ...body };
      result = db.campaigns[0];
    } else if (path.endsWith("/approve")) {
      db.campaigns[0].active_strategy_id = "s1";
      db.strategies[0].status = "approved";
    } else if (path.endsWith("/reject"))
      db.strategies.find((s) => s.id === path.split("/")[5])!.status =
        "rejected";
    return new Response(JSON.stringify(result));
  });
  vi.stubGlobal("fetch", fetch);
  const state = testState();
  state.data.videos = [
    { id: "v1", name: "First source", duration: 120 },
    { id: "v2", name: "Second source", duration: 90 },
  ];
  state.data.clips = [
    {
      ...clip,
      id: "clip1",
      campaign_id: "c1",
      profile_id: "p1",
      strategy_version_id: "s1",
      approved: true,
    },
    {
      ...clip,
      id: "clip2",
      name: "Founder clip",
      campaign_id: "c1",
      profile_id: "p2",
      strategy_version_id: "s1",
      approved: true,
    },
    { ...clip, id: "unassigned", name: "Legacy unassigned" },
  ];
  state.run = vi.fn(async (task, notice) => {
    state.dismiss();
    try {
      await task();
      state.notice = notice;
      return true;
    } catch (e) {
      state.notice = "";
      state.actionError = String(e);
      return false;
    }
  });
  const openFactory = vi.fn();
  render(<Campaigns state={state} openFactory={openFactory} />);
  return {
    db,
    fetch,
    state,
    openFactory,
    fail: (fn: typeof failure) => {
      failure = fn;
    },
  };
}
async function selectCampaign() {
  await waitFor(() =>
    expect(screen.getByLabelText("Selected campaign")).toBeEnabled(),
  );
  await userEvent.selectOptions(
    screen.getByLabelText("Selected campaign"),
    "c1",
  );
  await waitFor(() =>
    expect(
      screen.queryByText("Loading strategy versions and evidence…"),
    ).not.toBeInTheDocument(),
  );
}
const payload = (
  fetch: ReturnType<typeof vi.fn>,
  path: string,
  method = "POST",
) => {
  const call = fetch.mock.calls.find(
    ([p, o]) => p === path && o?.method === method,
  );
  expect(call, `${method} ${path}`).toBeTruthy();
  return JSON.parse(call![1].body);
};
const formOf = (name: string) =>
  screen.getByRole("button", { name }).closest("form")!;

describe("Campaigns response validation", () => {
  it("blocks malformed profile data instead of rendering writable context", async () => {
    const { fetch } = harness();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reload campaigns and profiles" }),
      ).toBeEnabled(),
    );
    const base = fetch.getMockImplementation()!;
    fetch.mockImplementation((p, o) =>
      p === "/api/profiles" && !o?.method
        ? Promise.resolve(
            new Response(
              JSON.stringify([{ id: "broken", name: "Incomplete" }]),
            ),
          )
        : base(p, o),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reload campaigns and profiles" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Invalid list response",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Create profile" }),
    ).toBeDisabled();
  });
  it("blocks malformed direction data until a verified strategy reload", async () => {
    const { fetch } = harness(true);
    const base = fetch.getMockImplementation()!;
    fetch.mockImplementation((p, o) =>
      p.endsWith("/strategies") && !o?.method
        ? Promise.resolve(
            new Response(
              JSON.stringify([
                { ...strategy, directions: { p1: { hooks: [] } } },
              ]),
            ),
          )
        : base(p, o),
    );
    await selectCampaign();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Invalid list response",
    );
    expect(
      screen.getByRole("button", { name: "Render campaign clip" }),
    ).toBeDisabled();
  });
});
describe("Campaigns saved context", () => {
  it("saves two reusable profiles and sends null primary metric for discovery", async () => {
    const { fetch, db } = harness();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByLabelText("Profile name")).toBeEnabled(),
    );
    await user.type(screen.getByLabelText("Profile name"), "Creators");
    await user.type(
      screen.getByLabelText("Profile audience"),
      "Independent creators",
    );
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    await waitFor(() => expect(db.profiles).toHaveLength(3));
    expect(payload(fetch, "/api/profiles")).toMatchObject({
      name: "Creators",
      objective: "discovery",
      primary_metric: null,
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Profile name")).toBeEnabled(),
    );
    await user.clear(screen.getByLabelText("Profile name"));
    await user.type(screen.getByLabelText("Profile name"), "Partners");
    await user.selectOptions(
      screen.getByLabelText("Profile objective"),
      "traffic",
    );
    expect(screen.getByLabelText("Primary metric")).toBeRequired();
    await user.type(screen.getByLabelText("Primary metric"), "clicks");
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    await waitFor(() => expect(db.profiles).toHaveLength(4));
    const posts = fetch.mock.calls.filter(
      ([p, o]) => p === "/api/profiles" && o?.method === "POST",
    );
    expect(JSON.parse(posts[1][1]!.body as string)).toMatchObject({
      name: "Partners",
      objective: "traffic",
      primary_metric: "clicks",
    });
  });
  it("creates a campaign with both saved profiles and both sources", async () => {
    const { fetch } = harness();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign name")).toBeEnabled(),
    );
    await user.type(
      screen.getByLabelText("Campaign name"),
      "New multi-source campaign",
    );
    await user.click(screen.getByRole("checkbox", { name: "Educators" }));
    await user.click(screen.getByRole("checkbox", { name: "Founders" }));
    await user.click(screen.getByRole("checkbox", { name: "First source" }));
    await user.click(screen.getByRole("checkbox", { name: "Second source" }));
    await user.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() =>
      expect(payload(fetch, "/api/campaigns")).toMatchObject({
        name: "New multi-source campaign",
        profile_ids: ["p1", "p2"],
        video_ids: ["v1", "v2"],
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Selected campaign")).toHaveValue("c3"),
    );
  });
  it("updates profile context without snapshot writes and saves multi-source campaign membership", async () => {
    const { fetch } = harness();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByLabelText("Edit saved profile")).toBeEnabled(),
    );
    await user.selectOptions(screen.getByLabelText("Edit saved profile"), "p1");
    await user.clear(screen.getByLabelText("Brand context"));
    await user.type(
      screen.getByLabelText("Brand context"),
      "Changed current context",
    );
    await user.click(
      screen.getByRole("button", { name: "Save profile context" }),
    );
    await waitFor(() =>
      expect(payload(fetch, "/api/profiles/p1", "PUT")).toMatchObject({
        brand_context: "Changed current context",
        primary_metric: null,
      }),
    );
    await selectCampaign();
    await user.click(screen.getByRole("button", { name: "Save campaign" }));
    await waitFor(() =>
      expect(payload(fetch, "/api/campaigns/c1", "PUT")).toMatchObject({
        profile_ids: ["p1", "p2"],
        video_ids: ["v1", "v2"],
        brief: campaign.brief,
      }),
    );
    expect(
      fetch.mock.calls.filter(
        ([p, o]) => p.startsWith("/api/clips") && o?.method,
      ),
    ).toHaveLength(0);
  });
});
describe("Campaigns strategy and production gates", () => {
  it("submits distinct directions for every initial profile and cannot produce a pending proposal", async () => {
    const { fetch } = harness();
    const user = userEvent.setup();
    await selectCampaign();
    await user.type(
      screen.getByLabelText("Proposal reason"),
      "Different creative directions",
    );
    const sections = document.querySelectorAll(".campaign-direction");
    await user.type(
      within(sections[0] as HTMLElement).getByLabelText("Hooks (one per line)"),
      "Educator hook",
    );
    await user.type(
      within(sections[1] as HTMLElement).getByLabelText("Hooks (one per line)"),
      "Founder hook",
    );
    fireEvent.change(
      within(sections[1] as HTMLElement).getByLabelText(
        "Target duration (seconds)",
      ),
      { target: { value: "45" } },
    );
    await user.click(
      screen.getByRole("button", { name: "Propose initial strategy" }),
    );
    await waitFor(() =>
      expect(payload(fetch, "/api/campaigns/c1/strategies")).toMatchObject({
        base_version_id: null,
        directions: {
          p1: { hooks: ["Educator hook"], duration_seconds: 30 },
          p2: { hooks: ["Founder hook"], duration_seconds: 45 },
        },
      }),
    );
    expect(
      screen.getByRole("button", { name: "Render campaign clip" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Propose learning revision" }),
    ).toBeDisabled();
    expect(fetch.mock.calls.some(([p]) => p.endsWith("/approve"))).toBe(false);
    expect(screen.queryByText("Legacy unassigned")).not.toBeInTheDocument();
  });
  it("requires explicit approval, renders second source with null default range and preserves direct range", async () => {
    const { fetch } = harness();
    const user = userEvent.setup();
    await selectCampaign();
    await user.click(screen.getByRole("button", { name: "Approve version 1" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Render campaign clip" }),
      ).toBeEnabled(),
    );
    expect(payload(fetch, "/api/campaigns/c1/strategies/s1/approve")).toEqual(
      {},
    );
    await user.selectOptions(screen.getByLabelText("Production source"), "v2");
    await user.selectOptions(screen.getByLabelText("Production profile"), "p2");
    await user.click(
      screen.getByRole("button", { name: "Render campaign clip" }),
    );
    await waitFor(() =>
      expect(payload(fetch, "/api/campaigns/c1/render")).toEqual({
        expected_strategy_version_id: "s1",
        video_id: "v2",
        profile_id: "p2",
        start: 0,
        end: null,
        hook: null,
        caption: "",
        subtitles: true,
        mode: "strategy",
        instructions: "",
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Production mode")).toBeEnabled(),
    );
    await user.selectOptions(
      screen.getByLabelText("Production mode"),
      "direct",
    );
    expect(
      screen.getByRole("button", { name: "Render campaign clip" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Start seconds"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("End seconds"), {
      target: { value: "17" },
    });
    await user.click(
      screen.getByRole("button", { name: "Render campaign clip" }),
    );
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([p, o]) => p.endsWith("/render") && o?.method),
      ).toHaveLength(2),
    );
    const calls = fetch.mock.calls.filter(
      ([p, o]) => p.endsWith("/render") && o?.method,
    );
    expect(JSON.parse(calls[1][1]!.body as string)).toMatchObject({
      start: 5,
      end: 17,
      mode: "direct",
      video_id: "v2",
      profile_id: "p2",
    });
  });
  it("rejects with reason and restores only a chosen profile as a proposal", async () => {
    const { fetch, db } = harness(true);
    const user = userEvent.setup();
    db.strategies.push({
      ...structuredClone(strategy),
      id: "s2",
      version: 2,
      base_version_id: "s1",
    });
    await selectCampaign();
    await user.type(
      screen.getByLabelText("Reason for version 2 action"),
      "Not the right direction",
    );
    await user.click(screen.getByRole("button", { name: "Reject version 2" }));
    await waitFor(() =>
      expect(payload(fetch, "/api/campaigns/c1/strategies/s2/reject")).toEqual({
        reason: "Not the right direction",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("Reason for version 1 action"),
      ).toBeEnabled(),
    );
    await user.type(
      screen.getByLabelText("Reason for version 1 action"),
      "Restore founder hook",
    );
    await user.selectOptions(
      screen.getByLabelText("Restore profile from version 1"),
      "p2",
    );
    await user.click(
      screen.getByRole("button", {
        name: "Propose restoration from version 1",
      }),
    );
    await waitFor(() =>
      expect(payload(fetch, "/api/campaigns/c1/strategies/s1/restore")).toEqual(
        { profile_id: "p2", reason: "Restore founder hook" },
      ),
    );
    expect(fetch.mock.calls.some(([p]) => p.endsWith("/approve"))).toBe(false);
  });
  it("does not approve a stale-base proposal or render from stale workspace data", async () => {
    const { db, state } = harness(true);
    db.strategies.push({
      ...structuredClone(strategy),
      id: "s2",
      version: 2,
      base_version_id: null,
    });
    state.errors.jobs = "Unavailable";
    await selectCampaign();
    expect(
      screen.getByRole("button", { name: "Approve version 2" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Render campaign clip" }),
    ).toBeDisabled();
  });
});
describe("Campaigns evidence and learning", () => {
  it.each(["", "0", "17.5"])(
    "imports actual value %s without replacing unknown with zero",
    async (value) => {
      const { fetch } = harness(true);
      const user = userEvent.setup();
      await selectCampaign();
      const form = within(formOf("Import real observation"));
      await user.selectOptions(
        form.getByLabelText("Approved evidence clip"),
        "clip1",
      );
      await user.type(form.getByLabelText("Observation metric"), "saves");
      if (value) await user.type(form.getByLabelText("Observed value"), value);
      await user.type(form.getByLabelText("Metric unit"), "count");
      await user.type(
        form.getByLabelText("Publication reference"),
        "real-post-url",
      );
      for (const [label, value] of [
        ["Observation window start", "2026-11-01T10:00"],
        ["Observation window end", "2026-11-02T10:00"],
        ["Collected at", "2026-11-03T10:00"],
      ])
        fireEvent.change(form.getByLabelText(label), { target: { value } });
      await user.click(
        form.getByRole("button", { name: "Import real observation" }),
      );
      await waitFor(() =>
        expect(payload(fetch, "/api/campaigns/c1/observations")).toMatchObject({
          clip_id: "clip1",
          metric: "saves",
          value: value === "" ? null : Number(value),
          unit: "count",
          publication_reference: "real-post-url",
          window_start: new Date("2026-11-01T10:00").toISOString(),
        }),
      );
    },
  );
  it("proposes only the selected profile using selected evidence and exact active base", async () => {
    const { fetch } = harness(true);
    const user = userEvent.setup();
    await selectCampaign();
    await user.selectOptions(screen.getByLabelText("Working profile"), "p2");
    expect(screen.queryByLabelText(/Use saves:/)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(/Use views: 100/));
    const form = within(formOf("Propose learning revision"));
    await user.type(
      form.getByLabelText("Learning hypothesis"),
      "A clearer hook may improve saves",
    );
    await user.type(
      form.getByLabelText("Learning reason"),
      "Test an alternative, not a winner claim",
    );
    await user.clear(form.getByLabelText("Hooks (one per line)"));
    await user.type(
      form.getByLabelText("Hooks (one per line)"),
      "New founder hook",
    );
    await user.click(
      form.getByRole("button", { name: "Propose learning revision" }),
    );
    await waitFor(() =>
      expect(payload(fetch, "/api/campaigns/c1/learning")).toMatchObject({
        profile_id: "p2",
        observation_ids: ["o2"],
        base_version_id: "s1",
        proposed_direction: {
          hooks: ["New founder hook"],
          evidence_refs: ["o2"],
          duration_seconds: 45,
          framing: "fill",
        },
      }),
    );
    expect(fetch.mock.calls.some(([p]) => p.endsWith("/approve"))).toBe(false);
    await waitFor(() =>
      expect(screen.getByLabelText("Working profile")).toBeEnabled(),
    );
    await user.selectOptions(screen.getByLabelText("Working profile"), "p1");
    expect(
      screen.getByRole("button", { name: "Propose learning revision" }),
    ).toBeDisabled();
    expect(
      within(formOf("Propose learning revision")).getByLabelText(
        "Learning hypothesis",
      ),
    ).toHaveValue("");
  });
});
describe("Campaigns local failure handling", () => {
  it("blocks writes after detail load failure until retry succeeds", async () => {
    const { fail } = harness();
    fail((p) => p.endsWith("/observations"));
    await selectCampaign();
    expect(
      screen.getByRole("button", { name: "Propose initial strategy" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Approve version 1" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Offline or conflict");
    fail(undefined);
    await userEvent.click(
      screen.getByRole("button", { name: "Reload strategy and evidence" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Approve version 1" }),
      ).toBeEnabled(),
    );
  });
  it("preserves a failed proposal draft, blocks retries and never reports stale success", async () => {
    const { fail, state, fetch } = harness();
    await selectCampaign();
    await userEvent.type(
      screen.getByLabelText("Proposal reason"),
      "Keep this draft",
    );
    fail((p, m) => p.endsWith("/strategies") && m === "POST");
    await userEvent.click(
      screen.getByRole("button", { name: "Propose initial strategy" }),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0),
    );
    expect(screen.getByLabelText("Proposal reason")).toHaveValue(
      "Keep this draft",
    );
    expect(
      screen.getByRole("button", { name: "Propose initial strategy" }),
    ).toBeDisabled();
    expect(state.notice).toBe("");
    expect(
      fetch.mock.calls.filter(
        ([p, o]) => p.endsWith("/strategies") && o?.method === "POST",
      ),
    ).toHaveLength(1);
  });
  it("treats successful write followed by failed reload as unresolved, not success", async () => {
    const { fail, state } = harness();
    await selectCampaign();
    fail((p, m) => p.endsWith("/observations") && m === "GET");
    await userEvent.click(
      screen.getByRole("button", { name: "Approve version 1" }),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("alert").length).toBeGreaterThan(0),
    );
    expect(state.notice).toBe("");
    expect(
      screen.getByRole("button", { name: "Render campaign clip" }),
    ).toBeDisabled();
  });
  it("blocks initial resource failures and loads fresh data on retry", async () => {
    const { fail } = harness();
    fail((p) => p === "/api/profiles");
    // The first requests started before failure was configured; explicitly reload.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reload campaigns and profiles" }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reload campaigns and profiles" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Campaign resources unavailable",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Create profile" }),
    ).toBeDisabled();
    fail(undefined);
    await userEvent.click(
      screen.getByRole("button", { name: "Reload campaigns and profiles" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create profile" }),
      ).toBeEnabled(),
    );
  });
  it("drops old campaign drafts and ignores late detail responses when switching selection", async () => {
    const { db, fetch } = harness();
    db.campaigns.push({
      ...structuredClone(campaign),
      id: "c2",
      name: "Second campaign",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reload campaigns and profiles" }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reload campaigns and profiles" }),
    );
    await selectCampaign();
    await userEvent.type(
      screen.getByLabelText("Proposal reason"),
      "Old campaign draft",
    );
    let resolve!: (response: Response) => void;
    const base = fetch.getMockImplementation()!;
    fetch.mockImplementation((p: string, o?: RequestInit) =>
      p === "/api/campaigns/c2/strategies"
        ? new Promise<Response>((r) => {
            resolve = r;
          })
        : base(p, o),
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Selected campaign"),
      "c2",
    );
    expect(screen.getByLabelText("Proposal reason")).toHaveValue("");
    await userEvent.selectOptions(
      screen.getByLabelText("Selected campaign"),
      "c1",
    );
    resolve(
      new Response(
        JSON.stringify([
          { ...strategy, id: "late", campaign_id: "c2", version: 99 },
        ]),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Approve version 1" }),
      ).toBeEnabled(),
    );
    expect(screen.queryByText(/Version 99/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Proposal reason")).toHaveValue("");
  });
});
