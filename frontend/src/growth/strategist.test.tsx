import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { StrategistPanel } from "./StrategistPanel";
import { BeliefCard } from "./BeliefLedger";
import {
  strategistApi,
  validSimulation,
  validView,
  type Belief,
  type Simulation,
  type StrategistView,
} from "./strategistApi";

const belief = (overrides: Partial<Belief> = {}): Belief => ({
  id: "belief_a",
  profile_id: "p",
  layer: "craft",
  statement: "Posts with question hooks tend to beat this account's median views.",
  variable: "hook_style",
  value: "question",
  direction: "increase",
  metric: "views",
  confidence: 0.94,
  uncertainty: 0.4,
  status: "supported",
  evidence: [
    {
      publication_id: "publication_abc123",
      snapshot_id: "snap1",
      clip_id: "c1",
      metric: "views",
      value: 300,
      baseline: 200,
      ratio: 1.5,
      outcome: "supports",
    },
  ],
  counts: { matching: 4, beats: 4, misses: 0, ties: 0, prospective: 2 },
  effect: { shrunken_log_ratio: 0.3, typical_ratio: 1.35 },
  origin: "pattern_scan",
  rationale: "",
  created_at: "2026-11-01T00:00:00+00:00",
  updated_at: "2026-11-02T00:00:00+00:00",
  ...overrides,
});

const view = (overrides: Partial<StrategistView> = {}): StrategistView => ({
  profile_id: "p",
  target_metric: "views",
  baseline: { statistic: "median", posts: 6, metrics: { views: 200 } },
  beliefs: [
    belief(),
    belief({
      id: "belief_b",
      layer: "selection",
      statement: "Story moments tend to beat the median.",
      status: "testing",
      confidence: 0.6,
    }),
  ],
  portfolio: {
    seed: "p:1",
    exploit: 3,
    explore: 1,
    slots: [
      ...[1, 2, 3].map((slot) => ({
        slot,
        mode: "exploit" as const,
        belief_id: "belief_a",
        layer: "craft" as const,
        variable: "hook_style",
        value: "question",
        direction: "increase" as const,
        rationale: "Apply",
        score: 0.4,
      })),
      {
        slot: 4,
        mode: "explore" as const,
        belief_id: "belief_b",
        layer: "selection" as const,
        variable: "moment_type",
        value: "story",
        direction: "increase" as const,
        rationale: "Test",
        score: 0.8,
      },
    ],
  },
  pending_proposals: {
    style_rules: [{ id: "v2", campaign_id: "c", version: 2, layer: "craft" }],
    campaign: [],
  },
  runs: [
    {
      id: "r1",
      status: "completed",
      trigger: "manual",
      layers: ["craft"],
      progress: 100,
      message: "Done",
      model: {
        status: "held",
        reasons: ["Learning is paused: about 6.0 GiB available memory is required."],
      },
      proposals: [],
      created_at: "2026-11-02T00:00:00+00:00",
      finished_at: "2026-11-02T00:00:01+00:00",
    },
  ],
  measured_posts: 6,
  due_layers: [],
  caveat: "Observational, not causal.",
  simulated: false,
  ...overrides,
});

const simulation = (): Simulation => ({
  simulated: true,
  banner: "Simulation — synthetic data illustrating how the strategist reasons",
  seed: 7,
  caveat: "Observational.",
  steps: [1, 2, 3].map((step) => ({
    step,
    simulated: true as const,
    post: { id: `sim-post-${step}`, tags: { hook_style: "question" }, views: 900 + step },
    baseline_views: 1000,
    layers_run: ["craft"],
    beliefs: [
      {
        id: "sim-belief",
        layer: "craft" as const,
        statement: `Synthetic belief at step ${step}.`,
        variable: "hook_style",
        value: "question",
        direction: "increase" as const,
        confidence: 0.5 + step / 10,
        status: "testing" as const,
        matching: step,
      },
    ],
    portfolio: null,
    new_proposals: [],
  })),
});

function stubMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: reduce, addEventListener: vi.fn() }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("strategist contract guards", () => {
  it("rejects unlabelled or out-of-range answers", () => {
    expect(validView(view())).toBe(true);
    expect(validView({ ...view(), simulated: true })).toBe(false);
    expect(validView(view({ beliefs: [belief({ confidence: 3 })] }))).toBe(false);
    expect(validSimulation(simulation())).toBe(true);
    expect(validSimulation({ ...simulation(), simulated: false })).toBe(false);
  });
});

