import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { previewRequest, resetPreview } from "./previewApi";
import type { Campaign, Clip, Job, StrategyVersion } from "../types";

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
  // These regressions exercise editable workspace settings; the new daily
  // Factory/default/onboarding flow has separate coverage.
  localStorage.setItem("growth-view-v2", "setup");
});

describe("Growth Factory interface", () => {
  it("ignores the onboarding preview hash in the ordinary build", async () => {
    const originalUrl = window.location.pathname + window.location.search + window.location.hash;
    window.history.replaceState(null, "", "/#onboarding");
    try {
      render(<GrowthApp />);
      await waitFor(() =>
        expect(screen.getByLabelText("Campaign name")).toHaveValue("All-In clips"),
      );
      expect(screen.getByRole("combobox", { name: "Current campaign" })).toHaveValue("preview-campaign");
      expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Who are we making this for?" })).not.toBeInTheDocument();
      expect(window.location.hash).toBe("#onboarding");
    } finally {
      window.history.replaceState(null, "", originalUrl);
    }
  });
  it("collapses and restores the sidebar without discarding the brief", async () => {
    render(<GrowthApp />);
    const menu = screen.getByLabelText("Workspace menu").closest("details");
    menu?.setAttribute("open", "");
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign name")).toHaveValue(
        "All-In clips",
      ),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Who are we speaking to?" }),
      {
        target: { value: "A retained audience" },
      },
    );
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
    expect(
      screen.getByRole("textbox", { name: "Who are we speaking to?" }),
    ).toHaveValue("A retained audience");
  });
  it("opens quick actions by keyboard or click and preserves drafts through navigation", async () => {
    render(<GrowthApp />);
    const menu = screen.getByLabelText("Workspace menu").closest("details");
    menu?.setAttribute("open", "");
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign name")).toHaveValue(
        "All-In clips",
      ),
    );
    const audience = screen.getByRole("textbox", {
      name: "Who are we speaking to?",
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
    fireEvent.click(screen.getByRole("button", { name: "Open quick actions" }));
    fireEvent.change(search, { target: { value: "library" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "Library" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(search, { target: { value: "setup" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(
      screen.getByRole("textbox", { name: "Who are we speaking to?" }),
    ).toHaveValue("My unsaved audience");
  });
  it("keeps new-workspace onboarding isolated from quick actions and app navigation", async () => {
    render(<GrowthApp />);
    const menu = screen.getByLabelText("Workspace menu").closest("details");
    menu?.setAttribute("open", "");
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign name")).toHaveValue(
        "All-In clips",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(
      screen.queryByRole("dialog", { name: "Quick actions" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      screen.queryByRole("combobox", { name: "Search quick actions" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Podcast or workspace name")).toHaveValue("");
    expect(
      screen.queryByRole("button", { name: "Creative direction" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Who are we making this for?" }),
    ).toHaveFocus();
  });
  it("saves a campaign, requires explicit direction approval, then opens Studio", async () => {
    render(<GrowthApp />);
    const menu = screen.getByLabelText("Workspace menu").closest("details");
    menu?.setAttribute("open", "");
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign name")).toHaveValue(
        "All-In clips",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Save & find direction\b/ }),
    );
    await screen.findByRole("heading", {
      name: "Creative direction",
    });
    const before = await previewRequest<Campaign>(path);
    expect(before.active_strategy_id).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /^Approve direction\b/ }),
    );
    await screen.findByRole("heading", {
      name: "Production & review",
    });
    expect((await previewRequest<Campaign>(path)).active_strategy_id).toBe(
      "preview-strategy-v1",
    );
    expect(screen.getByLabelText("Production mode")).toHaveValue("agent");
    expect(
      screen.queryByRole("link", { name: /Export/ }),
    ).not.toBeInTheDocument();
  });
  it("preserves an unsaved brief when moving between stages", async () => {
    render(<GrowthApp />);
    const menu = screen.getByLabelText("Workspace menu").closest("details");
    menu?.setAttribute("open", "");
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign name")).toHaveValue(
        "All-In clips",
      ),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Who are we speaking to?" }),
      {
        target: { value: "A very specific audience" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Creative direction" }));
    fireEvent.click(screen.getByRole("button", { name: "Workspace settings" }));
    expect(
      screen.getByRole("textbox", { name: "Who are we speaking to?" }),
    ).toHaveValue("A very specific audience");
  });
});

describe("approval transition regressions", () => {
  it("saves edited reference text before allowing direction approval", async () => {
    render(<GrowthApp />);
    const menu = screen.getByLabelText("Workspace menu").closest("details");
    menu?.setAttribute("open", "");
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign name")).toHaveValue(
        "All-In clips",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Creative direction" }));
    expect(
      screen.getByRole("button", { name: /^Approve direction\b/ }),
    ).toBeEnabled();
    fireEvent.click(screen.getByText("Reference & inspection details"));
    fireEvent.change(
      screen.getByLabelText("Reference link or source locator"),
      { target: { value: "Episode A, 00:18–00:25" } },
    );
    expect(
      screen.queryByRole("button", { name: /^Approve direction\b/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /^Save direction draft\b/ }),
    );
    await screen.findByRole("button", { name: /^Approve direction\b/ });
    const versions = await previewRequest<StrategyVersion[]>(
      `${path}/strategies`,
    );
    expect(
      versions.some((v) => v.reason.includes("Episode A, 00:18–00:25")),
    ).toBe(true);
    expect(
      (await previewRequest<Campaign>(path)).active_strategy_id,
    ).toBeNull();
  });
  it("opens fresh production on the second source after exact next-test approval", async () => {
    const v = await send<StrategyVersion>(
      `${path}/strategies/preview-strategy-v1/approve`,
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
    const menu = screen.getByLabelText("Workspace menu").closest("details");
    menu?.setAttribute("open", "");
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
      name: "Production & review",
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Source footage")).toHaveValue(
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
    const menu = screen.getByLabelText("Workspace menu").closest("details");
    menu?.setAttribute("open", "");
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign name")).toHaveValue(
        "All-In clips",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    expect(screen.getByLabelText("Podcast or workspace name")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Creative direction" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Library" })).not.toBeInTheDocument();
  });
});

describe("review transport boundaries", () => {
  it("preserves exact version lineage and never exports a simulated media response", async () => {
    const version = await send<StrategyVersion>(
      `${path}/strategies/preview-strategy-v1/approve`,
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
      `${path}/strategies/preview-strategy-v1/approve`,
    );
    const directions = {
      ...original.directions["preview-profile-allin"],
      moment_selection: "Lead with a useful question.",
    };
    const proposed = await send<StrategyVersion>(`${path}/strategies`, {
      base_version_id: original.id,
      reason: "A creator-provided new test.",
      directions: { "preview-profile-allin": directions },
    });
    expect((await previewRequest<Campaign>(path)).active_strategy_id).toBe(
      original.id,
    );
    const approved = await send<StrategyVersion>(
      `${path}/strategies/${proposed.id}/approve`,
    );
    expect(approved.directions["preview-profile-test"]).toEqual(
      original.directions["preview-profile-test"],
    );
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
    const menu = screen.getByLabelText("Workspace menu").closest("details");
    menu?.setAttribute("open", "");
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign name")).toHaveValue(
        "All-In clips",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Creative direction" }));
    const status = () =>
      screen.getByRole("list", { name: "Direction approval steps" })
        .nextElementSibling;
    expect(status()).toHaveTextContent(
      /Step 2 of 2: draft v1 is saved but not active yet/,
    );
    expect(screen.getByText(/Draft, not active/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Reference & inspection details"));
    fireEvent.change(
      screen.getByLabelText("Reference link or source locator"),
      {
        target: { value: "Episode A" },
      },
    );
    expect(status()).toHaveTextContent(/edited this since draft v1 was saved/);
    fireEvent.click(
      screen.getByRole("button", { name: /^Save direction draft\b/ }),
    );
    await screen.findByRole("button", { name: /^Approve direction\b/ });
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
    expect(stale.message(1)).toMatch(/out of date: a profile was added/);
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
    expect(editingLive.message()).toMatch(/approved direction stays active/);
  });
});
