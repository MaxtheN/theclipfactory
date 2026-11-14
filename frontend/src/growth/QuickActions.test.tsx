import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { QuickActions, type QuickAction } from "./QuickActions";

const showModal = HTMLDialogElement.prototype.showModal;
const close = HTMLDialogElement.prototype.close;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterAll(() => {
  HTMLDialogElement.prototype.showModal = showModal;
  HTMLDialogElement.prototype.close = close;
});

function Harness({ actions }: { actions: QuickAction[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open quick actions
      </button>
      <QuickActions
        open={open}
        onDismiss={() => setOpen(false)}
        actions={actions}
      />
    </>
  );
}

function openPalette(actions: QuickAction[]) {
  render(<Harness actions={actions} />);
  const opener = screen.getByRole("button", { name: "Open quick actions" });
  opener.focus();
  fireEvent.click(opener);
  const input = screen.getByRole("combobox", { name: "Search quick actions" });
  expect(input).toHaveFocus();
  return { input, opener };
}

describe("Quick actions", () => {
  it("filters by keywords and executes only the enabled keyboard selection", () => {
    const blocked = vi.fn();
    const research = vi.fn();
    const studio = vi.fn();
    const { input } = openPalette([
      {
        id: "blocked",
        label: "Research unavailable",
        keywords: "edit",
        icon: "research",
        group: "Clips",
        disabled: true,
        run: blocked,
      },
      {
        id: "research",
        label: "Research",
        keywords: "edit",
        icon: "research",
        group: "Clips",
        run: research,
      },
      {
        id: "studio",
        label: "Studio",
        keywords: "edit",
        icon: "studio",
        group: "Clips",
        run: studio,
      },
      {
        id: "refresh",
        label: "Refresh workspace",
        icon: "refresh",
        group: "Brand",
        run: vi.fn(),
      },
    ]);
    fireEvent.change(input, { target: { value: "edit" } });
    expect(
      screen.queryByRole("option", { name: "Refresh workspace" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Research unavailable" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "Research" }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen.getByRole("option", { name: "Studio" }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(studio).toHaveBeenCalledOnce();
    expect(research).not.toHaveBeenCalled();
    expect(blocked).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not execute a disabled or missing result and restores focus on Escape", () => {
    const run = vi.fn();
    const { input, opener } = openPalette([
      {
        id: "blocked",
        label: "Studio",
        icon: "studio",
        group: "Clips",
        disabled: true,
        run,
      },
    ]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Quick actions" })).toBeVisible();
    fireEvent.change(input, { target: { value: "missing" } });
    expect(screen.getByRole("status")).toHaveTextContent(
      "No matching actions.",
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    fireEvent.click(opener);
    expect(
      screen.getByRole("combobox", { name: "Search quick actions" }),
    ).toHaveValue("");
  });

  it("closes before running navigation so restored focus does not replace the destination", () => {
    const destination = document.createElement("button");
    destination.textContent = "Destination";
    document.body.append(destination);
    const run = vi.fn(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      destination.focus();
    });
    openPalette([
      {
        id: "tools",
        label: "Advanced tools",
        icon: "settings",
        group: "Brand",
        run,
      },
    ]);
    fireEvent.click(screen.getByRole("option", { name: "Advanced tools" }));
    expect(run).toHaveBeenCalledOnce();
    expect(destination).toHaveFocus();
    destination.remove();
  });
});
