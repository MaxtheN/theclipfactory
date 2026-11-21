// deno-lint-ignore-file require-await -- async to match the BillingStore interface exactly.
import type { BillingStore } from "./store.ts";
import type { SubscriptionRow } from "../_shared/plans.ts";

const ENDED = new Set(["canceled", "incomplete_expired"]);

/** In-memory store with the same semantics as the migration, for tests. */
export class MemoryBillingStore implements BillingStore {
  customers = new Map<string, string>();
  subscriptions = new Map<string, SubscriptionRow>();
  events = new Map<string, string>();
  rate = new Map<string, number>();

  async customerFor(ownerId: string) {
    return this.customers.get(ownerId) ?? null;
  }
  async saveCustomer(ownerId: string, customerId: string) {
    if (!this.customers.has(ownerId)) this.customers.set(ownerId, customerId);
    return this.customers.get(ownerId)!;
  }
  async ownerForCustomer(customerId: string) {
    for (const [owner, customer] of this.customers) if (customer === customerId) return owner;
    return null;
  }
  async subscription(ownerId: string) {
    const row = this.subscriptions.get(ownerId);
    return row ? { ...row } : null;
  }
  /** Mirrors gf_billing_save_subscription's WHERE clause. */
  async saveSubscription(row: SubscriptionRow) {
    const stored = this.subscriptions.get(row.owner_id);
    if (stored) {
      if (stored.synced_at > row.synced_at) return false;
      const replaceable = stored.stripe_subscription_id === row.stripe_subscription_id ||
        ENDED.has(stored.status) || !ENDED.has(row.status);
      if (!replaceable) return false;
    }
    this.subscriptions.set(row.owner_id, { ...row });
    return true;
  }
  async eventSeen(eventId: string) {
    return this.events.has(eventId);
  }
  async markEvent(eventId: string, eventType: string) {
    if (!this.events.has(eventId)) this.events.set(eventId, eventType);
  }
  async takeRate(ownerId: string, bucket: string, _windowSeconds: number, limit: number) {
    const key = `${ownerId}:${bucket}`;
    const hits = (this.rate.get(key) ?? 0) + 1;
    this.rate.set(key, hits);
    return hits <= limit;
  }
}
