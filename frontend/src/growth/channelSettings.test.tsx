import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import type { Campaign, Profile } from "../types";
import type { FactoryState } from "../useFactory";
import type { Workspace } from "./useCampaignWorkspace";
import { ApiError } from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  const { previewRequest: request } = await import("./previewApi");
  return {
    ...actual,
    api: request,
    post: (path: string, body: unknown = {}) =>
      request(path, { method: "POST", body: JSON.stringify(body) }),
    put: (path: string, body: unknown) =>
      request(path, { method: "PUT", body: JSON.stringify(body) }),
  };
});
import { Setup } from "./Setup";
import { workspaceApi } from "./workspaceApi";
import { resetPreview } from "./previewApi";
import { GrowthApp } from "./GrowthApp";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A small in-memory service: PUTs replace the exact record by ID. */
function fixture({
  latestVideos,
  part = "brand",
}: { latestVideos?: string[]; part?: "brand" | "campaign" } = {}) {
  const profiles: Profile[] = [
    {
      id: "profile-a",
      name: "All-In demo",
      audience: "Builders",
      brand_context: "Keep meaning",
      objective: "discovery",
      primary_metric: null,
      creative_preferences: "Meaning first",
      production_history: [{ id: "read-only-history" }],
    } as Profile,
    {
      id: "profile-b",
      name: "Separate profile",
      audience: "Other audience",
      brand_context: "Other context",
      objective: "traffic",
      primary_metric: "qualified_visits",
      creative_preferences: "Different direction",
    },
  ];
  const campaign: Campaign = {
    id: "campaign-a",
    name: "Campaign A",
    brief: {
      audience: "Builders",
      constraints: ["Keep meaning"],
      requested_outputs: ["Vertical clips"],
      measurement_intent: "Discovery",
    },
    profile_ids: ["profile-a", "profile-b"],
    video_ids: ["source-a"],
    objective: "discovery",
    primary_metric: null,
    notes: "",
    // Legacy pointer from before workspace rules; settings saves must keep it.
    active_strategy_id: "version-a",
  };
  // The saved service state may be newer than the screen (e.g. footage attached
  // in Factory after this screen loaded).
  const store = {
    profiles: clone(profiles),
    campaigns: [
      { ...clone(campaign), video_ids: latestVideos ?? campaign.video_ids },
    ],
  };
  const api = {
    campaigns: vi
      .spyOn(workspaceApi, "campaigns")
      .mockImplementation(async () => clone(store.campaigns)),
    profiles: vi
      .spyOn(workspaceApi, "profiles")
      .mockImplementation(async () => clone(store.profiles)),
    updateProfile: vi
      .spyOn(workspaceApi, "updateProfile")
      .mockImplementation(async (id, body) => {
        const row = store.profiles.find((p) => p.id === id);
        if (!row) throw new ApiError("Profile not found", 404);
        Object.assign(row, body);
        return clone(row);
      }),
    save: vi.spyOn(workspaceApi, "save").mockImplementation(async (body, id) => {
      const row = store.campaigns.find((c) => c.id === id);
      if (!row) throw new ApiError("Campaign not found", 404);
      Object.assign(row, body);
      return clone(row);
    }),
    createProfile: vi.spyOn(workspaceApi, "profile"),
    propose: vi.spyOn(workspaceApi, "propose"),
    approve: vi.spyOn(workspaceApi, "approve"),
    render: vi.spyOn(workspaceApi, "render"),
    learn: vi.spyOn(workspaceApi, "learn"),
    upload: vi.spyOn(workspaceApi, "upload"),
  };
  const load = vi.fn(async () => {});
  // Mirrors useCampaignWorkspace.run: task, then refresh, boolean result.
  const run = vi.fn(async (task: () => Promise<unknown>) => {
    try {
      await task();
      await load();
      return true;
    } catch {
      return false;
    }
  });
  const w = {
    profiles,
    campaign,
    campaigns: [campaign],
    selected: campaign.id,
    profileId: "profile-a",
    versions: [],
    observations: [],
    loading: false,
    busy: false,
    error: "",
    notice: "",
    run,
    load,
    select: vi.fn(),
    setProfileId: vi.fn(),
    clearNotice: vi.fn(),
  } as unknown as Workspace;
  const factory = {
    loading: false,
    busy: false,
    errors: {},
    data: {
      videos: [
        { id: "source-a", name: "Source A", duration: 60 },
        { id: "source-b", name: "Source B", duration: 60 },
        { id: "source-new", name: "Source New", duration: 60 },
      ],
      clips: [],
      jobs: [],
    },
  } as unknown as FactoryState;
  const next = vi.fn(),
    onSaved = vi.fn(),
    onAccounts = vi.fn();
  const view = render(
    <Setup
      w={w}
      factory={factory}
      creating={false}
      next={next}
      onSaved={onSaved}
      onAccounts={onAccounts}
      part={part}
    />,
  );
  return { w, factory, api, store, next, onSaved, onAccounts, view, profiles, campaign };
}
const saveButton = () =>
  screen.getByRole("button", { name: /^Save (brand|goals)$/ });
