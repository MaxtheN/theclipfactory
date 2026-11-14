import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api, ApiError, post, put } from "../api";
import type { Clip } from "../types";
import { GrowthLoopPanel } from "./GrowthLoopPanel";
vi.mock("../api", async () => ({ ...await vi.importActual<typeof import("../api")>("../api"), api: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("./workspaceApi", () => ({ reviewPreview: false }));
const native = { showModal: HTMLDialogElement.prototype.showModal, close: HTMLDialogElement.prototype.close };
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); }; HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); }; });
afterAll(() => Object.assign(HTMLDialogElement.prototype, native));
beforeEach(() => { vi.resetAllMocks(); sessionStorage.clear(); });
afterEach(() => vi.useRealTimers());
const clips = [1, 2, 3].map(n => ({ id: `c${n}`, profile_id: "p", campaign_id: "camp", video_id: "v", name: `Clip ${n}`, hook: `Clip ${n}`, caption: "Caption", start: n * 30, end: n * 30 + 30, objective: "awareness", approved: false, sha256: "a".repeat(64), edit_plan: { hook: "Hook" }, rank: { score: 70, position: n, below_bar: false } })) as Clip[];
const baseView = (profileId = "p", sample = 2) => ({ profile_id: profileId, policy: { auto_ab: false }, taste: { status: "insufficient_preference_evidence", sample_size: sample, minimum: 4, positive: 1, negative: 1 }, loops: [] });
const card = { integrity: { status: "verified" }, ranking: { score: 72, dimensions: [{ id: "moment", label: "Storyboard interest", weight: 0.1, value: null, ranking_value: 0.5, neutral_or_proxy: true, contribution_points: 5 }], limitations: "Quality does not predict audience growth." }, ai_rubric: { version: "creative-text@1", dimensions: [{ id: "source_faithfulness", label: "Source faithfulness", weight: 0.2 }] }, assessments: [{ id: "a1", current: true, status: "assessed", model: "haiku", usage: { calls: 1, cost_usd: 0.0002 }, assessment: { source_faithfulness: { score: 2, reason: "The hook omits a source negation.", evidence: [{ source: "source_speech", quote: "We should not do that." }] }, editorial_hold: true, suggested_change: "Keep the negation in the opening." } }], judge_policy: { automatic_after_production: true, cost_basis: "Assessment costs are separate." } };
const props = { profileId: "p", campaignId: "camp", strategyVersionId: "s1", clips, visible: true };
function ready() { vi.mocked(api).mockImplementation(async path => path.endsWith("/scorecard") ? card : baseView()); }
async function inspect() { await screen.findByText(/2 reviewed revisions/); fireEvent.click(screen.getByText("Inspect clip quality (3)")); }

