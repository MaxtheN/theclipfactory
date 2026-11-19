import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Storyboard as Board, StoryboardScene } from "../types";
import { Storyboard, readable, tracePaths } from "./Storyboard";

afterEach(() => vi.unstubAllGlobals());
const scene = (overrides: Partial<StoryboardScene>): StoryboardScene => ({
  index: 0,
  start: 0,
  end: 30,
  usable: true,
  score: 0.5,
  motion: 0.62,
  loudness: 0.4,
  peak_time: 12,
  cuts: 0,
  speech: "",
  visual: "Two players rally at a table.",
  action: "high",
  on_screen_text: [],
  highlight: 7,
  highlight_reason: "Long, fast exchange.",
  frames: [],
  ...overrides,
});
const board = (overrides: Partial<Board> = {}): Board => ({
  video_id: "v1",
  version: 1,
  model_id: "qwen-small",
  vision: true,
  duration: 90,
  signals: { interval: 30, motion: [0.2, 0.9, 0.1], loudness: [0.3, null, 0.5] },
  scenes: [
    scene({
      on_screen_text: ["NATIONAL TRAINING CENTER", "USA TABLE TENNIS", ""],
      frames: [
        { time: 5, url: "/api/videos/v1/storyboard/frames/s000-0.jpg" },
        { time: 15, url: "/api/videos/v1/storyboard/frames/s000-1.jpg" },
        { time: 25, url: "https://example.com/tracker.jpg" },
      ],
    }),
    scene({
      index: 1,
      start: 30,
      end: 60,
      speech: "That was the best point of the night.",
      visual: "A player celebrates.",
      action: "none",
      highlight: null,
      loudness: null,
    }),
    scene({
      index: 2,
      start: 60,
      end: 90,
      usable: false,
      visual: "Blurred close-up of a hand.",
      highlight: 0,
    }),
  ],
  limitations: "Frames are samples; fast action between them can be missed.",
  ...overrides,
});
function respond(value: unknown, status = 200) {
  const fetch = vi.fn(async (_path: string) => new Response(JSON.stringify(value), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("storyboard", () => {
  it("says the footage has not been watched when there is no storyboard", async () => {
    const fetch = respond({ detail: "No storyboard" }, 404);
    render(<Storyboard videoId="v/1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    await waitFor(() => expect(screen.getByText(/Not watched yet/)).toBeInTheDocument());
    expect(fetch.mock.calls[0][0]).toBe("/api/videos/v%2F1/storyboard");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("shows real failures instead of an empty storyboard", async () => {
    respond({ detail: "Storyboard file is damaged" }, 500);
    render(<Storyboard videoId="v1" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Storyboard file is damaged"));
  });
  it("rejects a response that is not a storyboard", async () => {
    respond({ scenes: "many" });
    render(<Storyboard videoId="v1" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("unreadable storyboard"));
  });
  it("describes every scene: picture, text on screen, speech, levels and skipped footage", async () => {
    respond(board());
    const view = render(<Storyboard videoId="v1" />);
    await waitFor(() => expect(screen.getByText("Two players rally at a table.")).toBeInTheDocument());
    expect(screen.getByText("Watched by qwen-small · 3 scenes, 1 skipped")).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Scenes in order" })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByRole("button", { name: "Scene 1 · 0:00–0:30" })).toBeInTheDocument();
    expect(within(rows[0]).getByText("Highlight 7/10")).toBeInTheDocument();
    expect(within(rows[0]).getByText("high action")).toBeInTheDocument();
    const texts = within(rows[0]).getByLabelText("Text on screen");
    expect([...texts.children].map((chip) => chip.textContent)).toEqual([
      "NATIONAL TRAINING CENTER",
      "USA TABLE TENNIS",
    ]);
    expect(within(rows[0]).getByText("62%")).toBeInTheDocument();
    expect(within(rows[0]).getByRole("meter", { name: "Motion level" })).toHaveValue(0.62);
    expect(within(rows[1]).getByText("That was the best point of the night.").tagName).toBe("BLOCKQUOTE");
    expect(within(rows[1]).queryByText(/Highlight/)).not.toBeInTheDocument();
    expect(within(rows[1]).queryByText("none action")).not.toBeInTheDocument();
    expect(within(rows[1]).getByText("none")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Skipped: unusable footage")).toBeInTheDocument();
    expect(within(rows[2]).queryByText(/Highlight/)).not.toBeInTheDocument();
    expect(screen.getByText(/Frames are samples/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Motion over the length of the video" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Sound level over the length of the video" })).toBeInTheDocument();
    const sources = [...view.container.querySelectorAll("img")].map((image) => image.getAttribute("src"));
    expect(sources).toEqual(["/api/videos/v1/storyboard/frames/s000-0.jpg"]);
  });
  it("selects a scene from the timeline and shows its frames and reason", async () => {
    respond(board());
    const view = render(<Storyboard videoId="v1" />);
    await waitFor(() => expect(screen.getByText("A player celebrates.")).toBeInTheDocument());
    const segments = within(screen.getByRole("group", { name: "Scenes" })).getAllByRole("button");
    expect(segments.map((segment) => segment.getAttribute("aria-label"))).toEqual([
      "Scene 1, 0:00 to 0:30",
      "Scene 2, 0:30 to 1:00",
      "Scene 3, 1:00 to 1:30, skipped",
    ]);
    expect(segments.map((segment) => segment.style.flexGrow)).toEqual(["30", "30", "30"]);
    expect(screen.queryByText("Long, fast exchange.")).not.toBeInTheDocument();
    await userEvent.click(segments[0]);
    expect(segments[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Scene 1 · 0:00–0:30" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Long, fast exchange.")).toBeInTheDocument();
    const frames = [...view.container.querySelectorAll(".scene-frames img")];
    expect(frames.map((frame) => frame.getAttribute("src"))).toEqual([
      "/api/videos/v1/storyboard/frames/s000-0.jpg",
      "/api/videos/v1/storyboard/frames/s000-1.jpg",
    ]);
    expect(screen.getByRole("img", { name: "Scene 1 at 0:15" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Scene 1 · 0:00–0:30" }));
    expect(segments[0]).toHaveAttribute("aria-pressed", "false");
  });
  it("reads out motion and sound at the focused scene, with gaps shown as a dash", async () => {
    respond(board());
    render(<Storyboard videoId="v1" />);
    await waitFor(() => expect(screen.getByText("A player celebrates.")).toBeInTheDocument());
    expect(screen.getByText(/Point at the timeline/)).toBeInTheDocument();
    const segments = within(screen.getByRole("group", { name: "Scenes" })).getAllByRole("button");
    fireEvent.focus(segments[1]);
    const readout = screen.getByText("motion", { exact: false, selector: ".timeline-readout" });
    expect(readout).toHaveTextContent("0:45 90% motion – sound Scene 2");
    fireEvent.blur(segments[1]);
    expect(screen.getByText(/Point at the timeline/)).toBeInTheDocument();
  });
  it("is honest when no vision model watched and when there is no sound", async () => {
    respond(
      board({
        vision: false,
        model_id: null,
        signals: { interval: 30, motion: [0.5, 0.5, 0.5], loudness: [null, null, null] },
        scenes: [scene({ visual: null, action: null, highlight: null, loudness: null })],
        limitations: "",
      }),
    );
    render(<Storyboard videoId="v1" />);
    await waitFor(() =>
      expect(screen.getByText("No vision model: sound and motion only · 1 scene")).toBeInTheDocument(),
    );
    expect(screen.getByText("No sound in this video")).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "Sound level over the length of the video" }),
    ).not.toBeInTheDocument();
  });
  it("reloads when its version changes", async () => {
    const fetch = respond(board());
    const view = render(<Storyboard videoId="v1" version="a" />);
    await waitFor(() => expect(screen.getByText("A player celebrates.")).toBeInTheDocument());
    view.rerender(<Storyboard videoId="v1" version="b" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});

describe("storyboard data handling", () => {
  it("drops malformed scenes and repairs missing signals", () => {
    expect(readable(null)).toBeNull();
    expect(readable({ duration: 0, scenes: [] })).toBeNull();
    expect(readable({ duration: 10, scenes: {} })).toBeNull();
    const repaired = readable({
      duration: 10,
      scenes: [null, { start: 5, end: 2 }, { index: 0, start: 0, end: 10 }],
      signals: { interval: 0, motion: "x" },
    });
    expect(repaired?.scenes).toHaveLength(1);
    expect(repaired?.signals).toEqual({ interval: 1, motion: [], loudness: [] });
    expect(repaired?.limitations).toBe("");
  });
  it("breaks a trace at missing readings instead of drawing through them", () => {
    const { line, area } = tracePaths([0, 1, null, 0.5]);
    expect(line.match(/M/g)).toHaveLength(2);
    expect(area.match(/Z/g)).toHaveLength(2);
    expect(line.startsWith("M125.0,25.0L375.0,2.0")).toBe(true);
    expect(tracePaths([]).line).toBe("");
    expect(tracePaths([null, null]).area).toBe("");
    expect(tracePaths([5, -3]).line).toBe("M250.0,2.0L750.0,25.0");
  });
  it("averages long signals down to a bounded number of points", () => {
    const { line } = tracePaths(Array.from({ length: 5000 }, (_, index) => (index % 2 ? 1 : 0)));
    expect(line.split("L").length).toBeLessThanOrEqual(500);
  });
});
