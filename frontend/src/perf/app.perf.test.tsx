/**
 * Render-performance benchmark for the whole desktop shell.
 *
 * Mounts the real GrowthApp against a busy, deterministic local service (40 episodes, 400 clips,
 * 120 jobs) and measures React commits and render time per screen for the moments creators feel:
 * idle polling, a job making progress, typing in the Library filter and scrolling. Run with
 * `npm run perf`; it prints a table and a `PERF_JSON` line for before/after comparisons.
 */
import { Profiler } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { onRender, resetSamples, samples } from "./profiling";
import { createWorld, fetchFor, type World } from "./world";

vi.mock("../growth/FactoryHome", async (load) => (await import("./profiling")).profiled(await load(), ["FactoryHome"]));
vi.mock("../growth/FactoryMap", async (load) => (await import("./profiling")).profiled(await load(), ["FactoryTabs"]));
vi.mock("../growth/Library", async (load) => (await import("./profiling")).profiled(await load(), ["Library"]));
vi.mock("../growth/Results", async (load) => (await import("./profiling")).profiled(await load(), ["Results"]));
vi.mock("../growth/Setup", async (load) => (await import("./profiling")).profiled(await load(), ["Setup"]));
vi.mock("../growth/Studio", async (load) => (await import("./profiling")).profiled(await load(), ["Studio"]));
vi.mock("../growth/Research", async (load) => (await import("./profiling")).profiled(await load(), ["Research"]));
vi.mock("../growth/SettingsScreen", async (load) => (await import("./profiling")).profiled(await load(), ["SettingsScreen"]));
vi.mock("../growth/ActivityCenter", async (load) => (await import("./profiling")).profiled(await load(), ["ActivityCenter"]));
vi.mock("../growth/Onboarding", async (load) => (await import("./profiling")).profiled(await load(), ["Onboarding"]));

const { GrowthApp } = await import("../growth/GrowthApp");

type Row = { scenario: string; commits: number; ms: number; wallMs: number; nodes?: number; screens: Record<string, Sample> };
type Sample = { commits: number; ms: number };
const report: Row[] = [];
let world: World;

const round = (n: number) => Math.round(n * 10) / 10;
function snapshot(): Record<string, Sample> {
  return Object.fromEntries([...samples].map(([k, v]) => [k, { commits: v.commits, ms: round(v.ms) }]));
}
async function measure(scenario: string, body: () => Promise<void>) {
  resetSamples();
  const started = performance.now();
  await body();
  const wallMs = performance.now() - started;
  const app = samples.get("app") ?? { commits: 0, ms: 0 };
  const nodes = document.getElementsByTagName("*").length;
  const row = { scenario, commits: app.commits, ms: round(app.ms), wallMs: round(wallMs), nodes, screens: snapshot() };
  report.push(row);
  return row;
}
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
/** Plain selectors: getByRole computes accessible names across the whole (large) DOM. */
function openLibrary() {
  const button = [...document.querySelectorAll<HTMLButtonElement>(".gf-primary-navigation button")].find((b) => b.textContent?.includes("Library"));
  fireEvent.click(button!);
}
async function mount() {
  render(
    <Profiler id="app" onRender={onRender}>
      <GrowthApp />
    </Profiler>,
  );
  // Let the first load, the workspace and every screen's own first fetch settle.
  for (let i = 0; i < 10; i++) await tick(50);
  expect(document.querySelector("h1")?.textContent).toBe("Factory");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  localStorage.clear();
  world = createWorld();
  vi.stubGlobal("fetch", vi.fn(fetchFor(world)));
});

afterAll(() => {
  vi.useRealTimers();
  const table = report.map((r) => ({
    scenario: r.scenario,
    commits: r.commits,
    "render ms": r.ms,
    "wall ms": r.wallMs,
    "DOM nodes": r.nodes,
    "screens re-rendered": Object.keys(r.screens).filter((k) => k !== "app").length,
  }));
  console.table(table);
  for (const r of report)
    console.log(
      r.scenario,
      Object.entries(r.screens)
        .filter(([k]) => k !== "app")
        .map(([k, v]) => `${k}:${v.commits}/${v.ms}ms`)
        .join("  "),
    );
  console.log(`PERF_JSON ${JSON.stringify(report)}`);
});

describe("render performance on a busy brand", () => {
  it("mounts the shell", async () => {
    await measure("mount", mount);
  });

  it("idles on Factory through 10 unchanged poll cycles", async () => {
    await mount();
    await measure("idle poll x10 (Factory)", async () => {
      for (let i = 0; i < 10; i++) await tick(4000);
    });
  });

  it("idles on Library through 10 unchanged poll cycles", async () => {
    await mount();
    openLibrary();
    await tick(50);
    await measure("idle poll x10 (Library)", async () => {
      for (let i = 0; i < 10; i++) await tick(4000);
    });
  });

  it("follows one job making progress for 10 poll cycles", async () => {
    world.jobs[0] = { ...world.jobs[0], status: "running", progress: 0 };
    await mount();
    await measure("active job x10 (Factory)", async () => {
      for (let i = 1; i <= 10; i++) {
        world.jobs[0] = { ...world.jobs[0], progress: i / 10, updated_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() };
        await tick(4000);
      }
    });
  });

  it("types 20 characters into the Library filter", async () => {
    await mount();
    openLibrary();
    await tick(50);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Filter library"]')!;
    const text = "the moment everythin";
    await measure("type 20 chars (Library filter)", async () => {
      for (let i = 1; i <= text.length; i++) {
        fireEvent.change(input, { target: { value: text.slice(0, i) } });
      }
      await tick(0);
    });
  });

  it("scrolls the workspace 50 times on Library", async () => {
    await mount();
    openLibrary();
    await tick(50);
    const scroller = document.querySelector(".gf-workspace")!;
    await measure("scroll x50 (Library)", async () => {
      for (let i = 0; i < 50; i++) {
        (scroller as HTMLElement).scrollTop = i * 40;
        fireEvent.scroll(scroller);
      }
      await tick(0);
    });
  });

  it("reports which endpoints one idle minute polls", async () => {
    await mount();
    world.hits.clear();
    await tick(60_000);
    const hits = Object.fromEntries([...world.hits].sort((a, b) => b[1] - a[1]));
    console.log("requests in one idle minute on Factory:", JSON.stringify(hits));
    report.push({ scenario: "requests / idle minute", commits: [...world.hits.values()].reduce((a, b) => a + b, 0), ms: 0, wallMs: 0, screens: {} });
  });
});
