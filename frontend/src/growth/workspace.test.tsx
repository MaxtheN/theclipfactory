import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { previewRequest, resetPreview } from "./previewApi";
import type { Campaign, Clip, Job, Profile, StrategyVersion } from "../types";

// Full-app journeys traverse persistent panels and async saves. Give these
// integration tests a bounded CI budget; unit files keep Vitest's 5-second default.
vi.setConfig({ testTimeout: 15_000 });

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
import { GrowthApp } from "./GrowthApp";
const path = "/api/campaigns/preview-campaign";
// Style rules belong to the workspace (profile), inherited by its campaigns.
const workspacePath = "/api/profiles/preview-profile-allin";
const rules = `${workspacePath}/strategies`;
const activeRules = async () =>
  (await previewRequest<Profile>(workspacePath)).active_strategy_id ?? null;
const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});
const send = <T,>(p: string, b: unknown = {}, method = "POST") =>
  previewRequest<T>(p, { method, body: JSON.stringify(b) });
beforeEach(() => {
  localStorage.clear();
  resetPreview();
  // These regressions exercise editable channel settings; the new daily
  // Factory/default/onboarding flow has separate coverage.
  localStorage.setItem("growth-view-v2", "setup");
});

function openBrandEditor() {
  fireEvent.click(screen.getByRole("button", { name: "Brand & voice" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit brand details" }));
  return screen.getByRole("dialog", { name: "Brand, audience & voice" });
}
function closeBrandEditor() {
  fireEvent.click(screen.getByRole("button", { name: "Close Brand, audience & voice" }));
}

function openEditingRules() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const search = screen.getByRole("combobox", { name: "Search quick actions" });
  fireEvent.change(search, { target: { value: "style rules" } });
  fireEvent.keyDown(search, { key: "Enter" });
}

describe("Growth Factory interface", () => {
  it("opens native Factory-map rehearsal from Results without an embedded website", async () => {
    localStorage.setItem("growth-view-v2", "results");
    render(<GrowthApp />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Current brand" })).toHaveValue("preview-profile-allin"));
    fireEvent.click(screen.getByRole("button", { name: /^Insights\b/ }));
    fireEvent.click(screen.getByRole("button", { name: "Rehearse the loop" }));
    expect(await screen.findByRole("tab", { name: "Factory map" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Demo rehearsal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Factory" })).toBeVisible();
    expect(document.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Real work" }));
    expect(screen.getByRole("button", { name: "Real work" })).toHaveAttribute("aria-pressed", "true");
    const profiles = within(screen.getByRole("combobox", { name: "Current brand" })).getAllByRole("option").map(option => (option as HTMLOptionElement).value);
    const other = profiles.find(id => id !== "preview-profile-allin" && id !== "__new__");
    expect(other).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Current brand" }), { target: { value: other } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Current brand" })).toHaveValue(other));
    expect(screen.getByRole("button", { name: "Real work" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches workspaces without changing campaign membership and shows the campaign picker only for several campaigns", async () => {
    const original = await previewRequest<Campaign>(path);
    const first = render(<GrowthApp />);
    const workspaces = await screen.findByRole("combobox", { name: "Current brand" });
    await waitFor(() => expect(workspaces).toHaveValue("preview-profile-allin"));
    const names = (select: HTMLElement) =>
      within(select).getAllByRole("option").map((o) => (o as HTMLOptionElement).value).filter((v) => v !== "__new__");
    expect(names(workspaces)).toEqual(["preview-profile-allin", "preview-profile-test"]);
    // One campaign in this workspace: no picker.
    expect(screen.queryByRole("combobox", { name: "Current campaign" })).not.toBeInTheDocument();
    expect((await previewRequest<Campaign>(path)).profile_ids).toEqual(original.profile_ids);
    first.unmount();
    // Existing membership is append-only, so use a separate single-workspace campaign.
    const single = await send<Campaign>("/api/campaigns", { name: "Single-workspace campaign", brief: original.brief, video_ids: [], profile_ids: ["preview-profile-allin"] });
    localStorage.setItem("growth-campaign", single.id);
    render(<GrowthApp />);
    const picker = await screen.findByRole("combobox", { name: "Current campaign" });
    await waitFor(() => expect(picker).toHaveValue(single.id));
    expect(within(picker).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual(["preview-campaign", single.id, "__brief__", "__new_campaign__"]);
    await waitFor(() => expect(localStorage.getItem("growth-profile")).toBe("preview-profile-allin"));
    // The other workspace is not linked to this campaign: switching opens its own campaign.
    fireEvent.change(screen.getByRole("combobox", { name: "Current brand" }), { target: { value: "preview-profile-test" } });
    await waitFor(() => expect(localStorage.getItem("growth-campaign")).toBe("preview-campaign"));
    await waitFor(() => expect(localStorage.getItem("growth-profile")).toBe("preview-profile-test"));
    expect(screen.queryByRole("combobox", { name: "Current campaign" })).not.toBeInTheDocument();
    expect((await previewRequest<Campaign>(path)).profile_ids).toEqual(original.profile_ids);
    expect((await previewRequest<Campaign>(`/api/campaigns/${single.id}`)).profile_ids).toEqual(["preview-profile-allin"]);
  });
  it("creates a campaign inside the current workspace only, without touching the workspace or other campaigns", async () => {
    const original = await previewRequest<Campaign>(path);
    const profilesBefore = await previewRequest<unknown[]>("/api/profiles");
    render(<GrowthApp />);
    await waitFor(() => expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"));
    // A separate push (campaign) is an advanced, explicit choice on Brand profile.
    screen.getByLabelText("Advanced controls").closest("details")?.setAttribute("open", "");
    fireEvent.click(screen.getByRole("button", { name: "Run a separate push (campaign)" }));
    expect(await screen.findByRole("heading", { name: "New campaign" })).toBeVisible();
    const form = screen.getByRole("region", { name: "New campaign" });
    fireEvent.change(within(form).getByLabelText("Campaign name"), { target: { value: "Episode 210 launch" } });
    fireEvent.change(within(form).getByLabelText("Key messages"), { target: { value: "Agents need review" } });
    fireEvent.keyDown(within(form).getByLabelText("Key messages"), { key: "Enter" });
    fireEvent.change(within(form).getByLabelText("Call to action"), { target: { value: "Listen to the full episode" } });
    fireEvent.change(within(form).getByLabelText("Must avoid"), { target: { value: "market predictions" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add to Must avoid" }));
    fireEvent.click(within(form).getByRole("button", { name: /^Create campaign\b/ }));
    const picker = await screen.findByRole("combobox", { name: "Current campaign" });
    const campaigns = await previewRequest<Campaign[]>("/api/campaigns");
    const created = campaigns.find((c) => c.name === "Episode 210 launch")!;
    expect(created.profile_ids).toEqual(["preview-profile-allin"]);
    expect(created.objective).toBe("discovery");
    // The brief carries only what this campaign adds; workspace boundaries are not copied in.
    expect(created.brief).toMatchObject({ key_messages: ["Agents need review"], cta: "Listen to the full episode",
      must_avoid: ["market predictions"], constraints: [], audience: "" });
    // No campaign approval chain: it inherits the workspace's rules.
    expect(created.active_strategy_id).toBeUndefined();
    await waitFor(() => expect(picker).toHaveValue(created.id));
    expect(await previewRequest<Campaign>(path)).toEqual(original);
    expect(await previewRequest<unknown[]>("/api/profiles")).toEqual(profilesBefore);
  });
  it("keeps daily navigation focused and opens style rules only through an explicit channel or footage action", async () => {
    localStorage.setItem("growth-view-v2", "factory");
    render(<GrowthApp />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Current brand" })).toHaveValue("preview-profile-allin"));
    const daily = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(daily).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(["Factory", "Library", "Results"]);
    expect(screen.queryByRole("button", { name: "Channel settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Creative direction" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Brand profile" })).toBeVisible();
    // Rare workspace actions live in one Advanced section inside Channel settings, not the sidebar.
    expect(screen.queryByRole("navigation", { name: "Advanced navigation" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Brand profile" }));
    expect(screen.getByRole("heading", { name: "Brand profile" })).toHaveFocus();
    screen.getByLabelText("Advanced controls").closest("details")?.setAttribute("open", "");
    const advanced = screen.getByRole("navigation", { name: "Advanced navigation" });
    expect(within(advanced).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(["New brand"]);
    openBrandEditor();
    fireEvent.change(screen.getByRole("textbox", { name: "Who it's for" }), { target: { value: "Channel-specific founders" } });
    fireEvent.click(screen.getByRole("button", { name: "Save brand" }));
    // The workspace audience is saved on the workspace; the campaign brief keeps its own.
    await waitFor(async () => expect((await previewRequest<{ audience: string }[]>("/api/profiles")).some((p) => p.audience === "Channel-specific founders")).toBe(true));
    expect((await previewRequest<Campaign>(path)).brief.audience).toBe("Builders and founders");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save brand" })).toBeNull());
    expect(screen.getByRole("heading", { name: "Brand profile" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Style rules" })).not.toBeInTheDocument();
    expect((await activeRules())).toBeNull();
    closeBrandEditor();
    fireEvent.click(screen.getByRole("button", { name: "Style rules" }));
    expect(screen.getByRole("heading", { name: "Style rules" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Back to Brand profile" }));
    expect(screen.getByRole("heading", { name: "Brand profile" })).toHaveFocus();
    openBrandEditor();
    expect(screen.getByRole("textbox", { name: "Who it's for" })).toHaveValue("Channel-specific founders");
    closeBrandEditor();
    fireEvent.click(within(daily).getByRole("button", { name: "Factory" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit full style rules" }));
    expect(screen.getByRole("heading", { name: "Style rules" })).toHaveFocus();
    expect((await activeRules())).toBeNull();
  });
  it("ignores the onboarding preview hash in the ordinary build", async () => {
    const originalUrl = window.location.pathname + window.location.search + window.location.hash;
    window.history.replaceState(null, "", "/#onboarding");
    try {
      render(<GrowthApp />);
      await waitFor(() =>
        expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"),
      );
      expect(screen.getByRole("combobox", { name: "Current brand" })).toHaveValue("preview-profile-allin");
      expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Who are we making this for?" })).not.toBeInTheDocument();
      expect(window.location.hash).toBe("#onboarding");
    } finally {
      window.history.replaceState(null, "", originalUrl);
    }
  });
  it("collapses and restores the sidebar without discarding the brief", async () => {
    render(<GrowthApp />);
    await waitFor(() =>
      expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"),
    );
    openBrandEditor();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Who it's for" }),
      {
        target: { value: "A retained audience" },
      },
    );
    closeBrandEditor();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(
      screen.queryByRole("navigation", { name: "Main navigation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand sidebar" }),
    ).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible();
    openBrandEditor();
    expect(
      screen.getByRole("textbox", { name: "Who it's for" }),
    ).toHaveValue("A retained audience");
  });
  it("opens quick actions by keyboard or click and preserves drafts through navigation", async () => {
    render(<GrowthApp />);
    await waitFor(() =>
      expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"),
    );
    openBrandEditor();
    const audience = screen.getByRole("textbox", {
      name: "Who it's for",
    });
    fireEvent.change(audience, { target: { value: "My unsaved audience" } });
    audience.focus();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const search = screen.getByRole("combobox", {
      name: "Search quick actions",
    });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(audience).toHaveFocus();
    closeBrandEditor();
    fireEvent.click(screen.getByRole("button", { name: "Open quick actions" }));
    fireEvent.change(search, { target: { value: "library" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "Library" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(search, { target: { value: "setup" } });
    fireEvent.keyDown(search, { key: "Enter" });
    openBrandEditor();
    expect(
      screen.getByRole("textbox", { name: "Who it's for" }),
    ).toHaveValue("My unsaved audience");
  });
  it("opens Goals from quick actions and closes editors when navigating away", async () => {
    render(<GrowthApp />);
    await waitFor(() => expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"));
    openBrandEditor();
    fireEvent.change(screen.getByRole("textbox", { name: "Who it's for" }), { target: { value: "A retained modal draft" } });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const search = screen.getByRole("combobox", { name: "Search quick actions" });
    fireEvent.change(search, { target: { value: "library" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "Library" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.change(search, { target: { value: "goals" } });
    fireEvent.keyDown(search, { key: "Enter" });
    const goals = await screen.findByRole("dialog", { name: "Goals & brief" });
    expect(within(goals).getByRole("combobox", { name: "What are we working toward?" })).toBeVisible();
    fireEvent.click(within(goals).getByRole("button", { name: "Close Goals & brief" }));
    openBrandEditor();
    expect(screen.getByRole("textbox", { name: "Who it's for" })).toHaveValue("A retained modal draft");
  });

  it("does not replay a handled Goals request when changing brand contexts", async () => {
    render(<GrowthApp />);
    const brand = await screen.findByRole("combobox", { name: "Current brand" });
    await waitFor(() => expect(brand).toHaveValue("preview-profile-allin"));
    function requestGoals() {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
      const search = screen.getByRole("combobox", { name: "Search quick actions" });
      fireEvent.change(search, { target: { value: "goals" } });
      fireEvent.keyDown(search, { key: "Enter" });
    }
    requestGoals();
    const goals = await screen.findByRole("dialog", { name: "Goals & brief" });
    fireEvent.click(within(goals).getByRole("button", { name: "Close Goals & brief" }));
    fireEvent.change(brand, { target: { value: "preview-profile-test" } });
    await waitFor(() => expect(screen.getByLabelText("Brand name")).toHaveValue("Test profile"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.change(brand, { target: { value: "preview-profile-allin" } });
    await waitFor(() => expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"));
    expect(screen.queryByRole("dialog")).toBeNull();
    requestGoals();
    expect(await screen.findByRole("dialog", { name: "Goals & brief" })).toBeVisible();
  });

  it("keeps new-workspace onboarding isolated from quick actions and app navigation", async () => {
    render(<GrowthApp />);
    await waitFor(() =>
      expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"),
    );
    fireEvent.click(screen.getByRole("button", { name: "New brand" }));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(
      screen.queryByRole("dialog", { name: "Quick actions" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      screen.queryByRole("combobox", { name: "Search quick actions" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name your brand / podcast")).toHaveValue("");
    expect(
      screen.queryByRole("button", { name: "Style rules" }),
    ).not.toBeInTheDocument();
    // Onboarding opens on the website step.
    expect(
      screen.getByRole("heading", { name: "What’s your website?" }),
    ).toBeInTheDocument();
  });
  it("saves brand edits and keeps approved style rules on the page until Factory is requested", async () => {
    render(<GrowthApp />);
    await waitFor(() =>
      expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"),
    );
    expect(screen.queryByRole("button", { name: "Save brand" })).toBeNull();
    openBrandEditor();
    fireEvent.change(screen.getByRole("textbox", { name: "Who it's for" }), { target: { value: "Builders and founders making thoughtful clips" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Save brand" }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save brand" })).toBeNull());
    expect(screen.getByRole("heading", { name: "Brand profile" })).toBeVisible();
    closeBrandEditor();
    fireEvent.click(screen.getByRole("button", { name: "Style rules" }));
    await screen.findByRole("heading", {
      name: "Style rules",
    });
    expect(await activeRules()).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /^Approve style rules\b/ }),
    );
    const factoryAction = await screen.findByRole("button", { name: "Go to Factory" });
    expect(screen.getByRole("heading", { name: "Style rules" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Studio" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Approve style rules\b/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save draft\b/ })).toBeNull();
    expect((await activeRules())).toBe(
      "preview-strategy-v1",
    );
    fireEvent.click(factoryAction);
    expect(screen.getByRole("heading", { name: "Factory" })).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "Studio" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: /Export/ }),
    ).not.toBeInTheDocument();
  });
  it("preserves an unsaved brief when moving between stages", async () => {
    render(<GrowthApp />);
    await waitFor(() =>
      expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"),
    );
    openBrandEditor();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Who it's for" }),
      {
        target: { value: "A very specific audience" },
      },
    );
    closeBrandEditor();
    openEditingRules();
    fireEvent.click(screen.getByRole("button", { name: "Brand profile" }));
    openBrandEditor();
    expect(
      screen.getByRole("textbox", { name: "Who it's for" }),
    ).toHaveValue("A very specific audience");
  });
});

describe("approval transition regressions", () => {
  it("treats a reason-only edit to active rules as a new draft and stays on Style rules", async () => {
    const active = await send<StrategyVersion>(`${rules}/preview-strategy-v1/approve`);
    render(<GrowthApp />);
    await waitFor(() => expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"));
    openEditingRules();
    fireEvent.click(screen.getByText("Notes & reference"));
    expect(screen.getByLabelText("Why try this?")).toHaveValue(active.reason);
    expect(screen.queryByRole("button", { name: /^Save draft\b/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Why try this?"), { target: { value: "Compare the same rules with a clearer reason." } });
    fireEvent.click(screen.getByRole("button", { name: /^Save draft\b/ }));
    await screen.findByRole("button", { name: /^Approve style rules\b/ });
    expect(screen.getByRole("heading", { name: "Style rules" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Studio" })).toBeNull();
    const versions = await previewRequest<StrategyVersion[]>(rules);
    const draft = versions.find((version) => version.id !== active.id && version.reason === "Compare the same rules with a clearer reason.")!;
    expect(draft).toBeDefined();
    expect(draft.reason).toBe("Compare the same rules with a clearer reason.");
    expect(draft.directions["preview-profile-allin"]).toEqual(active.directions["preview-profile-allin"]);
    expect(await activeRules()).toBe(active.id);
  });

  it("saves edited reference text before allowing direction approval", async () => {
    render(<GrowthApp />);
    await waitFor(() =>
      expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"),
    );
    openEditingRules();
    expect(
      screen.getByRole("button", { name: /^Approve style rules\b/ }),
    ).toBeEnabled();
    fireEvent.click(screen.getByText("Notes & reference"));
    fireEvent.change(
      screen.getByLabelText("Reference link or source locator"),
      { target: { value: "Episode A, 00:18–00:25" } },
    );
    expect(
      screen.queryByRole("button", { name: /^Approve style rules\b/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /^Save draft\b/ }),
    );
    await screen.findByRole("button", { name: /^Approve style rules\b/ });
    const versions = await previewRequest<StrategyVersion[]>(
      rules,
    );
    expect(
      versions.some((v) => v.reason.includes("Episode A, 00:18–00:25")),
    ).toBe(true);
    expect(
      (await activeRules()),
    ).toBeNull();
  });
  it("opens fresh production on the second source after exact next-test approval", async () => {
    const v = await send<StrategyVersion>(
      `${rules}/preview-strategy-v1/approve`,
    );
    await send(`${path}/render`, {
      expected_strategy_version_id: v.id,
      video_id: "preview-source-a",
      profile_id: "preview-profile-allin",
      start: 0,
      end: 30,
      hook: "Claim first",
      subtitles: true,
      mode: "direct",
    });
    const time = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    const [clip] = await previewRequest<Clip[]>("/api/clips");
    time.mockRestore();
    await send(`/api/clips/${clip.id}`, { approved: true }, "PUT");
    const o = await send<{ id: string }>(`${path}/observations`, {
      clip_id: clip.id,
      metric: "visits",
      value: 12,
      unit: "count",
      source: "manual_import",
      publication_reference: "Illustrative observation",
      window_start: new Date(Date.now() - 86400000).toISOString(),
      window_end: new Date(Date.now() - 60000).toISOString(),
      collected_at: new Date().toISOString(),
      notes: "Fixture",
    });
    await send(`${path}/learning`, {
      profile_id: "preview-profile-allin",
      observation_ids: [o.id],
      hypothesis: "Test a direct opening.",
      reason: "Test only.",
      base_version_id: v.id,
      proposed_direction: {
        ...v.directions["preview-profile-allin"],
        moment_selection: "A saved specific rule.",
      },
    });
    localStorage.setItem("growth-view-v2", "results");
    render(<GrowthApp />);
    fireEvent.click(await screen.findByRole("button", { name: /^Insights/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add a result by hand" }));
    await screen.findByRole("button", { name: /^Approve next test\b/ });
    fireEvent.change(screen.getByLabelText("Proposed source-selection rule"), {
      target: { value: "An unsaved different rule." },
    });
    expect(
      screen.queryByRole("button", { name: /^Approve next test\b/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Save next test draft\b/ }),
    ).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Proposed source-selection rule"), {
      target: { value: "A saved specific rule." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /^Approve next test\b/ }),
    );
    await screen.findByRole("heading", {
      name: "Studio",
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Episode")).toHaveValue(
        "preview-source-b",
      ),
    );
    expect(screen.getByLabelText("Production mode")).toHaveValue("agent");
    expect(
      screen.queryByRole("button", { name: /^Approve this clip\b/ }),
    ).not.toBeInTheDocument();
    expect(await previewRequest<Clip[]>("/api/clips")).toHaveLength(1);
  });
  it("does not operate on the old campaign while a new campaign is unsaved", async () => {
    render(<GrowthApp />);
    await waitFor(() =>
      expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"),
    );
    fireEvent.click(screen.getByRole("button", { name: "New brand" }));
    expect(screen.getByLabelText("Name your brand / podcast")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Style rules" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Library" })).not.toBeInTheDocument();
  });
});

describe("review transport boundaries", () => {
  it("preserves exact version lineage and never exports a simulated media response", async () => {
    const version = await send<StrategyVersion>(
      `${rules}/preview-strategy-v1/approve`,
    );
    const job = await send<Job>(`${path}/render`, {
      expected_strategy_version_id: version.id,
      video_id: "preview-source-a",
      profile_id: "preview-profile-allin",
      start: 0,
      end: 30,
      hook: "Claim first",
      caption: "",
      subtitles: true,
      mode: "direct",
      instructions: "",
    });
    expect(job.status).toBe("queued");
    const future = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    const clips = await previewRequest<Clip[]>("/api/clips");
    future.mockRestore();
    expect(clips).toHaveLength(1);
    expect(clips[0].approved).toBe(false);
    expect(clips[0].strategy_version_id).toBe(version.id);
    await expect(
      previewRequest(`/api/clips/${clips[0].id}/download`),
    ).rejects.toThrow();
  });
  it("preserves the other profile when a learned rule is approved and rejects stale renders", async () => {
    const original = await send<StrategyVersion>(
      `${rules}/preview-strategy-v1/approve`,
    );
    const directions = {
      ...original.directions["preview-profile-allin"],
      moment_selection: "Lead with a useful question.",
    };
    const proposed = await send<StrategyVersion>(rules, {
      base_version_id: original.id,
      reason: "A creator-provided new test.",
      direction: directions,
    });
    expect((await activeRules())).toBe(
      original.id,
    );
    const approved = await send<StrategyVersion>(
      `${rules}/${proposed.id}/approve`,
    );
    // The other workspace keeps its own (still unapproved) rule set.
    expect(approved.directions["preview-profile-test"]).toBeUndefined();
    expect(
      (await previewRequest<Profile>("/api/profiles/preview-profile-test"))
        .active_strategy_id,
    ).toBeNull();
    await expect(
      send(`${path}/render`, {
        expected_strategy_version_id: original.id,
        video_id: "preview-source-a",
        profile_id: "preview-profile-allin",
        start: 0,
        end: 30,
      }),
    ).rejects.toThrow(/changed|stale|current|approved/i);
  });
});

describe("direction approval guidance", () => {
  it("walks the creator through save, edit and approve in plain words", async () => {
    render(<GrowthApp />);
    await waitFor(() =>
      expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"),
    );
    openEditingRules();
    const status = () =>
      screen.getByRole("list", { name: "Direction approval steps" })
        .nextElementSibling;
    expect(status()).toHaveTextContent(
      /Step 2 of 2: draft v1 is saved but not active yet/,
    );
    expect(screen.getByText(/Draft, not active/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Notes & reference"));
    fireEvent.change(
      screen.getByLabelText("Reference link or source locator"),
      {
        target: { value: "Episode A" },
      },
    );
    expect(status()).toHaveTextContent(/edited this since draft v1 was saved/);
    fireEvent.click(
      screen.getByRole("button", { name: /^Save draft\b/ }),
    );
    await screen.findByRole("button", { name: /^Approve style rules\b/ });
    expect(status()).toHaveTextContent(/Step 2 of 2: draft v2 is saved/);
  });
});

describe("approvalStep", () => {
  it("explains each state of save-then-approve", async () => {
    const { approvalStep } = await import("./Research");
    const fresh = approvalStep({
      pending: false,
      active: false,
      changed: true,
      draftCurrent: false,
    });
    expect(fresh.saved).toBe(false);
    expect(fresh.message()).toMatch(/Step 1 of 2/);
    const ready = approvalStep({
      pending: true,
      active: false,
      changed: false,
      draftCurrent: true,
    });
    expect([ready.saved, ready.approved]).toEqual([true, false]);
    expect(ready.message(2)).toMatch(/draft v2 is saved but not active/);
    const stale = approvalStep({
      pending: true,
      active: false,
      changed: false,
      draftCurrent: false,
    });
    expect(stale.message(1)).toMatch(/out of date: the approved rules changed/);
    const live = approvalStep({
      pending: false,
      active: true,
      changed: false,
      draftCurrent: false,
    });
    expect(live.approved).toBe(true);
    expect(live.message(undefined, 3)).toMatch(/v3 is approved and active/);
    const editingLive = approvalStep({
      pending: false,
      active: true,
      changed: true,
      draftCurrent: false,
    });
    expect(editingLive.message()).toMatch(/approved rules stay active/);
  });
});
