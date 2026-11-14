import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clip, settings, testState } from "../test-state";
import { Instagram, isPublicHttps, publishingGate } from "./Instagram";
import { MetricGroup, Results } from "./Results";
import { Models } from "./Models";
import { Studio, getCandidates } from "./Studio";
import { Footage } from "./Footage";
import { SettingsPage, editableSettings } from "./Settings";
import { ClipReview } from "../components/ClipReview";
afterEach(() => vi.unstubAllGlobals());
const mockFetch = () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async (path: string) =>
        new Response(path === "/api/team/runs" ? "[]" : '{"id":"j1"}'),
    );
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
describe("publishing safety", () => {
  it("requires explicit approval, opt-in, verified account, and known capability", () => {
    expect(
      publishingGate(clip, settings, {
        connected: false,
        publishing_available: null,
      } as never),
    ).toHaveLength(4);
    expect(
      publishingGate(
        { ...clip, approved: true },
        { ...settings, publishing_enabled: true },
        { connected: true, publishing_available: true },
      ),
    ).toEqual([]);
    expect(
      publishingGate(
        { ...clip, approved: true },
        { ...settings, publishing_enabled: true },
        { connected: true, publishing_available: true },
        true,
      ),
    ).toHaveLength(1);
  });
  it.each([
    "http://example.com/a.mp4",
    "https://localhost/a.mp4",
    "https://127.0.0.1/a",
    "https://10.0.0.1/a",
    "https://192.168.1.1/a",
    "https://172.16.1.1/a",
    "https://[::1]/a",
    "https://user:secret@example.com/a",
    "not a url",
  ])("rejects local or unsafe asset %s", (url) =>
    expect(isPublicHttps(url)).toBe(false),
  );
  it("accepts public HTTPS assets", () =>
    expect(isPublicHttps("https://media.example.com/clip.mp4")).toBe(true));
  it("keeps publish disabled when gates are unknown", () => {
    const state = testState();
    state.data.clips = [clip];
    render(<Instagram state={state} />);
    expect(
      screen.getByRole("button", { name: "Queue Instagram publish" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Publishing capability is unavailable or unknown."),
    ).toBeInTheDocument();
  });
  it("clears access token on submission and never persists it", async () => {
    const fetch = mockFetch();
    const user = userEvent.setup();
    const state = testState();
    render(<Instagram state={state} />);
    await user.type(
      screen.getByLabelText("Meta access token"),
      "private-test-token",
    );
    await user.click(screen.getByRole("button", { name: "Inspect & connect" }));
    expect(screen.getByLabelText("Meta access token")).toHaveValue("");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      access_token: "private-test-token",
    });
    expect(JSON.stringify(localStorage)).not.toContain("private-test-token");
  });
});
describe("analytics provenance", () => {
  it("keeps null and absent metrics unknown, but real zero visible", () => {
    render(
      <MetricGroup
        title="Organic"
        metrics={{ reach: null, views: 0, likes: undefined }}
      />,
    );
    expect(screen.getAllByText("Unknown")).toHaveLength(2);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
  it("has an honest empty state without sample metrics", () => {
    render(<Results state={testState()} />);
    expect(
      screen.getByText("No performance observations yet"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Unknown is not zero/)).toBeInTheDocument();
  });
  it("sends explicit manual provenance and omits blank values", async () => {
    const fetch = mockFetch();
    const user = userEvent.setup();
    const state = testState();
    state.data.clips = [clip];
    render(<Results state={state} />);
    await user.selectOptions(screen.getByLabelText("Observed clip"), "c1");
    await user.click(
      screen.getByRole("button", { name: "Record manual event" }),
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      clip_id: "c1",
      event: "visit",
      source: "manual",
    });
  });
});
describe("local production controls", () => {
  it("requires per-model license consent before download", async () => {
    const fetch = mockFetch();
    const user = userEvent.setup();
    const state = testState();
    state.data.models = [
      {
        id: "qwen-small",
        name: "Qwen",
        installed: false,
        license: "Apache-2.0",
        estimated_gb: 4,
      },
    ];
    render(<Models state={state} />);
    expect(
      screen.getByRole("button", { name: "Install model" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Install model" }));
    expect(fetch.mock.calls[0][0]).toBe("/api/models/qwen-small/download");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      accept_license: true,
    });
  });
  it("renders a manual selection with exact render fields without an installed model", async () => {
    const fetch = mockFetch();
    const user = userEvent.setup();
    const state = testState();
    state.data.videos = [{ id: "v1", name: "Source", duration: 60 }];
    render(<Studio state={state} />);
    expect(
      screen.getByRole("button", { name: "Analyze video" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: /Queue subtitled render/ }),
    );
    const renderCall = fetch.mock.calls.find(
      ([path]) => path === "/api/videos/v1/render",
    )!;
    expect(renderCall[0]).toBe("/api/videos/v1/render");
    expect(JSON.parse(renderCall[1].body)).toEqual({
      start: 0,
      end: 30,
      hook: "",
      caption: "",
      objective: "discovery",
      subtitles: true,
      format: "vertical",
    });
  });
  it("validates ranges and guards malformed model candidates", async () => {
    expect(
      getCandidates({
        candidates: [
          null,
          { start: 5, end: 2 },
          { start: 0, end: 8, hook: { bad: "field" } },
        ],
      }),
    ).toEqual([
      {
        start: 0,
        end: 8,
        hook: "",
        caption: "",
        reason: "",
        objective: "discovery",
      },
    ]);
    const fetch = mockFetch();
    const user = userEvent.setup();
    const state = testState();
    state.data.videos = [{ id: "v1", name: "Source", duration: 60 }];
    render(<Studio state={state} />);
    await user.clear(screen.getByLabelText("Start (seconds)"));
    await user.type(screen.getByLabelText("Start (seconds)"), "35");
    await user.click(
      screen.getByRole("button", { name: /Queue subtitled render/ }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid range");
    expect(fetch.mock.calls.every(([path]) => path === "/api/team/runs")).toBe(
      true,
    );
  });
  it.each(["queued", "running"])("blocks manual rendering while this source has a %s job", (status) => {
    mockFetch();
    const state = testState();
    state.data.videos = [{ id: "v1", name: "Source", duration: 60 }];
    state.data.jobs = [{ id: "active", kind: "team", status, context: { video_id: "v1" } }];
    render(<Studio state={state} />);
    expect(screen.getByRole("button", { name: /Queue subtitled render/ })).toBeDisabled();
  });
  it("uploads multipart video files with the contract file field", async () => {
    const fetch = mockFetch();
    const user = userEvent.setup();
    render(<Footage state={testState()} onEdit={vi.fn()} />);
    await user.upload(
      screen.getByLabelText("Upload video files"),
      new File(["source bytes"], "source.mp4", { type: "video/mp4" }),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(fetch.mock.calls[0][0]).toBe("/api/videos");
    expect(fetch.mock.calls[0][1].body.get("file").name).toBe("source.mp4");
  });
  it("approves the clip with current caption edits and offers same-origin downloads", async () => {
    const fetch = mockFetch();
    const user = userEvent.setup();
    render(<ClipReview state={testState()} clip={clip} />);
    await user.clear(screen.getByLabelText("Clip caption"));
    await user.type(screen.getByLabelText("Clip caption"), "New caption");
    await user.click(screen.getByRole("button", { name: "Approve clip" }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      hook: "Hook",
      caption: "New caption",
      approved: true,
    });
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/api/clips/c1/download",
    );
  });
  it("does not save unknown read-only capability fields as settings", () => {
    expect(
      editableSettings({ ...settings, unexpected_capability: true } as never),
    ).not.toHaveProperty("unexpected_capability");
    const state = testState();
    state.data.settings = null;
    render(<SettingsPage state={state} />);
    expect(
      screen.queryByRole("button", { name: "Save studio settings" }),
    ).not.toBeInTheDocument();
  });
});
