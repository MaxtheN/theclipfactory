import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Campaign, Clip, Job, Profile } from "../types";
import { previewRequest, resetPreview } from "./previewApi";

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
vi.mock("./workspaceApi", async () => {
  const actual =
    await vi.importActual<typeof import("./workspaceApi")>("./workspaceApi");
  return { ...actual, reviewPreview: true };
});
import { GrowthApp } from "./GrowthApp";
import { workspaceApi } from "./workspaceApi";
import { LAUNCH_FADE_MS, LAUNCH_SWEEP_MS } from "./LaunchTransition";

const showModal = HTMLDialogElement.prototype.showModal;
const close = HTMLDialogElement.prototype.close;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterAll(() => {
  HTMLDialogElement.prototype.showModal = showModal;
  HTMLDialogElement.prototype.close = close;
});
beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(
      (query: string) =>
        ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
        }) as MediaQueryList,
    ),
  );
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  resetPreview();
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

async function enterOnboarding(viaQuickActions = false) {
  const workspace = await screen.findByRole("combobox", {
    name: "Current brand",
  });
  await waitFor(() => expect(workspace).toHaveValue("preview-profile-allin"));
  if (viaQuickActions) {
    fireEvent.click(screen.getByRole("button", { name: "Open quick actions" }));
    const search = screen.getByRole("combobox", {
      name: "Search quick actions",
    });
    fireEvent.change(search, { target: { value: "new brand" } });
    fireEvent.keyDown(search, { key: "Enter" });
  } else {
    // New workspace lives in Workspace settings → Advanced, not the sidebar.
    fireEvent.click(screen.getByRole("button", { name: "Brand profile" }));
    screen
      .getByLabelText("Advanced controls")
      .closest("details")
      ?.setAttribute("open", "");
    fireEvent.click(screen.getByRole("button", { name: "New brand" }));
  }
  await skipWebsite();
  return screen.findByRole("heading", { name: "Who are we making this for?" });
}
/** Onboarding opens with "What’s your website?"; these tests cover the typed path. */
async function skipWebsite() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Skip" }),
  );
}
function next() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("standalone onboarding shell", () => {
  it("starts a new workspace with the questions and leaves the account for the last step", async () => {
    localStorage.setItem("gf.preview.cloud", "1");
    const campaigns = vi
      .spyOn(workspaceApi, "campaigns")
      .mockResolvedValueOnce([]);
    try {
      render(<GrowthApp />);
      await skipWebsite();
      await screen.findByRole("heading", {
        name: "Who are we making this for?",
      });
      expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: /Sign in to Growth Factory/ }),
      ).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.getByRole("progressbar", { name: "Setup progress" }),
        ).toHaveAttribute("aria-valuemax", "5"),
      );
      expect(
        screen.getByRole("button", { name: "Go to Your account" }),
      ).toBeDisabled();
    } finally {
      campaigns.mockRestore();
    }
  });
  it("holds the natural first-run launch screen after the refreshed campaign becomes usable", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(
        (query: string) => ({ matches: false, media: query }) as MediaQueryList,
      ),
    );
    const before = await Promise.all([
      previewRequest<Profile[]>("/api/profiles"),
      previewRequest<Campaign[]>("/api/campaigns"),
    ]);
    const campaigns = vi
      .spyOn(workspaceApi, "campaigns")
      .mockResolvedValueOnce([]);
    try {
      render(<GrowthApp />);
      await skipWebsite();
      await screen.findByRole("heading", {
        name: "Who are we making this for?",
      });
      expect(window.location.hash).toBe("");
      expect(
        screen.queryByRole("button", { name: "Back to Factory" }),
      ).not.toBeInTheDocument();
      fireEvent.change(
        screen.getByRole("textbox", { name: "Name your brand / podcast" }),
        {
          target: { value: "First-run workspace" },
        },
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: "Who are we speaking to?" }),
        {
          target: { value: "First-time podcast producers" },
        },
      );
      next();
      fireEvent.click(screen.getByRole("button", { name: "Explore first" }));
      next();
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Launch" }),
        );
      });
      const ready = screen.getByRole("status", {
        name: "Your brand is ready",
      });
      expect(ready).toBeVisible();
      expect(campaigns).toHaveBeenCalledTimes(2);
      expect(
        screen.queryByRole("navigation", { name: "Main navigation" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Factory" }),
      ).not.toBeInTheDocument();
      const savedProfiles = await previewRequest<Profile[]>("/api/profiles");
      const savedCampaigns = await previewRequest<Campaign[]>("/api/campaigns");
      expect(savedProfiles).toHaveLength(before[0].length + 1);
      expect(savedCampaigns).toHaveLength(before[1].length + 1);
      const saved = savedCampaigns.find(
        // The first campaign is named after the brand automatically.
        (campaign) => campaign.name === "First-run workspace — main",
      )!;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LAUNCH_SWEEP_MS);
      });
      expect(ready).toBeVisible();
      expect(
        screen.queryByRole("navigation", { name: "Main navigation" }),
      ).not.toBeInTheDocument();
      const track = ready.querySelector('[aria-hidden="true"]')!;
      const arrived = createEvent.animationEnd(track);
      Object.defineProperty(arrived, "animationName", {
        value: "gf-launch-arrive",
      });
      fireEvent(track, arrived);
      expect(ready).toBeVisible();
      expect(ready).toHaveAttribute("data-exiting", "true");
      expect(
        screen.queryByRole("heading", { name: "Factory" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("navigation", { name: "Main navigation" }),
      ).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LAUNCH_FADE_MS - 1);
      });
      expect(
        screen.queryByRole("heading", { name: "Factory" }),
      ).not.toBeInTheDocument();
      const departed = createEvent.animationEnd(ready);
      Object.defineProperty(departed, "animationName", {
        value: "gf-launch-depart",
      });
      fireEvent(ready, departed);
      expect(screen.getByRole("heading", { name: "Factory" })).toHaveFocus();
      expect(
        screen.getByRole("navigation", { name: "Main navigation" }),
      ).toBeVisible();
      expect(localStorage.getItem("growth-campaign")).toBe(saved.id);
      expect(
        screen.queryByRole("region", { name: "Brand onboarding" }),
      ).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.getAllByRole("heading", { name: "Factory" })).toHaveLength(
        1,
      );
      expect(await previewRequest<Profile[]>("/api/profiles")).toEqual(
        savedProfiles,
      );
      expect(await previewRequest<Campaign[]>("/api/campaigns")).toEqual(
        savedCampaigns,
      );
    } finally {
      campaigns.mockRestore();
      vi.useRealTimers();
    }
  });

  it("opens the preview hash without replacing saved workspace data and restores it on cancel", async () => {
    window.history.replaceState(null, "", "/#onboarding");
    localStorage.setItem("growth-view-v2", "setup");
    localStorage.setItem("retained-workspace-draft", "An existing draft");
    const before = await Promise.all([
      previewRequest<Profile[]>("/api/profiles"),
      previewRequest<Campaign[]>("/api/campaigns"),
    ]);
    render(<GrowthApp />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    const question = screen.getByRole("heading", {
      name: "Who are we making this for?",
    });
    expect(question).toHaveFocus();
    expect(screen.getByLabelText("Name your brand / podcast")).toHaveValue("");
    expect(
      screen.getByRole("textbox", { name: "Who are we speaking to?" }),
    ).toHaveValue("");
    expect(
      screen.queryByRole("navigation", { name: "Main navigation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open quick actions" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(
      screen.queryByRole("dialog", { name: "Quick actions" }),
    ).not.toBeInTheDocument();
    const cancel = await screen.findByRole("button", {
      name: "Back to Factory",
    });
    expect(await previewRequest<Profile[]>("/api/profiles")).toEqual(before[0]);
    expect(await previewRequest<Campaign[]>("/api/campaigns")).toEqual(
      before[1],
    );
    expect(localStorage.getItem("retained-workspace-draft")).toBe(
      "An existing draft",
    );
    fireEvent.click(cancel);
    fireEvent.click(await screen.findByRole("button", { name: "Brand & voice" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit brand details" }));
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", {
          name: "Who it's for",
        }),
      ).toHaveValue("Builders and founders"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Brand, audience & voice" }));
    expect(
      screen.getByRole("combobox", { name: "Current brand" }),
    ).toHaveValue("preview-profile-allin");
    expect(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Brand onboarding" }),
    ).not.toBeInTheDocument();
    expect(window.location.hash).toBe("#onboarding");
    expect(await previewRequest<Profile[]>("/api/profiles")).toEqual(before[0]);
    expect(await previewRequest<Campaign[]>("/api/campaigns")).toEqual(
      before[1],
    );
    expect(localStorage.getItem("retained-workspace-draft")).toBe(
      "An existing draft",
    );
  });

  it("exits a direct onboarding preview after explicit launch while the hash remains", async () => {
    window.history.replaceState(null, "", "/#onboarding");
    const before = await Promise.all([
      previewRequest<Profile[]>("/api/profiles"),
      previewRequest<Campaign[]>("/api/campaigns"),
    ]);
    render(<GrowthApp />);
    await screen.findByRole("button", { name: "Back to Factory" });
    await skipWebsite();
    fireEvent.change(screen.getByLabelText("Name your brand / podcast"), {
      target: { value: "Direct preview workspace" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Who are we speaking to?" }),
      {
        target: { value: "Independent podcast creators" },
      },
    );
    next();
    fireEvent.click(screen.getByRole("button", { name: "Explore first" }));
    next();
    expect(
      screen.getByRole("heading", { name: "Review your brand" }),
    ).toHaveFocus();
    expect(await previewRequest<Profile[]>("/api/profiles")).toEqual(before[0]);
    expect(await previewRequest<Campaign[]>("/api/campaigns")).toEqual(
      before[1],
    );
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await screen.findByRole("heading", { name: "Factory" });
    const profiles = await previewRequest<Profile[]>("/api/profiles");
    const campaigns = await previewRequest<Campaign[]>("/api/campaigns");
    expect(profiles).toHaveLength(before[0].length + 1);
    expect(campaigns).toHaveLength(before[1].length + 1);
    const saved = campaigns.find(
      (campaign) => campaign.name === "Direct preview workspace — main",
    )!;
    expect(
      profiles.find((profile) => profile.id === saved.profile_ids[0]),
    ).toMatchObject({ audience: "Independent podcast creators" });
    // The goal is the campaign's own.
    expect(saved).toMatchObject({ objective: "discovery", primary_metric: null });
    expect(localStorage.getItem("growth-campaign")).toBe(saved.id);
    expect(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Brand onboarding" }),
    ).not.toBeInTheDocument();
    expect(window.location.hash).toBe("#onboarding");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Quick actions" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Who are we making this for?" }),
    ).not.toBeInTheDocument();
  });

  it("isolates the wizard from app chrome/shortcuts and preserves the mounted workspace draft on cancel", async () => {
    localStorage.setItem("growth-view-v2", "setup");
    render(<GrowthApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Brand & voice" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit brand details" }));
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Who it's for" }),
      ).toHaveValue("Builders and founders"),
    );
    const audience = screen.getByRole("textbox", {
      name: "Who it's for",
    });
    fireEvent.change(audience, {
      target: { value: "An unsaved workspace audience" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close Brand, audience & voice" }));
    const question = await enterOnboarding();
    expect(question).toHaveFocus();
    expect(
      screen.queryByRole("navigation", { name: "Main navigation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open quick actions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Current brand" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Set up your brand" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(
      screen.queryByRole("dialog", { name: "Quick actions" }),
    ).not.toBeInTheDocument();
    expect(question).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Back to Factory" }));
    expect(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const search = screen.getByRole("combobox", {
      name: "Search quick actions",
    });
    fireEvent.change(search, { target: { value: "brand profile" } });
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Brand & voice" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit brand details" }));
    expect(
      screen.getByRole("textbox", { name: "Who it's for" }),
    ).toHaveValue("An unsaved workspace audience");
  });
  it("saves only on explicit final launch and restores Factory with the created workspace/profile scope", async () => {
    const before = await Promise.all([
      previewRequest<Profile[]>("/api/profiles"),
      previewRequest<Campaign[]>("/api/campaigns"),
      previewRequest<Job[]>("/api/jobs"),
      previewRequest<Clip[]>("/api/clips"),
    ]);
    render(<GrowthApp />);
    await enterOnboarding(true);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Name your brand / podcast" }),
      { target: { value: "Producer launch test" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Who are we speaking to?" }),
      { target: { value: "Podcast producers and company marketers" } },
    );
    next();
    fireEvent.click(screen.getByRole("radio", { name: /^Reach new people/ }));
    next();
    fireEvent.click(
      screen.getByRole("radio", { name: /^A strong point of view/ }),
    );
    next();
    expect(
      screen.getByRole("heading", { name: "Review your brand" }),
    ).toHaveFocus();
    expect(await previewRequest<Profile[]>("/api/profiles")).toHaveLength(
      before[0].length,
    );
    expect(await previewRequest<Campaign[]>("/api/campaigns")).toHaveLength(
      before[1].length,
    );
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await screen.findByRole("heading", { name: "Factory" });
    expect(
      screen.queryByRole("dialog", { name: "Quick actions" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Factory" })).toHaveFocus();
    expect(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Open quick actions" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Brand onboarding" }),
    ).not.toBeInTheDocument();
    const profiles = await previewRequest<Profile[]>("/api/profiles");
    const campaigns = await previewRequest<Campaign[]>("/api/campaigns");
    expect(profiles).toHaveLength(before[0].length + 1);
    expect(campaigns).toHaveLength(before[1].length + 1);
    const saved = campaigns.find((c) => c.name === "Producer launch test — main")!;
    const profile = profiles.find((p) => p.id === saved.profile_ids[0])!;
    expect(profile).toMatchObject({
      audience: "Podcast producers and company marketers",
    });
    expect(saved).toMatchObject({ objective: "awareness", primary_metric: "reach" });
    expect(profile.creative_preferences).toContain("A strong point of view");
    expect(localStorage.getItem("growth-campaign")).toBe(saved.id);
    expect(
      screen.queryByRole("combobox", { name: "Current campaign" }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem("growth-profile")).toBe(profile.id);
    expect(await previewRequest<Job[]>("/api/jobs")).toHaveLength(
      before[2].length,
    );
    expect(await previewRequest<Clip[]>("/api/clips")).toHaveLength(
      before[3].length,
    );
  });
});
