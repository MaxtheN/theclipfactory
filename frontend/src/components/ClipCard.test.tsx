import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clip, testState } from "../test-state";
import type { Clip } from "../types";
import { Clips } from "../pages/Clips";
import { ClipCard, selfCheck } from "./ClipCard";

afterEach(() => vi.unstubAllGlobals());
function mockFetch() {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);
const team = (status: Clip["team_review_status"], findings: unknown = []): Clip => ({
  ...clip,
  team_run_id: "r1",
  team_review_status: status,
  team_findings: findings,
});

describe("self-check wording", () => {
  it("says nothing for clips the factory did not review", () => {
    expect(selfCheck(clip).state).toBe("none");
    expect(selfCheck(team("not_applicable")).state).toBe("none");
  });
  it("counts flagged issues and treats missing verdicts as unavailable", () => {
    expect(selfCheck(team("pass")).label).toBe("Self-check passed");
    expect(selfCheck(team("fail", [{ message: "A" }, { message: "B" }, { other: 1 }, null])).label).toBe(
      "Self-check flagged 2 issues",
    );
    expect(selfCheck(team("fail", [{ message: "Only one" }])).label).toBe("Self-check flagged 1 issue");
    expect(selfCheck(team("fail", "not a list")).label).toBe("Self-check flagged issues");
    expect(selfCheck(team("unknown")).label).toBe("Self-check unavailable");
    expect(selfCheck(team(undefined)).state).toBe("unavailable");
    expect(selfCheck(team(null)).state).toBe("unavailable");
  });
});

