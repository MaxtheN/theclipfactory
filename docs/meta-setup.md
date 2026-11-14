# Real Instagram connection (Facebook Login)

`clip_factory.meta` is a synchronous `httpx` adapter. Run it in the parent job worker,
not the FastAPI event loop. Production sends real requests to `graph.facebook.com`;
`MockTransport` is an injectable test seam, not a simulated production mode.

## Meta setup and limitations

1. Create/configure a Meta app for **Instagram API with Facebook Login**. This is
   not the separate Instagram Login product (`graph.instagram.com`) and does not
   support personal Instagram accounts. Use an Instagram professional account
   (Business or Creator) linked to a Facebook Page. The connecting Facebook user
   must have access to that Page and appropriate content-management tasks.
2. Enable Facebook Login and register an exact HTTPS redirect URI. Configure app ID
   and app secret only on the local server. Do not return the secret to the frontend.
   Local-first storage does not remove Meta's externally reachable HTTPS callback
   and asset-hosting requirements. A local random-port callback is not promised to
   work; arrange registered HTTPS callback delivery securely to the local session.
3. Request `pages_show_list`, `pages_read_engagement`, `instagram_basic`,
   `instagram_content_publish`, and `instagram_manage_insights`. Development mode
   is restricted to app roles/testers and their assets. For other customers, obtain
   the applicable Advanced Access/App Review and business verification; scopes alone
   do not imply approval. Business Manager asset setups can additionally require
   `business_management`; the minimal OAuth helper does not request it automatically.
4. Keep app permissions and Graph version configurable and confirm supported API
   versions against Meta's current changelog before release. Adapter default: `v22.0`.
   Reconnect when a token expires or permissions/Page access change. No automatic
   token refresh, long-lived exchange, or pretend-success validation is implemented.
5. Enable publishing only after successful connection and explicit user approval.
   Reels require a **public HTTPS video URL** that Meta can download. A local file,
   loopback URL, LAN URL, or authenticated desktop playback endpoint is not an upload.
   Host the actual approved video on a trusted HTTPS object-storage/CDN origin with
   a signed URL valid throughout processing. Check Meta's current Reel format limits.

### Asset URL security boundary

`validate_public_video_url(url)` checks syntax without fetching or DNS resolution.
It rejects credentials, non-HTTPS URLs, non-443 ports, fragments, malformed hosts,
local/reserved suffixes, ambiguous numeric addresses, private/loopback/link-local/
reserved/multicast IPv4 and IPv6, and private IPv4-mapped IPv6. This adapter never
fetches an asset itself; Meta fetches it. A syntactically public DNS name can resolve
to a private address or redirect elsewhere. This is **not** a claim of DNS/rebinding
or remote-redirect validation: use trusted public hosting. Do not reuse this
validator as authorization for an application-server URL-fetch feature.

## Public Python interface for parent routes

```python
from clip_factory.meta import MetaClient, MetaError, SecureTokenStore

with MetaClient(access_token, graph_version="v22.0") as meta:
    account = meta.discover_account(account_id=None)
    # {"id": "...", "username": str | None, "name": str | None, "page_id": "..."}
    SecureTokenStore().set_token(account["id"], access_token)
```

Only account metadata belongs in SQLite/API responses. Never serialize the token,
client object internals, full httpx request/response, or raw exception locals.

- `MetaError(message, *, code=None, http_status=None, retryable=False)` is a safe
  `RuntimeError`. `str(error)` and its three attributes can be returned/logged;
  upstream error messages, bodies, URLs, and credential-bearing exceptions are not
  included. Cancellation uses `code="cancelled"`; processing timeout uses
  `code="processing_timeout"`; ownership failure uses `code="ownership"`.
- `MetaClient(access_token: str, graph_version: str = "v22.0", transport=None)`
  supports a context manager and `close()`; clients are intended per operation/job.
  No logging is performed. Normal Graph authentication is a **Bearer header**, never
  an access-token query parameter. Redirects and environment HTTP proxies are disabled.
- `discover_account(account_id: str | None = None) -> dict` reads `/me/accounts`
  with Page access tokens and linked `instagram_business_account` fields. A Page
  token may resolve its own linked account via `/me` when the accounts edge is
  unavailable (Graph code 100). IDs must be numeric strings. An arbitrary publicly
  readable IG ID is not accepted. Multiple accounts require explicit ID selection.
- `validate_token() -> {"valid": True, "account": dict}` performs live account
  discovery and raises on failure; never returns a token or fabricated validation.
  For multi-Page connection use `discover_account(selected_id)` instead.
- `publish_reel(account_id, public_video_url, caption, poll_callback=None,
  cancel_check=None) -> {"id": media_id, "container_id": container_id}` revalidates
  Page ownership, creates a `REELS` container, polls `status_code`, and publishes
  **once**, only on `FINISHED`. `ERROR`, `EXPIRED`, unexpected states, and an already
  `PUBLISHED` container stop the job. The processing loop is bounded by 120 polls
  and a 600-second monotonic deadline (a current bounded HTTP request can finish
  after that deadline). Caption limit: 2,200 characters.
  - `poll_callback({"container_id": str, "status_code": str, "attempt": int})`
    runs synchronously in the worker. Keep callbacks quick and credential-free.
  - `cancel_check() -> bool` is called before creation, each poll, and final publish.
    Cancellation cannot undo an in-flight/completed Meta write or remove a container.
  - Both write endpoints are **never retried**, including rate limits and timeouts.
    A transport failure has an unknown outcome. Reconcile existing Meta containers/
    media before resubmitting; parent must not blindly retry failed publish jobs.
