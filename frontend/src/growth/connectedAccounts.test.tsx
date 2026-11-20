import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectedAccounts } from "./ConnectedAccounts";
import { FirstRunAccounts } from "./FirstRunAccounts";
import { postingApi, type PostingAccount } from "./publishApi";

vi.mock("./publishApi", async (original) => {
  const actual = await original<typeof import("./publishApi")>();
  return {
    ...actual,
    postingApi: { accounts: vi.fn(), connect: vi.fn(), progress: vi.fn(), bind: vi.fn(), permit: vi.fn(), disconnect: vi.fn() },
  };
});

const api = vi.mocked(postingApi);
const account = (over: Partial<PostingAccount> = {}): PostingAccount => ({
  id: "6a0000000000000000000001", provider: "zernio", platform: "instagram", platform_label: "Instagram",
  zernio_account_id: "6a0000000000000000000001", profile_id: "brand", display_name: "brand_ig", username: "brand_ig",
  avatar_url: null, status: "active", publishing_permitted: false, verified_at: "now", updated_at: "now", ...over,
});
const tiktok = account({ id: "6a0000000000000000000002", platform: "tiktok", platform_label: "TikTok", display_name: "brand.tt" });
const unbound = account({ id: "6a0000000000000000000003", platform: "youtube", platform_label: "YouTube", display_name: "Brand channel", profile_id: null, status: "unbound" });

beforeEach(() => {
  vi.resetAllMocks();
  api.accounts.mockResolvedValue([account(), tiktok, unbound,
    account({ id: "6a0000000000000000000004", display_name: "other brand", profile_id: "other" }),
    account({ id: "6a0000000000000000000005", display_name: "gone", status: "disconnected" })]);
});

