import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api";
import type { Workspace } from "./useCampaignWorkspace";
import { Onboarding, OFFLINE_KEY } from "./Onboarding";
import { workspaceApi } from "./workspaceApi";
import { cloudApi, type CloudStatus } from "./cloudApi";

vi.mock("./workspaceApi", () => ({
  workspaceApi: {
    profile: vi.fn(),
    updateProfile: vi.fn(),
    save: vi.fn(),
    profiles: vi.fn(),
    campaigns: vi.fn(),
  },
}));
vi.mock("./cloudApi", () => ({
  cloudApi: {
    status: vi.fn(),
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  },
}));

const signedIn: CloudStatus = {
  configured: true,
  signed_in: true,
  email: "ana@example.com",
  workspace_id: "ws-1",
};

function start() {
  const w = {
      busy: false,
      loading: false,
      load: vi.fn().mockResolvedValue(undefined),
      setProfileId: vi.fn(),
    } as unknown as Workspace,
    complete = vi.fn();
  render(<Onboarding w={w} onComplete={complete} askAccount />);
  return { w, complete };
}
function next() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}
function toAccount() {
  fireEvent.change(
    screen.getByRole("textbox", { name: "Podcast or workspace name" }),
    { target: { value: "Founder stories" } },
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Who are we speaking to?" }),
    { target: { value: "Founders" } },
  );
  next();
  fireEvent.click(screen.getByRole("radio", { name: /^Reach new people/ }));
  next();
  next();
  expect(
    screen.getByRole("heading", { name: "Review your workspace" }),
  ).toBeInTheDocument();
  next();
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(
      (query: string) =>
        ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
        }) as MediaQueryList,
    ),
  );
  vi.mocked(workspaceApi.profile).mockImplementation(async (body) => ({
    ...body,
    id: "new-profile",
  }));
  vi.mocked(workspaceApi.save).mockImplementation(async (body) => ({
    ...body,
    id: "new-campaign",
    active_strategy_id: null,
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("account as the last onboarding step", () => {
  it("asks for email and password only after the four workspace questions", async () => {
    vi.mocked(cloudApi.signUp).mockResolvedValue(signedIn);
    const { complete } = start();
    const progress = screen.getByRole("progressbar", { name: "Setup progress" });
    expect(progress).toHaveAttribute("aria-valuemax", "5");
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    toAccount();
    expect(
      screen.getByRole("heading", {
        name: "Save your workspace to your account",
      }),
    ).toBeInTheDocument();
    expect(progress).toHaveAttribute(
      "aria-valuetext",
      "Step 5 of 5: Your account",
    );
    expect(
      screen.getByRole("tab", { name: "Create account" }),
    ).toHaveAttribute("aria-selected", "true");
    const cta = screen.getByRole("button", { name: /Create account & launch/ });
    expect(cta).toBeDisabled();
    expect(workspaceApi.profile).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(cta);
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(cloudApi.signUp).toHaveBeenCalledWith({
      email: "ana@example.com",
      password: "correct-horse",
    });
    expect(workspaceApi.profile).toHaveBeenCalledOnce();
    expect(workspaceApi.save).toHaveBeenCalledOnce();
    expect(localStorage.getItem(OFFLINE_KEY)).toBeNull();
  });

  it("continues offline: saves the workspace without the cloud and remembers the choice", async () => {
    const { complete } = start();
    toAccount();
    fireEvent.click(screen.getByRole("button", { name: "Continue offline" }));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(cloudApi.signUp).not.toHaveBeenCalled();
    expect(cloudApi.signIn).not.toHaveBeenCalled();
    expect(workspaceApi.save).toHaveBeenCalledOnce();
    expect(localStorage.getItem(OFFLINE_KEY)).toBe("1");
  });

  it("keeps the step open with a clear message when sign-in fails, then launches on retry", async () => {
    vi.mocked(cloudApi.signIn)
      .mockRejectedValueOnce(new ApiError("Email or password is incorrect.", 401))
      .mockResolvedValueOnce(signedIn);
    const { complete } = start();
    toAccount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Sign in" }));
    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: /Sign in & launch/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email or password is incorrect.",
    );
    expect(workspaceApi.profile).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Sign in & launch/ }));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  });

  it("explains email confirmation and does not launch until the user acts", async () => {
    vi.mocked(cloudApi.signUp).mockResolvedValue({
      ...signedIn,
      signed_in: false,
      email: null,
      confirmation_required: true,
      message: "Check your email to confirm your account, then sign in.",
    });
    const { complete } = start();
    toAccount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(
      screen.getByRole("button", { name: /Create account & launch/ }),
    );
    expect(
      await screen.findByText(/Check your email to confirm/),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sign in" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(complete).not.toHaveBeenCalled();
    expect(workspaceApi.profile).not.toHaveBeenCalled();
  });

  it("keeps the four-step launch when no account is needed", () => {
    const w = {
      busy: false,
      loading: false,
      load: vi.fn(),
      setProfileId: vi.fn(),
    } as unknown as Workspace;
    render(<Onboarding w={w} onComplete={vi.fn()} />);
    expect(
      screen.getByRole("progressbar", { name: "Setup progress" }),
    ).toHaveAttribute("aria-valuemax", "4");
    expect(
      screen.queryByRole("button", { name: "Go to Your account" }),
    ).not.toBeInTheDocument();
  });
});
