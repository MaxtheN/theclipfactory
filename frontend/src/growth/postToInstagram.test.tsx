import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PostToInstagram } from "./PostToInstagram";
import {
  publishApi, withOffset, type PostPackageView, type PostSchedule, type PostTargets, type PublishAttempt,
  type QualityReport,
} from "./publishApi";
import { PostPreview, truncateForFeed } from "./PostPreview";

vi.mock("./publishApi", async (original) => {
  const actual = await original<typeof import("./publishApi")>();
  return {
    ...actual,
    publishApi: {
      quality: vi.fn(), targets: vi.fn(), post: vi.fn(), attempt: vi.fn(), reconcile: vi.fn(), resume: vi.fn(),
      postPackage: vi.fn(), schedule: vi.fn(), decide: vi.fn(),
    },
  };
});

const api = vi.mocked(publishApi);
const SHA = "a".repeat(64);
const pass: QualityReport = {
  clip_id: "c1", sha256: SHA, verdict: "pass", reasons: [], checks: [],
  rubric: { hook_clarity: null, standalone_context: 5, caption_legibility: 5, technical: 5 },
};
const targets = (over: Partial<PostTargets> = {}): PostTargets => ({
  accounts: [{ id: "acct-1", display_name: "brand" }, { id: "acct-2", display_name: "second" }],
  cloud_configured: true, signed_in: true, attempts: [], default_caption: "Default caption", ...over,
});
const attempt = (over: Partial<PublishAttempt> = {}): PublishAttempt => ({
  id: "at-1", clip_id: "c1", account_id: "acct-1", account_name: "brand", sha256: SHA, caption: "x",
  state: "created", pending_effect: null, active: true, media_id: null, permalink: null, warnings: [],
  error: null, mapping: { status: "pending" }, override_reason: null, updated_at: "now", ...over,
});
const clip = { id: "c1", approved: false, sha256: SHA, hook: "Hook", caption: "Caption" };

const pkg: PostPackageView = {
  limits: { caption_chars: 2200, hashtags: 30, mentions: 20, collaborators: 3, collaborators_supported: false },
  auto_cover: { source: "auto_best_frame", time_ms: 4250, url: "/api/clips/c1/cover" },
  candidates: [500, 4250, 8000, 11000, 15000, 19500].map(t => ({ time_ms: t, url: `/api/clips/c1/cover-frames/${t}`, auto: t === 4250 })),
  duration: 20, collaborators_note: "The connected Instagram tool has no collaborators option; mention people with @ in the caption instead.",
};
const schedule = (over: Partial<PostSchedule> = {}): PostSchedule => ({
  id: "s1", clip_id: "c1", account_ids: ["acct-1"], publish_at: "2026-11-14T19:00:00+00:00", timezone: "UTC",
  status: "scheduled", overdue_at: null, note: "The app must be open at that time.",
  attempts: [attempt({ state: "scheduled", active: false, scheduled_for: "2026-11-14T19:00:00+00:00" })], ...over,
});
const NOW = new Date(2026, 10, 14, 12, 0, 0);
const nativeDialogs = { showModal: HTMLDialogElement.prototype.showModal, close: HTMLDialogElement.prototype.close };
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterAll(() => Object.assign(HTMLDialogElement.prototype, nativeDialogs));

beforeEach(() => {
  vi.resetAllMocks();
  api.quality.mockResolvedValue(pass);
  api.targets.mockResolvedValue(targets());
  api.postPackage.mockResolvedValue(pkg);
});

