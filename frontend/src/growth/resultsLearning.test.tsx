import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  Campaign,
  Direction,
  Observation,
  Profile,
  StrategyVersion,
  TeamRun,
} from "../types";
import type { FactoryState } from "../useFactory";
import type { Workspace } from "./useCampaignWorkspace";
import { Results } from "./Results";
import { Setup } from "./Setup";
import { workspaceApi } from "./workspaceApi";

const direction = (): Direction => ({
  angles: ["Useful claim"],
  moment_selection: "A complete original thought",
  hooks: ["Original opening", "Alternative"],
  pacing: "Preserve context",
  duration_seconds: 30,
  framing: "fit",
  caption_style: "standard",
  editing_preferences: "Readable captions",
  measurement_questions: [],
  next_experiments: [],
  evidence_refs: [],
  limitations: "Untested",
  confidence: "low",
});
function fixture() {
  const profiles: Profile[] = [
    {
      id: "profile-a",
      name: "All-In demo",
      audience: "Builders",
      brand_context: "Brand context",
      objective: "discovery",
      primary_metric: null,
      creative_preferences: "Meaning first",
      production_history: [{ id: "read-only-history" }],
    } as Profile,
    {
      id: "profile-b",
      name: "Separate profile",
      audience: "Other audience",
      brand_context: "Other context",
      objective: "traffic",
      primary_metric: "qualified_visits",
      creative_preferences: "Different direction",
    },
  ];
  const campaign: Campaign = {
    id: "campaign-a",
    name: "Campaign A",
    brief: {
      audience: "Builders",
      constraints: [],
      requested_outputs: [],
      measurement_intent: "Descriptive brief intent",
    },
    profile_ids: profiles.map((p) => p.id),
    video_ids: ["source-a", "source-b"],
    active_strategy_id: "version-a",
  };
  const active: StrategyVersion = {
    id: "version-a",
    campaign_id: campaign.id,
    version: 1,
    status: "approved",
    base_version_id: null,
    reason: "Initial",
    hypothesis: "",
    created_at: "2026-11-13T00:00:00Z",
    approved_at: "2026-11-13T00:00:00Z",
    changed_profile_ids: campaign.profile_ids,
    directions: Object.fromEntries(profiles.map((p) => [p.id, direction()])),
  };
  const observations: Observation[] = [
    {
      id: "observation-a",
      profile_id: profiles[0].id,
      clip_id: "clip-a",
      metric: "visits",
      value: 12,
      unit: "count",
      source: "manual_import",
      publication_reference: "Publication A",
      window_start: "2026-11-12T00:00:00Z",
      window_end: "2026-11-13T00:00:00Z",
      collected_at: "2026-11-13T01:00:00Z",
      notes: "Observed only",
    },
  ];
  const run = vi.fn(async (task: () => Promise<unknown>) => {
    try {
      await task();
      return true;
    } catch {
      return false;
    }
  });
  const w = {
    profiles,
    campaign,
    campaigns: [campaign],
    selected: campaign.id,
    profileId: profiles[0].id,
    versions: [active],
    observations,
    loading: false,
    busy: false,
    error: "",
    notice: "",
    run,
    load: vi.fn(),
    select: vi.fn(),
    setProfileId: vi.fn(),
    clearNotice: vi.fn(),
  } as unknown as Workspace;
  const factory = {
    loading: false,
    busy: false,
    errors: {},
    data: {
      videos: [
        { id: "source-a", name: "Source A", duration: 60 },
        { id: "source-b", name: "Source B", duration: 60 },
      ],
      clips: [
        {
          id: "clip-a",
          name: "Approved original",
          campaign_id: campaign.id,
          profile_id: profiles[0].id,
          approved: true,
          video_id: "source-a",
        },
      ],
      jobs: [],
    },
  } as unknown as FactoryState;
  return { w, factory, active, profiles };
}
beforeEach(() => vi.restoreAllMocks());

