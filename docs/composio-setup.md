# Composio Instagram setup

Growth Factory keeps its own agent orchestration. Composio supplies managed authentication and explicit account-bound tools; no Composio agent SDK is required. This adapter enables **reads only**. Nothing here grants publishing or ad-spending authority.

## Configure and connect

1. Create/select a Composio project and an Instagram OAuth auth configuration. Instagram requires a Business or Creator account. The documented read scopes are `instagram_business_basic` and `instagram_business_manage_insights`. Store the project API key in the OS Keychain through the application, never SQLite, source, screenshots or logs. [Instagram toolkit](https://docs.composio.dev/toolkits/instagram)
2. Use a stable application `user_id` and the exact `auth_config_id`. `initiate_connection(...)` calls `POST /api/v3/connected_accounts/link`; the body contains those identifiers and an optional `callback_url`. Return the temporary `redirect_url` for the user to finish consent. The adapter drops the separate `link_token`. **Managed OAuth uses Connect Links:** legacy managed `initiate()` was retired in July2026. [Authentication guide](https://docs.composio.dev/docs/tools-direct/authenticating-tools), [Connect Link REST contract](https://docs.composio.dev/reference/v3/api-reference/connected-accounts/postConnectedAccountsLink)
3. Bind only the pending connection created for this app session. Callback query parameters and a displayed success page are insufficient. Verify the connected account server-side: exact account ID, application owner, expected auth configuration, `ACTIVE`, enabled and Instagram. Consume the pending flow once and enforce its expiry. If the Composio project enables callback-identity verification, its `session_uri`/complete-auth flow must also be implemented before activation; this adapter does not redeem that flow. [Connected-account identity verification](https://docs.composio.dev/docs/auth-configuration/connected-accounts)
4. `account_identity(...)` reads the actual Instagram profile through that exact connection. Meta distinguishes app-scoped `id` from professional `user_id`: bind `instagram_user_id` from the latter, never infer an alias. Only case-normalized `Business`/`Media_Creator` account types are accepted; missing/unknown types fail closed. Persist this numeric identity, not a Facebook Page ID, shortcode, connection ID or username. [Meta Instagram Login fields](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started/)

Real configured-account verification is complete for the two accounts listed below. Offline tests cover request and safety contracts; they do not establish real media/insight collection or growth.

## Python contract

```python
client = ComposioClient(api_key)  # root obtains this from Keychain
link = client.initiate_connection(auth_config_id, user_id, callback_url=None)
connection = client.read_account(connected_account_id, user_id, auth_config_id=None)
identity = client.account_identity(connected_account_id, user_id)
media = client.media_identity(
    connected_account_id, user_id, numeric_media_id,
    instagram_user_id=identity["instagram_user_id"],
)
observation = client.collect_insights(
    connected_account_id, user_id, numeric_media_id,
    instagram_user_id=identity["instagram_user_id"],
)
```

Each network method owns/closes a short-lived HTTP client. `with`/`close()` are optional conveniences. Environment proxies and redirects are disabled; response size, timeouts and schemas are bounded. Errors suppress provider bodies and exception text. No automatic request retries occur.

`read_account` returns only `connected_account_id`, `user_id`, `auth_config_id`, `toolkit` and `status`; raw credential-bearing `state`, `params` and `data` are discarded. `account_identity` adds separately validated `app_scoped_user_id` and professional `instagram_user_id`, plus `account_type`, `username` and `identity_tool_version`. `media_identity` adds exact `media_id`, verified ownership, `media_tool_version` and authoritative `published_at` from the provider. Publication timestamps must be valid, timezone-aware and not in the future; they are normalized to UTC. A manually entered date is never substituted.

For direct reads, `tool_schema(slug, version="latest")` fetches `GET /api/v3.1/tools/{slug}` and resolves a dated version. `execute_tool(slug, arguments, connected_account_id=..., user_id=..., version=..., schema=...)` requires that exact, unmodified fetched schema and version. Its REST body explicitly contains `connected_account_id`, `user_id`, `version` and `arguments`; it never uses implicit account selection, instant credentials, natural-language execution or proxy execution. Only four tools are enabled: `INSTAGRAM_GET_USER_INFO`, `INSTAGRAM_GET_IG_USER_MEDIA`, `INSTAGRAM_GET_IG_MEDIA` and `INSTAGRAM_GET_IG_MEDIA_INSIGHTS`. [Schema REST contract](https://docs.composio.dev/reference/api-reference/tools/getToolsByToolSlug), [execution REST contract](https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteByToolSlug)

## Exact-media observations

`collect_insights` uses `media_identity`, revalidates the connection before every execution, resolves the actual profile and requires an optional saved identity to match. It fetches media with `{"ig_media_id": id, "fields": "id,owner,timestamp"}` and requires the returned media ID to match and `owner.id` to equal one of the two numeric identifiers from the same freshly authenticated profile. The saved professional identity must still match exactly; an app-scoped ID cannot satisfy that pin. The result records which owner namespace matched. Missing ownership or publication time fails closed; the resulting observation includes provider-verified UTC `published_at`. Meta documents `owner` as the creator's Instagram ID and only returns it for the creator. [IG Media reference](https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/v21.0/)

The insights request uses `ig_media_id`, a **metric array**, and `period: "lifetime"`. Results retain nullable `views`, `reach`, `saved`, `shares`, `likes`, `comments` and `total_interactions`; real zero remains zero. Negative, fractional, nonfinite, string, boolean, ambiguous duplicate or multi-point counts remain unknown. Collection records the exact account, Instagram identity, media and resolved tool version. Unexpected pagination fails as incomplete; no provider `next` URL is followed. Account history is not silently enumerated or summed.

Attribution is `not_separated`: media metrics can include paid/crossposted distribution. Lifetime snapshots are not disjoint reporting periods, organic-only counts, business lift or causal evidence. [IG Media fields](https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/v21.0/)

## Later: approved publishing handshake — documented, not implemented

Current toolkit definitions describe these operations; fetch/pin their schemas again before implementation:

| Step | Tool and relevant arguments |
|---|---|
| Create Reel container | `INSTAGRAM_POST_IG_USER_MEDIA`: `ig_user_id`, `media_type: "REELS"`, `video_url`, optional `caption`/`share_to_feed`. Creation returns container `data.id`. |
| Check processing | Deprecated `INSTAGRAM_GET_POST_STATUS`: `creation_id`, optional `graph_api_version`; wait for `FINISHED`; `ERROR`/`EXPIRED` stop. |
| Publish once | `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH`: `ig_user_id`, `creation_id`, `max_wait_seconds` (default60, up to300), `poll_interval_seconds` (default3). Zero wait skips readiness checks. |
| Read published object | `INSTAGRAM_GET_IG_MEDIA`: published numeric `ig_media_id`, projected `id,owner,permalink,timestamp`. |
| Bounded reconciliation listing | `INSTAGRAM_GET_IG_USER_MEDIA`: exact `ig_user_id`, `fields`, `limit` <=100, optional `after` cursor. |

The official toolkit descriptions conflict: the deprecated status tool points at Get IG Media, while Get IG Media says it reads published objects and directs unpublished containers back to the deprecated status tool. Resolve this with pinned schema/provider readback before implementing a status primitive. [Current tool definitions](https://docs.composio.dev/toolkits/instagram)

The published schemas document no idempotency key. A future publisher needs an exact human-approved clip hash/account/caption, durable claim **before** creation/publication, persisted container ID and separately confirmed published media ID. A timeout after a write is an unknown outcome, not permission to retry. Listing similar recent media alone does not prove which container was published; unresolved reconciliation must remain held. The current adapter rejects all publishing tools even through generic execution.

## Verification

Run `python -m pytest tests/test_composio.py -q`. Tests use `httpx.MockTransport`; no real connection, OAuth grant, publication, spend, model or credential-store access occurs. Offline cases cover owner/account changes, documented professional-type variants, app-scoped versus professional identity, authoritative publication timestamps, exact schemas/versions, credential-safe failures, unknown counts, media ownership, incomplete pagination and response bounds.

## Actual account verification — 2026-11-14

The user approved a dedicated project API key with Tools read, Connected accounts read and predefined-tool execution. It was saved via the authenticated local settings API to native Keychain; temporary transfer file and clipboard copy were cleared. No key is stored in this repository. Both existing accounts were verified through exact connected-account owner/configuration, schema-pinned GET_USER_INFO and professional Instagram identity, then bound to the All-In creative demo profile: @kartik._builds and @kartikey_bihani. These are actual provider readbacks, not mocked connection success.

Actual bounded post listing and owned-media insights also passed for both accounts: three and four usable recent posts, schema version20261112_00, verified ownership and real cumulative metrics. Instagram Login returned app-scoped media owner IDs matching the same fresh profile; the adapter records that namespace separately from the professional identity. These connectivity probes were not mapped to All-In clips, imported as campaign learning evidence, or used to choose a winner. Private readbacks stay outside Git.

The current dedicated key permits existing-account verification and the app’s four read tools. It does not grant connected-account management; new managed OAuth connections require that additional project-key permission. Existing accounts can be connected in Composio and then imported. The app still prohibits publish/spend tools. Actual post/insight mapping must use a matching reviewed clip, not pretend an unrelated post used the All-In render.

## Choose an existing post
In Results, choose a verified account, then open **Find a post from your Instagram account**. **Find recent posts** loads at most six safe display entries from one provider page; unknown pagination and skipped rows remain explicit. **Use this post** only fills its ID and clears mapping confirmation. To track it, choose the exact reviewed local clip and explicitly confirm correspondence. No automatic mapping, policy activation, agent call or publication follows catalog selection. Incomplete/foreign/inactive bindings fail before provider IO. Captions are display text only, never instructions.
