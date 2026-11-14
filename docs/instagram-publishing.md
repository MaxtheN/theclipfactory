# Instagram publishing (Approve & post)

App-initiated Reels publishing through the user's Composio-connected Instagram
account, guarded by a pre-post quality gate and a durable attempt record. This is
separate from the older direct-Meta path (`POST /api/clips/{id}/publish` →
`meta.py publish_reel`), which needs a Meta app token and a caller-supplied public
video URL. The two paths do not share records; a clip with a direct-Meta attempt is
refused here.

## Composio research (2026-11-14, metadata only)

Read-only metadata listing (`GET /api/v3.1/tools?toolkit_slug=instagram`) with the
project key from Keychain. No tool was executed. 40 Instagram tools are listed,
all at version `20261112_00` (the only available version for each).

| Purpose | Slug | Required args | Scopes (connected account) |
| --- | --- | --- | --- |
| Create Reel container | `INSTAGRAM_POST_IG_USER_MEDIA` | `ig_user_id`; plus `video_url` (`^https?://`), `media_type` (`REELS`), `caption`, optional `share_to_feed`, `cover_url`, `thumb_offset` | `instagram_business_basic` + `instagram_business_content_publish` |
| Publish container | `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` | `ig_user_id`, `creation_id`; optional `max_wait_seconds` (default 60; 0 skips status checks), `poll_interval_seconds` | same |
| Container status | `INSTAGRAM_GET_MULTIPLE_NODES` | `object_ids` (≤50), optional `fields` | `instagram_business_basic` |
| Daily publish quota (read-only) | `INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT` | none (`ig_user_id` defaults to `me`; `fields` = `quota_usage,config`) | `instagram_business_basic` + `instagram_business_content_publish` |
| Read back media | `INSTAGRAM_GET_IG_MEDIA` (existing read adapter) | `ig_media_id` | `instagram_business_basic` |

Deprecated equivalents that the adapter refuses (`is_deprecated`):
`INSTAGRAM_CREATE_MEDIA_CONTAINER`, `INSTAGRAM_CREATE_POST`,
`INSTAGRAM_GET_POST_STATUS`. Composio's descriptions contradict each other on
container status: `GET_IG_MEDIA` says "published media only; use GET_POST_STATUS",
while `GET_POST_STATUS` says "deprecated, use GetIgMedia". We therefore read the
container node's `status_code` with the generic `INSTAGRAM_GET_MULTIPLE_NODES`
(fields `id,status_code,status`). **Unverified live**: the response shape is parsed
defensively; confirm it on the first real post.

Findings that shape the design:

