import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testState } from "../test-state";
import { Narration, narrationDownloadUrl } from "./Narration";
import type { FactoryState } from "../useFactory";
function readyState(): FactoryState {
  const state = testState();
  state.data.system = { model_runtime: true };
  state.data.models = [
    { id: "qwen-small", name: "Qwen", installed: true },
    { id: "kokoro", name: "Kokoro", installed: true },
  ];
  return state;
}
function fetchMock() {
  const fetch = vi.fn(async (_path: string) => new Response(JSON.stringify({ id: "job1" })));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());
describe("narration", () => {
  it("submits Kokoro text and shows completed same-origin audio/download", async () => {
    const fetch = fetchMock();
    const user = userEvent.setup();
    const state = readyState();
    state.data.jobs = [
      {
        id: "n1",
        kind: "narration",
        status: "completed",
        result: { download_url: "/api/narrations/n1/download" },
      },
    ];
    render(<Narration state={state} />);
    await user.type(
      screen.getByLabelText("Narration text"),
      "A real voiceover.",
    );
    await user.click(
      screen.getByRole("button", { name: "Generate narration" }),
    );
    expect(fetch.mock.calls[0][0]).toBe("/api/narrations");
    expect(
      JSON.parse(
        (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
          .body as string,
      ),
    ).toEqual({ text: "A real voiceover." });
    expect(screen.getByLabelText("Narration playback")).toHaveAttribute(
      "src",
      "/api/narrations/n1/download",
    );
    expect(
      screen.getByRole("link", { name: "Download narration" }),
    ).toHaveAttribute("href", "/api/narrations/n1/download");
  });
  it.each([
    "https://evil.example/api/narrations/n1/download",
    "//evil.example/x",
    "/api/narrations/../clips/c1/download",
    "/api/narrations/%2e%2e/download",
    "/api/narrations/n1/download?token=private",
    null,
  ])("refuses unsafe narration media %s", (url) =>
    expect(narrationDownloadUrl(url)).toBeNull(),
  );
  it("shows narration failures, rejects unsafe completed results, and gates missing Kokoro", () => {
    const state = readyState();
    state.data.models = [];
    state.data.jobs = [
      {
        id: "n1",
        kind: "narration",
        status: "failed",
        error: "Kokoro runtime failed",
      },
      {
        id: "n2",
        kind: "narration",
        status: "completed",
        result: { download_url: "https://external.example/a.wav" },
      },
    ];
    render(<Narration state={state} />);
    expect(
      screen.getByRole("button", { name: "Generate narration" }),
    ).toBeDisabled();
    expect(screen.getByText("Kokoro runtime failed")).toBeInTheDocument();
    expect(screen.getByText(/without a valid same-origin/)).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Narration playback"),
    ).not.toBeInTheDocument();
  });
});
