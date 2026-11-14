-- Growth Factory publish hosting: public-read bucket for approved MP4s that Instagram fetches.
-- Review, then apply once by hand. Not applied automatically; reruns abort on the guard.
-- Object names: <auth.uid()>/<sha256 of the approved clip>.mp4 (exact bytes the user approved).
-- Writes: authenticated users within their own uid prefix only. No UPDATE policy (no overwrite).
-- Reads: the bucket is public, so /storage/v1/object/public/gf-publish/... is readable without
-- an anonymous storage.objects policy (anonymous listing stays impossible).
BEGIN;
SET LOCAL search_path = pg_catalog, public;

DO $publish_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'gf-publish')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects' AND left(policyname, 11) = 'gf_publish_'
     ) THEN
    RAISE EXCEPTION 'gf-publish bucket or gf_publish_* policies already exist. Stop and review.';
  END IF;
END
$publish_guard$;

-- 52428800 bytes = 50 MB, the Supabase free-tier per-object upload limit.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('gf-publish', 'gf-publish', true, 52428800, ARRAY['video/mp4']);

CREATE POLICY gf_publish_insert_own ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'gf-publish'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
    AND name ~ '^[0-9a-f-]{36}/[0-9a-f]{64}\.mp4$'
  );

-- Storage API delete needs SELECT + DELETE on the row; both are limited to the caller's prefix.
CREATE POLICY gf_publish_select_own ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'gf-publish' AND (storage.foldername(name))[1] = (SELECT auth.uid()::text));

CREATE POLICY gf_publish_delete_own ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'gf-publish' AND (storage.foldername(name))[1] = (SELECT auth.uid()::text));

COMMIT;
