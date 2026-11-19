import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { SystemInfo } from "../types";
import type { FactoryState } from "../useFactory";
import type { Workspace } from "./useCampaignWorkspace";
import { SettingsScreen, type SettingsSection } from "./SettingsScreen";

const w = {} as Workspace;
function factory(system: SystemInfo | null, error?: string) {
  return {
    data: { system, settings: null, models: [], jobs: [], videos: [], clips: [], instagram: null, analytics: null, factory: null },
    errors: error ? { system: error } : {},
    loading: false,
    busy: false,
    refresh: vi.fn(async () => {}),
    run: vi.fn(),
  } as unknown as FactoryState;
}
const ready: SystemInfo = {
  platform: "macOS 15",
  apple_silicon: true,
  memory_gb: 32,
  free_disk_gb: 120.46,
  ffmpeg: true,
  ffprobe: true,
  model_runtime: true,
  whisper: true,
  ollama: false,
  data_dir: "/Users/me/Library/Application Support/Growth Factory",
  version: "0.1.0",
};
function show(f: FactoryState, section: SettingsSection, onSection = vi.fn()) {
  render(<SettingsScreen w={w} factory={f} section={section} onSection={onSection} visible />);
  return onSection;
}

afterEach(cleanup);

describe("Settings", () => {
  it("lists every section and marks the current one", () => {
    const onSection = show(factory(ready), "device");
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Device and runtime", "Models", "Accounts and connections", "Privacy and storage", "Background jobs", "About",
    ]);
    expect(within(nav).getByRole("button", { name: "Device and runtime" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(nav).getByRole("button", { name: "About" }));
    expect(onSection).toHaveBeenCalledWith("about");
  });

  it("shows the installed app version in About, or says it is unavailable", () => {
    show(factory(ready), "about");
    expect(within(screen.getByRole("region", { name: "About" })).getByText("0.1.0")).toBeVisible();
    cleanup();
    show(factory({ ...ready, version: undefined }), "about");
    expect(screen.getByText("Version unavailable")).toBeVisible();
  });

  it("reports Status unavailable instead of guessing when system status fails", () => {
    const f = factory(ready, "Local service unreachable");
    show(f, "device");
    const device = screen.getByRole("region", { name: "Device and runtime" });
    expect(within(device).getByRole("alert")).toHaveTextContent("Status unavailable: Local service unreachable");
    expect(within(device).queryByText("Ready")).toBeNull();
    fireEvent.click(within(device).getByRole("button", { name: "Refresh status" }));
    expect(f.refresh).toHaveBeenCalledWith(["system", "factory"]);
    cleanup();
    show(factory(ready, "Local service unreachable"), "about");
    expect(screen.getByText("Version unavailable")).toBeVisible();
  });

  it("lists each missing prerequisite with the action that resolves it", () => {
    const onSection = show(factory({ ...ready, ffmpeg: false, whisper: false }), "device");
    const gaps = screen.getByRole("list", { name: "Missing prerequisites" });
    expect(gaps).toHaveTextContent("FFmpeg is missing.");
    expect(gaps).toHaveTextContent("brew install ffmpeg");
    expect(gaps).toHaveTextContent("Speech-to-text isn’t installed.");
    fireEvent.click(within(gaps).getByRole("button", { name: "Open Models" }));
    expect(onSection).toHaveBeenCalledWith("models");
    cleanup();
    show(factory(ready), "device");
    expect(screen.queryByRole("list", { name: "Missing prerequisites" })).toBeNull();
    expect(screen.getByText("Every prerequisite for local production is ready.")).toBeVisible();
    expect(screen.getByText("120.5 GB")).toBeVisible();
  });

  it("shows where data is stored and which features need internet", () => {
    show(factory(ready), "privacy");
    const privacy = screen.getByRole("region", { name: "Privacy and storage" });
    expect(within(privacy).getByText(ready.data_dir!)).toBeVisible();
    expect(privacy).toHaveTextContent(/use the internet are marked/);
  });

  it("shows background jobs in their own section", () => {
    show(factory(ready), "jobs");
    expect(within(screen.getByRole("region", { name: "Background jobs" })).getByText("The queue is clear")).toBeVisible();
  });
});
