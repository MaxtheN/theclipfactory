import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api";
import { CloudAccountRow, CloudSignIn } from "./CloudSignIn";
import { cloudApi, type CloudStatus } from "./cloudApi";

vi.mock("./cloudApi", () => ({
  cloudApi: {
    status: vi.fn(),
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
  },
}));

const api = vi.mocked(cloudApi);
const signedOut: CloudStatus = {
  configured: true,
  signed_in: false,
  email: null,
  workspace_id: null,
};
const signedIn: CloudStatus = {
  configured: true,
  signed_in: true,
  email: "ana@example.com",
  workspace_id: "ws-1",
};

function start() {
  const onDone = vi.fn(),
    onSkip = vi.fn();
  render(<CloudSignIn onDone={onDone} onSkip={onSkip} />);
  return { onDone, onSkip };
}

async function fill(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), password);
  return user;
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("CloudSignIn", () => {
  it("shows checking, then the form when configured and signed out", async () => {
    api.status.mockResolvedValue(signedOut);
    start();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking your account",
    );
    expect(await screen.findByRole("tab", { name: "Sign in" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  it("moves between account tabs with the arrow keys and keeps the panel linked", async () => {
    api.status.mockResolvedValue(signedOut);
    start();
    const user = userEvent.setup();
    const signIn = await screen.findByRole("tab", { name: "Sign in" });
    const signUp = screen.getByRole("tab", { name: "Create account" });
    const panel = screen.getByRole("tabpanel");
    expect(signIn).toHaveAttribute("tabindex", "0");
    expect(signUp).toHaveAttribute("tabindex", "-1");
    expect(signIn).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", signIn.id);

    signIn.focus();
    await user.keyboard("{ArrowRight}");
    expect(signUp).toHaveAttribute("aria-selected", "true");
    expect(signUp).toHaveFocus();
    expect(panel).toHaveAttribute("aria-labelledby", signUp.id);
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();

    await user.keyboard("{Home}");
    expect(signIn).toHaveAttribute("aria-selected", "true");
    expect(signIn).toHaveFocus();
  });

  it("skips straight through when the cloud is not configured", async () => {
    api.status.mockResolvedValue({ ...signedOut, configured: false });
    const { onSkip } = start();
    await waitFor(() => expect(onSkip).toHaveBeenCalledOnce());
  });

  it("finishes immediately when already signed in", async () => {
    api.status.mockResolvedValue(signedIn);
    const { onDone } = start();
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(signedIn));
  });

  it("signs in and reports the status", async () => {
    api.status.mockResolvedValue(signedOut);
    api.signIn.mockResolvedValue(signedIn);
    const { onDone } = start();
    const user = await fill("ana@example.com", "correct-horse");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(signedIn));
    expect(api.signIn).toHaveBeenCalledWith({
      email: "ana@example.com",
      password: "correct-horse",
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Signed in as ana@example.com",
    );
  });

  it("requires an 8 character password and shows submitting state", async () => {
    api.status.mockResolvedValue(signedOut);
    let resolve: (s: CloudStatus) => void = () => {};
    api.signUp.mockReturnValue(new Promise((r) => (resolve = r)));
    const { onDone } = start();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("tab", { name: "Create account" }),
    );
    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Password"), "short");
    const submit = screen.getByRole("button", { name: "Create account" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Password"), "-enough");
    await user.click(submit);
    expect(
      await screen.findByRole("button", { name: "Creating account…" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Continue offline" }),
    ).toBeDisabled();
    resolve(signedIn);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(signedIn));
  });

  it("explains email confirmation when sign-up returns no session", async () => {
    api.status.mockResolvedValue(signedOut);
    api.signUp.mockResolvedValue({
      ...signedOut,
      confirmation_required: true,
      message: "Check your email to confirm your account, then sign in.",
    });
    const { onDone } = start();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("tab", { name: "Create account" }),
    );
    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(
      await screen.findByText(/Check your email to confirm/),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sign in" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("shows a safe error and lets the user retry", async () => {
    api.status.mockResolvedValue(signedOut);
    api.signIn.mockRejectedValue(
      new ApiError("Email or password is incorrect.", 401),
    );
    start();
    const user = await fill("ana@example.com", "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email or password is incorrect.",
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("continues offline without calling the cloud", async () => {
    api.status.mockResolvedValue(signedOut);
    const { onSkip } = start();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Continue offline" }),
    );
    expect(onSkip).toHaveBeenCalledOnce();
    expect(api.signIn).not.toHaveBeenCalled();
    expect(api.signUp).not.toHaveBeenCalled();
  });

  it("keeps Continue offline available when the status check fails", async () => {
    api.status.mockRejectedValue(new ApiError("Cannot reach", 0));
    const { onSkip } = start();
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot reach");
    await userEvent.click(
      screen.getByRole("button", { name: "Continue offline" }),
    );
    expect(onSkip).toHaveBeenCalledOnce();
  });
});

describe("CloudAccountRow", () => {
  it("shows the signed-in email and signs out", async () => {
    api.status.mockResolvedValue(signedIn);
    api.signOut.mockResolvedValue(signedOut);
    render(<CloudAccountRow />);
    expect(
      await screen.findByText("Signed in as ana@example.com"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText(/Not signed in/)).toBeInTheDocument();
  });

  it("renders nothing when the cloud is not configured", async () => {
    api.status.mockResolvedValue({ ...signedOut, configured: false });
    const { container } = render(<CloudAccountRow />);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
