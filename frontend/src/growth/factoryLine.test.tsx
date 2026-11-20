import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Campaign, Clip, FactorySource, Video } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import type { FactoryState } from "../useFactory";
import { workspaceApi } from "./workspaceApi";
import { productionApi } from "./productionApi";
import { parseAgentProductionResponse } from "./productionContracts";
import { FactoryHome } from "./FactoryHome";
import { Library } from "./Library";

const mode = vi.hoisted(() => ({ preview: false }));
vi.mock("./workspaceApi", () => ({
  get reviewPreview() { return mode.preview; },
  workspaceApi: { save: vi.fn(), campaigns: vi.fn(), upload: vi.fn(), teamRuns: vi.fn() },
}));
vi.mock("./productionApi", async () => {
  const actual = await vi.importActual<typeof import("./productionApi")>("./productionApi");
  return { ...actual, productionApi: { campaignProduce: vi.fn() } };
});

const direction = {
  angles: [],
  moment_selection: "Complete thought",
  hooks: ["An approved opening"],
  pacing: "Clear",
  duration_seconds: 24,
  framing: "fill" as const,
  caption_style: "standard" as const,
  editing_preferences: "",
  measurement_questions: [],
  next_experiments: [],
  evidence_refs: [],
  limitations: "",
  confidence: "low" as const,
};
function campaign(): Campaign {
  return {
    id: "c1",
    name: "Founder stories",
    brief: { audience: "Founders", constraints: [], requested_outputs: [], measurement_intent: "" },
    profile_ids: ["p1"],
    video_ids: ["v1"],
  };
}
function workspace(approved = true): Workspace {
  return {
    campaign: campaign(),
    profileId: "p1",
    // The campaign inherits its workspace's approved style rules.
    profiles: [{ id: "p1", name: "Founders", active_strategy_id: approved ? "s1" : null }],
    versions: approved ? [{ id: "s1", status: "approved", directions: { p1: direction } }] : [],
    busy: false,
    loading: false,
    error: "",
    load: vi.fn(async () => {}),
    run: vi.fn(async (task: () => Promise<unknown>) => {
      try {
        await task();
        return true;
      } catch {
        return false;
      }
    }),
  } as unknown as Workspace;
}
const video: Video = { id: "v1", name: "Conversation.mp4", duration: 3600 };
function source(changes: Partial<FactorySource> = {}): FactorySource {
  return {
    video_id: "v1",
    name: "Conversation.mp4",
    duration: 3600,
    created_at: "2026-11-14T00:00:00+00:00",
    state: "idle",
    headline: "Ready to make clips",
    progress: null,
    stages: [
      { key: "import", label: "Import", status: "done", detail: "" },
      { key: "listen", label: "Listen", status: "done", detail: "812 lines of speech" },
      { key: "watch", label: "Watch", status: "pending", detail: "" },
    ],
    job_id: null,
    run_id: null,
    clip_ids: [],
    unreviewed: 0,
    approved: 0,
    error: null,
    can_produce: true,
    blocked_reason: null,
    storyboard: null,
    thumbnail: null,
    ...changes,
  } as FactorySource;
}
function factory(
  line: Partial<FactorySource> | null = {},
  { clips = [] as Clip[], autonomy = "review", model = "qwen-small" as string | null } = {},
): FactoryState {
  return {
    data: {
      videos: [video],
      clips,
      jobs: [],
      settings: { autonomy },
      factory: line && {
        autopilot: autonomy === "auto",
        model_id: model,
        ready: !!model,
        blockers: [],
        sources: [source(line)],
      },
    },
    loading: false,
    busy: false,
    errors: {},
    refresh: vi.fn(),
    run: vi.fn(async (task: () => Promise<unknown>) => {
      await task();
      return true;
    }),
  } as unknown as FactoryState;
}
function home(w: Workspace, f: FactoryState, onSettings?: () => void) {
  return render(
    <FactoryHome w={w} factory={f} onProduce={vi.fn()} onReview={vi.fn()} onLibrary={vi.fn()} onDirection={vi.fn()} onSettings={onSettings} />,
  );
}
const swarm = {
  expected_strategy_version_id: "s1",
  video_id: "v1",
  profile_id: "p1",
  model_id: "qwen-small",
  strategy: "swarm",
};
// The test DOM has no modal dialogs; these are the two calls the quick look makes.
const dialogApi = { showModal: HTMLDialogElement.prototype.showModal, close: HTMLDialogElement.prototype.close };
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterAll(() => Object.assign(HTMLDialogElement.prototype, dialogApi));
let requests: { url: string; method: string }[];
beforeEach(() => {
  mode.preview = false;
  vi.clearAllMocks();
  requests = [];
  vi.mocked(workspaceApi.teamRuns).mockResolvedValue([]);
  vi.mocked(productionApi.campaignProduce).mockResolvedValue({} as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ detail: "This source has not been watched yet." }), {
        status: url.includes("/storyboard") ? 404 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

describe("production line on the Factory screen", () => {
  it("makes many clips from one source with a single click, under the approved direction", async () => {
    const w = workspace();
    home(w, factory());
    expect(screen.getByText("Ready to make clips")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Find clips" }));
    await waitFor(() => expect(productionApi.campaignProduce).toHaveBeenCalledWith("c1", swarm));
    expect(await screen.findByText(/Making clips from Conversation.mp4/)).toBeInTheDocument();
    // The detailed, slower path stays one click away.
    expect(screen.getByRole("button", { name: /^Open .* in the studio$/ })).toBeEnabled();
  });

  it("waits for an approved direction and a usable model, and says which is missing", () => {
    const first = home(workspace(false), factory());
    const blocked = screen.getByRole("button", { name: "Find clips" });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute("title", "Pick your clip style first.");
    // The reason is on screen and tied to the button, not only in a hover tooltip, and the
    // row no longer claims to be ready.
    expect(blocked).toHaveAccessibleDescription("Pick your clip style first.");
    expect(screen.queryByText("Ready to make clips")).toBeNull();
    first.unmount();
    const onSettings = vi.fn();
    home(workspace(), factory({}, { model: null }), onSettings);
    expect(screen.getByRole("button", { name: "Find clips" })).toHaveAttribute(
      "title",
      "Set up a local model in Settings → Models.",
    );
    // The missing prerequisite links to the Settings section that resolves it.
    fireEvent.click(screen.getByRole("button", { name: "Open Settings → Models" }));
    expect(onSettings).toHaveBeenCalledOnce();
    expect(productionApi.campaignProduce).not.toHaveBeenCalled();
  });

  it("says agents need the desktop app in the review preview instead of failing the request", () => {
    mode.preview = true;
    home(workspace(), factory());
    const blocked = screen.getByRole("button", { name: "Find clips" });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAccessibleDescription(
      "Agents run in the desktop app, not in this preview.",
    );
    fireEvent.click(blocked);
    expect(productionApi.campaignProduce).not.toHaveBeenCalled();
  });

  it("shows live progress and cancels the running job", async () => {
    const f = factory({
      state: "working",
      headline: "Swarm: stretch 17 of 57 · 16 clips ready",
      progress: 49,
      job_id: "job-1",
      can_produce: false,
    });
    home(workspace(), f);
    expect(screen.getByText("Swarm: stretch 17 of 57 · 16 clips ready")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Progress for Conversation.mp4" })).toHaveValue(49);
    expect(screen.getByText("Listen")).toBeInTheDocument(); // the stage tracker from the local service
    expect(screen.queryByRole("button", { name: "Find clips" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(requests).toContainEqual({ url: "/api/jobs/job-1/cancel", method: "POST" }));
    expect(f.refresh).toHaveBeenCalled();
  });

  it("counts only clips above the bar and opens the best one first", () => {
    const made = (id: string, score: number, position: number | null): Clip => ({
      id, video_id: "v1", campaign_id: "c1", profile_id: "p1", name: id, start: 0, end: 20, hook: "", caption: "",
      objective: "discovery", approved: false,
      rank: { score, position, below_bar: position === null, why: "Hook" },
    });
    const clips = [made("low", 30, null), made("second", 70, 2), made("best", 90, 1),
      { ...made("older-speechless", 99, 1), made_without_speech: true }];
    const onReview = vi.fn();
    render(
      <FactoryHome w={workspace()} factory={factory({ state: "needs_review" }, { clips })} onProduce={vi.fn()} onReview={onReview} onLibrary={vi.fn()} onDirection={vi.fn()} />,
    );
    expect(screen.getByText("2 clips ready · 1 below the bar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open 2 clips/ }));
    expect(onReview).toHaveBeenCalledWith(clips[2]);
  });

  it("loads the storyboard only when it is opened", async () => {
    home(
      workspace(),
      factory({ storyboard: { scenes: 57, vision: true, model_id: "qwen-small", updated_at: "t1" } }),
    );
    const summary = screen.getByText(/What the factory saw · 57 scenes/);
    expect(requests.some((r) => r.url.includes("/storyboard"))).toBe(false);
    const details = summary.closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(requests.some((r) => r.url === "/api/videos/v1/storyboard")).toBe(true));
  });

  it("starts the swarm by itself after an upload when autopilot is on", async () => {
    vi.mocked(workspaceApi.upload).mockResolvedValue({ id: "v2", name: "New talk.mp4", duration: 1800 } as Video);
    vi.mocked(workspaceApi.campaigns).mockResolvedValue([campaign()]);
    // The attach is only trusted once the saved workspace actually lists the new source.
    vi.mocked(workspaceApi.save).mockResolvedValue({ ...campaign(), video_ids: ["v1", "v2"] });
    const { container } = home(workspace(), factory({}, { autonomy: "auto" }));
    const file = new File(["video"], "New talk.mp4", { type: "video/mp4" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() =>
      expect(productionApi.campaignProduce).toHaveBeenCalledWith("c1", { ...swarm, video_id: "v2" }),
    );
    expect(workspaceApi.save).toHaveBeenCalledTimes(1); // attached to the workspace first
    expect(await screen.findByText(/added and queued for production/)).toBeInTheDocument();
  });

  it("leaves production to you after an upload when autopilot is off", async () => {
    vi.mocked(workspaceApi.upload).mockResolvedValue({ id: "v2", name: "New talk.mp4", duration: 1800 } as Video);
    // Its own workspace: an unconfirmed import from another test is deliberately remembered per workspace.
    const own = { ...campaign(), id: "c2" };
    const w = workspace();
    w.campaign = own;
    vi.mocked(workspaceApi.campaigns).mockResolvedValue([own]);
    vi.mocked(workspaceApi.save).mockResolvedValue({ ...own, video_ids: ["v1", "v2"] });
    const { container } = home(w, factory());
    const file = new File(["video"], "New talk.mp4", { type: "video/mp4" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(workspaceApi.save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/Adding it to this workspace/)).not.toBeInTheDocument());
    expect(productionApi.campaignProduce).not.toHaveBeenCalled();
  });
});

describe("autopilot and footage that was waiting for a direction", () => {
  const screenFor = (w: Workspace, f: FactoryState) => (
    <FactoryHome w={w} factory={f} onProduce={vi.fn()} onReview={vi.fn()} onLibrary={vi.fn()} onDirection={vi.fn()} />
  );
  const approvedNotice = /Style approved\. Conversation\.mp4 is queued for production/;

  it("starts the swarm on waiting footage the moment a direction is approved", async () => {
    const f = factory({}, { autonomy: "auto" });
    const { rerender } = render(screenFor(workspace(false), f));
    expect(productionApi.campaignProduce).not.toHaveBeenCalled();
    rerender(screenFor(workspace(), f)); // the creator approves the direction on another screen
    await waitFor(() => expect(productionApi.campaignProduce).toHaveBeenCalledWith("c1", swarm));
    expect(productionApi.campaignProduce).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(approvedNotice)).toBeInTheDocument();
  });

  it("does not start anything when a workspace opens with its direction already approved", async () => {
    const f = factory({}, { autonomy: "auto" });
    const opening = { ...workspace(false), loading: true } as Workspace;
    const { rerender } = render(screenFor(opening, f));
    rerender(screenFor(workspace(), f)); // loading finished: the direction was there all along
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(productionApi.campaignProduce).not.toHaveBeenCalled();
  });

  it("leaves alone footage that already has clips or a run, and everything when autopilot is off", async () => {
    const made = { id: "a", video_id: "v1", campaign_id: null, start: 0, end: 20, approved: false } as unknown as Clip;
    for (const f of [
      factory({}, { autonomy: "auto", clips: [made] }),
      factory({ run_id: "run-1" }, { autonomy: "auto" }),
      factory({ state: "working", can_produce: false, job_id: "job-1" }, { autonomy: "auto" }),
      factory({}, { autonomy: "review" }),
    ]) {
      const { rerender, unmount } = render(screenFor(workspace(false), f));
      rerender(screenFor(workspace(), f));
      await new Promise((resolve) => setTimeout(resolve, 20));
      unmount();
    }
    expect(productionApi.campaignProduce).not.toHaveBeenCalled();
  });
});

describe("review wall in the Library", () => {
  it.each(["preview", "busy", "loading", "videos"])("holds source maintenance for %s state", reason => {
    const f = factory();
    if (reason === "preview") mode.preview = true;
    if (reason === "busy") f.busy = true;
    if (reason === "loading") f.loading = true;
    if (reason === "videos") f.errors.videos = "Source unavailable";
    render(<Library w={workspace()} factory={f} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} view="footage" />);
    fireEvent.click(screen.getByText("Source details"));
    expect(screen.getByRole("button", { name: "Rebuild storyboard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete source" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Podcast 1" })).toBeDisabled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("preserves deliberate storyboard rebuild and confirmed source deletion in episode details", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "job" })));
    vi.stubGlobal("fetch", fetch);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const f = factory();
    try {
      render(<Library w={workspace()} factory={f} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} view="footage" />);
      fireEvent.click(screen.getByText("Source details"));
      fireEvent.click(screen.getByRole("button", { name: "Rebuild storyboard" }));
      await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/videos/v1/storyboard", expect.objectContaining({ method: "POST", body: "{}" })));
      fetch.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Delete source" }));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Delete Podcast 1?"));
      expect(fetch).not.toHaveBeenCalled();
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "Delete source" }));
      await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/videos/v1", expect.objectContaining({ method: "DELETE" })));
    } finally { confirm.mockRestore(); }
  });

  it("holds source maintenance while its job is active or source status is stale", () => {
    const f = factory();
    f.data.jobs = [{ id: "working", kind: "storyboard", status: "running", context: { video_id: "v1" } }];
    const view = render(<Library w={workspace()} factory={f} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} view="footage" />);
    fireEvent.click(screen.getByText("Source details"));
    expect(screen.getByRole("button", { name: "Rebuild storyboard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete source" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Podcast 1" })).toBeDisabled();
    const stale = factory();
    stale.errors.jobs = "Status unavailable";
    view.rerender(<Library w={workspace()} factory={stale} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} view="footage" />);
    expect(screen.getByRole("button", { name: "Rebuild storyboard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete source" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Podcast 1" })).toBeDisabled();
  });

  const made = (id: string, changes: Partial<Clip> = {}): Clip =>
    ({
      id,
      name: id,
      video_id: "v1",
      campaign_id: "c1",
      profile_id: "p1",
      start: 0,
      end: 20,
      hook: `Hook ${id}`,
      caption: "",
      objective: "discovery",
      approved: false,
      team_run_id: "run",
      team_review_status: "not_applicable",
      hypothesis: "question",
      ...changes,
    }) as Clip;

  it("shows generated clips together without approval actions", () => {
    const clips = [made("a"), made("b", { approved: true, hypothesis: "story" }), made("elsewhere", { campaign_id: "another" })];
    render(<Library w={workspace()} factory={factory({}, { clips })} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} view="wall" />);
    const wall = document.querySelector(".gf-review-wall") as HTMLElement;
    expect(within(wall).getByText("Hook a")).toBeInTheDocument();
    expect(within(wall).getByText("Hook b")).toBeInTheDocument();
    expect(within(wall).queryByText("Hook elsewhere")).not.toBeInTheDocument();
    expect(within(wall).queryByRole("button", { name: /Approve|Needs review/ })).not.toBeInTheDocument();
    expect(within(wall).getByRole("button", { name: /Quality holds/ })).toBeInTheDocument();
    expect(requests.filter(request => request.method === "PUT")).toEqual([]);
  });

  it("episode cards say what is left to review instead of repeating the count", () => {
    const episodes = (f: FactoryState) =>
      <Library w={workspace()} factory={f} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} view="footage" />;
    const card = () => document.querySelector(".gf-episode-body") as HTMLElement;
    const view = render(episodes(factory({}, { clips: [made("a"), made("b", { approved: true })] })));
    expect(within(card()).getByText("1 to review")).toBeInTheDocument();
    expect(within(card()).getByText("2 clips")).toBeInTheDocument();
    view.rerender(episodes(factory({}, { clips: [made("a", { approved: true })] })));
    expect(within(card()).getByText("All approved")).toBeInTheDocument();
    view.rerender(episodes(factory()));
    expect(within(card()).getByText("0 clips")).toBeInTheDocument();
    expect(within(card()).queryByText(/to review|All approved|No clips yet/)).not.toBeInTheDocument();
  });

  it("empty clip lists point at the episode that is ready, not at adding footage", () => {
    const onFactory = vi.fn();
    const library = (view: "edits" | "wall") =>
      <Library w={workspace()} factory={factory()} onReview={vi.fn()} onProduce={vi.fn()} onFactory={onFactory} view={view} />;
    const view = render(library("edits"));
    expect(screen.getByText("Your episode is ready. Press Find clips in Factory and new clips land here.")).toBeInTheDocument();
    expect(screen.queryByText(/Add footage in Factory/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to Factory" }));
    expect(onFactory).toHaveBeenCalledTimes(1);
    view.rerender(library("wall"));
    expect(screen.getByText("Press Find clips on an episode in Factory and new clips land here.")).toBeInTheDocument();
  });

  describe("freeing space", () => {
    const deleted = () => requests.filter((r) => r.method === "DELETE").map((r) => r.url);
    const library = (w: Workspace, f: FactoryState) =>
      render(<Library w={w} factory={f} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} />);
    /** The local service refuses to delete these clips, in its own words. */
    function refuse(ids: string[], detail: string) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          requests.push({ url, method: init?.method ?? "GET" });
          const refused = init?.method === "DELETE" && ids.some((id) => url === `/api/clips/${id}`);
          return new Response(JSON.stringify(refused ? { detail } : {}), {
            status: refused ? 409 : 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );
    }
    let confirm: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    });
    afterEach(() => confirm.mockRestore());

    it("deletes nothing when the question is declined", async () => {
      confirm.mockReturnValue(false);
      library(workspace(), factory({}, { clips: [made("a"), made("b")] }));
      fireEvent.click(screen.getByRole("button", { name: "Play Hook b" }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
      fireEvent.click(screen.getByRole("button", { name: /Episodes/ }));
      fireEvent.click(screen.getByRole("button", { name: "Delete Podcast 1" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(deleted()).toEqual([]);
    });

    it("says which clips the local service kept, and why", async () => {
      refuse(["b"], "This exact version was exported. It is kept so the export can be verified against it.");
      library(workspace(), factory({}, { clips: [made("a"), made("b")] }));
      fireEvent.click(screen.getByRole("button", { name: "Play Hook b" }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
      const outcome = await screen.findByRole("alert");
      expect(outcome).toHaveTextContent("0 clips discarded. Not deleted: “Hook b”: This exact version was exported.");
    });

    it("selects several clips on the wall and deletes them together", async () => {
      const clips = [made("a"), made("b", { approved: true }), made("c")];
      render(<Library w={workspace()} factory={factory({}, { clips })} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} view="wall" />);
      fireEvent.click(screen.getByRole("button", { name: "Select" }));
      fireEvent.click(screen.getByRole("button", { name: "Select Hook a" }));
      fireEvent.click(screen.getByRole("button", { name: "Select Hook b" }));
      expect(screen.getByRole("button", { name: "Select Hook a" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Delete 2" }));
      await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Delete 2 clips (1 approved)?")));
      expect(await screen.findByText("2 clips discarded.")).toBeInTheDocument();
      expect(deleted().sort()).toEqual(["/api/clips/a", "/api/clips/b"]);
      expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();
    });

    it("selects every shown clip at once and keeps the selection when the question is declined", async () => {
      confirm.mockReturnValue(false);
      const clips = [made("a"), made("b"), made("c")];
      render(<Library w={workspace()} factory={factory({}, { clips })} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} view="wall" />);
      fireEvent.click(screen.getByRole("button", { name: "Select" }));
      fireEvent.click(screen.getByRole("button", { name: "Select all shown (3)" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete 3" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(deleted()).toEqual([]);
      expect(screen.getByText("3 selected")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Clear shown" }));
      expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Select Hook a" })).not.toBeInTheDocument();
    });

    it("drops clips a filter hides from the selection and deletes only what is shown", async () => {
      const clips = [made("a"), made("b", { published_at: "2026-11-01T00:00:00Z" }), made("c")];
      render(<Library w={workspace()} factory={factory({}, { clips })} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} view="wall" />);
      fireEvent.click(screen.getByRole("button", { name: "Select" }));
      fireEvent.click(screen.getByRole("button", { name: "Select all shown (3)" }));
      expect(screen.getByText("3 selected")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /^Posted/ }));
      expect(await screen.findByText("1 selected")).toBeInTheDocument();
      // Widening the filter again does not bring hidden clips back into the selection.
      fireEvent.click(screen.getByRole("button", { name: /^All clips/ }));
      expect(screen.getByText("1 selected")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Delete 1" }));
      expect(await screen.findByText("1 clip discarded.")).toBeInTheDocument();
      expect(deleted()).toEqual(["/api/clips/b"]);
    });

    it("drops clips of another hypothesis from the selection", async () => {
      const clips = [made("a"), made("b", { hypothesis: "story" }), made("c")];
      render(<Library w={workspace()} factory={factory({}, { clips })} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} view="wall" />);
      fireEvent.click(screen.getByRole("button", { name: "Select" }));
      fireEvent.click(screen.getByRole("button", { name: "Select all shown (3)" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Filter by hypothesis" }), { target: { value: "story" } });
      expect(await screen.findByText("1 selected")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Delete 1" })).toBeEnabled();
    });

    it("counts approved and exported clips before deleting, then names the ones kept", async () => {
      const reason = "This exact version was exported. It is kept so the export can be verified against it.";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const method = init?.method ?? "GET";
          requests.push({ url, method });
          if (method === "GET" && url === "/api/exports")
            return new Response(JSON.stringify([{ id: "e1", clip_id: "b" }, { id: "e2", clip_id: "c" }]), { status: 200, headers: { "Content-Type": "application/json" } });
          const refused = method === "DELETE" && ["/api/clips/b", "/api/clips/c"].includes(url);
          return new Response(JSON.stringify(refused ? { detail: reason } : {}), {
            status: refused ? 409 : 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );
      const clips = [made("a", { approved: true }), made("b", { approved: true }), made("c")];
      render(<Library w={workspace()} factory={factory({}, { clips })} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} view="wall" />);
      fireEvent.click(screen.getByRole("button", { name: "Select" }));
      fireEvent.click(screen.getByRole("button", { name: "Select all shown (3)" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete 3" }));
      await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Delete 3 clips (2 approved, 2 exported)?")));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Exported versions are kept"));
      const outcome = await screen.findByRole("alert");
      expect(outcome).toHaveTextContent(`1 clip discarded. Not deleted: “Hook b”, “Hook c”: ${reason}`);
    });

    it("says when export history could not be read before a bulk delete", async () => {
      confirm.mockReturnValue(false);
      const clips = [made("a"), made("b")];
      render(<Library w={workspace()} factory={factory({}, { clips })} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} view="wall" />);
      fireEvent.click(screen.getByRole("button", { name: "Select" }));
      fireEvent.click(screen.getByRole("button", { name: "Select all shown (2)" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete 2" }));
      await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Export history could not be read")));
      expect(deleted()).toEqual([]);
    });

    it("discards one clip from its quick look", async () => {
      library(workspace(), factory({}, { clips: [made("a"), made("b")] }));
      fireEvent.click(screen.getByRole("button", { name: "Play Hook a" }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Discard “Hook a”?"));
      expect(await screen.findByText("1 clip discarded.")).toBeInTheDocument();
      expect(deleted()).toEqual(["/api/clips/a"]);
    });

    it("deletes an episode together with everything made from it, then reloads the brand", async () => {
      // Clips of the same file from another campaign go too: the service keeps a source while any clip uses it.
      const clips = [made("a"), made("done", { approved: true }), made("elsewhere", { campaign_id: "another" })];
      const w = workspace();
      library(w, factory({}, { clips }));
      fireEvent.click(screen.getByRole("button", { name: /Episodes/ }));
      fireEvent.click(screen.getByRole("button", { name: "Delete Podcast 1" }));
      expect(confirm).toHaveBeenCalledWith(
        expect.stringContaining("Delete Podcast 1 and the 3 clips made from it (1 approved)?"),
      );
      expect(await screen.findByText("Podcast 1 and its 3 clips were deleted.")).toBeInTheDocument();
      expect(deleted().slice(0, 3).sort()).toEqual(["/api/clips/a", "/api/clips/done", "/api/clips/elsewhere"]);
      expect(deleted()[3]).toBe("/api/videos/v1");
      expect(w.load).toHaveBeenCalledWith("c1");
    });

    it("keeps the footage when one of its clips must be kept", async () => {
      refuse(["a"], "Later revisions build on this version.");
      library(workspace(), factory({}, { clips: [made("a"), made("b")] }));
      fireEvent.click(screen.getByRole("button", { name: /Episodes/ }));
      fireEvent.click(screen.getByRole("button", { name: "Delete Podcast 1" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Podcast 1 was kept: 1 of its clips could not be deleted. Later revisions build on this version.",
      );
      expect(deleted()).not.toContain("/api/videos/v1");
    });

    it("locks source maintenance until episode deletion has finished", async () => {
      let finish!: () => void;
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => {
        finish = () => resolve(new Response("{}"));
      })));
      const f = factory();
      library(workspace(), f);
      fireEvent.click(screen.getByRole("button", { name: /Episodes/ }));
      fireEvent.click(screen.getByRole("button", { name: "Delete Podcast 1" }));
      fireEvent.click(screen.getByText("Source details"));
      expect(screen.getByRole("button", { name: "Rebuild storyboard" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Delete source" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Delete Podcast 1" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Rebuild storyboard" }));
      expect(f.run).not.toHaveBeenCalled();
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      finish();
      expect(await screen.findByText("Podcast 1 was deleted.")).toBeInTheDocument();
    });
  });
});

describe("clips in the front door", () => {
  const cut = (id: string, changes: Partial<Clip> = {}): Clip =>
    ({
      id,
      name: `Cut ${id}`,
      video_id: "v1",
      campaign_id: "c1",
      profile_id: "p1",
      start: 0,
      end: 20,
      hook: `Hook ${id}`,
      caption: "",
      objective: "discovery",
      approved: false,
      ...changes,
    }) as Clip;
  // What the engine makes when it is run on a file directly: no workspace, no direction.
  const engineMade = (id: string, changes: Partial<Clip> = {}) =>
    cut(id, { campaign_id: null, profile_id: null, ...changes } as Partial<Clip>);

  it("counts what was made from this footage before a direction was approved", () => {
    const onReview = vi.fn();
    const onLibrary = vi.fn();
    const clips = [engineMade("x"), engineMade("y"), engineMade("elsewhere", { video_id: "v9" })];
    render(
      <FactoryHome
        w={workspace(false)}
        factory={factory({}, { clips })}
        onProduce={vi.fn()}
        onReview={onReview}
        onLibrary={onLibrary}
        onDirection={vi.fn()}
      />,
    );
    expect(screen.getByText("2 clips ready")).toBeInTheDocument(); // on the episode row
    expect(screen.queryByText("Hook elsewhere")).not.toBeInTheDocument();
    // They have no direction to be reviewed against, so review happens on the wall.
    fireEvent.click(screen.getByRole("button", { name: /Open 2 clips/ }));
    expect(onLibrary).toHaveBeenCalledWith("wall");
    expect(onReview).not.toHaveBeenCalled();
  });

  it("opens directed clips from an episode row in the Studio", () => {
    const onReview = vi.fn();
    const onLibrary = vi.fn();
    const clip = cut("a");
    render(
      <FactoryHome
        w={workspace()}
        factory={factory({}, { clips: [clip] })}
        onProduce={vi.fn()}
        onReview={onReview}
        onLibrary={onLibrary}
        onDirection={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open 1 clip/ }));
    expect(onReview).toHaveBeenCalledWith(clip);
    expect(onLibrary).not.toHaveBeenCalled();
  });

  it("inspects undirected clips locally without borrowing a Studio direction", () => {
    const onReview = vi.fn();
    render(<Library w={workspace(false)} factory={factory({}, { clips: [engineMade("x"), engineMade("elsewhere", { video_id: "v9" })] })} onReview={onReview} onProduce={vi.fn()} onFactory={vi.fn()} />);
    expect(screen.queryByText("Hook elsewhere")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect Cut x" }));
    expect(screen.getByLabelText("Playing Hook x")).toHaveAttribute("src", "/api/clips/x/media");
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: /Approve|Edit/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(onReview).not.toHaveBeenCalled();
    expect(requests.filter(request => request.method === "PUT")).toEqual([]);
  });

  it("keeps speechless test drafts out of the default list and warns on inspection", () => {
    const old = { ...cut("old"), made_without_speech: true };
    render(<Library w={workspace()} factory={factory({}, { clips: [cut("fresh"), old] })} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} />);
    expect(screen.getByText("Hook fresh")).toBeInTheDocument();
    expect(screen.queryByText("Hook old")).not.toBeInTheDocument();
    expect(screen.queryByText("Made without speech")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Older test drafts (1)"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include older test drafts" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Hook old" }));
    expect(within(screen.getByRole("dialog")).getByText(/generated without speech/)).toBeInTheDocument();
  });

  it("plays an edit from its cover in the Library list", () => {
    const onReview = vi.fn();
    const clip = cut("a");
    render(
      <Library
        w={workspace()}
        factory={factory({}, { clips: [clip] })}
        onReview={onReview}
        onProduce={vi.fn()}
        onFactory={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Play Hook a" }));
    const dialog = screen.getByLabelText("Playing Hook a").closest("dialog")!;
    // Preview chrome stays decorative: it cannot trigger a social action.
    expect(dialog.querySelector(".gf-reels-rail")).toHaveAttribute("aria-hidden", "true");
    expect(dialog.querySelectorAll(".gf-reels-rail li")).toHaveLength(5);
    expect(within(dialog).getAllByRole("button").map(button => button.textContent)).toEqual(["Edit / request change", "Remove", "Close"]);
    // From the quick look, review is one press away and closes the player.
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit / request change" }));
    expect(onReview).toHaveBeenCalledWith(clip);
    expect(screen.queryByLabelText("Playing Hook a")).not.toBeInTheDocument();
  });
});

describe("production response contract", () => {
  const envelope = (mode: string) => ({
    job: { id: "job-1", kind: mode, status: "queued", context: { video_id: "v1", team_run_id: "run-1" } },
    run: {
      id: "run-1",
      video_id: "v1",
      job_id: "job-1",
      model_id: "qwen-small",
      mode,
      status: "queued",
      objective: "discovery",
      revision_budget: 0,
      revision_count: 0,
      clip_ids: [],
      created_at: "2026-11-14T00:00:00+00:00",
      permissions: { publish: false, ads: false },
      tasks: [],
    },
  });

  it("accepts the run kind that was requested, with the swarm as the default", () => {
    expect(parseAgentProductionResponse(envelope("swarm"), {}, "swarm").run.id).toBe("run-1");
    expect(parseAgentProductionResponse(envelope("swarm")).run.id).toBe("run-1");
    expect(parseAgentProductionResponse(envelope("team"), {}, "team").run.id).toBe("run-1");
    expect(() => parseAgentProductionResponse(envelope("team"))).toThrow();
    expect(() => parseAgentProductionResponse(envelope("swarm"), {}, "team")).toThrow();
  });
});

describe("speech setup on the Factory screen", () => {
  it("shows the engine setup card and blocks Find clips for footage with sound until speech works", async () => {
    const message = "Speech recognition isn't set up yet. Set it up once (about 1.6 GB download) and run again.";
    const blocker = { code: "asr_missing", message, tab: "Models", scope: "speech", action: "speech_setup" as const };
    const steps = [
      { id: "runtime", label: "Speech engine packages", approx_gb: 1.4, state: "missing" as const },
      { id: "whisper-turbo", label: "Speech model (Whisper)", approx_gb: 1.6, state: "missing" as const },
    ];
    const f = factory({ can_produce: false, blocked_reason: message, blocked_code: "asr_missing" });
    f.data.factory!.blockers = [blocker];
    f.data.factory!.engine = {
      ready: false, blocker, steps, job: null, last_error: null,
      runtime: { state: "missing", problems: [] }, whisper: { state: "missing", problems: [] },
    };
    home(workspace(), f);
    expect(screen.getByRole("heading", { name: "Setting up your engine" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /set up speech recognition/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Find clips" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText(message).length).toBeGreaterThan(0);
  });
});
