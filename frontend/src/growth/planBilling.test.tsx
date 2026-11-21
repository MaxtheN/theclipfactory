import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError, PLAN_LIMIT_EVENT } from "../api";
import type { BillingState, Entitlement, Plan } from "./billingApi";

const billing = vi.hoisted(() => ({
  get: vi.fn(),
  refresh: vi.fn(),
  checkout: vi.fn(),
  portal: vi.fn(),
}));
vi.mock("./billingApi", () => ({ billingApi: billing }));
import { PlanBadge, PlanBillingSection, UpgradePrompt, resetPlanStore } from "./PlanBilling";

const PLANS: Plan[] = [
  { id: "free", name: "Free", price: { month: 0, year: 0 }, limits: { brands: 1, clips_per_month: 10, posting: false, connected_accounts: 0, factory_builder: false } },
  { id: "pro", name: "Pro", price: { month: 24, year: 19 }, limits: { brands: 3, clips_per_month: null, posting: true, connected_accounts: 5, factory_builder: false } },
  { id: "business", name: "Business", price: { month: 200, year: 160 }, limits: { brands: 25, clips_per_month: null, posting: true, connected_accounts: 50, factory_builder: true } },
];
function state(entitlement: Partial<Entitlement> = {}, usage: Partial<BillingState["usage"]> = {}, rest: Partial<BillingState> = {}): BillingState {
  const plan = PLANS.find((p) => p.id === (entitlement.plan ?? "free"))!;
  return {
    entitlement: {
      plan: plan.id,
      name: plan.name,
      status: plan.id === "free" ? "none" : "active",
      interval: plan.id === "free" ? null : "month",
      current_period_end: plan.id === "free" ? null : "2026-12-12T00:00:00Z",
      cancel_at_period_end: false,
      payment_problem: false,
      has_subscription: plan.id !== "free",
      limits: plan.limits,
      state: "confirmed",
      confirmed_at: "2026-11-18T12:00:00Z",
      grace_ends_at: null,
      message: null,
      ...entitlement,
    },
    usage: { brands: 1, clips_this_month: 3, connected_accounts: 0, month_start: "2026-11-01T07:00:00Z", resets_at: "2026-12-01T08:00:00Z", ...usage },
    plans: PLANS,
    signed_in: true,
    available: true,
    ...rest,
  };
}
const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

const showModal = HTMLDialogElement.prototype.showModal;
const close = HTMLDialogElement.prototype.close;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterAll(() => {
  HTMLDialogElement.prototype.showModal = showModal;
  HTMLDialogElement.prototype.close = close;
});
beforeEach(() => {
  resetPlanStore();
  Object.values(billing).forEach((fn) => fn.mockReset());
});
afterEach(() => {
  resetPlanStore();
  vi.useRealTimers();
});

