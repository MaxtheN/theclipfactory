import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Campaign, Clip, FactorySource, Video } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import type { FactoryState } from "../useFactory";
import { workspaceApi } from "./workspaceApi";
import { productionApi } from "./productionApi";
import { parseAgentProductionResponse } from "./productionContracts";
import { FactoryHome } from "./FactoryHome";
import { Library } from "./Library";

vi.mock("./workspaceApi", () => ({
  reviewPreview: false,
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
function campaign(approved = true): Campaign {
  return {
    id: "c1",
    name: "Founder stories",
    brief: { audience: "Founders", constraints: [], requested_outputs: [], measurement_intent: "" },
    profile_ids: ["p1"],
    video_ids: ["v1"],
    active_strategy_id: approved ? "s1" : null,
  };
}
function workspace(approved = true): Workspace {
  return {
    campaign: campaign(approved),
    profileId: "p1",
    profiles: [{ id: "p1", name: "Founders" }],
    versions: approved ? [{ id: "s1", status: "approved", directions: { p1: direction } }] : [],
    busy: false,
    loading: false,
    error: "",
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
function home(w: Workspace, f: FactoryState) {
  return render(
    <FactoryHome w={w} factory={f} onProduce={vi.fn()} onReview={vi.fn()} onLibrary={vi.fn()} onDirection={vi.fn()} />,
  );
}
const swarm = {
  expected_strategy_version_id: "s1",
  video_id: "v1",
  profile_id: "p1",
  model_id: "qwen-small",
  strategy: "swarm",
};
let requests: { url: string; method: string }[];
beforeEach(() => {
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
    expect(blocked).toHaveAttribute("title", "Approve your style rules first.");
    first.unmount();
    home(workspace(), factory({}, { model: null }));
    expect(screen.getByRole("button", { name: "Find clips" })).toHaveAttribute(
      "title",
      "Set up a local model: Channel settings → Advanced → Advanced tools.",
    );
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
    expect(await screen.findByText(/The factory is making clips from it now/)).toBeInTheDocument();
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

describe("review wall in the Library", () => {
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

  it("shows this workspace's clips side by side and approves them in bulk", async () => {
    const clips = [
      made("a"),
      made("b", { hypothesis: "story" }),
      made("elsewhere", { campaign_id: "another" }),
    ];
    const f = factory({}, { clips });
    render(<Library w={workspace()} factory={f} onReview={vi.fn()} onProduce={vi.fn()} onFactory={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Review wall/ }));
    const wall = document.querySelector(".gf-review-wall") as HTMLElement;
    expect(within(wall).getByDisplayValue("Hook a")).toBeInTheDocument();
    expect(within(wall).getByDisplayValue("Hook b")).toBeInTheDocument();
    expect(within(wall).queryByDisplayValue("Hook elsewhere")).not.toBeInTheDocument();
    expect(within(wall).getByRole("combobox", { name: "Filter by hypothesis" })).toBeInTheDocument();
    fireEvent.click(within(wall).getByRole("button", { name: "Approve all 2 shown" }));
    await waitFor(() =>
      expect(requests.filter((r) => r.method === "PUT").map((r) => r.url).sort()).toEqual([
        "/api/clips/a",
        "/api/clips/b",
      ]),
    );
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

  it("accepts a swarm run only when a swarm was requested", () => {
    expect(parseAgentProductionResponse(envelope("swarm"), {}, "swarm").run.id).toBe("run-1");
    expect(parseAgentProductionResponse(envelope("team")).run.id).toBe("run-1");
    expect(() => parseAgentProductionResponse(envelope("swarm"))).toThrow();
    expect(() => parseAgentProductionResponse(envelope("team"), {}, "swarm")).toThrow();
  });
});
