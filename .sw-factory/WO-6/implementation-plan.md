# Summary
Deliver durable account-scoped learning work and real bounded draft experiments. Automatic drafts are authorized; publishing remains human approved and paid spending is excluded.

# Code Reuse And Package Structure
Reuse Store/put_many, Campaigns.require/snapshot/propose, existing Jobs and campaign_render. Create learning.py plus tests/test_learning.py for domain, learning_api.py for authenticated routes, autonomy_runtime.py for model/render adapters, and tests/test_learning_api.py. Wire app.py lifecycle only after integrating master. Existing clipping remains owned by teammates.

# Components And Flow
LearningEngine(store, collect, analyze, produce, clock) owns policies, publication mappings, cumulative snapshots, due work and receipts. Exact account/campaign/profile/source/clip/base IDs are validated before work. Durable lease and idempotency keys prevent duplicate collection/proposals. Exceptions persist bounded retries; ambiguous render submission must reconcile deterministic experiment context rather than blindly submit again. Policies permit hook or duration changes only; no global strategy promotion. Collector returns real normalized observations; analyst returns validated one-variable experiment with exact citations or insufficient evidence; producer invokes campaign render using parent clip and explicit changed inputs, leaving output unapproved. A periodic local worker runs tick while app is open and catches up after restart.

# Steps
1. Domain and injected-clock/provider tests in disjoint files.
2. Merge reviewed master backend changes.
3. Implement API contracts and local model/render adapters with provenance and model availability failures.
4. Wire background lifecycle and scoped readback; integrate Composio collector when configured.
5. Verify replay, cross-account, stale strategy, insufficient data, failure and actual changed render paths; independent review and branch-only handoff.

# Testing
Run test_learning.py/test_learning_api.py with PYTHONPATH set to this checkout. Test persisted restart, due3/6days, duplicate ticks, cumulative counts, nulls, wrong account, stale strategy, unknown effects, failed jobs and publication approval. Existing campaign/app/team tests protect production. Use isolated temporary stores; never enter a second lifespan against live allin-smoke. No live publish or ad spending. Native/API smoke after deliberate reload, with fixtures clearly separated from real metrics.

# Final integration detail
AutomationPanel.tsx/automation.css and GrowthApp Results-stage controls expose exact account import, policy cadence, tracked-post mapping, observations/work/experiment receipts, pause and due-only check. Fresh-state gating and duplicate-click protection are tested; no publication/spending endpoint exists. Models.run supports an explicit Ollama context bound; the learning prompt projects exact timed cues and avoids word-probability payloads. A small text model is tested separately from vision.
