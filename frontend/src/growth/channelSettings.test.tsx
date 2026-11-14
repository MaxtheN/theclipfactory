import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
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
function fixture({ latestVideos }: { latestVideos?: string[] } = {}) {
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
    onSaved = vi.fn();
  const view = render(
    <Setup
      w={w}
      factory={factory}
      creating={false}
      next={next}
      onSaved={onSaved}
    />,
  );
  return { w, factory, api, store, next, onSaved, view, profiles, campaign };
}
const saveButton = () =>
  screen.getByRole("button", { name: "Save channel settings" });
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

describe("unified channel settings", () => {
  it("shows one goal control, one save action and no duplicate upload box", () => {
    const { view } = fixture();
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(
      screen.getByRole("combobox", { name: "What are we working toward?" }),
    ).toHaveValue("discovery");
    expect(screen.getByRole("option", { name: /^Drive visits/ })).toBeTruthy();
    expect(screen.queryByLabelText("Campaign brief intent")).toBeNull();
    expect(screen.queryByLabelText("Production objective")).toBeNull();
    expect(screen.queryByRole("button", { name: /Save profile goal/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save & find direction/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Save/ })).toHaveLength(1);
    expect(view.container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText("Add an episode")).toBeNull();
    // Discovery needs no metric.
    expect(screen.getByLabelText("Primary metric")).toBeDisabled();
    expect(saveButton()).toBeEnabled();
    // Advanced: existing footage attachment and linked profiles stay available.
    expect(screen.getByLabelText("Attach Source A")).toBeDisabled();
    expect(screen.getByLabelText("Attach Source B")).toBeEnabled();
    expect(screen.getByLabelText("Link Separate profile")).toBeChecked();
    expect(screen.getByRole("button", { name: "Create profile" })).toBeTruthy();
  });

  it("requires a metric only for goal-directed work", () => {
    fixture();
    fireEvent.change(screen.getByLabelText("What are we working toward?"), {
      target: { value: "traffic" },
    });
    expect(saveButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Primary metric"), {
      target: { value: "full_episode_visits" },
    });
    expect(saveButton()).toBeEnabled();
  });

  it("writes the exact selected profile, leaves the other unchanged and preserves latest footage", async () => {
    const { api, store, next, onSaved } = fixture({
      latestVideos: ["source-a", "source-new"],
    });
    fireEvent.change(screen.getByLabelText("Who are we speaking to?"), {
      target: { value: "Founders shipping AI products" },
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
    expect(api.updateProfile).toHaveBeenCalledTimes(1);
    expect(api.updateProfile).toHaveBeenCalledWith("profile-a", {
      name: "All-In demo",
      audience: "Founders shipping AI products",
      brand_context: "Keep meaning",
      creative_preferences: "Meaning first",
      objective: "traffic",
      primary_metric: "full_episode_visits",
    });
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenCalledWith(
      {
        name: "Campaign A",
        brief: {
          audience: "Founders shipping AI products",
          constraints: ["Keep meaning"],
          requested_outputs: ["Vertical clips"],
          measurement_intent:
            "Drive visits, such as full episodes (traffic): full_episode_visits",
        },
        profile_ids: ["profile-a", "profile-b"],
        video_ids: ["source-a", "source-new", "source-b"],
      },
      "campaign-a",
    );
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

  it("never falls back to another profile when the selected one is no longer linked", async () => {
    const { api, store, onSaved } = fixture();
    store.campaigns[0].profile_ids = ["profile-b"];
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "no longer linked to this channel",
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
    fireEvent.change(screen.getByLabelText("Who are we speaking to?"), {
      target: { value: "Retained audience" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The profile was not saved, so nothing changed",
      ),
    );
    expect(api.save).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Who are we speaking to?")).toHaveValue(
      "Retained audience",
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("reports a partial save and requires readback before saving again", async () => {
    const { api, onSaved, store } = fixture();
    api.save.mockRejectedValueOnce(new ApiError("Conflict", 409));
    fireEvent.change(screen.getByLabelText("Channel name"), {
      target: { value: "Renamed channel" },
    });
    fireEvent.change(screen.getByLabelText("Creative preferences"), {
      target: { value: "Claim first" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Partially saved"),
    );
    expect(store.profiles[0].creative_preferences).toBe("Claim first");
    expect(store.campaigns[0].name).toBe("Campaign A");
    expect(onSaved).not.toHaveBeenCalled();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByLabelText("Channel name")).toHaveValue("Renamed channel");
    fireEvent.click(screen.getByRole("button", { name: "Check saved state" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "profile settings saved; channel details not saved",
      ),
    );
    expect(saveButton()).toBeEnabled();
    expect(screen.getByLabelText("Channel name")).toHaveValue("Renamed channel");
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(store.campaigns[0].name).toBe("Renamed channel");
  });

  it("treats a lost response as unknown and blocks a repeat until readback", async () => {
    const { api, onSaved, store } = fixture();
    // The write lands, but the response is lost.
    api.updateProfile.mockImplementationOnce(async (id, body) => {
      Object.assign(store.profiles.find((p) => p.id === id)!, body);
      throw new ApiError("Cannot reach the local service.", 0);
    });
    fireEvent.change(screen.getByLabelText("Channel name"), {
      target: { value: "Renamed channel" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "may or may not have been written",
      ),
    );
    expect(api.save).not.toHaveBeenCalled();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check saved state" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "profile settings saved; channel details not saved",
      ),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(saveButton()).toBeEnabled();
    expect(api.updateProfile).toHaveBeenCalledTimes(1);
    noSideEffects(api);
  });

  it("opens style rules only through the explicit action", async () => {
    const { next, onSaved } = fixture();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(next).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Style rules" }));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("creates a profile only by explicit action and links it on save", async () => {
    const { api } = fixture();
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
    fireEvent.change(screen.getByLabelText("New profile name"), {
      target: { value: "New clips" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
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
      within(main).queryByRole("heading", { name: "Channel settings" }),
    ).toBeNull();
  });
});
