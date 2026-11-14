import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { PanelDialog } from "./PanelDialog";

const nativeShowModal = HTMLDialogElement.prototype.showModal;
const nativeClose = HTMLDialogElement.prototype.close;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterAll(() => {
  HTMLDialogElement.prototype.showModal = nativeShowModal;
  HTMLDialogElement.prototype.close = nativeClose;
});

function Harness({ dismissed = () => {} }: { dismissed?: () => void }) {
  const [open, setOpen] = useState(false);
  return <div className="gf-app">
    <button onClick={() => setOpen(true)}>Edit profile</button>
    <PanelDialog open={open} onClose={() => { dismissed(); setOpen(false); }} title="Profile" description="Edit your details.">
      <label>Name<input defaultValue="Original" /></label>
    </PanelDialog>
  </div>;
}

function openEditor() {
  const opener = screen.getByRole("button", { name: "Edit profile" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe("PanelDialog", () => {
  it("restores focus and keeps the field draft mounted after closing", () => {
    render(<Harness />);
    const opener = openEditor();
    expect(screen.getByRole("dialog", { name: "Profile" })).toHaveAccessibleDescription("Edit your details.");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Close Profile" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    openEditor();
    expect(screen.getByLabelText("Name")).toHaveValue("Unsaved draft");
  });

  it("dismisses once on Escape without submitting, and restores the opener", () => {
    const dismissed = vi.fn();
    render(<Harness dismissed={dismissed} />);
    const opener = openEditor();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: false, cancelable: true }));
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("distinguishes the backdrop from blank space inside the dialog", () => {
    const dismissed = vi.fn();
    render(<Harness dismissed={dismissed} />);
    openEditor();
    const dialog = screen.getByRole("dialog");
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({ left: 100, right: 600, top: 100, bottom: 600 } as DOMRect);
    fireEvent.click(dialog, { clientX: 110, clientY: 110 });
    expect(dismissed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Name"));
    expect(dismissed).not.toHaveBeenCalled();
    fireEvent.click(dialog, { clientX: 50, clientY: 50 });
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
