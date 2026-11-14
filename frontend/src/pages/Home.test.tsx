import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clip, line, lineSource, settings, testState } from "../test-state";
import type { FactoryLine, FactorySource } from "../types";
import { Home } from "./Home";

afterEach(() => vi.unstubAllGlobals());
function mockFetch(storyboard: unknown = null) {
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    path.endsWith("/storyboard") && storyboard === null
      ? new Response('{"detail":"Not built"}', { status: 404 })
      : new Response(JSON.stringify(path.endsWith("/storyboard") ? storyboard : { id: "j1" })),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function home(factory: FactoryLine | null, change: (state: ReturnType<typeof testState>) => void = () => {}) {
  const state = testState();
  state.data.factory = factory;
  change(state);
  const navigate = vi.fn();
  const view = render(<Home state={state} navigate={navigate} />);
  return { state, navigate, view };
}
const withSource = (source: Partial<FactorySource>) => line({ sources: [lineSource(source)] });
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

describe("factory home", () => {
  it("starts with the drop zone and three plain steps when there is no footage", () => {
    home(line());
    expect(screen.getByRole("heading", { name: "Drop footage. Get clips." })).toBeInTheDocument();
    const steps = within(screen.getByRole("list", { name: "How it works" })).getAllByRole("listitem");
    expect(steps.map((step) => step.querySelector("strong")?.textContent)).toEqual([
      "Add footage",
      "The factory works",
      "You approve",
    ]);
    expect(screen.queryByRole("region", { name: "Production line" })).not.toBeInTheDocument();
    expect(screen.getByText("Ready. Using qwen-small.")).toBeInTheDocument();
  });
  it("names the model the factory will use by its catalogue name", () => {
    home(line(), (state) => {
      state.data.models = [{ id: "qwen-small", name: "Qwen3.5 9B", installed: true }];
    });
    expect(screen.getByText("Ready. Using Qwen3.5 9B.")).toBeInTheDocument();
  });
  it("lists what blocks production and opens the page that fixes it", async () => {
    const { navigate } = home(
      line({
        ready: false,
        model_id: null,
        blockers: [
          { code: "no_model", message: "Install a model that can see video.", tab: "Models" },
          { code: "ffmpeg", message: "Install FFmpeg to cut clips.", tab: null },
          { code: "odd", message: "Unknown page.", tab: "Elsewhere" },
        ],
      }),
    );
    expect(screen.getByText("The factory is not ready yet")).toBeInTheDocument();
    expect(screen.getByText(/Install FFmpeg to cut clips/)).toBeInTheDocument();
    expect(screen.queryByText(/Ready\. Using/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Open Models" }));
    expect(navigate).toHaveBeenCalledWith("Models");
  });
  it("does not claim readiness while the factory status is unknown", () => {
    home(null);
    expect(screen.getByText(/factory status is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/Ready\. Using/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "How it works" })).not.toBeInTheDocument();
  });
  it.each([
    ["review", "auto", false],
    ["auto", "review", true],
  ])("switches autopilot from %s with a partial settings update", async (from, to, checked) => {
    const fetch = mockFetch();
    home(line(), (state) => {
      state.data.settings = { ...settings, autonomy: from };
    });
    const toggle = screen.getByRole("switch", { name: "Autopilot" });
    expect(toggle).toHaveAttribute("aria-checked", String(checked));
    await userEvent.click(toggle);
    expect(fetch.mock.calls[0][0]).toBe("/api/settings");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
    expect(bodyOf(fetch.mock.calls[0])).toEqual({ autonomy: to });
  });
  it("keeps autopilot locked while settings are unknown", () => {
    home(line(), (state) => {
      state.data.settings = null;
    });
    expect(screen.getByRole("switch", { name: "Autopilot" })).toBeDisabled();
    expect(screen.getByText("Autopilot unknown")).toBeInTheDocument();
  });
});

describe("production line", () => {
  it("renders the stages the service reports, marking the active one", () => {
    home(
      withSource({
        state: "working",
        job_id: "j9",
        progress: 42,
        headline: "Watching the footage",
        stages: [
          { key: "import", label: "Added", status: "done", detail: "" },
          { key: "listen", label: "Listening", status: "skipped", detail: "No audio" },
          { key: "watch", label: "Watching", status: "active", detail: "Scene 12 of 48" },
          { key: "select", label: "Picking", status: "pending", detail: "" },
        ],
      }),
    );
    const track = screen.getByRole("list", { name: "Progress for Match day" });
    const items = within(track).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-status"))).toEqual([
      "done",
      "skipped",
      "active",
      "pending",
    ]);
    expect(items[2]).toHaveAttribute("aria-current", "step");
    expect(items[2]).toHaveTextContent("Watching, in progress");
    expect(screen.getByText("Scene 12 of 48")).toBeInTheDocument();
    expect(screen.queryByText("No audio")).not.toBeInTheDocument();
    expect(screen.getByText("Watching the footage")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Match day progress" })).toHaveValue(42);
    expect(screen.getByText("2:05")).toBeInTheDocument();
  });
  it("makes clips for an idle source with an empty request body", async () => {
    const fetch = mockFetch();
    home(withSource({ state: "idle" }));
    await userEvent.click(screen.getByRole("button", { name: "Make clips" }));
    expect(fetch.mock.calls[0][0]).toBe("/api/videos/v1/produce");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(bodyOf(fetch.mock.calls[0])).toEqual({});
  });
  it("explains why an idle source cannot start", () => {
    home(
      withSource({
        state: "idle",
        can_produce: false,
        blocked_reason: "Install a speech model to transcribe this video.",
      }),
    );
    expect(screen.getByRole("button", { name: "Make clips" })).toBeDisabled();
    expect(screen.getByText("Install a speech model to transcribe this video.")).toBeInTheDocument();
  });
  it.each(["queued", "working"] as const)("cancels the job of a %s source", async (state) => {
    const fetch = mockFetch();
    home(withSource({ state, job_id: "job/1" }));
    expect(screen.queryByRole("button", { name: "Make clips" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetch.mock.calls[0][0]).toBe("/api/jobs/job%2F1/cancel");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });
  it("cannot cancel work whose job is unknown", () => {
    home(withSource({ state: "working", job_id: null }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
  it.each([
    ["failed", "The model ran out of memory.", "The model ran out of memory."],
    ["failed", null, "Something went wrong before any clip was made."],
    ["cancelled", null, "Stopped before it finished."],
  ] as const)("shows why a %s source stopped and tries again", async (state, error, shown) => {
    const fetch = mockFetch();
    home(withSource({ state, error }));
    expect(screen.getByRole("alert")).toHaveTextContent(shown);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(fetch.mock.calls[0][0]).toBe("/api/videos/v1/produce");
    expect(bodyOf(fetch.mock.calls[0])).toEqual({});
  });
  it("offers more clips once a source is done", async () => {
    const fetch = mockFetch();
    home(withSource({ state: "done", approved: 2, clip_ids: ["a", "b"] }));
    expect(screen.getByText("2 approved")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Make more clips" }));
    expect(fetch.mock.calls[0][0]).toBe("/api/videos/v1/produce");
  });
  it("narrows the review section to one source from its Review button", async () => {
    const { state } = home(
      line({
        sources: [
          lineSource({ state: "needs_review", unreviewed: 1, clip_ids: ["c1"] }),
          lineSource({ video_id: "v2", name: "Interview", state: "needs_review", unreviewed: 2 }),
        ],
      }),
      (state) => {
        state.data.clips = [
          { ...clip, id: "c1", hook: "First rally" },
          { ...clip, id: "c2", video_id: "v2", hook: "Opening line" },
          { ...clip, id: "c3", video_id: "v2", hook: "Closing line" },
          { ...clip, id: "c4", video_id: "v2", hook: "Already approved", approved: true },
        ];
      },
    );
    expect(state.data.clips).toHaveLength(4);
    expect(screen.getByText("3 clips waiting for you")).toBeInTheDocument();
    expect(screen.getAllByRole("article", { name: /^Clip: / })).toHaveLength(3);
    expect(screen.queryByRole("article", { name: "Clip: Already approved" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review 1 clip" }));
    expect(screen.getAllByRole("article", { name: /^Clip: / })).toHaveLength(1);
    expect(screen.getByRole("article", { name: "Clip: First rally" })).toBeInTheDocument();
    expect(screen.getByText(/Showing clips from Match day/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Clips to review" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getAllByRole("article", { name: /^Clip: / })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Review 2 clips" })).toBeInTheDocument();
  });
  it("caps the review section and links to every clip", async () => {
    const { navigate } = home(withSource({ state: "needs_review", unreviewed: 8 }), (state) => {
      state.data.clips = Array.from({ length: 8 }, (_, index) => ({
        ...clip,
        id: `c${index}`,
        hook: `Hook ${index}`,
        created_at: `2026-11-14T00:00:0${index}Z`,
      }));
    });
    const tiles = screen.getAllByRole("article", { name: /^Clip: / });
    expect(tiles).toHaveLength(6);
    expect(tiles[0]).toHaveAccessibleName("Clip: Hook 7");
    expect(screen.getByText(/Showing 6 of 8/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "See all in Clips" })[0]);
    expect(navigate).toHaveBeenCalledWith("Clips");
  });
  it("loads what the factory saw only when the section is opened", async () => {
    const fetch = mockFetch({
      video_id: "v1",
      model_id: "qwen-small",
      vision: true,
      duration: 60,
      signals: { interval: 1, motion: [0.2, 0.8], loudness: [0.1, 0.4] },
      scenes: [
        {
          index: 0,
          start: 0,
          end: 60,
          usable: true,
          score: 0.8,
          motion: 0.7,
          loudness: 0.4,
          peak_time: 30,
          cuts: 0,
          speech: "",
          visual: "Two players in a long rally.",
          action: "high",
          on_screen_text: [],
          highlight: 8,
          highlight_reason: "Fast exchange",
          frames: [],
        },
      ],
      limitations: "",
    });
    home(
      withSource({
        state: "done",
        storyboard: { scenes: 1, vision: true, model_id: "qwen-small", updated_at: "now" },
      }),
    );
    const summary = screen.getByText("What the factory saw · 1 scene");
    expect(fetch).not.toHaveBeenCalled();
    const details = summary.closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(screen.getByText("Two players in a long rally.")).toBeInTheDocument());
    expect(fetch.mock.calls[0][0]).toBe("/api/videos/v1/storyboard");
  });
  it("hides the storyboard section for footage the factory has not watched", () => {
    home(withSource({ state: "idle", storyboard: null }));
    expect(screen.queryByText(/What the factory saw/)).not.toBeInTheDocument();
  });
  it("only loads thumbnails from the local service", () => {
    const { view } = home(
      line({
        sources: [
          lineSource({ thumbnail: "/api/videos/v1/storyboard/frames/s000-0.jpg" }),
          lineSource({ video_id: "v2", thumbnail: "https://example.com/x.jpg" }),
        ],
      }),
    );
    const images = [...view.container.querySelectorAll("img.line-thumb")];
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "/api/videos/v1/storyboard/frames/s000-0.jpg",
    ]);
  });
  it("keeps the home screen free of studio jargon", () => {
    const { view } = home(
      withSource({ state: "needs_review", unreviewed: 1 }),
      (state) => {
        state.data.clips = [{ ...clip, team_run_id: "r1", team_review_status: "pass" }];
      },
    );
    expect(view.container.textContent).not.toMatch(/ledger|provenance|handoff|preflight/i);
  });
});
