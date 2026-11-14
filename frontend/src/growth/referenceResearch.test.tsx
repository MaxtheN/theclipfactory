import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ReferenceResearch } from "./ReferenceResearch";
import { referencesApi, type Research } from "./referencesApi";

const research = (overrides: Partial<Research> = {}): Research => ({
  id: "rr_1",
  campaign_id: "c",
  profile_id: "p",
  status: "draft",
  references: [],
  target_clip_id: null,
  observations: [],
  pattern: null,
  plans: [],
  limits: [],
  abstained: null,
  holds: [],
  job: null,
  candidate_clips: [{ id: "clip1", hook: "Most founders hire too early", start: 2, end: 8, name: "" }],
  direction: null,
  ...overrides,
});

const upload = {
  id: "ref_a", kind: "upload" as const, media_kind: "reference" as const, name: "great.mp4", note: "", url: null,
  file: "ref_a.mp4", duration: 6, status: "analyzed" as const, status_reason: "Inspected: measured and described.",
  frames: [{ time: 0.5, file: "ref_a-f01.jpg", described: true, visual: "A man", on_screen_text: [] }],
};
const link = {
  id: "ref_b", kind: "url" as const, media_kind: "reference" as const, name: "https://www.instagram.com/reel/x/",
  note: "Great pace", url: "https://www.instagram.com/reel/x/", file: null, status: "not_inspected" as const,
  status_reason: "Social platform pages are never scraped. Not inspected — upload the video to analyze it.",
};
const ready = (overrides: Partial<Research> = {}) => research({
  status: "ready",
  target_clip_id: "clip1",
  references: [upload, link],
  observations: [
    { id: "O1", reference_id: "ref_a", statement: "The opening line returns later.", basis: "transcript similarity",
      evidence: { kind: "quote", start: 0.3, end: 5.9, quote: "Stop scrolling" } },
    { id: "O2", reference_id: "ref_a", statement: "2 picture cuts in 6.0s.", basis: "FFmpeg scene change",
      evidence: { kind: "measurement", start: 2, end: 4 } },
  ],
  pattern: { pattern: "Opens on the payoff line, then returns to it.", supported_by: ["O1"], reference_ids: ["ref_a"],
    hypothesis: "Our viewers may stay past 3 s if the payoff is teased first.", variable: "structure",
    value_a: "linear", value_b: "hook_first" },
  plans: [
    { label: "A", role: "control", variable: "structure", variable_label: "Structure", value: "linear",
      summary: "Linear: setup, then payoff", hook: "Most founders hire too early",
      source: { clip_id: "clip1", start: 2, end: 8, opening: "Most founders hire" } },
    { label: "B", role: "pattern", variable: "structure", variable_label: "Structure", value: "hook_first",
      summary: "Hook-first: payoff teaser, then setup", hook: "Most founders hire too early",
      source: { clip_id: "clip1", start: 2, end: 8, opening: "Most founders hire" } },
  ],
  limits: ["Sample of 1 reference; the pattern cites 1 of them.", "No performance data: these examples were chosen for taste, not measured results."],
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe("ReferenceResearch", () => {
  it("starts a research record and shows an honest empty state", async () => {
    vi.spyOn(referencesApi, "list").mockResolvedValue([]);
    const start = vi.spyOn(referencesApi, "start").mockResolvedValue(research());
    render(<ReferenceResearch campaignId="c" profileId="p" />);
    expect(await screen.findByText(/No references yet/)).toBeTruthy();
    expect(start).toHaveBeenCalledWith("c", "p");
    expect((screen.getByRole("button", { name: "Analyze examples" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Use this direction/ })).toBeNull();
  });

  it("labels links as not inspected and needs an upload to analyze", async () => {
    vi.spyOn(referencesApi, "list").mockResolvedValue([research({ references: [link] })]);
    render(<ReferenceResearch campaignId="c" profileId="p" />);
    expect(await screen.findByText("Not inspected")).toBeTruthy();
    expect(screen.getByText(/links alone are not inspected/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Analyze examples" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds a link and only clears the field on success", async () => {
    vi.spyOn(referencesApi, "list").mockResolvedValue([research()]);
    const add = vi.spyOn(referencesApi, "link").mockRejectedValueOnce(new Error("Use at most 3 references."));
    render(<ReferenceResearch campaignId="c" profileId="p" />);
    const field = await screen.findByLabelText("Reference link");
    fireEvent.change(field, { target: { value: "https://www.tiktok.com/@a/video/1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Use at most 3 references.");
    expect((field as HTMLInputElement).value).toBe("https://www.tiktok.com/@a/video/1");
    expect(add).toHaveBeenCalledWith("rr_1", "https://www.tiktok.com/@a/video/1");
  });

  it("shows real progress while analyzing and locks the inputs", async () => {
    vi.spyOn(referencesApi, "list").mockResolvedValue([research({
      status: "analyzing", references: [{ ...upload, status: "stored" }],
      job: { id: "j", status: "running", progress: 42, message: "Studying reference 1 of 1", error: null },
    })]);
    vi.spyOn(referencesApi, "get").mockResolvedValue(research({ status: "analyzing" }));
    render(<ReferenceResearch campaignId="c" profileId="p" pollMs={100000} />);
    expect(await screen.findByText(/Studying reference 1 of 1 · 42%/)).toBeTruthy();
    expect((screen.getByLabelText("Upload a reference video") as HTMLInputElement).disabled).toBe(true);
  });

  it("keeps evidence and inference apart and highlights the one changed variable", async () => {
    vi.spyOn(referencesApi, "list").mockResolvedValue([ready()]);
    const use = vi.spyOn(referencesApi, "use").mockResolvedValue(ready({
      direction: { clip_id: "clip1", job_id: "job9", proposal_id: "v7", proposal_error: null },
    }));
    render(<ReferenceResearch campaignId="c" profileId="p" entry="studio" />);
    expect(await screen.findByText("evidence")).toBeTruthy();
    expect(screen.getByText("inference")).toBeTruthy();
    expect(screen.getByText("Test a pattern from examples")).toBeTruthy();
    expect(screen.getByText("Opens on the payoff line, then returns to it.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "O1" }).getAttribute("href")).toBe("#obs-rr_1-O1");
    expect(screen.getByText(/No performance data/)).toBeTruthy();
    const plans = screen.getByLabelText("Two plans that differ in one variable");
    const changed = plans.querySelectorAll(".is-changed");
    expect(changed).toHaveLength(2);
    expect(within(plans).getByText("Linear: setup, then payoff")).toBeTruthy();
    expect(within(plans).getByText("Hook-first: payoff teaser, then setup")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play from 0.3s" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Use this direction/ }));
    await waitFor(() => expect(use).toHaveBeenCalledWith("rr_1", "clip1"));
    expect(await screen.findByText(/Two versions are rendering/)).toBeTruthy();
    expect(screen.getByText(/nothing was approved/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Use this direction/ })).toBeNull();
  });

  it("says plainly when the model abstained", async () => {
    vi.spyOn(referencesApi, "list").mockResolvedValue([ready({
      status: "abstained", pattern: null, plans: [],
      abstained: { status: "abstained", reason: "The model's pattern failed validation twice." },
    })]);
    render(<ReferenceResearch campaignId="c" profileId="p" />);
    expect(await screen.findByText(/No pattern named\./)).toBeTruthy();
    expect(screen.getByText(/failed validation twice/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Use this direction/ })).toBeNull();
    expect(screen.getByText("The opening line returns later.")).toBeTruthy();
  });

  it("shows a retryable error when the service is unreachable", async () => {
    vi.spyOn(referencesApi, "list").mockRejectedValue(new Error("Cannot reach the local service."));
    render(<ReferenceResearch campaignId="c" profileId="p" />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Cannot reach the local service.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