function noSideEffects(api: ReturnType<typeof fixture>["api"]) {
  expect(api.createProfile).not.toHaveBeenCalled();
  expect(api.propose).not.toHaveBeenCalled();
  expect(api.approve).not.toHaveBeenCalled();
  expect(api.render).not.toHaveBeenCalled();
  expect(api.learn).not.toHaveBeenCalled();
  expect(api.upload).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("brand profile", () => {
  it("shows only brand fields, the links and one save action", () => {
    const { view, next, onAccounts } = fixture();
    expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo");
    expect(screen.getByLabelText("Who it's for")).toHaveValue("Builders");
    expect(screen.getByLabelText("Voice & boundaries")).toHaveValue("Keep meaning");
    // Campaign fields live in the Campaign brief, not here.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByLabelText("Campaign name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save brief" })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: /^Save/ }).map((b) => b.textContent),
    ).toEqual(["Save brand"]);
    expect(view.container.querySelector('input[type="file"]')).toBeNull();
    // Advanced is closed and holds the rarely used notes.
    const advanced = screen.getByLabelText("Advanced controls").closest("details")!;
    expect(advanced.open).toBe(false);
    expect(advanced).toContainElement(screen.getByLabelText("Extra creative notes"));
    fireEvent.click(screen.getByRole("button", { name: "Style rules" }));
    expect(next).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Connected accounts" }));
    expect(onAccounts).toHaveBeenCalledTimes(1);
    // No user-facing jargon on this screen.
    expect(view.container.textContent).not.toMatch(/workspace|snapshot|provenance|strategy version/i);
  });

  it("writes only the exact selected brand and leaves the campaign and the other brand unchanged", async () => {
    const { api, store, next, onSaved } = fixture({
      latestVideos: ["source-a", "source-new"],
    });
    fireEvent.change(screen.getByLabelText("Who it's for"), {
      target: { value: "Founders shipping AI products" },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.updateProfile).toHaveBeenCalledTimes(1);
    // No brand kit was edited, so none is sent (the saved one is kept by the service).
    expect(api.updateProfile).toHaveBeenCalledWith("profile-a", {
      name: "All-In demo",
      audience: "Founders shipping AI products",
      brand_context: "Keep meaning",
      creative_preferences: "Meaning first",
    });
    expect(api.save).not.toHaveBeenCalled();
    expect(store.profiles[1]).toEqual({
      id: "profile-b",
      name: "Separate profile",
      audience: "Other audience",
      brand_context: "Other context",
      objective: "traffic",
      primary_metric: "qualified_visits",
      creative_preferences: "Different direction",
    });
    expect(store.campaigns[0].active_strategy_id).toBe("version-a");
    expect(screen.getByRole("status")).toHaveTextContent("Saved and confirmed.");
    expect(next).not.toHaveBeenCalled();
    noSideEffects(api);
  });

  it("saves the brand kit only when it is edited, and checks it first", async () => {
    const { api, store, onSaved } = fixture();
    fireEvent.change(screen.getByLabelText("Logo (PNG file on this Mac)"), {
      target: { value: "logo.jpg" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("full path to a .png file");
    expect(saveButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Logo (PNG file on this Mac)"), {
      target: { value: "/Users/me/logo.png" },
    });
    fireEvent.change(screen.getByLabelText("Main colour"), {
      target: { value: "#123456" },
    });
    fireEvent.change(screen.getByLabelText("Font"), { target: { value: "Inter" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.updateProfile.mock.calls[0][1].brand_kit).toEqual({
      font_family: "Inter",
      primary_color: "#123456",
      accent_color: "#FFD400",
      logo_file: "/Users/me/logo.png",
    });
    expect(store.profiles[0].brand_kit?.primary_color).toBe("#123456");
    expect(api.save).not.toHaveBeenCalled();
  });

  it("never falls back to another brand when the selected one is no longer linked", async () => {
    const { api, store, onSaved } = fixture();
    store.campaigns[0].profile_ids = ["profile-b"];
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "no longer linked",
      ),
    );
    expect(api.updateProfile).not.toHaveBeenCalled();
    expect(api.save).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    noSideEffects(api);
  });

  it("keeps the draft after a definite failure and allows a retry", async () => {
    const { api, onSaved } = fixture();
    api.updateProfile.mockRejectedValueOnce(
      new ApiError("Profile name must not be blank.", 422),
    );
    fireEvent.change(screen.getByLabelText("Who it's for"), {
      target: { value: "Retained audience" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Nothing was saved. Your edits are still here.",
      ),
    );
    expect(api.save).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Who it's for")).toHaveValue("Retained audience");
    expect(onSaved).not.toHaveBeenCalled();
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("treats a lost response as unknown and blocks a repeat until readback", async () => {
    const { api, onSaved, store } = fixture();
    // The write lands, but the response is lost.
    api.updateProfile.mockImplementationOnce(async (id, body) => {
      Object.assign(store.profiles.find((p) => p.id === id)!, body);
      throw new ApiError("Cannot reach the local service.", 0);
    });
    fireEvent.change(screen.getByLabelText("Brand name"), {
      target: { value: "Renamed brand" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "may or may not have been written",
      ),
    );
    expect(api.save).not.toHaveBeenCalled();
    expect(saveButton()).toBeDisabled();
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check saved state" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Readback confirms every change is saved.",
      ),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(api.updateProfile).toHaveBeenCalledTimes(1);
    expect(store.profiles[0].name).toBe("Renamed brand");
    noSideEffects(api);
  });
});

describe("goals & brief (the default campaign)", () => {
  it("shows one goal control, the brief's own save and the goals save, without the word campaign", () => {
    const { view } = fixture({ part: "campaign" });
    // One automatic campaign per brand: no name field and no campaign wording.
    expect(screen.queryByLabelText("Campaign name")).toBeNull();
    expect(view.container.textContent).not.toMatch(/campaign|workspace|snapshot|provenance/i);
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(
      screen.getByRole("combobox", { name: "What are we working toward?" }),
    ).toHaveValue("discovery");
    expect(screen.getByRole("option", { name: /^Drive visits/ })).toBeTruthy();
    expect(screen.queryByLabelText("Brand name")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: /^Save/ }).map((b) => b.textContent),
    ).toEqual(["Save brief", "Save goals"]);
    expect(screen.getByRole("button", { name: "Save brief" })).toBeDisabled();
    expect(view.container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByLabelText("Primary metric")).toBeDisabled();
    expect(saveButton()).toBeEnabled();
    // Advanced: footage attachment and shared brands stay available.
    expect(screen.getByLabelText("Attach Source A")).toBeDisabled();
    expect(screen.getByLabelText("Attach Source B")).toBeEnabled();
    expect(screen.getByLabelText("Link Separate profile")).toBeChecked();
    expect(screen.getByRole("button", { name: "Create brand" })).toBeTruthy();
  });

  it("requires a metric only for goal-directed work", () => {
    fixture({ part: "campaign" });
    fireEvent.change(screen.getByLabelText("What are we working toward?"), {
      target: { value: "traffic" },
    });
    expect(saveButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Primary metric"), {
      target: { value: "full_episode_visits" },
    });
    expect(saveButton()).toBeEnabled();
  });

  it("writes only the campaign, keeps the latest brief and footage, and never touches a brand", async () => {
    const { api, onSaved } = fixture({
      part: "campaign",
      latestVideos: ["source-a", "source-new"],
    });
    fireEvent.change(screen.getByLabelText("What are we working toward?"), {
      target: { value: "traffic" },
    });
    fireEvent.change(screen.getByLabelText("Primary metric"), {
      target: { value: " full_episode_visits " },
    });
    fireEvent.click(screen.getByLabelText("Attach Source B"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.updateProfile).not.toHaveBeenCalled();
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenCalledWith(
      {
        name: "Campaign A",
        // The brief is saved by Save brief; this save keeps the latest saved brief exactly.
        brief: {
          audience: "Builders",
          constraints: ["Keep meaning"],
          requested_outputs: ["Vertical clips"],
          measurement_intent: "Discovery",
        },
        profile_ids: ["profile-a", "profile-b"],
        video_ids: ["source-a", "source-new", "source-b"],
        // The goal belongs to this campaign, not the shared brand.
        objective: "traffic",
        primary_metric: "full_episode_visits",
        notes: "",
      },
      "campaign-a",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Saved and confirmed.");
    noSideEffects(api);
  });

  it("keeps the draft after a rejected save and needs no readback for a definite refusal", async () => {
    const { api, onSaved, store } = fixture({ part: "campaign" });
    api.save.mockRejectedValueOnce(new ApiError("Conflict", 409));
    fireEvent.change(screen.getByLabelText("Notes for the agents"), {
      target: { value: "Favour founders" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Nothing was saved"),
    );
    expect(store.campaigns[0].notes).toBe("");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Notes for the agents")).toHaveValue("Favour founders");
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(store.campaigns[0].notes).toBe("Favour founders");
    expect(api.updateProfile).not.toHaveBeenCalled();
  });

  it("treats a lost campaign response as unknown and reads back before another save", async () => {
    const { api, onSaved, store } = fixture({ part: "campaign" });
    api.save.mockImplementationOnce(async () => {
      throw new ApiError("Cannot reach the local service.", 0);
    });
    fireEvent.change(screen.getByLabelText("Notes for the agents"), {
      target: { value: "Favour founders" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "may or may not have been written",
      ),
    );
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check saved state" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Readback: not saved. Your edits are still here; saving again is now safe.",
      ),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(store.campaigns[0].notes).toBe("");
    expect(saveButton()).toBeEnabled();
    noSideEffects(api);
  });

  it("shows the campaign name only once a brand has a second campaign", () => {
    const { w, factory } = fixture({ part: "campaign" });
    cleanup();
    (w as { campaigns: Campaign[] }).campaigns = [
      w.campaign!,
      { ...w.campaign!, id: "campaign-b", name: "Launch week" },
    ];
    render(
      <Setup w={w} factory={factory} creating={false} next={vi.fn()} onSaved={vi.fn()} part="campaign" />,
    );
    expect(screen.getByLabelText("Campaign name")).toHaveValue("Campaign A");
  });

  it("creates a brand only by explicit action and links it on save", async () => {
    const { api } = fixture({ part: "campaign" });
    api.createProfile.mockResolvedValueOnce({
      id: "profile-c",
      name: "New clips",
      audience: "Builders",
      brand_context: "",
      objective: "discovery",
      primary_metric: null,
      creative_preferences: "",
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.createProfile).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("New brand name"), {
      target: { value: "New clips" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create brand" }));
    await waitFor(() => expect(api.createProfile).toHaveBeenCalledTimes(1));
  });
});

describe("app routing", () => {
  const originalUrl =
    window.location.pathname + window.location.search + window.location.hash;
  afterEach(() => window.history.replaceState(null, "", originalUrl));
  it("still opens Results for #connections", async () => {
    resetPreview();
    localStorage.setItem("growth-view-v2", "setup");
    window.history.replaceState(null, "", "/#connections");
    render(<GrowthApp />);
    const main = await screen.findByRole("main");
    expect(
      await within(main).findByRole("heading", { name: "Results & next test" }),
    ).toBeTruthy();
    expect(
      within(main).queryByRole("heading", { name: "Brand profile" }),
    ).toBeNull();
  });
});

describe("campaign brief in the Campaign brief screen", () => {
  const addChip = (label: string, value: string) => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: `Add to ${label}` }));
  };

  it("saves only the brief with an exact campaign PUT, keeps membership and reads it back", async () => {
    const { api, store } = fixture({ part: "campaign", latestVideos: ["source-a", "source-new"] });
    addChip("Key messages", "Agents need human review");
    addChip("Must avoid", "market predictions");
    fireEvent.change(screen.getByLabelText("Call to action"), {
      target: { value: "Listen to the full episode" },
    });
    expect(screen.getByRole("list", { name: "Key messages" })).toHaveTextContent(
      "Agents need human review",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save brief" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Brief saved and confirmed."),
    );
    expect(api.updateProfile).not.toHaveBeenCalled();
    expect(api.save).toHaveBeenCalledTimes(1);
    const [body, id] = api.save.mock.calls[0];
    expect(id).toBe("campaign-a");
    // Every other field comes from the latest saved record, membership included.
    expect({ ...body, brief: undefined }).toEqual({
      name: "Campaign A",
      brief: undefined,
      profile_ids: ["profile-a", "profile-b"],
      video_ids: ["source-a", "source-new"],
      objective: "discovery",
      primary_metric: null,
      notes: "",
    });
    expect(body.brief).toMatchObject({
      audience: "Builders",
      constraints: ["Keep meaning"],
      key_messages: ["Agents need human review"],
      must_avoid: ["market predictions"],
      cta: "Listen to the full episode",
      cta_link: null,
    });
    expect(store.campaigns[0].brief.cta).toBe("Listen to the full episode");
  });

  it("blocks an invalid brief and reports an unconfirmed save", async () => {
    const { api } = fixture({ part: "campaign" });
    addChip("Must include", "crypto");
    addChip("Must avoid", "Crypto");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A topic can't be both must-include and must-avoid.",
    );
    expect(screen.getByRole("button", { name: "Save brief" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Crypto" }));
    api.save.mockImplementation(async () => ({}) as Campaign); // written nowhere
    fireEvent.click(screen.getByRole("button", { name: "Save brief" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("may or may not have been saved"),
    );
  });
});
