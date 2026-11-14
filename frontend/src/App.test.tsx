import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { STORAGE_KEY, descriptions, initialTab, rememberTab, tabs } from "./navigation";
import { line, lineSource, settings } from "./test-state";

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
  it("lands on the factory by default and for unknown values", () => {
    expect(initialTab()).toBe("Factory");
    localStorage.setItem(STORAGE_KEY, "Nowhere");
    expect(initialTab()).toBe("Factory");
  });
  it.each([
    ["Dashboard", "Factory"],
    ["Library", "Footage"],
    ["Factory", "Studio"],
    ["Campaigns", "Campaigns"],
    ["Models", "Models"],
  ])("translates %s from the old layout to %s", (saved, expected) => {
    localStorage.setItem(STORAGE_KEY, saved);
    expect(initialTab()).toBe(expected);
  });
  it("translates the old Factory page only once", () => {
    localStorage.setItem(STORAGE_KEY, "Factory");
    expect(initialTab()).toBe("Studio");
    expect(initialTab()).toBe("Studio");
    rememberTab("Factory");
    expect(initialTab()).toBe("Factory");
    rememberTab("Studio");
    expect(initialTab()).toBe("Studio");
  });
  it("describes every tab in one plain sentence", () => {
    expect(tabs).toHaveLength(9);
    for (const tab of tabs) {
      expect(descriptions[tab].length).toBeGreaterThan(10);
      expect(descriptions[tab]).not.toMatch(/ledger|provenance|handoff|preflight/i);
    }
  });
});

describe("app shell", () => {
  it("opens on the factory with grouped navigation", async () => {
    service();
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Factory" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Drop footage. Get clips." })).toBeInTheDocument(),
    );
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    const groups = within(nav).getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Make", "Grow", "Setup"]);
    expect(
      groups.map((group) =>
        within(group)
          .getAllByRole("button")
          .map((button) => button.textContent?.replace(/[^A-Za-z]/g, "")),
      ),
    ).toEqual([
      ["Factory", "Clips", "Footage"],
      ["Campaigns", "Results", "Instagram"],
      ["Studio", "Models", "Settings"],
    ]);
    expect(within(nav).getByRole("button", { name: /Factory/ })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "＋ Add footage" })).not.toBeInTheDocument();
    expect(screen.queryByText("CREATE WITH INTENT")).not.toBeInTheDocument();
    expect(screen.queryByText(/Human review is part of the pipeline/)).not.toBeInTheDocument();
  });
  it("moves focus to the page title, remembers the tab and returns to the factory to add footage", async () => {
    service();
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /Clips/ }));
    const title = screen.getByRole("heading", { level: 1, name: "Clips" });
    expect(title).toHaveFocus();
    expect(localStorage.getItem(STORAGE_KEY)).toBe("Clips");
    await userEvent.click(screen.getByRole("button", { name: "＋ Add footage" }));
    expect(screen.getByRole("heading", { level: 1, name: "Factory" })).toHaveFocus();
  });
  it("counts running jobs on Factory and waiting clips on Clips", async () => {
    service({
      "/api/jobs": [
        { id: "j1", kind: "team", status: "running" },
        { id: "j2", kind: "team", status: "completed" },
      ],
      "/api/clips": [
        { id: "c1", approved: false },
        { id: "c2", approved: false },
        { id: "c3", approved: true },
      ],
      "/api/factory": line({ sources: [lineSource({ state: "working", job_id: "j1" })] }),
    });
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    await waitFor(() =>
      expect(within(nav).getByRole("button", { name: /Clips/ })).toHaveTextContent("2 to review"),
    );
    expect(within(nav).getByRole("button", { name: /Factory/ })).toHaveTextContent("1 running");
    expect(screen.getByText("1 job running")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Production line" })).toBeInTheDocument();
  });
  it("opens the manual editor for a source chosen in Footage", async () => {
    service({
      "/api/videos": [
        { id: "v1", name: "First", duration: 60 },
        { id: "v2", name: "Second", duration: 90 },
      ],
    });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /Footage/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Second/ })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Second/ }));
    await userEvent.click(screen.getByRole("button", { name: "Edit by hand" }));
    expect(screen.getByRole("heading", { level: 1, name: "Studio" })).toBeInTheDocument();
    expect(screen.getByLabelText("Source video")).toHaveValue("v2");
  });
  it("names unreadable data in plain words", async () => {
    service({ "/api/factory": [] });
    render(<App />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("factory status:"));
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid factory response");
  });
});
