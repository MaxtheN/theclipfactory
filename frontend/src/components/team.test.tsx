import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamLedger } from "./TeamLedger";
import { TeamComparisons } from "./TeamComparisons";
import { StructuredData } from "./StructuredData";
import { ClipReview } from "./ClipReview";
import { clip, settings, testState } from "../test-state";
import type { TeamRun } from "../types";
const source = { id: "v1", name: "Source", duration: 60 };
const run: TeamRun = {
  id: "r1",
  video_id: "v1",
  mode: "team",
  status: "running",
  model_id: "qwen-small",
  objective: "discovery",
  job_id: "j1",
  revision_budget: 2,
  revision_count: 1,
  stop_reason: null,
  created_at: "2026-11-14T00:00:00Z",
  started_at: null,
  finished_at: null,
  elapsed_seconds: null,
  resource_observations: { memory_gb: null },
  clip_ids: [],
  plan: { summary: "Inspect source" },
  context: {
    source: { id: "v1", hash: "source-hash" },
    settings: { objective: "discovery" },
  },
  permissions: { publish: false, ads: false },
  tasks: [
    {
      id: "t1",
      role: "critic",
      label: "Review evidence",
      kind: "agent",
      status: "completed",
      iteration: 1,
      input_refs: ["source:v1"],
      started_at: null,
      finished_at: null,
      error: null,
      output: {
        verdict: "unknown",
        checks: {
          context: "pass",
          claims: "unknown",
          captions: "fail",
          duplicates: "pass",
        },
        findings: [
          {
            message: "<img src=x onerror=alert(1)>",
            evidence_refs: ["source:v1"],
          },
        ],
      },
    },
  ],
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function readyState() {
  const state = testState();
  state.data.videos = [source];
  state.data.system = { model_runtime: true };
  state.data.models = [{ id: "qwen-small", name: "Qwen", installed: true }];
  return state;
}
describe("team production contract", () => {
  it.each(["fail", "unknown", undefined] as const)(
    "blocks approval for unresolved team status %s",
    (status) => {
      render(
        <ClipReview
          state={testState()}
          clip={{
            ...clip,
            team_run_id: "r1",
            team_review_status: status,
            team_findings: [{ message: "Unsupported claim" }],
          }}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Approve clip" }),
      ).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent("Unresolved critic");
    },
  );
  it("permits human approval after critic pass and removal even after failed review", () => {
    const view = render(
      <ClipReview
        state={testState()}
        clip={{ ...clip, team_run_id: "r1", team_review_status: "pass" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Approve clip" })).toBeEnabled();
    view.rerender(
      <ClipReview
        state={testState()}
        clip={{
          ...clip,
          approved: true,
          team_run_id: "r1",
          team_review_status: "fail",
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Remove approval" }),
    ).toBeEnabled();
  });
});
describe("safe ledger and cancellation", () => {
  it("renders nested model artifacts as text, never executable markup or hidden reasoning", () => {
    const { container } = render(
      <StructuredData
        value={{
          nested: [
            {
              html: "<script>alert(1)</script><img src=x>",
              unknown_metric: null,
            },
          ],
          hidden_reasoning: "private trace",
        }}
      />,
    );
    expect(
      screen.getByText("<script>alert(1)</script><img src=x>"),
    ).toBeInTheDocument();
    expect(container.querySelector("script,img")).toBeNull();
    expect(screen.queryByText("private trace")).not.toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
  it("shows tasks, unresolved checks, timings and revision history; filters and selects runs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json([
          run,
          {
            ...run,
            id: "r2",
            video_id: "v2",
            mode: "baseline",
            status: "needs_review",
            tasks: [],
          },
        ]),
      ),
    );
    const { container } = render(
      <TeamLedger
        videos={[source, { id: "v2", name: "Other" }]}
        sourceId="v1"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    await screen.findByText("Review evidence");
    expect(
      screen.getByText("<img src=x onerror=alert(1)>"),
    ).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/Revisions: 1 \/ 2/)).toBeInTheDocument();
    expect(screen.getByText("claims")).toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByLabelText("Ledger source filter"),
      "",
    );
    await userEvent.selectOptions(screen.getByLabelText("Ledger run"), "r2");
    expect(screen.getByText("baseline run")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeDisabled();
  });
  it("locks duplicate cancellation while requesting and after acceptance without claiming immediate cancellation", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn((path: string) =>
      path.endsWith("/cancel")
        ? new Promise<Response>((r) => {
            resolve = r;
          })
        : Promise.resolve(json([run])),
    );
    vi.stubGlobal("fetch", fetch);
    render(<TeamLedger videos={[source]} />);
    const cancel = await screen.findByRole("button", { name: "Cancel run" });
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    expect(
      fetch.mock.calls.filter(([path]) => path.endsWith("/cancel")),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Requesting cancellation…" }),
    ).toBeDisabled();
    await act(async () => resolve(json(run)));
    expect(
      screen.getByRole("button", { name: "Cancellation requested" }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Active work may finish",
    );
    expect(
      screen.getByText("running", { selector: ".badge" }),
    ).toBeInTheDocument();
  });
  it("polls every four seconds, marks retained data stale and disables cancellation on missing routes", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json([run]))
      .mockResolvedValue(json({ detail: "Not found" }, 404));
    vi.stubGlobal("fetch", fetch);
    const view = render(<TeamLedger videos={[source]} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Review evidence")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("stale");
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeDisabled();
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("handles missing routes and empty ledgers without inventing runs", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValue(json([]));
    vi.stubGlobal("fetch", fetch);
    render(<TeamLedger videos={[]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "route unavailable",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Reload ledger" }),
    );
    expect(
      await screen.findByText("No runs reported for this source."),
    ).toBeInTheDocument();
  });
});
describe("honest comparisons", () => {
  it("loads explicitly, renders every run and source snapshot, unknown metrics, mismatch warnings and stale results", async () => {
    let missing = false;
    const fetch = vi.fn(async (path: string) =>
      path.startsWith("/api/team/comparisons")
        ? missing
          ? json({}, 404)
          : json({
              video_id: "v1",
              runs: [
                {
                  ...run,
                  comparable: false,
                  feedback: [{ notes: "Creator says: <b>needs context</b>" }],
                  outcomes: { views: null },
                  resource_observations: {
                    model: { loaded: "qwen-small" },
                    memory: null,
                  },
                },
                {
                  ...run,
                  id: "r2",
                  mode: "baseline",
                  comparable: null,
                  feedback: [],
                  outcomes: null,
                },
              ],
              notes: ["Snapshots differ; no causal inference."],
            })
        : json({ ...run, id: path.split("/").pop() }),
    );
    vi.stubGlobal("fetch", fetch);
    const { container } = render(<TeamComparisons videoId="v1" />);
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Load comparisons" }),
    );
    await screen.findByText(/Comparable: No/);
    expect(screen.getByText(/Comparable: Unknown/)).toBeInTheDocument();
    expect(screen.getAllByText("source-hash")).toHaveLength(2);
    expect(
      screen.getByText("Creator says: <b>needs context</b>"),
    ).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("views").nextElementSibling).toHaveTextContent(
      "Unknown",
    );
    expect(fetch.mock.calls[0][0]).toBe("/api/team/comparisons?video_id=v1");
    missing = true;
    await userEvent.click(
      screen.getByRole("button", { name: "Load comparisons" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("stale"),
    );
    expect(screen.getAllByText("source-hash")).toHaveLength(2);
  });
  it("reports missing per-run snapshots without dropping comparison observations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path.includes("comparisons")
          ? json({
              video_id: "v1",
              runs: [
                { ...run, comparable: true, feedback: [], outcomes: null },
              ],
              notes: [],
            })
          : json({}, 404),
      ),
    );
    render(<TeamComparisons videoId="v1" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Load comparisons" }),
    );
    expect(
      await screen.findByText(/Snapshot unavailable:/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Comparable: Yes/)).toBeInTheDocument();
  });
});
