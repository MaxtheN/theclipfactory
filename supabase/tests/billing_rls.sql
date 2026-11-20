-- Rollback-contained probes for 202611210001_billing.sql. Run as the SQL Editor administrator
-- (or the Management API query endpoint). Expected final row:
-- 'Billing probes passed; synthetic rows rolled back.'
BEGIN;
SET LOCAL search_path = pg_catalog, public;

-- App roles: no table or function access at all, whatever their JWT says.
DO $app_probes$
DECLARE
  role_name text;
  table_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    PERFORM set_config('request.jwt.claims',
      '{"sub":"0f000000-0000-4000-8000-0000000000bb","role":"' || role_name || '"}', true);
    EXECUTE format('SET LOCAL ROLE %I', role_name);
    FOREACH table_name IN ARRAY ARRAY['gf_billing_customers', 'gf_billing_subscriptions', 'gf_billing_events',
      'gf_billing_rate'] LOOP
      BEGIN
        EXECUTE format('SELECT count(*) FROM public.%I', table_name);
        RAISE EXCEPTION '% could read %', role_name, table_name;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    END LOOP;
    BEGIN
      PERFORM public.gf_billing_save_subscription('0f000000-0000-4000-8000-0000000000bb', 'cus_probe',
        'sub_probe', 'business', 'month', 'active', NULL, false, CURRENT_TIMESTAMP);
      RAISE EXCEPTION '% could grant itself a plan', role_name;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.gf_billing_take('0f000000-0000-4000-8000-0000000000bb', 'write', 60, 10);
      RAISE EXCEPTION '% could call gf_billing_take', role_name;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END LOOP;
END
$app_probes$;

-- service_role: the billing function's role can do exactly its job.
SET LOCAL ROLE service_role;
DO $service_probes$
DECLARE
  written boolean;
  row_status text;
BEGIN
  INSERT INTO public.gf_billing_customers (owner_id, stripe_customer_id)
  VALUES ('0f000000-0000-4000-8000-0000000000bb', 'cus_probe');
  INSERT INTO public.gf_billing_events (event_id, event_type) VALUES ('evt_probe', 'customer.subscription.updated');
  BEGIN
    UPDATE public.gf_billing_customers SET stripe_customer_id = 'cus_other';
    RAISE EXCEPTION 'service_role could rewrite a customer mapping';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.gf_billing_subscriptions (owner_id, stripe_customer_id, stripe_subscription_id, plan,
      billing_interval, status, synced_at)
    VALUES ('0f000000-0000-4000-8000-0000000000bb', 'cus_probe', 'sub_direct', 'pro', 'month', 'active',
      CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'service_role could write a subscription directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  written := public.gf_billing_save_subscription('0f000000-0000-4000-8000-0000000000bb', 'cus_probe',
    'sub_probe', 'pro', 'month', 'active', CURRENT_TIMESTAMP + interval '30 days', false,
    '2026-11-21T10:00:00Z');
  IF NOT written THEN RAISE EXCEPTION 'first save was not written'; END IF;

  -- An older read never overwrites a newer one.
  written := public.gf_billing_save_subscription('0f000000-0000-4000-8000-0000000000bb', 'cus_probe',
    'sub_probe', 'pro', 'month', 'incomplete', NULL, false, '2026-11-21T09:00:00Z');
  IF written THEN RAISE EXCEPTION 'stale read overwrote a newer one'; END IF;

  -- A cancelled old subscription read later cannot hide a different live one.
  written := public.gf_billing_save_subscription('0f000000-0000-4000-8000-0000000000bb', 'cus_probe',
    'sub_old', 'pro', 'month', 'canceled', NULL, false, '2026-11-21T11:00:00Z');
  IF written THEN RAISE EXCEPTION 'cancelled old subscription replaced the live one'; END IF;

  -- The same subscription moving forward is written.
  written := public.gf_billing_save_subscription('0f000000-0000-4000-8000-0000000000bb', 'cus_probe',
    'sub_probe', 'business', 'year', 'past_due', NULL, true, '2026-11-21T12:00:00Z');
  SELECT status INTO row_status FROM public.gf_billing_subscriptions
  WHERE owner_id = '0f000000-0000-4000-8000-0000000000bb';
  IF NOT written OR row_status <> 'past_due' THEN RAISE EXCEPTION 'newer read was not written'; END IF;

  BEGIN
    PERFORM public.gf_billing_save_subscription('0f000000-0000-4000-8000-0000000000bb', 'cus_probe',
      'sub_probe', 'enterprise', 'month', 'active', NULL, false, '2026-11-21T13:00:00Z');
    RAISE EXCEPTION 'an unknown plan was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  IF NOT public.gf_billing_take('0f000000-0000-4000-8000-0000000000bb', 'write', 60, 1) THEN
    RAISE EXCEPTION 'first request was refused';
  END IF;
  IF public.gf_billing_take('0f000000-0000-4000-8000-0000000000bb', 'write', 60, 1) THEN
    RAISE EXCEPTION 'rate limit did not apply';
  END IF;
END
$service_probes$;
RESET ROLE;

SELECT 'Billing probes passed; synthetic rows rolled back.' AS result;
ROLLBACK;
