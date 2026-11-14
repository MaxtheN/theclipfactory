import { createRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoTextarea } from "./AutoTextarea";

const style = {
  boxSizing: "border-box" as const,
  fontSize: "14px",
  lineHeight: "20px",
  padding: "10px",
  border: "1px solid",
};

describe("automatically growing text fields", () => {
  let width: number;
  let notifyResize: ResizeObserverCallback;
  let frames: FrameRequestCallback[];
  const flushFrames = () => act(() => {
    const pending = frames.splice(0);
    pending.forEach((callback) => callback(0));
  });

  beforeEach(() => {
    width = 300;
    frames = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      width, height: 42, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 42,
      toJSON: () => ({}),
    }));
    // JSDOM has no layout. Simulate measured wrapping on the inert mirror.
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) {
      const available = Math.max(1, (Number.parseFloat(this.style.width) - 22) / 7);
      const lines = this.value.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / available)), 0);
      return lines * 20 + 20;
    });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { notifyResize = callback; }
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("grows, caps and shrinks while preserving controlled editing and the forwarded ref", () => {
    const reference = createRef<HTMLTextAreaElement>();
    const changed = vi.fn();
    function Editor() {
      const [value, setValue] = useState("");
      return <AutoTextarea ref={reference} aria-label="Audience" value={value} style={style}
        onChange={(event) => { changed(event.target.value); setValue(event.target.value); }} />;
    }
    render(<Editor />);
    const field = screen.getByRole("textbox", { name: "Audience" });
    expect(reference.current).toBe(field);
    expect(field).toHaveStyle({ height: "42px", overflowY: "hidden" });
    fireEvent.change(field, { target: { value: "Audience detail ".repeat(10) } });
    expect(Number.parseInt(reference.current!.style.height)).toBeGreaterThan(42);
    fireEvent.change(field, { target: { value: "Audience detail ".repeat(100) } });
    expect(field).toHaveStyle({ height: "240px", overflowY: "auto" });
    expect(changed).toHaveBeenLastCalledWith("Audience detail ".repeat(100));
    fireEvent.change(field, { target: { value: "Founders" } });
    expect(field).toHaveValue("Founders");
    expect(field).toHaveStyle({ height: "42px", overflowY: "hidden" });
  });

  it("respects rows and custom caps, and grows uncontrolled input without changing its selection", () => {
    render(<AutoTextarea aria-label="Direction" rows={3} maxAutoHeight={120} defaultValue="Short" style={style} />);
    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(field.style.height).toBe("82px");
    field.focus();
    field.value = "One\nTwo\nThree\nFour\nFive\nSix";
    field.setSelectionRange(4, 7);
    fireEvent.input(field);
    expect(field).toHaveStyle({ height: "120px", overflowY: "auto" });
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([4, 7]);
  });

  it("remeasures wrapping after width changes and hidden disclosures reopen", () => {
    const { rerender } = render(<details open><AutoTextarea aria-label="Brief" defaultValue={"a".repeat(200)} style={style} /></details>);
    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    const initial = Number.parseInt(field.style.height);
    width = 600;
    act(() => notifyResize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
    flushFrames();
    expect(Number.parseInt(field.style.height)).toBeLessThan(initial);
    const previous = field.style.height;
    width = 0;
    rerender(<details><AutoTextarea aria-label="Brief" defaultValue={"a".repeat(200)} style={style} /></details>);
    fireEvent(window, new Event("resize"));
    flushFrames();
    expect(field.style.height).toBe(previous);
    width = 180;
    const disclosure = field.closest("details")!;
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    flushFrames();
    expect(Number.parseInt(field.style.height)).toBeGreaterThan(initial);
  });

  it("keeps its measurement mirror outside the accessible form and removes it on unmount", () => {
    const { unmount } = render(<label htmlFor="brief">Brief<AutoTextarea id="brief" name="brief" required disabled style={style} /></label>);
    expect(screen.getAllByLabelText("Brief")).toHaveLength(1);
    expect(screen.getByLabelText("Brief")).toBeRequired();
    expect(screen.getByLabelText("Brief")).toBeDisabled();
    const mirror = document.querySelector("[data-autosize-mirror]")!;
    expect(mirror).toHaveAttribute("aria-hidden", "true");
    expect(mirror).toHaveAttribute("tabindex", "-1");
    expect(mirror).not.toHaveAttribute("id");
    expect(mirror).not.toHaveAttribute("name");
    unmount();
    expect(document.querySelector("[data-autosize-mirror]")).toBeNull();
  });
});
