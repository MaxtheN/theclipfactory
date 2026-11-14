# Learning loop: evidence to the next edit

This is the integration target, with current capabilities and missing automation distinguished. It does not claim a deployed autonomous growth system or measured audience improvement.

## Production loop

Saved campaign + selected profile/objective → creator-approved direction → local agent analysis or explicit edit plan → real render/checks → human-approved exact clip → verified export → publication record/real observations → analyst recommendation → proposed account-specific strategy → approval → next-source production with that version.

Every loop should expose the observation IDs, hypothesis, changed rule, proposal/base/version, approving decision and subsequent clip's immutable strategy snapshot. A receipt proves production happened; subsequent audience evidence is required to establish improved performance.

## What exists on merged main

- Persistent scoped campaigns, profiles, approved strategy versions, observations and learning proposals.
- An actual performance-analyst task inside campaign agent production when prior observations/feedback exist; otherwise it is explicitly skipped. Its typed output is recommendations with evidence references and limitations.
- Campaign `/learning` can save a complete changed Direction from known-value account-scoped observations. It remains a proposal until explicitly approved.
- Campaign `/produce` supplies approved direction and prior scoped evidence to local model roles, creates reviewable files and a task ledger. It is production, not an external precedent-research endpoint.
- Instagram insights sync exists for configured eligible accounts; structured manual observation import is also available. Historical imports must keep publication/source/window and remain labeled historical.
- Paid routes read insights and perform preflight only. There is no implemented ad-creation/activation/pause operation.

## Applying a rule must change actual production

| Approved direction field | Manual campaign render consumes it? | Agent campaign production receives it? |
| --- | --- | --- |
| hooks | Yes, defaults to first hook unless creator supplies override | Yes |
| duration_seconds | Yes, when end is omitted; explicit range is a recorded override | Yes |
| framing / caption_style | Yes | Yes |
| moment_selection / angles / pacing / editing_preferences | Not interpreted as edit commands | Passed in approved campaign context to planning/editing roles |

Therefore a selection-rule-only learning proposal must lead to **agent production** on the next source, or the creator must deliberately choose a concrete source/edit change. A manual render with the same explicit start/end/hook does not prove the selection rule was applied. Show the current-versus-proposed setting, production mode and the actual subsequent edit plan. A new strategy ID alone is insufficient proof.

## Smallest credible demo

1. Produce two opening treatments from real local footage, inspect actual checks, request a concrete linked revision and approve/export the exact accepted output.
2. Import a real historical observation with its account, publication and measurement window; do not fabricate a fresh audience result.
3. Show a cited recommendation (actual analyst output when available, otherwise creator-proposed and labeled) and a single account-specific strategy change.
4. Approve the changed strategy. Render the next source through a path that consumes that field, and show the changed edit decision plus preserved other-profile direction.
5. Report actual elapsed time, human intervention, acceptance and direct processing receipts against a matched manual baseline. Unknown cost or audience lift remains unknown.

This demonstrates an operational closed loop and explainable persistent learning. It does not establish causal lift, virality, self-training model weights or agency replacement.

## Remaining automation to make explicit

- There is no standalone campaign learning-analysis trigger that turns new observations into a full proposed Direction. Existing `/learning` persists a supplied proposal; the performance analyst currently runs inside production. A future bounded trigger should take exact observation IDs/current version, run one analyst, validate scope and available evidence, and save a draft. Missing data should end as insufficient evidence, not an unbounded retry.
- Reference/EvidenceBrief ingestion and external precedent research are separate missing backend capabilities. No URL-only “research complete” state.
- Duplicate observation/export writes are not idempotent on the current server. Reconcile uncertain writes and disable double submission; do not auto-retry.
- A brand/paid loop would add conversion attribution, currency/window, budget/action limits and separately authorized activation. Existing Reel preflight is a real gate, not an ad launch.
- The local app must be running for its existing scheduler. Continuous unattended operation while the Mac app is closed is not implemented.

## Autonomy boundary

Agents may propose and execute local production within the selected approved campaign context. Output quality/critic checks do not grant human approval. Publishing and paid actions require their separate account/configuration/authorization gates. Future automatic strategy application needs explicit allowed fields, evidence conditions, rollback/versioning and an approved policy; it is not implied by a model recommendation.