describe("growth loop panel", () => {
  it("loads only visible Insights and routes rehearsal to the native Factory map", async () => {
    ready(); const onRehearse = vi.fn();
    const ui = render(<GrowthLoopPanel {...props} visible={false} onRehearse={onRehearse} />);
    expect(api).not.toHaveBeenCalled();
    ui.rerender(<GrowthLoopPanel {...props} onRehearse={onRehearse} />);
    await screen.findByText(/2 reviewed revisions/);
    fireEvent.click(screen.getByRole("button", { name: "Rehearse the loop" }));
    expect(onRehearse).toHaveBeenCalledOnce();
    expect(document.querySelector("iframe")).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
  it("saves opt-in policy and submits only the top three scoped clips", async () => {
    ready(); vi.mocked(put).mockResolvedValue({ auto_ab: true }); vi.mocked(post).mockResolvedValue({ id: "loop" });
    render(<GrowthLoopPanel {...props} />); const auto = await screen.findByRole("checkbox"); fireEvent.click(auto);
    await waitFor(() => expect(auto).toBeChecked()); expect(put).toHaveBeenCalledWith("/api/growth/profiles/p/policy", { auto_ab: true });
    fireEvent.click(screen.getByRole("button", { name: "Make top-three A/B drafts" })); await waitFor(() => expect(post).toHaveBeenCalled());
    expect(vi.mocked(post).mock.calls[0]).toEqual(["/api/growth/profiles/p/ab", { request_id: expect.any(String), clip_ids: ["c1", "c2", "c3"], expected_strategy_version_id: "s1" }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Make top-three A/B drafts" })).toBeEnabled()); expect(sessionStorage.length).toBe(0);
  });
  it("preserves the exact batch and request ID after an uncertain response", async () => {
    ready(); vi.mocked(post).mockRejectedValueOnce(new ApiError("Network response lost", 0)).mockResolvedValueOnce({ id: "loop" });
    const ui = render(<GrowthLoopPanel {...props} />); await screen.findByText(/2 reviewed revisions/);
    fireEvent.click(screen.getByRole("button", { name: "Make top-three A/B drafts" })); const retry = await screen.findByRole("button", { name: "Retry same A/B request" });
    expect(screen.getByRole("alert")).toHaveTextContent("same batch and request ID"); ui.rerender(<GrowthLoopPanel {...props} clips={[...clips].reverse()} />); fireEvent.click(retry);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2)); expect(vi.mocked(post).mock.calls[1]).toEqual(vi.mocked(post).mock.calls[0]);
  });
  it("shows actual lineage and real measurement-window reasons", async () => {
    const onReview = vi.fn(); const output = { ...clips[0], id: "out", hook: "Changed hook" };
    vi.mocked(api).mockResolvedValue({ ...baseView(), loops: [{ id: "old", profile_id: "p", number: 1, status: "completed", kind: "ab", simulated: false, slots: [] }, { id: "loop", parent_loop_id: "old", profile_id: "p", number: 3, kind: "recut", status: "completed", simulated: false, slots: [{ id: "slot", campaign_id: "camp", parent_clip_id: "c1", variable: "hooks", reason: "Apply approved rule s2: hooks.", status: "completed", clip_id: "out", outcomes: { status: "pending_window", label: "pending", comparison: { status: "insufficient_evidence", reasons: ["The declared measurement window has not elapsed."] } } }] }] });
    render(<GrowthLoopPanel {...props} clips={[...clips, output]} onReview={onReview} />); await screen.findByText("Loop #1 → Loop #3");
    expect(screen.getByText("The declared measurement window has not elapsed.")).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "Review draft: Changed hook" })); expect(onReview).toHaveBeenCalledWith(output);
  });
  it("renders unknown/proxy evidence separately from readable AI review", async () => {
    ready(); render(<GrowthLoopPanel {...props} />); await inspect(); fireEvent.click(screen.getByRole("button", { name: "Scorecard for Clip 1" }));
    const dialog = screen.getByRole("dialog", { name: "Clip quality scorecard" }); await within(dialog).findByText("Unknown · ranking proxy 0.50");
    expect(within(dialog).getByText("The hook omits a source negation.")).toBeVisible(); expect(within(dialog).getByText(/Editorial hold suggested/)).toBeVisible();
    fireEvent.click(within(dialog).getByText("Source evidence")); expect(within(dialog).getByText("“We should not do that.”")).toBeVisible();
  });
  it("never applies a late old-brand response to a new scope", async () => {
    let resolveOld!: (value: unknown) => void; vi.mocked(api).mockImplementation(path => path === "/api/growth/profiles/p" ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(baseView("q", 9)));
    const ui = render(<GrowthLoopPanel {...props} />); ui.rerender(<GrowthLoopPanel {...props} profileId="q" campaignId="other" />); await screen.findByText(/9 reviewed revisions/);
    await act(async () => resolveOld(baseView("p", 2))); expect(screen.queryByText(/2 reviewed revisions/)).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Make top-three A/B drafts" })).toBeDisabled();
  });
  it("holds stale-file assessment", async () => {
    vi.mocked(api).mockImplementation(async path => path.endsWith("/scorecard") ? { ...card, integrity: { status: "hold", message: "File bytes changed." }, assessments: [] } : baseView());
    render(<GrowthLoopPanel {...props} />); await inspect(); fireEvent.click(screen.getByRole("button", { name: "Scorecard for Clip 1" })); await screen.findByText("File bytes changed."); expect(screen.getByRole("button", { name: "Assess this exact clip" })).toBeDisabled();
  });
  it("labels abstained rehearsal receipts as no draft and explains the rubric decision", async () => {
    vi.mocked(api).mockResolvedValue({ ...baseView(), loops: [{ id: "rehearsal", profile_id: "p", source_clip_id: "c1", number: 1, kind: "rehearsal", status: "no_draft", simulated: false, simulated_evidence: true, slots: [], proposal: { status: "no_supported_rubric_edit", before: "Original hook", after: null, weak_dimension: "source_faithfulness", reason: "No verified quote supports a safe repair." }, comparison: { status: "favors_variant", metric: "completion_rate", before_value: 0.3, after_value: 0.5, reasons: [] } }] });
    render(<GrowthLoopPanel {...props} />);
    await screen.findByText(/No draft rendered · simulated engagement evidence/);
    expect(screen.queryByText(/Real draft rendered/)).not.toBeInTheDocument();
    expect(screen.getByText("No verified quote supports a safe repair.")).toBeVisible();
    expect(screen.getByText("No supported edit")).toBeVisible();
  });

});
