-- Growth Factory publish hosting: also allow the Reel cover still next to the approved MP4.
-- Review, then apply once by hand AFTER 202611140002_publish_bucket.sql. Not applied automatically.
-- Object names: <auth.uid()>/<sha256 of the cover JPEG>.jpg, same uid-prefix rules as the video.
-- Instagram fetches the cover from the public URL (cover_url); Reel covers are JPEG, at most 8 MB.
-- The bucket's 50 MB file_size_limit is unchanged; the app refuses covers over 8 MB before upload.
-- Without this migration the app still posts: it falls back to thumb_offset (the frame time).
BEGIN;
SET LOCAL search_path = pg_catalog, public;

DO $publish_cover_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'gf-publish')
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'gf_publish_insert_own'
     ) THEN
    RAISE EXCEPTION 'Apply 202611140002_publish_bucket.sql first. Stop and review.';
  END IF;
  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'gf_publish_insert_own_cover'
     ) THEN
    RAISE EXCEPTION 'gf_publish_insert_own_cover already exists. Stop and review.';
  END IF;
END
$publish_cover_guard$;

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['video/mp4', 'image/jpeg']
WHERE id = 'gf-publish';

-- Separate INSERT policy (policies are OR-ed): the MP4 policy stays exactly as reviewed.
CREATE POLICY gf_publish_insert_own_cover ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'gf-publish'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
    AND name ~ '^[0-9a-f-]{36}/[0-9a-f]{64}\.jpg$'
  );

-- SELECT and DELETE policies from 202611140002 are already limited to the caller's uid prefix
-- and do not restrict the extension, so cover cleanup needs no further policy.

COMMIT;
