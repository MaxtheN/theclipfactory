# Publishing (post an approved revision)

Approval and posting are separate decisions. Approve the exact revision in review first
("Approve revision N"); approving never exports or posts. Posting and scheduling are offered
only for an approved revision.

**Current status (2026-11-20):** the desktop engine posts through the Growth Factory posting
server (Supabase Edge Function `posting`, in front of Zernio). See
[posting-server.md](posting-server.md) for the server. The first real app publication through
this path is still a live acceptance gate. The earlier Composio Instagram path (Supabase Storage
bucket `gf-publish`, `INSTAGRAM_POST_IG_USER_MEDIA`) has been removed; its research notes are in
git history before WO-23.

The older direct-Meta path (`POST /api/clips/{id}/publish` → `meta.py publish_reel`) is separate
and does not share records; a clip with a direct-Meta attempt is refused here.

## Platforms and accounts

Supported: Instagram, TikTok, YouTube, Facebook, LinkedIn, X and Threads. The app never holds a
Zernio key. Every call carries the signed-in cloud session and the linked workspace; the server
scopes accounts, uploads and posts to that workspace.

Connected accounts (`clip_factory/posting_accounts.py`, records in `connected_accounts` with
`provider = "zernio"`, local id = Zernio account id):

| Route | Purpose |
| --- | --- |
| `GET /api/posting/accounts?profile_id&refresh` | List (optionally re-read from the server first) |
| `POST /api/posting/accounts/sync` | Re-read accounts from the server |
| `POST /api/posting/connect {platform, profile_id}` | Start OAuth in the system browser; returns `request_id`, `auth_url` |
| `GET /api/posting/connect/{request_id}` | Progress: `pending`, `connected`, `ambiguous`, `expired` |
| `GET /api/posting/connected/{request_id}` | Browser return page (no local token; only for a pending request) |
| `PUT /api/posting/accounts/{id}/binding {profile_id}` | Bind to a workspace profile |
| `PUT /api/posting/accounts/{id}/permission {publishing_permitted}` | Allow or stop posting for this account |
| `DELETE /api/posting/accounts/{id}` | Disconnect upstream; disables its learning policies |
| `GET /api/posting/accounts/{id}/tiktok-creator-info` | TikTok privacy levels, interaction options, limits |

A new account starts `unbound` with posting not permitted. A connection started for a profile
binds automatically only when exactly one new account of that platform appears within 30 minutes;
otherwise the person binds it explicitly. Binding never grants permission. An account that was
disconnected and appears again comes back `unbound`, without permission. An account missing
upstream is marked `disconnected`.

Posting needs, in order: **Settings → publishing enabled** (`publishing_disabled`, 403), cloud
configured and signed in (`cloud_not_configured` / `sign_in_required`, 409), and an active account
bound to the clip's profile with `publishing_permitted` (`account_not_permitted`, 403). These are
checked when the request is made and again before each upload and post.

## Flow

```
POST /api/clips/{id}/post {account_id, caption, sha256, override_reason?, package fields}
  checks: publishing enabled · signed in · clip approved · sha256 == approved revision == file
          · campaign not archived · account active, bound, permitted
          · platform caption limits · TikTok consent and creator options
          · quality gate pass (or override reason ≥ 10 chars)
  → attempt (durable, kind publish_attempts), queued on one sequential publish lane
```

One attempt is one clip to one account, always sent as `publishNow`. Local scheduling stays in
the app. Each attempt has a fixed `idempotency_key` (`gf-attempt-<id>`) and `external_id`
(`gf-<id>`) that never change, so a resend can never create a second post.

Every external effect is preceded by a durable write of `pending_effect`:

| State | Next effect (pending_effect) | Record written after |
| --- | --- | --- |
| `created` | `upload` (presigned PUT of the approved MP4; Instagram also uploads the cover) | `uploaded` + `video_url` |
| `uploaded` | `create_post` (`POST /posts`, one target, `publishNow`) | `submitted` + `zernio_post_id` |
| `submitted` | read-only polls of `GET /posts/{id}` | `published` + `platform_post_id`, `permalink` |
| `published` | learning registration | `mapped` |

Terminal: `mapped`, `published` (mapping awaiting a learning policy), `failed` (definite: the
server refused, or the platform reported a failure with its `errorCategory`). `unknown` means the
post may or may not exist: a timeout, a lost connection or a server 5xx after `create_post` was
sent, an `in_progress` replay, or a crash with `pending_effect = create_post`. An `unknown` attempt
is never resent; `POST /api/publish-attempts/{id}/reconcile` reads first:

- no post id: `GET /posts?externalId=gf-<id>`. One match → adopt it; none → back to `uploaded`
  (safe to resend with the same idempotency key); several → left `unknown` with a note.
- with a post id: `GET /posts/{id}` and apply its status.

A failed upload (or a crash during one) simply goes back to `created`; an upload publishes
nothing. Retryable refusals (`sign_in_required`, `session_expired`, rate limits, `posting_plan_limit`,
`workspace_forbidden`, `not_configured`) leave the attempt at `uploaded` with the error so
**Continue** (`POST /api/publish-attempts/{id}/resume`) can try again. A post still publishing after
the polls stays `submitted`; **Check status** reconciles it.