describe("compact clip card", () => {
  it("approves a plain clip with approval only and offers the download", async () => {
    const fetch = mockFetch();
    render(<ClipCard state={testState()} clip={{ ...clip, reason: "The crowd reacts to the winning point." }} />);
    expect(screen.getByText("The crowd reacts to the winning point.")).toBeInTheDocument();
    expect(screen.queryByText(/Self-check/)).not.toBeInTheDocument();
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText("0:10")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(fetch.mock.calls[0][0]).toBe("/api/clips/c1");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "PUT" });
    expect(bodyOf(fetch.mock.calls[0])).toEqual({ approved: true });
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/api/clips/c1/download",
    );
  });
  it("falls back to the moment summary for the reason line", () => {
    render(<ClipCard state={testState()} clip={{ ...clip, reason: " ", moment_summary: "A long rally." }} />);
    expect(screen.getByText("A long rally.")).toBeInTheDocument();
    expect(screen.getByText("Why this moment")).toBeInTheDocument();
  });
  it("approves a passed self-check without an override", async () => {
    const fetch = mockFetch();
    render(<ClipCard state={testState()} clip={team("pass")} />);
    expect(screen.getByText("Self-check passed")).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(bodyOf(fetch.mock.calls[0])).toEqual({ approved: true });
  });
  it.each([
    ["fail", "Self-check flagged 2 issues"],
    ["unknown", "Self-check unavailable"],
  ] as const)("shows findings for %s and sends an explicit override", async (status, label) => {
    const fetch = mockFetch();
    render(
      <ClipCard
        state={testState()}
        clip={team(status, [
          { message: "The caption names a score that is never shown.", severity: "error" },
          { message: "<img src=x onerror=alert(1)>" },
        ])}
      />,
    );
    expect(screen.getByText(label)).toBeInTheDocument();
    const note = screen.getByRole("note");
    expect(within(note).getByText("The caption names a score that is never shown.")).toBeInTheDocument();
    expect(within(note).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(note.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve anyway" }));
    expect(bodyOf(fetch.mock.calls[0])).toEqual({ approved: true, acknowledge_findings: true });
  });
  it("explains an unavailable self-check that reported nothing", () => {
    render(<ClipCard state={testState()} clip={team("unknown")} />);
    expect(screen.getByRole("note")).toHaveTextContent("could not finish");
  });
  it("saves edited words first and only then allows approval", async () => {
    const fetch = mockFetch();
    render(<ClipCard state={testState()} clip={team("pass")} />);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Caption"));
    await userEvent.type(screen.getByLabelText("Caption"), "New caption");
    await userEvent.clear(screen.getByLabelText("Hook"));
    await userEvent.type(screen.getByLabelText("Hook"), "New hook");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByText("Save your changes before approving.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetch.mock.calls[0])).toEqual({ hook: "New hook", caption: "New caption" });
  });
  it("keeps a burned-in hook read-only and never sends it", async () => {
    const fetch = mockFetch();
    render(<ClipCard state={testState()} clip={{ ...clip, hook_rendered: true }} />);
    expect(screen.queryByLabelText("Hook")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hook" })).toBeInTheDocument();
    expect(screen.getByText(/burned into the video/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Caption"), " edited");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(bodyOf(fetch.mock.calls[0])).toEqual({ caption: "Caption edited" });
  });
  it("undoes approval and notes an approval given over open issues", async () => {
    const fetch = mockFetch();
    render(
      <ClipCard
        state={testState()}
        clip={{
          ...team("fail", [{ message: "Unsupported claim" }]),
          approved: true,
          approval_override: { at: "2026-11-14T00:00:00Z", review_status: "fail" },
        }}
      />,
    );
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Approved with open self-check issues.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Approve/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo approval" }));
    expect(bodyOf(fetch.mock.calls[0])).toEqual({ approved: false });
  });
  it("discards only after confirmation", async () => {
    const fetch = mockFetch();
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    render(<ClipCard state={testState()} clip={clip} />);
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(fetch.mock.calls[0][0]).toBe("/api/clips/c1");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
  });
  it("locks the actions while this clip has running work", () => {
    const state = testState();
    state.data.jobs = [
      { id: "j1", kind: "team_review", status: "running", context: { clip_id: "c1" } },
    ];
    render(<ClipCard state={state} clip={team("pass")} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });
  it("keeps the extras behind More: recheck, checks, cover and rating", async () => {
    const fetch = mockFetch();
    const state = testState();
    state.data.videos = [{ id: "v1", name: "Match day" }];
    render(
      <ClipCard
        state={state}
        clip={{
          ...team("fail", [{ message: "Unsupported claim" }]),
          technical_checks: {
            playback_format: [
              { id: "decode", label: "Full decode", status: "pass", detail: "Fine" },
              { id: "audio", label: "AAC source audio", status: "not_applicable", detail: "" },
            ],
            captions: [{ id: "length", label: "Caption length", status: "warn", detail: "2 long cues" }],
          },
        } as Clip}
      />,
    );
    const more = screen.getByText("More").closest("details")!;
    expect(more).not.toHaveAttribute("open");
    expect(within(more).getByText(/From Match day/)).toBeInTheDocument();
    expect(within(more).getByText("Full decode")).toBeInTheDocument();
    expect(within(more).getByText("Check: 2 long cues")).toBeInTheDocument();
    expect(within(more).queryByText("AAC source audio")).not.toBeInTheDocument();
    expect(within(more).getByRole("link", { name: "Download cover", hidden: true })).toHaveAttribute(
      "href",
      "/api/clips/c1/cover/download",
    );
    more.open = true;
    await userEvent.click(within(more).getByRole("button", { name: "Run the self-check again" }));
    expect(fetch.mock.calls[0][0]).toBe("/api/clips/c1/team-review");
    await userEvent.selectOptions(within(more).getByLabelText("Rating"), "5");
    await userEvent.type(within(more).getByLabelText("What worked or did not"), "Great pace");
    await userEvent.click(within(more).getByRole("button", { name: "Save rating" }));
    expect(fetch.mock.calls[1][0]).toBe("/api/clips/c1/feedback");
    expect(bodyOf(fetch.mock.calls[1])).toEqual({ rating: 5, notes: "Great pace" });
  });
  it("offers no recheck for clips without a self-check", () => {
    render(<ClipCard state={testState()} clip={clip} />);
    expect(
      screen.queryByRole("button", { name: "Run the self-check again", hidden: true }),
    ).not.toBeInTheDocument();
  });
});

describe("clips page", () => {
  const clips: Clip[] = [
    { ...clip, id: "a", hook: "Waiting one", created_at: "2026-11-14T00:00:01Z" },
    { ...clip, id: "b", hook: "Approved one", approved: true, created_at: "2026-11-14T00:00:02Z" },
    { ...clip, id: "c", hook: "Waiting two", video_id: "v2", created_at: "2026-11-14T00:00:03Z" },
  ];
  const names = () =>
    screen.getAllByRole("article", { name: /^Clip: / }).map((tile) => tile.getAttribute("aria-label"));
  it("opens on clips that need review, newest first, and filters with chips", async () => {
    const state = testState();
    state.data.clips = clips;
    render(<Clips state={state} navigate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Needs review 2" })).toHaveAttribute("aria-pressed", "true");
    expect(names()).toEqual(["Clip: Waiting two", "Clip: Waiting one"]);
    await userEvent.click(screen.getByRole("button", { name: "Approved 1" }));
    expect(names()).toEqual(["Clip: Approved one"]);
    await userEvent.click(screen.getByRole("button", { name: "All 3" }));
    expect(names()).toHaveLength(3);
  });
  it("filters by video when clips come from several", async () => {
    const state = testState();
    state.data.clips = clips;
    state.data.videos = [
      { id: "v1", name: "Match day" },
      { id: "v2", name: "Interview" },
      { id: "v3", name: "Unused" },
    ];
    render(<Clips state={state} navigate={vi.fn()} />);
    const select = screen.getByLabelText("Filter by video");
    expect(within(select).queryByRole("option", { name: "Unused" })).not.toBeInTheDocument();
    await userEvent.selectOptions(select, "v2");
    expect(names()).toEqual(["Clip: Waiting two"]);
    expect(screen.getByRole("button", { name: "Approved 0" })).toBeInTheDocument();
  });
  it("says so when nothing is waiting", async () => {
    const state = testState();
    state.data.clips = [clips[1]];
    render(<Clips state={state} navigate={vi.fn()} />);
    expect(screen.getByText("Nothing is waiting for review.")).toBeInTheDocument();
  });
  it("points to the factory when there are no clips, without assuming an empty library on errors", async () => {
    const navigate = vi.fn();
    const view = render(<Clips state={testState()} navigate={navigate} />);
    expect(screen.getByText("No clips yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Go to Factory" }));
    expect(navigate).toHaveBeenCalledWith("Factory");
    view.unmount();
    render(<Clips state={testState({ errors: { clips: "Offline" } })} navigate={navigate} />);
    expect(screen.getByText("Clips are unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No clips yet")).not.toBeInTheDocument();
  });
});
