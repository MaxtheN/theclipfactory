import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settings, testState } from "../test-state";
import { Models } from "./Models";
import { SettingsPage, editableSettings } from "./Settings";
afterEach(() => vi.unstubAllGlobals());
const mockFetch = () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async (_path: string) => new Response('{"id":"j1"}'),
    );
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
describe("local setup controls", () => {
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
