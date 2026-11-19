import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import {
  UnsavedDraftProvider,
  UnsavedNote,
  useDraftRegistry,
  useUnsavedDraft,
  type UnsavedDraft,
} from "./unsavedDrafts";

type Registry = ReturnType<typeof useDraftRegistry>;

// jsdom has no modal dialogs; open and close them by attribute.
const native = { showModal: HTMLDialogElement.prototype.showModal, close: HTMLDialogElement.prototype.close };
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterAll(() => Object.assign(HTMLDialogElement.prototype, native));

/** A screen with one text field that registers its edits as an Unsaved Draft. */
function Editor({ id, label, save, record }: { id: string; label: string; save?: (value: string) => Promise<boolean>; record?: string }) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const dirty = value !== saved;
  useUnsavedDraft(dirty, {
    id,
    screen: "setup",
    label,
    record,
    save: save
      ? async () => {
          const ok = await save(value);
          if (ok) setSaved(value);
          return ok;
        }
      : undefined,
    discard: () => setValue(saved),
  });
  return (
    <div>
      <label>
        {label}
        <input value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      {dirty && <UnsavedNote />}
    </div>
  );
}

function Shell({ children, onRegistry }: { children: React.ReactNode; onRegistry: (r: Registry) => void }) {
  const registry = useDraftRegistry();
  onRegistry(registry);
  return (
    <UnsavedDraftProvider api={registry.api}>
      {children}
      {registry.dialog}
    </UnsavedDraftProvider>
  );
}

function setup(children: React.ReactNode) {
  const ref: { current?: Registry } = {};
  render(<Shell onRegistry={(r) => (ref.current = r)}>{children}</Shell>);
  return () => ref.current!;
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("Unsaved Draft registry", () => {
  it("continues at once when nothing is unsaved", () => {
    const registry = setup(<Editor id="brief" label="Campaign brief" />);
    expect(registry().guard("Switching campaign reloads every screen.")).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("registers a draft while dirty, marks it and clears it once the edit is undone", () => {
    const registry = setup(<Editor id="brief" label="Campaign brief" />);
    type("Campaign brief", "New goal");
    expect(registry().drafts.map((d) => d.label)).toEqual(["Campaign brief"]);
    expect(screen.getByText("Not saved")).toBeInTheDocument();
    type("Campaign brief", "");
    expect(registry().drafts).toEqual([]);
  });

  it("lists the drafts and keeps them when the creator stays", async () => {
    const registry = setup(<Editor id="brief" label="Campaign brief" save={async () => true} />);
    type("Campaign brief", "New goal");
    let answer!: true | Promise<boolean>;
    act(() => {
      answer = registry().guard("Switching campaign reloads every screen.");
    });
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    expect(within(dialog).getByText("Switching campaign reloads every screen.")).toBeInTheDocument();
    expect(within(within(dialog).getByRole("list", { name: "Unsaved drafts" })).getByText("Campaign brief")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    await expect(answer).resolves.toBe(false);
    expect(screen.getByLabelText("Campaign brief")).toHaveValue("New goal");
    expect(registry().drafts).toHaveLength(1);
  });

  it("discards only when the creator chooses Discard", async () => {
    const registry = setup(<Editor id="brief" label="Campaign brief" />);
    type("Campaign brief", "New goal");
    let answer!: true | Promise<boolean>;
    act(() => {
      answer = registry().guard("Leaving New campaign closes this form.");
    });
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await expect(answer).resolves.toBe(true);
    expect(screen.getByLabelText("Campaign brief")).toHaveValue("");
    expect(registry().drafts).toEqual([]);
  });

  it("continues after a confirmed save and stays with the edits when saving fails", async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const registry = setup(<Editor id="brand" label="Brand profile" save={save} />);
    type("Brand profile", "Calmer voice");
    let answer!: true | Promise<boolean>;
    act(() => {
      answer = registry().guard("Switching brand reloads every screen.");
    });
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't save Brand profile. Your edits are still here.");
    expect(screen.getByLabelText("Brand profile")).toHaveValue("Calmer voice");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await expect(answer).resolves.toBe(true);
    expect(save).toHaveBeenLastCalledWith("Calmer voice");
    await waitFor(() => expect(registry().drafts).toEqual([]));
  });

  it("offers no Save when a draft cannot be saved on its own, and asks only about matching drafts", async () => {
    const registry = setup(
      <>
        <Editor id="brand" label="Brand profile" save={async () => true} />
        <Editor id="caption" label="Post caption" record="clip-1" />
      </>,
    );
    type("Brand profile", "Calmer voice");
    type("Post caption", "Watch this");
    const other = (d: UnsavedDraft) => d.record !== undefined && d.record !== "clip-2";
    expect(registry().guard("Studio is about to open another clip.", (d) => d.record === "clip-9")).toBe(true);
    act(() => {
      void registry().guard("Studio is about to open another clip.", other);
    });
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    const listed = within(within(dialog).getByRole("list", { name: "Unsaved drafts" })).getAllByRole("listitem");
    expect(listed.map((item) => item.textContent)).toEqual(["Post caption"]);
    expect(within(dialog).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });

  it("warns before the window closes only while something is unsaved", () => {
    setup(<Editor id="brief" label="Campaign brief" />);
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    type("Campaign brief", "New goal");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("does nothing outside the shell", () => {
    render(<Editor id="brief" label="Campaign brief" />);
    type("Campaign brief", "New goal");
    expect(screen.getByText("Not saved")).toBeInTheDocument();
  });
});
