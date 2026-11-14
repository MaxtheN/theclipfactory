import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClipReview } from "./ClipReview";
import { Factory } from "../pages/Factory";
import { clip, testState } from "../test-state";
import { hasTranscript, jobContextId } from "../productionPreflight";
import type { Job } from "../types";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
afterEach(() => vi.unstubAllGlobals());
function readyState() {
  const state = testState();
  state.data.system = { model_runtime: true };
  state.data.models = [{ id: "qwen-small", name: "Qwen", installed: true }];
  state.data.videos = [
    { id: "v1", name: "Source", has_audio: false, duration: 60 },
  ];
  return state;
}
const reviewed = {
  ...clip,
  team_run_id: "r1",
  team_review_status: "pass" as const,
};
const critiqueJob: Job = {
  id: "review-1",
  kind: "team_review",
  status: "queued",
  context: { video_id: "v1", clip_id: "c1" },
  progress: 0,
};
function mockFetch() {
  const fetch = vi.fn(async (path: string) =>
    json(
      path === "/api/team/runs"
        ? []
        : path.endsWith("/team-review")
          ? critiqueJob
          : {},
    ),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
describe("human approval security boundaries", () => {
  it("allows explicit baseline not_applicable approval including draft metadata without requesting critique", async () => {
    const fetch = mockFetch();
    render(
      <ClipReview
        state={readyState()}
        clip={{ ...reviewed, team_review_status: "not_applicable" }}
      />,
    );
    await userEvent.type(screen.getByLabelText("Clip caption"), " edited");
    expect(screen.getByRole("button", { name: "Approve clip" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Recheck team critique" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve clip" }));
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(call[1].body as string)).toEqual({
      hook: "Hook",
      caption: "Caption edited",
      approved: true,
    });
  });
  it.each(["Clip hook", "Clip caption"])(
    "requires saving and rechecking when %s changes after a team pass",
    async (label) => {
      const fetch = mockFetch();
      render(<ClipReview state={readyState()} clip={reviewed} />);
      await userEvent.type(screen.getByLabelText(label), " changed");
      expect(
        screen.getByRole("button", { name: "Approve clip" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Recheck team critique" }),
      ).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Save edits, then recheck",
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Approve clip" }),
      );
      expect(fetch).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Save edits" }));
      const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(call[1].body as string)).not.toHaveProperty("approved");
    },
  );
  it("sends team approval separately from content and always permits removing approval without saving dirty drafts", async () => {
    const fetch = mockFetch();
    const state = readyState();
    const view = render(<ClipReview state={state} clip={reviewed} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve clip" }));
    expect(
      JSON.parse(
        (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
          .body as string,
      ),
    ).toEqual({ approved: true });
    view.rerender(
      <ClipReview
        state={state}
        clip={{ ...reviewed, approved: true, team_review_status: "unknown" }}
      />,
    );
    await userEvent.type(screen.getByLabelText("Clip hook"), " unsaved");
    await userEvent.click(
      screen.getByRole("button", { name: "Remove approval" }),
    );
    expect(
      JSON.parse(
        (fetch.mock.calls[1] as unknown as [string, RequestInit])[1]
          .body as string,
      ),
    ).toEqual({ approved: false });
  });
  it("saves edits then queues a single explicit critique, retains feedback, and waits for backend verdict and job progress", async () => {
    const fetch = mockFetch();
    const state = readyState();
    const view = render(<ClipReview state={state} clip={reviewed} />);
    await userEvent.type(
      screen.getByLabelText("Feedback notes"),
      "Keep the context",
    );
    await userEvent.selectOptions(screen.getByLabelText("Clip rating"), "4");
    await userEvent.type(screen.getByLabelText("Clip caption"), " changed");
    await userEvent.click(screen.getByRole("button", { name: "Save edits" }));
    const saved = {
      ...reviewed,
      caption: "Caption changed",
      approved: false,
      team_review_status: "unknown" as const,
    };
    view.rerender(<ClipReview state={state} clip={saved} />);
    const recheck = screen.getByRole("button", {
      name: "Recheck team critique",
    });
    fireEvent.click(recheck);
    fireEvent.click(recheck);
    await screen.findByText(/Critique job: queued/);
    const calls = fetch.mock.calls.filter(([path]) =>
      path.endsWith("/team-review"),
    ) as unknown as Array<[string, RequestInit]>;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("/api/clips/c1/team-review");
    expect(JSON.parse(calls[0][1].body as string)).toEqual({});
    expect(calls[0][1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
    });
    expect(screen.getByRole("button", { name: "Approve clip" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Recheck team critique" }),
    ).toBeDisabled();
    const running = {
      ...state,
      data: {
        ...state.data,
        jobs: [{ ...critiqueJob, status: "running", progress: 45 }],
      },
    };
    view.rerender(<ClipReview state={running} clip={saved} />);
    expect(
      screen.getByRole("progressbar", { name: "Team critique progress" }),
    ).toHaveAttribute("value", "45");
    view.rerender(
      <ClipReview
        state={{
          ...state,
          data: {
            ...state.data,
            jobs: [{ ...critiqueJob, status: "completed" }],
          },
        }}
        clip={{ ...saved, team_review_status: "pass" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Approve clip" })).toBeEnabled();
    expect(screen.getByLabelText("Feedback notes")).toHaveValue(
      "Keep the context",
    );
    expect(screen.getByLabelText("Clip rating")).toHaveValue("4");
  });
  it("shows real recheck API rejection without fabricating a verdict", async () => {
    const state = readyState();
    state.run = vi.fn(async (task) => {
      try {
        await task();
        return true;
      } catch {
        return false;
      }
    });
    const fetch = vi.fn(async () =>
      json(
        { detail: "Ledger still has active work; wait before rechecking." },
        409,
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <ClipReview
        state={state}
        clip={{ ...reviewed, team_review_status: "unknown" }}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Recheck team critique" }),
    );
    expect(
      await screen.findByText(
        "Ledger still has active work; wait before rechecking.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve clip" })).toBeDisabled();
    expect(screen.queryByText(/Critique job:/)).not.toBeInTheDocument();
  });
  it.each(["system", "models", "clips", "jobs", "videos"] as const)(
    "disables recheck when %s data is stale",
    (resource) => {
      const state = readyState();
      state.errors[resource] = "Unavailable";
      render(
        <ClipReview
          state={state}
          clip={{ ...reviewed, team_review_status: "unknown" }}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Recheck team critique" }),
      ).toBeDisabled();
    },
  );
  it("requires a known ready runtime for recheck, and blocks source/clip-bound active work", () => {
    const state = readyState();
    state.data.system = { model_runtime: false };
    const view = render(<ClipReview state={state} clip={reviewed} />);
    expect(
      screen.getByRole("button", { name: "Recheck team critique" }),
    ).toBeDisabled();
    for (const context of [{ video_id: "v1" }, { clip_id: "c1" }]) {
      const busy = readyState();
      busy.data.jobs = [
        { id: "busy", kind: "team_review", status: "running", context },
      ];
      view.rerender(<ClipReview state={busy} clip={reviewed} />);
      expect(
        screen.getByRole("button", { name: "Recheck team critique" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Approve clip" }),
      ).toBeDisabled();
    }
  });
});
function expectProduction(enabled: boolean) {
  for (const name of [
    "Produce variants (team)",
    "Start team run",
    "Run comparative baseline",
  ]) {
    const button = screen.getByRole("button", { name });
    if (enabled) expect(button).toBeEnabled();
    else expect(button).toBeDisabled();
  }
}
describe("source-aware production preflight", () => {
  it.each([undefined, null, {}, [], ""])(
    "requires installed Whisper for known audio without transcript %j but keeps analysis available",
    (transcript) => {
      mockFetch();
      const state = readyState();
      state.data.videos[0] = {
        ...state.data.videos[0],
        has_audio: true,
        transcript,
      };
      render(<Factory state={state} />);
      expectProduction(false);
      expect(screen.getByText(/Install whisper-turbo/)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Analyze video" }),
      ).toBeEnabled();
    },
  );
  it.each(["whisper", "transcript", "silent", "unknown"] as const)(
    "allows production when the audio prerequisite is %s",
    (condition) => {
      mockFetch();
      const state = readyState();
      state.data.videos[0].has_audio =
        condition === "unknown" ? undefined : condition !== "silent";
      if (condition === "whisper")
        state.data.models.push({
          id: "whisper-turbo",
          name: "Whisper",
          installed: true,
        });
      if (condition === "transcript")
        state.data.videos[0].transcript = {
          segments: [{ text: "Real transcript" }],
        };
      render(<Factory state={state} />);
      expectProduction(true);
      if (condition === "unknown")
        expect(
          screen.getByText(/Audio prerequisites checked by backend/),
        ).toBeInTheDocument();
    },
  );
  it.each(["queued", "running"])(
    "blocks source-bound %s work using context rather than unrelated result fields",
    (status) => {
      mockFetch();
      const state = readyState();
      state.data.jobs = [
        { id: "active", kind: "team", status, context: { video_id: "v1" } },
      ];
      const view = render(<Factory state={state} />);
      expectProduction(false);
      expect(
        screen.getByRole("button", { name: "Analyze video" }),
      ).toBeDisabled();
      for (const job of [
        { id: "other", kind: "team", status, context: { video_id: "other" } },
        {
          id: "download",
          kind: "download",
          status,
          context: { model_id: "whisper-turbo" },
        },
        { id: "result", kind: "analyze", status, result: { video_id: "v1" } },
        {
          id: "done",
          kind: "team",
          status: "completed",
          context: { video_id: "v1" },
        },
      ]) {
        view.rerender(
          <Factory
            state={{ ...state, data: { ...state.data, jobs: [job] } }}
          />,
        );
        expectProduction(true);
      }
    },
  );
  it.each(["false", "missing", "stale", "model", "queue"])(
    "disables analysis for %s runtime/model/queue readiness",
    (condition) => {
      mockFetch();
      const state = readyState();
      if (condition === "false") state.data.system = { model_runtime: false };
      if (condition === "missing") state.data.system = null;
      if (condition === "stale") state.errors.system = "Unavailable";
      if (condition === "model") state.data.models = [];
      if (condition === "queue") state.errors.jobs = "Unavailable";
      render(<Factory state={state} />);
      expect(
        screen.getByRole("button", { name: "Analyze video" }),
      ).toBeDisabled();
      expectProduction(false);
    },
  );
  it("submits analysis only with a ready runtime and installed selected model", async () => {
    const fetch = mockFetch();
    render(<Factory state={readyState()} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Analyze video" }),
    );
    const call = fetch.mock.calls.find(([path]) =>
      path.endsWith("/analyze"),
    ) as unknown as [string, RequestInit];
    expect(call[0]).toBe("/api/videos/v1/analyze");
    expect(JSON.parse(call[1].body as string)).toEqual({
      model_id: "qwen-small",
    });
  });
  it("reads unknown job context safely and treats empty transcript artifacts as unavailable", () => {
    for (const context of [
      null,
      [],
      "v1",
      { video_id: { bad: "v1" } },
      { video_id: 1 },
    ])
      expect(
        jobContextId(
          { id: "j", kind: "team", status: "queued", context },
          "video_id",
        ),
      ).toBeUndefined();
    expect(hasTranscript({})).toBe(false);
    expect(hasTranscript({ segments: [] })).toBe(true);
  });
});

it("keeps a burned-in campaign hook read-only and explains how to revise it", () => {
  render(
    <ClipReview state={readyState()} clip={{ ...clip, hook_rendered: true }} />,
  );
  expect(screen.getByLabelText("Clip hook")).toBeDisabled();
  expect(screen.getByText(/Burned into this video/)).toBeInTheDocument();
  expect(screen.getByLabelText("Clip caption")).toBeEnabled();
});
