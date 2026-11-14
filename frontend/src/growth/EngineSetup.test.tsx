import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EngineSetup } from "./EngineSetup";
import { patch, post, remove } from "../api";
import type { FactoryState } from "../useFactory";

vi.mock("../api", async () => ({ ...await vi.importActual<typeof import("../api")>("../api"), post: vi.fn(async () => ({})), patch: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) }));

function fixture() {
  const factory = {
    busy: false, loading: false, errors: {},
    data: {
      factory: null,
      system: { model_runtime: true, ollama: false, memory_gb: 16, free_disk_gb: 52, ffmpeg: true },
      settings: { brand: "Keep this brand", objective: "traffic", language: "en", autonomy: "auto", default_model: "", clip_count: 3, production_strategy: "swarm", ads_enabled: false, publishing_enabled: true, daily_budget: 25, total_budget: 500, graph_version: "v22.0" },
      models: [
        { id: "qwen-small", name: "Qwen small", kind: "llm", installed: true, vision: true, license: "Apache 2.0", estimated_gb: 2 },
        { id: "qwen-large", name: "Qwen vision", kind: "llm", installed: false, vision: true, license: "Apache 2.0", estimated_gb: 8.5 },
        { id: "whisper", name: "Whisper", kind: "speech", installed: false, status: "damaged", license: "MIT", estimated_gb: 1.5 },
        { id: "ollama:text", name: "Ollama text", kind: "llm", installed: true, source: "ollama", vision: false },
      ],
      jobs: [{ id: "download-1", kind: "model_download", status: "running", progress: 42, message: "Downloading model files" }],
      videos: [], clips: [],
    },
    run: vi.fn(async (task: () => Promise<unknown>) => { await task(); return true; }),
    refresh: vi.fn(async () => {}),
  } as unknown as FactoryState;
  const view = render(<div className="gf-app"><EngineSetup factory={factory} /></div>);
  return { factory, view };
}
function modelDetails(name: string) {
  const summary = screen.getByText(name, { selector: "strong" }).closest("summary")!;
  fireEvent.click(summary);
  return within(summary.closest("details")!);
}
beforeEach(() => vi.clearAllMocks());

