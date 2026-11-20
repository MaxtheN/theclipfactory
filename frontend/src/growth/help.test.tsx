import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const help = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./helpApi", () => ({ helpApi: help }));
import { HelpButton } from "./Help";
import { GUIDE_URL, requestHelp } from "./guideLinks";
import { previewRequest } from "./previewApi";

afterEach(() => {
  help.open.mockReset();
});

describe("HelpButton", () => {
  it("opens the guide index through the engine and confirms it", async () => {
    help.open.mockResolvedValue({ url: GUIDE_URL, opened: true });
    render(<HelpButton />);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The guide opened in your browser."));
    expect(help.open).toHaveBeenCalledWith("", "");
  });

  it("offers the link when the browser could not be opened", async () => {
    help.open.mockResolvedValue({ url: `${GUIDE_URL}posting#missed-schedules`, opened: false });
    render(<HelpButton />);
    act(() => requestHelp("posting", "missed-schedules"));
    const link = await screen.findByRole("link");
    expect(link).toHaveAttribute("href", `${GUIDE_URL}posting#missed-schedules`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(help.open).toHaveBeenCalledWith("posting", "missed-schedules");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("falls back to the published guide when the engine is unreachable", async () => {
    help.open.mockRejectedValue(new Error("offline"));
    render(<HelpButton />);
    act(() => requestHelp("models"));
    expect(await screen.findByRole("link")).toHaveAttribute("href", `${GUIDE_URL}models`);
  });

  it("can be disabled", () => {
    render(<HelpButton disabled />);
    expect(screen.getByRole("button", { name: "Help" })).toBeDisabled();
  });
});

describe("preview", () => {
  it("returns the guide link instead of failing", async () => {
    await expect(
      previewRequest("/api/help/open", { method: "POST", body: JSON.stringify({ page: "results", anchor: "what-results-can-and-cannot-prove" }) }),
    ).resolves.toEqual({ url: `${GUIDE_URL}results#what-results-can-and-cannot-prove`, opened: false });
  });
});
