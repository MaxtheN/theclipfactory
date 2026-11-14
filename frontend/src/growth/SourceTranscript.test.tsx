import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testState } from "../test-state";
import type { Video } from "../types";
import type { FactoryState } from "../useFactory";
import { SourceTranscript } from "./SourceTranscript";
import { productionApi } from "./productionApi";
import type { Workspace } from "./useCampaignWorkspace";

const mode = vi.hoisted(() => ({ preview: false }));
vi.mock("./workspaceApi", () => ({
  get reviewPreview() {
    return mode.preview;
  },
}));
vi.mock("./productionApi", () => ({
  productionApi: { importTranscript: vi.fn(), transcribe: vi.fn() },
}));

const source: Video = {
  id: "source-a",
  name: "Episode A",
  has_audio: true,
  duration: 60,
};
const srt = "1\n00:00:01,000 --> 00:00:03,000\nA source-backed opening.\n";
function readyFactory(): FactoryState {
  const factory = testState();
  factory.data = {
    ...factory.data,
    system: { model_runtime: true, ffmpeg: true },
    models: [{ id: "whisper-turbo", name: "Whisper", installed: true }],
  };
  return factory;
}
function runTask(): Workspace["run"] {
  return vi.fn(async (task) => {
    try {
      await task();
      return true;
    } catch {
      return false;
    }
  });
}
function openDetails() {
  fireEvent.click(screen.getByText("Transcript & captions"));
}
beforeEach(() => {
  mode.preview = false;
  vi.mocked(productionApi.importTranscript).mockReset();
  vi.mocked(productionApi.transcribe).mockReset();
});

