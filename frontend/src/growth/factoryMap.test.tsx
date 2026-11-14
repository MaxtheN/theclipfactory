import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api";
import type { TeamRun } from "../types";
import type { FactoryState } from "../useFactory";
import { FactoryMap, FactoryMiniMap, FactoryTabs, RunLedgerCard } from "./FactoryMap";
import { strategistApi } from "./strategistApi";
import type { Workspace } from "./useCampaignWorkspace";
import { workspaceApi } from "./workspaceApi";

vi.mock("../api", () => ({ api: vi.fn(), post: vi.fn(), put: vi.fn() }));

const NOW = Date.now();
const at = (m: number) => new Date(NOW + m * 60000).toISOString();
const w = {
  campaign: { id: "c", video_ids: ["v1"], brief: { audience: "", constraints: [], requested_outputs: [], measurement_intent: "" } },
  profileId: "p",
  profiles: [{ id: "p", active_strategy_id: null }],
  versions: [],
} as unknown as Workspace;
function factory(working: boolean): FactoryState {
  return {
    loading: false,
    errors: {},
    data: {
      clips: [],
      jobs: working
        ? [{ id: "job", kind: "team", status: "running", progress: 30, message: "Finding clips: part 1 of 4 · 0 clips ready" }]
        : [],
      factory: {
        autopilot: false,
        model_id: null,
        ready: true,
        blockers: [],
        sources: [
          {
            video_id: "v1",
            name: "Episode",
            duration: 600,
            state: working ? "working" : "idle",
            headline: "",
            progress: null,
            stages: [
              { key: "listen", label: "Listen", status: working ? "active" : "done", detail: "" },
            ],
            job_id: working ? "job" : null,
            run_id: null,
            clip_ids: [],
            unreviewed: 0,
            approved: 0,
            error: null,
            can_produce: true,
            blocked_reason: null,
            storyboard: null,
            thumbnail: null,
          },
        ],
      },
    },
  } as unknown as FactoryState;
}
const finishedRun = {
  id: "run",
  video_id: "v1",
  mode: "swarm",
  model_id: "m",
  objective: "o",
  status: "needs_review",
  job_id: "job",
  revision_budget: 0,
  revision_count: 0,
  stop_reason: null,
  created_at: at(-20),
  started_at: at(-20),
  finished_at: at(-5),
  elapsed_seconds: 900,
  resource_observations: null,
  clip_ids: [],
  plan: null,
  context: {},
  permissions: { publish: false, ads: false },
  tasks: [
    { id: "t", role: "watch", label: "Watch", kind: "tool", status: "completed", iteration: 0, input_refs: [], output: null, error: null, started_at: at(-20), finished_at: at(-10) },
  ],
} as TeamRun;

