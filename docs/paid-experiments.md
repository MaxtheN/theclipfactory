# Paid traffic experiments: blocked pending creative verification

`AdsClient(MetaClient)` in `clip_factory/ads.py` implements **live read-only
preflight**, not a paid-launch feature. No campaigns, ad sets, creatives or ads
are created, activated, paused or deleted. Passing preflight is not approval,
resource creation, a spend reservation, or proof Meta will accept an ad.

## Official documentation check

A `web_search` verification and focused follow-up were performed on November 14,
2026 before implementation. Relevant official sources:

- [Use Posts as Instagram Ads](https://developers.facebook.com/documentation/ads-commerce/instagram/ads-api/guides/use-posts-as-ads)
  documents existing-post promotion using **top-level**
  `source_instagram_media_id`, with Instagram identity/Page fields. It notes
  copyrighted music and interactive elements can prevent boosting. This does
  not verify the required landing-page URL combination for this adapter.
- [Ad Creative](https://developers.facebook.com/docs/marketing-api/reference/ad-creative/),
  [Object Story Spec](https://developers.facebook.com/docs/marketing-api/reference/ad-creative-object-story-spec/),
  [Link Data](https://developers.facebook.com/docs/marketing-api/reference/ad-creative-link-data/):
  the exact existing published Reel + destination URL/CTA payload could not be
  established. Do **not** put `source_instagram_media_id` in `link_data` based on
  an inferred combination of field names; the first research synthesis suggested
  that nesting, but the follow-up contradicted it.
- [Campaign](https://developers.facebook.com/docs/marketing-api/reference/campaign/)
  and [Ad Set](https://developers.facebook.com/docs/marketing-api/reference/ad-set/):
  the exact Reels-only placement with `OUTCOME_TRAFFIC`, `LINK_CLICKS` optimization,
  and `IMPRESSIONS` billing was not established as a supported combination.
- [User ad accounts](https://developers.facebook.com/docs/marketing-api/reference/user/adaccounts/)
  and [IG user media](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/reference/ig-user/media/)
  references were access-restricted during research. The adapter uses live GETs
  for these reads and refuses missing/malformed responses, not synthetic accounts.

**Blocking gap:** authenticated, version-specific official documentation must
verify an exact creative request for the user's existing published Reel plus a
landing-page destination, and the requested placement/objective combination.
No fabricated write payload, speculative partial campaign, or alternate uploaded
video creative is used. No live paid experiment was run or claimed.

## Public API

Construct with the same `access_token`, `graph_version` (inherited default
`v22.0`), and optional HTTP transport as `MetaClient`; use a context manager or
`close()`. The parent obtains credentials through `SecureTokenStore`'s native
OS keychain. This module has no token persistence or plaintext fallback.

- `accounts() -> list[dict]`: paginated `GET /me/adaccounts`, only
  `id` (`act_`-prefixed), `name`, `currency`, `account_status`. Accessibility is
  not proof of `ads_management` permission; inactive accounts remain visible.
- `preflight(spec: dict, *, cancel_check=None) -> dict`: validates local input,
  live accessible active ad account, live currency, accessible Page-linked IG
  account, matching Page, and published Reel present in that IG account's media
  collection. Returns `stage="preflight_only"`, `can_create=False`,
  `can_activate=False`, normalized `spec`, currency/exponent, verification gap,
  and **intended**, not verified API, constraints. Only USD exponent **2** is
  supported. Budgets are integer cents; bools/floats are refused. Every other
  live currency is refused rather than guessing its exponent. This does not
  validate Meta minimum budgets, ad eligibility, or spend availability.
- `create_experiment(spec: dict, persist: Callable, *, cancel_check=None) -> dict`:
  preflights then raises `MetaError(code="paid_creative_unverified")`. No POSTs
  or persistence callbacks; no external write results exist to persist.
- `set_status(campaign_id, status: 'ACTIVE'|'PAUSED') -> dict`: always refuses;
  a bare campaign ID cannot verify ownership, locked cap or new explicit consent.
- `set_experiment_status(record, status, *, persist=None, cancel_check=None) -> dict`:
  always refuses both statuses. **It does not remotely pause anything**; manage
  existing external campaigns in Meta Ads Manager.
- `insights(ad_account_id) -> list[dict]`: proves live account accessibility then
  delegates to existing `fetch_paid_insights` (daily ad-level last 30 days).
  Numeric strings/actions remain unchanged; no organic-clip attribution claim.

The exact spec keys are:

```python
{
    "ad_account_id": "act_123", "instagram_account_id": "456", "page_id": "789",
    "instagram_media_id": "101112", "name": "Explicit traffic candidate",
    "destination_url": "https://creator.com/offer", "country": "US",
    "lifetime_budget_minor": 1000, "duration_days": 7,
}
```

No extra targeting, currency, credential or regulated-category overrides are
accepted. Only general-ad intent for US adults (18+) is in scope; regulated ads
are unsupported. There is no automatic classification of a landing page.
Destination syntax is checked without fetching it; DNS/redirect safety cannot
be proved. Parent app approval of the source and general-ad eligibility remains
required. Cancel checks stop preflight before reads/between media rows; there
are no writes to cancel or roll back.

## Required safety contract before enabling writes

The parent must issue a **new explicit user request** to activate a fully
verified experiment, confirming its immutable capped lifetime budget. Store
budget/identity records durably and guard simultaneous local allocations;
preflight neither locks budget nor authorizes launch. No autonomous paid launch.

Once official verification is available, implement and test: campaign PAUSED,
`OUTCOME_TRAFFIC`, `special_ad_categories=[]`; ad set PAUSED with lifetime cap,
fixed start/end, US 18+, Instagram Reels only, `IMPRESSIONS`/`LINK_CLICKS`;
verified existing-Reel creative; ad PAUSED. Persist `{stage, ...ids}` immediately
following **each** write, including external results before cancellation can
interrupt handling. Never retry uncertain writes; reconcile failures with Meta.
Never blindly delete user resources. Activation must validate ownership, live
caps and all three object statuses, persist each transition, and pause what was
activated on failure while preserving IDs and reporting uncertain pause results.

All current IO uses inherited `_request`/`_pages`: credential-safe errors,
bounded safe-GET retries and no write retries. Tests use mocked HTTP only. No
writes means tests cannot honestly assert created PAUSED objects or remote
lifetime enforcement; instead they assert **zero writes** and precise refusal.
