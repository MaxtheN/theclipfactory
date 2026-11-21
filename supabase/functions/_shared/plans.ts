// Growth Factory plan catalog (Plans and Billing). The billing function serves it, the posting function
// enforces it, and the engine and website mirror it (clip_factory/billing.py, landing-page/plans.json).
// Keep all four in step: tests in each place compare against plans.json.

export type PlanId = "free" | "pro" | "business";
export type BillingInterval = "month" | "year";

export interface PlanLimits {
  /** Brand profiles; null means unlimited. */
  brands: number | null;
  /** Clips produced per calendar month; null means unlimited. */
  clips_per_month: number | null;
  /** Whether the app may connect accounts and post through the posting server. */
  posting: boolean;
  /** Connected social accounts in the workspace's posting profile. */
  connected_accounts: number;
  /** Whether the factory builder may start new extension work orders. */
  factory_builder: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Whole US dollars per month, billed monthly / billed yearly. */
  price: { month: number; year: number };
  limits: PlanLimits;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    price: { month: 0, year: 0 },
    limits: { brands: 1, clips_per_month: 20, posting: false, connected_accounts: 0, factory_builder: false },
  },
  pro: {
    id: "pro",
    name: "Pro",
    price: { month: 24, year: 19 },
    limits: { brands: 3, clips_per_month: null, posting: true, connected_accounts: 3, factory_builder: false },
  },
  business: {
    id: "business",
    name: "Business",
    price: { month: 200, year: 160 },
    limits: { brands: 15, clips_per_month: null, posting: true, connected_accounts: 30, factory_builder: true },
  },
};

export const PAID_PLANS: PlanId[] = ["pro", "business"];
export const INTERVALS: BillingInterval[] = ["month", "year"];

/** Stripe statuses that keep the paid plan. past_due keeps it while Stripe retries the charge. */
const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);
/** Statuses for which Checkout is refused: the owner already has a subscription to manage in the portal. */
const LIVE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

export interface SubscriptionRow {
  owner_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  plan: PlanId;
  billing_interval: BillingInterval;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  synced_at: string;
}

export interface Entitlement {
  plan: PlanId;
  /** Stripe status of the latest subscription, or "none". */
  status: string;
  interval: BillingInterval | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  payment_problem: boolean;
  /** True when Checkout should be refused in favour of the Billing Portal. */
  has_subscription: boolean;
  limits: PlanLimits;
}

export function isLive(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

export function entitlementFor(row: SubscriptionRow | null): Entitlement {
  const paid = row !== null && PAID_STATUSES.has(row.status) && row.plan in PLANS;
  const plan: PlanId = paid ? row!.plan : "free";
  return {
    plan,
    status: row?.status ?? "none",
    interval: paid ? row!.billing_interval : null,
    current_period_end: paid ? row!.current_period_end : null,
    cancel_at_period_end: paid ? row!.cancel_at_period_end : false,
    payment_problem: row !== null && (row.status === "past_due" || row.status === "unpaid"),
    has_subscription: row !== null && isLive(row.status),
    limits: { ...PLANS[plan].limits },
  };
}