describe("source transcript tools", () => {
  it("reports persisted origin and valid timed cues without calling them approved", () => {
    const imported = {
      ...source,
      transcript_origin: "imported",
      transcript: {
        segments: [
          { start: 1, end: 3, text: "A source-backed opening." },
          { start: 4, end: 6, text: "A second cue." },
        ],
      },
    };
    render(
      <SourceTranscript
        source={imported}
        factory={readyFactory()}
        run={runTask()}
      />,
    );
    expect(screen.getByText("Imported transcript")).toBeInTheDocument();
    expect(screen.getByText("2 valid timed cues")).toBeInTheDocument();
    expect(productionApi.importTranscript).not.toHaveBeenCalled();
    expect(productionApi.transcribe).not.toHaveBeenCalled();
  });

  it("imports the selected file and explicit language through the shared run boundary", async () => {
    const run = runTask();
    render(
      <SourceTranscript source={source} factory={readyFactory()} run={run} />,
    );
    openDetails();
    fireEvent.change(screen.getByLabelText("Transcript file"), {
      target: {
        files: [new File([srt], "episode.srt", { type: "text/plain" })],
      },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Timed transcript")).toHaveValue(srt),
    );
    expect(screen.getByLabelText("Transcript format")).toHaveValue("srt");
    fireEvent.change(screen.getByLabelText("Transcript language"), {
      target: { value: "fr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import transcript" }));
    await waitFor(() =>
      expect(productionApi.importTranscript).toHaveBeenCalledExactlyOnceWith(
        "source-a",
        { format: "srt", content: srt, language: "fr" },
      ),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps transcript, format and language available after an import failure", async () => {
    vi.mocked(productionApi.importTranscript).mockRejectedValue(
      new Error("Cue exceeds source duration."),
    );
    render(
      <SourceTranscript
        source={source}
        factory={readyFactory()}
        run={runTask()}
      />,
    );
    openDetails();
    fireEvent.change(screen.getByLabelText("Timed transcript"), {
      target: { value: srt },
    });
    fireEvent.change(screen.getByLabelText("Transcript format"), {
      target: { value: "vtt" },
    });
    fireEvent.change(screen.getByLabelText("Transcript language"), {
      target: { value: "en" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import transcript" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Timed transcript")).toHaveValue(srt);
    expect(screen.getByLabelText("Transcript format")).toHaveValue("vtt");
    expect(screen.getByLabelText("Transcript language")).toHaveValue("en");
    expect(productionApi.importTranscript).toHaveBeenCalledTimes(1);
  });

  it("refuses oversized files without replacing an existing draft", async () => {
    render(
      <SourceTranscript
        source={source}
        factory={readyFactory()}
        run={runTask()}
      />,
    );
    openDetails();
    fireEvent.change(screen.getByLabelText("Timed transcript"), {
      target: { value: srt },
    });
    const file = new File(["ignored"], "large.json");
    Object.defineProperty(file, "size", { value: 2_000_001 });
    fireEvent.change(screen.getByLabelText("Transcript file"), {
      target: { files: [file] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("within 2 MB");
    expect(screen.getByLabelText("Timed transcript")).toHaveValue(srt);
    expect(productionApi.importTranscript).not.toHaveBeenCalled();
  });

  it("queues transcription only after the user's explicit action", async () => {
    const run = runTask();
    render(
      <SourceTranscript source={source} factory={readyFactory()} run={run} />,
    );
    openDetails();
    expect(productionApi.transcribe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Transcribe locally" }));
    await waitFor(() =>
      expect(productionApi.transcribe).toHaveBeenCalledExactlyOnceWith(
        "source-a",
      ),
    );
    expect(run).toHaveBeenCalledWith(
      expect.any(Function),
      expect.stringContaining("queued"),
    );
  });

  it.each(["busy-source", "stale", "loading", "disabled"])(
    "blocks both transcript actions for %s",
    (scenario) => {
      const factory = readyFactory();
      if (scenario === "busy-source")
        factory.data.jobs = [
          {
            id: "running",
            kind: "render",
            status: "running",
            context: { video_id: source.id },
          },
        ];
      if (scenario === "stale")
        factory.errors.videos = "Unable to refresh sources";
      if (scenario === "loading") factory.loading = true;
      render(
        <SourceTranscript
          source={source}
          factory={factory}
          run={runTask()}
          disabled={scenario === "disabled"}
        />,
      );
      openDetails();
      expect(screen.getByLabelText("Transcript file")).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Import transcript" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Transcribe locally" }),
      ).toBeDisabled();
      expect(productionApi.importTranscript).not.toHaveBeenCalled();
      expect(productionApi.transcribe).not.toHaveBeenCalled();
    },
  );

  it.each(["runtime", "model", "audio", "ffmpeg"])(
    "keeps import usable while transcription lacks %s",
    (scenario) => {
      const factory = readyFactory();
      if (scenario === "runtime") factory.data.system!.model_runtime = false;
      if (scenario === "model") factory.data.models = [];
      if (scenario === "ffmpeg") factory.data.system!.ffmpeg = false;
      render(
        <SourceTranscript
          source={
            scenario === "audio" ? { ...source, has_audio: false } : source
          }
          factory={factory}
          run={runTask()}
        />,
      );
      openDetails();
      fireEvent.change(screen.getByLabelText("Timed transcript"), {
        target: { value: srt },
      });
      expect(
        screen.getByRole("button", { name: "Import transcript" }),
      ).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Transcribe locally" }),
      ).toBeDisabled();
    },
  );

  it("does not offer native transcript operations in preview mode", () => {
    mode.preview = true;
    render(
      <SourceTranscript
        source={source}
        factory={readyFactory()}
        run={runTask()}
      />,
    );
    openDetails();
    expect(
      screen.getByText(/does not inspect files or generate a transcript/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Transcript file")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Transcribe locally" }),
    ).not.toBeInTheDocument();
    expect(productionApi.importTranscript).not.toHaveBeenCalled();
    expect(productionApi.transcribe).not.toHaveBeenCalled();
  });

  it("does not submit the same import twice while its first request is pending", async () => {
    let finish!: () => void;
    vi.mocked(productionApi.importTranscript).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(source);
        }),
    );
    render(
      <SourceTranscript
        source={source}
        factory={readyFactory()}
        run={runTask()}
      />,
    );
    openDetails();
    fireEvent.change(screen.getByLabelText("Timed transcript"), {
      target: { value: srt },
    });
    const button = screen.getByRole("button", { name: "Import transcript" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(productionApi.importTranscript).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Import transcript" }),
      ).toBeEnabled(),
    );
  });
});