- `video_url` must be a public HTTP(S) MP4 that Meta fetches while it processes
  the container (signed URLs work if they stay valid). Composio's docs also say
  "Google Drive share pages will not work". Composio additionally offers
  `video_file` (an `s3key` on Composio's own storage); we do not use it, so the
  approved bytes go only to our own bucket.
- Containers expire after about 24 hours; publishing before `FINISHED` returns
  Graph error 9007. Missing publish permission returns Graph error code 10.
- Daily API publish quota exists (`quota_usage` vs `config.quota_total`); polling
  it too often triggers error 613, so calls are spaced.
- Caption: max 2,200 characters, 30 hashtags, 20 mentions. The tool description
  says "Use HTML URL encoding for hashtags (# becomes %23)". This is unverified; we
  send the caption verbatim and compare the read-back caption. If the first real
  post's read-back differs, the attempt records a `caption_readback_mismatch`
  warning — check it before posting more.
- `ig_user_id` must be the professional IG User ID (Instagram Login `user_id`), not
  the app-scoped `id`. The publisher uses the account's verified
  `instagram_user_id` and re-verifies identity before each run.

### Can our key execute these tools?

Unknown without an execution. The key's project scope allows predefined tool
execution (the read tools already work). Whether publishing succeeds depends on the
**connected account's OAuth scopes**: the Instagram auth config must request
`instagram_business_content_publish`, and accounts connected before that scope
was added must reconnect. The safe live check is the read-only quota tool, which
requires that same scope but publishes nothing:

`GET /api/publish/accounts/{account_id}/readiness` executes only
`INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT` and reports `ready` /
`missing_publish_scope_or_error`. Run it once per account before the first post.

## Flow

```
POST /api/clips/{id}/post {account_id, caption, sha256, override_reason?}
  checks: signed in to cloud · clip approved · sha256 == approved revision == file
          · campaign not archived · account active + verified + bound to clip profile
          · quality gate pass (or override reason ≥ 10 chars)
  → attempt (durable, kind publish_attempts), queued on one sequential publish lane
```

Every external effect is preceded by a durable write of `pending_effect`:

| State | Next effect (pending_effect) | Record written after |
| --- | --- | --- |
| `created` | `upload` (Supabase Storage) | `uploaded` + `video_url` |
| `uploaded` | `create_container` (`POST_IG_USER_MEDIA`) | `container_created` + `container_id` |
| `container_created` | read-only status polls | `container_ready` |
| `container_ready` | `publish` (`POST_IG_USER_MEDIA_PUBLISH`, `max_wait_seconds=0`) | `published` + `media_id` |
| `published` | read-back (`GET_IG_MEDIA`) + learning registration | `mapped` |

Terminal: `mapped`, `published` (mapping awaiting a learning policy), `failed`
(definite: nothing published). `unknown` means an external write may or may not
have happened (timeout, network loss, crash with `pending_effect` set). An
`unknown` attempt is never retried; `POST /api/publish-attempts/{id}/reconcile`
reads first:

- upload: public URL `HEAD` (size match → `uploaded`; otherwise back to `created`).
- container creation: recent-media match (caption + time) → adopt, else back to
  `uploaded` (an orphan *unpublished* container is harmless and expires in 24h).
- publish: container `status_code` — `PUBLISHED` → recent-media match → `published`;
  `FINISHED` → `container_ready`; `IN_PROGRESS` → `container_created`;
  `ERROR`/`EXPIRED` → `failed`; anything unreadable stays `unknown`.

Only after reconcile can `POST /api/publish-attempts/{id}/resume` continue.

On app start, attempts that were running are marked `unknown` if they had a
`pending_effect`, otherwise left resumable.

### Learning mapping

After a verified read-back (owner + provider timestamp via `media_identity`), the
publisher registers `learning_publications` through `LearningEngine.register_publication`
with the exact clip SHA-256 and `mapping_source = "app_published"`. It needs an
existing learning policy for (campaign, profile, account); without one the attempt
ends at `published` with `mapping.status = "awaiting_policy"`.

## Hosting (Supabase Storage)

`clip_factory/publish_storage.py` uploads the approved MP4 to the public-read bucket
`gf-publish` at `<auth user id>/<sha256>.mp4` with the signed-in session, verifies the
public URL by `HEAD` (status, `video/mp4`, exact byte length), then gives that URL to
Instagram. The object is deleted after a successful publish when no other attempt
still needs it.

- 50 MB per object (Supabase free tier global limit); larger clips are refused with
  a clear error before upload. The migration sets the same `file_size_limit`.
- Migration (write-only, **not applied**):
  `supabase/migrations/202611140002_publish_bucket.sql`. Policies: authenticated
  insert/select/delete only within the caller's own `auth.uid()` prefix and only
  `<uuid>/<64 hex>.mp4` names; no update (no overwrite); public reads via the
  bucket's public flag (no anonymous listing policy).

## Quality gate

`clip_factory/quality.py`, `GET /api/clips/{id}/quality`. Deterministic checks:
file decodes (ffprobe, H.264/HEVC video), 1080×1920, 7–90 s, audio stream present,
burned captions, black (≥1 s) or frozen (≥2 s) frames via FFmpeg
`blackdetect`/`freezedetect` (unknown if FFmpeg is unavailable), size within the
hosting limit, render playback checks, and SHA-256 equal to the approved revision.
The existing critic's result (`team_review_status`, `team_checks`) is read, never
changed; a failing or unresolved critique holds.

Rubric 0–5 (null = not measured):

- `technical`: 5 minus one per failing technical check; 4 if some are unknown.
- `caption_legibility`: deterministic from burned captions and caption style
  (none 1, standard 4, high-contrast/pop 5).
- `standalone_context`: critic `context` check (pass 5, fail 1, otherwise null).
- `hook_clarity`: no hook 0; critic `claims` + `context` pass 4, a fail 1, otherwise
  null. The critic checks support, not clarity, so this is a proxy.

Verdict `pass` only when no check fails and no critic hold applies; otherwise
`hold` with reasons. Posting a held clip requires an explicit override reason,
recorded on the attempt.

## Post package (cover, caption, schedule)

Verified 2026-11-14 against the pinned `INSTAGRAM_POST_IG_USER_MEDIA` `20261112_00` schema
(tool metadata read only; nothing executed). It is `additionalProperties: false` and accepts
`ig_user_id` (required), `caption`, `media_type`, `video_url`, `video_file`, `image_url`,
`image_file`, `cover_url` (`^https?://`), `thumb_offset` (integer ms), `share_to_feed`,
`location_id`, `user_tags` (Reels: username only), `audio_name`, `alt_text` (not for Reels),
`children`, `is_carousel_item`, `graph_api_version`. **There is no `collaborators` field**, so
collaborator invites (Graph API: up to 3) cannot be sent; the API refuses them with
`collaborators_unsupported` and the panel says to @mention instead. Graph API Reels rules:
cover JPEG ≤ 8 MB, 9:16 recommended, `cover_url` wins over `thumb_offset` (ms, default 0).

- **Cover** (`clip_factory/post_package.py`): the render's own `<clip>.jpg` (craft cover,
  `auto_best_frame`/`auto_first_frame`) or a frame the person picks from six candidates
  (`GET /api/clips/{id}/post-package`, `GET /api/clips/{id}/cover-frames/{ms}`, 1080×1920 JPEG
  under `publish_covers/`). During the upload step the still goes to `gf-publish` at
  `<uid>/<sha256 of the jpg>.jpg` and is sent as `cover_url` after a public `HEAD`
  (`image/jpeg`, exact size). If hosting is refused (migration `202611140003` not applied) or the
  URL is unreadable at container time, the attempt sends `thumb_offset` = that frame's time and
  records `cover_upload_failed` / `cover_url_unavailable`. Cover objects are deleted with the MP4.
