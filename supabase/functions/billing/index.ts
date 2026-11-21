// Edge Function entry point. Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, the four STRIPE_PRICE_*
// ids and BILLING_RETURN_URL (the website origin). Supabase provides SUPABASE_URL, SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY to every function. See docs/billing.md.
import { createHandler } from "./handler.ts";
import { PostgrestBillingStore, SupabaseBillingAuth } from "./store.ts";
import { StripeClient } from "./stripe.ts";

const env = (name: string) => Deno.env.get(name) ?? "";

Deno.serve(
  createHandler({
    stripe: new StripeClient(env("STRIPE_SECRET_KEY")),
    store: new PostgrestBillingStore(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")),
    auth: new SupabaseBillingAuth(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY")),
    webhookSecret: env("STRIPE_WEBHOOK_SECRET"),
    prices: {
      pro: { month: env("STRIPE_PRICE_PRO_MONTH"), year: env("STRIPE_PRICE_PRO_YEAR") },
      business: { month: env("STRIPE_PRICE_BUSINESS_MONTH"), year: env("STRIPE_PRICE_BUSINESS_YEAR") },
    },
    returnUrl: env("BILLING_RETURN_URL"),
    log: (entry) => console.log(JSON.stringify(entry)),
  }),
);