On app start, attempts with `pending_effect = upload` go back to `created`; any other pending
effect becomes `unknown`. Unfinished attempts from the removed Composio path are cancelled; ones
that may have posted (`container_*`, `published`, `unknown`) are kept with `legacy: true` and
cannot be resumed or reconciled here.

### Learning mapping

After `published`, the publisher registers `learning_publications` through
`LearningEngine.register_publication` with the exact clip SHA-256, `media_id` = Zernio post id and
`mapping_source = "app_published"`, then records `provider`, `platform`, `platform_post_id` and
`permalink` on it. It needs a learning policy for (campaign, profile, account); without one the
attempt ends at `published` with `mapping.status = "awaiting_policy"`.

Metrics are read with `GET /posts/{id}/analytics`. A metric the platform does not report (Zernio
returns 0) is recorded as unavailable, never as zero; "syncing" retries later, and a post with no
platform analytics at all finishes as insufficient evidence.

## Quality gate

`clip_factory/quality.py`, `GET /api/clips/{id}/quality`. Deterministic checks:
file decodes (ffprobe, H.264/HEVC video), 1080×1920, 7–90 s, audio stream present,
burned captions, black (≥1 s) or frozen (≥2 s) frames via FFmpeg
`blackdetect`/`freezedetect` (unknown if FFmpeg is unavailable), size within 300 MB (Instagram
Reels, the smallest platform limit), render playback checks, and SHA-256 equal to the approved
revision. The existing critic's result (`team_review_status`, `team_checks`) is read, never
changed; a failing or unresolved critique holds. `GATE_VERSION` 4.

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

## Post package (cover, caption, platform options, schedule)

- **Caption limits** per platform: Instagram 2,200 (and 30 hashtags, 20 mentions), TikTok 2,200,
  YouTube 5,000, Facebook 63,206, LinkedIn 3,000, X 280, Threads 500.
- **Instagram**: `shareToFeed` (default on); up to 3 `collaborators`; the cover goes out as
  `instagramThumbnail` (the still is uploaded like the video) or, if that upload fails or the file
  changed, `thumbOffset` = the frame's time with a `cover_upload_failed` / `cover_file_missing`
  warning. Collaborators are refused for other platforms (`collaborators_unsupported`).
- **YouTube**: `title` (`youtube_title`, else the hook or caption, ≤ 100 characters) and
  `visibility` (public, unlisted, private).
- **TikTok**: requires `privacy_level` from the creator's options, `allow_comment`, `allow_duet`,
  `allow_stitch`, `content_preview_confirmed` and `express_consent_given`. The engine re-reads
  creator info and refuses a privacy level not offered, an interaction the creator disabled, a
  creator who cannot post more, or a clip longer than the creator's limit. The cover frame time is
  sent as `video_cover_timestamp_ms`.
- **Cover** (`clip_factory/post_package.py`): the render's own `<clip>.jpg` (craft cover,
  `auto_best_frame`/`auto_first_frame`) or a frame the person picks from six candidates
  (`GET /api/clips/{id}/post-package`, `GET /api/clips/{id}/cover-frames/{ms}`, 1080×1920 JPEG
  under `publish_covers/`, ≤ 8 MB).
- **Record**: each attempt stores `package` (`caption_sha256`, `caption_chars`, `hashtags`,
  `mentions`, `cta`, `share_to_feed`, `collaborators`, `cover {source, time_ms, sha256, bytes}`,
  platform options), `cover_mode`, `scheduled_for`, `schedule_id`, `posted_at`.
- **Schedule** (`clip_factory/post_schedule.py`): `POST /api/clips/{id}/schedule-post
  {account_ids, captions{account: text}, sha256, publish_at (with offset), timezone, ...}`
  validates every account (all-or-nothing) and stores a `schedules` row with
  `lane = "instagram_post"` (kept for stored rows; it covers every platform) plus one attempt per
  account in state `scheduled` (nothing external). The legacy direct-Meta runner skips that lane;
  campaign archive and draft cleanup guards see it. While the app is open the scheduler re-checks
  everything at the time and moves the attempts to `created` on the normal publish lane. **The app
  must be open at that time.** A time that passed while the app was closed or asleep (> 2 min
  late) is marked `overdue_at` and is never posted without a click:
  `POST /api/post-schedules/{id}/decision {action: post_now|reschedule|cancel}`.
  Cancelled attempts end `cancelled` and do not block a new post.

## Batch

`POST /api/campaigns/{id}/post-batch {account_ids, clip_ids, captions?, override_reasons?}`
validates every pair first (all-or-nothing), then queues one attempt per
clip × account on the same sequential lane, with a short gap between items.

## First real post procedure

1. Confirm the posting server is deployed and configured ([posting-server.md](posting-server.md)),
   and the Zernio plan has room for the accounts you will connect (otherwise
   `posting_plan_limit`).
2. In the app: sign in to Growth Factory cloud and turn on publishing in Settings.
3. Connect one owned test account (`POST /api/posting/connect`), confirm it is bound to the right
   profile, then allow posting for it.
4. Pick one short clip; check the quality gate and press **Approve revision N**. Write a caption
   and post to exactly one account.
5. Watch the attempt: `uploaded` → `submitted` → `published` → `mapped` (or `published` awaiting
   policy). Open the post link.
6. If it shows `unknown`, press **Check status**. Never post again from the UI or the platform until
   reconcile resolves it.
