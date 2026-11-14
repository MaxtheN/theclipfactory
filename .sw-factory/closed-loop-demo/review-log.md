# Closed-loop demo independent review

## Round 1 — NEEDS_CHANGES

Reviewed the direct task implementation against `.sw-factory/closed-loop-demo/implementation-plan.md`, scoped to new creative-score/growth-loop/demo modules, their APIs and fixtures, the narrow app/team/moments wiring, demo viewer assets, and package data. Unrelated Pearl and landing-page changes are excluded. Local baseline at review start: `8437186`; this review covers the uncommitted task delta, not the UI agent's isolated remote merge.

### Findings

1. **[P2] Exact-file assessment freshness is not checked when reading a scorecard.** `CreativeScores.view` builds each receipt's `current` flag using the clip record's stored SHA and text/context identity, without verifying the bytes currently at the clip path. A cached assessment can remain current after on-disk corruption or replacement, even though `request` and `run` correctly reject changed bytes. Verify integrity on view or explicitly label the result unverifiable/noncurrent. Add a regression that completes an assessment, changes file bytes without altering the stored SHA, then reads the scorecard.
2. **[P2] Real loop receipts omit real audience observations.** `GrowthLoop.view/reconcile` supplies render status and lineage only. `compare_observations` is called by the synthetic demo and tests but not by the real loop readout. Once a parent and revised clip have scoped publications and snapshots, the requested Loop #1 → Loop #2 view cannot display their actual outcomes or missing-window state. Add a read-only scoped join with explicit pending/unknown outcomes; call the comparison only for exact account/profile/declared equal-age windows with available metrics.
3. **[P2] Automatic judging does not cover follow-up revisions.** The post-ranking callback queues scoring for swarm run clips, but A/B and approved-rule recuts go through `campaign_render` without `rank_clips`, leaving those generated reels without the requested automatic assessment. Cover finalized revised outputs through the same consent/cache-bound scheduling path; do not double-charge already requested swarm outputs or turn an optional judging failure into a generation failure.

### Confirmed strengths

- Existing eight weighted production signals remain distinct from the new five-dimension, source-cited text opinion.
- Unknown AI dimensions remain null; output scale/citations are validated; there is at most one repair attempt; usage is separate from generation cost.
- New routes inherit authentication. Static demo filenames use an explicit allowlist. Viewer writes values using `textContent`.
- Growth requests keep durable IDs, parent hashes, exact approved-rule IDs, one-field edits, and unapproved outputs. Submitting/unknown render attempts are held for reconciliation instead of blind retry.
- Comparison requires known counts/denominators, minimum sample, complete windows, and matching real observation scope; synthetic outcomes remain separate.
- Simulation explicitly labels every metric, reviewer and plan as synthetic; no model calls, renders, real approval, publication, or persistent synthetic rows are claimed. Negative and insufficient-evidence scenarios exist.
- The negation repair addresses the observed semantic inversion; it is conservative and is not a general semantic-truth certification.

### Verification

Reviewer reran `PYTHONPATH=/Users/kartikbihani/WIN/growth-factory-integration /Users/kartikbihani/WIN/theclipfactory/.venv/bin/python -m pytest tests/test_creative_score.py -q`: 18 passed. Existing task evidence supplied by implementers includes growth unit/API/real FFmpeg tests and deterministic demo tests. Those do not substitute for a fresh source-generation check or the first real post.

### Demo acceptance boundary

The rehearsal uses synthetic clip metadata and plans as well as synthetic Instagram outcomes. It demonstrates shared scoring/comparison mechanics, not a live agent editing an actual reel in response to Instagram. Pair it with the live source-grounded assessment and actual original/B/recut render evidence, or add an explicitly labeled rehearsal path using a real selected clip. Do not claim that the standalone viewer alone proves the full live loop, causal lift, or 10× impact.

### Pending review

Parent is integrating `GrowthLoopPanel` into Results. Final UI/API contracts, async scope switching, request identity retention, exact score rendering, and browser checks require a subsequent scoped pass. The current verdict remains NEEDS_CHANGES until findings are resolved and verified.

