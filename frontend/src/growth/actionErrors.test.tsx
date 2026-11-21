import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { resetPreview } from "./previewApi";

// Full-app journeys traverse persistent panels and async saves.
vi.setConfig({ testTimeout: 15_000 });

// Rejects the next write to one route, once, the way a validating service would.
const reject = vi.hoisted(() => ({ path: "", message: "" }));
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  const { previewRequest } = await import("./previewApi");
  const request = (path: string, options: RequestInit = {}) => {
    if (reject.path && path === reject.path && (options.method ?? "GET") !== "GET") {
      reject.path = "";
      // A definite 4xx: the service refused the write, so nothing was saved.
      return Promise.reject(new actual.ApiError(reject.message, 409));
    }
    return previewRequest(path, options);
  };
  return {
    ...actual,
    api: request,
    post: (path: string, body: unknown = {}) =>
      request(path, { method: "POST", body: JSON.stringify(body) }),
    put: (path: string, body: unknown) =>
      request(path, { method: "PUT", body: JSON.stringify(body) }),
    patch: (path: string, body: unknown) =>
      request(path, { method: "PATCH", body: JSON.stringify(body) }),
  };
});
import { GrowthApp } from "./GrowthApp";
import { useCampaignWorkspace } from "./useCampaignWorkspace";
import { pillValue, setPills } from "../test-pills";

// The test DOM has no modal dialogs; the brand editor opens in one.
const dialogApi = { showModal: HTMLDialogElement.prototype.showModal, close: HTMLDialogElement.prototype.close };
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterAll(() => Object.assign(HTMLDialogElement.prototype, dialogApi));
beforeEach(() => {
  localStorage.clear();
  resetPreview();
  reject.path = "";
});

describe("rejected actions", () => {
  it("are reported apart from load failures, and the workspace is re-read rather than held", async () => {
    const refreshFactory = vi.fn(async () => {});
    const { result } = renderHook(() => useCampaignWorkspace(refreshFactory));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.campaign).toBeDefined();
    let ok = true;
    await act(async () => {
      ok = await result.current.run(async () => {
        throw new Error("Choose a primary metric.");
      }, "Saved.");
    });
    expect(ok).toBe(false);
    expect(result.current.actionError).toBe("Choose a primary metric.");
    expect(result.current.notice).toBe("");
    // Nothing marks the workspace unavailable, so screens do not hold their actions.
    expect(result.current.error).toBe("");
    // What the failed action may have touched is read again, as Reconnect would.
    await waitFor(() => expect(refreshFactory).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("");
    act(() => result.current.clearActionError());
    expect(result.current.actionError).toBe("");
    // The next action starts clean and succeeds.
    await act(async () => {
      ok = await result.current.run(async () => {}, "Saved.");
    });
    expect(ok).toBe(true);
    expect(result.current.notice).toBe("Saved.");
  });

  it("show as a dismissible error with the draft kept, not as a lost connection", async () => {
    localStorage.setItem("growth-view-v2", "setup");
    render(<GrowthApp />);
    await waitFor(() =>
      expect(screen.getByLabelText("Brand name")).toHaveValue("All-In demo"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Brand & voice" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit brand details" }));
    setPills("Who it's for", "Founders who ship weekly");
    reject.path = "/api/profiles/preview-profile-allin";
    reject.message = "Brand names must be unique.";
    fireEvent.click(screen.getByRole("button", { name: "Save brand" }));
    const dismiss = await screen.findByRole("button", { name: "Dismiss error" });
    const banner = dismiss.closest("[role=alert]");
    expect(banner).toHaveTextContent("Brand names must be unique.");
    expect(banner).toHaveTextContent("Your inputs are kept.");
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(pillValue("Who it's for")).toBe("Founders who ship weekly");
    // Saving again is not held back as stale data.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save brand" })).toBeEnabled());
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(screen.queryByRole("button", { name: "Dismiss error" })).toBeNull();
    // Keyboard focus stays on the page instead of falling to <body>.
    expect(document.getElementById("growth-main")).toHaveFocus();
  });

  it("in Settings say what happened instead of failing silently", async () => {
    localStorage.setItem("growth-view-v2", "settings");
    render(<GrowthApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Accounts and connections" }));
    const posting = await screen.findByRole("switch", { name: /Post from Growth Factory/ });
    reject.path = "/api/settings";
    reject.message = "Posting needs a signed-in account.";
    fireEvent.click(posting);
    const dismiss = await screen.findByRole("button", { name: "Dismiss error" });
    expect(dismiss.closest("[role=alert]")).toHaveTextContent("Posting needs a signed-in account.");
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(screen.queryByRole("button", { name: "Dismiss error" })).toBeNull();
    // Keyboard focus stays on the page instead of falling to <body>.
    expect(document.getElementById("growth-main")).toHaveFocus();
  });
});
