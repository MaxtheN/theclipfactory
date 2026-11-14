import { vi } from "vitest";
import type { FactoryState } from "./useFactory";
import type { Clip, Settings } from "./types";
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
