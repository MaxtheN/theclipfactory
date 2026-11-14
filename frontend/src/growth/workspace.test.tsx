import { beforeEach, describe, expect, it, vi } from "vitest";
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
const send = <T,>(p: string, b: unknown = {}, method = "POST") =>
  previewRequest<T>(p, { method, body: JSON.stringify(b) });
beforeEach(() => {
  localStorage.clear();
  resetPreview();
});

describe("Growth Factory interface", () => {
  it("saves a campaign, requires explicit direction approval, then opens Studio", async () => {
    render(<GrowthApp />);
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign name")).toHaveValue(
        "All-In clips",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save & find direction" }),
    );
    await screen.findByRole("heading", {
      name: "Choose a creative direction.",
    });
    const before = await previewRequest<Campaign>(path);
    expect(before.active_strategy_id).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve direction" }));
    await screen.findByRole("heading", {
      name: "Make the cut.",
    });
    expect((await previewRequest<Campaign>(path)).active_strategy_id).toBe(
      "preview-strategy-v1",
    );
    expect(
      screen.getByRole("button", { name: "Make the first cut" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("link", { name: /Export/ }),
    ).not.toBeInTheDocument();
  });
  it("preserves an unsaved brief when moving between stages", async () => {
    render(<GrowthApp />);
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign name")).toHaveValue(
        "All-In clips",
      ),
    );
    fireEvent.change(screen.getByLabelText("Who are we speaking to?"), {
      target: { value: "A very specific audience" },
    });
    fireEvent.click(screen.getByRole("button", { name: /02 Research/ }));
    fireEvent.click(screen.getByRole("button", { name: /01 Setup/ }));
    expect(screen.getByLabelText("Who are we speaking to?")).toHaveValue(
      "A very specific audience",
    );
  });
});

describe("approval transition regressions", () => {
  it("saves edited reference text before allowing direction approval", async () => {
    render(<GrowthApp />);
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign name")).toHaveValue(
        "All-In clips",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /02 Research/ }));
    expect(
      screen.getByRole("button", { name: "Approve direction" }),
    ).toBeEnabled();
    fireEvent.change(
      screen.getByLabelText("Reference link or source locator"),
      { target: { value: "Episode A, 00:18–00:25" } },
    );
    expect(
      screen.queryByRole("button", { name: "Approve direction" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Save direction draft" }),
    );
    await screen.findByRole("button", { name: "Approve direction" });
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
    localStorage.setItem("growth-stage", "results");
    render(<GrowthApp />);
    await screen.findByRole("button", { name: "Approve next test" });
    fireEvent.change(screen.getByLabelText("Proposed source-selection rule"), {
      target: { value: "An unsaved different rule." },
    });
    expect(
      screen.queryByRole("button", { name: "Approve next test" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save next test draft" }),
    ).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Proposed source-selection rule"), {
      target: { value: "A saved specific rule." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve next test" }));
    await screen.findByRole("heading", {
      name: "Make the cut.",
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Source footage")).toHaveValue(
        "preview-source-b",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Make the first cut" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Approve this clip" }),
    ).not.toBeInTheDocument();
    expect(await previewRequest<Clip[]>("/api/clips")).toHaveLength(1);
  });
  it("does not operate on the old campaign while a new campaign is unsaved", async () => {
    render(<GrowthApp />);
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign name")).toHaveValue(
        "All-In clips",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "New campaign" }));
    expect(screen.getByLabelText("Campaign name")).toHaveValue("");
    expect(screen.getByRole("button", { name: /02 Research/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /03 Studio/ })).toBeDisabled();
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
