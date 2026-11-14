# Independent single-navigation migration review

Verdict: **no remaining actionable P2 findings in the reviewed migration**. One stale model-setup breadcrumb was reported during review and is now corrected in FactoryHome to Brand profile → Advanced → Engine & models.

Read-only source review of EngineSetup.tsx/engine-setup.css, Setup/GrowthApp integration, deleted App/navigation/pages, shared SourceStages/clipOrder extraction, and Library/sourcePresentation actions. No product edits or concurrent tests were run. Landing-page changes and backend files are outside this review.

## Preserved capabilities and boundaries

- Engine & models is a focused Brand profile Advanced destination and context-scoped quick action. There is one GrowthApp/useFactory shell; the old App import, tools state, return surface and second Make/Grow navigation are removed. Engine modal presentation is gated by Setup's active state and retains its children when closed.
- Compared with the deleted Models page: the same model catalog metadata, repository, storage/license information, individual license consent, install/repair payload `{accept_license: true}`, confirmed removal, Ollama-owned management notice, runtime setup action, hardware readiness facts, local inference model/prompt and recorded outputs remain present. Unavailable model/system states remain explicit. Mounting EngineSetup, Jobs, Narration and SpeechSetup does not start model work.
- Existing SpeechSetup is reused for real speech setup/repair and worker progress. Narration is reused unchanged, preserving readiness checks, 5,000-character limit, separate audio generation, same-origin download validation and playback/download. Jobs is reused unchanged, preserving actual progress/unknown/error/results and explicit cancellation.
- Production defaults are intentionally narrower than the deleted global Settings page: only default_model, clip_count, production_strategy, autonomy and language can enter the partial draft. Save sends PATCH containing changed fields only; no brand, objective, ads/publishing permissions, budgets, Graph version or server capabilities are spread into the request. Missing/error settings block save; mounting and editing do not write. Post-save draft cleanup compares each value with the sent snapshot so a newer edit survives.
- Library's added rebuild/delete callbacks preserve the legacy storyboard and delete endpoints. Destructive deletion still requires confirmation naming the source. Both actions are disabled for fixture preview, workspace/factory busy/loading, stale source/job data and active source work. Model removal retains its confirmation and Ollama controls remain unavailable for app-owned removal. These are user-triggered actions; no replacement action is performed on mount.
- Source stages and newest-first ordering were extracted into growth-owned helpers; the episode stage words/statuses/details and immutable date ordering remain unchanged. No old page imports remain in product source. Existing production/clip review, transcript import/transcription, source playback/storyboard and current campaign/profile scoping remain in the unified surfaces.

## Limits

This is source/diff review, not native runtime certification. Root is validating modal navigation, compact geometry and the fixture UI; implementing agents are coordinating focused tests/build separately. The old ads/budget/global-permission UI is deliberately not migrated into local production defaults, consistent with the requested single-navigation boundary and no-permission-writes contract.
