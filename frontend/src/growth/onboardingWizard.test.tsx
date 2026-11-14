import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api";
import type { Campaign, Profile } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import { Onboarding, onboardingBodies } from "./Onboarding";
import {
  LAUNCH_FADE_MS,
  LAUNCH_FALLBACK_PADDING_MS,
  LAUNCH_SWEEP_MS,
} from "./LaunchTransition";
import { workspaceApi } from "./workspaceApi";

vi.mock("./workspaceApi", () => ({
  workspaceApi: {
    profile: vi.fn(),
    updateProfile: vi.fn(),
    save: vi.fn(),
    profiles: vi.fn(),
    campaigns: vi.fn(),
    upload: vi.fn(),
  },
}));

function workspace(): Workspace {
  return {
    busy: false,
    loading: false,
    load: vi.fn().mockResolvedValue(undefined),
    setProfileId: vi.fn(),
  } as unknown as Workspace;
}
function start() {
  const w = workspace(),
    complete = vi.fn();
  render(<Onboarding w={w} onComplete={complete} />);
  return { w, complete };
}
function fillAudience() {
  fireEvent.change(
    screen.getByRole("textbox", { name: "Name your brand / podcast" }),
    { target: { value: "Founder stories" } },
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Who are we speaking to?" }),
    { target: { value: "Founders" } },
  );
}
function next() {
  fireEvent.click(
    screen.getByRole("button", { name: /^(Continue|Review changes)$/ }),
  );
}
function toVoice(goal = /^Reach new people/) {
  fillAudience();
  next();
  fireEvent.click(screen.getByRole("radio", { name: goal }));
  next();
}
function toReview(goal = /^Reach new people/) {
  toVoice(goal);
  next();
}
function launch() {
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
}
function boundaries() {
  screen
    .getByText("Voice & boundaries")
    .closest("details")
    ?.setAttribute("open", "");
  return screen.getByLabelText("What should every edit respect?");
}
function noWrites() {
  expect(workspaceApi.profile).not.toHaveBeenCalled();
  expect(workspaceApi.updateProfile).not.toHaveBeenCalled();
  expect(workspaceApi.save).not.toHaveBeenCalled();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function reducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(
      (query: string) =>
        ({
          matches: matches && query === "(prefers-reduced-motion: reduce)",
          media: query,
        }) as MediaQueryList,
    ),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  // Save/recovery tests do not depend on decorative settling time. The dedicated
  // handoff tests below explicitly opt into motion and exercise that boundary.
  reducedMotion(true);
  vi.mocked(workspaceApi.profile).mockImplementation(async (body) => ({
    ...body,
    id: "new-profile",
  }));
  vi.mocked(workspaceApi.updateProfile).mockImplementation(
    async (id, body) => ({ ...body, id }),
  );
  vi.mocked(workspaceApi.save).mockImplementation(async (body) => ({
    ...body,
    id: "new-campaign",
    active_strategy_id: null,
  }));
  vi.mocked(workspaceApi.profiles).mockResolvedValue([]);
  vi.mocked(workspaceApi.campaigns).mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

describe("guided workspace onboarding", () => {
  it("announces the current step through the progress bar in both navigation directions", () => {
    start();
    const progress = screen.getByRole("progressbar", {
      name: "Setup progress",
    });
    expect(progress).toHaveAttribute("aria-valuemin", "1");
    expect(progress).toHaveAttribute("aria-valuemax", "4");
    expect(progress).toHaveAttribute("aria-valuenow", "1");
    expect(progress).toHaveAttribute(
      "aria-valuetext",
      "Step 1 of 4: Your audience",
    );
    expect(
      screen.getByRole("button", { name: "Go to Review & launch" }),
    ).toBeDisabled();
    fillAudience();
    next();
    expect(progress).toHaveAttribute("aria-valuenow", "2");
    expect(progress).toHaveAttribute(
      "aria-valuetext",
      "Step 2 of 4: Your outcome",
    );
    fireEvent.click(screen.getByRole("button", { name: "Explore first" }));
    expect(progress).toHaveAttribute("aria-valuenow", "3");
    expect(progress).toHaveAttribute(
      "aria-valuetext",
      "Step 3 of 4: Your voice",
    );
    next();
    expect(progress).toHaveAttribute("aria-valuenow", "4");
    expect(progress).toHaveAttribute(
      "aria-valuetext",
      "Step 4 of 4: Review & launch",
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(progress).toHaveAttribute("aria-valuenow", "3");
    noWrites();
  });
  it("leaves focus alone while inactive and focuses the first question on activation", () => {
    const w = workspace(),
      complete = vi.fn();
    const { rerender } = render(
      <>
        <button autoFocus>Outside the wizard</button>
        <Onboarding active={false} w={w} onComplete={complete} />
      </>,
    );
    expect(
      screen.getByRole("button", { name: "Outside the wizard" }),
    ).toHaveFocus();
    rerender(
      <>
        <button autoFocus>Outside the wizard</button>
        <Onboarding active w={w} onComplete={complete} />
      </>,
    );
    expect(
      screen.getByRole("heading", { name: "Who are we making this for?" }),
    ).toHaveFocus();
    noWrites();
  });
  it("exposes one question stage at a time, preserves drafts and makes no writes before review launch", async () => {
    const { w, complete } = start();
    expect(
      screen.queryByText(
        "A local planning profile. No social sign-in or publishing permission needed.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    fillAudience();
    next();
    expect(
      screen.getByRole("heading", { name: "What are we working toward?" }),
    ).toHaveFocus();
    expect(
      screen.queryByRole("textbox", { name: "Name your brand / podcast" }),
    ).not.toBeInTheDocument();
    noWrites();
    fireEvent.click(screen.getByRole("radio", { name: /^Reach new people/ }));
    next();
    expect(
      screen.getByRole("heading", { name: "How should your edits feel?" }),
    ).toHaveFocus();
    fireEvent.click(
      screen.getByRole("radio", { name: /^Stories that stay with you/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("radio", { name: /^Reach new people/ }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.getByRole("textbox", { name: "Name your brand / podcast" }),
    ).toHaveValue("Founder stories");
    expect(
      screen.getByRole("textbox", { name: "Who are we speaking to?" }),
    ).toHaveValue("Founders");
    next();
    next();
    expect(
      screen.getByRole("radio", { name: /^Stories that stay with you/ }),
    ).toBeChecked();
    next();
    expect(
      screen.getByRole("heading", { name: "Review your brand" }),
    ).toHaveFocus();
    noWrites();
    launch();
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(workspaceApi.profile).toHaveBeenCalledWith(
      expect.objectContaining({
        creative_preferences: expect.stringContaining(
          "Stories that stay with you",
        ),
      }),
    );
    // The goal belongs to the first campaign; the workspace keeps audience and voice.
    expect(vi.mocked(workspaceApi.profile).mock.calls[0][0]).not.toHaveProperty("objective");
    expect(workspaceApi.save).toHaveBeenCalledWith(
      expect.objectContaining({
        // The first (automatic) campaign is "<Brand> — main".
        name: "Founder stories — main",
        profile_ids: ["new-profile"],
        video_ids: [],
        objective: "awareness",
        primary_metric: "reach",
      }),
    );
    expect(w.load).toHaveBeenCalledWith("new-campaign");
    expect(w.setProfileId).toHaveBeenCalledWith("new-profile");
    expect(workspaceApi.upload).not.toHaveBeenCalled();
  });
  it.each([
    [/^Reach new people/, "awareness", "reach"],
    [/^Drive full-episode visits/, "traffic", "full_episode_visits"],
    [/^Generate qualified leads/, "leads", "qualified_leads"],
  ])(
    "maps familiar suggested outcomes to the actual saved objective and metric",
    async (label, objective, metric) => {
      const { complete } = start();
      toReview(label as RegExp);
      noWrites();
      launch();
      await waitFor(() => expect(complete).toHaveBeenCalledOnce());
      expect(workspaceApi.save).toHaveBeenCalledWith(
        expect.objectContaining({ objective, primary_metric: metric }),
      );
    },
  );
  it("requires an explicit outcome choice or Discovery, and Discovery leaves the primary metric unset", async () => {
    const { complete } = start();
    fillAudience();
    next();
    next();
    expect(screen.getByRole("alert")).toHaveTextContent(/Choose an outcome/);
    noWrites();
    fireEvent.click(screen.getByRole("button", { name: "Explore first" }));
    expect(
      screen.getByRole("heading", { name: "How should your edits feel?" }),
    ).toHaveFocus();
    next();
    launch();
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(workspaceApi.save).toHaveBeenCalledWith(
      expect.objectContaining({ objective: "discovery", primary_metric: null }),
    );
  });
  it("validates Other outcome/metric and creative voice, then preserves their exact semantics", async () => {
    const { complete } = start();
    fillAudience();
    next();
    fireEvent.click(screen.getByRole("radio", { name: /^Other/ }));
    next();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Describe your outcome/,
    );
    noWrites();
    fireEvent.change(screen.getByLabelText("Your outcome"), {
      target: { value: "Book qualified demos" },
    });
    next();
    expect(screen.getByRole("alert")).toHaveTextContent(/primary metric/);
    fireEvent.change(screen.getByLabelText("Primary metric"), {
      target: { value: "qualified_demo_requests" },
    });
    next();
    fireEvent.click(screen.getByRole("radio", { name: /^Other/ }));
    next();
    expect(screen.getByRole("alert")).toHaveTextContent(/Describe how/);
    noWrites();
    fireEvent.change(screen.getByLabelText("Your creative direction"), {
      target: {
        value: "Thoughtful founder stories, with the original context intact.",
      },
    });
    next();
    launch();
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(workspaceApi.profile).toHaveBeenCalledWith(
      expect.objectContaining({
        creative_preferences:
          "Thoughtful founder stories, with the original context intact.",
      }),
    );
    expect(workspaceApi.save).toHaveBeenCalledWith(
      expect.objectContaining({
        objective: "custom",
        primary_metric: "qualified_demo_requests",
        brief: expect.objectContaining({
          measurement_intent: expect.stringContaining("Book qualified demos"),
        }),
      }),
    );
  });
  it("edits review choices without discarding other drafts or writing early", () => {
    start();
    toReview(/^Drive full-episode visits/);
    fireEvent.click(screen.getByRole("button", { name: "Edit audience" }));
    expect(screen.getByLabelText("Who are we speaking to?")).toHaveValue(
      "Founders",
    );
    fireEvent.change(screen.getByLabelText("Who are we speaking to?"), {
      target: { value: "Early-stage founders" },
    });
    next();
    expect(
      screen.getByRole("heading", { name: "Review your brand" }),
    ).toHaveFocus();
    expect(screen.getByText("Early-stage founders")).toBeInTheDocument();
    noWrites();
    fireEvent.click(screen.getByRole("button", { name: "Edit outcome" }));
    expect(
      screen.getByRole("radio", { name: /^Drive full-episode visits/ }),
    ).toBeChecked();
    fireEvent.click(
      screen.getByRole("radio", { name: /^Generate qualified leads/ }),
    );
    next();
    expect(
      screen.getByRole("heading", { name: "Review your brand" }),
    ).toHaveFocus();
    noWrites();
  });
  it("revalidates an earlier edit before progress navigation can return to launch", () => {
    start();
    toReview();
    fireEvent.click(screen.getByRole("button", { name: "Edit audience" }));
    fireEvent.change(screen.getByLabelText("Who are we speaking to?"), {
      target: { value: "" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Go to Review & launch",
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("1–3,000 characters");
    expect(
      screen.queryByRole("button", { name: "Launch" }),
    ).not.toBeInTheDocument();
    noWrites();
    fireEvent.change(screen.getByLabelText("Who are we speaking to?"), {
      target: { value: "A corrected audience" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Go to Review & launch",
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Review your brand" }),
    ).toHaveFocus();
    noWrites();
  });
  it("supports keyboard choices and Continue while moving focus to the new heading", async () => {
    const user = userEvent.setup();
    const { complete } = start();
    fillAudience();
    screen.getByRole("button", { name: "Continue" }).focus();
    await user.keyboard("{Enter}");
    const outcome = screen.getByRole("radio", { name: /^Reach new people/ });
    outcome.focus();
    await user.keyboard(" ");
    expect(outcome).toBeChecked();
    screen.getByRole("button", { name: "Continue" }).focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("heading", { name: "How should your edits feel?" }),
    ).toHaveFocus();
    screen.getByRole("button", { name: "Continue" }).focus();
    await user.keyboard("{Enter}");
    noWrites();
    screen.getByRole("button", { name: "Launch" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  });
  it("keeps keyboard navigation and explicit saving available when reduced motion is requested", async () => {
    const previous = Object.getOwnPropertyDescriptor(window, "matchMedia");
    const matchMedia = vi.fn(
      (query: string) =>
        ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
        }) as MediaQueryList,
    );
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: matchMedia,
    });
    try {
      const user = userEvent.setup(),
        { w, complete } = start(),
        reload = deferred<void>();
      vi.mocked(w.load).mockReturnValueOnce(reload.promise);
      fillAudience();
      screen.getByRole("button", { name: "Continue" }).focus();
      await user.keyboard("{Enter}");
      expect(
        screen.getByRole("heading", { name: "What are we working toward?" }),
      ).toHaveFocus();
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
      noWrites();
      fireEvent.click(screen.getByRole("radio", { name: /^Reach new people/ }));
      next();
      next();
      const launchButton = screen.getByRole("button", {
        name: "Launch",
      });
      expect(launchButton).toBeEnabled();
      launchButton.focus();
      await user.keyboard("{Enter}");
      expect(
        screen.getByRole("status", { name: "Making it yours" }),
      ).toHaveTextContent("All saved. Opening Factory…");
      expect(complete).not.toHaveBeenCalled();
      await act(async () => reload.resolve());
      expect(complete).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("button", { name: "Open Factory" }),
      ).toBeEnabled();
      expect(workspaceApi.profile).toHaveBeenCalledTimes(1);
      expect(workspaceApi.save).toHaveBeenCalledTimes(1);
    } finally {
      if (previous) Object.defineProperty(window, "matchMedia", previous);
      else Reflect.deleteProperty(window, "matchMedia");
    }
  });
  it("locks repeated final submissions and starts the actual write immediately", async () => {
    let resolveProfile!: (p: Profile) => void;
    vi.mocked(workspaceApi.profile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProfile = resolve;
        }),
    );
    const { complete } = start();
    toReview();
    const form = screen
      .getByRole("button", { name: "Launch" })
      .closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(workspaceApi.profile).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Back" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Making it yours" }),
    ).toHaveTextContent("Saving your audience and creative voice…");
    await act(async () =>
      resolveProfile({
        ...vi.mocked(workspaceApi.profile).mock.calls[0][0],
        id: "new-profile",
      }),
    );
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(workspaceApi.save).toHaveBeenCalledTimes(1);
  });
  it("announces only confirmed save stages and holds the submission lock through the bounded ready handoff", async () => {
    reducedMotion(false);
    vi.useFakeTimers();
    try {
      const profile = deferred<Profile>(),
        campaign = deferred<Campaign>(),
        reload = deferred<void>();
      vi.mocked(workspaceApi.profile).mockReturnValueOnce(profile.promise);
      vi.mocked(workspaceApi.save).mockReturnValueOnce(campaign.promise);
      const w = workspace(),
        complete = vi.fn(),
        busy = vi.fn();
      vi.mocked(w.load).mockReturnValueOnce(reload.promise);
      render(<Onboarding w={w} onComplete={complete} onBusyChange={busy} />);
      toReview();
      const form = screen
        .getByRole("button", { name: "Launch" })
        .closest("form")!;
      fireEvent.submit(form);
      expect(workspaceApi.profile).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("heading", { name: "Making it yours" }),
      ).toHaveFocus();
      expect(
        screen.getByRole("status", { name: "Making it yours" }),
      ).toHaveTextContent("Saving your audience and creative voice…");
      expect(
        screen.queryByRole("navigation", { name: "Brand setup" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Launch" }),
      ).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(workspaceApi.save).not.toHaveBeenCalled();
      expect(w.load).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      await act(async () =>
        profile.resolve({
          ...vi.mocked(workspaceApi.profile).mock.calls[0][0],
          id: "confirmed-profile",
        }),
      );
      expect(
        screen.getByRole("status", { name: "Making it yours" }),
      ).toHaveTextContent("Your brand is saved. Setting up your goals…");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(w.load).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      await act(async () =>
        campaign.resolve({
          ...vi.mocked(workspaceApi.save).mock.calls[0][0],
          id: "confirmed-campaign",
          active_strategy_id: null,
        }),
      );
      expect(
        screen.getByRole("status", { name: "Making it yours" }),
      ).toHaveTextContent("All saved. Opening Factory…");
      expect(w.load).toHaveBeenCalledWith("confirmed-campaign");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(complete).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("heading", { name: "Your brand is ready" }),
      ).not.toBeInTheDocument();
      await act(async () => reload.resolve());
      expect(
        screen.getByRole("status", { name: "Your brand is ready" }),
      ).toHaveTextContent("Your choices are saved.");
      expect(w.setProfileId).toHaveBeenCalledWith("confirmed-profile");
      expect(busy).toHaveBeenLastCalledWith(true);
      fireEvent.submit(form);
      fireEvent.submit(form);
      expect(workspaceApi.profile).toHaveBeenCalledOnce();
      expect(workspaceApi.save).toHaveBeenCalledOnce();
      expect(w.load).toHaveBeenCalledOnce();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          LAUNCH_SWEEP_MS + LAUNCH_FALLBACK_PADDING_MS - 1,
        );
      });
      expect(complete).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(complete).not.toHaveBeenCalled();
      expect(busy).toHaveBeenLastCalledWith(true);
      fireEvent.submit(form);
      expect(workspaceApi.profile).toHaveBeenCalledOnce();
      expect(workspaceApi.save).toHaveBeenCalledOnce();
      expect(w.load).toHaveBeenCalledOnce();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          LAUNCH_FADE_MS + LAUNCH_FALLBACK_PADDING_MS - 1,
        );
      });
      expect(complete).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(complete).toHaveBeenCalledOnce();
      expect(busy).toHaveBeenLastCalledWith(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([0, LAUNCH_SWEEP_MS + LAUNCH_FALLBACK_PADDING_MS])(
    "cancels the pending launch handoff when onboarding unmounts after %i ms",
    async (elapsed) => {
      reducedMotion(false);
      vi.useFakeTimers();
      try {
        const complete = vi.fn(),
          busy = vi.fn();
        const { unmount } = render(
          <Onboarding
            w={workspace()}
            onComplete={complete}
            onBusyChange={busy}
          />,
        );
        toReview();
        await act(async () => launch());
        expect(
          screen.getByRole("status", { name: "Your brand is ready" }),
        ).toBeVisible();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(elapsed);
        });
        expect(complete).not.toHaveBeenCalled();
        unmount();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        expect(complete).not.toHaveBeenCalled();
        expect(busy).toHaveBeenLastCalledWith(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("onboarding validation and write recovery", () => {
  it("returns a rejected launch to the review draft without a delayed success callback", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(workspaceApi.profile).mockRejectedValueOnce(
        new ApiError("Audience needs clarification", 422),
      );
      const { complete } = start();
      toReview();
      await act(async () => launch());
      expect(
        screen.queryByRole("status", { name: "Making it yours" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Review your brand" }),
      ).toBeVisible();
      expect(screen.getByRole("alert")).toHaveFocus();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Audience needs clarification",
      );
      expect(
        screen.getByRole("button", { name: "Launch" }),
      ).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Edit audience" }));
      expect(screen.getByLabelText("Who are we speaking to?")).toHaveValue(
        "Founders",
      );
      expect(screen.getByLabelText("Who are we speaking to?")).toBeEnabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(complete).not.toHaveBeenCalled();
      expect(workspaceApi.profile).toHaveBeenCalledOnce();
      expect(workspaceApi.save).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    [
      "x".repeat(1201),
      "Keep each voice or boundary line within 1,200 characters.",
    ],
    [
      Array.from({ length: 31 }, (_, i) => `Boundary ${i}`).join("\n"),
      "Use up to 30 voice and boundary lines.",
    ],
    [
      "x".repeat(4001),
      "Keep voice and boundaries within 4,000 characters in total.",
    ],
  ])(
    "validates all guardrail limits before any write and retains editable inputs",
    async (value, message) => {
      const { complete } = start();
      toVoice();
      const field = boundaries();
      fireEvent.change(field, { target: { value } });
      next();
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      noWrites();
      expect(field).toBeEnabled();
      fireEvent.change(field, { target: { value: "Keep context." } });
      next();
      launch();
      await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    },
  );
  it("validates the narrower profile audience limit before progressing or creating", () => {
    start();
    fillAudience();
    fireEvent.change(screen.getByLabelText("Who are we speaking to?"), {
      target: { value: "a".repeat(3001) },
    });
    next();
    expect(screen.getByRole("alert")).toHaveTextContent("1–3,000 characters");
    noWrites();
    expect(screen.getByLabelText("Who are we speaking to?")).toBeEnabled();
  });
  it("enforces optional voice and natural-language outcome limits in the shared body builder", () => {
    const body = {
      name: "Show",
      audience: "Founders",
      objective: "awareness",
      metric: "reach",
      guardrails: "Keep context",
    };
    expect(() =>
      onboardingBodies({ ...body, creativePreference: "v".repeat(4001) }),
    ).toThrow(/4,000 characters/);
    expect(() =>
      onboardingBodies({ ...body, outcomeLabel: "o".repeat(201) }),
    ).toThrow(/200 characters/);
  });
  it("keeps 422 failures visible through correction and updates the confirmed profile instead of duplicating it", async () => {
    vi.mocked(workspaceApi.save).mockRejectedValueOnce(
      new ApiError("Correct the workspace details", 422),
    );
    const { complete } = start();
    toReview();
    launch();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Edit audience" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Correct your details");
    const audience = screen.getByLabelText("Who are we speaking to?");
    expect(audience).toBeEnabled();
    fireEvent.change(audience, { target: { value: "Early-stage founders" } });
    next();
    expect(screen.getByRole("alert")).toHaveTextContent("Correct your details");
    launch();
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(workspaceApi.profile).toHaveBeenCalledTimes(1);
    expect(workspaceApi.updateProfile).toHaveBeenCalledWith(
      "new-profile",
      expect.objectContaining({ audience: "Early-stage founders" }),
    );
    expect(workspaceApi.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        profile_ids: ["new-profile"],
        brief: expect.objectContaining({ audience: "Early-stage founders" }),
      }),
    );
  });
  it("reconciles a failed campaign response before resubmitting and reuses the confirmed profile", async () => {
    vi.mocked(workspaceApi.save).mockRejectedValueOnce(
      new Error("Connection interrupted"),
    );
    const { complete } = start();
    toReview();
    launch();
    const check = await screen.findByRole("button", {
      name: "Check saved goals",
    });
    expect(
      screen.getByRole("button", { name: "Launch" }),
    ).toBeDisabled();
    fireEvent.click(check);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Launch" }),
      ).toBeEnabled(),
    );
    launch();
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(workspaceApi.profile).toHaveBeenCalledTimes(1);
    expect(workspaceApi.save).toHaveBeenCalledTimes(2);
  });
  it("adopts an ambiguously committed profile rather than creating it twice", async () => {
    let saved!: Profile;
    vi.mocked(workspaceApi.profile).mockImplementationOnce(async (body) => {
      saved = { ...body, id: "already-saved" };
      throw new Error("Response lost");
    });
    vi.mocked(workspaceApi.profiles).mockImplementation(async () => [saved]);
    const { complete } = start();
    toReview();
    launch();
    fireEvent.click(
      await screen.findByRole("button", { name: "Check saved brands" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Launch" }),
      ).toBeEnabled(),
    );
    launch();
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(workspaceApi.profile).toHaveBeenCalledTimes(1);
    expect(workspaceApi.save).toHaveBeenCalledWith(
      expect.objectContaining({ profile_ids: ["already-saved"] }),
    );
  });
  it("adopts a confirmed workspace from reconciliation and opens it without repeating either create", async () => {
    let saved!: Campaign;
    vi.mocked(workspaceApi.save).mockImplementationOnce(async (body) => {
      saved = {
        ...body,
        id: "already-saved-campaign",
        active_strategy_id: null,
      };
      throw new Error("Response lost");
    });
    vi.mocked(workspaceApi.campaigns).mockImplementation(async () => [saved]);
    const { w, complete } = start();
    toReview();
    launch();
    fireEvent.click(
      await screen.findByRole("button", { name: "Check saved goals" }),
    );
    const open = await screen.findByRole("button", { name: "Open Factory" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(workspaceApi.profile).toHaveBeenCalledTimes(1);
    expect(workspaceApi.save).toHaveBeenCalledTimes(1);
    expect(w.load).toHaveBeenCalledWith("already-saved-campaign");
  });
  it("retries only the refresh after both writes have succeeded", async () => {
    const { w, complete } = start();
    vi.mocked(w.load)
      .mockRejectedValueOnce(new Error("Read failed"))
      .mockResolvedValue(undefined);
    toReview();
    launch();
    const open = await screen.findByRole("button", { name: "Open Factory" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(workspaceApi.profile).toHaveBeenCalledTimes(1);
    expect(workspaceApi.save).toHaveBeenCalledTimes(1);
    expect(w.load).toHaveBeenCalledTimes(2);
  });
});
