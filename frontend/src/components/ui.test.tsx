import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary, ReadOnlyValue, Unknown } from "./ui";
import { Jobs } from "./Jobs";
import { testState } from "../test-state";
describe("honest fallback UI", () => {
  it("does not convert absent, NaN, or nonnumeric metrics into zero", () => {
    render(
      <>
        <Unknown value={null} />
        <Unknown value={undefined} />
        <Unknown value={NaN} />
        <Unknown value="12" />
        <Unknown value={0} />
      </>,
    );
    expect(screen.getAllByText("Unknown")).toHaveLength(4);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
  it("renders unknown capability fields without assuming availability", () => {
    render(
      <>
        <ReadOnlyValue value={null} />
        <ReadOnlyValue value={{ unexpected_feature: { enabled: null } }} />
      </>,
    );
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText(/unexpected_feature/)).toBeInTheDocument();
  });
  it("never declares an unavailable queue to be clear", () => {
    render(<Jobs state={testState({ errors: { jobs: "Offline" } })} />);
    expect(screen.getByText("Queue status unknown")).toBeInTheDocument();
    expect(screen.queryByText("The queue is clear")).not.toBeInTheDocument();
  });
  it("shows real job errors", () => {
    const state = testState();
    state.data.jobs = [
      {
        id: "j1",
        kind: "render",
        status: "failed",
        error: "ffmpeg is missing",
      },
    ];
    render(<Jobs state={state} />);
    expect(screen.getByRole("alert")).toHaveTextContent("ffmpeg is missing");
    expect(screen.getByText("failed")).toBeInTheDocument();
  });
  it("contains rendering failures and offers recovery", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const expectedError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", expectedError);
    function Broken(): never {
      throw new Error("Invalid component");
    }
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    expect(
      screen.getByRole("heading", { name: "Something went wrong" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reload interface" }),
    ).toBeInTheDocument();
    window.removeEventListener("error", expectedError);
    consoleError.mockRestore();
  });
});
