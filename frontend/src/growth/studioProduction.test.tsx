import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clip as baseClip, testState } from "../test-state";
import type { FactoryState } from "../useFactory";
import type { Job, TeamRun } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import { Studio } from "./Studio";
import { productionApi } from "./productionApi";
import { workspaceApi } from "./workspaceApi";
import type { ProductionClip } from "./productionContracts";
const mode = vi.hoisted(() => ({ preview: false }));
vi.mock("./workspaceApi", async () => {
  const actual = await vi.importActual<typeof import("./workspaceApi")>("./workspaceApi");
  return { ...actual, get reviewPreview() { return mode.preview; }, workspaceApi: { ...actual.workspaceApi, teamRuns: vi.fn() } };
});
vi.mock("./productionApi", async () => {
  const actual = await vi.importActual<typeof import("./productionApi")>("./productionApi");
  return { ...actual, productionApi: { campaignRender: vi.fn(), campaignProduce: vi.fn(), review: vi.fn(), recheck: vi.fn(), listExports: vi.fn(), createVerifiedExport: vi.fn(), cancelJob: vi.fn(), importTranscript: vi.fn(), transcribe: vi.fn() } };
});
const direction = { angles: [], moment_selection: "Complete thought", hooks: ["An approved opening"], pacing: "Clear", duration_seconds: 24, framing: "fill" as const, caption_style: "standard" as const, editing_preferences: "Original audio", measurement_questions: [], next_experiments: [], evidence_refs: [], limitations: "Hypothesis", confidence: "low" as const };
const plan = { start: 0, end: 10, hook: "Hook", subtitles: true, opening_treatment: "text_overlay" as const, hook_overlay: true, cold_open_start: null, cold_open_end: null, focus_x: .5, framing: "fill" as const, caption_style: "standard" as const };
const clip: ProductionClip = { ...baseClip, campaign_id: "camp", profile_id: "profile", strategy_version_id: "strategy", edit_plan: plan };
function workspace(): Workspace {
  return { campaign: { id: "camp", name: "All-In", video_ids: ["v1"], profile_ids: ["profile"], brief: { audience: "Founders", constraints: [], requested_outputs: [], measurement_intent: "Production" } }, profileId: "profile", profiles: [{ id: "profile", name: "Brand", audience: "Founders", brand_context: "", creative_preferences: "", active_strategy_id: "strategy" }], versions: [{ id: "strategy", campaign_id: "camp", version: 1, status: "approved", base_version_id: null, reason: "", hypothesis: "", created_at: "now", approved_at: "now", changed_profile_ids: [], directions: { profile: direction } }], loading: false, busy: false, error: "", run: vi.fn(async task => { try { await task(); return true; } catch { return false; } }) } as unknown as Workspace;
}
function factory(clips: ProductionClip[] = []): FactoryState {
  const f = testState();
  f.data = { ...f.data, system: { ffmpeg: true, ffprobe: true, model_runtime: true }, videos: [{ id: "v1", name: "Episode", duration: 120, has_audio: true, transcript: { segments: [{ start: 0, end: 60, text: "Source" }] } }], clips, models: [{ id: "ollama:vision:latest", name: "Local vision", kind: "llm", installed: true, vision: true, source: "ollama" }, { id: "ollama:text", name: "Text only", kind: "llm", installed: true, vision: false }] };
  return f;
}
const queued = (id = "job-1"): Job => ({ id, kind: "render", status: "queued", context: { video_id: "v1", campaign_id: "camp", profile_id: "profile" } });
function loaded() { fireEvent.loadedData(screen.getByLabelText("Review Test clip")); }
function settings() { fireEvent.click(screen.getByText("Fine-tune")); }
beforeEach(() => {
  mode.preview = false;
  vi.clearAllMocks();
  vi.mocked(workspaceApi.teamRuns).mockResolvedValue([]);
  vi.mocked(productionApi.listExports).mockResolvedValue([]);
  vi.mocked(productionApi.campaignRender).mockResolvedValue(queued() as never);
});

