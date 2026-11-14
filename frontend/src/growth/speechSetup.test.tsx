import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EngineStatus, FactoryBlocker } from "../types";
import { line, testState } from "../test-state";
import { post } from "../api";
import { SpeechSetup, SpeechlessChip, speechBlocked } from "./SpeechSetup";
import { belowBar, reviewOrder } from "./clipRanking";
import { clip } from "../test-state";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, post: vi.fn() };
});

const MISSING = "Speech recognition isn't set up yet. Set it up once (about 1.6 GB download) and run again.";
const DAMAGED = "Speech model files are damaged or were removed — repair (re-download).";
const steps = [
  { id: "runtime", label: "Speech engine packages", approx_gb: 1.4, state: "missing" as const },
  { id: "whisper-turbo", label: "Speech model (Whisper)", approx_gb: 1.6, state: "missing" as const },
];
function blocker(code = "asr_missing"): FactoryBlocker {
  return {
    code,
    message: code === "asr_damaged" ? DAMAGED : MISSING,
    tab: "Models",
    scope: "speech",
    action: "speech_setup",
    steps,
    download_gb: 3,
  };
}
function engine(overrides: Partial<EngineStatus> = {}): EngineStatus {
  return {
    ready: false,
    blocker: blocker(),
    runtime: { state: "missing", problems: [] },
    whisper: { state: "missing", problems: [] },
    steps,
    job: null,
    last_error: null,
    ...overrides,
  };
}
function state(value: EngineStatus) {
  const s = testState();
  s.data.factory = line({ ready: false, blockers: value.blocker ? [value.blocker] : [], engine: value });
  return s;
}

describe("speech setup", () => {
  beforeEach(() => vi.mocked(post).mockReset());

  it("shows the asr_missing blocker with a primary button that starts the setup job", async () => {
    vi.mocked(post).mockResolvedValue({ id: "job1" });
    const s = state(engine());
    render(<SpeechSetup factory={s} />);
    expect(screen.getByText(MISSING)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /set up speech recognition/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/speech/setup", { accept_license: true }));
    await waitFor(() => expect(s.refresh).toHaveBeenCalled());
  });

  it("shows real progress and the current step while setup runs, with no second button", () => {
    const running = engine({
      job: {
        id: "job1", kind: "speech_setup", status: "running", progress: 61,
        message: "Downloading model weights", step: "whisper-turbo", step_index: 2, step_count: 2,
      },
    });
    render(<SpeechSetup factory={state(running)} variant="engine" />);
    expect(screen.getByRole("heading", { name: "Setting up your engine" })).toBeTruthy();
    expect(screen.getByText(/about 3\.0 GB/)).toBeTruthy();
    const bar = screen.getByLabelText("Speech setup progress") as HTMLProgressElement;
    expect(bar.value).toBe(61);
    expect(screen.getByText(/Step 2 of 2 · Downloading model weights/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    const current = screen.getByText("Speech model (Whisper)").closest("li")!;
    expect(current.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("Speech engine packages").closest("li")!.className).toContain("is-complete");
  });

  it("offers a repair for damaged files and a retry after a failed setup", () => {
    render(<SpeechSetup factory={state(engine({ blocker: blocker("asr_damaged"), last_error: "Network down" }))} />);
    expect(screen.getByText(DAMAGED)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Network down");
    expect(screen.getByRole("button", { name: /retry: repair speech model/i })).toBeTruthy();
  });

  it("renders nothing once speech is ready", () => {
    const ready = engine({ ready: true, blocker: null, steps: [] });
    expect(speechBlocked(ready)).toBe(false);
    const { container } = render(<SpeechSetup factory={state(ready)} variant="engine" />);
    expect(container.innerHTML).toBe("");
  });

  it("puts clips made without speech below the bar and labels them", () => {
    const mute = { ...clip, id: "m", made_without_speech: true, rank: { score: 80, position: 1, below_bar: false } };
    expect(belowBar(mute)).toBe(true);
    expect(reviewOrder([mute, clip]).below.map((c) => c.id)).toEqual(["m"]);
    render(<SpeechlessChip />);
    expect(screen.getByText("Made without speech")).toBeTruthy();
  });
});
