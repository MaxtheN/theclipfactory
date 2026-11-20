-- Rollback-contained probes for 202611200001_posting_server.sql. Run as the SQL Editor
-- administrator (or the Management API query endpoint). Expected final row:
-- 'Posting server probes passed; synthetic rows rolled back.'
BEGIN;
SET LOCAL search_path = pg_catalog, public;

INSERT INTO public.gf_workspaces (id, owner_id, name)
VALUES ('0f000000-0000-4000-8000-0000000000aa', '0f000000-0000-4000-8000-0000000000bb', 'Posting probe');

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
    FOREACH table_name IN ARRAY ARRAY['gf_posting_profiles', 'gf_posting_uploads', 'gf_posting_posts',
      'gf_posting_events', 'gf_posting_rate'] LOOP
      BEGIN
        EXECUTE format('SELECT count(*) FROM public.%I', table_name);
        RAISE EXCEPTION '% could read %', role_name, table_name;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    END LOOP;
    BEGIN
      INSERT INTO public.gf_posting_profiles (workspace_id, zernio_profile_id)
      VALUES ('0f000000-0000-4000-8000-0000000000aa', 'aaaaaaaaaaaaaaaaaaaaaaaa');
      RAISE EXCEPTION '% could map a profile', role_name;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.gf_posting_take('0f000000-0000-4000-8000-0000000000aa', 'write', 60, 10);
      RAISE EXCEPTION '% could call gf_posting_take', role_name;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END LOOP;
END
$app_probes$;

-- service_role: the posting function's role can do exactly its job.
SET LOCAL ROLE service_role;
DO $service_probes$
DECLARE
  allowed boolean;
BEGIN
  INSERT INTO public.gf_posting_profiles (workspace_id, zernio_profile_id)
  VALUES ('0f000000-0000-4000-8000-0000000000aa', 'aaaaaaaaaaaaaaaaaaaaaaaa');
  INSERT INTO public.gf_posting_uploads (public_url, workspace_id, content_type)
  VALUES ('https://media.example/clip.mp4', '0f000000-0000-4000-8000-0000000000aa', 'video/mp4');
  INSERT INTO public.gf_posting_posts (zernio_post_id, workspace_id)
  VALUES ('bbbbbbbbbbbbbbbbbbbbbbbb', '0f000000-0000-4000-8000-0000000000aa');
  INSERT INTO public.gf_posting_events (event_id, zernio_post_id, workspace_id, event, occurred_at)
  VALUES ('evt-probe', 'bbbbbbbbbbbbbbbbbbbbbbbb', '0f000000-0000-4000-8000-0000000000aa',
    'post.published', CURRENT_TIMESTAMP);
  BEGIN
    INSERT INTO public.gf_posting_posts (zernio_post_id, workspace_id)
    VALUES ('not-an-id', '0f000000-0000-4000-8000-0000000000aa');
    RAISE EXCEPTION 'malformed post id accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.gf_posting_uploads (public_url, workspace_id, content_type)
    VALUES ('http://insecure.example/x.mp4', '0f000000-0000-4000-8000-0000000000aa', 'video/mp4');
    RAISE EXCEPTION 'non-https upload accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  FOR i IN 1..3 LOOP
    allowed := public.gf_posting_take('0f000000-0000-4000-8000-0000000000aa', 'probe', 3600, 3);
    IF NOT allowed THEN RAISE EXCEPTION 'request % within the limit was refused', i; END IF;
  END LOOP;
  IF public.gf_posting_take('0f000000-0000-4000-8000-0000000000aa', 'probe', 3600, 3) THEN
    RAISE EXCEPTION 'request over the limit was allowed';
  END IF;
  BEGIN
    UPDATE public.gf_posting_posts SET workspace_id = workspace_id;
    RAISE EXCEPTION 'service_role could rewrite post ownership';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$service_probes$;
RESET ROLE;

ROLLBACK;
SELECT 'Posting server probes passed; synthetic rows rolled back.' AS verification_result;