function motion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: reduce, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
}
beforeEach(() => {
  // jsdom has no layout: give every station a box so wires (and tokens) can be drawn.
  let n = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => {
    const left = (n++ % 12) * 120;
    return { left, top: 0, width: 100, height: 60, right: left + 100, bottom: 60, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  vi.mocked(api).mockRejectedValue(new Error("offline"));
  vi.spyOn(strategistApi, "view").mockRejectedValue(new Error("offline"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FactoryMap", () => {
  it("disables Demo replay with an explanation when no run was recorded", async () => {
    motion(false);
    const runs = vi.spyOn(workspaceApi, "teamRuns").mockResolvedValue([]);
    render(<FactoryMap w={w} factory={factory(false)} />);
    await waitFor(() => expect(runs).toHaveBeenCalled());
    const button = screen.getByRole("button", { name: "Demo replay" });
    expect(button).toBeDisabled();
    expect(button.getAttribute("title")).toMatch(/No finished run yet/);
    expect(screen.getByText(/Demo replay is unavailable/)).toBeTruthy();
    expect(document.querySelector(".gf-fmap-engine-details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText(/^Engine details/));
    // Honest empty state for missing data, never invented numbers.
    expect(screen.getByRole("button", { name: /Strategist: Idle\. Unavailable right now/ })).toBeTruthy();
    expect(screen.getByText(/No run recorded for this campaign yet/)).toBeTruthy();
  });

  it("defaults to five compact stages and keeps rehearsal evidence inline without a sidebar", async () => {
    motion(false);
    vi.spyOn(workspaceApi, "teamRuns").mockResolvedValue([]);
    const { container } = render(<FactoryMap w={w} factory={factory(false)} />);
    expect(screen.getByRole("list", { name: "Factory growth loop" }).children).toHaveLength(5);
    expect(container.querySelector(".gf-fmap-engine-details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Demo rehearsal" }));
    await screen.findByRole("heading", { name: "Plan-only example" });
    expect(container.querySelector(".gf-loop-inline-workbench")).toBeTruthy();
    expect(document.querySelector(".gf-fmap-sheet")).toBeNull();
    expect(screen.getByRole("button", { name: "Run demo experiment — creates one draft" })).toBeDisabled();
  });

  it("previews stages on hover and keyboard focus, and restores the clicked selection", () => {
    motion(false);
    vi.spyOn(workspaceApi, "teamRuns").mockResolvedValue([]);
    render(<FactoryMap w={w} factory={factory(false)} />);
    const stages = screen.getByRole("list", { name: "Factory growth loop" });
    const buttons = stages.querySelectorAll("button");
    fireEvent.click(buttons[2]);
    expect(screen.getByRole("heading", { name: "Measure", level: 3 })).toBeTruthy();
    fireEvent.mouseEnter(buttons[1]);
    expect(screen.getByRole("heading", { name: "Instagram", level: 3 })).toBeTruthy();
    expect(screen.getByText("Output evidence")).toBeTruthy();
    fireEvent.mouseLeave(stages);
    expect(screen.getByRole("heading", { name: "Measure", level: 3 })).toBeTruthy();
    fireEvent.focus(buttons[3]);
    expect(screen.getByRole("heading", { name: "Strategy", level: 3 })).toBeTruthy();
    fireEvent.blur(stages, { relatedTarget: document.body });
    expect(screen.getByRole("heading", { name: "Measure", level: 3 })).toBeTruthy();
  });

  it("enables Demo replay for a finished, timestamped run", async () => {
    motion(false);
    vi.spyOn(workspaceApi, "teamRuns").mockResolvedValue([finishedRun]);
    render(<FactoryMap w={w} factory={factory(false)} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Demo replay" })).not.toBeDisabled(),
    );
  });

  it("summarises the chosen run compactly and lists full detail in the menu", async () => {
    motion(false);
    vi.spyOn(workspaceApi, "teamRuns").mockResolvedValue([finishedRun]);
    render(<FactoryMap w={w} factory={factory(false)} />);
    fireEvent.click(screen.getByText(/^Engine details/));
    const picker = await screen.findByRole("button", { name: /Choose a run/ });
    expect(picker.textContent).toMatch(/^Run.*Needs review$/);
    fireEvent.click(picker);
    const option = screen.getByRole("option", { selected: true });
    expect(option.textContent).toMatch(/Needs review/);
    expect(option.textContent).toMatch(/run/);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(picker).toHaveFocus();
  });

  it("opens the run menu above a low trigger outside clipped ancestors and keeps keyboard selection", () => {
    const earlier = { ...finishedRun, id: "earlier", created_at: at(-60), status: "completed" } as TeamRun;
    const { container } = render(<div style={{ overflow: "hidden", height: 30 }}><RunLedgerCard runs={[finishedRun, earlier]} clips={[]} /></div>);
    const picker = screen.getByRole("button", { name: /Choose a run/ });
    vi.spyOn(picker, "getBoundingClientRect").mockReturnValue({
      left: window.innerWidth - 190, right: window.innerWidth - 10,
      top: window.innerHeight - 40, bottom: window.innerHeight - 8,
      width: 180, height: 32,
    } as DOMRect);
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    const menu = screen.getByRole("listbox");
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveFocus();
    expect(parseFloat(menu.style.top)).toBeLessThan(window.innerHeight - 40);
    expect(parseFloat(menu.style.left) + parseFloat(menu.style.width)).toBeLessThanOrEqual(window.innerWidth - 12);
    fireEvent.keyDown(menu, { key: "End" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(picker).toHaveAccessibleName(/Completed/);
    expect(picker).toHaveFocus();
    fireEvent.click(picker);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("moves tokens only while real work happens", async () => {
    motion(false);
    vi.spyOn(workspaceApi, "teamRuns").mockResolvedValue([]);
    const idle = render(<FactoryMap w={w} factory={factory(false)} />);
    await waitFor(() =>
      expect(idle.container.querySelector(".gf-fmap-live")!.textContent).toBe("Resting"),
    );
    expect(idle.container.querySelectorAll(".gf-fmap-wire").length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId("flow-token")).toHaveLength(0);
    idle.unmount();
    render(<FactoryMap w={w} factory={factory(true)} />);
    expect(await screen.findByText("Working now")).toBeTruthy();
    expect(screen.getAllByTestId("flow-token").length).toBeGreaterThan(0);
  });

  it("is a still map with state badges under reduced motion", async () => {
    motion(true);
    vi.spyOn(workspaceApi, "teamRuns").mockResolvedValue([]);
    const { container } = render(<FactoryMap w={w} factory={factory(true)} />);
    expect(await screen.findByText("Working now")).toBeTruthy();
    expect(container.querySelector(".gf-fmap-wire.is-flowing")).toBeTruthy();
    expect(container.querySelector(".gf-fmap")!.getAttribute("data-reduced")).toBe("true");
    expect(screen.queryAllByTestId("flow-token")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /^Listen: Working\./ })).toBeTruthy();
  });
});

describe("FactoryTabs", () => {
  it("supports arrow-key view switching while retaining an episode draft", () => {
    localStorage.removeItem("growth-factory-tab-v1");
    motion(true);
    vi.spyOn(workspaceApi, "teamRuns").mockResolvedValue([]);
    render(<FactoryTabs w={w} factory={factory(false)} active={false}><input aria-label="Episode draft" defaultValue="" /></FactoryTabs>);
    const draft = screen.getByRole("textbox", { name: "Episode draft" });
    fireEvent.change(draft, { target: { value: "Unfinished import title" } });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Episodes" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Factory map" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Factory map" })).toHaveAttribute("aria-selected", "true");
    expect(draft).toBeInTheDocument();
    expect(draft).not.toBeVisible();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Factory map" }), { key: "Home" });
    expect(draft).toBeVisible();
    expect(draft).toHaveValue("Unfinished import title");
    localStorage.removeItem("growth-factory-tab-v1");
  });
});

describe("FactoryMiniMap", () => {
  it("names the working station", () => {
    motion(false);
    render(<FactoryMiniMap w={w} factory={factory(true)} runs={[]} />);
    expect(screen.getByRole("status").textContent).toMatch(/Listen/);
  });
});
