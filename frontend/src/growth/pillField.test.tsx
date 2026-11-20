import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { PillList, PillSelect, joinList, splitList } from "./PillField";

function List({ initial = "", max }: { initial?: string; max?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PillList label="Tone" format="comma" options={["Warm", "Bold"]} max={max} value={value} onChange={setValue} />
      <output>{value}</output>
    </>
  );
}

function Select() {
  const [value, setValue] = useState("");
  return (
    <>
      <PillSelect label="Metric" options={["reach", "views"]} labels={{ reach: "Reach" }} value={value} onChange={setValue} />
      <output>{value}</output>
    </>
  );
}

const group = (name: string) => screen.getByRole("group", { name });
const stored = () => screen.getByRole("status").textContent;
const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

describe("PillField", () => {
  it("picks and unpicks presets into the stored list", () => {
    render(<List />);
    fireEvent.click(within(group("Tone")).getByRole("button", { name: "Warm" }));
    fireEvent.click(within(group("Tone")).getByRole("button", { name: "Bold" }));
    expect(stored()).toBe("Warm, Bold");
    expect(within(group("Tone")).getByRole("button", { name: "Warm" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(group("Tone")).getByRole("button", { name: "Warm" }));
    expect(stored()).toBe("Bold");
  });

  it("adds your own as a removable pill, and typing a preset picks the preset", () => {
    render(<List />);
    fireEvent.click(screen.getByRole("button", { name: "Add your own" }));
    const input = screen.getByRole("textbox", { name: "Add your own: Tone" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "  Deadpan  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "warm" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(stored()).toBe("Deadpan, Warm");
    fireEvent.click(screen.getByRole("button", { name: "Deadpan, remove" }));
    expect(stored()).toBe("Warm");
  });

  it("Escape discards the typed text", () => {
    render(<List />);
    fireEvent.click(screen.getByRole("button", { name: "Add your own" }));
    const input = screen.getByRole("textbox", { name: "Add your own: Tone" });
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(stored()).toBe("");
  });

  it("leaves focus where the person moved it when a typed pill is kept on blur", async () => {
    render(
      <>
        <List />
        <button type="button">Next</button>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add your own" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Add your own: Tone" }), { target: { value: "Calm" } });
    act(() => screen.getByRole("button", { name: "Next" }).focus());
    await frame();
    expect(stored()).toBe("Calm");
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
  });

  it("puts focus back on Add your own when Escape closes the input", async () => {
    render(<List />);
    fireEvent.click(screen.getByRole("button", { name: "Add your own" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Add your own: Tone" }), { key: "Escape" });
    await frame();
    expect(screen.getByRole("button", { name: "Add your own" })).toHaveFocus();
  });

  it("stops at the cap: other pills disable and Add your own hides", () => {
    render(<List max={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Warm" }));
    expect(screen.getByRole("button", { name: "Bold" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add your own" })).toBeNull();
  });

  it("keeps an existing typed value as it was", () => {
    render(<List initial="Builders, founders and curious minds" />);
    expect(screen.getByRole("button", { name: "Builders, remove" })).toHaveAttribute("aria-pressed", "true");
    expect(stored()).toBe("Builders, founders and curious minds");
  });

  it("single keeps one pick, shows labels and stores the key", () => {
    render(<Select />);
    fireEvent.click(screen.getByRole("button", { name: "Reach" }));
    fireEvent.click(screen.getByRole("button", { name: "views" }));
    expect(stored()).toBe("views");
    fireEvent.click(screen.getByRole("button", { name: "views" }));
    expect(stored()).toBe("");
  });

  it("treats a stored or typed label as its preset", () => {
    function Stored() {
      const [value, setValue] = useState("Reach");
      return (
        <>
          <PillSelect label="Metric" options={["reach", "views"]} labels={{ reach: "Reach" }} value={value} onChange={setValue} />
          <output>{value}</output>
        </>
      );
    }
    render(<Stored />);
    expect(screen.getAllByRole("button", { name: /Reach/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Reach" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Add your own" }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "reach" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(stored()).toBe("reach");
  });

  it("splits and joins symmetrically", () => {
    for (const [text, format] of [["a, b, c", "comma"], ["one\ntwo", "lines"]] as const)
      expect(joinList(splitList(text, format), format)).toBe(text);
    expect(splitList(" a \n\n b ", "lines")).toEqual(["a", "b"]);
  });
});