describe("Studio production integration", () => {
  it("defaults to one agent action with every pipeline control behind a closed Fine-tune", () => {
    render(<Studio w={workspace()} factory={factory()} next={() => {}} />);
    expect(screen.getByRole("button", { name: "Let agents find clips" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make this clip" })).not.toBeInTheDocument();
    const fineTune = screen.getByText("Fine-tune").closest("details")!;
    expect(fineTune.open).toBe(false);
    expect(fineTune).toContainElement(screen.getByLabelText("Production mode"));
    expect(fineTune).toContainElement(screen.getByLabelText("Installed vision model"));
  });
  it("sends actual cold-open, crop and caption controls with approved version", async () => {
    render(<Studio w={workspace()} factory={factory()} next={() => {}} preferredSource="v1" preferredMode="manual" />);
    expect(screen.getByLabelText("End (seconds)")).toHaveValue(24);
    settings();
    fireEvent.change(screen.getByLabelText("Opening treatment"), { target: { value: "cold_open" } });
    fireEvent.change(screen.getByLabelText("Cold open start (seconds)"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Cold open end (seconds)"), { target: { value: "44" } });
    fireEvent.change(screen.getByLabelText("Crop focus"), { target: { value: "0.8" } });
    fireEvent.click(screen.getByLabelText("Include captions"));
    fireEvent.click(screen.getByRole("button", { name: "Make this clip" }));
    await waitFor(() => expect(productionApi.campaignRender).toHaveBeenCalledOnce());
    expect(productionApi.campaignRender).toHaveBeenCalledWith("camp", expect.objectContaining({ expected_strategy_version_id: "strategy", video_id: "v1", profile_id: "profile", start: 0, end: 24, opening_treatment: "cold_open", cold_open_start: 40, cold_open_end: 44, focus_x: .8, subtitles: false }));
  });
  it("blocks captions without a transcript and offers an explicit captions-off path", async () => {
    const f = factory(); f.data.videos[0].transcript = null;
    render(<Studio w={workspace()} factory={f} next={() => {}} preferredMode="manual" />);
    expect(screen.getByRole("button", { name: "Make this clip" })).toBeDisabled();
    expect(screen.getByText(/Captions need a source transcript/)).toBeInTheDocument();
    settings(); fireEvent.click(screen.getByLabelText("Include captions"));
    expect(screen.getByRole("button", { name: "Make this clip" })).toBeEnabled();
  });
  it("requires an actual revision delta and records parent, reason and changed fields", async () => {
    render(<Studio w={workspace()} factory={factory([clip])} next={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Request a change" }));
    fireEvent.change(screen.getByLabelText("What would make it better?"), { target: { value: "Remove dead air" } });
    expect(screen.getByRole("button", { name: "Render a new revision" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Start (seconds)"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Render a new revision" }));
    await waitFor(() => expect(productionApi.campaignRender).toHaveBeenCalledWith("camp", expect.objectContaining({ parent_clip_id: "c1", change_reason: "Remove dead air", changed_variable: "start", start: 2, end: 10 })));
  });
  it("never selects an unrelated new output; selects only the submitted terminal job result", async () => {
    const w = workspace(), f = factory();
    const view = render(<Studio w={w} factory={f} next={() => {}} preferredMode="manual" />);
    fireEvent.click(screen.getByRole("button", { name: "Make this clip" }));
    await waitFor(() => expect(productionApi.campaignRender).toHaveBeenCalledOnce());
    const unrelated = { ...clip, id: "other", name: "Unrelated" };
    const pending = { ...f, data: { ...f.data, jobs: [queued()], clips: [unrelated] } };
    view.rerender(<Studio w={w} factory={pending} next={() => {}} preferredMode="manual" />);
    expect(screen.queryByLabelText(/^Review /)).not.toBeInTheDocument();
    const done = { ...pending, data: { ...pending.data, clips: [unrelated, clip], jobs: [{ ...queued(), status: "completed", result: { clip_id: "c1" } }] } };
    view.rerender(<Studio w={w} factory={done} next={() => {}} preferredMode="manual" />);
    await waitFor(() => expect(screen.getByLabelText("Review Test clip")).toBeInTheDocument());
    expect(screen.queryByLabelText("Review Unrelated")).not.toBeInTheDocument();
  });
  it("keeps clips and jobs from detached sources and other profiles out of this studio", () => {
    const f = factory([{ ...clip, id: "detached", video_id: "v2", name: "Detached" }, { ...clip, id: "other-profile", profile_id: "else", name: "Other profile" }]);
    f.data.jobs = [{ ...queued(), id: "wrong-job", context: { video_id: "v2", campaign_id: "camp", profile_id: "profile" } }];
    render(<Studio w={workspace()} factory={f} next={() => {}} />);
    expect(screen.queryByText("Detached")).not.toBeInTheDocument();
    expect(screen.queryByText("Other profile")).not.toBeInTheDocument();
    expect(screen.queryByText("wrong-job")).not.toBeInTheDocument();
  });
  it("uses dynamic installed vision models and a bounded real agent envelope", async () => {
    const run = { id: "run-1", tasks: [], job_id: "agent-1" } as unknown as TeamRun;
    vi.mocked(productionApi.campaignProduce).mockResolvedValue({ job: { ...queued("agent-1"), kind: "team" } as never, run });
    render(<Studio w={workspace()} factory={factory()} next={() => {}} preferredMode="agent" />);
    expect(screen.queryByRole("option", { name: "Text only" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Installed vision model")).toHaveValue("ollama:vision:latest"));
    fireEvent.change(screen.getByLabelText("Correction budget"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Let agents find clips" }));
    await waitFor(() => expect(productionApi.campaignProduce).toHaveBeenCalledWith("camp", { expected_strategy_version_id: "strategy", video_id: "v1", profile_id: "profile", model_id: "ollama:vision:latest", revision_budget: 2 }));
    expect(productionApi.campaignRender).not.toHaveBeenCalled();
  });
  it("sends the optional 'what to look for' text with this agent run only", async () => {
    const run = { id: "run-1", tasks: [], job_id: "agent-1" } as unknown as TeamRun;
    vi.mocked(productionApi.campaignProduce).mockResolvedValue({ job: { ...queued("agent-1"), kind: "team" } as never, run });
    render(<Studio w={workspace()} factory={factory()} next={() => {}} preferredMode="agent" />);
    await waitFor(() => expect(screen.getByLabelText("Installed vision model")).toHaveValue("ollama:vision:latest"));
    const box = screen.getByLabelText("What should the agents look for? (optional)");
    expect(box).toHaveAttribute("maxlength", "500");
    fireEvent.change(box, { target: { value: "  the spiciest takes on AI policy, under 40s  " } });
    fireEvent.click(screen.getByRole("button", { name: "Let agents find clips" }));
    await waitFor(() => expect(productionApi.campaignProduce).toHaveBeenCalledWith("camp", expect.objectContaining({ direction: "the spiciest takes on AI policy, under 40s" })));
  });
  it("does not run agents in the illustrative hosted preview", () => {
    mode.preview = true;
    render(<Studio w={workspace()} factory={factory()} next={() => {}} preferredMode="agent" />);
    expect(screen.getByRole("button", { name: "Let agents find clips" })).toBeDisabled();
    expect(productionApi.campaignProduce).not.toHaveBeenCalled();
  });
  it("requires playable exact output and an explicit acceptance before export", async () => {
    render(<Studio w={workspace()} factory={factory([clip])} next={() => {}} />);
    expect(screen.getByRole("button", { name: "Approve this clip" })).toBeDisabled();
    loaded();
    fireEvent.click(screen.getByRole("button", { name: "Approve this clip" }));
    await waitFor(() => expect(productionApi.review).toHaveBeenCalledExactlyOnceWith(clip, true));
    expect(productionApi.createVerifiedExport).not.toHaveBeenCalled();
  });
  it("submits export once and reconciles history after a response-unknown failure", async () => {
    vi.mocked(productionApi.createVerifiedExport).mockRejectedValue(new Error("Response unknown; reconcile"));
    render(<Studio w={workspace()} factory={factory([{ ...clip, approved: true }])} next={() => {}} />);
    loaded(); const button = screen.getByRole("button", { name: "Export approved MP4" });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(productionApi.createVerifiedExport).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText(/An export was submitted/)).toBeInTheDocument());
    expect(button).toBeDisabled();
    expect(productionApi.listExports).toHaveBeenCalled();
    fireEvent.click(button);
    expect(productionApi.createVerifiedExport).toHaveBeenCalledOnce();
  });
  it("requires confirmation for cancellation and never retries a failed revision by guessing its reason", async () => {
    const f = factory();
    f.data.jobs = [queued(), { ...queued("failed-revision"), status: "failed", context: { video_id: "v1", campaign_id: "camp", profile_id: "profile", parent_clip_id: "c1", plan } }];
    render(<Studio w={workspace()} factory={f} next={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel job" }));
    expect(productionApi.cancelJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    await waitFor(() => expect(productionApi.cancelJob).toHaveBeenCalledExactlyOnceWith("job-1"));
    expect(screen.getByRole("button", { name: "Retry saved render" })).toBeDisabled();
    expect(screen.getByText(/Reopen the parent version/)).toBeInTheDocument();
  });
  it("opens the exact Library clip when its source is also supplied", () => {
    render(<Studio w={workspace()} factory={factory([clip])} next={() => {}} preferredSource="v1" preferredClip="c1" />);
    expect(screen.getByLabelText("Review Test clip")).toBeInTheDocument();
    expect(screen.queryByLabelText("Source footage")).not.toBeInTheDocument();
  });
  it("retries the saved edit once with explicit retry lineage, never by automatic repetition", async () => {
    const f = factory();
    f.data.jobs = [{ ...queued("failed-cut"), status: "failed", context: { video_id: "v1", campaign_id: "camp", profile_id: "profile", attempt: 1, plan: { ...plan, start: 12, end: 22, subtitles: false, focus_x: .7 } } }];
    render(<Studio w={workspace()} factory={f} next={() => {}} />);
    expect(productionApi.campaignRender).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved render" }));
    await waitFor(() => expect(productionApi.campaignRender).toHaveBeenCalledExactlyOnceWith("camp", expect.objectContaining({ retry_of_job_id: "failed-cut", start: 12, end: 22, subtitles: false, focus_x: .7, expected_strategy_version_id: "strategy" })));
  });
  it("retains critique as a separate gate from playback and human acceptance", () => {
    render(<Studio w={workspace()} factory={factory([{ ...clip, team_run_id: "run", team_review_status: "fail" }])} next={() => {}} />);
    loaded();
    expect(screen.getByRole("button", { name: "Approve this clip" })).toBeDisabled();
    expect(screen.getByText(/Resolve the team critique/)).toBeInTheDocument();
    expect(productionApi.review).not.toHaveBeenCalled();
  });

});

describe("failed agent runs", () => {
  it("points to Let agents find clips instead of a render retry it cannot do", () => {
    const f = factory();
    f.data.jobs = [{ ...queued("failed-team"), kind: "team", status: "failed", error: "This FFmpeg build lacks libass", context: { video_id: "v1", campaign_id: "camp", profile_id: "profile", team_run_id: "run" } }];
    render(<Studio w={workspace()} factory={f} next={() => {}} />);
    expect(screen.queryByRole("button", { name: "Retry saved render" })).not.toBeInTheDocument();
    expect(screen.queryByText(/belongs to another source/)).not.toBeInTheDocument();
    expect(screen.getByText(/use Let agents find clips/)).toBeInTheDocument();
  });
});
