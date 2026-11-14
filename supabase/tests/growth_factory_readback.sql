SELECT json_build_object(
  'table_count', (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('gf_workspaces','gf_records','gf_events') AND c.relkind='r'),
  'rls_enabled', (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('gf_workspaces','gf_records','gf_events') AND c.relrowsecurity),
  'rls_forced', (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('gf_workspaces','gf_records','gf_events') AND c.relforcerowsecurity),
  'policy_count', (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname='public'
    AND tablename IN ('gf_workspaces','gf_records','gf_events')),
  'anonymous_table_grants', (SELECT count(*) FROM information_schema.table_privileges WHERE table_schema='public'
    AND table_name IN ('gf_workspaces','gf_records','gf_events') AND grantee IN ('anon','PUBLIC')),
  'authenticated_record_id_update', has_column_privilege('authenticated','public.gf_records','id','UPDATE'),
  'authenticated_record_data_update', has_column_privilege('authenticated','public.gf_records','data','UPDATE'),
  'authenticated_workspace_update', has_table_privilege('authenticated','public.gf_workspaces','UPDATE'),
  'authenticated_record_delete', has_table_privilege('authenticated','public.gf_records','DELETE'),
  'authenticated_event_update', has_table_privilege('authenticated','public.gf_events','UPDATE'),
  'workspace_rows', (SELECT count(*) FROM public.gf_workspaces),
  'record_rows', (SELECT count(*) FROM public.gf_records),
  'event_rows', (SELECT count(*) FROM public.gf_events)
)::text AS verified_state;
