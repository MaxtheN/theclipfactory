import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clip, settings, testState } from "../test-state";
import { ClipReview } from "../components/ClipReview";
import { Narration, narrationDownloadUrl } from "../components/Narration";
import {
  PaidSetup,
  PaidInsights,
  adsPreflightGate,
  ownedPublishedReel,
  validatePreflightBudget,
} from "../components/PaidSetup";
import type { FactoryState } from "../useFactory";
const instagram = {
  connected: true,
  account: { id: "ig1" },
  publishing_available: true,
};
const ownedClip = {
  ...clip,
  approved: true,
  status: "published",
  instagram_media_id: "reel1",
  instagram_account_id: "ig1",
};
const adAccount = { id: "act_1", name: "Real account", currency: "USD" };
function readyState(): FactoryState {
  const state = testState();
  state.data.system = { model_runtime: true };
  state.data.models = [
    { id: "qwen-small", name: "Qwen", installed: true },
    { id: "kokoro", name: "Kokoro", installed: true },
  ];
  state.data.videos = [
    { id: "v1", name: "Source 1", duration: 60 },
    { id: "v2", name: "Source 2", duration: 80 },
  ];
  return state;
}
function paidState(): FactoryState {
  const state = testState();
  state.data.instagram = instagram;
  state.data.settings = { ...settings, ads_enabled: true, total_budget: 50 };
  state.data.clips = [ownedClip];
  return state;
}
function fetchMock() {
  const fetch = vi.fn(
    async (path: string) =>
      new Response(
        JSON.stringify(
          path === "/api/team/runs"
            ? []
            : path === "/api/ads/accounts"
              ? {
                  accounts: [adAccount],
                  supported: false,
                  note: "Creation is not supported",
                }
              : path === "/api/ads/insights"
                ? {
                    rows: [
                      { ad_id: "actual-ad", impressions: null, clicks: 0 },
                    ],
                    source: "Meta ads reads",
                    attribution: "Unmapped",
                  }
                : { id: "job1" },
        ),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());
describe("full local production", () => {
  it.each([
    "https://evil.example/api/narrations/n1/download",
    "//evil.example/x",
    "/api/narrations/../clips/c1/download",
    "/api/narrations/%2e%2e/download",
    "/api/narrations/n1/download?token=private",
    null,
  ])("refuses unsafe narration media %s", (url) =>
    expect(narrationDownloadUrl(url)).toBeNull(),
  );
  it("shows narration failures, rejects unsafe completed results, and gates missing Kokoro", () => {
    const state = readyState();
    state.data.models = [];
    state.data.jobs = [
      {
        id: "n1",
        kind: "narration",
        status: "failed",
        error: "Kokoro runtime failed",
      },
      {
        id: "n2",
        kind: "narration",
        status: "completed",
        result: { download_url: "https://external.example/a.wav" },
      },
    ];
    render(<Narration state={state} />);
    expect(
      screen.getByRole("button", { name: "Generate narration" }),
    ).toBeDisabled();
    expect(screen.getByText("Kokoro runtime failed")).toBeInTheDocument();
    expect(screen.getByText(/without a valid same-origin/)).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Narration playback"),
    ).not.toBeInTheDocument();
  });
});
describe("render fidelity and publish reconciliation", () => {
  it("shows backend warning, actual subtitle status, and cover endpoints", () => {
    render(
      <ClipReview
        state={testState()}
        clip={{ ...clip, warning: "Font unavailable", subtitles_burned: false }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Font unavailable");
    expect(screen.getByText("Subtitles burned in: No")).toBeInTheDocument();
    expect(screen.getByAltText("Cover frame for Test clip")).toHaveAttribute(
      "src",
      "/api/clips/c1/cover",
    );
    expect(
      screen.getByRole("link", { name: "Download cover", hidden: true }),
    ).toHaveAttribute("href", "/api/clips/c1/cover/download");
    fireEvent.error(screen.getByAltText("Cover frame for Test clip"));
    expect(screen.getByText(/Cover unavailable/)).toBeInTheDocument();
  });
  it("does not claim subtitles are present when omitted", () => {
    render(<ClipReview state={testState()} clip={clip} />);
    expect(
      screen.getByText("Subtitles burned in: Unknown"),
    ).toBeInTheDocument();
  });
});
describe("deliberate paid reads and no-spend preflight", () => {
  it("does not call ads endpoints on mount; sync and stored reads require explicit actions", async () => {
    const fetch = fetchMock();
    const user = userEvent.setup();
    render(<PaidSetup state={paidState()} />);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Ad creation/activation unavailable; manage campaigns in Meta Ads Manager.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/additional ads_read permission/i),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Fetch accessible ad accounts" }),
    );
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/ads/accounts",
    ]);
    await user.selectOptions(
      screen.getByLabelText("Accessible ad account"),
      "act_1",
    );
    await user.click(
      screen.getByRole("button", { name: "Sync paid insights" }),
    );
    expect(fetch.mock.calls[1][0]).toBe("/api/ads/sync");
    expect(
      JSON.parse(
        (fetch.mock.calls[1] as unknown as [string, RequestInit])[1]
          .body as string,
      ),
    ).toEqual({ ad_account_id: "act_1" });
    expect(
      fetch.mock.calls.filter(([path]) => path === "/api/ads/insights"),
    ).toHaveLength(0);
    await user.click(
      screen.getByRole("button", { name: "Refresh stored paid insights" }),
    );
    expect(fetch.mock.calls[2][0]).toBe("/api/ads/insights");
    const table = screen.getByRole("table");
    expect(within(table).getByText("actual-ad")).toBeInTheDocument();
    expect(within(table).getByText("Unknown")).toBeInTheDocument();
    expect(within(table).getByText("0")).toBeInTheDocument();
    expect(within(table).queryByText("Test clip")).not.toBeInTheDocument();
  });
  it("keeps empty paid reads unknown and provenance explicit", () => {
    render(
      <PaidInsights
        insights={{
          rows: [],
          source: "Meta",
          attribution: null,
          note: "No paid records",
        }}
      />,
    );
    expect(
      screen.getByText("No paid insight rows reported"),
    ).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText(/never guessed/)).toBeInTheDocument();
  });
  it("requires known ownership, positive settings budget, opt-in, and USD currency", () => {
    expect(ownedPublishedReel(ownedClip, instagram)).toBe(true);
    expect(
      ownedPublishedReel(
        { ...ownedClip, instagram_account_id: "other" },
        instagram,
      ),
    ).toBe(false);
    expect(
      ownedPublishedReel(
        { ...ownedClip, instagram_account_id: null },
        instagram,
      ),
    ).toBe(false);
    expect(
      adsPreflightGate(
        ownedClip,
        adAccount,
        { ...settings, ads_enabled: true, total_budget: 50 },
        instagram,
      ),
    ).toEqual([]);
    expect(
      adsPreflightGate(
        clip,
        { ...adAccount, currency: "EUR" },
        settings,
        instagram,
      ),
    ).toHaveLength(4);
  });
  it.each([
    ["0", "7", 50],
    ["1.5", "7", 50],
    ["-1", "7", 50],
    ["5001", "7", 50],
    ["100", "0", 50],
    ["100", "1.2", 50],
    ["100", "7", 0],
    ["100", "7", NaN],
  ])(
    "rejects invalid cents/days or over-budget input %s/%s/%s",
    (cents, days, total) =>
      expect(
        validatePreflightBudget(
          cents as string,
          days as string,
          total as number,
        ),
      ).not.toBeNull(),
  );
  it("accepts exact total limit in cents, without confusing cents and USD", () => {
    expect(validatePreflightBudget("5000", "7", 50)).toBeNull();
    expect(validatePreflightBudget("29", "1", 0.29)).toBeNull();
  });
  it("rejects over-budget UI submission then sends exact validation-only payload", async () => {
    const fetch = fetchMock();
    const user = userEvent.setup();
    const state = paidState();
    render(<PaidSetup state={state} />);
    await user.click(
      screen.getByRole("button", { name: "Fetch accessible ad accounts" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Accessible ad account"),
      "act_1",
    );
    await user.selectOptions(
      screen.getByLabelText("Published owned Reel"),
      "c1",
    );
    await user.type(screen.getByLabelText("Preflight name"), "Intent check");
    await user.type(
      screen.getByLabelText("Destination HTTPS URL"),
      "https://store.example/product",
    );
    await user.type(
      screen.getByLabelText("Lifetime budget (USD cents)"),
      "5001",
    );
    await user.click(
      screen.getByRole("button", { name: "Validate ads preflight (no spend)" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "exceeds the total budget",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    await user.clear(screen.getByLabelText("Lifetime budget (USD cents)"));
    await user.type(
      screen.getByLabelText("Lifetime budget (USD cents)"),
      "1000",
    );
    await user.click(
      screen.getByRole("button", { name: "Validate ads preflight (no spend)" }),
    );
    expect(fetch.mock.calls[1][0]).toBe("/api/ads/preflight");
    expect(
      JSON.parse(
        (fetch.mock.calls[1] as unknown as [string, RequestInit])[1]
          .body as string,
      ),
    ).toEqual({
      clip_id: "c1",
      ad_account_id: "act_1",
      destination_url: "https://store.example/product",
      lifetime_budget_minor: 1000,
      duration_days: 7,
      name: "Intent check",
    });
    expect(
      screen.queryByRole("button", { name: /Activate campaign|Create ad$/i }),
    ).not.toBeInTheDocument();
  });
});
