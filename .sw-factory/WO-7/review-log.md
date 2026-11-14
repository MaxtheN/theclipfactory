<!--lint disable strong-marker-->

# Review Log: WO-7

**Work Order:** WO-7 — Connect explicit Instagram accounts through Composio
**Initialized At (UTC):** 2026-11-14T13:10:25Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1

### Requirements Alignment

**Blocking:**

**Advisory:**

### Blueprint Alignment

**Blocking:**

**Advisory:**

### Architecture And Conventions

**Blocking:**

**Advisory:**

### Tests And Build

**Commands run:**

**Blocking:**

**Advisory:**

### User-Facing Verification

**Skipped:** _yes/no_ - _reason if yes_

**Evidence:**

**Blocking:**

**Advisory:**

### Security, Privacy, And Data Safety

**Skipped:** _yes/no_ - _reason if yes_

**Blocking:**

**Advisory:**

### Round 1 Verdict

- Total blocking:
- Total advisory:
- Files reviewed:
- **Verdict:** _APPROVED or CHANGES_REQUESTED_

---

<!-- Subsequent rounds: copy the structure above and increment the round number. -->

## Independent review — interim round (2026-11-14)

Inspected `composio.py`, credential-safe native Keychain runtime integration, exact server-created connection intents, account identity verification, collector and AutomationPanel connection controls. No external grant, provider request, publication, model call or live data access was performed.

### Verified strengths

Read-only tool allowlist; explicit user/connected-account IDs on every execution; live schema resolution and pinned tool versions; immutable signature check rejects mutated/forged schemas. Foreign/inactive connections and foreign media owners reject. Nullable integer counts are bounded, not fabricated or summed; pagination is not silently ignored. HTTP redirects and environment proxies are disabled, response bytes/timeouts are bounded, provider exception bodies/URLs are redacted, and sensitive HTTP logging is suppressed. Keys use the native Keychain and stay outside SQLite/public responses. No publication or paid-spend method exists.

### Open blocking finding

**[P2] Professional account type is not verified.** `ComposioClient.account_identity` rejects only `account_type == PERSONAL`; missing/unknown/malformed types otherwise become an accepted account identity. Require documented Business/Creator account types before declaring a professional connection verified, or expose an explicit unverified type that blocks collection. Add missing/unknown account-type tests. Root was notified.

### Resolved integration finding

`AutonomyRuntime.collect` originally omitted the stored `instagram_user_id` pin even though the adapter supports it. Current source now requires and supplies that exact ID, preventing changed provider identities from silently replacing the bound account.

### Advisory and verification

Manual post mapping proves local approval/hash and provider media ownership; it does not prove the remote media bytes equal the selected MP4. Keep that human-supplied mapping explicit. Connection-intent expiry and configuration changes should be considered when finishing old pending OAuth links; provider active/owner/config checks still apply. Native browser OAuth/Keychain permission UX remains unverified and must not be presented as a successful real account connection.

Offline independent domain+adapter tests:88 passed before concurrent updates. Combined latest domain/adapter/API snapshot:102 passed,1 timestamp-format-only assertion failed (recorded in WO-6). Provider error/timeout/identity/schema/pagination and no-publish paths are mocked, not live provider proof.

**Interim verdict: CHANGES_REQUESTED** for professional-account verification and final green combined checks.

## Independent review — final round (2026-11-14)

### Findings resolved

- Professional account identity now requires a documented Business/Media Creator type; missing, personal, malformed and unknown types fail closed. Tests explicitly cover those cases.
- Adapter distinguishes Instagram's professional `user_id` from app-scoped `id`; stored user identity is pinned during collection and media verification. Runtime binding/import requires exact user/configuration/profile and refuses rebinding an existing account to another local identity.
- Mapping uses exact media ownership and the provider's valid, timezone-bearing publication timestamp. Local clip-to-post correspondence remains an explicit user confirmation, not a fabricated byte-level provider verification. API refuses manual timestamp injection or missing/false confirmation.
- Keys remain solely in the native Keychain seam; SQLite/API replies/validation errors exclude them. No plaintext fallback, implicit account, unsupported tool, publish method or paid-spend method was introduced. Direct grant/revocation success is not claimed.