describe("ConnectedAccounts", () => {
  it("lists this brand's accounts and claimable ones, refreshing from the cloud on open", async () => {
    render(<ConnectedAccounts profileId="brand" />);
    const list = await screen.findByLabelText("Connected accounts");
    expect(api.accounts).toHaveBeenCalledWith(true);
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map(r => r.querySelector("strong")?.textContent)).toEqual(["brand_ig", "brand.tt", "Brand channel"]);
    expect(rows[0]).toHaveTextContent("Instagram · Connected");
    expect(rows[2]).toHaveTextContent("YouTube · Not linked to a brand");
    expect(screen.queryByText("other brand")).not.toBeInTheDocument();
    expect(screen.queryByText("gone")).not.toBeInTheDocument();
  });

  it("shows the app-wide posting switch only where Settings owns it", async () => {
    const onChange = vi.fn();
    const view = render(<ConnectedAccounts profileId="brand" publishing={{ enabled: false, onChange }} />);
    const master = await screen.findByRole("switch", { name: /Post from Growth Factory/ });
    expect(master).not.toBeChecked();
    expect(screen.getByText(/nothing is posted, even to allowed accounts/)).toBeInTheDocument();
    await userEvent.click(master);
    expect(onChange).toHaveBeenCalledWith(true);
    view.unmount();
    render(<ConnectedAccounts profileId="brand" />);
    await screen.findByLabelText("Connected accounts");
    expect(screen.queryByRole("switch", { name: /Post from Growth Factory/ })).not.toBeInTheDocument();
  });

  it("allows posting per account, links an unbound account, and confirms before disconnecting", async () => {
    api.permit.mockResolvedValue(account({ publishing_permitted: true }));
    api.bind.mockResolvedValue(account({ ...unbound, status: "active", profile_id: "brand" }));
    api.disconnect.mockResolvedValue({ id: tiktok.id, status: "disconnected" });
    render(<ConnectedAccounts profileId="brand" />);
    await userEvent.click(await screen.findByRole("switch", { name: "Allow posting to brand_ig on Instagram" }));
    expect(api.permit).toHaveBeenCalledWith(account().id, true);
    expect(await screen.findByText("Posting to brand_ig is allowed.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use for this brand" }));
    expect(api.bind).toHaveBeenCalledWith(unbound.id, "brand");
    await userEvent.click(screen.getByRole("button", { name: "Disconnect brand.tt on TikTok" }));
    expect(api.disconnect).not.toHaveBeenCalled();
    expect(screen.getByText(/Posting and result tracking stop for this account/)).toBeInTheDocument();
    const confirm = screen.getByRole("group", { name: "Disconnect brand.tt?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Disconnect" }));
    expect(api.disconnect).toHaveBeenCalledWith(tiktok.id);
    expect(await screen.findByText(/brand.tt is disconnected/)).toBeInTheDocument();
  });

  it("connects through the platform sign-in and polls until the account shows up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    try {
      const onConnected = vi.fn();
      api.connect.mockResolvedValue({ request_id: "req-1", platform: "tiktok", status: "pending", opened: false, auth_url: "https://zernio.example/auth" });
      api.progress.mockResolvedValueOnce({ request_id: "req-1", platform: "tiktok", status: "pending", account: null })
        .mockResolvedValueOnce({ request_id: "req-1", platform: "tiktok", status: "connected", account: tiktok });
      render(<ConnectedAccounts profileId="brand" pollMs={60_000} onConnected={onConnected} />);
      await screen.findByLabelText("Connected accounts");
      await userEvent.click(screen.getByRole("button", { name: "Connect TikTok" }));
      expect(api.connect).toHaveBeenCalledWith("tiktok", "brand");
      // The system browser did not open, so the sign-in link is the main action.
      expect(await screen.findByRole("link", { name: "Open sign-in page" })).toHaveAttribute("href", "https://zernio.example/auth");
      expect(screen.getByRole("button", { name: "Connect Instagram" })).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(onConnected).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      await waitFor(() => expect(onConnected).toHaveBeenCalledWith(tiktok));
      expect(screen.getByText(/Connected brand.tt on TikTok\. Turn on Allow posting/)).toBeInTheDocument();
      expect(api.accounts).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the person to pick when several new accounts appear, and reports expiry", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    try {
      api.connect.mockResolvedValue({ request_id: "req-2", platform: "youtube", status: "pending", opened: true, auth_url: "https://zernio.example/a" });
      api.progress.mockResolvedValueOnce({ request_id: "req-2", platform: "youtube", status: "ambiguous", account: null })
        .mockResolvedValueOnce({ request_id: "req-3", platform: "youtube", status: "expired", account: null });
      render(<ConnectedAccounts profileId="brand" pollMs={60_000} />);
      await screen.findByLabelText("Connected accounts");
      await userEvent.click(screen.getByRole("button", { name: "Connect YouTube" }));
      expect(await screen.findByRole("link", { name: "Didn't open? Open sign-in page" })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(await screen.findByText(/More than one new YouTube account appeared/)).toBeInTheDocument();
      api.connect.mockResolvedValue({ request_id: "req-3", platform: "youtube", status: "pending", opened: true, auth_url: "https://zernio.example/b" });
      await userEvent.click(screen.getByRole("button", { name: "Connect YouTube" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(await screen.findByRole("alert")).toHaveTextContent("The YouTube sign-in expired. Start again.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the server's reason when connecting is refused", async () => {
    api.connect.mockRejectedValue(new Error("Your posting plan has no free account slots."));
    render(<ConnectedAccounts profileId="brand" />);
    await screen.findByLabelText("Connected accounts");
    await userEvent.click(screen.getByRole("button", { name: "Connect Threads" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your posting plan has no free account slots.");
    expect(screen.getByRole("button", { name: "Connect Threads" })).toBeEnabled();
  });

  it("explains when accounts cannot be read, e.g. before signing in", async () => {
    api.accounts.mockRejectedValue(new Error("Sign in to Growth Factory cloud first."));
    render(<ConnectedAccounts profileId="brand" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in to Growth Factory cloud first.");
  });

  it("loads the list when React mounts it twice, as StrictMode does", async () => {
    render(<StrictMode><ConnectedAccounts profileId="brand" /></StrictMode>);
    const list = await screen.findByLabelText("Connected accounts");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByText("Loading connected accounts…")).toBeNull();
  });

  it("stops loading when the reply is not a list of accounts", async () => {
    api.accounts.mockResolvedValue(undefined as never);
    render(<ConnectedAccounts profileId="brand" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Connected accounts are unavailable.");
    expect(screen.queryByText("Loading connected accounts…")).toBeNull();
  });
});

describe("FirstRunAccounts", () => {
  beforeEach(() => localStorage.clear());

  it("offers to connect accounts until one is connected for this brand", async () => {
    api.accounts.mockResolvedValue([unbound]);
    render(<FirstRunAccounts profileId="brand" />);
    expect(await screen.findByRole("heading", { name: /Connect your accounts/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Connect Instagram" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
  });

  it("confirms a connected account and stays hidden once skipped", async () => {
    const view = render(<FirstRunAccounts profileId="brand" />);
    expect(await screen.findByText(/Connected brand_ig on Instagram/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(/Connected brand_ig/)).not.toBeInTheDocument();
    view.unmount();
    render(<FirstRunAccounts profileId="brand" />);
    await Promise.resolve();
    expect(screen.queryByRole("heading", { name: /Connect your accounts/ })).not.toBeInTheDocument();
  });
});