- `fetch_insights(account_id) -> list[dict]` revalidates Page ownership, paginates
  actual media, and returns `id`, `caption`, `timestamp`, `media_type`,
  `media_product_type`, `permalink`, and `metrics`. Metrics are `views`, `reach`,
  `saved`, `shares`, `likes`, `comments`, `total_interactions`. Query each separately:
  a metric unavailable for that media/API version (code 100), an empty response,
  or missing/non-numeric value becomes `None`; a real numeric zero stays zero.
  Supports `values[0].value` and `total_value.value`. Auth/permission/network/rate
  failures propagate rather than masquerading as successful analytics.
- `fetch_paid_insights(ad_account_id) -> list[dict]` accepts numeric or `act_` IDs
  and reads ad-level daily last-30-day insights: ad ID/name, impressions, reach,
  clicks, spend, actions, date start/stop. Returns actual Meta rows without claiming
  clip attribution; amounts remain Meta numeric strings and absent fields remain
  absent. Requires separately configured ad-account access and `ads_read`. No
  campaign creation, edits, budget changes, spend automation, or unattended launch.

Safe GETs retry at most twice for transient/rate-limit responses and transport
failures; backoff/`Retry-After` is capped at five seconds. Connect/pool timeout is
10 seconds and read/write timeout is 30 seconds (httpx per-phase inactivity bounds,
not a promise of total wall-clock deadline against an endlessly streaming server).
Pagination is limited to 100 pages, checks cursor loops, and reconstructs Graph
requests instead of following credential-bearing `paging.next` URLs.

## Native keychain only

`SecureTokenStore()` exposes:

- `set_token(account_id: str, access_token: str) -> None`
- `get_token(account_id: str) -> str | None`
- `delete_token(account_id: str) -> None` (idempotent when absent)

Uses service **`clip-factory`**, username **`instagram:<account_id>`**. Only native
macOS Keychain, Windows Credential Manager, Linux Secret Service, or KWallet
backends are accepted. No plaintext/file/environment fallback. Fail, null, chained,
and third-party alternate backends are rejected. On a headless Linux host, enable
and unlock a native secret service; on macOS approve/unlock Keychain access. Failures
are actionable safe `MetaError`s. Never copy tokens into SQLite, logs, browser
storage, frontend props, or analytics exports. Use the account ID saved in SQLite
to retrieve the user's original token; the adapter selects the appropriate Page
token in memory after discovery. Do not substitute a Page token for ads access.

## OAuth helper and parent responsibilities

`MetaOAuth(app_id, app_secret, redirect_uri, graph_version="v22.0", transport=None)`:

- `authorization_url() -> (url: str, state: str)` generates a cryptographic
  256-bit state, stores it for ten minutes, and requests the minimal five scopes.
- `exchange_code(code: str, state: str) -> str` consumes/validates state then returns
  the actual access token for immediate discovery and keychain storage. No retries.
- `verify_state(state: str) -> bool` is a one-use constant-time verification helper;
  **do not call it before `exchange_code`**, which already performs verification.

The parent must retain the helper instance **per authenticated local session**;
never use a globally shared OAuth state bag as a substitute for session binding.
Process callback codes on the backend only, authenticate the callback session,
handle denied-consent callbacks, and strip code/state from the browser URL. A
restart intentionally invalidates pending login states. Never return the token.

The official Facebook Login references document **GET** `/oauth/access_token`
with `client_id`, `client_secret`, `redirect_uri`, and `code` for code exchange.
Official POST support for this Facebook authorization-code flow could not be
verified (do not confuse it with Instagram Login's POST endpoint). The helper uses
that documented GET, sends **no access token**, disables retries, and redacts errors.
**The app secret and code necessarily occur in this one server-side request URL**:
do not enable httpx/httpcore debug logs or proxy URL capture, and never log OAuth
request objects. There is no speculative POST or insecure fallback.

## Official references checked November 14, 2026

- [Instagram API with Facebook Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/)
- [Instagram media / Reels publishing](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/)
- [Container processing statuses](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-container)
- [Media insights](https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights)
- [Instagram Platform changelog](https://developers.facebook.com/documentation/instagram-platform/changelog)
- [Facebook access tokens](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens)
- [Manual Facebook Login flow](https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow)
  (intermittently inaccessible during research; POST support not established).
- [Marketing API insights](https://developers.facebook.com/docs/marketing-api/insights/)

The changelog removes `video_views` from v21+ (all versions January 8, 2025) and
`plays`, `impressions`, `clips_replays_count`, and
`ig_reels_aggregated_all_plays_count` from v22+ (all versions April 21, 2025).
The current media-insights table lists `views` for Reels. Do not remap plays or
paid impressions into organic views. Metrics remain subject to media type,
publication date, privacy rules, permissions, and version-specific availability.

## Verification

`python -m pytest tests/test_meta.py -q` uses only `httpx.MockTransport` and a native
keyring test double. Covers redaction, Page ownership/discovery, cursor safety,
processing failures/expiry/cancellation, write no-retry, bounded GET retries,
private/local URL rejection, null/zero metric distinctions, read-only paid rows,
keychain-only storage, and one-use OAuth state. No live token or account is needed;
live Meta app approval, account eligibility, and actual publishing must still be
verified with a properly configured app and test professional account.
