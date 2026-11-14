import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FactoryUpgrades } from "./FactoryUpgrades";
import {
  builderStatus,
  factoryBuilderApi,
  type CapabilityRequest,
  type FactoryBuild,
  type FactoryBuilderView,
} from "./factoryBuilderApi";
import { deriveFactoryMap } from "./flowEvents";

const request = (over: Partial<CapabilityRequest> = {}): CapabilityRequest => ({
  id: "cap_progress_bar",
  capability: "progress_bar",
  label: "Progress bar",
  evidence: [{ source: "reference_observation", id: "rr_1:o1", quote: "A thin progress bar fills along the top edge." }],
  demand_count: 1,
  status: "detected",
  demo: false,
  buildable: true,
  work_order: null,
  build_id: null,
  created_at: "2026-11-14T00:00:00Z",
  updated_at: "2026-11-14T00:00:00Z",
  ...over,
});

const build = (over: Partial<FactoryBuild> = {}): FactoryBuild => ({
  id: "fb_1",
  request_id: "cap_progress_bar",
  capability: "progress_bar",
  status: "ready_for_review",
  branch: "factory/upgrade-progress-bar-ab12",
  base_branch: "kartik/backend-integration",
  base_commit: "abc",
  commit: "def4567890",
  test_log: "3 passed",
  sample_path: "/data/work/factory/samples/fb_1/progress_bar.mp4",
  attempts: [{ n: 1, ok: true, steps: [{ name: "static", ok: true }, { name: "tests", ok: true }, { name: "render", ok: true }] }],
  model: { provider: "openrouter", model: "anthropic/claude-sonnet-5.5" },
  usage: { calls: 1, cost_usd: 0.0421, prompt_tokens: 9000, completion_tokens: 2000 },
  error: null,
  demo: true,
  created_at: "2026-11-14T00:00:00Z",
  updated_at: "2026-11-14T00:00:00Z",
  ...over,
});

const view = (requests: CapabilityRequest[] = [], builds: FactoryBuild[] = []): FactoryBuilderView => {
  const count = (s: string) => requests.filter((r) => r.status === s).length;
  return {
    requests,
    builds,
    can_build: true,
    repo: { branch: "kartik/backend-integration", push_remote: "origin", push_repo: "o/r", origin_repo: "o/r" },
    gh: { available: true, authenticated: true, reason: null },
    summary: {
      total: requests.length,
      ideas: count("detected") + count("work_order"),
      building: count("building"),
      ready_for_review: count("ready_for_review"),
      merged: count("merged"),
      by_status: {} as FactoryBuilderView["summary"]["by_status"],
    },
  };
};

afterEach(() => vi.restoreAllMocks());

describe("FactoryUpgrades", () => {
  it("shows an honest empty state and a clearly labelled demo trigger", async () => {
    vi.spyOn(factoryBuilderApi, "view").mockResolvedValue(view());
    const demo = vi.spyOn(factoryBuilderApi, "demo").mockResolvedValue(view());
    render(<FactoryUpgrades />);
    expect(await screen.findByText(/No upgrade ideas yet/)).toBeTruthy();
    expect(screen.getByText(/labelled “demo”, not real demand/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try with a demo request" }));
    await waitFor(() => expect(demo).toHaveBeenCalledTimes(1));
  });

  it("lists requests with evidence chips and builds only on an explicit click", async () => {
    vi.spyOn(factoryBuilderApi, "view").mockResolvedValue(view([request()]));
    const start = vi.spyOn(factoryBuilderApi, "build").mockResolvedValue(build({ status: "building" }));
    const push = vi.spyOn(factoryBuilderApi, "push");
    render(<FactoryUpgrades />);
    expect(await screen.findByText("Progress bar")).toBeTruthy();
    expect(screen.getByText("Reference")).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Progress bar/ }));
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("cap_progress_bar"));
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the review: checks, sample render, exact commands, and push only on click", async () => {
    const ready = request({ status: "ready_for_review", build_id: "fb_1", demo: true });
    vi.spyOn(factoryBuilderApi, "view").mockResolvedValue(view([ready], [build()]));
    vi.spyOn(factoryBuilderApi, "detail").mockResolvedValue(build({ diff: "+CAPABILITY = \"progress_bar\"" }));
    vi.spyOn(factoryBuilderApi, "prPlan").mockResolvedValue({
      remote: "origin", repo: "o/r", base: "kartik/backend-integration", head: "factory/upgrade-progress-bar-ab12",
      commands: ["git push origin factory/upgrade-progress-bar-ab12", "gh pr create --draft --base kartik/backend-integration"],
      blocked: null, gh: { authenticated: true, reason: null },
    });
    const push = vi.spyOn(factoryBuilderApi, "push").mockResolvedValue(build({ pr_url: "https://github.com/o/r/pull/1" }));
    render(<FactoryUpgrades />);
    fireEvent.click(await screen.findByRole("button", { name: /Progress bar/ }));
    expect(screen.getByText("Demo")).toBeTruthy();
    expect(screen.getByLabelText("Sample render with the new extension")).toBeTruthy();
    expect(await screen.findByLabelText("Exact commands")).toBeTruthy();
    expect(screen.getByText(/\$0\.0421/)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Push & open draft PR" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("fb_1"));
  });

  it("disables push when the plan is blocked", async () => {
    const ready = request({ status: "ready_for_review", build_id: "fb_1" });
    vi.spyOn(factoryBuilderApi, "view").mockResolvedValue(view([ready], [build({ base_branch: "main" })]));
    vi.spyOn(factoryBuilderApi, "detail").mockResolvedValue(build());
    vi.spyOn(factoryBuilderApi, "prPlan").mockResolvedValue({
      remote: "origin", repo: "o/r", base: "main", head: "h", commands: [],
      blocked: "Pull requests never target main.", gh: { authenticated: true, reason: null },
    });
    render(<FactoryUpgrades />);
    fireEvent.click(await screen.findByRole("button", { name: /Progress bar/ }));
    expect(await screen.findByText("Pull requests never target main.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Push & open draft PR" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Factory builder station", () => {
  it("summarises ideas, builds and reviews in one line", () => {
    const v = view([
      request(),
      request({ id: "cap_lower", label: "Lower third", status: "work_order" }),
      request({ id: "cap_zoom", label: "Zoom", status: "building" }),
      request({ id: "cap_box", label: "Box", status: "ready_for_review" }),
    ]);
    expect(builderStatus(v)).toMatchObject({
      state: "active",
      status: "2 upgrade ideas · 1 building · 1 ready for review",
    });
    expect(builderStatus(view()).status).toBe("No upgrade ideas yet");
    expect(builderStatus(null).status).toBe("Unavailable right now");
    const model = deriveFactoryMap({
      sources: [], jobs: [], clips: [], runs: [], campaign: null, versions: [], automation: null,
      strategist: null, builder: v, now: Date.now(),
    });
    const station = model.stations.find((s) => s.id === "builder")!;
    expect(station.family).toBe("learn");
    expect(station.status).toBe("2 upgrade ideas · 1 building · 1 ready for review");
    expect(station.sheet[0].rows).toHaveLength(4);
  });
});