describe("Plan and Billing Section", () => {
  it("shows a loading state, then the plan, usage and reset date", async () => {
    let resolve!: (value: BillingState) => void;
    billing.get.mockReturnValue(new Promise<BillingState>((r) => (resolve = r)));
    render(<PlanBillingSection onSignIn={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking your plan");
    await act(async () => resolve(state()));
    expect(screen.getByRole("heading", { name: "Free plan" })).toBeInTheDocument();
    const usage = screen.getByRole("list", { name: "Usage" });
    expect(within(usage).getByText("Brands").closest("li")).toHaveTextContent("1 of 1");
    expect(within(usage).getByText("Brands").closest("li")).toHaveClass("is-reached");
    expect(within(usage).getByText("Brands").closest("li")).toHaveTextContent("Limit reached");
    expect(within(usage).getByText("Clips this month").closest("li")).toHaveTextContent("3 of 10");
    expect(within(usage).getByText("Posting from the app").closest("li")).toHaveTextContent("Not included");
    expect(screen.getByText(`Clip allowance resets on ${date("2026-12-01T08:00:00Z")}.`)).toBeInTheDocument();
  });

  it("shows unlimited usage and the renewal date for a paid plan", async () => {
    billing.get.mockResolvedValue(state({ plan: "pro" }, { clips_this_month: 42, connected_accounts: 2 }));
    render(<PlanBillingSection onSignIn={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Pro plan" })).toBeInTheDocument();
    expect(screen.getByText("Billed monthly")).toBeInTheDocument();
    expect(screen.getByText(`Renews on ${date("2026-12-12T00:00:00Z")}`)).toBeInTheDocument();
    const usage = screen.getByRole("list", { name: "Usage" });
    expect(within(usage).getByText("Clips this month").closest("li")).toHaveTextContent("42 · Unlimited");
    expect(within(usage).getByText("Connected accounts").closest("li")).toHaveTextContent("2 of 5");
    expect(screen.queryByText(/Clip allowance resets/)).not.toBeInTheDocument();
  });

  it("asks a signed-out person to sign in before upgrading", async () => {
    const onSignIn = vi.fn();
    billing.get.mockResolvedValue(state({ state: "signed_out", has_subscription: false }, {}, { signed_in: false }));
    render(<PlanBillingSection onSignIn={onSignIn} />);
    expect(await screen.findByText(/Sign in to Growth Factory cloud to upgrade/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to choose Pro" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(billing.checkout).not.toHaveBeenCalled();
  });

  it("says when the plan was last confirmed while offline", async () => {
    billing.get.mockResolvedValue(state({ plan: "pro", state: "offline", grace_ends_at: "2026-11-25T12:00:00Z" }));
    render(<PlanBillingSection onSignIn={vi.fn()} />);
    expect(
      await screen.findByText(new RegExp(`Showing the plan confirmed on ${date("2026-11-18T12:00:00Z")}`)),
    ).toHaveTextContent(`It keeps working until ${date("2026-11-25T12:00:00Z")}`);
  });

  it("compares every plan monthly by default and marks the current one", async () => {
    billing.get.mockResolvedValue(state());
    render(<PlanBillingSection onSignIn={vi.fn()} />);
    const compare = await screen.findByRole("region", { name: "Compare plans" });
    expect(within(compare).getByRole("button", { name: "Monthly" })).toHaveAttribute("aria-pressed", "true");
    const pro = within(compare).getByRole("listitem", { name: "Pro plan" });
    expect(pro).toHaveTextContent("$24");
    expect(pro).toHaveTextContent("Clips per monthUnlimited");
    expect(within(compare).getByRole("listitem", { name: "Free plan" })).toHaveTextContent("Current plan");
    expect(within(compare).getByRole("listitem", { name: "Business plan" })).toHaveTextContent("Factory builderIncluded");
    fireEvent.click(within(compare).getByRole("button", { name: /Yearly/ }));
    expect(pro).toHaveTextContent("$19");
    expect(pro).toHaveTextContent("$228 billed yearly");
  });

  it("opens Checkout for the chosen interval and confirms the plan on return", async () => {
    billing.get.mockResolvedValue(state());
    billing.checkout.mockResolvedValue({ url: "https://checkout.stripe.com/c/1", opened: true });
    billing.refresh.mockResolvedValue(state({ plan: "pro", interval: "year" }));
    render(<PlanBillingSection onSignIn={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Yearly/ }));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    expect(await screen.findByText(/Finish in your browser/)).toBeInTheDocument();
    expect(billing.checkout).toHaveBeenCalledWith("pro", "year");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(billing.refresh).toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Pro plan" })).toBeInTheDocument();
    expect(screen.getByText("Billed yearly")).toBeInTheDocument();
  });

  it("shows the link when the browser could not open", async () => {
    billing.get.mockResolvedValue(state());
    billing.checkout.mockResolvedValue({ url: "https://checkout.stripe.com/c/2", opened: false });
    render(<PlanBillingSection onSignIn={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to Business" }));
    expect(await screen.findByText("https://checkout.stripe.com/c/2")).toBeInTheDocument();
  });

  it("explains why Checkout failed and leaves the plan alone", async () => {
    billing.get.mockResolvedValue(state());
    billing.checkout.mockRejectedValue(new ApiError("Plans are not on sale yet.", 502, { code: "billing_unavailable" }));
    render(<PlanBillingSection onSignIn={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to Pro" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Plans are not on sale yet.");
    expect(screen.getByRole("heading", { name: "Free plan" })).toBeInTheDocument();
  });

  it("sends subscribers to the billing portal for changes and billing", async () => {
    billing.get.mockResolvedValue(state({ plan: "pro" }));
    billing.portal.mockResolvedValue({ url: "https://billing.stripe.com/p/1", opened: true });
    render(<PlanBillingSection onSignIn={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Business" }));
    await waitFor(() => expect(billing.portal).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Manage billing" }));
    await waitFor(() => expect(billing.portal).toHaveBeenCalledTimes(2));
    expect(billing.checkout).not.toHaveBeenCalled();
  });

  it("shows the end date of a cancelled plan", async () => {
    billing.get.mockResolvedValue(state({ plan: "pro", cancel_at_period_end: true }));
    render(<PlanBillingSection onSignIn={vi.fn()} />);
    expect(await screen.findByText(`Ends on ${date("2026-12-12T00:00:00Z")}`)).toBeInTheDocument();
    expect(screen.getByText(/Your Pro plan is cancelled/)).toBeInTheDocument();
  });

  it("warns about a failed payment with a way to fix it", async () => {
    billing.get.mockResolvedValue(state({ plan: "pro", payment_problem: true, status: "past_due" }));
    billing.portal.mockResolvedValue({ url: "https://billing.stripe.com/p/1", opened: true });
    render(<PlanBillingSection onSignIn={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your last payment failed.");
    fireEvent.click(screen.getByRole("button", { name: "Fix payment" }));
    await waitFor(() => expect(billing.portal).toHaveBeenCalled());
  });

  it("offers a retry when the plan cannot be read", async () => {
    billing.get.mockRejectedValue(new ApiError("Cannot reach the local service.", 0));
    billing.refresh.mockResolvedValue(state());
    render(<PlanBillingSection onSignIn={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot reach the local service.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Free plan" })).toBeInTheDocument();
  });
});

describe("Upgrade Prompt and plan badge", () => {
  const limit = (detail: Record<string, unknown>) =>
    act(() => {
      window.dispatchEvent(new CustomEvent(PLAN_LIMIT_EVENT, { detail }));
    });

  it("names the limit and usage, and opens the comparison", async () => {
    const onCompare = vi.fn();
    render(<UpgradePrompt onCompare={onCompare} />);
    expect(screen.queryByText(/Nothing was changed/)).not.toBeInTheDocument();
    await limit({ code: "plan_limit", limit: "clips_per_month", usage: 10, max: 10, plan: "free", message: "The Free plan includes 10 clips a month." });
    expect(screen.getByText("Plan limit reached").closest("dialog")).toHaveAttribute("open");
    expect(screen.getByText("The Free plan includes 10 clips a month.")).toBeInTheDocument();
    expect(screen.getByText("10 of 10 used", { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compare plans" }));
    expect(onCompare).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("The Free plan includes 10 clips a month.")).not.toBeInTheDocument();
  });

  it("closes on Not now without doing anything else", async () => {
    const onCompare = vi.fn();
    render(<UpgradePrompt onCompare={onCompare} />);
    await limit({ code: "plan_limit", limit: "posting", usage: null, max: null, plan: "free", message: "Posting from the app needs Pro." });
    expect(screen.queryByText(/of .* used/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText("Posting from the app needs Pro.")).not.toBeInTheDocument();
    expect(onCompare).not.toHaveBeenCalled();
  });

  it("ignores events that are not plan limits", async () => {
    render(<UpgradePrompt onCompare={vi.fn()} />);
    await limit({ code: "other", message: "no" });
    expect(screen.queryByText(/Nothing was changed/)).not.toBeInTheDocument();
  });

  it("shows the plan in the sidebar and flags a payment problem", async () => {
    billing.get.mockResolvedValue(state({ plan: "pro", payment_problem: true }));
    const onOpen = vi.fn();
    render(<PlanBadge onOpen={onOpen} />);
    const badge = await screen.findByRole("button", { name: /Pro plan, needs attention/ });
    expect(badge).toHaveClass("is-warning");
    fireEvent.click(badge);
    expect(onOpen).toHaveBeenCalled();
  });

  it("rereads usage after a plan limit", async () => {
    billing.get.mockResolvedValue(state());
    render(<PlanBadge onOpen={vi.fn()} />);
    await screen.findByRole("button", { name: /Free plan/ });
    expect(billing.get).toHaveBeenCalledTimes(1);
    await limit({ code: "plan_limit", limit: "brands", usage: 1, max: 1, plan: "free", message: "m" });
    await waitFor(() => expect(billing.get).toHaveBeenCalledTimes(2));
  });
});
