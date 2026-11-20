import { api, post } from "../api";

export type PlanId = "free" | "pro" | "business";
export type BillingInterval = "month" | "year";
export type PlanLimits = {
  brands: number;
  /** null: unlimited. */
  clips_per_month: number | null;
  posting: boolean;
  connected_accounts: number;
  factory_builder: boolean;
};
export type Plan = { id: PlanId; name: string; price: { month: number; year: number }; limits: PlanLimits };
export type EntitlementState = "confirmed" | "offline" | "expired" | "signed_out" | "not_configured";
export type Entitlement = {
  plan: PlanId;
  name: string;
  status: string;
  interval: BillingInterval | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  payment_problem: boolean;
  has_subscription: boolean;
  limits: PlanLimits;
  state: EntitlementState;
  confirmed_at: string | null;
  grace_ends_at: string | null;
  message: string | null;
};
export type PlanUsage = {
  brands: number;
  clips_this_month: number;
  connected_accounts: number;
  month_start: string;
  resets_at: string;
};
export type BillingState = {
  entitlement: Entitlement;
  usage: PlanUsage;
  plans: Plan[];
  signed_in: boolean;
  /** False when this build has no cloud project (plans cannot be bought). */
  available: boolean;
};
export type BillingLink = { url: string; opened: boolean };
export type PlanLimitName = "brands" | "clips_per_month" | "posting" | "connected_accounts" | "factory_builder";
/** The `error` of a 402 reply. */
export type PlanLimitDetail = {
  code: "plan_limit";
  limit: PlanLimitName;
  usage: number | null;
  max: number | null;
  plan: PlanId;
  message: string;
};

export const billingApi = {
  get: () => api<BillingState>("/api/billing"),
  /** Confirms the plan with Growth Factory cloud now (after Checkout or the Billing Portal). */
  refresh: () => post<BillingState>("/api/billing/refresh"),
  checkout: (plan: Exclude<PlanId, "free">, interval: BillingInterval) =>
    post<BillingLink>("/api/billing/checkout", { plan, interval }),
  portal: () => post<BillingLink>("/api/billing/portal"),
};
