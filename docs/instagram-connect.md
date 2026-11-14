# Connect Instagram (self-serve)

A new user of the Mac app presses **Connect Instagram**, signs in to Instagram in
their own browser, and comes back to a verified account. Nobody opens the Composio
dashboard. This page records how it works, what was checked live on 2026-11-14,
and what still stands between this and a public launch.

## Flow

```
Connect Instagram ─► POST /api/automation/connect/instagram {profile_id}
                     └─ Composio POST /api/v3/connected_accounts/link
                        {auth_config_id, user_id}  → connected_account_id, redirect_url, expires_at
                     └─ backend opens redirect_url in the system browser
"Waiting for Instagram login in your browser…"
                  ─► GET /api/automation/connect/{request_id}   (every 3 s)
                     └─ Composio GET /api/v3/connected_accounts/{id}
                        exact id + owner + Instagram toolkit + auth config → status only
                     INITIALIZING / INITIATED → pending
                     ACTIVE  → existing bind flow: read_account, GET_USER_INFO,
                               Business/Creator check, professional + app-scoped IDs,
                               bind to the profile → connected (@handle)
                     FAILED / INACTIVE / REVOKED → failed
                     EXPIRED, or past expires_at → expired
"Connected @handle"
```

- **Request ID** is the pending `connected_account_id` Composio returns. The app
  stores it in `connection_intents` with the profile, Composio user ID and auth
  config. Only that exact intent can be bound; terminal states (`connected`,
  `failed`, `expired`) are kept and answered locally, never retried silently.
- **Composio user ID** is stable per install and never an email:
  signed in to Growth Factory cloud → `gf-user-` + first 32 hex of
  `sha256("growth-factory-composio:" + Supabase user id)`; otherwise
  `gf-install-` + a random 128-bit ID saved once in local SQLite
  (`config/composio_install`).
- **Browser**: the backend calls `webbrowser.open` with the Composio URL. pywebview
  only hands *clicked* `target="_blank"` links to the system browser (a scripted
  `window.open` is dropped), so the waiting message also shows a clickable
  "Didn't open? Open login page" link.
- **No callback URL.** Composio's hosted page ends the flow; the app learns the
  result by polling. If the Composio project ever enables OAuth callback identity
  verification (`session_uri` / `complete_auth`), this flow must add that step.
- **Permission fallback.** If Composio refuses the link (401/403), the API returns
  `403 "Your Composio key needs connected-account management permission."` and the
  UI says to connect the account in the Composio dashboard, then use **Import**
  under **Advanced** (the existing import-by-`ca_` ID path).
- `link_token`, provider `state`, tokens and the API key never enter responses,
  SQLite or logs. The read adapter's four-tool allowlist and the publisher's
  separate allowlist are unchanged.

Code: `clip_factory/composio.py` (`initiate_connection`, `connection_status`),
`clip_factory/autonomy_runtime.py` (`composio_user_id`, `connect_instagram`,
`connect_status`, `bind_account`), `clip_factory/learning_api.py`,
`frontend/src/growth/ConnectInstagram.tsx`. Tests:
`tests/test_instagram_connect.py`, `frontend/src/growth/connectInstagram.test.tsx`.

## What was checked live (read-only, 2026-11-14)

| Question | Evidence | Answer |
| --- | --- | --- |
| Managed or custom Meta app behind `ac_02lrmG08C1Iz`? | `GET /api/v3/connected_accounts/{ca_dYkCuj6H5XDa, ca_YgnHf7APOlBV}` → `auth_config.is_composio_managed: true`, `auth_scheme: OAUTH2` | **Composio-managed** credentials (Composio's own Meta app). |
| Scopes actually granted to the existing connections | `requested_scopes` on both accounts | `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`. **No comment or message scopes** on these two connections. If the auth config was changed later to add them, existing accounts must reconnect to get them. |
| Can the key read the auth config? | `GET /api/v3/auth_configs/ac_02lrmG08C1Iz` → 403 `APIKey_InsufficientPermissions`: key has no access for `auth_configs` | No. The scope list above comes from the connections, not the config. |
| Can the key start new connections? | `POST /api/v3/connected_accounts/link` with a **nonexistent** auth config ID (nothing can be created) → 403: route requires `connected_accounts` **write**; key has **read** | **No.** In-app Connect returns the permission fallback until the key is upgraded. |

No connected account was created, changed or revoked.

## What's needed for a public launch

**1. Composio key.** Create (or edit) the project API key with
`connected_accounts` **write** in addition to the current Tools read, Connected
accounts read and tool execution. Without it, self-serve connect cannot start.

**2. Meta app and review.** Instagram API with Instagram Login apps start at
*Standard Access*: only people with a role on the Meta app can authorize it.
Serving accounts you don't own needs *Advanced Access*, which requires Meta App
Review and business verification
([Meta overview](https://developers.facebook.com/docs/instagram-platform/overview)).

- **Today (Composio-managed):** Composio's Meta app is the one under review, so
  strangers can sign in now for the scopes Composio's app is approved for. The
  consent screen shows Composio's app, not Growth Factory. Composio's own
  Instagram docs say comment permissions must be approved on the Meta app and
  recommend "an owned Meta app" for production use
  ([toolkit page](https://docs.composio.dev/toolkits/instagram)). Before launch,
  confirm with one non-team test account that basic, insights and
  content-publish all work through the managed app.
- **Own Meta app (recommended for launch: our brand on consent, our quotas):**
  create a Business-type Meta app with the Instagram product (Instagram Login),
  set Composio's OAuth redirect URI, create a custom auth config in Composio with
  that client ID/secret, and get **Advanced Access via App Review** for
  `instagram_business_basic`, `instagram_business_content_publish`,
  `instagram_business_manage_insights` (and `instagram_business_manage_comments` /
  `instagram_business_manage_messages` only if features ship that use them). This
  needs business verification, a privacy policy URL, data-deletion instructions, a
  screencast per permission, and test credentials for reviewers. Until approved,
  only app testers can connect. Then switch the app's auth config ID.

**3. Account type.** Only Instagram **Business or Creator** (Professional)
accounts work; personal accounts are rejected during verification with "Connect an
Instagram Business or Creator account." No Facebook Page is needed for Instagram
Login.

**4. Distribution of the key.** Each install currently uses the Composio key typed
under Advanced. For strangers, the key must not ship inside the app: put connect
link creation behind our backend (e.g. a Supabase Edge Function holding the key)
or give each user their own Composio project. This is not implemented.
