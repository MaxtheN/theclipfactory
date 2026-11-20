import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Workspace } from "./useCampaignWorkspace";
import { ContourField } from "./ContourField";
import { Onboarding } from "./Onboarding";
import { startContours } from "./contours";
import { setPills } from "../test-pills";

const field = vi.hoisted(() => ({ pulse: vi.fn(), stop: vi.fn() }));

vi.mock("./contours", () => ({
  contoursSupported: () => true,
  startContours: vi.fn(() => field),
}));
vi.mock("./workspaceApi", () => ({
  workspaceApi: {
    profile: vi.fn(),
    updateProfile: vi.fn(),
    save: vi.fn(),
    profiles: vi.fn(),
    campaigns: vi.fn(),
    upload: vi.fn(),
    propose: vi.fn(),
    approve: vi.fn(),
  },
  initialDirection: () => ({ angles: [], hooks: [] }),
}));

function workspace(): Workspace {
  return {
    busy: false,
    loading: false,
    load: vi.fn().mockResolvedValue(undefined),
    setProfileId: vi.fn(),
  } as unknown as Workspace;
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(startContours).mockClear();
  field.pulse.mockClear();
  field.stop.mockClear();
});

describe("ContourField", () => {
  it("ripples from the marked origin on mount and on each new key, and stops on unmount", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ left: 100, top: 40, width: 20, height: 20 } as DOMRect);
    const view = (key: string) => (
      <section>
        <ContourField pulseKey={key} />
        <span data-ripple-origin="" />
      </section>
    );
    const { rerender, unmount } = render(view("intro"));
    expect(startContours).toHaveBeenCalledOnce();
    expect(field.pulse).toHaveBeenLastCalledWith({ x: 110, y: 50 }, 300);
    rerender(view("intro"));
    expect(field.pulse).toHaveBeenCalledTimes(1);
    rerender(view("step-2"));
    expect(field.pulse).toHaveBeenLastCalledWith({ x: 110, y: 50 }, 0);
    unmount();
    expect(field.stop).toHaveBeenCalledOnce();
    rect.mockRestore();
  });

  it("ripples from the centre when the origin isn't showing", () => {
    render(
      <section>
        <ContourField pulseKey={0} />
        <span data-ripple-origin="" hidden />
      </section>,
    );
    expect(field.pulse).toHaveBeenCalledWith(undefined, 300);
  });

  it("keeps quiet when the field can't start", () => {
    vi.mocked(startContours).mockReturnValueOnce(null);
    const { unmount } = render(
      <section>
        <ContourField pulseKey={0} />
      </section>,
    );
    unmount();
    expect(field.pulse).not.toHaveBeenCalled();
    expect(field.stop).not.toHaveBeenCalled();
  });
});

describe("Onboarding moving map", () => {
  it("runs one field from the welcome through the steps, rippling at each", () => {
    render(<Onboarding w={workspace()} onComplete={vi.fn()} askWebsite={false} intro />);
    expect(screen.getByRole("region", { name: "Brand onboarding" })).toHaveClass("has-contours");
    expect(document.querySelector(".gf-intro-aurora")).toBeNull();
    expect(startContours).toHaveBeenCalledOnce();
    expect(field.pulse).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Build my growth engine" }));
    expect(screen.getByRole("heading", { name: "Who should care?" })).toBeVisible();
    expect(startContours).toHaveBeenCalledOnce();
    expect(field.pulse).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[data-ripple-origin]")).toHaveTextContent("01");

    fireEvent.change(screen.getByRole("textbox", { name: "Name your brand / podcast" }), {
      target: { value: "Founder stories" },
    });
    setPills("Who are we speaking to?", "Founders");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(field.pulse).toHaveBeenCalledTimes(3);
    expect(document.querySelector("[data-ripple-origin]")).toHaveTextContent("02");
  });
});
