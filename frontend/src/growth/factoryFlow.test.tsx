import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Campaign, Clip, Profile, TeamRun, Video } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import type { FactoryState } from "../useFactory";
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
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(workspaceApi.profile).mockImplementation(async (body) => ({
    ...body,
    id: "new-profile",
  }));
  vi.mocked(workspaceApi.updateProfile).mockImplementation(
    async (id, body) => ({ ...body, id }),
  );
  vi.mocked(workspaceApi.save).mockImplementation(async (body) => ({
    ...body,
    id: "new-campaign",
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
    render(
      <FactoryHome
        w={{ ...workspace(), campaign: current, profileId: "p2" }}
        {...props}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Attach imported footage" }),
    );
    await screen.findByText(
      "New.mp4 added. Open production when you’re ready.",
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
    fireEvent.change(screen.getByLabelText("Upload footage"), {
      target: {
        files: [new File(["video"], "New.mp4", { type: "video/mp4" })],
      },
    });
    const retry = await screen.findByRole("button", {
      name: "Attach imported footage",
    });
    fireEvent.click(retry);
    await screen.findByText(
      "New.mp4 added. Open production when you’re ready.",
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
    fireEvent.click(screen.getByRole("button", { name: /^Footage/ }));
    expect(screen.getByText("Conversation.mp4")).toBeInTheDocument();
    expect(screen.queryByText("Other footage")).not.toBeInTheDocument();
  });
});
