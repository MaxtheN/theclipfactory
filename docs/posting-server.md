# Posting server (Zernio)

A Supabase Edge Function, `posting`, that publishes to social platforms through [Zernio](https://docs.zernio.com) on
behalf of Growth Factory workspaces. The Zernio API key is account-wide (it can read and post to every connected
account), so it lives only in the function's secrets and never ships in the desktop app.

- Code: `supabase/functions/posting/` (`index.ts` wiring, `handler.ts` routes and validation, `zernio.ts` client,
  `store.ts` Supabase persistence, `memory_store.ts` + `handler_test.ts` tests).
- Schema: `supabase/migrations/202611200001_posting_server.sql`; probe: `supabase/tests/posting_server_rls.sql`.
- URL: `https://spdtisizhcepmsogjvnr.supabase.co/functions/v1/posting/<route>`.

## Authentication and scoping

Every route except the webhook needs:

- `Authorization: Bearer <Supabase access token>`, the desktop app's cloud sign-in session; and
- `X-GF-Workspace: <gf_workspaces id>`, which must be owned by that user.

The function verifies the token with Supabase Auth and checks `gf_workspaces.owner_id`. Supabase's gateway JWT check
is off (`verify_jwt = false`) because the webhook is unauthenticated by design; the function does its own check.

Each workspace maps to exactly one Zernio **profile** (created on first use with `externalId = workspace id`). A
workspace can only see and act on accounts in its profile, media it presigned, and posts it created; anything else is
`404`/`403`, never forwarded to Zernio. Ownership is recorded server-side (`gf_posting_*` tables), so a foreign
Zernio id is refused even if guessed.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /register` | Ensure the workspace's Zernio profile exists (idempotent). |
| `GET /accounts` | Connected accounts: `id, platform, username, displayName, avatarUrl, connected` only. |
| `DELETE /accounts/:id` | Disconnect an owned account. |
| `GET /accounts/:id/tiktok-creator-info` | TikTok privacy levels and limits for the consent step. |
| `POST /connect` `{platform, redirectUrl?}` | OAuth URL for tiktok, instagram, youtube, facebook, linkedin, twitter or threads. `redirectUrl` must be `http://127.0.0.1` or `http://localhost`. |
| `POST /uploads` `{filename, contentType, size}` | Presigned upload (mp4, mov, jpeg, png; up to 5 GB). `PUT` the bytes to `uploadUrl`, then post with `publicUrl`. |
| `POST /posts` | Create a post (below). |
| `GET /posts?externalId=` | Owned posts with that external id (reconciliation). |
| `GET /posts/:id` | Post status, per-platform results and stored webhook events. |
| `DELETE /posts/:id` | Cancel or delete an owned post. |
| `GET /posts/:id/analytics` | `{status: "syncing"}` until Zernio has data, then `{status: "ready", analytics}`. |
| `POST /webhooks/zernio` | Zernio delivery endpoint (signature-verified). |

Errors are `{"error": {"code", "message"}}`. Notable codes: `sign_in_required`/`session_expired` (401),
`workspace_forbidden` (403), `rate_limited` and `zernio_rate_limited` (429, with `Retry-After`),
`posting_plan_limit` (402, Zernio plan limit; not retryable by the creator), `zernio_unavailable` (502, retry),
`server_misconfigured` (502), `not_configured` (503).

### Creating posts

```http
POST /posts
Idempotency-Key: <8–128 chars, one per publish attempt>

{
  "content": "Default caption",
  "mediaItems": [{"url": "<publicUrl from /uploads>", "type": "video"}],
  "publishNow": true,                      // or "scheduledFor": "2026-12-01T10:00:00-08:00"
  "externalId": "gf-attempt-…",            // optional, for GET /posts?externalId=
  "tiktokSettings": {"privacy_level": "PUBLIC_TO_EVERYONE", "content_preview_confirmed": true, "express_consent_given": true},
  "platforms": [
    {"accountId": "…", "content": "Per-platform caption", "platformSpecificData": {}}
  ]
}
```

- 1–10 targets, each an owned account; the platform is taken from the server's account record, not the caller.
- Exactly one of `publishNow` or `scheduledFor` (future, with an explicit UTC offset).
- TikTok targets need `privacy_level`, `content_preview_confirmed` and `express_consent_given` (from
  `tiktokSettings` or the target's `platformSpecificData`), matching TikTok's Direct Post consent rules.
- **Idempotency:** the key is forwarded to Zernio as `gf:<workspace>:<key>` (Zernio keys are account-wide). Retrying
  with the same key never creates a second post: a replay returns `200` with `replayed: true`; a create still in
  flight returns `409 in_progress` with `Retry-After`. New posts return `201`. Zernio keeps keys for 24 hours; after
  that, reconcile with `GET /posts?externalId=` before retrying.

## Webhooks

Zernio webhook `6affbad0682c1924b63fbbfc` ("Growth Factory posting server") posts the `post.*` events
(`scheduled, published, partial, failed, cancelled, platform.published, platform.failed, platform.deleted,
tiktok.url_resolved`) to `/webhooks/zernio`. The function checks `X-Zernio-Signature` (HMAC-SHA256 of the raw body
with `ZERNIO_WEBHOOK_SECRET`, constant-time), stores events only for owned posts, deduplicates on the event id, and
never stores captions. Test, unknown or foreign events get `200 {stored: false}`; a bad signature gets `401`.

## Limits

- Per workspace: 30 reads and 10 writes per minute (`gf_posting_take`), on top of Zernio's account-wide limits.
- Zernio free tier: 60 requests/min for the whole account, **2 connected accounts in total**, 25 posts per hour per
  account, TikTok 15 posts per day. At the account limit Zernio refuses new profiles *and* new connections
  (`posting_plan_limit`), so new workspaces cannot register until billing is added or accounts are freed.

## Logs

One JSON line per request: method, route with ids replaced by `:id`, status, duration, and the first 8 characters of
the workspace id. No captions, tokens, account, post or media identifiers.

## Deploy and configure

1. Apply the migration (SQL Editor or `POST /v1/projects/<ref>/database/query`), then run
   `supabase/tests/posting_server_rls.sql`; it must end with
   `Posting server probes passed; synthetic rows rolled back.`
2. Secrets (Management API `POST /v1/projects/<ref>/secrets` or the dashboard): `ZERNIO_API_KEY` and
   `ZERNIO_WEBHOOK_SECRET` (random, 32 bytes). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by the
   platform.
3. Deploy: `supabase functions deploy posting --remote=spdtisizhcepmsogjvnr --use-api --yes`.
4. Webhook: `POST https://zernio.com/api/v1/webhooks/settings` with the function URL, the same secret and the events
   above; check with `POST /webhooks/test` and `GET /webhooks/logs` (expect `200`, `{"received":true,"stored":false}`).

Tests: `cd supabase/functions && deno test posting/` (also `deno fmt --check`, `deno lint`, `deno check`; CI job
`posting-server`).

## Verified live — 2026-11-20

- Migration applied; probe passed (app roles have no table or function access; `service_role` can insert but not
  update ownership rows). Existing `growth_factory_rls.sql` probe still passes.
- Function `posting` ACTIVE; secrets set; webhook test delivered and answered `200 {stored:false}`; unsigned
  delivery `401`.
- Smoke as a throwaway signed-in user: register, accounts (sanitized), creator-info gate, presigned upload + `PUT`,
  foreign-account post refused (`403`), foreign post `404`, foreign workspace `403`, bad token `401`. `connect`
  returned `posting_plan_limit` because the account is at the free tier's 2 accounts. Throwaway user and rows
  removed; no post was made.
