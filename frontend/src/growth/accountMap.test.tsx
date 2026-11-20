import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api";
import type { Clip } from "../types";
import type { FactoryState } from "../useFactory";
import { AccountMap } from "./AccountMap";
import type { Row } from "./flowEvents";
import { Results } from "./Results";
import {
  accountMap,
  clipPage,
  compactCount,
  postedRows,
  ratioChip,
  sortClips,
  timesTypical,
  UNKNOWN_ACCOUNT,
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
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const NOW = Date.parse("2026-11-14T12:00:00Z");
const DAY = 86400000;
type Spec = { id: string; account: string; clip?: string; daysAgo: number; views?: number };

const publication = (s: Spec): Row => ({
  id: s.id,
  policy_id: "pol",
  clip_id: s.clip ?? `clip-${s.id}`,
  account_id: s.account,
  media_id: `m-${s.id}`,
  published_at: new Date(NOW - s.daysAgo * DAY).toISOString(),
  next_due_at: null,
});
const reading = (s: Spec): Row => ({
  id: `r-${s.id}`,
  policy_id: "pol",
  publication_id: s.id,
  collected_at: new Date(NOW - DAY / 4).toISOString(),
  metrics: { views: s.views },
});
const clipsFor = (specs: Spec[]) =>
  specs.map((s) => ({ id: s.clip ?? `clip-${s.id}`, hook: `Hook ${s.id}` })) as unknown as Clip[];
const rowsOf = (specs: Spec[], accounts: Row[]) =>
  postedRows({
    publications: specs.map(publication),
    snapshots: specs.filter((s) => s.views !== undefined).map(reading),
    policies: [{ id: "pol", cadence_days: 3 }],
    accounts,
    clips: clipsFor(specs),
    baseline: [{ name: "views", median: 1000 }],
    now: NOW,
  });
const account = (id: string, name: string, platform = "instagram", status = "active"): Row => ({
  id,
  profile_id: "p",
  status,
  platform,
  display_name: name,
});
const IG = account("ig", "@brand_ig");
const TT = account("tt", "@brand_tt", "tiktok");
const YT = account("yt", "Brand on YouTube", "youtube");
const mapOf = (specs: Spec[], connected: Row[], known: Row[] = connected) =>
  accountMap({ rows: rowsOf(specs, known), connected, known, brand: "All-In", typical: 1000 });

/** Seven Instagram clips (two pages), one of them cross-posted to TikTok. */
const SEVEN: Spec[] = [
  { id: "i1", account: "ig", daysAgo: 1 },
  { id: "i2", account: "ig", daysAgo: 2, views: 1500 },
  { id: "i3", account: "ig", daysAgo: 3, views: 600 },
  { id: "i4", account: "ig", daysAgo: 4, views: 4000 },
  { id: "i5", account: "ig", daysAgo: 5, views: 900 },
  { id: "i6", account: "ig", daysAgo: 6, views: 2000 },
  { id: "i7", account: "ig", clip: "shared", daysAgo: 7, views: 1200 },
  { id: "t1", account: "tt", clip: "shared", daysAgo: 6.5, views: 9000 },
];

describe("Account Map model", () => {
  it("posted rows carry their account and latest views", () => {
    const [row] = rowsOf([{ id: "a", account: "ig", daysAgo: 1, views: 4210 }], [IG]);
    expect(row.accountId).toBe("ig");
    expect(row.views).toBe(4210);
    expect(rowsOf([{ id: "b", account: "ig", daysAgo: 1 }], [IG])[0].views).toBeNull();
  });

  it("groups clips under their accounts, linked from the brand, and never turns unknown into zero", () => {
    const map = mapOf(
      [
        { id: "a", account: "ig", daysAgo: 1, views: 3000 },
        { id: "b", account: "ig", daysAgo: 2, views: 1500 },
        { id: "c", account: "ig", daysAgo: 3 },
        { id: "d", account: "tt", daysAgo: 1 },
      ],
      [IG, TT, YT],
    );
    expect(map.brand).toBe("All-In");
    expect(map.clips).toBe(4);
    expect(map.views).toBe(4500);
    expect(map.accounts.map((a) => a.key)).toEqual(["ig", "tt", "yt"]);
    const [ig, tt, yt] = map.accounts;
    expect(ig).toMatchObject({ name: "@brand_ig", platform: "instagram", connected: true, views: 4500, measured: 2 });
    expect(ig.clips.map((c) => c.row.id)).toEqual(["a", "b", "c"]);
    expect(ig.best?.row.id).toBe("a");
    expect(ig.best?.vsTypical.ratio).toBe(3);
    expect(ig.clips.map((c) => c.share)).toEqual([1, 0.5, 0]);
    // Measured nothing yet is unknown, not zero.
    expect(tt).toMatchObject({ views: null, measured: 0, best: null });
    expect(tt.clips).toHaveLength(1);
    // A connected account with nothing posted still gets a node.
    expect(yt).toMatchObject({ views: null, clips: [] });
  });

  it("keeps posts on accounts that are no longer connected, named from the record when there is one", () => {
    const old = account("old", "@old_brand", "twitter", "disconnected");
    const map = mapOf(
      [
        { id: "a", account: "ig", daysAgo: 1, views: 100 },
        { id: "b", account: "old", daysAgo: 9, views: 50 },
        { id: "c", account: "gone", daysAgo: 12 },
        { id: "d", account: "", daysAgo: 13 },
      ],
      [IG],
      [IG, old],
    );
    const byKey = Object.fromEntries(map.accounts.map((a) => [a.key, a]));
    expect(byKey.old).toMatchObject({ name: "@old_brand", platform: "twitter", connected: false });
    expect(byKey.gone).toMatchObject({ name: "gone", platform: "", connected: false });
    expect(byKey[UNKNOWN_ACCOUNT]).toMatchObject({ name: "Unknown account", platform: "", connected: false });
    // Most views first, then unmeasured; connected before disconnected on a tie.
    expect(map.accounts.map((a) => a.key)).toEqual(["ig", "old", "gone", UNKNOWN_ACCOUNT]);
  });

  it("links a clip posted to several accounts to its copies, never to itself", () => {
    const map = mapOf(SEVEN, [IG, TT]);
    const ig = map.accounts.find((a) => a.key === "ig")!;
    const tt = map.accounts.find((a) => a.key === "tt")!;
    expect(tt.clips[0].alsoOn).toEqual([{ key: "ig", name: "@brand_ig", rowId: "i7" }]);
    expect(ig.clips.find((c) => c.row.id === "i7")?.alsoOn).toEqual([{ key: "tt", name: "@brand_tt", rowId: "t1" }]);
    expect(ig.clips.find((c) => c.row.id === "i1")?.alsoOn).toEqual([]);
  });

  it("sorts by views with unmeasured clips last, ties newest first", () => {
    const ig = mapOf(
      [
        { id: "a", account: "ig", daysAgo: 1 },
        { id: "b", account: "ig", daysAgo: 2, views: 500 },
        { id: "c", account: "ig", daysAgo: 3, views: 900 },
        { id: "d", account: "ig", daysAgo: 4, views: 500 },
      ],
      [IG],
    ).accounts[0];
    expect(sortClips(ig.clips, "views").map((c) => c.row.id)).toEqual(["c", "b", "d", "a"]);
    expect(sortClips(ig.clips, "newest").map((c) => c.row.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("pages five at a time and keeps a page past the end on the last page", () => {
    const items = Array.from({ length: 7 }, (_, i) => i);
    expect(clipPage(items, 0)).toMatchObject({ page: 0, pages: 2, total: 7, from: 1, to: 5, items: [0, 1, 2, 3, 4] });
    expect(clipPage(items, 1)).toMatchObject({ page: 1, from: 6, to: 7, items: [5, 6] });
    expect(clipPage(items, 9)).toMatchObject({ page: 1, from: 6, to: 7 });
    expect(clipPage(items, -3).page).toBe(0);
    expect(clipPage([], 0)).toMatchObject({ page: 0, pages: 1, total: 0, from: 0, to: 0, items: [] });
  });

  it("says how a clip compares in plain words and shortens big counts", () => {
    expect(timesTypical(ratioChip("views", 1400, 1000))).toBe("1.4× typical");
    expect(timesTypical(ratioChip("views", 1400, null))).toBe("no typical yet");
    expect(timesTypical(ratioChip("views", null, 1000))).toBe("not measured yet");
    expect(compactCount(12400)).toBe("12.4K");
    expect(compactCount(980)).toBe("980");
  });
});

describe("Account Map", () => {
  const draw = (map = mapOf(SEVEN, [IG, TT, YT]), untracked = 0) => {
    const onAccounts = vi.fn();
    render(<AccountMap model={map} untracked={untracked} onAccounts={onAccounts} />);
    return onAccounts;
  };
  const node = (name: string) => screen.getByRole("article", { name });

  it("shows the brand linked to each account with views on every node", () => {
    draw();
    const brand = screen.getByRole("region", { name: "All-In" });
    expect(within(brand).getByText("Brand · 3 accounts")).toBeTruthy();
    const entries = within(within(brand).getByRole("list", { name: "Go to an account" })).getAllByRole("button");
    // Same order as the nodes: most views first, unmeasured last.
    expect(entries.map((b) => b.textContent)).toEqual([
      "@brand_ig" + "Instagram" + "10.2K",
      "@brand_tt" + "TikTok" + "9K",
      "Brand on YouTube" + "YouTube" + "—not measured yet",
    ]);
    const ig = node("@brand_ig");
    expect(within(ig).getByText("Instagram")).toBeTruthy();
    expect(within(ig).getByText("10.2K")).toBeTruthy();
    expect(within(ig).getByText("1 not measured yet")).toBeTruthy();
    // Best clip: 4,000 views against a typical 1,000.
    expect(within(ig).getByText("4.0×")).toBeTruthy();
    expect(within(node("Brand on YouTube")).getByText("Nothing posted to this account yet.")).toBeTruthy();
    // Choosing an entry moves focus to that account's node.
    fireEvent.click(entries[0]);
    expect(document.activeElement).toBe(ig);
    expect(ig.classList.contains("is-active")).toBe(true);
  });

  it("starts every list closed when there are several accounts, and opens on request", () => {
    draw();
    const toggle = within(node("@brand_ig")).getByRole("button", { name: "7 clips" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Clips posted to @brand_ig" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(screen.getByRole("list", { name: "Clips posted to @brand_ig" })).getAllByRole("listitem")).toHaveLength(5);
  });

  it("opens a single account's list and pages it five at a time", () => {
    draw(mapOf(SEVEN.filter((s) => s.account === "ig"), [IG]));
    const ig = node("@brand_ig");
    const list = () => within(ig).getByRole("list", { name: "Clips posted to @brand_ig" });
    expect(within(ig).getByRole("button", { name: "7 clips" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(list()).getAllByRole("listitem")).toHaveLength(5);
    expect(within(ig).getByRole("status").textContent).toBe("Showing clips 1–5 of 7");
    const previous = within(ig).getByRole("button", { name: "Previous clips on @brand_ig" });
    const next = within(ig).getByRole("button", { name: "Next clips on @brand_ig" });
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(previous);
    expect(within(ig).getByRole("status").textContent).toBe("Showing clips 1–5 of 7");
    fireEvent.click(next);
    expect(within(ig).getByRole("status").textContent).toBe("Showing clips 6–7 of 7");
    expect(within(list()).getAllByRole("listitem").map((li) => li.querySelector("strong")?.textContent)).toEqual([
      "Hook i6",
      "Hook i7",
    ]);
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(previous.getAttribute("aria-disabled")).toBe("false");
  });

  it("sorts by most views with unmeasured clips last and goes back to the first page", () => {
    draw(mapOf(SEVEN.filter((s) => s.account === "ig"), [IG]));
    const ig = node("@brand_ig");
    fireEvent.click(within(ig).getByRole("button", { name: "Next clips on @brand_ig" }));
    const most = screen.getByRole("button", { name: "Most views" });
    fireEvent.click(most);
    expect(most.getAttribute("aria-pressed")).toBe("true");
    expect(within(ig).getByRole("status").textContent).toBe("Showing clips 1–5 of 7");
    const titles = () =>
      within(within(ig).getByRole("list", { name: "Clips posted to @brand_ig" }))
        .getAllByRole("listitem")
        .map((li) => li.querySelector("strong")?.textContent);
    expect(titles()).toEqual(["Hook i4", "Hook i6", "Hook i2", "Hook i7", "Hook i5"]);
    fireEvent.click(within(ig).getByRole("button", { name: "Next clips on @brand_ig" }));
    expect(titles()).toEqual(["Hook i3", "Hook i1"]);
    expect(within(ig).getByText("Not measured yet")).toBeTruthy();
  });

  it("follows a cross-post to the other account's page holding that clip and focuses it", async () => {
    draw();
    const tt = node("@brand_tt");
    fireEvent.click(within(tt).getByRole("button", { name: "1 clip" }));
    fireEvent.click(within(tt).getByRole("button", { name: "Show this clip on @brand_ig" }));
    const ig = node("@brand_ig");
    expect(within(ig).getByRole("button", { name: "7 clips" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(ig).getByRole("status").textContent).toBe("Showing clips 6–7 of 7");
    await waitFor(() => expect(document.activeElement?.querySelector("strong")?.textContent).toBe("Hook i7"));
    expect(document.activeElement?.classList.contains("is-landing")).toBe(true);
  });

  it("offers to connect another account and to track clips that are not on the map", () => {
    const onAccounts = draw(mapOf(SEVEN, [IG, TT]), 2);
    fireEvent.click(screen.getByRole("button", { name: "Connect an account" }));
    expect(screen.getByText(/^2 posted clips are not on the map because they are not tracked yet\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Track to measure" }));
    expect(onAccounts).toHaveBeenCalledTimes(2);
  });

  it("marks an account that is no longer connected", () => {
    const old = account("old", "@old_brand", "twitter", "disconnected");
    draw(mapOf([{ id: "a", account: "old", daysAgo: 3, views: 50 }], [IG], [IG, old]));
    const gone = node("@old_brand");
    expect(gone.classList.contains("is-disconnected")).toBe(true);
    expect(within(gone).getByText("Not connected")).toBeTruthy();
    expect(within(gone).getByText("X")).toBeTruthy();
  });
});

describe("Results > Posted clips views", () => {
  const workspace = {
    campaign: { id: "c", video_ids: [], brief: {}, profile_ids: ["p"] },
    profileId: "p",
    profiles: [{ id: "p", name: "All-In", active_strategy_id: null }],
    versions: [],
    observations: [],
    busy: false,
    loading: false,
    error: "",
  } as unknown as Workspace;
  const specs = SEVEN.slice(5);
  const factory = {
    loading: false,
    errors: {},
    data: {
      clips: clipsFor(specs).map((c) => ({ ...c, campaign_id: "c", profile_id: "p" })),
      videos: [],
      jobs: [],
    },
  } as unknown as FactoryState;
  const setup = () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/automation/state")
        return {
          policies: [
            { id: "pol", campaign_id: "c", profile_id: "p", account_id: "ig", cadence_days: 3, enabled: true, auto_drafts: false },
          ],
          publications: specs.map(publication),
          snapshots: specs.filter((s) => s.views !== undefined).map(reading),
          work: [],
          experiments: [],
        };
      if (path === "/api/automation/accounts") return [IG, TT];
      if (path === "/api/automation/settings") return { configured: true };
      return null;
    });
    vi.spyOn(strategistApi, "view").mockResolvedValue({
      profile_id: "p", target_metric: "views", baseline: { statistic: null, posts: 0, metrics: {} }, beliefs: [], portfolio: null,
      pending_proposals: { style_rules: [], campaign: [] }, runs: [], measured_posts: 0, due_layers: [], caveat: "", simulated: false,
    });
  };
  const page = (props: { demoMode?: boolean } = {}) => (
    <Results w={workspace} factory={factory} next={vi.fn()} onRehearse={vi.fn()} onAccounts={vi.fn()} {...props} />
  );

  it("shows the list first, switches to the account map by keyboard or click, and remembers the choice", async () => {
    setup();
    const { unmount } = render(page());
    const list = await screen.findByRole("tab", { name: "List" });
    const mapTab = screen.getByRole("tab", { name: "Account map" });
    expect(list.getAttribute("aria-selected")).toBe("true");
    expect(mapTab.tabIndex).toBe(-1);
    expect(screen.getByRole("tabpanel", { name: "List" })).toBeTruthy();
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(mapTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(mapTab);
    const panel = screen.getByRole("tabpanel", { name: "Account map" });
    expect(within(panel).getByRole("region", { name: "All-In" })).toBeTruthy();
    expect(within(panel).getByRole("article", { name: "@brand_ig" })).toBeTruthy();
    expect(within(panel).getByRole("article", { name: "@brand_tt" })).toBeTruthy();
    expect(localStorage.getItem("gf-posted-view")).toBe("map");
    unmount();
    render(page());
    expect((await screen.findByRole("tab", { name: "Account map" })).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    expect(localStorage.getItem("gf-posted-view")).toBe("list");
    expect(screen.queryByRole("region", { name: "All-In" })).toBeNull();
  });

  it("keeps the account map out of Demo Mode", async () => {
    setup();
    localStorage.setItem("gf-posted-view", "map");
    const { rerender } = render(page());
    expect(await screen.findByRole("tab", { name: "Account map" })).toBeTruthy();
    rerender(page({ demoMode: true }));
    expect(screen.queryByRole("tab", { name: "Account map" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Posted clips" })).toBeNull();
  });
});
