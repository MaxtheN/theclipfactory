# Summary

Add reversible campaign archive/restore so old test work disappears from the default campaign list without deleting footage, clips, profiles, connected accounts, strategies or receipts. Archiving pauses associated learning policies in the same transaction; restoring never re-enables them.

# Code Reuse And Package Structure

Reuse `Campaigns`, its shared `Store.lock`, `Store.put_many`, UTC `now()` timestamps and existing FastAPI campaign routes. Modify only `clip_factory/campaigns.py`, `clip_factory/campaign_api.py` and new focused `tests/test_campaign_archive.py`. This plan is the only additional execution artifact. No live database, media-file, model/provider or Git actions.

# Components And Flow

- `Campaigns.list_campaigns(include_archived=False)` filters records with a nonempty `archived_at`; absent/null means active.
- `POST /api/campaigns/{id}/archive` returns the campaign record with stable `archived_at`/`updated_at`. Repeat archive is idempotent. Under one store lock, check related active work, then atomically save the archived campaign and disable its enabled learning policies.
- `POST /api/campaigns/{id}/restore` clears `archived_at`, records `restored_at`/`updated_at` and returns the campaign. Repeated restore is idempotent. Policy state stays paused.
- `GET /api/campaigns?include_archived=true` explicitly includes archived records for recovery. Individual campaign, strategy and observation history GETs remain readable.
- A shared active-campaign guard rejects campaign updates, strategy proposals/decisions/restoration, new observations/learning proposals and production snapshots with HTTP409. Production route callbacks also check before dispatch. No immutable history is rewritten.
- Active job/run checks inspect only known dictionary shapes: direct campaign scope, context campaign/snapshot, linked clips/team runs/experiments and unscoped source work using a member video. Explicitly foreign campaign scope wins over shared video membership. Malformed optional context must not crash the check. Related active learning work also blocks archival before its job exists.
- Root must apply the same archived-campaign guard when enabling learning policies/binding new automation work in its separately owned learning modules. This change pauses current policies and blocks production through `snapshot`; it does not edit those modules.

# Steps

1. Implement list, guard, related-work detection and transactional idempotent archive/restore in the campaign domain.
2. Add explicit archive/restore routes and optional list flag; guard production callbacks.
3. Add isolated domain/API tests for filtering/recovery, preservation, atomic policy pause, idempotency, active work and archived writes/production.
4. Run the focused suite and relevant campaign regression tests with no real media/model/provider effects; report contracts and remaining root integration point.

# Testing

Use temporary `Store` instances and a minimal FastAPI app with injected render/produce callbacks. Verify records and sentinel media bytes are unchanged; force transaction failure to show no partial archive/policy update; cover queued/running scopes and malformed context. Run `python -m pytest tests/test_campaign_archive.py -q` and appropriate existing campaign tests, plus Ruff on owned Python files. Root will back up and archive exact live demo campaign IDs only after review.
