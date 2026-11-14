import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceHasTranscript } from "../productionPreflight";
import { line, lineSource, settings, testState } from "../test-state";
import { Footage, Transcript } from "./Footage";
import { Models } from "./Models";
import { SettingsPage, editableSettings } from "./Settings";

afterEach(() => vi.unstubAllGlobals());
function mockFetch() {
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    path.endsWith("/storyboard") && !_init?.method
      ? new Response('{"detail":"Not built"}', { status: 404 })
      : new Response('{"id":"j1"}'),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);
const summary = { scenes: 12, vision: true, model_id: "qwen-small", updated_at: "2026-11-14T00:00:00Z" };

describe("footage page", () => {
  it("starts production and watching for the selected video", async () => {
    const fetch = mockFetch();
    const state = testState();
    state.data.videos = [
      { id: "v1", name: "First", duration: 60 },
      { id: "v2", name: "Second", duration: 90 },
    ];
    render(<Footage state={state} onEdit={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Second/ }));
    expect(screen.getByText(/has not watched this video yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Make clips" }));
    expect(fetch.mock.calls[0][0]).toBe("/api/videos/v2/produce");
    expect(bodyOf(fetch.mock.calls[0])).toEqual({});
    await userEvent.click(screen.getByRole("button", { name: "Watch footage" }));
    expect(fetch.mock.calls[1][0]).toBe("/api/videos/v2/storyboard");
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "POST" });
    expect(bodyOf(fetch.mock.calls[1])).toEqual({});
  });
  it("loads the storyboard of a watched video and offers to watch again", async () => {
    const fetch = mockFetch();
    const state = testState();
    state.data.videos = [{ id: "v1", name: "First", duration: 60, storyboard: summary }];
    render(<Footage state={state} onEdit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Watch again" })).toBeEnabled();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/videos/v1/storyboard", expect.anything()));
    expect(within(screen.getByRole("button", { name: /First/ })).getByText("Watched")).toBeInTheDocument();
  });
  it("follows the factory's verdict on whether a video can start", () => {
    mockFetch();
    const state = testState();
    state.data.videos = [{ id: "v1", name: "First", duration: 60 }];
    state.data.factory = line({
      sources: [
        lineSource({ can_produce: false, blocked_reason: "Install a model first.", state: "idle" }),
      ],
    });
    render(<Footage state={state} onEdit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Make clips" })).toBeDisabled();
    expect(screen.getByText("Install a model first.")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /First/ })).getByText("New")).toBeInTheDocument();
  });
  it("locks production and watching while the video has running work", () => {
    mockFetch();
    const state = testState();
    state.data.videos = [{ id: "v1", name: "First", duration: 60, has_audio: true }];
    state.data.jobs = [{ id: "j1", kind: "team", status: "running", context: { video_id: "v1" } }];
    state.data.factory = line({ sources: [lineSource({ state: "working", job_id: "j1" })] });
    render(<Footage state={state} onEdit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Make clips" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Watch footage" })).toBeDisabled();
    expect(screen.getByText("The factory is working on this video.")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /First/ })).getByText("Working")).toBeInTheDocument();
  });
  it("opens the manual editor and deletes only after confirmation", async () => {
    const fetch = mockFetch();
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    const onEdit = vi.fn();
    const state = testState();
    state.data.videos = [{ id: "v1", name: "First", duration: 60 }];
    render(<Footage state={state} onEdit={onEdit} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit by hand" }));
    expect(onEdit).toHaveBeenCalledWith("v1");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(fetch.mock.calls[0][0]).toBe("/api/videos/v1");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
  });
  it("reads slim transcripts and prefers the explicit transcript flag", () => {
    expect(sourceHasTranscript({ has_transcript: true, transcript: null })).toBe(true);
    expect(sourceHasTranscript({ has_transcript: false, transcript: { text: "old" } })).toBe(false);
    expect(sourceHasTranscript({ transcript: { language: "en", text: "Hi", segment_count: 1 } })).toBe(true);
    expect(sourceHasTranscript({ transcript: null })).toBe(false);
    const view = render(<Transcript value={{ language: "en", text: "Hello there", segment_count: 2 }} />);
    expect(screen.getByText("Hello there")).toBeInTheDocument();
    view.rerender(<Transcript value={{ language: "en", text: " ", segment_count: 0 }} />);
    expect(screen.getByText("No speech was found in this video.")).toBeInTheDocument();
    view.rerender(<Transcript value={null} />);
    expect(screen.getByText("No transcript yet.")).toBeInTheDocument();
  });
});