describe("selected profile goal control", () => {
  it("writes only selected-profile writable fields and keeps a failed draft", async () => {
    const { w, factory, profiles } = fixture();
    vi.spyOn(workspaceApi, "campaigns").mockResolvedValue([w.campaign!]);
    vi.spyOn(workspaceApi, "profiles").mockResolvedValue(profiles);
    const save = vi.spyOn(workspaceApi, "save");
    const update = vi
      .spyOn(workspaceApi, "updateProfile")
      .mockRejectedValue(new Error("Profile save failed"));
    render(
      <Setup
        w={w}
        factory={factory}
        creating={false}
        next={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Campaign brief intent")).toBeNull();
    fireEvent.change(screen.getByLabelText("What are we working toward?"), {
      target: { value: "traffic" },
    });
    expect(
      screen.getByRole("button", { name: "Save channel settings" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Primary metric"), {
      target: { value: "full_episode_visits" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save channel settings" }),
    );
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("profile-a", {
        name: profiles[0].name,
        audience: profiles[0].audience,
        brand_context: profiles[0].brand_context,
        creative_preferences: profiles[0].creative_preferences,
        objective: "traffic",
        primary_metric: "full_episode_visits",
      }),
    );
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByLabelText("What are we working toward?")).toHaveValue(
      "traffic",
    );
    expect(screen.getByLabelText("Primary metric")).toHaveValue(
      "full_episode_visits",
    );
    expect(profiles[1].primary_metric).toBe("qualified_visits");
    expect(profiles[0].objective).toBe("discovery");
  });
});

describe("real next-edit decisions", () => {
  it("does not approve a metadata-only proposal with no production change", () => {
    const { w, factory, active } = fixture();
    w.versions.push({
      ...active,
      id: "metadata-only",
      version: 2,
      status: "proposed",
      base_version_id: active.id,
      changed_profile_ids: [w.profileId],
      hypothesis: "A different description",
      directions: {
        ...active.directions,
        [w.profileId]: {
          ...active.directions[w.profileId],
          evidence_refs: ["observation-a"],
        },
      },
    });
    render(<Results w={w} factory={factory} next={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: "Approve next test" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save next test draft" }),
    ).toBeDisabled();
  });
  it("saves an actual opening change and approves only the visible saved value before manual production", async () => {
    const { w, factory, active } = fixture(),
      next = vi.fn();
    let proposed: StrategyVersion;
    const learn = vi
      .spyOn(workspaceApi, "learn")
      .mockImplementation(async (_id, body) => {
        proposed = {
          ...active,
          id: "version-b",
          version: 2,
          status: "proposed",
          base_version_id: active.id,
          changed_profile_ids: [w.profileId],
          hypothesis: body.hypothesis,
          directions: {
            ...active.directions,
            [w.profileId]: {
              ...body.proposed_direction,
              evidence_refs: body.observation_ids,
            },
          },
        };
        return proposed;
      });
    const approve = vi
      .spyOn(workspaceApi, "approve")
      .mockResolvedValue({ ...active, id: "version-b", version: 2 });
    const view = render(<Results w={w} factory={factory} next={next} />);
    fireEvent.change(screen.getByLabelText("What changes in the next edit?"), {
      target: { value: "opening" },
    });
    fireEvent.change(screen.getByLabelText("Proposed opening text"), {
      target: { value: "A concrete new opening" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Propose next test" }));
    await waitFor(() => expect(learn).toHaveBeenCalledTimes(1));
    expect(learn.mock.calls[0][1].proposed_direction.hooks[0]).toBe(
      "A concrete new opening",
    );
    expect(learn.mock.calls[0][1].proposed_direction.moment_selection).toBe(
      active.directions[w.profileId].moment_selection,
    );
    w.versions = [active, proposed!];
    view.rerender(<Results w={w} factory={factory} next={next} />);
    expect(
      screen.getByRole("button", { name: "Approve next test" }),
    ).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Proposed opening text"), {
      target: { value: "An unsaved other opening" },
    });
    expect(
      screen.queryByRole("button", { name: "Approve next test" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save next test draft" }),
    ).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Proposed opening text"), {
      target: { value: "A concrete new opening" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve next test" }));
    await waitFor(() =>
      expect(next).toHaveBeenCalledWith("source-b", "manual"),
    );
    expect(approve).toHaveBeenCalledWith(w.campaign!.id, "version-b");
  });
  it("routes an approved descriptive selection change through agent planning", async () => {
    const { w, factory, active } = fixture(),
      next = vi.fn();
    const draft = {
      ...active.directions[w.profileId],
      moment_selection: "Find a contrary claim backed by its context.",
      evidence_refs: ["observation-a"],
    };
    w.versions.push({
      ...active,
      id: "version-b",
      version: 2,
      status: "proposed",
      base_version_id: active.id,
      changed_profile_ids: [w.profileId],
      hypothesis: "Test a contrary claim",
      directions: { ...active.directions, [w.profileId]: draft },
    });
    vi.spyOn(workspaceApi, "approve").mockResolvedValue({
      ...active,
      id: "version-b",
      version: 2,
    });
    render(<Results w={w} factory={factory} next={next} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve next test" }));
    await waitFor(() => expect(next).toHaveBeenCalledWith("source-b", "agent"));
  });
  it("reads only scoped completed analyst output and applies it to a draft without a write", async () => {
    const { w, factory } = fixture(),
      next = vi.fn();
    const makeRun = (id: string, profile: string, text: string): TeamRun => ({
      id,
      video_id: "source-a",
      mode: "team",
      model_id: "ollama:test",
      objective: "traffic",
      status: "needs_review",
      job_id: `job-${id}`,
      revision_budget: 2,
      revision_count: 0,
      stop_reason: null,
      created_at: "2026-11-13T00:00:00Z",
      started_at: null,
      finished_at: null,
      elapsed_seconds: 1,
      resource_observations: {},
      clip_ids: ["clip-a"],
      plan: null,
      context: {
        campaign_snapshot: { campaign_id: w.campaign!.id, profile_id: profile },
      },
      permissions: { publish: false, ads: false },
      tasks: [
        {
          id: `task-${id}`,
          role: "performance_analyst",
          label: "Performance analyst",
          kind: "agent",
          status: "completed",
          iteration: 0,
          input_refs: ["event:observation-a"],
          output: {
            recommendations: [
              {
                recommendation: text,
                limitation: "Observed only; not proof of improvement",
                evidence_refs: ["event:observation-a"],
              },
            ],
          },
          error: null,
          started_at: null,
          finished_at: null,
        },
      ],
    });
    vi.spyOn(workspaceApi, "teamRuns").mockResolvedValue([
      makeRun(
        "run-a",
        "profile-a",
        "Find a more direct opening from the source.",
      ),
      makeRun("foreign", "profile-b", "Foreign profile suggestion"),
    ]);
    const learn = vi.spyOn(workspaceApi, "learn"),
      approve = vi.spyOn(workspaceApi, "approve");
    render(<Results w={w} factory={factory} next={next} />);
    fireEvent.click(screen.getByText("Performance analyst recommendations"));
    fireEvent.click(
      screen.getByRole("button", { name: "Load analyst recommendations" }),
    );
    await screen.findByText("Find a more direct opening from the source.");
    expect(
      screen.queryByText("Foreign profile suggestion"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Use as a planning draft" }),
    );
    expect(screen.getByLabelText("Proposed source-selection rule")).toHaveValue(
      "Find a more direct opening from the source.",
    );
    expect(learn).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
