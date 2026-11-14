import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, ApiError, post } from "../api";
import {
  ConnectInstagram,
  parseConnectStart,
  parseConnectStatus,
} from "./ConnectInstagram";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ApiError: actual.ApiError, api: vi.fn(), post: vi.fn() };
});

beforeEach(() => vi.resetAllMocks());

const started = {
  request_id: "ca_new",
  status: "pending",
  redirect_url: "https://connect.composio.dev/link/lk",
  opened: true,
};

it("rejects malformed or mismatched connection replies", () => {
  expect(() =>
    parseConnectStart({ ...started, redirect_url: "javascript:alert(1)" }),
  ).toThrow();
  expect(() =>
    parseConnectStatus({ request_id: "ca_other", status: "pending" }, "ca_new"),
  ).toThrow();
  expect(() =>
    parseConnectStatus(
      { request_id: "ca_new", status: "connected", account: { id: "ca_x" } },
      "ca_new",
    ),
  ).toThrow();
});

it("waits for the browser login, then shows the connected handle", async () => {
  vi.mocked(post).mockResolvedValue(started);
  vi.mocked(api)
    .mockResolvedValueOnce({ request_id: "ca_new", status: "pending" })
    .mockResolvedValueOnce({
      request_id: "ca_new",
      status: "connected",
      account: { id: "ca_new", display_name: "new_creator" },
    });
  const onConnected = vi.fn();
  render(
    <ConnectInstagram
      profileId="profile"
      ready
      disabled={false}
      pollMs={5}
      onConnected={onConnected}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect Instagram" }));
  expect(post).toHaveBeenCalledWith("/api/automation/connect/instagram", {
    profile_id: "profile",
  });
  await screen.findByText(/Waiting for Instagram login in your browser/);
  expect(
    screen.getByRole("link", { name: /Open login page/ }),
  ).toHaveAttribute("href", started.redirect_url);
  await screen.findByText("Connected @new_creator");
  expect(onConnected).toHaveBeenCalledWith("ca_new");
  expect(api).toHaveBeenCalledWith("/api/automation/connect/ca_new");
});

it("shows expired sign-ins plainly and stops polling", async () => {
  vi.mocked(post).mockResolvedValue(started);
  vi.mocked(api).mockResolvedValue({
    request_id: "ca_new",
    status: "expired",
    message: "The sign-in link expired. Start again.",
  });
  render(
    <ConnectInstagram
      profileId="profile"
      ready
      disabled={false}
      pollMs={5}
      onConnected={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect Instagram" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The sign-in link expired. Start again.",
  );
  const calls = vi.mocked(api).mock.calls.length;
  await new Promise((r) => setTimeout(r, 30));
  expect(vi.mocked(api).mock.calls.length).toBe(calls);
  expect(
    screen.getByRole("button", { name: "Connect Instagram" }),
  ).toBeEnabled();
});

it("falls back to the dashboard import when the key cannot manage connections", async () => {
  vi.mocked(post).mockRejectedValue(
    new ApiError(
      "Your Composio key needs connected-account management permission.",
      403,
    ),
  );
  const onNeedsDashboard = vi.fn();
  render(
    <ConnectInstagram
      profileId="profile"
      ready
      disabled={false}
      onConnected={vi.fn()}
      onNeedsDashboard={onNeedsDashboard}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect Instagram" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    /connect the account in the Composio dashboard, then use Import/,
  );
  await waitFor(() => expect(onNeedsDashboard).toHaveBeenCalled());
  expect(api).not.toHaveBeenCalled();
});

it("needs saved settings before starting", () => {
  render(
    <ConnectInstagram
      profileId="profile"
      ready={false}
      disabled={false}
      onConnected={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Connect Instagram" }),
  ).toBeDisabled();
  expect(post).not.toHaveBeenCalled();
});
