// deno-lint-ignore-file no-explicit-any require-await -- loose JSON shapes and sync fakes behind async interfaces.
// Billing function tests against a mocked Stripe API, an in-memory store and fake Supabase auth.
// Run: deno test --allow-read billing/

import { assert, assertEquals, assertFalse } from "@std/assert";
import { createHandler, routePath } from "./handler.ts";
import { MemoryBillingStore } from "./memory_store.ts";
import { formEncode, StripeClient, stripeSignatureValid } from "./stripe.ts";
import { entitlementFor, PLANS } from "../_shared/plans.ts";

const USER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const USER_B = "bbbbbbbb-0000-4000-8000-000000000002";
const USERS: Record<string, { id: string; email: string | null }> = {
  "token-a": { id: USER_A, email: "a@example.com" },
  "token-b": { id: USER_B, email: null },
};
const SECRET = "whsec_test";
const NOW = new Date("2026-11-21T12:00:00Z");
const PRICES = {
  pro: { month: "price_promonth", year: "price_proyear" },
  business: { month: "price_bizmonth", year: "price_bizyear" },
};

interface Call {
  method: string;
  path: string;
  form: URLSearchParams;
  idempotencyKey: string | null;
}

class FakeStripe {
  calls: Call[] = [];
  subscriptions = new Map<string, Record<string, unknown>>();
  customers = 0;
  failNext: number | null = null;

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const path = url.pathname.replace("/v1", "");
    const headers = new Headers(init.headers);
    const call: Call = {
      method: init.method ?? "GET",
      path,
      form: new URLSearchParams(typeof init.body === "string" ? init.body : ""),
      idempotencyKey: headers.get("Idempotency-Key"),
    };
    this.calls.push(call);
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (headers.get("Authorization") !== "Bearer sk_test_key") return reply(401, { error: { type: "auth" } });
    if (this.failNext !== null) {
      const status = this.failNext;
      this.failNext = null;
      return reply(status, { error: { message: "boom" } });
    }
    if (call.method === "POST" && path === "/customers") return reply(200, { id: `cus_test${++this.customers}` });
    if (call.method === "POST" && path === "/checkout/sessions") {
      return reply(200, { id: "cs_test1", url: "https://checkout.stripe.com/c/pay/cs_test1" });
    }
    if (call.method === "POST" && path === "/billing_portal/sessions") {
      return reply(200, { id: "bps_1", url: "https://billing.stripe.com/p/session/test" });
    }
    const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
    if (call.method === "GET" && sub) {
      const found = this.subscriptions.get(sub[1]);
      return found ? reply(200, found) : reply(404, { error: { message: "No such subscription" } });
    }
    return reply(404, { error: { message: "unknown route" } });
  };

  setSubscription(
    id: string,
    customer: string,
    price: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) {
    this.subscriptions.set(id, {
      id,
      object: "subscription",
      customer,
      status,
      cancel_at_period_end: false,
      metadata: {},
      items: { data: [{ price: { id: price }, current_period_end: 1798000000 }] },
      ...extra,
    });
  }
}

