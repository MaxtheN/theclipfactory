import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Campaign, Clip, FactoryLine, Job } from "../types";
import type { FactoryState } from "../useFactory";

const apiMock = vi.hoisted(() => ({ api: vi.fn(), post: vi.fn() }));
vi.mock("../api", async (importActual) => ({
  ...(await importActual<typeof import("../api")>()),
  api: apiMock.api,
  post: apiMock.post,
}));

import { ActivityCenter, activityItems, type PostScheduleSummary, type PublishAttemptSummary } from "./ActivityCenter";

const nativeShowModal = HTMLDialogElement.prototype.showModal;
const nativeClose = HTMLDialogElement.prototype.close;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterAll(() => {
  HTMLDialogElement.prototype.showModal = nativeShowModal;
  HTMLDialogElement.prototype.close = nativeClose;
});

const NOW = Date.parse("2026-11-19T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60000).toISOString();
const job = (over: Partial<Job> & { id: string; kind: string; status: Job["status"] }): Job => ({
  progress: 0, message: "", error: null, context: {}, created_at: ago(5), updated_at: ago(1), ...over,
} as Job);
const campaigns = [{ id: "c1", name: "Fall launch", video_ids: ["v1"], profile_ids: ["p1"] }] as unknown as Campaign[];
const clips = [{ id: "k1", video_id: "v1", campaign_id: "c1", title: "Hook" }] as unknown as Clip[];
const line = {
  sources: [{ job_id: "j-fail", stages: [{ key: "render", label: "Rendering", status: "failed", detail: "" }] }],
} as unknown as FactoryLine;

function factory(jobs: Job[], errors: Record<string, string> = {}) {
  return {
    data: { system: null, settings: null, models: [], jobs, videos: [], clips, instagram: null, analytics: null, factory: line },
    errors,
    loading: false,
    busy: false,
    refresh: vi.fn(async () => {}),
    run: vi.fn(),
  } as unknown as FactoryState;
}

beforeEach(() => {
  apiMock.api.mockReset().mockResolvedValue([]);
  apiMock.post.mockReset().mockResolvedValue({});
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("activityItems", () => {
  const opts = { campaigns, clips, line, now: NOW };

  it("shows type, campaign, stage and reported progress only while running", () => {
    const [running, queued] = activityItems([
      job({ id: "j1", kind: "swarm", status: "running", progress: 42, message: "Picking moments", context: { video_id: "v1" } }),
      job({ id: "j2", kind: "render", status: "queued", progress: 0, context: { video_id: "v2" } }),
    ], [], opts);
    expect(running).toMatchObject({ type: "Production run", campaign: "Fall launch", stage: "Picking moments", status: "active", progress: 42 });
    expect(running.target).toEqual({ to: "source", videoId: "v1" });
    expect(running.cancel).toEqual({ jobId: "j1", production: true });
    expect(queued).toMatchObject({ type: "Render", stage: "Queued", progress: undefined });
    expect(queued.campaign).toBeUndefined();
  });

  it("names the failed stage from the factory line, or says it was not reported", () => {
    const [a, b] = activityItems([
      job({ id: "j-fail", kind: "pipeline", status: "failed", message: "Failed", error: "FFmpeg exited", updated_at: ago(2) }),
      job({ id: "j-other", kind: "download", status: "failed", message: "Failed", error: "Disk full", updated_at: ago(3) }),
    ], [], opts);
    expect(a).toMatchObject({ status: "failed", failedStage: "Rendering", reason: "FFmpeg exited" });
    expect(b).toMatchObject({ failedStage: undefined, reason: "Disk full", target: { to: "settings", section: "models" } });
    expect(a.cancel).toBeUndefined();
  });

  it("never offers cancel for publishing work and keeps only the last day of finished jobs", () => {
    const items = activityItems([
      job({ id: "p", kind: "publish", status: "running", context: { clip_id: "k1" } }),
      job({ id: "old", kind: "render", status: "completed", updated_at: ago(60 * 25) }),
      job({ id: "new", kind: "render", status: "completed", updated_at: ago(60) }),
    ], [], opts);
    expect(items.map((i) => i.id)).toEqual(["job:p", "job:new"]);
    expect(items[0].cancel).toBeUndefined();
    expect(items[0].target).toEqual({ to: "results" });
  });

  it("treats unknown and failed posting attempts as failures with the stage they reached", () => {
    const attempts: PublishAttemptSummary[] = [{
      id: "a1", clip_id: "k1", account_name: "@show", state: "unknown", updated_at: ago(4),
      history: [{ state: "created" }, { state: "uploading" }, { state: "unknown" }],
    }];
    const [post] = activityItems([], attempts, opts);
    expect(post).toMatchObject({
      type: "Instagram post to @show", campaign: "Fall launch", status: "failed", failedStage: "Uploading",
    });
    expect(post.reason).toMatch(/outcome is unknown/);
    expect(post.stage).toBe("Check posting status");
    expect(post.reconcile).toBe("a1");
    expect(post.target).toEqual({ to: "clip", clip: clips[0] });
  });

  it("names each post's platform, links the live post and checks a post the lane stopped watching", () => {
    const attempts: PublishAttemptSummary[] = [
      { id: "a1", clip_id: "k1", account_name: "channel", platform: "youtube", state: "mapped", active: false,
        permalink: "https://youtube.com/shorts/abc", updated_at: ago(3) },
      { id: "a2", clip_id: "k1", account_name: "tiktoker", platform: "tiktok", state: "submitted", active: false, updated_at: ago(2) },
      { id: "a3", clip_id: "k1", account_name: "brand", platform: "threads", state: "failed", active: false, updated_at: ago(1),
        error: { code: "caption_too_long", message: "Threads captions are limited to 500 characters." }, history: [{ state: "uploading" }] },
    ];
    const items = activityItems([], attempts, opts);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId["post:a1"]).toMatchObject({ type: "YouTube post to channel", status: "done",
      link: { href: "https://youtube.com/shorts/abc", label: "Open on YouTube" } });
    expect(byId["post:a1"].reconcile).toBeUndefined();
    expect(byId["post:a2"]).toMatchObject({ type: "TikTok post to tiktoker", stage: "Platform is processing", reconcile: "a2" });
    // The publisher records {code, message}; the reason is the message text, never the object.
    expect(byId["post:a3"]).toMatchObject({ type: "Threads post to brand", status: "failed",
      reason: "Threads captions are limited to 500 characters." });
  });

  it("keeps every current job but only the latest 20 finished ones", () => {
    const done = Array.from({ length: 25 }, (_, n) =>
      job({ id: `d${n}`, kind: "render", status: "completed", updated_at: ago(n + 1) }));
    const items = activityItems([...done, job({ id: "live", kind: "render", status: "running" })], [], opts);
    expect(items).toHaveLength(21);
    expect(items[0].id).toBe("job:live");
    expect(items[1].id).toBe("job:d0");
    expect(items.at(-1)!.id).toBe("job:d19");
  });

  it("shows Cancel requested instead of a second Cancel while the engine stops a job", () => {
    const [item] = activityItems([
      job({ id: "j1", kind: "swarm", status: "running", message: "Cancellation requested; external writes cannot be undone" }),
    ], [], opts);
    expect(item).toMatchObject({ status: "active", stage: "Cancel requested", cancel: undefined });
  });

  it("marks a production run that finished as ready to review", () => {
    const [item] = activityItems([job({ id: "j1", kind: "swarm", status: "completed", message: "Completed" })], [], opts);
    expect(item.stage).toBe("Ready to review");
  });

  it("flags a scheduled post whose time passed while the app was closed", () => {
    const attempts: PublishAttemptSummary[] = [
      { id: "a1", clip_id: "k1", state: "scheduled", schedule_id: "s1", updated_at: ago(30) },
      { id: "a2", clip_id: "k1", state: "scheduled", schedule_id: "s2", updated_at: ago(30) },
    ];
    const schedules: PostScheduleSummary[] = [
      { id: "s1", status: "scheduled", overdue_at: ago(5), attempt_ids: ["a1"] },
      { id: "s2", status: "scheduled", overdue_at: null, attempt_ids: ["a2"] },
    ];
    const [missed, waiting] = activityItems([], attempts, { ...opts, schedules });
    expect(missed).toMatchObject({ id: "post:a1", status: "stopped", target: { to: "clip", clip: clips[0] } });
    expect(missed.stage).toMatch(/^Stopped when the app closed/);
    expect(waiting).toMatchObject({ id: "post:a2", status: "waiting", stage: "Scheduled" });
  });
});

describe("ActivityCenter", () => {
  it("counts active jobs on the trigger and flags an unseen failure until opened", async () => {
    const f = factory([
      job({ id: "j1", kind: "swarm", status: "running", context: { video_id: "v1" }, updated_at: new Date().toISOString() }),
      job({ id: "j-fail", kind: "pipeline", status: "failed", error: "FFmpeg exited", updated_at: new Date().toISOString() }),
    ]);
    render(<ActivityCenter factory={f} campaigns={campaigns} onOpen={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Activity: 1 active, a failure needs attention" });
    fireEvent.click(trigger);
    const panel = screen.getByRole("dialog", { name: "Activity" });
    expect(within(panel).getByRole("region", { name: "Active jobs" })).toHaveTextContent("Production run");
    expect(within(panel).getByRole("region", { name: "Recent jobs" })).toHaveTextContent("Failed while rendering: FFmpeg exited");
    await waitFor(() => expect(screen.getByRole("button", { name: "Activity: 1 active" })).toBeInTheDocument());
  });

  it("shows a clear empty state and an unavailable state instead of an empty list", async () => {
    render(<ActivityCenter factory={factory([])} campaigns={campaigns} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Activity: nothing running" }));
    await waitFor(() => expect(screen.getByText("Nothing is running. Recent jobs from the last day appear here.")).toBeVisible());
    cleanup();
    render(<ActivityCenter factory={factory([], { jobs: "Local service unreachable" })} campaigns={campaigns} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Job status unavailable: Local service unreachable");
    expect(screen.queryByText(/Nothing is running/)).toBeNull();
  });

  it("confirms that finished clips are kept before cancelling a production run", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const f = factory([job({ id: "j1", kind: "team", status: "running", context: { video_id: "v1" } })]);
    render(<ActivityCenter factory={f} campaigns={campaigns} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledWith("Stop this team production run? Finished clips are kept.");
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/api/jobs/j1/cancel"));
    expect(f.refresh).toHaveBeenCalledWith(["jobs", "factory"]);
  });

  it("opens the screen that holds a job's outputs", () => {
    const onOpen = vi.fn();
    render(<ActivityCenter factory={factory([job({ id: "j1", kind: "render", status: "running", context: { clip_id: "k1", video_id: "v1" } })])} campaigns={campaigns} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith({ to: "clip", clip: clips[0] });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("announces status changes in a polite live region", () => {
    const running = job({ id: "j1", kind: "render", status: "running", updated_at: new Date().toISOString() });
    const { rerender } = render(<ActivityCenter factory={factory([running])} campaigns={campaigns} onOpen={vi.fn()} />);
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("");
    act(() => {
      rerender(<ActivityCenter factory={factory([{ ...running, status: "completed", message: "Completed" }])} campaigns={campaigns} onOpen={vi.fn()} />);
    });
    expect(live).toHaveTextContent("Render finished.");
  });

  it("checks an uncertain post's status instead of retrying it", async () => {
    apiMock.api.mockImplementation(async (path: string) => path === "/api/publish-attempts"
      ? [{ id: "a1", clip_id: "k1", state: "unknown", updated_at: new Date().toISOString() }]
      : []);
    render(<ActivityCenter factory={factory([])} campaigns={campaigns} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    const check = await screen.findByRole("button", { name: "Check status" });
    expect(screen.queryByRole("button", { name: /Retry|Post again/ })).toBeNull();
    fireEvent.click(check);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/api/publish-attempts/a1/reconcile"));
  });

  it("loads posting attempts and says when posting status is unavailable", async () => {
    apiMock.api.mockRejectedValue(new Error("offline"));
    render(<ActivityCenter factory={factory([])} campaigns={campaigns} onOpen={vi.fn()} />);
    expect(apiMock.api).toHaveBeenCalledWith("/api/publish-attempts");
    expect(apiMock.api).toHaveBeenCalledWith("/api/post-schedules");
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Posting status unavailable"));
  });
});