## Round 1 follow-up

A fourth P2 was identified during UI review: `start_ab` and `recut` perform mutable parent/strategy preflight before checking the durable request identity in `_request`. If an accepted response is lost and the approved version changes before retry, the same request can return a new 409 rather than its existing receipt. The panel treats definitive 4xx as a failed request and clears the saved identity. Resolve existing request ID/fingerprint first, then preflight only genuinely new work; verify retry after rule advancement queues no duplicate.

The real-outcome join has since been added, and its nine new scoped/window tests passed in the review environment. It correctly keeps synthetic/demo-override snapshots out of real comparison. Its one-second equal-age tolerance is deliberately conservative; actual late cumulative reads may remain incomparable rather than being relabeled as exact three-/six-day observations. Final UI display and all other fixes remain under review.

## Round 2 — APPROVED

Re-reviewed the final code delta after fixes. No remaining actionable P1/P2 code findings were found in the scoped backend, APIs, demo viewer, or new Results panel.

### Resolutions

- GET scorecards now hash the actual file and mark old assessments noncurrent on mismatch/unavailability. The returned integrity state is visible, and the UI disables new assessment when integrity is held.
- Every finalized render can queue the exact-file/context/model-bound judge under existing cloud-agent consent; cached swarm post-ranking requests do not add a paid call. Real FFmpeg integration covers original, A/B, approved-rule recut and rubric-driven rehearsal output.
- Real loop readouts now join exact parent/variant publication mappings and scoped metric snapshots, retain unknown counts and provenance, display pending/window reasons and evidence IDs, and never treat demo overrides or synthetic observations as ordinary real outcomes.
- Accepted request IDs are looked up before mutable preflight. Tests cover returning the same receipt after rules advance, the profile is archived, or the parent file disappears; changed payload reuse still conflicts.
- Rehearsal now uses a real selected clip and an actual rubric weakness. An exact-current source-faithfulness hold can select a verified in-range payoff, or a measured long-hook weakness can select a source-grounded shorter hook. It records the rubric, assessment identity, weakness, source quote, before/after and rationale. It abstains if no safely supported single-field repair exists. Favorable synthetic engagement remains a separate prerequisite, not performance proof.
- The real rehearsal render retains synthetic-evidence provenance on the loop and clip, creates no real publication/learning metric rows, changes exactly the hook field, and remains unapproved. Negative/sparse scenarios and unsupported rubric edits do not force a draft.
- Results exposes scoped preference counts, opt-in A/B, approved-rule recuts, scorecards, the isolated replay and an explicit confirmation before a real rehearsal render. Scope switches ignore old async results; uncertain requests retain their identity. Dialogs can close while a request remains unresolved. Labels distinguish requested, completed and absent renders, and no-draft receipts show the rubric's reason.
- Palette references now use existing Pearl tokens; loop headings use actual parent receipt IDs rather than inferred adjacent numbers. Model opinions are readable dimensions/citations/costs instead of raw JSON.

### Reviewer verification

Sequential focused reruns in the current checkout:

- `tests/test_creative_score.py`: 19 passed.
- `tests/test_growth_loop.py`: 21 passed after the rubric-driven bridge changes.
- `tests/test_growth_loop_outcomes.py`: 9 passed.
- `tests/test_demo_loop.py`: 13 passed.
- `tests/test_growth_loop_render.py`: 1 passed in 3.22 s with actual FFmpeg output; exact single-field edits and unchanged parent bytes verified.
- `frontend/src/growth/growthLoopPanel.test.tsx`: 10 passed after the final dialog/label/retry fixes.

The primary agent retains responsibility for final checks after integrating upstream `5e6c6a`, browser/native visual verification and the user-facing fresh-generation/clip-caption review. This code-review approval does not claim a fresh real source run, a published Instagram post, completed real measurement windows, causal lift, model-weight training or a matched 10× human-effort benchmark. No publication is authorized by the rehearsal or by this review.
