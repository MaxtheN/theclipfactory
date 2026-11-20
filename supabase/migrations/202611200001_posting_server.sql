-- Growth Factory posting server state (WO-22). Only the `posting` Edge Function reads or
-- writes it, as service_role. App roles (anon, authenticated) get no access at all.
-- Stores no captions, media, OAuth tokens or Zernio keys: only ids, ownership and outcomes.
-- Apply once after 202611140001_growth_factory.sql; reruns deliberately abort.
BEGIN;
SET LOCAL search_path = pg_catalog, public;

DO $posting_guard$
BEGIN
  IF pg_catalog.to_regclass('public.gf_workspaces') IS NULL THEN
    RAISE EXCEPTION 'Apply 202611140001_growth_factory.sql first. Stop and review.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND left(c.relname, 11) = 'gf_posting_'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND left(p.proname, 11) = 'gf_posting_'
  ) THEN
    RAISE EXCEPTION 'gf_posting_* objects already exist. Stop and review.';
  END IF;
END
$posting_guard$;

-- One Zernio profile per Growth Factory workspace.
CREATE TABLE public.gf_posting_profiles (
  workspace_id uuid PRIMARY KEY REFERENCES public.gf_workspaces (id),
  zernio_profile_id text NOT NULL UNIQUE CHECK (zernio_profile_id ~ '^[0-9a-f]{24}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Media URLs the server presigned for a workspace. A post may only attach these.
CREATE TABLE public.gf_posting_uploads (
  public_url text PRIMARY KEY CHECK (char_length(public_url) <= 2048 AND left(public_url, 8) = 'https://'),
  workspace_id uuid NOT NULL REFERENCES public.gf_workspaces (id),
  content_type text NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX gf_posting_uploads_workspace_idx ON public.gf_posting_uploads (workspace_id, created_at);

-- Zernio posts created through the server, and the workspace that owns each one.
CREATE TABLE public.gf_posting_posts (
  zernio_post_id text PRIMARY KEY CHECK (zernio_post_id ~ '^[0-9a-f]{24}$'),
  workspace_id uuid NOT NULL REFERENCES public.gf_workspaces (id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX gf_posting_posts_workspace_idx ON public.gf_posting_posts (workspace_id, created_at);

-- Verified Zernio webhook deliveries for those posts, deduplicated on the event id.
-- Outcome fields only: the caption and the rest of the payload are not kept.
CREATE TABLE public.gf_posting_events (
  event_id text PRIMARY KEY CHECK (char_length(event_id) BETWEEN 1 AND 128),
  zernio_post_id text NOT NULL REFERENCES public.gf_posting_posts (zernio_post_id),
  workspace_id uuid NOT NULL REFERENCES public.gf_workspaces (id),
  event text NOT NULL CHECK (char_length(event) BETWEEN 1 AND 64),
  post_status text CHECK (char_length(post_status) <= 32),
  platform text CHECK (char_length(platform) <= 32),
  account_id text CHECK (char_length(account_id) <= 64),
  platform_status text CHECK (char_length(platform_status) <= 32),
  platform_post_id text CHECK (char_length(platform_post_id) <= 256),
  published_url text CHECK (char_length(published_url) <= 2048),
  error_category text CHECK (char_length(error_category) <= 64),
  error_source text CHECK (char_length(error_source) <= 16),
  error text CHECK (char_length(error) <= 1000),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX gf_posting_events_post_idx ON public.gf_posting_events (zernio_post_id, occurred_at);

-- Fixed-window request counters per workspace and bucket.
CREATE TABLE public.gf_posting_rate (
  workspace_id uuid NOT NULL REFERENCES public.gf_workspaces (id),
  bucket text NOT NULL CHECK (char_length(bucket) BETWEEN 1 AND 32),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits >= 0),
  PRIMARY KEY (workspace_id, bucket, window_start)
);

-- Counts one request and reports whether it is within the limit. Old windows are pruned
-- now and then, so the table stays small without a scheduled job.
CREATE FUNCTION public.gf_posting_take(p_workspace uuid, p_bucket text, p_window_seconds integer, p_limit integer)
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
  INSERT INTO public.gf_posting_rate AS r (workspace_id, bucket, window_start, hits)
  VALUES (p_workspace, p_bucket, v_start, 1)
  ON CONFLICT (workspace_id, bucket, window_start) DO UPDATE SET hits = r.hits + 1
  RETURNING r.hits INTO v_hits;
  IF pg_catalog.random() < 0.02 THEN
    DELETE FROM public.gf_posting_rate WHERE window_start < pg_catalog.clock_timestamp() - interval '1 day';
  END IF;
  RETURN v_hits <= p_limit;
END
$take$;

ALTER TABLE public.gf_posting_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gf_posting_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.gf_posting_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gf_posting_uploads FORCE ROW LEVEL SECURITY;
ALTER TABLE public.gf_posting_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gf_posting_posts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.gf_posting_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gf_posting_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.gf_posting_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gf_posting_rate FORCE ROW LEVEL SECURITY;

-- No policies: app roles see nothing. service_role bypasses RLS, so its default
-- Supabase grants are reset to exactly what the function needs: ownership rows and
-- events are insert-only, never updated or deleted.
REVOKE ALL ON public.gf_posting_profiles, public.gf_posting_uploads, public.gf_posting_posts,
  public.gf_posting_events, public.gf_posting_rate FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.gf_posting_profiles, public.gf_posting_uploads, public.gf_posting_posts,
  public.gf_posting_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gf_posting_rate TO service_role;

REVOKE ALL ON FUNCTION public.gf_posting_take(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gf_posting_take(uuid, text, integer, integer) TO service_role;

COMMIT;
