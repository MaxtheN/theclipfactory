import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { STORAGE_KEY, descriptions, initialTab, rememberTab, tabs } from "./navigation";
import { line, settings } from "./test-state";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());
function service(overrides: Record<string, unknown> = {}) {
  const fetch = vi.fn(async (path: string) => {
    const value =
      path in overrides
        ? overrides[path]
        : path === "/api/settings"
          ? settings
          : path === "/api/factory"
            ? line()
            : ["/api/system", "/api/instagram/status", "/api/analytics"].includes(path)
              ? {}
              : [];
    return new Response(JSON.stringify(value));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("saved tab", () => {
  it("opens Models by default and for unknown values", () => {
    expect(initialTab()).toBe("Models");
    localStorage.setItem(STORAGE_KEY, "Nowhere");
    expect(initialTab()).toBe("Models");
  });
  it.each(["Factory", "Clips", "Footage", "Campaigns", "Results", "Instagram", "Studio", "Dashboard", "Library"])(
    "opens Models when the saved tab is the removed %s screen",
    (saved) => {
      localStorage.setItem(STORAGE_KEY, saved);
      expect(initialTab()).toBe("Models");
    },
  );
  it("remembers the setup screen that was open", () => {
    rememberTab("Settings");
    expect(initialTab()).toBe("Settings");
  });
  it("describes every tab in one plain sentence", () => {
    expect(tabs).toEqual(["Models", "Settings"]);
    for (const tab of tabs) {
      expect(descriptions[tab].length).toBeGreaterThan(10);
      expect(descriptions[tab]).not.toMatch(/ledger|provenance|handoff|preflight/i);
    }
  });
});

describe("local setup", () => {
  it("holds only Models and Settings: making, reviewing and posting live in the Growth Factory shell", async () => {
    service();
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Models" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Models", "Settings"]);
    expect(within(nav).getByRole("button", { name: "Models" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "＋ Add footage" })).not.toBeInTheDocument();
  });
  it("moves focus to the page title and remembers the tab", async () => {
    service();
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toHaveFocus();
    expect(localStorage.getItem(STORAGE_KEY)).toBe("Settings");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save studio settings" })).toBeInTheDocument(),
    );
  });
  it("says how many jobs are running", async () => {
    service({
      "/api/jobs": [
        { id: "j1", kind: "team", status: "running" },
        { id: "j2", kind: "team", status: "completed" },
      ],
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText("1 job running")).toBeInTheDocument());
  });
  it("names unreadable data in plain words", async () => {
    service({ "/api/factory": [] });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("factory status:"));
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid factory response");
  });
});
