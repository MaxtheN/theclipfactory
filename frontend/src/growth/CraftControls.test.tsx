import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { CraftControls, craftFromPlan, craftPlan, freshCraft, type CraftState } from "./CraftControls";
import { changedEditFields } from "./productionState";

function Harness({ onPlan }: { onPlan: (plan: object) => void }) {
  const [state, setState] = useState<CraftState>(freshCraft);
  onPlan(craftPlan(state));
  return <CraftControls value={state} onChange={setState} />;
}

describe("editing craft controls", () => {
  it("sends only the options the person changed, plus an A/B variant", () => {
    let plan: object = {};
    render(<Harness onPlan={p => { plan = p; }} />);
    expect(plan).toEqual({});
    fireEvent.change(screen.getByLabelText("Tighten pauses"), { target: { value: "silences_and_fillers" } });
    fireEvent.click(screen.getByLabelText("Normalise loudness (−14 LUFS)"));
    fireEvent.click(screen.getByLabelText("Follow the speaker's face (9:16 crop)"));
    fireEvent.change(screen.getByLabelText("End card call to action"), { target: { value: " Follow for part 2 " } });
    fireEvent.change(screen.getByLabelText("A/B variants"), { target: { value: "structure" } });
    expect(plan).toEqual({
      jump_cuts: "silences_and_fillers", loudness: "off", crop_focus: "fixed", cta_text: "Follow for part 2", end_card: "cta",
      variants: { variable: "structure", values: ["hook_first", "linear"] },
    });
  });

  it("starts a revision from what the parent was rendered with", () => {
    const legacy = craftFromPlan({ start: 0, end: 5, hook: "x" });
    expect(legacy.values).toMatchObject({ structure: "linear", jump_cuts: "off", loudness: "off", hook_format: "overlay", crop_focus: "fixed" });
    expect(craftPlan(legacy)).toEqual({});
    const crafted = craftFromPlan({ structure: "auto", jump_cuts: "silences", hook_format: "title_card" });
    const changed = craftPlan({ ...crafted, values: { ...crafted.values, hook_format: "overlay" }, touched: ["hook_format"] });
    expect(changedEditFields({ hook_format: "title_card", jump_cuts: "silences" }, changed)).toEqual(["hook_format"]);
  });
});