- **Caption**: the text is sent verbatim; limits 2,200 chars / 30 hashtags / 20 mentions are
  enforced in the UI (live counters) and the API. `share_to_feed` defaults on.
- **Record**: each attempt stores `package` (`caption_sha256`, `caption_chars`, `hashtags`,
  `mentions`, `cta`, `share_to_feed`, `collaborators`, `location_id` (always null; location is
  skipped), `cover {source, time_ms, sha256, bytes}`), `cover_mode`, `container_arguments`
  (everything sent except the caption), `scheduled_for`, `schedule_id`, `posted_at`.
- **Schedule** (`clip_factory/post_schedule.py`): `POST /api/clips/{id}/schedule-post
  {account_ids, captions{account: text}, sha256, publish_at (with offset), timezone, ...}`
  validates every account (all-or-nothing) and stores a `schedules` row with
  `lane = "instagram_post"` plus one attempt per account in state `scheduled` (nothing external).
  The legacy direct-Meta runner skips that lane; campaign archive and draft cleanup guards see it.
  While the app is open the scheduler re-checks everything at the time and moves the attempts to
  `created` on the normal publish lane. **The app must be open at that time.** A time that passed
  while the app was closed or asleep (> 2 min late) is marked `overdue_at` and is never posted
  without a click: `POST /api/post-schedules/{id}/decision {action: post_now|reschedule|cancel}`.
  Cancelled attempts end `cancelled` and do not block a new post.

## Batch

`POST /api/campaigns/{id}/post-batch {account_ids, clip_ids, captions?, override_reasons?}`
validates every pair first (all-or-nothing), then queues one attempt per
clip × account on the same sequential lane, with a short gap between items.

## First real post procedure

1. Apply `supabase/migrations/202611140002_publish_bucket.sql` in the Supabase SQL
   editor (review it first). Confirm bucket `gf-publish` is public, 50 MB limit. Then
   apply `202611140003_publish_bucket_covers.sql` (adds `image/jpeg` and `<uid>/<sha>.jpg`
   inserts) so custom covers go out as `cover_url`; without it posts use `thumb_offset`.
2. In Composio, confirm the Instagram auth config requests
   `instagram_business_content_publish`; reconnect the account if it was added
   later.
3. In the app: sign in to Growth Factory cloud; then call
   `GET /api/publish/accounts/{account_id}/readiness` (read-only) and expect `ready`.
4. Pick one short approved clip on a test/owned account; open it in Studio, check
   the quality gate, write a caption without hashtags for the first try, and press
   **Approve & post** for exactly one account.
5. Watch the attempt: `uploaded` → `container_created` → `container_ready` →
   `published` → `mapped` (or `published` awaiting policy). Open the reel link.
6. If it shows `unknown`, press **Check status** — never post again from the UI or
   Instagram until reconcile resolves it.
7. Compare the read-back caption warning, then try a caption with a hashtag.