### Final verification

Independent combined domain/Composio/API regression: **140 passed in4.49s**, including new reviewer-authored account-import/publication route-wiring cases. Dedicated API file:16 passed before combined run. Automation UI:4 passed; full TypeScript check and Ruff passed. Provider and Keychain calls were replaced with injected local fixtures; no credentials were requested/read, and no real OAuth grant, network/model call, public post or active app database/lifespan was touched.

**Final scoped implementation verdict: APPROVED. Total open code blockers:0.** Real Composio configuration, account grants, native sign-in/Keychain UX and actual provider readback remain explicit live gates. These tests establish fail-closed contracts, not proof that a real account is connected. Future API schema/version or permission failures must remain visible and must never select a different account or invent metrics.

## Independent follow-up — automatic authoritative owner discovery (2026-11-14)

**Backend/API verdict: APPROVED;0 blockers.** Reviewed `ComposioClient.account_owner`, shared `_validated_account` checks, optional `ImportAccount.user_id`, and runtime binding. With no manual user supplied, the server reads only the explicitly selected connected-account ID through the project-key-scoped GET endpoint. It requires that exact ID, ACTIVE status, Instagram toolkit, enabled account/auth configuration, the expected auth-config ID, and a safe nonblank provider owner. It returns only sanitized identity. Runtime then revalidates that explicit owner/configuration and obtains the actual professional Instagram identity before persisting a binding. Existing different local profile/user bindings cannot be overwritten. There is no account listing, most-recent selection, guessed profile-derived user ID, or anonymous owner inference. Explicit older user-ID API requests remain compatible.

Reviewer added six API cases **only in `tests/test_learning_api.py`**, using the actual adapter with injected `httpx.MockTransport`: successful omitted-user import, explicit owner on the subsequent tool call, distinct app-scoped/professional Instagram IDs, rejected foreign config, missing/blank/control-character owner, and refused replacement of another workspace binding. Rejected cases create no account binding or dependent tool call; provider state/API keys remain out of replies.

Independent combined command `pytest tests/test_learning_api.py tests/test_learning.py tests/test_composio.py -q --tb=short -p no:cacheprovider`: **169 passed in5.92s**; existing Starlette/httpx deprecation warning only. Ruff and whitespace checks on reviewer-added API tests passed. No actual network, model or active database/lifespan was touched. Root separately owns the removal of the manual User ID field, clearer setup copy/contrast and its UI tests; that in-progress visual change is not claimed verified by these backend tests. Real OAuth/project-key/native-Keychain UX remains a live gate.

## Bounded catalog and actual provider follow-up — 2026-11-14
Actual account/post/insight probes ran read-only through the native Keychain credential. Both existing professional accounts returned owned posts and cumulative metrics using schema20261112_00. The first live attempt correctly held an owner mismatch: Instagram Login exposes a distinct app-scoped media owner ID. The adapter now retains two separately validated IDs from one fresh profile, keeps the saved professional pin exact, and permits media ownership only against those exact same-profile IDs. Owner namespace is recorded; no global alias or username fallback exists. No local clip mapping, policy activation, model call or public post occurred. Raw readbacks are private and excluded from Git.

Focused adapter/API tests:188 passed. UI chooser/async tests:21 passed. Route reviewer added15 cases and approved scoping/legacy binding guards; UI reviewer found no blocking async/scope issue after generation/unmount guards. Separate final namespace review and whole backend regression are in progress; no final follow-up approval is implied here.

Final namespace follow-up reviewer verdict: APPROVED, no blockers. Independent adapter/API188tests passed; whole backend931passed/6existing skips; Ruff/whitespace passed. Fresh IDs remain separate and exact, professional pins cannot be replaced with app-scoped aliases. Catalog rows remain display-only until exact media ownership/time is independently verified for mapping.
