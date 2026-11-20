# Plans and billing (Stripe)

Growth Factory sells three plans as a self-serve subscription. Stripe is the source of truth: hosted Checkout takes
payment, the hosted Billing Portal handles plan changes, cards, invoices and cancellation, and a Supabase Edge Function
(`billing`) mirrors each owner's subscription into Supabase. The desktop app never holds a Stripe key and never decides
its own plan; it reads the entitlement from the cloud.

- Code: `supabase/functions/billing/` (`index.ts` wiring, `handler.ts` routes, `stripe.ts` client and signature check,
  `store.ts` persistence, `memory_store.ts` + `handler_test.ts` tests); `supabase/functions/_shared/plans.ts` (the plan
  catalog) and `_shared/plan_source.ts` (entitlement lookup shared with the posting function).
- Schema: `supabase/migrations/202611210001_billing.sql`; probe: `supabase/tests/billing_rls.sql`.
- URL: `https://spdtisizhcepmsogjvnr.supabase.co/functions/v1/billing/<route>`.
- Spec: requirements and blueprint "Plans and Billing" in the project.

## Plans

The catalog lives in `supabase/functions/_shared/plans.ts` and is mirrored to `landing-page/plans.json` (website) and
`clip_factory/billing.py` (engine). Tests in each place compare against `plans.json`, so a price or limit change must
update all three, plus the Stripe prices.

| | Free | Pro | Business |
| --- | --- | --- | --- |
| Price | $0 | $24 / month, or $19 / month billed yearly ($228) | $200 / month, or $160 / month billed yearly ($1,920) |
| Brands | 1 | 3 | 15 |
| Clips per month | 20 | Unlimited | Unlimited |
| Post from the app (connect accounts, schedule, publish) | No | Yes | Yes |
| Connected social accounts | 0 | 3 | 30 |
| Factory builder (agent-built extensions) | No | No | Yes |

Everything else (local clip production, Studio editing, exports, Learning Loop insights, cloud sign-in and sync) is in
every plan. Posting limits are enforced by the cloud (the posting function refuses requests). Brand, clip and factory
builder limits are enforced by the desktop engine from the cached entitlement.

Why these numbers: Opus Clip sells Starter at $15 and Pro at $29 a month; Growth Factory Pro adds autonomous posting
and learning, so $24 sits between them. Zernio bills the shared posting account per connected account across all
customers: the first 2 are free, then $6 each up to 10, $3 each up to 100 and $1 each beyond. A Pro customer's 3
accounts therefore cost up to $18 a month while there are only a handful of customers, falling to about $9 at 11-100
and $3 past 100 accounts in total; Business (30 accounts) costs $30-90. Watch the margin on Pro until the account
total passes 10, and raise the Pro price or lower its account limit if early customers all max out.

## How an entitlement is decided

`entitlementFor(row)` in `_shared/plans.ts`:

- No subscription row: **Free** (`status: "none"`).
- `active`, `trialing` or `past_due`: the subscribed plan. `past_due` keeps the plan while Stripe retries the card and
  sets `payment_problem: true`, so the app shows a fix-payment banner.
- `unpaid`, `incomplete`, `incomplete_expired`, `paused`, `canceled`: **Free**. `unpaid` also sets `payment_problem`.
- `has_subscription` is true while the status is live (anything except `canceled` and `incomplete_expired`); Checkout is
  then refused with `409 subscription_exists` and the app opens the Billing Portal instead.
- Cancelling in the portal sets `cancel_at_period_end`; the plan stays until Stripe ends the subscription.

The desktop app caches the entitlement and uses it for up to 7 days offline, then falls back to Free until it can
reach the cloud. Signed out is Free. Downgrading never deletes work: extra brands become read-only for new runs, extra
connected accounts stay connected but posting is held until they fit the plan.

## HTTP contract