describe("PostToInstagram", () => {
  it("keeps quality visible and preserves posting drafts when the review sheet closes", async () => {
    const view = render(<PostToInstagram compact clip={{ ...clip, approved: true }} approve={vi.fn()} pollMs={60000} now={() => NOW} />);
    expect(await screen.findByText("Passed: ready to post")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Clip with burned-in captions")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Prepare your post" }));
    const dialog = screen.getByRole("dialog", { name: "Prepare your post" });
    const caption = within(dialog).getByLabelText("Caption");
    fireEvent.change(caption, { target: { value: "A caption I am still editing" } });
    await userEvent.click(within(dialog).getByLabelText("Schedule"));
    const date = within(dialog).getByLabelText("Date and time");
    const savedDate = (date as HTMLInputElement).value;
    await userEvent.click(within(dialog).getByRole("button", { name: "Close Prepare your post" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Prepare your post" }));
    expect(screen.getByLabelText("Caption")).toHaveValue("A caption I am still editing");
    expect(screen.getByLabelText("Date and time")).toHaveValue(savedDate);
    view.rerender(<PostToInstagram compact activeSurface={false} clip={{ ...clip, approved: true }} approve={vi.fn()} pollMs={60000} now={() => NOW} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(<PostToInstagram compact activeSurface clip={{ ...clip, approved: true }} approve={vi.fn()} pollMs={60000} now={() => NOW} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Prepare your post" }));
    expect(screen.getByLabelText("Caption")).toHaveValue("A caption I am still editing");
    expect(screen.getByLabelText("Date and time")).toHaveValue(savedDate);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.schedule).not.toHaveBeenCalled();
  });

  it("keeps unknown posting outcomes visible outside the closed sheet", async () => {
    api.targets.mockResolvedValue(targets({ attempts: [attempt({ state: "unknown", active: false })] }));
    render(<PostToInstagram compact clip={{ ...clip, approved: true }} approve={vi.fn()} pollMs={60000} />);
    expect(await screen.findByText(/A post needs a status check/)).toBeInTheDocument();
    expect(screen.getByLabelText("Posting activity")).toHaveTextContent("Outcome unknown · check status: 1");
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Prepare your post" }));
    expect(screen.getByRole("button", { name: "Check status" })).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.resume).not.toHaveBeenCalled();
  });

  it("keeps a held clip's override editable in the compact posting sheet", async () => {
    api.quality.mockResolvedValue({ ...pass, verdict: "hold", reasons: ["Check the crop"] });
    render(<PostToInstagram compact clip={{ ...clip, approved: true }} approve={vi.fn()} pollMs={60000} />);
    await screen.findByText("Quality gate: hold");
    await userEvent.click(screen.getByRole("button", { name: "Prepare your post" }));
    const dialog = screen.getByRole("dialog", { name: "Prepare your post" });
    await userEvent.click(within(dialog).getByLabelText(/brand/));
    expect(within(dialog).getByRole("button", { name: "Post to Instagram" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Override reason/), { target: { value: "The full sentence and subject are visible." } });
    expect(within(dialog).getByRole("button", { name: "Post to Instagram" })).toBeEnabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("shows sign in required and disables posting", async () => {
    api.targets.mockResolvedValue(targets({ signed_in: false }));
    render(<PostToInstagram clip={clip} approve={vi.fn()} />);
    expect(await screen.findByText("Sign in required.")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/brand/));
    expect(screen.getByRole("button", { name: "Approve & post" })).toBeDisabled();
  });

  it("offers sign in right where it is needed and says why", async () => {
    api.targets.mockResolvedValue(targets({ signed_in: false }));
    render(<PostToInstagram clip={clip} approve={vi.fn()} />);
    expect(await screen.findByText(/so Instagram can fetch it/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("approves the exact revision then posts to each chosen account", async () => {
    const approve = vi.fn().mockResolvedValue({ ...clip, approved: true });
    api.post.mockResolvedValueOnce(attempt()).mockResolvedValueOnce(attempt({ id: "at-2", account_id: "acct-2", account_name: "second" }));
    render(<PostToInstagram clip={clip} approve={approve} pollMs={60000} />);
    expect(await screen.findByDisplayValue("Default caption")).toBeInTheDocument();
    expect(screen.getByText("Quality gate: pass")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/brand/));
    await userEvent.click(screen.getByLabelText(/second/));
    await userEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenNthCalledWith(1, "c1", { account_id: "acct-1", caption: "Default caption", sha256: SHA,
      share_to_feed: true, cover_time_ms: null });
    expect(await screen.findAllByText("Queued")).toHaveLength(2);
  });

  it("does not post when approval is not recorded", async () => {
    render(<PostToInstagram clip={clip} approve={vi.fn().mockResolvedValue(false)} />);
    await userEvent.click(await screen.findByLabelText(/brand/));
    await userEvent.click(screen.getByRole("button", { name: "Approve & post" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("nothing was posted");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("requires an override reason when the gate holds", async () => {
    api.quality.mockResolvedValue({ ...pass, verdict: "hold", reasons: ["Captions burned in: none"] });
    api.post.mockResolvedValue(attempt());
    render(<PostToInstagram clip={{ ...clip, approved: true }} approve={vi.fn()} pollMs={60000} />);
    expect(await screen.findByText("Captions burned in: none")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/brand/));
    const button = screen.getByRole("button", { name: "Post to Instagram" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Override reason/), "Captions are in the description.");
    await userEvent.click(button);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("c1", expect.objectContaining({ override_reason: "Captions are in the description." })));
  });

  it("offers Check status (not retry) for unknown outcomes and links the posted reel", async () => {
    api.targets.mockResolvedValue(targets({ attempts: [
      attempt({ state: "unknown", active: false, pending_effect: "publish", error: { code: "timeout", message: "Timed out." } }),
      attempt({ id: "at-2", account_id: "acct-2", account_name: "second", state: "mapped", active: false, permalink: "https://www.instagram.com/reel/X/" }),
    ] }));
    api.reconcile.mockResolvedValue(attempt({ state: "container_ready", active: false }));
    render(<PostToInstagram clip={{ ...clip, approved: true }} approve={vi.fn()} />);
    expect(await screen.findByText("Outcome unknown · check status")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open reel" })).toHaveAttribute("href", "https://www.instagram.com/reel/X/");
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/brand/)).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Check status" }));
    expect(api.reconcile).toHaveBeenCalledWith("at-1");
    expect(await screen.findByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("counts caption limits live and blocks posting over a limit", async () => {
    render(<PostToInstagram clip={{ ...clip, approved: true }} approve={vi.fn()} />);
    const field = await screen.findByLabelText("Caption");
    await userEvent.click(screen.getByLabelText(/brand/));
    expect(screen.getByText("15 / 2,200 characters")).toBeInTheDocument();
    fireEvent.change(field, { target: { value: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ") } });
    expect(screen.getByText("31 / 30 hashtags")).toHaveClass("over");
    expect(screen.getByRole("alert")).toHaveTextContent("at most 30 hashtags");
    expect(screen.getByRole("button", { name: "Post to Instagram" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "x".repeat(2201) } });
    expect(screen.getByText("2,201 / 2,200 characters")).toHaveClass("over");
    expect(screen.getByRole("button", { name: "Post to Instagram" })).toBeDisabled();
  });

  it("adds link in bio, picks a cover frame and turns off feed sharing", async () => {
    api.post.mockResolvedValue(attempt());
    render(<PostToInstagram clip={{ ...clip, approved: true }} approve={vi.fn()} pollMs={60000} />);
    await screen.findByDisplayValue("Default caption");
    await userEvent.click(screen.getByRole("button", { name: "Add “Link in bio”" }));
    expect(screen.getByLabelText("Caption")).toHaveValue("Default caption\n\nLink in bio.");
    expect(await screen.findByRole("button", { name: "Cover at 4.3s (suggested)" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Cover at 8.0s" }));
    expect(screen.getByRole("button", { name: "Cover at 8.0s" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByAltText("Cover as it appears on your profile grid")).toHaveAttribute("src", "/api/clips/c1/cover-frames/8000");
    await userEvent.click(screen.getByLabelText(/Also show in the main feed/));
    expect(screen.getByText("Shows in Reels only")).toBeInTheDocument();
    expect(screen.getByText(/no collaborators option/)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/brand/));
    await userEvent.click(screen.getByRole("button", { name: "Post to Instagram" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("c1", {
      account_id: "acct-1", caption: "Default caption\n\nLink in bio.", sha256: SHA, share_to_feed: false, cover_time_ms: 8000,
    }));
  });

  it("previews the post on a Reels-style phone with a truncated caption", async () => {
    const long = "First line of the caption that is pretty long\nSecond line keeps going\nThird line is hidden until more";
    api.targets.mockResolvedValue(targets({ default_caption: long }));
    render(<PostToInstagram clip={{ ...clip, approved: true }} approve={vi.fn()} />);
    const preview = await screen.findByLabelText("Post preview");
    await waitFor(() => expect(within(preview).getByTestId("preview-caption")).toHaveTextContent(/pretty long… more$/));
    expect(within(preview).getByText("brand")).toBeInTheDocument();
    expect(within(preview).getByLabelText("Clip with burned-in captions")).toHaveAttribute("src", "/api/clips/c1/media");
    await userEvent.click(within(preview).getByRole("button", { name: "more" }));
    expect(within(preview).getByTestId("preview-caption")).toHaveTextContent("Third line is hidden until more");
    expect(truncateForFeed("short").truncated).toBe(false);
  });

  it("uses a per-account caption override for the second account", async () => {
    api.post.mockResolvedValueOnce(attempt()).mockResolvedValueOnce(attempt({ id: "at-2", account_id: "acct-2" }));
    render(<PostToInstagram clip={{ ...clip, approved: true }} approve={vi.fn()} pollMs={60000} />);
    await screen.findByDisplayValue("Default caption");
    await userEvent.click(screen.getByLabelText(/brand/));
    await userEvent.click(screen.getByLabelText(/second/));
    await userEvent.click(screen.getByRole("button", { name: "Own caption for second" }));
    const own = screen.getByLabelText("Caption for second");
    fireEvent.change(own, { target: { value: "Words just for the second account" } });
    expect(within(screen.getByLabelText("Post preview")).getByTestId("preview-caption")).toHaveTextContent("Words just for the second account");
    await userEvent.click(screen.getByRole("button", { name: "Post to Instagram" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenNthCalledWith(1, "c1", expect.objectContaining({ account_id: "acct-1", caption: "Default caption" }));
    expect(api.post).toHaveBeenNthCalledWith(2, "c1", expect.objectContaining({ account_id: "acct-2", caption: "Words just for the second account" }));
  });

  it("schedules for later with a suggestion chip, local timezone and the app-open warning", async () => {
    api.schedule.mockResolvedValue(schedule());
    render(<PostToInstagram clip={{ ...clip, approved: true }} approve={vi.fn()} now={() => NOW} />);
    await screen.findByDisplayValue("Default caption");
    await userEvent.click(screen.getByLabelText(/brand/));
    await userEvent.click(screen.getByLabelText("Schedule"));
    expect(screen.getByText("The app must be open at that time.")).toBeInTheDocument();
    expect(screen.getByText(/^Times are in /)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Tomorrow 9am" }));
    expect(screen.getByLabelText("Date and time")).toHaveValue("2026-11-15T09:00");
    await userEvent.click(screen.getByRole("button", { name: "Schedule post" }));
    await waitFor(() => expect(api.schedule).toHaveBeenCalledWith("c1", expect.objectContaining({
      account_ids: ["acct-1"], captions: { "acct-1": "Default caption" }, sha256: SHA,
      publish_at: withOffset("2026-11-15T09:00"), share_to_feed: true, cover_time_ms: null,
    })));
    expect(api.post).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent(/^Scheduled for .*The app must be open at that time\.$/);
    expect(within(screen.getByLabelText("Scheduled posts")).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("asks before posting an overdue schedule: Post now, Reschedule or Cancel", async () => {
    api.targets.mockResolvedValue(targets({ schedules: [schedule({ overdue_at: "2026-11-14T20:00:00+00:00" })],
      attempts: [attempt({ state: "scheduled", active: false })] }));
    api.decide.mockResolvedValue(schedule({ status: "submitted", attempts: [attempt({ state: "created" })] }));
    render(<PostToInstagram clip={{ ...clip, approved: true }} approve={vi.fn()} pollMs={60000} now={() => NOW} />);
    expect(await screen.findByText("Missed while the app was closed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reschedule" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(api.decide).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Post now" }));
    expect(api.decide).toHaveBeenCalledWith("s1", "post_now", undefined);
    expect(await screen.findByText("Queued")).toBeInTheDocument();
  });
  it("summarises quality as four score pills and a one-line verdict, reasons behind Details", async () => {
    api.quality.mockResolvedValue({ ...pass, verdict: "hold", reasons: ["No captions burned in"], rubric: { hook_clarity: 4, standalone_context: 3, caption_legibility: 1, technical: null } });
    render(<PostToInstagram clip={{ ...clip, approved: true }} approve={vi.fn()} pollMs={60000} />);
    const gate = await screen.findByLabelText("Quality gate");
    const pills = within(within(gate).getByLabelText("Quality scores")).getAllByRole("listitem");
    expect(pills.map(p => p.textContent)).toEqual(["Hook4/5", "Context3/5", "Captions1/5", "Technical–/5"]);
    expect(pills[2]).toHaveClass("is-low");
    expect(within(gate).getByText("Held: no captions burned in")).toBeInTheDocument();
    expect(within(gate).getByText("No captions burned in").closest("details")).not.toBeNull();
    expect(within(gate).getByLabelText(/Override reason/)).toBeInTheDocument();
  });

  it("shows the override reason only when the gate holds", async () => {
    render(<PostToInstagram clip={{ ...clip, approved: true }} approve={vi.fn()} pollMs={60000} />);
    expect(await screen.findByText("Passed: ready to post")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Override reason/)).not.toBeInTheDocument();
  });

  it("uses a switch for feed sharing and a segmented control for timing", async () => {
    render(<PostToInstagram clip={{ ...clip, approved: true }} approve={vi.fn()} pollMs={60000} now={() => NOW} />);
    await screen.findByDisplayValue("Default caption");
    expect(screen.getByRole("switch", { name: /Also show in the main feed/ })).toBeChecked();
    const when = screen.getByRole("radiogroup", { name: "When to post" });
    expect(within(when).getByLabelText("Post now")).toBeChecked();
    expect(screen.queryByLabelText("Date and time")).not.toBeInTheDocument();
    await userEvent.click(within(when).getByLabelText("Schedule"));
    expect(screen.getByLabelText("Date and time")).toBeInTheDocument();
  });

  it("renders a Reels-style screen with the selected account handle", async () => {
    render(<PostToInstagram clip={{ ...clip, approved: true }} approve={vi.fn()} pollMs={60000} />);
    const preview = await screen.findByLabelText("Post preview");
    await waitFor(() => expect(within(preview).getByText("brand")).toBeInTheDocument());
    expect(within(preview).getByText("Reels")).toBeInTheDocument();
    expect(within(preview).getByText("Follow")).toBeInTheDocument();
    expect(within(preview).getByText("Original audio")).toBeInTheDocument();
    expect(preview.querySelector(".gf-reels-rail")).toHaveAttribute("aria-hidden", "true");
    expect(preview.querySelectorAll(".gf-reels-rail li")).toHaveLength(5);
    expect(within(preview).queryByText("—")).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/second/));
    expect(within(preview).getByText("second")).toBeInTheDocument();
  });
  it("keeps the phone preview paused under reduced motion", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      render(<PostPreview videoUrl="/v.mp4" handle="@brand" caption="Hi" shareToFeed />);
      expect(screen.getByLabelText("Clip with burned-in captions")).not.toHaveAttribute("autoplay");
      expect(screen.getByText("brand")).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });
});
