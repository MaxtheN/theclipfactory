import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, post } from "../api";
import type { Clip } from "../types";
import type { FactoryState } from "../useFactory";
import { LoopRehearsalControls, LoopRehearsalInspector, rehearsalModel, useLoopRehearsal } from "./LoopRehearsal";
import type { Workspace } from "./useCampaignWorkspace";
import { STATIONS } from "./flowEvents";
vi.mock("../api", async importOriginal => ({ ...await importOriginal<typeof import("../api")>(), api: vi.fn(), post: vi.fn() }));
vi.mock("./workspaceApi", () => ({ reviewPreview: false }));
const sha = "a".repeat(64);
const clip = { id: "clip", sha256: sha, profile_id: "p", campaign_id: "c", video_id: "v", hook: "Original opening", name: "Clip", approved: false, rank: { below_bar: false } } as Clip;
const workspace = { profileId: "p", profiles: [{ id: "p", active_strategy_id: "rules" }], campaign: { id: "c", video_ids: ["v"] }, versions: [] } as unknown as Workspace;
const factory = { data: { clips: [clip] }, refresh: vi.fn().mockResolvedValue(undefined) } as unknown as FactoryState;
const report = { integrity: { status: "verified" }, ranking: { clip_id: "clip", sha256: sha, score: 70, dimensions: [{ id: "hook", label: "Hook clarity", weight: 0.05, value: 0.4, ranking_value: 0.4, contribution_points: 2 }] }, assessments: [] };
function proposal(scenario = "mixed") { return { source_clip_id: "clip", source_sha256: sha, scenario, simulated_evidence: true, proposal: { status: "supported_rubric_edit", weak_dimension: "hook_clarity", reason: "The current hook is long; the source supports a shorter opening.", before: clip.hook, after: "A supported quote", source_quote: "A supported quote", evidence_source: "source_speech" }, synthetic_observations: [{ id: "a", simulated: true, metrics: { views: 1000, completions: 350 } }, { id: "b", simulated: true, metrics: { views: scenario === "sparse" ? null : 1000, completions: scenario === "sparse" ? null : scenario === "decline" ? 260 : 500 } }], comparison: { status: scenario === "sparse" ? "insufficient_evidence" : scenario === "decline" ? "favors_parent" : "favors_variant", before_value: 0.35, after_value: scenario === "sparse" ? null : scenario === "decline" ? 0.26 : 0.5, decision: scenario === "mixed" ? "test" : "wait", reasons: scenario === "sparse" ? ["Window pending"] : [] } }; }
function Harness({ w = workspace, f = factory, enabled = true }: { w?: Workspace; f?: FactoryState; enabled?: boolean }) {
  const state = useLoopRehearsal(w, f, enabled);
  const model = rehearsalModel({ stations: STATIONS.map(s => ({ ...s, state: "idle", status: "", counts: [], last: "", sheet: [], lanes: 0 })), edges: [], returnArc: { lit: false, label: "" }, live: false, runId: null }, state);
  return <><LoopRehearsalControls state={state} /><LoopRehearsalInspector state={state} /><output data-testid="active-count">{model.stations.filter(s => s.state === "active").length}</output></>;
}
beforeEach(() => {
  sessionStorage.clear(); vi.clearAllMocks();
  vi.mocked(api).mockResolvedValue(report);
  vi.mocked(post).mockImplementation(async (path, body) => {
    if (path.endsWith("rehearse-preview")) return proposal((body as { scenario: string }).scenario);
    return { id: "loop", number: 1, kind: "rehearsal", profile_id: "p", source_clip_id: "clip", source_sha256: sha, simulated_evidence: true, status: "running", slots: [{ id: "slot", parent_clip_id: "clip", campaign_id: "c", status: "queued", job_id: "job" }] };
  });
});
afterEach(() => { vi.useRealTimers(); });
async function runExperiment() {
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Run demo experiment — creates one draft" }));
  for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  vi.useRealTimers();
}
describe("native map rehearsal", () => {
  it("reads exact rubric and previews only, then runs the explicitly requested real experiment", async () => {
    render(<Harness />);
    await screen.findByText("70");
    expect(screen.getByLabelText("Original clip video").getAttribute("src")).toBe("/api/clips/clip/media");
    expect(vi.mocked(post).mock.calls.every(([path]) => path.endsWith("rehearse-preview"))).toBe(true);
    await runExperiment();
    await waitFor(() => expect(vi.mocked(post).mock.calls.some(([path]) => path.endsWith("/rehearse"))).toBe(true));
    const call = vi.mocked(post).mock.calls.find(([path]) => path.endsWith("/rehearse"))!;
    expect(call[1]).toMatchObject({ clip_id: "clip", expected_sha256: sha, expected_strategy_version_id: "rules", scenario: "mixed" });
    expect(screen.getAllByText("Simulated Instagram data").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Revised clip video")).toBeNull();
  });
  it.each(["decline", "sparse"])("abstains when %s evidence cannot support the proposed edit", async scenario => {
    render(<Harness />); await screen.findByText("70");
    fireEvent.change(screen.getByLabelText("Rehearsal scenario"), { target: { value: scenario } });
    await waitFor(() => expect(vi.mocked(post).mock.calls.some(([, body]) => (body as { scenario: string }).scenario === scenario)).toBe(true));
    await waitFor(() => expect(screen.queryByText(/Reading this clip/)).toBeNull());
    await runExperiment();
    expect(screen.getByText(/Stopped:/)).toBeInTheDocument();
    expect(vi.mocked(post).mock.calls.some(([path]) => path.endsWith("/rehearse"))).toBe(false);
    if (scenario === "sparse") expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
  });
  it("never uses fixture media or permits a real render in the plan-only fallback", async () => {
    vi.mocked(post).mockResolvedValue({ simulated: true, loops: [{ number: 1, pairs: [{ id: "synthetic", before: { id: "a", topic: "Demo", hook: "Plan A", synthetic_transcript: "Source" }, after: { hook: "Plan B" }, quality_before: { score: 40 }, quality_after: { score: 45 }, proposal: { source_quote: "Source", reason: "Plan only" }, evaluation: proposal().comparison, observations: proposal().synthetic_observations }] }] });
    render(<Harness f={{ ...factory, data: { clips: [] } } as unknown as FactoryState} />);
    await screen.findByText("Plan-only example");
    expect(screen.getByRole("button", { name: "Run demo experiment — creates one draft" })).toBeDisabled();
    expect(document.querySelectorAll("video")).toHaveLength(0);
    expect(screen.getByText(/Generate a real clip before rendering/)).toBeInTheDocument();
  });
  it("retains the idempotency identity after uncertain submission", async () => {
    vi.mocked(post).mockImplementation(async (path, body) => { if (path.endsWith("rehearse-preview")) return proposal(); throw new ApiError("Uncertain submission", 0); });
    render(<Harness />); await screen.findByText("70"); await runExperiment();
    await screen.findByRole("button", { name: "Retry same draft request" });
    fireEvent.click(screen.getByRole("button", { name: "Retry same draft request" }));
    await waitFor(() => expect(vi.mocked(post).mock.calls.filter(([path]) => path.endsWith("/rehearse"))).toHaveLength(2));
    const bodies = vi.mocked(post).mock.calls.filter(([path]) => path.endsWith("/rehearse")).map(([, body]) => body);
    expect(bodies[0]).toEqual(bodies[1]);
  });
  it("runs exactly one real draft after the explicit experiment action", async () => {
    render(<Harness />); await screen.findByText("70");
    expect(vi.mocked(post).mock.calls.some(([path]) => path.endsWith("/rehearse"))).toBe(false);
    await runExperiment();
    expect(vi.mocked(post).mock.calls.filter(([path]) => path.endsWith("/rehearse"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Run demo experiment — creates one draft" })).toBeDisabled();
  });
  it("ignores an old brand response and does not request its proposal after the brand switches", async () => {
    let resolveOld!: (value: unknown) => void;
    vi.mocked(api).mockReturnValue(new Promise(resolve => { resolveOld = resolve; }));
    vi.mocked(post).mockResolvedValue({ simulated: true, loops: [{ number: 1, pairs: [] }] });
    const view = render(<Harness />);
    view.rerender(<Harness w={{ ...workspace, profileId: "other", campaign: { ...workspace.campaign!, id: "other-campaign", video_ids: [] } }} />);
    await act(async () => { resolveOld(report); });
    expect(screen.queryByText("70")).toBeNull();
    expect(vi.mocked(post).mock.calls.some(([path]) => path.includes("/profiles/p/rehearse-preview"))).toBe(false);
    expect(screen.queryByLabelText("Original clip video")).toBeNull();
  });
  it("shows actual before/after media and independently fetched exact output assessment", async () => {
    const output = { ...clip, id: "revised", sha256: "b".repeat(64), hook: "A supported quote", approved: false };
    vi.mocked(api).mockImplementation(async path => path.includes("/revised/") ? { ...report, ranking: { ...report.ranking, clip_id: "revised", sha256: output.sha256, score: 72 } } : report);
    vi.mocked(post).mockImplementation(async path => path.endsWith("rehearse-preview") ? proposal() : { id: "loop", number: 1, kind: "rehearsal", profile_id: "p", source_clip_id: "clip", source_sha256: sha, simulated_evidence: true, status: "completed", slots: [{ id: "slot", parent_clip_id: "clip", campaign_id: "c", status: "completed", clip_id: "revised", sha256: output.sha256 }] });
    render(<Harness f={{ ...factory, data: { clips: [clip, output] } } as unknown as FactoryState} />);
    await screen.findByText("70"); await runExperiment();
    await screen.findByText("72");
    expect(screen.getByLabelText("Original clip video").getAttribute("src")).toBe("/api/clips/clip/media");
    expect(screen.getByLabelText("Revised clip video").getAttribute("src")).toBe("/api/clips/revised/media");
    expect(screen.getByText(/Revision · actual unapproved draft/)).toBeInTheDocument();
  });

});