function setup(options: { secretKey?: string; returnUrl?: string; limit?: number } = {}) {
  const stripe = new FakeStripe();
  const store = new MemoryBillingStore();
  const logs: Record<string, unknown>[] = [];
  let clock = NOW;
  const handler = createHandler({
    stripe: new StripeClient(options.secretKey ?? "sk_test_key", stripe.fetch, "https://api.stripe.com/v1"),
    store,
    auth: { user: async (token) => USERS[token] ?? null },
    webhookSecret: SECRET,
    prices: PRICES,
    returnUrl: options.returnUrl ?? "https://growth.example/",
    log: (entry) => logs.push(entry),
    now: () => clock,
    limits: {
      read: { window: 60, limit: options.limit ?? 1000 },
      write: { window: 60, limit: options.limit ?? 1000 },
    },
  });
  const call = (method: string, path: string, options: { body?: unknown; token?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (options.token !== "") headers.Authorization = `Bearer ${options.token ?? "token-a"}`;
    return handler(
      new Request(`https://x.supabase.co/functions/v1/billing${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
    );
  };
  const deliver = async (event: Record<string, unknown>, signatureOverride?: string) => {
    const raw = JSON.stringify(event);
    const signature = signatureOverride ?? await signHeader(raw, Math.floor(clock.getTime() / 1000));
    return handler(
      new Request("https://x.supabase.co/functions/v1/billing/webhooks/stripe", {
        method: "POST",
        headers: { "Stripe-Signature": signature },
        body: raw,
      }),
    );
  };
  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };
  return { stripe, store, logs, handler, call, deliver, advance };
}

async function signHeader(raw: string, timestamp: number, secret = SECRET) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${raw}`)),
  );
  return `t=${timestamp},v1=${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

let eventCounter = 0;
function event(type: string, object: Record<string, unknown>) {
  return { id: `evt_test${++eventCounter}`, type, data: { object } };
}

async function body(response: Response) {
  return await response.json();
}

/** Buys pro monthly for USER_A through checkout and the completion webhook. */
async function subscribe(t: ReturnType<typeof setup>, price = PRICES.pro.month) {
  await t.call("POST", "/checkout", { body: { plan: "pro", interval: "month" } });
  const customer = t.store.customers.get(USER_A)!;
  t.stripe.setSubscription("sub_a1", customer, price, "active");
  const response = await t.deliver(
    event("checkout.session.completed", {
      id: "cs_test1",
      mode: "subscription",
      customer,
      subscription: "sub_a1",
      client_reference_id: USER_A,
      metadata: { owner_id: USER_A },
    }),
  );
  assertEquals(response.status, 200);
  return customer;
}

Deno.test("the website's plans.json mirrors the plan catalog", async () => {
  const raw = await Deno.readTextFile(new URL("../../../landing-page/plans.json", import.meta.url));
  const doc = JSON.parse(raw);
  assertEquals(doc.currency, "usd");
  assertEquals(doc.plans, Object.values(PLANS));
});

Deno.test("routePath strips the function prefix", () => {
  assertEquals(routePath("/functions/v1/billing/checkout"), "/checkout");
  assertEquals(routePath("/billing/webhooks/stripe/"), "/webhooks/stripe");
  assertEquals(routePath("/billing"), "/");
});

Deno.test("formEncode uses Stripe's bracket encoding", () => {
  const form = new URLSearchParams(
    formEncode({ mode: "subscription", line_items: [{ price: "p", quantity: 1 }], metadata: { a: "b" } }),
  );
  assertEquals(form.get("mode"), "subscription");
  assertEquals(form.get("line_items[0][price]"), "p");
  assertEquals(form.get("line_items[0][quantity]"), "1");
  assertEquals(form.get("metadata[a]"), "b");
});

Deno.test("signature check accepts any v1 value and rejects old or forged ones", async () => {
  const raw = '{"id":"evt_x"}';
  const good = await signHeader(raw, 1000);
  assert(await stripeSignatureValid(SECRET, raw, good, 1000));
  const v1 = good.split("v1=")[1];
  assert(await stripeSignatureValid(SECRET, raw, `t=1000,v1=${"0".repeat(64)},v1=${v1}`, 1000));
  assertFalse(await stripeSignatureValid(SECRET, raw, good, 1000 + 301));
  assertFalse(await stripeSignatureValid(SECRET, raw + " ", good, 1000));
  assertFalse(await stripeSignatureValid("whsec_other", raw, good, 1000));
  assertFalse(await stripeSignatureValid(SECRET, raw, "v1=abc", 1000));
  assertFalse(await stripeSignatureValid(SECRET, raw, "", 1000));
});

Deno.test("entitlement requires a session and defaults to Free", async () => {
  const t = setup();
  assertEquals((await t.call("GET", "/entitlement", { token: "" })).status, 401);
  assertEquals((await t.call("GET", "/entitlement", { token: "nope" })).status, 401);
  const response = await t.call("GET", "/entitlement");
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Cache-Control"), "no-store");
  const data = await body(response);
  assertEquals(data.entitlement.plan, "free");
  assertEquals(data.entitlement.status, "none");
  assertEquals(data.entitlement.limits, PLANS.free.limits);
  assertFalse(data.entitlement.has_subscription);
  assertEquals(data.plans.map((p: any) => p.id), ["free", "pro", "business"]);
  assertEquals(data.checked_at, NOW.toISOString());
});

Deno.test("checkout validates the plan and interval", async () => {
  const t = setup();
  for (const bad of [{ plan: "free" }, { plan: "enterprise" }, {}, { plan: "pro", interval: "week" }]) {
    const response = await t.call("POST", "/checkout", { body: bad });
    assertEquals(response.status, 400, JSON.stringify(bad));
  }
  assertEquals(t.stripe.calls.length, 0);
});

Deno.test("checkout creates one customer and a subscription session for the owner", async () => {
  const t = setup();
  const response = await t.call("POST", "/checkout", { body: { plan: "business", interval: "year" } });
  assertEquals(response.status, 200);
  assertEquals((await body(response)).url, "https://checkout.stripe.com/c/pay/cs_test1");
  const [customer, session] = t.stripe.calls;
  assertEquals(customer.path, "/customers");
  assertEquals(customer.idempotencyKey, `gf-customer-${USER_A}`);
  assertEquals(customer.form.get("metadata[owner_id]"), USER_A);
  assertEquals(customer.form.get("email"), "a@example.com");
  assertEquals(session.path, "/checkout/sessions");
  assertEquals(session.form.get("mode"), "subscription");
  assertEquals(session.form.get("customer"), "cus_test1");
  assertEquals(session.form.get("line_items[0][price]"), "price_bizyear");
  assertEquals(session.form.get("line_items[0][quantity]"), "1");
  assertEquals(session.form.get("client_reference_id"), USER_A);
  assertEquals(session.form.get("subscription_data[metadata][owner_id]"), USER_A);
  assertEquals(
    session.form.get("success_url"),
    "https://growth.example/billing/success.html?session_id={CHECKOUT_SESSION_ID}",
  );
  assertEquals(session.form.get("cancel_url"), "https://growth.example/billing/cancel.html");

  // A second attempt (the creator closed the first Checkout tab) reuses the same customer.
  assertEquals((await t.call("POST", "/checkout", { body: { plan: "pro" } })).status, 200);
  assertEquals(t.stripe.calls.filter((c) => c.path === "/customers").length, 1);
  assertEquals(t.stripe.calls.at(-1)!.form.get("line_items[0][price]"), "price_promonth");

  // No email on the account: the customer is created without one.
  await t.call("POST", "/checkout", { token: "token-b", body: { plan: "pro" } });
  const second = t.stripe.calls.filter((c) => c.path === "/customers")[1];
  assertEquals(second.form.get("email"), null);
});

Deno.test("checkout is refused while a subscription is live, and allowed again after it ends", async () => {
  const t = setup();
  const customer = await subscribe(t);
  const refused = await t.call("POST", "/checkout", { body: { plan: "business" } });
  assertEquals(refused.status, 409);
  assertEquals((await body(refused)).error.code, "subscription_exists");

  t.advance(60);
  t.stripe.setSubscription("sub_a1", customer, PRICES.pro.month, "canceled");
  await t.deliver(event("customer.subscription.deleted", { id: "sub_a1", customer }));
  assertEquals((await t.call("POST", "/checkout", { body: { plan: "business" } })).status, 200);
});

Deno.test("billing reports not configured without a key, return URL or price", async () => {
  for (const options of [{ secretKey: "" }, { returnUrl: "" }]) {
    const t = setup(options);
    const response = await t.call("POST", "/checkout", { body: { plan: "pro" } });
    assertEquals(response.status, 503);
    assertEquals((await body(response)).error.code, "not_configured");
    assertEquals((await t.call("POST", "/portal")).status, 503);
    // The entitlement still works, so the app keeps showing Free.
    assertEquals((await t.call("GET", "/entitlement")).status, 200);
  }
  const stripe = new FakeStripe();
  const handler = createHandler({
    stripe: new StripeClient("sk_test_key", stripe.fetch),
    store: new MemoryBillingStore(),
    auth: { user: async (token) => USERS[token] ?? null },
    webhookSecret: SECRET,
    prices: { pro: { month: "price_promonth", year: "" }, business: { month: "", year: "" } },
    returnUrl: "https://growth.example",
  });
  const response = await handler(
    new Request("https://x/functions/v1/billing/checkout", {
      method: "POST",
      headers: { Authorization: "Bearer token-a" },
      body: JSON.stringify({ plan: "pro", interval: "year" }),
    }),
  );
  assertEquals(response.status, 503);
});

Deno.test("a rejected Stripe key is reported as a server problem without leaking details", async () => {
  const t = setup({ secretKey: "sk_wrong" });
  const response = await t.call("POST", "/checkout", { body: { plan: "pro" } });
  assertEquals(response.status, 502);
  const data = await body(response);
  assertEquals(data.error.code, "server_misconfigured");
  assertFalse(JSON.stringify(data).includes("sk_wrong"));
});

Deno.test("portal needs a billing account and returns to the website", async () => {
  const t = setup();
  const missing = await t.call("POST", "/portal");
  assertEquals(missing.status, 404);
  assertEquals((await body(missing)).error.code, "no_customer");
  await subscribe(t);
  const response = await t.call("POST", "/portal");
  assertEquals(response.status, 200);
  assertEquals((await body(response)).url, "https://billing.stripe.com/p/session/test");
  const call = t.stripe.calls.at(-1)!;
  assertEquals(call.form.get("customer"), "cus_test1");
  assertEquals(call.form.get("return_url"), "https://growth.example/billing/return.html");
});

Deno.test("checkout completion grants the plan read back from Stripe", async () => {
  const t = setup();
  await subscribe(t);
  const data = await body(await t.call("GET", "/entitlement"));
  assertEquals(data.entitlement.plan, "pro");
  assertEquals(data.entitlement.interval, "month");
  assertEquals(data.entitlement.status, "active");
  assertEquals(data.entitlement.current_period_end, new Date(1798000000 * 1000).toISOString());
  assertEquals(data.entitlement.limits, PLANS.pro.limits);
  assert(data.entitlement.has_subscription);
  // Another owner is unaffected.
  assertEquals((await body(await t.call("GET", "/entitlement", { token: "token-b" }))).entitlement.plan, "free");
});

Deno.test("webhooks need a valid, recent signature", async () => {
  const t = setup();
  const forged = await t.deliver(event("customer.subscription.updated", { id: "sub_a1" }), "t=1,v1=00");
  assertEquals(forged.status, 400);
  const raw = JSON.stringify(event("customer.subscription.updated", { id: "sub_a1" }));
  const old = await signHeader(raw, Math.floor(NOW.getTime() / 1000) - 3600);
  const stale = await t.handler(
    new Request("https://x/functions/v1/billing/webhooks/stripe", {
      method: "POST",
      headers: { "Stripe-Signature": old },
      body: raw,
    }),
  );
  assertEquals(stale.status, 400);
  assertEquals(t.store.events.size, 0);
  assertEquals(t.stripe.calls.length, 0);
});

Deno.test("a webhook event is applied once", async () => {
  const t = setup();
  const customer = await subscribe(t);
  const update = event("customer.subscription.updated", { id: "sub_a1", customer });
  assertEquals((await body(await t.deliver(update))).outcome, "stored");
  const reads = t.stripe.calls.length;
  const again = await body(await t.deliver(update));
  assert(again.duplicate);
  assertEquals(t.stripe.calls.length, reads);
});

Deno.test("subscription changes follow Stripe: upgrade, payment trouble, cancellation", async () => {
  const t = setup();
  const customer = await subscribe(t);
  const plan = async () => (await body(await t.call("GET", "/entitlement"))).entitlement;

  t.advance(60);
  t.stripe.setSubscription("sub_a1", customer, PRICES.business.year, "active", { cancel_at_period_end: true });
  await t.deliver(event("customer.subscription.updated", { id: "sub_a1", customer }));
  let now = await plan();
  assertEquals([now.plan, now.interval, now.cancel_at_period_end], ["business", "year", true]);

  t.advance(60);
  t.stripe.setSubscription("sub_a1", customer, PRICES.business.year, "past_due");
  await t.deliver(event("invoice.payment_failed", { id: "in_1", customer, subscription: "sub_a1" }));
  now = await plan();
  assertEquals([now.plan, now.payment_problem], ["business", true]);

  t.advance(60);
  t.stripe.setSubscription("sub_a1", customer, PRICES.business.year, "unpaid");
  // Newer API versions put the subscription under parent.subscription_details.
  await t.deliver(
    event("invoice.payment_failed", {
      id: "in_2",
      customer,
      parent: { subscription_details: { subscription: "sub_a1" } },
    }),
  );
  now = await plan();
  assertEquals([now.plan, now.payment_problem, now.has_subscription], ["free", true, true]);

  t.advance(60);
  t.stripe.setSubscription("sub_a1", customer, PRICES.business.year, "canceled");
  await t.deliver(event("customer.subscription.deleted", { id: "sub_a1", customer }));
  now = await plan();
  assertEquals([now.plan, now.has_subscription, now.status], ["free", false, "canceled"]);
});

Deno.test("a subscription created outside the app is attributed by its owner metadata", async () => {
  const t = setup();
  t.stripe.setSubscription("sub_dash", "cus_dash", PRICES.pro.year, "active", { metadata: { owner_id: USER_B } });
  const result = await body(await t.deliver(event("customer.subscription.created", { id: "sub_dash" })));
  assertEquals(result.outcome, "stored");
  assertEquals(t.store.customers.get(USER_B), "cus_dash");
  assertEquals((await body(await t.call("GET", "/entitlement", { token: "token-b" }))).entitlement.plan, "pro");
});

Deno.test("events without a known owner or price change nothing", async () => {
  const t = setup();
  t.stripe.setSubscription("sub_x", "cus_x", PRICES.pro.month, "active");
  assertEquals(
    (await body(await t.deliver(event("customer.subscription.created", { id: "sub_x" })))).outcome,
    "unknown_owner",
  );
  t.stripe.setSubscription("sub_y", "cus_y", "price_other_product", "active", { metadata: { owner_id: USER_A } });
  assertEquals(
    (await body(await t.deliver(event("customer.subscription.created", { id: "sub_y" })))).outcome,
    "unknown_price",
  );
  assertEquals((await body(await t.deliver(event("invoice.paid", { id: "in_9" })))).outcome, "no_subscription");
  assertEquals((await body(await t.deliver(event("charge.refunded", { id: "ch_1" })))).outcome, "ignored");
  assertEquals(t.store.subscriptions.size, 0);
  // Metadata cannot move a customer that already belongs to someone else.
  await subscribe(t);
  t.stripe.setSubscription("sub_z", "cus_test1", PRICES.business.month, "active", { metadata: { owner_id: USER_B } });
  await t.deliver(event("customer.subscription.created", { id: "sub_z" }));
  assertFalse(t.store.subscriptions.has(USER_B));
});

Deno.test("a Stripe failure during sync is retried by Stripe, not recorded as done", async () => {
  const t = setup();
  const customer = await subscribe(t);
  t.advance(60);
  t.stripe.setSubscription("sub_a1", customer, PRICES.business.month, "active");
  const update = event("customer.subscription.updated", { id: "sub_a1", customer });
  t.stripe.failNext = 500;
  assertEquals((await t.deliver(update)).status, 502);
  assertFalse(t.store.events.has(update.id));
  assertEquals((await body(await t.deliver(update))).outcome, "stored");
  assertEquals(t.store.subscriptions.get(USER_A)!.plan, "business");
});

Deno.test("an older read never replaces a newer one", async () => {
  const store = new MemoryBillingStore();
  const row = {
    owner_id: USER_A,
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_new",
    plan: "pro" as const,
    billing_interval: "month" as const,
    status: "active",
    current_period_end: null,
    cancel_at_period_end: false,
    synced_at: "2026-11-21T10:00:00.000Z",
  };
  assert(await store.saveSubscription(row));
  assertFalse(await store.saveSubscription({ ...row, status: "canceled", synced_at: "2026-11-21T09:00:00.000Z" }));
  assertFalse(
    await store.saveSubscription({
      ...row,
      stripe_subscription_id: "sub_old",
      status: "canceled",
      synced_at: "2026-11-21T11:00:00.000Z",
    }),
  );
  assertEquals(entitlementFor(await store.subscription(USER_A)).plan, "pro");
});

Deno.test("authenticated routes are rate limited per owner", async () => {
  const t = setup({ limit: 2 });
  assertEquals((await t.call("GET", "/entitlement")).status, 200);
  assertEquals((await t.call("GET", "/entitlement")).status, 200);
  assertEquals((await t.call("GET", "/entitlement")).status, 429);
  assertEquals((await t.call("GET", "/entitlement", { token: "token-b" })).status, 200);
});

Deno.test("unknown routes are 404 and logs carry no identifiers", async () => {
  const t = setup();
  assertEquals((await t.call("GET", "/checkout")).status, 404);
  await subscribe(t);
  const text = JSON.stringify(t.logs);
  for (const secret of [USER_A, "cus_test1", "sub_a1", "a@example.com", "token-a"]) {
    assertFalse(text.includes(secret), secret);
  }
});
