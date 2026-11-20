# Self-hosting the cloud

This page is for operators who run their own copy of Growth Factory's cloud service, for example a team or a reseller. Creators using the published app do not need any of it.

The app does its work on your computer. The cloud does only three things:

- **Sign-in:** email and password accounts, and one workspace per account (Supabase Auth and Postgres).
- **Posting:** the `posting` function publishes approved clips through Zernio and keeps the Zernio key off users' computers.
- **Billing:** the `billing` function opens Stripe Checkout and the billing portal and keeps each workspace's plan up to date from Stripe's webhooks.

The source and the detailed runbooks are in the [repository](https://github.com/MaxtheN/theclipfactory): `supabase/` holds the migrations, probes and functions, and `docs/posting-server.md` and `docs/billing.md` give every route, secret and check.

## What you need

| Service | Used for | Account needed |
|---|---|---|
| Supabase | Sign-in, workspace records, the two functions | A project (the free tier is enough to start) |
| Zernio | Posting to TikTok, Instagram, YouTube, Facebook, LinkedIn, X and Threads | An API key and a webhook secret |
| Stripe | Subscriptions, Checkout, the billing portal | Four prices: Pro and Business, monthly and yearly |
| A static host | The website, including the Checkout return pages | Any host; the site is plain HTML |

You also need the [Supabase CLI](https://supabase.com/docs/guides/cli) and, to run the function tests, [Deno](https://deno.com).

## 1. Create the database

In the Supabase SQL Editor, run each file in `supabase/migrations/` in filename order; each runs as one transaction. Then run the three probes in `supabase/tests/` (`growth_factory_rls.sql`, `posting_server_rls.sql` and `billing_rls.sql`). Each ends with a "probes passed; synthetic rows rolled back" message and leaves no data behind.

In Authentication, enable email sign-in. The app signs users up and in with an email and password.

## 2. Set up Stripe

Create the Pro and Business products with recurring USD prices of $24 monthly and $228 yearly (Pro), and $200 monthly and $1,920 yearly (Business). Configure the customer portal to allow plan changes between those four prices, card updates, invoices and cancelling at the end of the period. Add a webhook endpoint at `<project URL>/functions/v1/billing/webhooks/stripe` for the checkout, subscription and invoice events listed in `docs/billing.md`.

## 3. Set the secrets and deploy

Set these function secrets in the Supabase dashboard or with `supabase secrets set`:

| Secret | Value |
|---|---|
| `ZERNIO_API_KEY` | Your Zernio API key |
| `ZERNIO_WEBHOOK_SECRET` | A random 32-byte value, also given to Zernio |
| `STRIPE_SECRET_KEY` | A secret or restricted Stripe key |
| `STRIPE_WEBHOOK_SECRET` | The webhook signing secret (`whsec_...`) |
| `STRIPE_PRICE_PRO_MONTH`, `STRIPE_PRICE_PRO_YEAR`, `STRIPE_PRICE_BUSINESS_MONTH`, `STRIPE_PRICE_BUSINESS_YEAR` | The four price ids |
| `BILLING_RETURN_URL` | Your website's address, for example `https://example.com` |

Then deploy both functions with `supabase functions deploy billing` and `supabase functions deploy posting`. Register the posting webhook with Zernio as `docs/posting-server.md` describes.

## 4. Host the website

Deploy the `landing-page/` folder to any static host. Checkout returns buyers to `/billing/success.html` or `/billing/cancel.html` and the billing portal to `/billing/return.html` on the `BILLING_RETURN_URL` site, so those pages must be reachable there. Point the Stripe portal's privacy and terms links at `/privacy` and `/terms`.

## 5. Point the app at your cloud

The app reads its cloud address from `clip_factory/cloud_config.json`, which holds the project URL and its **publishable** key, and is bundled when you build the app. For a single computer, set `CLIP_SUPABASE_URL` and `CLIP_SUPABASE_PUBLISHABLE_KEY` before starting the app instead. The app refuses a secret or service-role key.

To send Help to your own copy of this guide, set `GF_GUIDE_URL` to its address (for example `https://example.com/guide/`).

## Checking it works

In Stripe test mode, sign in to the app, open **Settings → Plan and billing**, choose Pro and pay with the card `4242 4242 4242 4242`. The plan shows Pro within a few seconds of returning to the app. Then connect a test account in **Settings → Accounts and connections** and post an approved clip.

The functions log one line per request (method, route, status and duration) and never log tokens, emails or customer ids. Card details, invoices and receipts stay in Stripe.
