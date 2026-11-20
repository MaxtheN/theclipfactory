-- Growth Factory billing state (Plans and Billing, WO-34). Only the `billing` and `posting` Edge
-- Functions read or write it, as service_role. App roles (anon, authenticated) get no access.
-- Stripe is the source of truth: rows mirror the latest subscription read back from Stripe.
-- Stores no card data, invoices or emails: only ids, plan, status and dates.
-- Apply once after 202611200001_posting_server.sql; reruns deliberately abort.
BEGIN;
SET LOCAL search_path = pg_catalog, public;

DO $billing_guard$
BEGIN
  IF pg_catalog.to_regclass('public.gf_workspaces') IS NULL THEN
    RAISE EXCEPTION 'Apply 202611140001_growth_factory.sql first. Stop and review.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND left(c.relname, 11) = 'gf_billing_'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND left(p.proname, 11) = 'gf_billing_'
  ) THEN
    RAISE EXCEPTION 'gf_billing_* objects already exist. Stop and review.';
  END IF;
END
$billing_guard$;

-- One Stripe customer per Growth Factory account owner (Supabase auth user id).
CREATE TABLE public.gf_billing_customers (
  owner_id uuid PRIMARY KEY,
  stripe_customer_id text NOT NULL UNIQUE CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The owner's latest subscription as last read from Stripe. One row per owner.
CREATE TABLE public.gf_billing_subscriptions (
  owner_id uuid PRIMARY KEY,
  stripe_customer_id text NOT NULL CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,64}$'),
  stripe_subscription_id text NOT NULL UNIQUE CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,64}$'),
  plan text NOT NULL CHECK (plan IN ('pro', 'business')),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  status text NOT NULL CHECK (status IN (
    'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'
  )),
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  -- When this state was read from Stripe. A slower, older read never overwrites a newer one.
  synced_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Stripe webhook event ids already applied, so retried deliveries do no work twice.
CREATE TABLE public.gf_billing_events (
  event_id text PRIMARY KEY CHECK (event_id ~ '^evt_[A-Za-z0-9]{1,64}$'),
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 64),
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Fixed-window request counters per owner and bucket.
CREATE TABLE public.gf_billing_rate (
  owner_id uuid NOT NULL,
  bucket text NOT NULL CHECK (char_length(bucket) BETWEEN 1 AND 32),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits >= 0),
  PRIMARY KEY (owner_id, bucket, window_start)
);

-- Writes the subscription unless a newer read is already stored. Returns true when written.
CREATE FUNCTION public.gf_billing_save_subscription(
  p_owner uuid, p_customer text, p_subscription text, p_plan text, p_interval text, p_status text,
  p_period_end timestamptz, p_cancel_at_period_end boolean, p_synced_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
-- Definer rights: service_role may only read the table directly; writes go through this rule.
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $save$
DECLARE
  v_written boolean;
BEGIN
  INSERT INTO public.gf_billing_subscriptions AS s (
    owner_id, stripe_customer_id, stripe_subscription_id, plan, billing_interval, status,
    current_period_end, cancel_at_period_end, synced_at, updated_at
  ) VALUES (
    p_owner, p_customer, p_subscription, p_plan, p_interval, p_status,
    p_period_end, p_cancel_at_period_end, p_synced_at, pg_catalog.clock_timestamp()
  )
  ON CONFLICT (owner_id) DO UPDATE SET
    stripe_customer_id = excluded.stripe_customer_id,
    stripe_subscription_id = excluded.stripe_subscription_id,
    plan = excluded.plan,
    billing_interval = excluded.billing_interval,
    status = excluded.status,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    synced_at = excluded.synced_at,
    updated_at = excluded.updated_at
  -- A newer read wins. A different subscription only replaces a stored one that is no longer live,
  -- so a stale event for an old, cancelled subscription cannot hide the current one.
  WHERE s.synced_at <= excluded.synced_at
    AND (
      s.stripe_subscription_id = excluded.stripe_subscription_id
      OR s.status IN ('canceled', 'incomplete_expired')
      OR excluded.status NOT IN ('canceled', 'incomplete_expired')
    )
  RETURNING true INTO v_written;
  RETURN coalesce(v_written, false);
END
$save$;

CREATE FUNCTION public.gf_billing_take(p_owner uuid, p_bucket text, p_window_seconds integer, p_limit integer)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $take$
DECLARE
  v_start timestamptz;
  v_hits integer;
BEGIN
  IF p_window_seconds < 1 OR p_limit < 1 THEN
    RAISE EXCEPTION 'invalid rate limit';
  END IF;
  v_start := pg_catalog.to_timestamp(
    floor(extract(epoch FROM pg_catalog.clock_timestamp()) / p_window_seconds) * p_window_seconds
  );
  INSERT INTO public.gf_billing_rate AS r (owner_id, bucket, window_start, hits)
  VALUES (p_owner, p_bucket, v_start, 1)
  ON CONFLICT (owner_id, bucket, window_start) DO UPDATE SET hits = r.hits + 1
  RETURNING r.hits INTO v_hits;
  IF pg_catalog.random() < 0.02 THEN
    DELETE FROM public.gf_billing_rate WHERE window_start < pg_catalog.clock_timestamp() - interval '1 day';
  END IF;
  RETURN v_hits <= p_limit;
END
$take$;

ALTER TABLE public.gf_billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gf_billing_customers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.gf_billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gf_billing_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.gf_billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gf_billing_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.gf_billing_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gf_billing_rate FORCE ROW LEVEL SECURITY;

-- No policies: app roles see nothing. service_role gets exactly what the functions need.
-- Subscriptions are written only through gf_billing_save_subscription.
REVOKE ALL ON public.gf_billing_customers, public.gf_billing_subscriptions, public.gf_billing_events,
  public.gf_billing_rate FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.gf_billing_customers, public.gf_billing_events TO service_role;
GRANT SELECT ON public.gf_billing_subscriptions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gf_billing_rate TO service_role;

REVOKE ALL ON FUNCTION public.gf_billing_save_subscription(
  uuid, text, text, text, text, text, timestamptz, boolean, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gf_billing_save_subscription(
  uuid, text, text, text, text, text, timestamptz, boolean, timestamptz
) TO service_role;
REVOKE ALL ON FUNCTION public.gf_billing_take(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gf_billing_take(uuid, text, integer, integer) TO service_role;

COMMIT;
