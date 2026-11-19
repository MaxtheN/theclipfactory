import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { setPlatformOs, type Os } from "../platform";
import type { SystemInfo } from "../types";
import type { FactoryState } from "../useFactory";
import type { Workspace } from "./useCampaignWorkspace";
import { AiModelCard, type LlmView } from "./AiModelCard";
import { QuickActions } from "./QuickActions";
import { SettingsScreen, type SettingsSection } from "./SettingsScreen";
import { modelRouteText } from "./WebsiteBrief";

const { showModal, close } = HTMLDialogElement.prototype;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterAll(() => {
  Object.assign(HTMLDialogElement.prototype, { showModal, close });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const system = (os: Os): SystemInfo => ({
  os,
  platform: os === "windows" ? "Windows AMD64" : os === "linux" ? "Linux x86_64" : "Darwin arm64",
  apple_silicon: os === "macos",
  memory_gb: 16,
  free_disk_gb: 80,
  ffmpeg: false,
  ffprobe: false,
  model_runtime: true,
  whisper: true,
  ollama: true,
  data_dir: "/data",
  version: "0.1.0",
});
function factory(info: SystemInfo) {
  return {
    data: { system: info, settings: null, models: [], jobs: [], videos: [], clips: [], instagram: null, analytics: null, factory: null },
    errors: {},
    loading: false,
    busy: false,
    refresh: vi.fn(async () => {}),
    run: vi.fn(),
  } as unknown as FactoryState;
}
function settings(os: Os, section: SettingsSection) {
  setPlatformOs(os);
  render(<SettingsScreen w={{} as Workspace} factory={factory(system(os))} section={section} onSection={vi.fn()} visible />);
  return screen.getByRole("region");
}

const llm: LlmView = {
  key: { present: true, error: null },
  groq_configured: true,
  settings: { provider: "local", model: "m", cloud_agents: false, cloud_agent_frames: false, fallback_to_local: false, speech_provider: "local" },
  routes: { brand_research: "local", post_copy: "local", reference_pattern: "local", strategist_hypothesis: "local", learning_analyst: "local", agents: "local" },
  models: [{ id: "m", label: "Model", tier: "Fast", vision: true }],
  spend: { calls: 0, cost_usd: 0 },
};

describe("Platform wording", () => {
  it("keeps the Mac wording on macOS", () => {
    const device = settings("macos", "device");
    expect(device).toHaveTextContent("What this Mac has ready for local production.");
    expect(device).toHaveTextContent("brew install ffmpeg-full");
    expect(within(device).getByText("Apple Silicon")).toBeVisible();
  });

  it.each([
    ["windows", "winget install Gyan.FFmpeg"],
    ["linux", "sudo apt install ffmpeg"],
  ] as const)("describes %s without Mac-only words or steps", (os, install) => {
    const device = settings(os, "device");
    expect(device).toHaveTextContent("What this computer has ready for local production.");
    expect(device).toHaveTextContent(install);
    expect(within(device).queryByText("Apple Silicon")).toBeNull();
    expect(device.textContent).not.toMatch(/Mac|brew|Keychain/);
    for (const section of ["privacy", "jobs", "about"] as const) {
      cleanup();
      expect(settings(os, section).textContent).not.toMatch(/\bMac\b/);
    }
  });

  it.each([
    ["macos", "macOS Keychain", "your Mac", "this Mac"],
    ["windows", "Windows Credential Manager", "your computer", "this computer"],
    ["linux", "your system keyring", "your computer", "this computer"],
  ] as const)("names the %s key store and computer in AI model settings", async (os, store, yours, local) => {
    setPlatformOs(os);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(llm), { status: 200, headers: { "Content-Type": "application/json" } })));
    render(<AiModelCard />);
    expect(await screen.findByText(`Groq key configured in ${store}.`)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Transcription audio stays on ${local}.*audio leaves ${yours}`))).toBeInTheDocument();
    expect(screen.getByText(/Key saved in .* ✓/).textContent).toBe(`Key saved in ${os === "macos" ? "Keychain" : os === "windows" ? "Credential Manager" : "system keyring"} ✓`);
    expect(screen.getByText(`Text and clip-agent models run on ${local}.`, { exact: false })).toBeInTheDocument();
  });

  it.each([
    ["macos", "⌘K"],
    ["windows", "CtrlK"],
    ["linux", "CtrlK"],
  ] as const)("shows the %s command-palette shortcut", (os, keys) => {
    setPlatformOs(os);
    const { container } = render(<QuickActions open onDismiss={vi.fn()} actions={[]} />);
    const footer = container.ownerDocument.querySelector(".gf-command-footer")!;
    expect(Array.from(footer.querySelectorAll("kbd")).slice(-2).map((k) => k.textContent).join("")).toBe(keys);
  });

  it("says which computer drafts the website brief", () => {
    setPlatformOs("windows");
    expect(modelRouteText({ ...llm, routes: { ...llm.routes, brand_research: "local" } }, false)).toBe("Drafted by the model on this computer.");
    setPlatformOs("macos");
    expect(modelRouteText(llm, false)).toBe("Drafted by the model on this Mac.");
  });
});