describe("StrategistPanel", () => {
  it("shows three lanes, belief cards, evidence chips, queue and held state", async () => {
    stubMotion(false);
    vi.spyOn(strategistApi, "view").mockResolvedValue(view());
    const open = vi.fn();
    render(<StrategistPanel profileId="p" onOpenStyleRules={open} />);
    expect(await screen.findByText(/question hooks tend to beat/)).toBeTruthy();
    for (const lane of ["Craft", "Selection", "Campaign"])
      expect(screen.getByRole("region", { name: `${lane} beliefs` })).toBeTruthy();
    const craft = screen.getByRole("region", { name: "Craft beliefs" });
    expect(within(craft).getByText("Supported")).toBeTruthy();
    expect(within(craft).getByText("views 1.50× median")).toBeTruthy();
    expect(within(craft).getByRole("meter").getAttribute("aria-valuenow")).toBe("94");
    expect(screen.getByText(/Model held: insufficient memory/)).toBeTruthy();
    const queue = screen.getByRole("list", { name: "Next experiment batch" });
    expect(within(queue).getAllByText("Apply")).toHaveLength(3);
    expect(within(queue).getAllByText("Explore")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Review in Style rules" }));
    expect(open).toHaveBeenCalled();
    expect(screen.queryByText(/Simulation — synthetic/)).toBeNull();
  });

  it("runs the strategist and reports progress while queued", async () => {
    stubMotion(false);
    const queued = view({
      runs: [{ ...view().runs[0], id: "r2", status: "running", progress: 30, message: "Scoring beliefs" }],
    });
    const viewSpy = vi
      .spyOn(strategistApi, "view")
      .mockResolvedValueOnce(view())
      .mockResolvedValue(queued);
    const runSpy = vi.spyOn(strategistApi, "run").mockResolvedValue(queued.runs[0]);
    render(<StrategistPanel profileId="p" />);
    fireEvent.click(await screen.findByRole("button", { name: "Run strategist" }));
    expect(await screen.findByText("Scoring beliefs (30%)")).toBeTruthy();
    expect(runSpy).toHaveBeenCalledWith("p");
    expect(screen.getByRole("button", { name: "Strategist running…" })).toHaveProperty("disabled", true);
    expect(viewSpy).toHaveBeenCalledTimes(2);
  });

  it("plays the simulation behind a permanent synthetic banner", async () => {
    stubMotion(false);
    vi.spyOn(strategistApi, "view").mockResolvedValue(view());
    vi.spyOn(strategistApi, "simulate").mockResolvedValue(simulation());
    render(<StrategistPanel profileId="p" />);
    fireEvent.click(await screen.findByRole("button", { name: "Play simulation" }));
    expect(await screen.findByText(/Simulation — synthetic data/)).toBeTruthy();
    expect(screen.getByText("Synthetic belief at step 1.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run strategist" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Retire belief" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Synthetic belief at step 2.")).toBeTruthy();
    expect(screen.getByText(/Simulation — synthetic data/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to real data" }));
    expect(screen.queryByText(/Simulation — synthetic data/)).toBeNull();
  });

  it("respects reduced motion: no autoplay, final step, no transition class", async () => {
    stubMotion(true);
    vi.spyOn(strategistApi, "view").mockResolvedValue(view());
    vi.spyOn(strategistApi, "simulate").mockResolvedValue(simulation());
    const { container } = render(<StrategistPanel profileId="p" />);
    fireEvent.click(await screen.findByRole("button", { name: "Play simulation" }));
    expect(await screen.findByText("Synthetic belief at step 3.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(container.querySelector(".gf-strategist.is-reduced")).toBeTruthy();
  });

  it("autoplays the timeline when motion is allowed", async () => {
    stubMotion(false);
    vi.spyOn(strategistApi, "view").mockResolvedValue(view());
    vi.spyOn(strategistApi, "simulate").mockResolvedValue(simulation());
    render(<StrategistPanel profileId="p" />);
    fireEvent.click(await screen.findByRole("button", { name: "Play simulation" }));
    await screen.findByText("Synthetic belief at step 1.");
    expect(
      await screen.findByText("Synthetic belief at step 2.", {}, { timeout: 2500 }),
    ).toBeTruthy();
  });
});

describe("BeliefCard", () => {
  it("marks model suggestions and offers retire", () => {
    const retire = vi.fn();
    render(
      <BeliefCard
        belief={{ ...belief({ origin: "model", rationale: "Both question posts were above." }), matching: 4 }}
        onRetire={retire}
      />,
    );
    expect(screen.getByText("Suggested by local model")).toBeTruthy();
    expect(screen.getByText("Both question posts were above.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retire belief" }));
    expect(retire).toHaveBeenCalledWith("belief_a");
  });
});
