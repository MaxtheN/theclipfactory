-- Growth Factory private metadata foundation. No sync, credentials, files or buckets.
-- Apply once to the reviewed empty gf_* namespace; reruns deliberately abort.
BEGIN;
SET LOCAL search_path = pg_catalog, public;

DO $migration_guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND left(c.relname, 3) = 'gf_'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND left(t.typname, 3) = 'gf_'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND left(p.proname, 3) = 'gf_'
  ) THEN
    RAISE EXCEPTION 'Existing public.gf_* objects found. Stop and review; this migration never replaces them.';
  END IF;
END
$migration_guard$;

CREATE TABLE public.gf_workspaces (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  owner_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX gf_workspaces_owner_idx ON public.gf_workspaces (owner_id);

CREATE TABLE public.gf_records (
  workspace_id uuid NOT NULL REFERENCES public.gf_workspaces (id),
  kind text NOT NULL CHECK (kind IN (
    'profiles', 'campaigns', 'strategy_versions', 'campaign_observations', 'clips',
    'feedback', 'learning_policies', 'learning_publications', 'learning_snapshots',
    'learning_experiments'
  )),
  id text NOT NULL CHECK (char_length(btrim(id)) BETWEEN 1 AND 128),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(data) = 'object' AND pg_catalog.octet_length(data::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, kind, id)
);

CREATE TABLE public.gf_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.gf_workspaces (id),
  kind text NOT NULL CHECK (kind IN (
    'profiles', 'campaigns', 'strategy_versions', 'campaign_observations', 'clips',
    'feedback', 'learning_policies', 'learning_publications', 'learning_snapshots',
    'learning_experiments'
  )),
  record_id text NOT NULL CHECK (char_length(btrim(record_id)) BETWEEN 1 AND 128),
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'updated', 'reviewed', 'observed', 'experiment_proposed', 'experiment_completed'
  )),
  data jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(data) = 'object' AND pg_catalog.octet_length(data::text) <= 262144),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX gf_events_workspace_created_idx ON public.gf_events (workspace_id, created_at, id);

ALTER TABLE public.gf_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gf_workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE public.gf_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gf_records FORCE ROW LEVEL SECURITY;
ALTER TABLE public.gf_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gf_events FORCE ROW LEVEL SECURITY;

CREATE POLICY gf_workspaces_select_own ON public.gf_workspaces
  FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
CREATE POLICY gf_workspaces_insert_own ON public.gf_workspaces
  FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT auth.uid()));

CREATE POLICY gf_records_select_own ON public.gf_records
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.gf_workspaces w
    WHERE w.id = gf_records.workspace_id AND w.owner_id = (SELECT auth.uid())
  ));
CREATE POLICY gf_records_insert_own ON public.gf_records
  FOR INSERT TO authenticated WITH CHECK (EXISTS (
    SELECT 1 FROM public.gf_workspaces w
    WHERE w.id = gf_records.workspace_id AND w.owner_id = (SELECT auth.uid())
  ));
CREATE POLICY gf_records_update_own ON public.gf_records
  FOR UPDATE TO authenticated USING (EXISTS (
    SELECT 1 FROM public.gf_workspaces w
    WHERE w.id = gf_records.workspace_id AND w.owner_id = (SELECT auth.uid())
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM public.gf_workspaces w
    WHERE w.id = gf_records.workspace_id AND w.owner_id = (SELECT auth.uid())
  ));

CREATE POLICY gf_events_select_own ON public.gf_events
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.gf_workspaces w
    WHERE w.id = gf_events.workspace_id AND w.owner_id = (SELECT auth.uid())
  ));
CREATE POLICY gf_events_insert_own ON public.gf_events
  FOR INSERT TO authenticated WITH CHECK (EXISTS (
    SELECT 1 FROM public.gf_workspaces w
    WHERE w.id = gf_events.workspace_id AND w.owner_id = (SELECT auth.uid())
  ));

-- Remove Supabase/default PUBLIC grants before giving only the intended capabilities.
REVOKE ALL PRIVILEGES ON TABLE public.gf_workspaces, public.gf_records, public.gf_events
  FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT ON TABLE public.gf_workspaces, public.gf_records, public.gf_events TO authenticated;
-- No identity moves, ownership transfer, workspace update, event update, DELETE or TRUNCATE.
GRANT UPDATE (version, data, updated_at) ON TABLE public.gf_records TO authenticated;

COMMIT;