describe("EngineSetup", () => {
  it("mounts without model work and reports hardware without guessing unknown values", () => {
    const { factory, view } = fixture();
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(factory.refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("This Mac"));
    expect(screen.getByText("16 GB")).toBeVisible();
    expect(screen.getByText("52 GB")).toBeVisible();
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(view.container.querySelectorAll(".gf-local-engine-tools[open]")).toHaveLength(0);
  });

  it("requires separate license consent and preserves exact install and repair actions", async () => {
    fixture();
    const vision = modelDetails("Qwen vision");
    const whisper = modelDetails("Whisper");
    expect(vision.getByRole("button", { name: "Install model" })).toBeDisabled();
    fireEvent.click(vision.getByRole("checkbox", { name: /accept Qwen vision/ }));
    expect(whisper.getByRole("button", { name: "Repair (re-download)" })).toBeDisabled();
    fireEvent.click(vision.getByRole("button", { name: "Install model" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/models/qwen-large/download", { accept_license: true }));
    fireEvent.click(whisper.getByRole("checkbox", { name: /accept Whisper/ }));
    fireEvent.click(whisper.getByRole("button", { name: "Repair (re-download)" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/models/whisper/download", { accept_license: true }));
  });

  it("honors removal confirmation and leaves Ollama management with Ollama", async () => {
    fixture();
    const local = modelDetails("Qwen small");
    const ollama = modelDetails("Ollama text");
    expect(ollama.queryByRole("button", { name: "Remove model" })).toBeNull();
    expect(ollama.getByText(/Managed by Ollama/)).toBeVisible();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(local.getByRole("button", { name: "Remove model" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(local.getByRole("button", { name: "Remove model" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("/api/models/qwen-small"));
    confirm.mockRestore();
  });

  it("queues runtime only by click and retains real progress and cancellation", async () => {
    fixture();
    fireEvent.click(screen.getByRole("button", { name: "Set up runtime" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/runtime/setup"));
    fireEvent.click(screen.getByText("Background jobs"));
    expect(screen.getByRole("progressbar", { name: "model_download progress" })).toHaveAttribute("value", "42");
    expect(screen.getByText("Downloading model files")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel job" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/jobs/download-1/cancel"));
  });

  it("runs local inference only on an installed model with an explicit prompt", async () => {
    fixture();
    fireEvent.click(screen.getByText("Local testing & narration"));
    expect(screen.getByRole("button", { name: "Run locally" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Find a clear opening" } });
    fireEvent.change(screen.getByLabelText("Inference model"), { target: { value: "ollama:text" } });
    fireEvent.click(screen.getByRole("button", { name: "Run locally" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/inference", { prompt: "Find a clear opening", model_id: "ollama:text" }));
    expect(screen.getByRole("button", { name: "Generate narration" })).toBeDisabled();
  });

  it("retains a newer defaults draft while an earlier patch is pending", async () => {
    const { factory } = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(patch).mockImplementationOnce(async <T,>(_path: string, changes: unknown) => {
      await pending;
      Object.assign(factory.data.settings!, changes);
      return factory.data.settings as T;
    });
    fireEvent.click(screen.getByText("Production defaults"));
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "fr" } });
    fireEvent.click(screen.getByRole("button", { name: "Save production defaults" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "es" } });
    release();
    await waitFor(() => expect(factory.data.settings?.language).toBe("fr"));
    expect(screen.getByLabelText("Language")).toHaveValue("es");
    expect(screen.getByRole("button", { name: "Save production defaults" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save production defaults" }));
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith("/api/settings", { language: "es" }));
  });

  it("keeps defaults after a successful request with failed readback until confirmed settings arrive", async () => {
    const { factory, view } = fixture();
    const original = factory.data.settings!;
    const readbackError = { ...factory, errors: { settings: "Cannot refresh settings" } } as FactoryState;
    vi.mocked(patch).mockImplementationOnce(async <T,>() => {
      view.rerender(<div className="gf-app"><EngineSetup factory={readbackError} /></div>);
      return {} as T;
    });
    fireEvent.click(screen.getByText("Production defaults"));
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "fr" } });
    fireEvent.click(screen.getByRole("button", { name: "Save production defaults" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert")).toHaveTextContent("Unknown settings will not be overwritten");
    view.rerender(<div className="gf-app"><EngineSetup factory={{ ...factory, errors: {}, data: { ...factory.data, settings: { ...original } } }} /></div>);
    expect(screen.getByLabelText("Language")).toHaveValue("fr");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save production defaults" })).toBeEnabled());
    view.rerender(<div className="gf-app"><EngineSetup factory={{ ...factory, errors: {}, data: { ...factory.data, settings: { ...original, language: "fr" } } }} /></div>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save production defaults" })).toBeDisabled());
    expect(screen.getByLabelText("Language")).toHaveValue("fr");
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer revert to the old language while the previous write is pending", async () => {
    const { factory } = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(patch).mockImplementationOnce(async <T,>(_path: string, changes: unknown) => {
      await pending;
      Object.assign(factory.data.settings!, changes);
      return factory.data.settings as T;
    });
    fireEvent.click(screen.getByText("Production defaults"));
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "fr" } });
    fireEvent.click(screen.getByRole("button", { name: "Save production defaults" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "en" } });
    release();
    await waitFor(() => expect(factory.data.settings?.language).toBe("fr"));
    expect(screen.getByLabelText("Language")).toHaveValue("en");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save production defaults" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save production defaults" }));
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith("/api/settings", { language: "en" }));
  });

  it("patches only changed local defaults and preserves unrelated settings", async () => {
    fixture();
    fireEvent.click(screen.getByText("Production defaults"));
    expect(screen.getByRole("button", { name: "Save production defaults" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "fr" } });
    fireEvent.change(screen.getByLabelText("When footage arrives"), { target: { value: "review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save production defaults" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/settings", { language: "fr", autonomy: "review" }));
    expect(Object.keys(vi.mocked(patch).mock.calls[0][1] as object).sort()).toEqual(["autonomy", "language"]);
    expect(post).not.toHaveBeenCalled();
  });
});
