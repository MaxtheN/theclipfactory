import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Campaign, Clip, Profile, TeamRun, Video } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import type { FactoryState } from "../useFactory";
import { ApiError } from "../api";
import { workspaceApi } from "./workspaceApi";
import { FactoryHome } from "./FactoryHome";
import { Library } from "./Library";

vi.mock("./workspaceApi", () => ({
  reviewPreview: false,
  workspaceApi: {
    profile: vi.fn(),
    save: vi.fn(),
    profiles: vi.fn(),
    campaigns: vi.fn(),
    upload: vi.fn(),
    updateProfile: vi.fn(),
    teamRuns: vi.fn(),
  },
}));
const brief = {
  audience: "Founders",
  constraints: ["Keep context"],
  requested_outputs: ["Vertical clips"],
  measurement_intent: "Discovery",
};
const campaign: Campaign = {
  id: "c1",
  name: "Founder stories",
  brief,
  profile_ids: ["p1"],
  video_ids: ["v1"],
  active_strategy_id: null,
};
const profile: Profile = {
  id: "p1",
  name: "Founders",
  audience: "Founders",
  objective: "discovery",
  primary_metric: null,
  brand_context: "",
  creative_preferences: "",
};
function workspace(): Workspace {
  return {
    campaign,
    campaigns: [campaign],
    profiles: [profile],
    profileId: "p1",
    versions: [],
    observations: [],
    selected: "c1",
    busy: false,
    loading: false,
    error: "",
    notice: "",
    load: vi.fn().mockResolvedValue(undefined),
    setProfileId: vi.fn(),
    select: vi.fn(),
    clearNotice: vi.fn(),
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
const video: Video = { id: "v1", name: "Conversation.mp4", duration: 60 };
function factory(clips: Clip[] = []): FactoryState {
  return {
    data: {
      videos: [video, { id: "other-video", name: "Other footage" }],
      clips,
      jobs: [],
    },
    loading: false,
    errors: {},
    refresh: vi.fn(),
  } as unknown as FactoryState;
}
const clip: Clip = {
  id: "clip1",
  name: "A useful edit",
  video_id: "v1",
  campaign_id: "c1",
  profile_id: "p1",
  start: 0,
  end: 30,
  hook: "A specific opening",
  caption: "",
  objective: "discovery",
  approved: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function home(w = workspace(), f = factory()) {
  const callbacks = {
    onProduce: vi.fn(),
    onReview: vi.fn(),
    onLibrary: vi.fn(),
    onDirection: vi.fn(),
  };
  const view = render(<FactoryHome w={w} factory={f} {...callbacks} />);
  return { ...view, ...callbacks, w, f };
}
function acknowledgeSource(view: ReturnType<typeof home>, sourceId = "v2") {
  const source = view.f.data.videos.find((row) => row.id === sourceId) || {
    id: sourceId,
    name: "New.mp4",
    duration: 90,
  };
  view.w.campaign = {
    ...view.w.campaign!,
    video_ids: [...new Set([...view.w.campaign!.video_ids, sourceId])],
  };
  view.w.error = "";
  view.f.data = {
    ...view.f.data,
    videos: [
      ...view.f.data.videos.filter((row) => row.id !== sourceId),
      source,
    ],
  };
  view.f.errors = { ...view.f.errors };
  delete view.f.errors.videos;
  view.rerender(
    <FactoryHome
      w={view.w}
      factory={view.f}
      onProduce={view.onProduce}
      onReview={view.onReview}
      onLibrary={view.onLibrary}
      onDirection={view.onDirection}
    />,
  );
}
function refreshNextRun(view: ReturnType<typeof home>, sourceId = "v2") {
  vi.mocked(view.w.run).mockImplementationOnce(async (task) => {
    try {
      await task();
      acknowledgeSource(view, sourceId);
      return true;
    } catch {
      return false;
    }
  });
}
function upload(name = "New.mp4") {
  fireEvent.change(screen.getByLabelText("Upload footage"), {
    target: { files: [new File(["video"], name, { type: "video/mp4" })] },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(workspaceApi.profile).mockImplementation(async (body) => ({
    ...body,
    id: "new-profile",
  }));
  vi.mocked(workspaceApi.updateProfile).mockImplementation(
    async (id, body) => ({ ...body, id }),
  );
  vi.mocked(workspaceApi.save).mockImplementation(async (body, id) => ({
    ...body,
    id: id || "new-campaign",
    active_strategy_id: null,
  }));
  vi.mocked(workspaceApi.profiles).mockResolvedValue([]);
  vi.mocked(workspaceApi.teamRuns).mockResolvedValue([]);
  vi.mocked(workspaceApi.campaigns).mockResolvedValue([campaign]);
  vi.mocked(workspaceApi.upload).mockResolvedValue({
    id: "v2",
    name: "New.mp4",
    duration: 90,
  });
});

describe("Factory imports and scoped Library", () => {
  it("waits for confirmed upload, attachment and workspace refresh before offering the new source for production", async () => {
    const current = {
      ...campaign,
      id: "delayed-import-campaign",
      video_ids: [],
    };
    const w = { ...workspace(), campaign: current },
      uploaded = deferred<Video>(),
      attached = deferred<Campaign>(),
      refreshed = deferred<void>();
    vi.mocked(workspaceApi.campaigns).mockResolvedValue([current]);
    vi.mocked(workspaceApi.upload).mockReturnValueOnce(uploaded.promise);
    vi.mocked(workspaceApi.save).mockReturnValueOnce(attached.promise);
    vi.mocked(w.run).mockImplementation(async (task) => {
      await task();
      await refreshed.promise;
      return true;
    });
    const view = home(w);
    upload();
    upload();
    expect(workspaceApi.upload).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Upload footage")).toBeDisabled();
    expect(screen.getByRole("region", { name: "Import" })).toHaveAttribute(
      "data-state",
      "uploading",
    );
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
    expect(workspaceApi.campaigns).not.toHaveBeenCalled();
    expect(workspaceApi.save).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Find clips" }),
    ).not.toBeInTheDocument();
    await act(async () =>
      uploaded.resolve({ id: "v2", name: "New.mp4", duration: 90 }),
    );
    expect(screen.getByRole("region", { name: "Import" })).toHaveAttribute(
      "data-state",
      "attaching",
    );
    expect(workspaceApi.save).toHaveBeenCalledExactlyOnceWith(
      { name: current.name, brief, profile_ids: ["p1"], video_ids: ["v2"] },
      current.id,
    );
    expect(
      screen.queryByRole("button", { name: "Find clips" }),
    ).not.toBeInTheDocument();
    await act(async () => attached.resolve({ ...current, video_ids: ["v2"] }));
    expect(screen.getByRole("region", { name: "Import" })).toHaveAttribute(
      "data-state",
      "refreshing",
    );
    expect(
      screen.queryByRole("button", { name: "Find clips" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Source saved and attached to this workspace."),
    ).not.toBeInTheDocument();
    acknowledgeSource(view);
    expect(screen.getByRole("region", { name: "Import" })).toHaveAttribute(
      "data-state",
      "refreshing",
    );
    await act(async () => refreshed.resolve());
    expect(screen.getByRole("region", { name: "Import" })).toHaveAttribute(
      "data-state",
      "ready",
    );
    fireEvent.click(
      within(screen.getByRole("region", { name: "Import" })).getByRole(
        "button",
        { name: "Find clips" },
      ),
    );
    expect(view.onProduce).toHaveBeenCalledExactlyOnceWith("v2", "agent");
    expect(workspaceApi.upload).toHaveBeenCalledOnce();
    expect(workspaceApi.save).toHaveBeenCalledOnce();
  });
  it.each(["id", "source", "profile"])(
    "retains a confirmed source when the attachment response has an invalid %s",
    async (invalid) => {
      const current = { ...campaign, id: `invalid-${invalid}-receipt` },
        w = { ...workspace(), campaign: current };
      vi.mocked(workspaceApi.campaigns).mockResolvedValue([current]);
      vi.mocked(workspaceApi.save).mockResolvedValueOnce({
        ...current,
        id: invalid === "id" ? "wrong-campaign" : current.id,
        video_ids: invalid === "source" ? ["v1"] : ["v1", "v2"],
        profile_ids: invalid === "profile" ? ["p2"] : ["p1"],
      });
      const view = home(w);
      upload();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "attachment was not confirmed",
      );
      const retry = screen.getByRole("button", {
        name: "Attach imported footage",
      });
      await waitFor(() => expect(retry).toBeEnabled());
      expect(
        screen.queryByRole("button", { name: "Add episode" }),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Upload footage")).toBeDisabled();
      refreshNextRun(view);
      fireEvent.click(retry);
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Attach imported footage" }),
        ).not.toBeInTheDocument(),
      );
      expect(workspaceApi.upload).toHaveBeenCalledOnce();
      expect(workspaceApi.save).toHaveBeenCalledTimes(2);
      expect(workspaceApi.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ video_ids: ["v1", "v2"] }),
        current.id,
      );
    },
  );
  it("adopts an already confirmed campaign attachment from GET without repeating the PUT", async () => {
    const current = { ...campaign, id: "already-attached-campaign" };
    vi.mocked(workspaceApi.campaigns).mockResolvedValue([
      { ...current, video_ids: ["v1", "v2"] },
    ]);
    const view = home({ ...workspace(), campaign: current });
    refreshNextRun(view);
    upload();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Import" })).toHaveAttribute(
        "data-state",
        "ready",
      ),
    );
    expect(workspaceApi.upload).toHaveBeenCalledOnce();
    expect(workspaceApi.save).not.toHaveBeenCalled();
  });
  it.each([422, 507])(
    "allows a corrected upload after a known %i rejection without treating it as an uncertain saved source",
    async (status) => {
      const current = { ...campaign, id: `rejected-upload-campaign-${status}` };
      vi.mocked(workspaceApi.campaigns).mockResolvedValue([current]);
      vi.mocked(workspaceApi.upload).mockRejectedValueOnce(
        new ApiError("Source was rejected before saving", status),
      );
      const view = home({ ...workspace(), campaign: current });
      upload();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Source was rejected before saving",
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Add episode" }),
        ).toBeEnabled(),
      );
      expect(
        screen.queryByRole("button", { name: "Check local footage" }),
      ).not.toBeInTheDocument();
      expect(workspaceApi.save).not.toHaveBeenCalled();
      refreshNextRun(view);
      upload("Corrected.mp4");
      await waitFor(() =>
        expect(screen.getByRole("region", { name: "Import" })).toHaveAttribute(
          "data-state",
          "ready",
        ),
      );
      expect(workspaceApi.upload).toHaveBeenCalledTimes(2);
      expect(workspaceApi.save).toHaveBeenCalledOnce();
    },
  );
  it("retains a confirmed attachment after refresh failure and retries only the refresh path", async () => {
    const current = { ...campaign, id: "attachment-refresh-failed" },
      w = { ...workspace(), campaign: current };
    vi.mocked(workspaceApi.campaigns)
      .mockResolvedValueOnce([current])
      .mockResolvedValue([{ ...current, video_ids: ["v1", "v2"] }]);
    vi.mocked(w.run).mockImplementationOnce(async (task) => {
      await task();
      return false;
    });
    const view = home(w);
    upload();
    await screen.findByRole("heading", {
      name: "Saved source needs a refresh",
    });
    expect(screen.getByLabelText("Upload footage")).toBeDisabled();
    expect(
      screen.queryByRole("heading", { name: "Episode added" }),
    ).not.toBeInTheDocument();
    refreshNextRun(view);
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh saved source" }),
    );
    await screen.findByRole("heading", { name: "Episode added" });
    expect(workspaceApi.upload).toHaveBeenCalledOnce();
    expect(workspaceApi.save).toHaveBeenCalledOnce();
    expect(w.run).toHaveBeenCalledTimes(2);
  });
  it.each(["videos-error", "missing-source", "missing-membership"])(
    "keeps the attachment receipt when a successful refresh leaves %s and recovers without another write",
    async (failure) => {
      const current = { ...campaign, id: `stale-refresh-${failure}` },
        view = home({ ...workspace(), campaign: current });
      vi.mocked(workspaceApi.campaigns).mockResolvedValue([current]);
      vi.mocked(view.w.run).mockImplementationOnce(async (task) => {
        await task();
        acknowledgeSource(view);
        if (failure === "videos-error")
          view.f.errors = { videos: "Local footage read failed" };
        if (failure === "missing-source")
          view.f.data = {
            ...view.f.data,
            videos: view.f.data.videos.filter((source) => source.id !== "v2"),
          };
        if (failure === "missing-membership") view.w.campaign = { ...current };
        view.rerender(
          <FactoryHome
            w={view.w}
            factory={view.f}
            onProduce={view.onProduce}
            onReview={view.onReview}
            onLibrary={view.onLibrary}
            onDirection={view.onDirection}
          />,
        );
        return true;
      });
      upload();
      await screen.findByRole("heading", {
        name: "Saved source needs a refresh",
      });
      expect(
        screen.queryByRole("heading", { name: "Episode added" }),
      ).not.toBeInTheDocument();
      const refresh = screen.getByRole("button", {
        name: "Refresh saved source",
      });
      expect(refresh).toBeEnabled();
      expect(screen.getByLabelText("Upload footage")).toBeDisabled();
      expect(view.onProduce).not.toHaveBeenCalled();
      vi.mocked(workspaceApi.campaigns).mockResolvedValue([
        { ...current, video_ids: ["v1", "v2"] },
      ]);
      refreshNextRun(view);
      fireEvent.click(refresh);
      await screen.findByRole("heading", { name: "Episode added" });
      expect(workspaceApi.upload).toHaveBeenCalledOnce();
      expect(workspaceApi.save).toHaveBeenCalledOnce();
      expect(view.w.run).toHaveBeenCalledTimes(2);
    },
  );
  it("requires a new explicit attachment if a refresh no longer confirms a previously attached receipt", async () => {
    const current = { ...campaign, id: "attachment-no-longer-present" },
      view = home({ ...workspace(), campaign: current });
    vi.mocked(workspaceApi.campaigns).mockResolvedValue([current]);
    vi.mocked(view.w.run).mockImplementationOnce(async (task) => {
      await task();
      return false;
    });
    upload();
    await screen.findByRole("button", { name: "Refresh saved source" });
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh saved source" }),
    );
    const attach = await screen.findByRole("button", {
      name: "Attach imported footage",
    });
    expect(workspaceApi.upload).toHaveBeenCalledOnce();
    expect(workspaceApi.save).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("heading", { name: "Episode added" }),
    ).not.toBeInTheDocument();
    refreshNextRun(view);
    fireEvent.click(attach);
    await screen.findByRole("heading", { name: "Episode added" });
    expect(workspaceApi.upload).toHaveBeenCalledOnce();
    expect(workspaceApi.save).toHaveBeenCalledTimes(2);
    expect(workspaceApi.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ video_ids: ["v1", "v2"] }),
      current.id,
    );
  });
  it("keeps an unknown upload locked across remounts until a saved source is explicitly identified", async () => {
    const current = { ...campaign, id: "unknown-upload-campaign" },
      w = { ...workspace(), campaign: current },
      f = factory();
    f.data.videos.push({ id: "preexisting", name: "Unknown.mp4" });
    vi.mocked(workspaceApi.campaigns).mockResolvedValue([current]);
    vi.mocked(workspaceApi.upload).mockRejectedValueOnce(
      new Error("Connection closed after write"),
    );
    const first = home(w, f);
    upload("Unknown.mp4");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "upload response was not confirmed",
    );
    expect(screen.getByLabelText("Upload footage")).toBeDisabled();
    first.unmount();
    const restored = home(w, f);
    expect(
      screen.getByRole("heading", { name: "Let’s confirm your upload" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Upload footage")).toBeDisabled();
    upload("Unknown.mp4");
    expect(workspaceApi.upload).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "Check local footage" }),
    );
    await screen.findByText(
      "No matching saved source is confirmed yet. Check again; the original request may still be finishing.",
    );
    expect(screen.getByLabelText("Upload footage")).toBeDisabled();
    expect(workspaceApi.save).not.toHaveBeenCalled();
    vi.mocked(f.refresh).mockImplementationOnce(async () => {
      f.data.videos = [
        ...f.data.videos,
        { id: "savedA11", name: "Unknown.mp4" },
        { id: "savedB22", name: "Unknown.mp4" },
      ];
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Check local footage" }),
    );
    const chosen = await screen.findByRole("button", {
      name: "Use saved source savedB22",
    });
    expect(
      screen.getAllByRole("button", { name: /^Use saved source/ }),
    ).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Use saved source preexist" }),
    ).not.toBeInTheDocument();
    expect(workspaceApi.upload).toHaveBeenCalledOnce();
    expect(workspaceApi.save).not.toHaveBeenCalled();
    fireEvent.click(chosen);
    expect(workspaceApi.save).not.toHaveBeenCalled();
    refreshNextRun(restored, "savedB22");
    fireEvent.click(
      screen.getByRole("button", { name: "Attach imported footage" }),
    );
    await screen.findByRole("heading", { name: "Episode added" });
    expect(workspaceApi.upload).toHaveBeenCalledOnce();
    expect(workspaceApi.save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ video_ids: ["v1", "savedB22"] }),
      current.id,
    );
    expect(f.refresh).toHaveBeenCalledWith(["videos"]);
    expect(w.load).toHaveBeenCalledWith(current.id);
  });
  it("offers review only for actual scoped clips rather than a completed job or another workspace output", async () => {
    const w = workspace(),
      f = factory([
        {
          ...clip,
          id: "foreign-profile",
          name: "Another profile output",
          profile_id: "p2",
        },
        {
          ...clip,
          id: "foreign-campaign",
          name: "Another campaign output",
          campaign_id: "c2",
        },
        {
          ...clip,
          id: "detached-output",
          name: "Detached source output",
          video_id: "other-video",
        },
      ]);
    f.data.jobs = [
      {
        id: "finished-without-output",
        kind: "team",
        status: "completed",
        progress: 100,
        context: { video_id: "v1", campaign_id: "c1", profile_id: "p1" },
        result: {},
      },
    ];
    const view = home(w, f);
    await waitFor(() => expect(workspaceApi.teamRuns).toHaveBeenCalled());
    expect(
      screen.queryByText(
        /Another profile output|Another campaign output|Detached source output/,
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Review \d+ clips?$/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Waiting for the saved edits" }),
    ).toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: "Production progress" }),
    ).not.toHaveAttribute("value");
    fireEvent.click(screen.getByRole("button", { name: "Refresh outputs" }));
    expect(f.refresh).toHaveBeenCalledExactlyOnceWith(["jobs", "clips"]);
    expect(view.onReview).not.toHaveBeenCalled();
    f.data.clips = [
      ...f.data.clips,
      clip,
      {
        ...clip,
        id: "approved",
        name: "Already accepted output",
        approved: true,
      },
    ];
    view.rerender(
      <FactoryHome
        w={w}
        factory={f}
        onProduce={view.onProduce}
        onReview={view.onReview}
        onLibrary={view.onLibrary}
        onDirection={view.onDirection}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Review \d+ clips?$/ }));
    expect(view.onReview).toHaveBeenCalledExactlyOnceWith(clip);
    expect(
      screen.queryByText("Already accepted output"),
    ).not.toBeInTheDocument();
  });
  it("keeps unknown worker progress indeterminate and exposes a failed run without automatically retrying it", async () => {
    const w = workspace(),
      f = factory();
    f.data.jobs = [
      {
        id: "pending-worker",
        kind: "team",
        status: "running",
        progress: null,
        message: "Inspecting the supplied source",
        context: { video_id: "v1", campaign_id: "c1", profile_id: "p1" },
      },
    ];
    const view = home(w, f);
    await screen.findByText("Inspecting the supplied source");
    expect(
      screen.getByRole("progressbar", { name: "Production progress" }),
    ).not.toHaveAttribute("value");
    expect(
      screen.queryByRole("button", { name: /^Review \d+ clips?$/ }),
    ).not.toBeInTheDocument();
    f.data.jobs = [
      {
        ...f.data.jobs[0],
        status: "failed",
        error: "Local worker lost its model connection",
      },
    ];
    view.rerender(
      <FactoryHome
        w={w}
        factory={f}
        onProduce={view.onProduce}
        onReview={view.onReview}
        onLibrary={view.onLibrary}
        onDirection={view.onDirection}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Production needs attention" }),
    ).toBeVisible();
    expect(
      screen.getByText("Local worker lost its model connection"),
    ).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(view.onProduce).not.toHaveBeenCalled();
    expect(w.run).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Review production status" }),
    );
    expect(view.onProduce).toHaveBeenCalledExactlyOnceWith("v1", "agent");
    expect(workspaceApi.upload).not.toHaveBeenCalled();
    expect(workspaceApi.save).not.toHaveBeenCalled();
  });
  it("keeps a preview-fixture Factory output explicitly illustrative in native mode", async () => {
    const illustrative = { ...clip, provenance_mode: "preview_fixture" },
      view = home(workspace(), factory([illustrative]));
    await screen.findByText("Illustrative edit");
    fireEvent.click(screen.getByRole("button", { name: /^Review \d+ clips?$/ }));
    expect(view.onReview).toHaveBeenCalledExactlyOnceWith(illustrative);
    expect(illustrative.approved).toBe(false);
  });
  it("shows real team progress through the nested run snapshot without another profile’s jobs", async () => {
    vi.mocked(workspaceApi.teamRuns).mockResolvedValue([
      {
        id: "our-run",
        context: { campaign_snapshot: { campaign_id: "c1", profile_id: "p1" } },
      } as TeamRun,
      {
        id: "other-run",
        context: { campaign_snapshot: { campaign_id: "c1", profile_id: "p2" } },
      } as TeamRun,
    ]);
    const f = factory();
    f.data.jobs = [
      {
        id: "our-job",
        kind: "team",
        status: "running",
        progress: 37,
        message: "Inspecting source moments",
        context: { video_id: "v1", team_run_id: "our-run" },
      },
      {
        id: "other-job",
        kind: "team",
        status: "running",
        progress: 92,
        message: "Another profile’s job",
        context: { video_id: "v1", team_run_id: "other-run" },
      },
    ];
    render(
      <FactoryHome
        w={workspace()}
        factory={f}
        onProduce={vi.fn()}
        onReview={vi.fn()}
        onLibrary={vi.fn()}
        onDirection={vi.fn()}
      />,
    );
    await screen.findByText("Inspecting source moments");
    expect(
      screen.getByRole("progressbar", { name: "Production progress" }),
    ).toHaveAttribute("value", "37");
    expect(screen.queryByText("Another profile’s job")).not.toBeInTheDocument();
  });
  it("reports unavailable agent run status instead of implying the queue is empty", async () => {
    vi.mocked(workspaceApi.teamRuns).mockRejectedValueOnce(
      new Error("Ledger unavailable"),
    );
    render(
      <FactoryHome
        w={workspace()}
        factory={factory()}
        onProduce={vi.fn()}
        onReview={vi.fn()}
        onLibrary={vi.fn()}
        onDirection={vi.fn()}
      />,
    );
    await screen.findByText("Agent run status is unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Check run status" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Agent run status is unavailable"),
      ).not.toBeInTheDocument(),
    );
    expect(workspaceApi.teamRuns).toHaveBeenCalledTimes(2);
  });
  it("retains an import receipt across profile and workspace remounts for attach-only recovery", async () => {
    const current = {
      ...campaign,
      id: "recovery-campaign",
      profile_ids: ["p1", "p2"],
    };
    const w = { ...workspace(), campaign: current };
    vi.mocked(workspaceApi.campaigns).mockResolvedValue([current]);
    vi.mocked(workspaceApi.save).mockRejectedValueOnce(
      new Error("Attach interrupted"),
    );
    const props = {
      factory: factory(),
      onProduce: vi.fn(),
      onReview: vi.fn(),
      onLibrary: vi.fn(),
      onDirection: vi.fn(),
    };
    const first = render(<FactoryHome w={w} {...props} />);
    fireEvent.change(screen.getByLabelText("Upload footage"), {
      target: {
        files: [new File(["video"], "New.mp4", { type: "video/mp4" })],
      },
    });
    await screen.findByRole("button", { name: "Attach imported footage" });
    await waitFor(() => expect(workspaceApi.save).toHaveBeenCalledOnce());
    await vi.mocked(w.run).mock.results[0].value;
    first.unmount();
    const elsewhere = render(
      <FactoryHome
        w={{ ...workspace(), campaign: { ...campaign, id: "elsewhere" } }}
        {...props}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Attach imported footage" }),
    ).not.toBeInTheDocument();
    elsewhere.unmount();
    const restored = home(
      { ...workspace(), campaign: current, profileId: "p2" },
      props.factory,
    );
    refreshNextRun(restored);
    fireEvent.click(
      screen.getByRole("button", { name: "Attach imported footage" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Attach imported footage" }),
      ).not.toBeInTheDocument(),
    );
    expect(workspaceApi.upload).toHaveBeenCalledTimes(1);
    expect(workspaceApi.save).toHaveBeenCalledTimes(2);
  });
  it("reattaches the confirmed import without uploading twice or spreading GET fields", async () => {
    vi.mocked(workspaceApi.save).mockRejectedValueOnce(
      new Error("Attach failed"),
    );
    vi.mocked(workspaceApi.campaigns).mockResolvedValue([
      {
        ...campaign,
        video_ids: ["v1", "concurrent-source"],
        active_strategy_id: "approved-version",
      },
    ]);
    const view = home();
    fireEvent.change(screen.getByLabelText("Upload footage"), {
      target: {
        files: [new File(["video"], "New.mp4", { type: "video/mp4" })],
      },
    });
    const retry = await screen.findByRole("button", {
      name: "Attach imported footage",
    });
    await waitFor(() => expect(retry).toBeEnabled());
    refreshNextRun(view);
    fireEvent.click(retry);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Attach imported footage" }),
      ).not.toBeInTheDocument(),
    );
    expect(workspaceApi.upload).toHaveBeenCalledTimes(1);
    expect(workspaceApi.save).toHaveBeenCalledTimes(2);
    const body = vi.mocked(workspaceApi.save).mock.calls[1][0];
    expect(body.video_ids).toEqual(["v1", "concurrent-source", "v2"]);
    expect(Object.keys(body).sort()).toEqual([
      "brief",
      "name",
      "profile_ids",
      "video_ids",
    ]);
  });
  it("excludes another campaign, profile, and unattached source and opens the exact review identity", () => {
    const review = vi.fn();
    render(
      <Library
        w={workspace()}
        factory={factory([
          clip,
          {
            ...clip,
            id: "foreign-campaign",
            name: "Wrong campaign",
            campaign_id: "c2",
          },
          {
            ...clip,
            id: "foreign-profile",
            name: "Wrong profile",
            profile_id: "p2",
          },
          {
            ...clip,
            id: "foreign-source",
            name: "Wrong source",
            video_id: "other-video",
          },
        ])}
        onReview={review}
        onProduce={vi.fn()}
        onFactory={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Wrong/)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Review A useful edit" }),
    );
    expect(review).toHaveBeenCalledWith(clip);
    fireEvent.click(screen.getByRole("button", { name: /^Episodes/ }));
    expect(screen.getByText("Conversation.mp4")).toBeInTheDocument();
    expect(screen.queryByText("Other footage")).not.toBeInTheDocument();
  });
  it("uses campaign-order source labels while original filenames remain searchable and production keeps the exact ID", () => {
    const produce = vi.fn(),
      f = factory();
    f.data.videos.reverse();
    render(
      <Library
        w={{
          ...workspace(),
          campaign: { ...campaign, video_ids: ["v1", "other-video"] },
        }}
        factory={f}
        onReview={vi.fn()}
        onProduce={produce}
        onFactory={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Episodes/ }));
    const filter = screen.getByRole("searchbox", { name: "Filter library" });
    fireEvent.change(filter, { target: { value: "Podcast 2" } });
    expect(screen.getByText("Podcast 2")).toBeInTheDocument();
    expect(screen.queryByText("Podcast 1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Find clips" }));
    expect(produce).toHaveBeenCalledExactlyOnceWith("other-video", "agent");
    fireEvent.change(filter, { target: { value: "Conversation.mp4" } });
    expect(screen.getByText("Podcast 1")).toBeInTheDocument();
    expect(screen.queryByText("Podcast 2")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Source details"));
    expect(screen.getByText("Conversation.mp4")).toBeVisible();
    expect(screen.getByText("v1")).toBeVisible();
    expect(f.data.videos.find((source) => source.id === "v1")?.name).toBe(
      "Conversation.mp4",
    );
  });
  it("labels illustrative record provenance in the native Library and retains the exact review identity", () => {
    const illustrative = { ...clip, provenance_mode: "preview_fixture" },
      review = vi.fn();
    render(
      <Library
        w={workspace()}
        factory={factory([illustrative])}
        onReview={review}
        onProduce={vi.fn()}
        onFactory={vi.fn()}
      />,
    );
    expect(screen.getByText("Illustrative edit")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Review A useful edit" }),
    );
    expect(review).toHaveBeenCalledExactlyOnceWith(illustrative);
    expect(illustrative.approved).toBe(false);
  });
});
