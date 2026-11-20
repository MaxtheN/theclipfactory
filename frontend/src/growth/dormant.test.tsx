import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dormant } from "./Dormant";

let renders = 0;
function Screen({ value }: { value: number }) {
  renders++;
  return <p>value {value}</p>;
}
const at = (active: boolean, value: number, scope = "c1") => (
  <Dormant active={active} scope={scope}>
    <Screen key={scope} value={value} />
  </Dormant>
);

describe("Dormant destinations", () => {
  it("mounts on first visit, skips updates while hidden and catches up when shown", () => {
    renders = 0;
    const { rerender } = render(at(false, 1));
    // Never opened: nothing is built.
    expect(screen.queryByText(/value/)).toBeNull();
    rerender(at(true, 2));
    expect(screen.getByText("value 2")).toBeInTheDocument();
    rerender(at(false, 3)); // leaving renders once, so the screen sees it is hidden
    const left = renders;
    rerender(at(false, 4));
    rerender(at(false, 5));
    expect(renders).toBe(left);
    // Still mounted while hidden, so its state survives.
    expect(screen.getByText("value 3")).toBeInTheDocument();
    rerender(at(true, 6));
    expect(screen.getByText("value 6")).toBeInTheDocument();
  });

  it("follows a brand or campaign switch even while hidden", () => {
    const { rerender } = render(at(true, 1, "c1"));
    rerender(at(false, 1, "c1"));
    rerender(at(false, 2, "c2"));
    expect(screen.getByText("value 2")).toBeInTheDocument();
  });
});