describe("factory settings", () => {
  it("sends the factory defaults with every save and clamps odd clip counts", () => {
    expect(editableSettings(settings)).toMatchObject({ default_model: "", clip_count: 3 });
    expect(editableSettings({ ...settings, default_model: "qwen-large", clip_count: 5 })).toMatchObject({
      default_model: "qwen-large",
      clip_count: 5,
    });
    expect(editableSettings({ ...settings, clip_count: 40 }).clip_count).toBe(3);
    expect(editableSettings({ ...settings, clip_count: NaN }).clip_count).toBe(3);
  });
  it("saves autopilot, the default model and clips per source", async () => {
    const fetch = mockFetch();
    const state = testState();
    state.data.models = [
      { id: "qwen-small", name: "Qwen small", installed: true, kind: "llm" },
      { id: "ollama:llama", name: "Llama", installed: true, kind: "llm", vision: false },
      { id: "qwen-large", name: "Qwen large", installed: false, kind: "llm" },
      { id: "whisper-turbo", name: "Whisper", installed: true, kind: "asr" },
    ];
    render(<SettingsPage state={state} />);
    const autopilot = screen.getByRole("checkbox", { name: /Autopilot/ });
    expect(autopilot).not.toBeChecked();
    const model = screen.getByLabelText("Default model");
    expect(within(model).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Automatic",
      "Qwen small",
      "Llama (text only)",
    ]);
    await userEvent.click(autopilot);
    await userEvent.selectOptions(model, "qwen-small");
    await userEvent.selectOptions(screen.getByLabelText("Clips per source"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Save studio settings" }));
    expect(fetch.mock.calls[0][0]).toBe("/api/settings");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "PUT" });
    expect(bodyOf(fetch.mock.calls[0])).toMatchObject({
      autonomy: "auto",
      default_model: "qwen-small",
      clip_count: 5,
      production_strategy: "team",
    });
  });
  it("keeps a saved default model visible when it is no longer installed", () => {
    const state = testState();
    state.data.settings = { ...settings, autonomy: "auto", default_model: "ollama:gone", clip_count: 2 };
    render(<SettingsPage state={state} />);
    expect(screen.getByRole("checkbox", { name: /Autopilot/ })).toBeChecked();
    expect(screen.getByLabelText("Default model")).toHaveValue("ollama:gone");
    expect(screen.getByRole("option", { name: "ollama:gone (not installed)" })).toBeInTheDocument();
    expect(screen.getByLabelText("Clips per source")).toHaveValue("2");
  });
});

describe("models page readiness", () => {
  it("lists what this Mac reports without assuming anything is available", () => {
    const state = testState();
    state.data.system = { apple_silicon: true, memory_gb: 48, ffmpeg: false, model_runtime: true };
    const view = render(<Models state={state} />);
    const section = screen.getByRole("heading", { name: "This Mac" }).closest("section")!;
    const row = (label: string) => within(section).getByText(label).closest("div")!;
    expect(row("Apple Silicon")).toHaveTextContent("Available");
    expect(row("Memory")).toHaveTextContent("48 GB");
    expect(row("FFmpeg")).toHaveTextContent("Unavailable");
    expect(row("Free disk")).toHaveTextContent("Unknown");
    view.unmount();
    render(<Models state={testState({ errors: { system: "Offline" } })} />);
    const stale = screen.getByRole("heading", { name: "This Mac" }).closest("section")!;
    expect(within(stale).queryByText("Available")).not.toBeInTheDocument();
  });
});
