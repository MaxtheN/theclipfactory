<!--lint disable strong-marker-->

# Review Log: WO-10

**Work Order:** WO-10 — Archive test campaigns without losing production history
**Initialized At (UTC):** 2026-11-14T14:38:07Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1

Independent skeptical review of the uncommitted WO-10 backend diff (`clip_factory/campaigns.py`, `campaign_api.py`, `learning.py`, tests). Fixes were applied in this round and re-verified; findings below record what was found before the fix.

### Requirements Alignment

**Blocking:**

- (High, fixed) Pending publish schedules (`schedules` rows with `status="scheduled"`) were not treated as active work. Archiving a campaign with a scheduled Instagram post left a timed external publish that the scheduler would submit later. `_has_active_work` now treats a `scheduled` schedule linked to a campaign clip as active (409). Regression: `test_pending_publish_schedule_blocks_archive_but_finished_schedule_does_not`.
- (Medium, fixed) Clip-level new effects for an archived campaign's clips were unguarded: `POST /api/clips/{id}/publish`, `/schedule` and `/team-review` still worked. Added `Campaigns.ensure_clip_campaign_active` and called it in those three `app.py` routes under `operations_lock` (the scheduler goes through `publish_clip`, so it is covered too). Reconcile stays allowed (it settles an existing external effect). Regressions: `test_archived_campaign_clip_rejects_new_clip_level_effects`, `tests/test_campaign_api.py::test_archived_campaign_clip_cannot_publish_schedule_or_recheck`.

**Advisory:**

- (Low, fixed) Repeat archive was not idempotent once later work existed (e.g. an allowed reconcile job on an archived clip made a second archive return 409). Already-archived campaigns now return the stable record without re-checking work. Regression: `test_repeat_archive_stays_idempotent_when_later_work_exists`.
- (Low, fixed) The new learning tick check used `_require("campaigns", ...)`, so a policy whose campaign record is missing would raise 404 and abort the whole tick (previously that work was recorded as `blocked`). Now uses `store.get(...) or {}`. Regression: `tests/test_learning.py::test_tick_with_missing_campaign_does_not_abort`.
- (Open) Clip edit (`PUT /api/clips/{id}`), feedback, export and `DELETE /api/clips/{id}` remain allowed for archived-campaign clips. Archive/restore themselves never delete records or files (verified by the byte/record snapshot test), but a user can still delete an archived campaign's clip through the pre-existing clip delete route.
- (Open) Active-work detection fails closed: a `learning_work` row stuck `running` after its lease expired while its policy is disabled, or a `team_runs` row left `queued` without a job, would block archive until cleaned up.
- (Open) `_recover_submission` in the learning tick still reconciles existing experiments of archived campaigns. It only settles prior effects; it claims no new due work.
- (Open) `configure_policy` on an archived campaign rejects every change, including disabling. Harmless because archive already pauses the policies.

### Blueprint Alignment

**Blocking:** none.

**Advisory:** Plan said only `campaigns.py`/`campaign_api.py` would change; `learning.py` (binding/tick guard) and three `app.py` clip routes were also changed. Both are the minimal places the guard must live.

### Architecture And Conventions

**Blocking:** none.

**Advisory:**

- Locking: `operations_lock is store.lock is Jobs.lock` (one RLock). Archive checks and writes under it; `campaign_render`/`campaign_produce` hold it across `snapshot()` and `jobs().submit()`; `submit_production` creates the team run and job under it; the learning tick checks archived and claims under it, and the claimed `running` work blocks archive until it finishes. No window was found where a job/run/claim can start between the active-work check and the archive write. The extra `with campaigns.store.lock` in `campaign_api` render/produce is redundant (reentrant) but harmless.
- Schema: records are JSON blobs in one `records(kind,id,data)` table. No column or migration is needed; an absent/null `archived_at` means active, so existing SQLite databases are read unchanged.
- Restore sets `archived_at=None`, `restored_at`, `updated_at` only; it never touches policies.

### Tests And Build

**Commands run** (repo root, one file at a time, offline, temp stores only):

- `PYTHONPATH=. .../theclipfactory/.venv/bin/python -m pytest tests/test_campaign_archive.py -q --tb=short` -> 44 passed
- `... -m pytest tests/test_learning.py -q --tb=short` -> 59 passed
- `PATH=.../.growth-factory-tools/bin:$PATH ... -m pytest tests/test_campaign_api.py -q --tb=short` -> 10 passed
- `... -m pytest tests/test_learning_api.py -q --tb=short` -> 37 passed
- `... -m pytest tests/test_campaigns.py -q --tb=short` -> 55 passed
- `... -m pytest tests/test_app.py -q --tb=short` -> 58 passed (covers the modified publish/schedule routes)
- `... -m ruff check clip_factory tests` -> All checks passed

**Blocking:** none.

**Advisory:** Full suite was not run (memory constraint). The new regression tests were not run against the pre-fix code to watch them fail.

### User-Facing Verification

**Skipped:** yes - backend-only review; starting the app against the live data dir is prohibited. API behavior was exercised through TestClient on temp stores.

**Evidence:** API tests above.

### Security, Privacy, And Data Safety

**Skipped:** no

**Blocking:** none after fixes (the scheduled-publish gap was the external-effect risk).

**Advisory:** No live data, provider or model calls were made. Root still needs to back up the live DB before archiving the demo campaigns.

### Round 1 Verdict

- Total blocking: 2 found, 2 fixed (0 open)
- Total advisory: 8 (2 fixed, 6 open/accepted)
- Files reviewed: clip_factory/campaigns.py, campaign_api.py, learning.py, app.py, jobs.py, team.py, store.py, tests/test_campaign_archive.py, tests/test_learning.py, tests/test_campaign_api.py
- **Verdict:** APPROVED (after the Round 1 fixes; open advisories accepted as follow-ups)

---

<!-- Subsequent rounds: copy the structure above and increment the round number. -->
