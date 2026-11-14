import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JourneyProgress } from "./JourneyProgress";
import { SourceDetails, sourceLabel } from "./sourcePresentation";

describe("factual production journey", () => {
  it("keeps missing or non-finite work progress indeterminate instead of claiming completion", () => {
    const props = {
      state: "working" as const,
      step: 1 as const,
      title: "Inspecting source moments",
      message: "Waiting for the local worker",
      source: "Podcast 2",
    };
    const view = render(<JourneyProgress {...props} />);
    for (const progress of [undefined, null, Number.NaN, Infinity, -Infinity]) {
      view.rerender(<JourneyProgress {...props} progress={progress} />);
      const bar = screen.getByRole("progressbar", {
        name: "Production journey progress",
      });
      expect(bar).not.toHaveAttribute("value");
      expect(bar).toHaveAttribute(
        "aria-valuetext",
        "Waiting for the local worker",
      );
    }
    expect(screen.getByRole("status")).toHaveTextContent("Podcast 2");
    const stages = within(
      screen.getByRole("list", { name: "Production stages" }),
    ).getAllByRole("listitem");
    expect(stages[1]).toHaveAttribute("aria-current", "step");
    expect(stages[2]).not.toHaveAttribute("aria-current");
  });

  it("shows real zero and finite measured progress, clamps invalid ranges, and removes pending progress at review", () => {
    const props = {
      state: "working" as const,
      step: 1 as const,
      title: "Producing edits",
      message: "Rendering the selected source",
    };
    const view = render(<JourneyProgress {...props} progress={0} />);
    for (const [progress, expected] of [
      [0, 0],
      [37, 37],
      [-12, 0],
      [148, 100],
    ]) {
      view.rerender(<JourneyProgress {...props} progress={progress} />);
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "value",
        String(expected),
      );
    }
    const review = vi.fn();
    view.rerender(
      <JourneyProgress
        state="review"
        step={2}
        title="Your edits are ready"
        message="Choose an exact version to inspect"
        receipts={["3 saved edits"]}
        actions={<button onClick={review}>Review clips</button>}
      />,
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(review).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review clips" }));
    expect(review).toHaveBeenCalledOnce();
  });
});

describe("contextual source names", () => {
  it("derives aliases from campaign order without mutating source provenance or guessing an unattached index", () => {
    const source = Object.freeze({
      id: "source-b",
      name: "Founder-session-original.mov",
      duration: 90,
    });
    expect(sourceLabel(source.id, ["source-a", "source-b"])).toBe("Podcast 2");
    expect(sourceLabel(source.id, ["source-b", "source-a"])).toBe("Podcast 1");
    expect(sourceLabel(source.id, ["source-a"])).toBe("Unattached source");
    render(<SourceDetails source={source} />);
    fireEvent.click(screen.getByText("Source details"));
    expect(screen.getByText("Founder-session-original.mov")).toBeVisible();
    expect(screen.getByText("source-b")).toBeVisible();
    expect(source).toEqual({
      id: "source-b",
      name: "Founder-session-original.mov",
      duration: 90,
    });
  });
});
