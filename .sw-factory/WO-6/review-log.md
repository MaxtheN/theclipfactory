<!--lint disable strong-marker-->

# Review Log: WO-6

**Work Order:** WO-6 — Persist scheduled learning and execute bounded draft experiments
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

Reviewer inspected current `learning.py`, `autonomy_runtime.py`, `learning_api.py`, `app.py` integration, `AutomationPanel.tsx`, its CSS, GrowthApp insertion and Clip type extension. Review is independent of implementation; no product writes or active app/database/provider/model actions.

### Verified strengths

- Durable explicit campaign/profile/account/source/base/publication identities; immutable cumulative snapshots are not summed. Unknowns remain null. Policies permit only one actual hook/duration change. Current direction is rechecked before rendering. New drafts remain human-gated; this adapter exposes no publish or spend action.
- Keychain wrapper accepts native backends only; no key enters SQLite/settings responses. Composio provider errors are credential-safe. Model evidence is serialized intact, bounded, and includes exact metric snapshot; long inference runs on shared local Jobs rather than request thread.
- Worker checks real UTC due windows and catches up while open, with bounded collector/analyzer retries. Producer effects are claimed before submission; unknown results do not blindly retry.

### Initially found, now resolved in reread/temp-store repro

- Unknown render responses previously stayed held forever despite an exact persisted job. `_recover_submission` now adopts one exact tagged job, holds zero/multiple matches, and does not produce again.
- Native Instagram numeric user IDs were compared to Composio connected-account IDs. Current `_context` compares to the verified bound Instagram user instead; a same-user registration repro now succeeds.
- Runtime collector now pins `instagram_user_id`; learning-analysis Jobs now carry explicit source/profile/campaign/account/snapshot/publication/model context.

### Open blocking finding

**[P2] Human approval can race background completion reconciliation.** `LearningEngine.reconcile` requires `clip.approved is False`. A fast real render can appear in UI and receive explicit human acceptance before the 15-second background tick. That valid output is then marked `needs_reconciliation`, conflating production completion with subsequent human approval. A temporary-store repro with the exact saved job/clip and `approved_at` confirmed this state. Preserve proof of initial unapproved creation or accept valid server-recorded post-render human approval evidence; do not accept an autoapproved output without such evidence. Add a happy-path test for approval before the next tick.

### Advisory

- Publication time comes from the user, while snapshot source currently says Composio Instagram media insights. Preserve `published_at` provenance separately or verify provider timestamp before claiming an exact day-3/day-6 audience window.
- UI state parser checks row IDs, not full state shape; failed refresh leaves mutating controls enabled over stale cached rows. Backend guards reject invalid identities, but a conservative stale-state hold would improve reviewability.
- Pausing disables future work, not necessarily already queued production. State that distinction; disconnected grants are not revoked by local disconnect (API correctly reports false).
- Old published clips with stale base strategy are deliberately blocked; clarify that reviewing a new strategy does not automatically rebase those historical mappings.

### Tests and current verdict

Independent offline run `pytest tests/test_learning.py tests/test_composio.py tests/test_learning_api.py -q --tb=short -p no:cacheprovider`: **102 passed, 1 failed** during concurrent implementation. Failure: exact UTC string `Z` versus `+00:00` in new timestamp assertion; compare actual UTC values or use one canonical representation. API/runtime tests passed. Earlier domain/Composio-only snapshot:88 passed. Warnings: Starlette/httpx deprecation and empty pytest `match` in one new test. Native OAuth/provider/model UX was intentionally not exercised; these tests do not establish a connected real account.

**Interim verdict: CHANGES_REQUESTED** for approval/reconciliation race and final green combined verification. Root was notified with exact repro; a final review round will follow after fixes/tests stabilize.

## Independent review — final round (2026-11-14)

### Findings resolved

Reread confirms every blocking issue from the interim review is addressed:

