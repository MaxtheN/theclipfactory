// Reads an owner's effective entitlement from gf_billing_subscriptions. Shared by the billing and
// posting functions so both agree on the plan without the desktop app taking part.
import { type Entitlement, entitlementFor, type SubscriptionRow } from "./plans.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface PlanSource {
  entitlement(ownerId: string): Promise<Entitlement>;
}

export class PlanSourceError extends Error {}

export const SUBSCRIPTION_COLUMNS = "owner_id,stripe_customer_id,stripe_subscription_id,plan,billing_interval," +
  "status,current_period_end,cancel_at_period_end,synced_at";

export async function readSubscription(
  url: string,
  serviceKey: string,
  ownerId: string,
  fetchImpl: FetchLike = fetch,
): Promise<SubscriptionRow | null> {
  const response = await fetchImpl(
    `${url}/rest/v1/gf_billing_subscriptions?select=${SUBSCRIPTION_COLUMNS}&owner_id=eq.${encodeURIComponent(ownerId)}`,
    {
      method: "GET",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new PlanSourceError(`subscription lookup failed (${response.status})`);
  const rows = await response.json().catch(() => null);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] as SubscriptionRow : null;
}

export class PostgrestPlanSource implements PlanSource {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async entitlement(ownerId: string): Promise<Entitlement> {
    return entitlementFor(await readSubscription(this.url, this.serviceKey, ownerId, this.fetchImpl));
  }
}
