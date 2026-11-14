import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PostToInstagram } from "./PostToInstagram";
import { publishApi, type PostTargets, type PublishAttempt, type QualityReport } from "./publishApi";

vi.mock("./publishApi", async (original) => {
  const actual = await original<typeof import("./publishApi")>();
  return {
    ...actual,
    publishApi: { quality: vi.fn(), targets: vi.fn(), post: vi.fn(), attempt: vi.fn(), reconcile: vi.fn(), resume: vi.fn() },
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

beforeEach(() => {
  vi.resetAllMocks();
  api.quality.mockResolvedValue(pass);
  api.targets.mockResolvedValue(targets());
});

describe("PostToInstagram", () => {
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
    expect(api.post).toHaveBeenNthCalledWith(1, "c1", { account_id: "acct-1", caption: "Default caption", sha256: SHA });
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
});
