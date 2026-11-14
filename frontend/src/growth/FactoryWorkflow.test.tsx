import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { FactoryWorkflow } from "./FactoryWorkflow";

describe("landing workflow explanation", () => {
  it.each([false, true])("explains the ordered workflow (compact=%s)", (compact) => {
    render(<FactoryWorkflow compact={compact} />);
    const list = screen.getByRole("list", { name: "Factory workflow" });
    const steps = within(list).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent("Add your footage");
    expect(steps[1]).toHaveTextContent("Produce & review");
    expect(steps[1]).toHaveTextContent("Agents shape clips. You approve.");
    expect(steps[2]).toHaveTextContent("Use feedback to guide the next edit.");
    // These are explanatory steps, not fake job statuses or clickable controls.
    expect(within(list).queryByRole("button")).not.toBeInTheDocument();
    expect(within(list).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(list.querySelector("[aria-current]")).toBeNull();
  });
});
