// Server-side billing state and identity. The production store talks to PostgREST as service_role;
// tests use MemoryBillingStore. Neither stores card data, invoices or emails.
import { type FetchLike, readSubscription } from "../_shared/plan_source.ts";
import type { SubscriptionRow } from "../_shared/plans.ts";

export interface BillingStore {
  customerFor(ownerId: string): Promise<string | null>;
  /** Saves the mapping; returns the stored customer id (an earlier concurrent save wins). */
  saveCustomer(ownerId: string, customerId: string): Promise<string>;
  ownerForCustomer(customerId: string): Promise<string | null>;
  subscription(ownerId: string): Promise<SubscriptionRow | null>;
  /** Writes unless a newer read of the subscription is already stored; true when written. */
  saveSubscription(row: SubscriptionRow): Promise<boolean>;
  eventSeen(eventId: string): Promise<boolean>;
  markEvent(eventId: string, eventType: string): Promise<void>;
  takeRate(ownerId: string, bucket: string, windowSeconds: number, limit: number): Promise<boolean>;
}

export interface BillingUser {
  id: string;
  email: string | null;
}

export interface BillingAuth {
  /** The Supabase user behind an access token, or null when the token is not valid. */
  user(accessToken: string): Promise<BillingUser | null>;
}

export class BillingStoreError extends Error {}

export class SupabaseBillingAuth implements BillingAuth {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async user(accessToken: string): Promise<BillingUser | null> {
    const response = await this.fetchImpl(`${this.url}/auth/v1/user`, {
      method: "GET",
      headers: { apikey: this.apiKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new BillingStoreError("auth lookup failed");
    const body = await response.json().catch(() => null);
    if (!body || typeof body.id !== "string") return null;
    return { id: body.id, email: typeof body.email === "string" ? body.email : null };
  }
}

export class PostgrestBillingStore implements BillingStore {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call(method: string, path: string, body?: unknown, prefer?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;
    const response = await this.fetchImpl(`${this.url}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new BillingStoreError(`store ${method} ${path.split("?")[0]} failed (${response.status})`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  private async rows(path: string): Promise<Record<string, unknown>[]> {
    const rows = await this.call("GET", path);
    return Array.isArray(rows) ? rows : [];
  }

  async customerFor(ownerId: string) {
    const rows = await this.rows(
      `gf_billing_customers?select=stripe_customer_id&owner_id=eq.${encodeURIComponent(ownerId)}`,
    );
    return typeof rows[0]?.stripe_customer_id === "string" ? rows[0].stripe_customer_id as string : null;
  }

  async saveCustomer(ownerId: string, customerId: string) {
    await this.call(
      "POST",
      "gf_billing_customers?on_conflict=owner_id",
      { owner_id: ownerId, stripe_customer_id: customerId },
      "resolution=ignore-duplicates,return=minimal",
    );
    const stored = await this.customerFor(ownerId);
    if (!stored) throw new BillingStoreError("customer mapping was not saved");
    return stored;
  }

  async ownerForCustomer(customerId: string) {
    const rows = await this.rows(
      `gf_billing_customers?select=owner_id&stripe_customer_id=eq.${encodeURIComponent(customerId)}`,
    );
    return typeof rows[0]?.owner_id === "string" ? rows[0].owner_id as string : null;
  }

  async subscription(ownerId: string) {
    try {
      return await readSubscription(this.url, this.serviceKey, ownerId, this.fetchImpl);
    } catch {
      throw new BillingStoreError("subscription lookup failed");
    }
  }

  async saveSubscription(row: SubscriptionRow) {
    const written = await this.call("POST", "rpc/gf_billing_save_subscription", {
      p_owner: row.owner_id,
      p_customer: row.stripe_customer_id,
      p_subscription: row.stripe_subscription_id,
      p_plan: row.plan,
      p_interval: row.billing_interval,
      p_status: row.status,
      p_period_end: row.current_period_end,
      p_cancel_at_period_end: row.cancel_at_period_end,
      p_synced_at: row.synced_at,
    });
    return written === true;
  }

  async eventSeen(eventId: string) {
    const rows = await this.rows(`gf_billing_events?select=event_id&event_id=eq.${encodeURIComponent(eventId)}`);
    return rows.length > 0;
  }

  async markEvent(eventId: string, eventType: string) {
    await this.call(
      "POST",
      "gf_billing_events?on_conflict=event_id",
      { event_id: eventId, event_type: eventType.slice(0, 64) },
      "resolution=ignore-duplicates,return=minimal",
    );
  }

  async takeRate(ownerId: string, bucket: string, windowSeconds: number, limit: number) {
    const allowed = await this.call("POST", "rpc/gf_billing_take", {
      p_owner: ownerId,
      p_bucket: bucket,
      p_window_seconds: windowSeconds,
      p_limit: limit,
    });
    return allowed === true;
  }
}
