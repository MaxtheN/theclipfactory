import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { setPlatformOs } from "../platform";
import type { AgentModel, AgentsState, FactoryBlocker, Job, SystemInfo, Video } from "../types";
import type { FactoryState } from "../useFactory";
import { AgentSetup } from "./AgentSetup";
import { readiness } from "./productionState";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const model = (over: Partial<AgentModel> = {}): AgentModel => ({
  id: "ollama:qwen3-vl:4b-instruct",
  tag: "qwen3-vl:4b-instruct",
  name: "Qwen3-VL 4B Instruct",
  download_gb: 3.3,
  min_ram_gb: 12,
  min_vram_gb: 5,
  license: "Apache-2.0",
  note: "Recommended. Brand research, post copy, references and the strategist are tuned for it.",
  fits: true,
  device: "cpu",
  installed: false,
  recommended: true,
  ...over,
});
const base = { scope: "agents", tab: "AI model", steps: [] };
const blockers: Record<string, FactoryBlocker> = {
  agents_hardware: {
    ...base, code: "agents_hardware", action: null, alternatives: ["openrouter_key", "manual"],
    message: "Local agents need at least 8 GB of memory, or an NVIDIA GPU with 3 GB; this computer has 4 GB.",
  },
  ollama_missing: {
    ...base, code: "ollama_missing", action: "check", install_url: "https://ollama.com/download",
    message: "Agents run on this computer through Ollama, which isn't installed.",
  },
  ollama_stopped: {
    ...base, code: "ollama_stopped", action: "check",
    message: "Ollama is installed but not running. Open the Ollama app (or run `ollama serve`), then check again.",
  },
  agent_model_missing: {
    ...base, code: "agent_model_missing", action: "pull", model_id: "ollama:qwen3-vl:4b-instruct", download_gb: 3.3,
    message: "Download Qwen3-VL 4B Instruct (about 3.3 GB) through Ollama to run agents on this computer.",
  },
};
function agents(blocker: FactoryBlocker | null, over: Partial<AgentsState> = {}): AgentsState {
  return {
    engine: "ollama",
    ollama: { installed: true, running: true, install_url: "https://ollama.com/download" },
    hardware: { ram_gb: 16, gpu: null, vram_gb: null },
    minimum_ram_gb: 8,
    recommended: { text: "ollama:qwen3-vl:4b-instruct", vision: "ollama:qwen3-vl:4b-instruct" },
    catalogue: [model({ installed: !blocker })],
    cloud: false,
    blocker,
    ...over,
  };
}
function factory(state: AgentsState | undefined, jobs: Job[] = []) {
  return {
    data: { system: { os: "windows", agents: state } as SystemInfo, settings: null, models: [], jobs, videos: [], clips: [], instagram: null, analytics: null, factory: null },
    errors: {},
    loading: false,
    busy: false,
    refresh: vi.fn(async () => {}),
    run: vi.fn(),
  } as unknown as FactoryState;
}
function serve() {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

describe("AgentSetup", () => {
  it("shows nothing where agents run on MLX (Apple Silicon)", () => {
    const { container } = render(<AgentSetup factory={factory(agents(null, { engine: "mlx" }))} />);
    expect(container).toBeEmptyDOMElement();
    render(<AgentSetup factory={factory(undefined)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says which model is ready and on which device", () => {
    setPlatformOs("windows");
    render(<AgentSetup factory={factory(agents(null, { hardware: { ram_gb: 16, gpu: "NVIDIA GeForce RTX 3060", vram_gb: 12 }, catalogue: [model({ installed: true, device: "cuda" })] }))} />);
    const card = screen.getByRole("region", { name: "Local agents" });
    expect(card).toHaveTextContent("Agents run on this computer through Ollama. 16 GB memory · NVIDIA GeForce RTX 3060 (12 GB).");
    expect(card).toHaveTextContent("Ready: Qwen3-VL 4B Instruct runs on the NVIDIA GPU.");
    expect(card.textContent).not.toMatch(/Mac/);
  });

  it("blocks a computer below the minimum, names the alternatives and can check again", async () => {
    const calls = serve();
    const f = factory(agents(blockers.agents_hardware, { hardware: { ram_gb: 4, gpu: null, vram_gb: null }, recommended: null }));
    render(<AgentSetup factory={f} />);
    const card = screen.getByRole("region", { name: "Local agents" });
    expect(card).toHaveAttribute("data-code", "agents_hardware");
    expect(card).toHaveTextContent("this computer has 4 GB");
    expect(card).toHaveTextContent("Use your own OpenRouter key: add it in Settings → Models → AI model, then turn on cloud agents.");
    expect(card).toHaveTextContent("Edit clips by hand in the Studio.");
    expect(within(card).queryByRole("button", { name: /Download/ })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(f.refresh).toHaveBeenCalledWith(["system", "factory", "jobs", "models"]));
    expect(calls.map((c) => c.url)).toEqual(["/api/agents/check"]);
  });

  it("links to the Ollama download when it is missing, with a retry", async () => {
    const calls = serve();
    render(<AgentSetup factory={factory(agents(blockers.ollama_missing, { ollama: { installed: false, running: false, install_url: "https://ollama.com/download" } }))} />);
    const card = screen.getByRole("region", { name: "Local agents" });
    expect(within(card).getByRole("link", { name: "Get Ollama" })).toHaveAttribute("href", "https://ollama.com/download");
    expect(card).toHaveTextContent("Other ways to make clips");
    fireEvent.click(within(card).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(calls.map((c) => c.url)).toEqual(["/api/agents/check"]));
  });

  it("asks to open Ollama when it is stopped, with a retry", () => {
    render(<AgentSetup factory={factory(agents(blockers.ollama_stopped))} />);
    const card = screen.getByRole("region", { name: "Local agents" });
    expect(card).toHaveTextContent("Ollama is installed but not running.");
    expect(within(card).queryByRole("link", { name: "Get Ollama" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("downloads the recommended model only after its license is accepted", async () => {
    const calls = serve();
    render(<AgentSetup factory={factory(agents(blockers.agent_model_missing))} />);
    const card = screen.getByRole("region", { name: "Local agents" });
    const download = within(card).getByRole("button", { name: "Download Qwen3-VL 4B Instruct (about 3.3 GB)" });
    expect(download).toBeDisabled();
    fireEvent.click(within(card).getByRole("checkbox", { name: "I accept Qwen3-VL 4B Instruct’s Apache-2.0 license." }));
    fireEvent.click(download);
    await waitFor(() => expect(calls).toEqual([{ url: "/api/agents/ollama/pull", body: { model_id: "ollama:qwen3-vl:4b-instruct", accept_license: true } }]));
    expect(within(card).getByRole("button", { name: "Check again" })).toBeVisible();
  });

  it("shows the running download instead of the button", () => {
    const job: Job = { id: "j1", kind: "download", status: "running", progress: 40, message: "Downloading Qwen3-VL 4B Instruct through Ollama", context: { model_id: "ollama:qwen3-vl:4b-instruct" } };
    render(<AgentSetup factory={factory(agents(blockers.agent_model_missing), [job])} />);
    expect(screen.getByRole("progressbar", { name: "Qwen3-VL 4B Instruct download progress" })).toHaveAttribute("value", "40");
    expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
  });

  it("renders inline only while agents are blocked", () => {
    const { container } = render(<AgentSetup factory={factory(agents(null))} variant="inline" />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    render(<AgentSetup factory={factory(agents(blockers.ollama_stopped))} variant="inline" />);
    expect(screen.getByRole("group", { name: "Local agents" })).toHaveAttribute("data-code", "ollama_stopped");
  });
});

describe("readiness on Windows and Linux", () => {
  const source = { id: "v1", duration: 60, has_audio: false } as Video;
  const input = (system: SystemInfo) => ({
    source, system, models: [], jobs: [], modelId: "", approved: true, sourceAttached: true, subtitles: false, stale: false,
  });
  const ready = { ffmpeg: true, ffprobe: true } as SystemInfo;

  it("blocks agents with the engine's reason before anything is queued", () => {
    const state = readiness(input({ ...ready, agents: agents(blockers.ollama_missing) }));
    expect(state.agent).toEqual([blockers.ollama_missing.message]);
    expect(state.canProduce).toBe(false);
    expect(state.canRender).toBe(true);
  });

  it("keeps the model check where the engine reports no agents blocker", () => {
    expect(readiness(input({ ...ready, agents: agents(null) })).agent).toEqual(["Choose an installed model that can inspect video frames."]);
    expect(readiness(input({ ...ready, agents: agents(blockers.ollama_missing, { engine: "mlx" }) })).agent).toEqual(["Choose an installed model that can inspect video frames."]);
  });

  it("states the speech download size this computer's engine reports", () => {
    const speaking = { ...source, has_audio: true, transcript: null } as Video;
    const steps = [{ id: "runtime", label: "Speech runtime", approx_gb: 0.4, state: "missing" as const }, { id: "whisper", label: "Whisper", approx_gb: 1.6, state: "missing" as const }];
    const engine = { ready: false, blocker: null, runtime: { state: "missing" as const, problems: [] }, whisper: { state: "missing" as const, problems: [] }, steps, job: null, last_error: null };
    const state = readiness({ ...input({ ...ready, engine }), source: speaking });
    expect(state.agent).toContain("Speech recognition isn't set up yet. Set it up once (about 2.0 GB download) and run again.");
    const unknown = readiness({ ...input(ready), source: speaking });
    expect(unknown.agent).toContain("Speech recognition isn't set up yet. Set it up once (a one-time download) and run again.");
  });
});
