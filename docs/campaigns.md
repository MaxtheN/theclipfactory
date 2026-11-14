# Campaigns, profiles and saved learning

Campaigns is the primary entry point for new work. Local profiles describe an audience, brand, user-selected objective/primary metric and creative preferences. They are **not** live Instagram connections; multiple offline profiles work with no connection. Existing unassigned videos, clips and jobs remain intact and are never assigned invented strategy provenance.

## Continuous local workflow

1. Import source videos in Library. In Campaigns save two profiles and create a campaign with both profiles and sources. Edit its brief, constraints, requested outputs and measurement intent without rebuilding the campaign.
2. Propose initial direction for every profile. Save angles, selection rules, hooks, pacing, duration, framing, caption treatment, editing preferences, measurement questions, next experiments, limitations and confidence. A proposal is not an active strategy. Explicit approval activates it.
3. Render a campaign clip with an approved direction, or select an exact Direct Clip range. Deterministic rendering applies supported duration, fit/fill framing, standard/high-contrast transcript captions and a separate opening-hook overlay. A supplied direct range stays exact rather than being shortened silently; deviations are recorded. Free-text instructions are retained for provenance, not claimed as an implemented general editing language. Pacing and semantic selection rules require agent interpretation rather than a deterministic multi-segment edit engine.
4. Alternatively run the campaign agent team with installed local prerequisites. Its ledger, role inputs and outputs remain in Factory. The team receives the captured account direction and only that campaign/profile's clip evidence. Duration violations fail bounded validation before critique; deterministic rendering enforces supported framing and caption treatment. Critic pass never replaces human approval.
5. In Factory preview and review outputs. A burned-in hook cannot be relabeled through metadata editing: render another output to change the video. Post copy can be edited independently. Local clip approval does not enable publication or spending.
6. Import actual manual performance observations for an approved campaign clip. Keep metric, nullable value, unit, publication reference, observation window, collection time and notes. Blank is unavailable, not zero. Times require timezones; counts are whole and percentage values are bounded. Imported records preserve a snapshot of the reviewed clip, never overwrite earlier observations, and are separate from creator preferences or live platform metrics.
7. Select known-value evidence for one profile, describe a hypothesis and propose revised direction. This creates a **proposal**, not proof of improvement or causal lift. Approve it explicitly before using it on the second source. Other profiles' direction stays unchanged; evidence from another campaign/profile is rejected. Restoring an earlier approved profile direction also creates a proposal, leaving the other profile untouched.
8. Reopen the application: campaign, approved pointer, rejected/proposed versions, evidence and production snapshots persist in SQLite.

## Version and concurrency boundaries

Saved strategy versions are immutable except for their proposal decision metadata. Every production captures campaign/profile IDs, strategy version, approved direction, profile context and brief **at queue admission**. Approving a later version does not rewrite queued or completed production. The UI sends its displayed version; a stale version returns a conflict requiring reload. Concurrent same-base approvals cannot silently overwrite each other: strategy decision and active pointer commit in one transaction. Membership can be extended; removing historical members is refused to preserve references.

Named-profile evidence is never mixed into legacy unassigned production or analysis. Team comparisons include campaign/profile/effective saved context; different profiles or revisions are not automatically labelled comparable.

## Optional narration and operating limits

Standalone local narration preparation remains an optional, explicitly requested text-to-WAV helper in Models. It produces synthetic audio separate from source speech, can be previewed/exported without Instagram, and never mixes or publishes it automatically. It is not part of the required hackathon demo; integrated generated voice/music editing and dubbing remain later scope. The matching Factory Requirements clarification is a pending review suggestion, not a claim that the document has already been approved.

Production retains one heavy worker and three independent download workers. External publishing/spending gates, native keychain behavior and lightweight authenticated launch health are unchanged. The implementation is not a claim that every broader product acceptance target is complete (general clip-version editing/packaged provenance exports, controlled experiment evaluation, research/precedent collection and target-M5 inference still require separate verification/work).

## Evidence

`tests/test_campaigns.py` covers domain approval, restore, restart, evidence isolation, concurrency and transactional rollback. `tests/test_campaign_api.py` exercises authenticated APIs and actual FFmpeg video: two local sources, two profiles, distinguishable rendered hook variants, a requested changed output, imported test-fixture observations, approved profile-specific direction applied to source two, and reopening the actual application. Fixture metrics prove plumbing, **not audience improvement**. Frontend tests exercise profile/campaign/strategy/evidence forms and failure gates. Native Cocoa open/authentication/close/reopen checks remain separate from model inference.
