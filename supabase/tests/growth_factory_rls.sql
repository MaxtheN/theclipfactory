-- Run AFTER the reviewed migration as the SQL Editor administrator.
-- All probes are synthetic and rollback-contained; no auth.users rows are created.
BEGIN;
SET LOCAL row_security = on;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';
SET LOCAL request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';

INSERT INTO public.gf_workspaces (id, owner_id, name)
VALUES ('91000000-0000-4000-8000-000000000001', auth.uid(), 'RLS probe A');
INSERT INTO public.gf_records (workspace_id, kind, id, data)
VALUES ('91000000-0000-4000-8000-000000000001', 'profiles', 'rls-probe-a', '{"name":"Synthetic A"}');
INSERT INTO public.gf_events (workspace_id, kind, record_id, event_type, data)
VALUES ('91000000-0000-4000-8000-000000000001', 'profiles', 'rls-probe-a', 'created', '{}');

SET LOCAL request.jwt.claim.sub = 'b0000000-0000-4000-8000-000000000002';
SET LOCAL request.jwt.claims = '{"sub":"b0000000-0000-4000-8000-000000000002","role":"authenticated"}';
INSERT INTO public.gf_workspaces (id, owner_id, name)
VALUES ('92000000-0000-4000-8000-000000000002', auth.uid(), 'RLS probe B');
INSERT INTO public.gf_records (workspace_id, kind, id, data)
VALUES ('92000000-0000-4000-8000-000000000002', 'profiles', 'rls-probe-b', '{"name":"Synthetic B"}');
INSERT INTO public.gf_events (workspace_id, kind, record_id, event_type, data)
VALUES ('92000000-0000-4000-8000-000000000002', 'profiles', 'rls-probe-b', 'created', '{}');

DO $authenticated_probes$
DECLARE
  changed integer;
BEGIN
  IF current_user <> 'authenticated' OR auth.uid() <> 'b0000000-0000-4000-8000-000000000002'::uuid THEN
    RAISE EXCEPTION 'JWT/role test setup did not take effect';
  END IF;
  IF EXISTS (SELECT 1 FROM public.gf_workspaces WHERE id = '91000000-0000-4000-8000-000000000001')
    OR EXISTS (SELECT 1 FROM public.gf_records WHERE workspace_id = '91000000-0000-4000-8000-000000000001')
    OR EXISTS (SELECT 1 FROM public.gf_events WHERE workspace_id = '91000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Foreign workspace data was visible';
  END IF;

  BEGIN
    INSERT INTO public.gf_workspaces (owner_id, name)
    VALUES ('a0000000-0000-4000-8000-000000000001', 'Forbidden owner');
    RAISE EXCEPTION 'Foreign workspace ownership insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.gf_records (workspace_id, kind, id, data)
    VALUES ('91000000-0000-4000-8000-000000000001', 'profiles', 'forbidden-b', '{}');
    RAISE EXCEPTION 'Foreign record insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.gf_events (workspace_id, kind, record_id, event_type, data)
    VALUES ('91000000-0000-4000-8000-000000000001', 'profiles', 'forbidden-b', 'created', '{}');
    RAISE EXCEPTION 'Foreign event insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  UPDATE public.gf_records SET version = 2, data = '{"name":"Updated synthetic B"}'
    WHERE workspace_id = '92000000-0000-4000-8000-000000000002' AND kind = 'profiles' AND id = 'rls-probe-b';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'Owned record update failed'; END IF;
  UPDATE public.gf_records SET data = '{"forbidden":true}'
    WHERE workspace_id = '91000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 0 THEN RAISE EXCEPTION 'Foreign record update unexpectedly succeeded'; END IF;

  BEGIN
    UPDATE public.gf_records SET id = 'moved'
      WHERE workspace_id = '92000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'Record identity mutation unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.gf_workspaces SET owner_id = 'a0000000-0000-4000-8000-000000000001'
      WHERE id = '92000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'Ownership transfer unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.gf_records WHERE workspace_id = '92000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'Record deletion unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.gf_events SET data = '{"changed":true}'
      WHERE workspace_id = '92000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'Event mutation unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.gf_events WHERE workspace_id = '92000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'Event deletion unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.gf_records (workspace_id, kind, id, data)
    VALUES ('92000000-0000-4000-8000-000000000002', 'config', 'forbidden-kind', '{}');
    RAISE EXCEPTION 'Private/unknown record kind unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.gf_records (workspace_id, kind, id, data)
    VALUES ('92000000-0000-4000-8000-000000000002', 'profiles', 'oversize',
      jsonb_build_object('payload', repeat('x', 300000)));
    RAISE EXCEPTION 'Oversized metadata unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.gf_records SET version = 0
      WHERE workspace_id = '92000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'Invalid version unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$authenticated_probes$;

SET LOCAL ROLE anon;
SET LOCAL request.jwt.claim.sub = 'b0000000-0000-4000-8000-000000000002';
SET LOCAL request.jwt.claims = '{"role":"anon","sub":"b0000000-0000-4000-8000-000000000002"}';
DO $anonymous_probes$
BEGIN
  BEGIN
    PERFORM 1 FROM public.gf_workspaces LIMIT 1;
    RAISE EXCEPTION 'Anonymous workspace read unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.gf_records LIMIT 1;
    RAISE EXCEPTION 'Anonymous record read unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.gf_events LIMIT 1;
    RAISE EXCEPTION 'Anonymous event read unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.gf_workspaces (owner_id, name)
    VALUES ('a0000000-0000-4000-8000-000000000001', 'Forbidden anonymous insert');
    RAISE EXCEPTION 'Anonymous insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$anonymous_probes$;

ROLLBACK;
SELECT 'RLS probes passed; synthetic rows rolled back.' AS verification_result;
