import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settings, testState } from "../test-state";
import { Models } from "./Models";
import { SettingsPage, editableSettings } from "./Settings";

afterEach(() => vi.unstubAllGlobals());
function mockFetch() {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response('{"id":"j1"}'));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

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
      production_strategy: "swarm",
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
