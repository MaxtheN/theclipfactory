import { vi } from "vitest";
import type { FactoryState } from "./useFactory";
import type { Clip, FactoryLine, FactorySource, Settings } from "./types";
export const settings: Settings = {
  brand: "Test studio",
  objective: "discovery",
  language: "en",
  autonomy: "review",
  publishing_enabled: false,
  ads_enabled: false,
  daily_budget: 0,
  total_budget: 0,
  graph_version: "v22.0",
};
export const clip: Clip = {
  id: "c1",
  video_id: "v1",
  name: "Test clip",
  start: 0,
  end: 10,
  hook: "Hook",
  caption: "Caption",
  objective: "discovery",
  approved: false,
  status: "rendered",
};
export function lineSource(overrides: Partial<FactorySource> = {}): FactorySource {
  return {
    video_id: "v1",
    name: "Match day",
    duration: 125,
    state: "idle",
    headline: "Ready when you are",
    progress: null,
    stages: [
      { key: "import", label: "Added", status: "done", detail: "" },
      { key: "listen", label: "Listen", status: "pending", detail: "" },
      { key: "watch", label: "Watch", status: "pending", detail: "" },
      { key: "select", label: "Pick moments", status: "pending", detail: "" },
      { key: "edit", label: "Edit", status: "pending", detail: "" },
      { key: "render", label: "Make clips", status: "pending", detail: "" },
    ],
    job_id: null,
    run_id: null,
    clip_ids: [],
    unreviewed: 0,
    approved: 0,
    error: null,
    can_produce: true,
    blocked_reason: null,
    storyboard: null,
    thumbnail: null,
    ...overrides,
  };
}
export function line(overrides: Partial<FactoryLine> = {}): FactoryLine {
  return {
    autopilot: false,
    model_id: "qwen-small",
    ready: true,
    blockers: [],
    sources: [],
    ...overrides,
  };
}
export function testState(overrides: Partial<FactoryState> = {}): FactoryState {
  return {
    data: {
      system: null,
      settings,
      models: [],
      jobs: [],
      videos: [],
      clips: [],
      instagram: null,
      analytics: null,
      factory: null,
    },
    errors: {},
    loading: false,
    notice: "",
    actionError: "",
    busy: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    run: vi.fn(async (task: () => Promise<unknown>) => {
      await task();
      return true;
    }),
    dismiss: vi.fn(),
    ...overrides,
  };
}