- Unknown/expired producer outcomes reconcile through exactly one persisted render job tagged with experiment/source/campaign/profile identity; missing/multiple/invalid jobs remain held, with no blind resubmission.
- Instagram user identity is pinned separately from Composio connected-account identity, including native publication mappings.
- A creator accepting a new output before the next scheduler tick no longer invalidates production completion: acceptance requires the immutable worker receipt `approval_state_at_creation=unapproved` and a valid human approval time after render completion. Root's actual `app.py` render receipt now records that flag; unverifiable/preapproved outputs still reject.
- Publication time is now obtained from verified provider media identity, and the user must explicitly confirm the local-clip/remote-post mapping. User-supplied publication times are rejected at the API boundary. Mapping provenance is recorded.
- Analyzer context retains complete cues overlapping the opening of a manually selected cut; no opening speech is discarded merely because its cue starts slightly before the cut. Oversize JSON fails before inference. Scoped analysis Jobs protect source/model work and preserve snapshot/publication context.
- UI mutations hold on stale/unavailable state, exact account/profile scope is preserved, and pending requests are locked against duplicate submission. Production versus human approval versus publication remain separate.

### Added verification

At root's explicit follow-up request, reviewer changed **only** `tests/test_learning_api.py` to add route-wiring tests. These exercise real local domain/API integration with provider IO replaced at the seam: authoritative timestamp/day-3 due time, owner rejection, foreign-policy rejection before IO, missing/false mapping confirmation and forbidden manual timestamp, exact existing-account configuration/user/profile import, profile/user rebind rejection, and provider foreign-user failure without local persistence.

Final independent commands/results:

- `PYTHONPATH=. .../.venv/bin/python -m pytest tests/test_learning.py tests/test_composio.py tests/test_learning_api.py -q --tb=short -p no:cacheprovider`: **140 passed in4.49s**; one existing Starlette/httpx deprecation warning.
- `npm exec vitest run src/growth/automation.test.tsx`: **4 passed**.
- `npm exec tsc -- --noEmit`: **passed**.
- Ruff on reviewed domain/runtime/API/adapter/tests and subsequent added API tests: **passed**. Added-test whitespace check: **passed**.

### Remaining explicit live gates

User-facing/native OAuth/Keychain permission flow, actual account/tool grants, real audience collection, real-model hypothesis quality, and end-to-end autonomous render performance were not exercised by this independent review. No active app lifespan/database, real model/provider request, publication or ad spend was invoked. These are honest live-verification gates, not mocked successes. Root is handling the isolated real-model/render smoke separately. Local disconnect intentionally does not revoke upstream grants; pausing does not erase evidence or already submitted work. No causal lift/ROAS claim follows from cumulative counts.

**Final scoped implementation verdict: APPROVED. Total open code blockers:0.** Approval covers reviewed implementation and offline contracts, not a claimed live Instagram connection or proven audience improvement. WO-5 design/native polish and the production-agent fixes have separate owners/reviewers.

## Independent follow-up — effective opening normalization (2026-11-14)

Read-only review of the latest `LearningEngine._experiment` normalization and receipt fields. **APPROVED;0 blockers.** It resolves only an explicitly present nullable requested opening to `text_overlay` when independent saved physical facts agree: top-level actual treatment, strictly true burned-hook and hook-overlay flags, nonblank saved hook, and no cold-open boundaries. Missing or contradictory facts remain unsupported. Raw parent plan is preserved separately, the effective plan is a deep copy, normalization is disclosed, and the original parent record is not modified. Hook/duration proposals still require an actual one-variable physical change under the approved direction; completion verifies the frozen request and retains fresh human approval requirements.

Independent offline `pytest tests/test_learning.py -q --tb=short -p no:cacheprovider`: **56 passed in0.66s**. Tests include raw/effective plan separation, unchanged parent before/after completion, unapproved result, and rejected missing/contradictory facts. No model/provider or live database activity.

Final follow-up verification after setup-owner changes: independent combined learning/domain/API/Composio suite **169 passed in5.92s**. Latest effective-opening normalization remains approved, with raw parent evidence and fresh approval gates retained. No real model or live database calls were made by reviewer; real-model smoke results are root-owned evidence and are not inferred from these offline tests.
