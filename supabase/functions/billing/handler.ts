// Growth Factory billing function (Plans and Billing, WO-34). Holds the Stripe key, starts hosted
// Checkout and Billing Portal sessions, and mirrors Stripe subscriptions into gf_billing_subscriptions.
// See docs/billing.md for setup and the HTTP contract.

import {
  type BillingInterval,
  entitlementFor,
  INTERVALS,
  isLive,
  PAID_PLANS,
  type PlanId,
  PLANS,
  type SubscriptionRow,
} from "../_shared/plans.ts";
import { type StripeClient, type StripeResponse, stripeSignatureValid, StripeUnavailable } from "./stripe.ts";
import { type BillingAuth, type BillingStore, BillingStoreError, type BillingUser } from "./store.ts";

export type PriceTable = Record<"pro" | "business", Record<BillingInterval, string>>;

/** Per-owner limits on the authenticated routes. */
export const LIMITS = { read: { window: 60, limit: 60 }, write: { window: 60, limit: 10 } };
const MAX_BODY_BYTES = 16 * 1024;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CUSTOMER = /^cus_[A-Za-z0-9]{1,64}$/;
const SUBSCRIPTION = /^sub_[A-Za-z0-9]{1,64}$/;
const EVENT = /^evt_[A-Za-z0-9]{1,64}$/;
const STATUSES = new Set([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);

export interface BillingDeps {
  stripe: StripeClient;
  store: BillingStore;
  auth: BillingAuth;
  webhookSecret: string;
  prices: PriceTable;
  /** Website origin that hosts billing/success.html, billing/cancel.html and billing/return.html. */
  returnUrl: string;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => Date;
  limits?: typeof LIMITS;
}

type Json = Record<string, unknown>;

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A Stripe field that is either an id or an expanded object with an id. */
function idOf(value: unknown): string | null {
  return str(value) ?? (isObject(value) ? str(value.id) : null);
}

function isoFromUnix(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
}

/** "/billing/checkout" or "/functions/v1/billing/checkout" -> "/checkout". */
export function routePath(pathname: string): string {
  const at = pathname.indexOf("/billing");
  const rest = at >= 0 ? pathname.slice(at + "/billing".length) : pathname;
  return (rest || "/").replace(/\/+$/, "") || "/";
}

async function readJson(request: Request): Promise<Json> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new HttpError(413, "body_too_large", "The request body is too large.");
  }
  try {
    const parsed = text ? JSON.parse(text) : {};
    if (isObject(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_json", "Send a JSON object.");
}

function stripeFailed(response: StripeResponse): HttpError {
  if (response.status === 401) {
    return new HttpError(502, "server_misconfigured", "The billing server's Stripe key was rejected.");
  }
  if (response.status === 429 || response.status >= 500) {
    return new HttpError(502, "stripe_unavailable", "Stripe had a problem. Try again shortly.");
  }
  return new HttpError(502, "stripe_error", "Stripe refused the request. Check the billing configuration.");
}

export function createHandler(deps: BillingDeps) {
  const { stripe, store, auth } = deps;
  const now = deps.now ?? (() => new Date());
  const limits = deps.limits ?? LIMITS;
  const log = deps.log ?? (() => {});
  const priceToPlan = new Map<string, { plan: PlanId; interval: BillingInterval }>();
  for (const plan of ["pro", "business"] as const) {
    for (const interval of INTERVALS) {
      const price = deps.prices[plan]?.[interval];
      if (price) priceToPlan.set(price, { plan, interval });
    }
  }
  const returnBase = deps.returnUrl.replace(/\/+$/, "");

  async function authenticate(request: Request): Promise<BillingUser> {
    const header = request.headers.get("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new HttpError(401, "unauthorized", "Sign in to Growth Factory Cloud first.");
    const user = await auth.user(token);
    if (!user || !UUID.test(user.id)) throw new HttpError(401, "unauthorized", "Sign in again.");
    return user;
  }

  async function rate(user: BillingUser, bucket: "read" | "write") {
    const { window, limit } = limits[bucket];
    if (!(await store.takeRate(user.id, bucket, window, limit))) {
      throw new HttpError(429, "rate_limited", "Too many billing requests. Try again in a minute.");
    }
  }

  function requireStripe() {
    if (!stripe.configured || !returnBase) {
      throw new HttpError(503, "not_configured", "Billing is not set up on this server yet.");
    }
  }

  async function entitlement(user: BillingUser): Promise<Response> {
    await rate(user, "read");
    const row = await store.subscription(user.id);
    return json(200, {
      entitlement: entitlementFor(row),
      plans: Object.values(PLANS),
      checked_at: now().toISOString(),
    });
  }

  async function ensureCustomer(user: BillingUser): Promise<string> {
    const existing = await store.customerFor(user.id);
    if (existing) return existing;
    const form: Json = { metadata: { owner_id: user.id } };
    if (user.email) form.email = user.email;
    const created = await stripe.request("POST", "/customers", {
      form,
      idempotencyKey: `gf-customer-${user.id}`,
    });
    const id = created.body ? str(created.body.id) : null;
    if (created.status !== 200 || !id || !CUSTOMER.test(id)) throw stripeFailed(created);
    return await store.saveCustomer(user.id, id);
  }

  async function checkout(user: BillingUser, request: Request): Promise<Response> {
    requireStripe();
    const body = await readJson(request);
    const plan = body.plan;
    const interval = body.interval ?? "month";
    if (typeof plan !== "string" || !PAID_PLANS.includes(plan as PlanId)) {
      throw new HttpError(400, "invalid_plan", "Choose the pro or business plan.");
    }
    if (typeof interval !== "string" || !INTERVALS.includes(interval as BillingInterval)) {
      throw new HttpError(400, "invalid_interval", "Choose monthly or yearly billing.");
    }
    const price = deps.prices[plan as "pro" | "business"]?.[interval as BillingInterval];
    if (!price) throw new HttpError(503, "not_configured", "That plan is not on sale on this server yet.");
    await rate(user, "write");
    const current = await store.subscription(user.id);
    if (current && isLive(current.status)) {
      throw new HttpError(
        409,
        "subscription_exists",
        "You already have a subscription. Change or cancel it from Manage billing.",
      );
    }
    const customer = await ensureCustomer(user);
    const session = await stripe.request("POST", "/checkout/sessions", {
      form: {
        mode: "subscription",
        customer,
        client_reference_id: user.id,
        line_items: [{ price, quantity: 1 }],
        allow_promotion_codes: true,
        metadata: { owner_id: user.id },
        subscription_data: { metadata: { owner_id: user.id } },
        success_url: `${returnBase}/billing/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${returnBase}/billing/cancel.html`,
      },
    });
    const url = session.body ? str(session.body.url) : null;
    if (session.status !== 200 || !url) throw stripeFailed(session);
    return json(200, { url });
  }

  async function portal(user: BillingUser): Promise<Response> {
    requireStripe();
    await rate(user, "write");
    const customer = await store.customerFor(user.id);
    if (!customer) throw new HttpError(404, "no_customer", "There is no billing account yet. Choose a plan first.");
    const session = await stripe.request("POST", "/billing_portal/sessions", {
      form: { customer, return_url: `${returnBase}/billing/return.html` },
    });
    const url = session.body ? str(session.body.url) : null;
    if (session.status !== 200 || !url) throw stripeFailed(session);
    return json(200, { url });
  }

  /** Reads the subscription back from Stripe and stores it. Returns what happened, for the response. */
  async function sync(subscriptionId: string, ownerHint: string | null): Promise<string> {
    const read = await stripe.request("GET", `/subscriptions/${subscriptionId}`);
    if (read.status === 404) return "subscription_missing";
    if (read.status !== 200 || !read.body) throw stripeFailed(read);
    const sub = read.body;
    const customer = idOf(sub.customer);
    const status = str(sub.status);
    if (!customer || !CUSTOMER.test(customer) || !status || !STATUSES.has(status)) return "unrecognised";
    const items = isObject(sub.items) && Array.isArray(sub.items.data) ? sub.items.data : [];
    const item = isObject(items[0]) ? items[0] : {};
    const priceId = isObject(item.price) ? str(item.price.id) : null;
    const mapped = priceId ? priceToPlan.get(priceId) : undefined;
    if (!mapped) return "unknown_price";

    let owner = await store.ownerForCustomer(customer);
    if (!owner) {
      const metadata = isObject(sub.metadata) ? sub.metadata : {};
      const claimed = str(metadata.owner_id) ?? ownerHint;
      if (!claimed || !UUID.test(claimed)) return "unknown_owner";
      const stored = await store.saveCustomer(claimed, customer);
      if (stored !== customer) return "owner_mismatch";
      owner = claimed;
    }
    const row: SubscriptionRow = {
      owner_id: owner,
      stripe_customer_id: customer,
      stripe_subscription_id: subscriptionId,
      plan: mapped.plan,
      billing_interval: mapped.interval,
      status,
      current_period_end: isoFromUnix(sub.current_period_end) ?? isoFromUnix(item.current_period_end),
      cancel_at_period_end: sub.cancel_at_period_end === true,
      synced_at: now().toISOString(),
    };
    return (await store.saveSubscription(row)) ? "stored" : "stale";
  }

  /** The subscription an event concerns, across Stripe API versions. */
  function subscriptionOf(type: string, object: Json): string | null {
    if (type.startsWith("customer.subscription.")) return idOf(object.id);
    const direct = idOf(object.subscription);
    if (direct) return direct;
    const parent = isObject(object.parent) ? object.parent : {};
    const details = isObject(parent.subscription_details) ? parent.subscription_details : {};
    return idOf(details.subscription);
  }

  async function webhook(request: Request): Promise<Response> {
    if (!deps.webhookSecret) throw new HttpError(503, "not_configured", "Webhooks are not configured yet.");
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_WEBHOOK_BYTES) {
      throw new HttpError(413, "body_too_large", "The webhook body is too large.");
    }
    const header = request.headers.get("Stripe-Signature") ?? "";
    const seconds = Math.floor(now().getTime() / 1000);
    if (!(await stripeSignatureValid(deps.webhookSecret, raw, header, seconds))) {
      throw new HttpError(400, "invalid_signature", "Invalid signature.");
    }
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid_json", "Send a JSON object.");
    }
    if (!isObject(event) || !str(event.id) || !EVENT.test(event.id as string) || !str(event.type)) {
      throw new HttpError(400, "invalid_event", "The event has no id or type.");
    }
    const id = event.id as string;
    const type = event.type as string;
    if (await store.eventSeen(id)) return json(200, { received: true, duplicate: true });
    const data = isObject(event.data) ? event.data : {};
    const object = isObject(data.object) ? data.object : {};

    let outcome = "ignored";
    const relevant = type === "checkout.session.completed" || type.startsWith("customer.subscription.") ||
      type === "invoice.paid" || type === "invoice.payment_failed";
    if (relevant) {
      let ownerHint: string | null = null;
      if (type === "checkout.session.completed") {
        const metadata = isObject(object.metadata) ? object.metadata : {};
        ownerHint = str(metadata.owner_id) ?? str(object.client_reference_id);
        const customer = idOf(object.customer);
        if (ownerHint && UUID.test(ownerHint) && customer && CUSTOMER.test(customer)) {
          await store.saveCustomer(ownerHint, customer);
        }
      }
      const subscription = subscriptionOf(type, object);
      outcome = subscription && SUBSCRIPTION.test(subscription)
        ? await sync(subscription, ownerHint && UUID.test(ownerHint) ? ownerHint : null)
        : "no_subscription";
    }
    // Recorded only after the work succeeded, so a failure above makes Stripe retry the event.
    await store.markEvent(id, type);
    return json(200, { received: true, outcome });
  }

  async function route(request: Request, path: string): Promise<Response> {
    if (request.method === "POST" && path === "/webhooks/stripe") return await webhook(request);
    if (path === "/entitlement" && request.method === "GET") return await entitlement(await authenticate(request));
    if (path === "/checkout" && request.method === "POST") {
      return await checkout(await authenticate(request), request);
    }
    if (path === "/portal" && request.method === "POST") return await portal(await authenticate(request));
    throw new HttpError(404, "not_found", "No such billing route.");
  }

  return async function handle(request: Request): Promise<Response> {
    const started = Date.now();
    const path = routePath(new URL(request.url).pathname);
    let response: Response;
    try {
      response = await route(request, path);
    } catch (error) {
      if (error instanceof HttpError) {
        response = json(error.status, { error: { code: error.code, message: error.message } });
      } else if (error instanceof StripeUnavailable) {
        response = json(502, { error: { code: "stripe_unavailable", message: "Stripe could not be reached." } });
      } else if (error instanceof BillingStoreError) {
        response = json(503, { error: { code: "store_unavailable", message: "Billing state is unavailable." } });
      } else {
        response = json(500, { error: { code: "internal", message: "The billing server failed." } });
      }
    }
    // Request logs: route, status and timing only. Never bodies, tokens, emails or Stripe ids.
    log({ method: request.method, route: path.slice(0, 64), status: response.status, ms: Date.now() - started });
    return response;
  };
}