All routes except the webhook need `Authorization: Bearer <Supabase access token>` (the app's cloud sign-in).
Responses are JSON with `Cache-Control: no-store`; errors are `{"error": {"code", "message"}}`.

| Route | Response |
| --- | --- |
| `GET /entitlement` | `{entitlement: {plan, status, interval, current_period_end, cancel_at_period_end, payment_problem, has_subscription, limits}, plans: [...], checked_at}` |
| `POST /checkout` `{plan: "pro" \| "business", interval?: "month" \| "year"}` | `{url}`: a Stripe Checkout page to open in the browser. `409 subscription_exists` while a subscription is live. |
| `POST /portal` | `{url}`: the Stripe Billing Portal. `404 no_customer` before the first checkout. |
| `POST /webhooks/stripe` | Stripe delivery endpoint (`Stripe-Signature` verified, 5-minute tolerance). |

Other codes: `401 unauthorized`, `400 invalid_plan` / `invalid_interval` / `invalid_json`, `429 rate_limited` (60
reads and 10 writes per minute per owner), `502 stripe_unavailable` / `stripe_error` / `server_misconfigured` (Stripe
rejected the key), `503 not_configured` (missing key, price or return URL) / `store_unavailable`.

Checkout returns the buyer to `BILLING_RETURN_URL/billing/success.html?session_id=...` or
`BILLING_RETURN_URL/billing/cancel.html`; the portal returns to `BILLING_RETURN_URL/billing/return.html`. The website
ships those pages; they tell the creator to switch back to the app, which refreshes its plan.

## Webhooks

The function never trusts the event body for plan state. For each relevant event it reads the subscription back from
Stripe (`GET /v1/subscriptions/:id`) and stores that, with the time it was read:

- `checkout.session.completed`: records the owner to customer mapping, then syncs the subscription.
- `customer.subscription.created|updated|deleted|paused|resumed|trial_will_end`: syncs that subscription.
- `invoice.paid`, `invoice.payment_failed`: syncs the invoice's subscription (both API shapes are read).
- Anything else is acknowledged and ignored.

Rules: an older read never overwrites a newer one; a late event for an old, ended subscription cannot hide the current
one; a price that is not one of the four configured prices is ignored; the owner comes from the stored customer
mapping (created at checkout), and only for an unknown customer from `metadata.owner_id`. Each event id is recorded
after it is applied, so retries are no-ops, and a Stripe or database failure returns an error so Stripe retries.

## Set up Stripe (owner, once)

Do this in **test mode** first, run the smoke test below, then repeat in live mode.

1. **Products and prices.** Product catalog, then create:
   - "Growth Factory Pro": recurring USD prices of $24.00 monthly and $228.00 yearly.
   - "Growth Factory Business": recurring USD prices of $200.00 monthly and $1,920.00 yearly.

   Copy the four price ids (`price_...`).
2. **Customer portal.** Settings, Billing, Customer portal: allow updating payment methods, viewing invoices,
   cancelling (at the end of the billing period) and switching plans between the four prices above (prorate). Set the
   business name, privacy policy and terms links (the website's `privacy.html` and `terms.html`).
3. **Retries.** Settings, Billing, Subscriptions and emails: turn on Smart Retries and choose "cancel the subscription"
   (or "mark as unpaid") when all retries fail. Turn on Stripe's failed-payment and upcoming-renewal emails.
4. **Webhook.** Developers, Webhooks, add endpoint
   `https://spdtisizhcepmsogjvnr.supabase.co/functions/v1/billing/webhooks/stripe` with events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`,
   `invoice.payment_failed`. Copy the signing secret (`whsec_...`).
5. **Tax (optional).** Prices are tax-exclusive and Stripe Tax is not switched on by the function. If you register for
   tax collection, add `automatic_tax[enabled]=true` to the Checkout session in `handler.ts`.

## Deploy

1. Apply `supabase/migrations/202611210001_billing.sql` (SQL Editor or `POST /v1/projects/<ref>/database/query`), then
   run `supabase/tests/billing_rls.sql`; it must end with `Billing probes passed; synthetic rows rolled back.`
2. Secrets (dashboard, Edge Functions, Secrets, or the CLI):

   ```sh
   supabase secrets set --project-ref spdtisizhcepmsogjvnr \
     STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_... \
     STRIPE_PRICE_PRO_MONTH=price_... STRIPE_PRICE_PRO_YEAR=price_... \
     STRIPE_PRICE_BUSINESS_MONTH=price_... STRIPE_PRICE_BUSINESS_YEAR=price_... \
     BILLING_RETURN_URL=https://growth-factory-landing.vercel.app
   ```

   A restricted key works: Customers write, Checkout Sessions write, Customer portal write, Subscriptions read.
3. Deploy both functions (the posting function now reads plans):

   ```sh
   supabase functions deploy billing --project-ref spdtisizhcepmsogjvnr --use-api --yes
   supabase functions deploy posting --project-ref spdtisizhcepmsogjvnr --use-api --yes
   ```

   Until the migration is applied, the posting function answers gated routes with `503 store_unavailable`, so apply
   the migration first.
4. **Smoke test (test mode):** sign in to the app, Settings, Plan and billing, choose Pro; pay with card
   `4242 4242 4242 4242`; the plan shows Pro within a few seconds of returning. In Stripe, send a test
   `customer.subscription.updated` event to confirm `200`. Open Manage billing, cancel, and confirm "Cancels on ...".

Grant a plan by hand (support, pilots): create the subscription in the Stripe dashboard on the customer the app created
(search by email), using one of the four prices, optionally with a 100% coupon. The webhook syncs it like any other.

Tests: `cd supabase/functions && deno test --allow-read posting/ billing/` (also `deno fmt --check`, `deno lint`,
`deno check`; CI job `posting-server`).

## Logs and data

One JSON line per request: method, route, status and duration. No tokens, emails, owner, customer or subscription ids.
Supabase stores only ids, the plan, the status and dates; card details, invoices and receipts stay in Stripe.
