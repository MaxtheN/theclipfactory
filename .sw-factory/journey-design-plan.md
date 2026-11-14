# Upload, production and review journey

Baseline: 57421d7, kartik/backend-integration. Product edits were held until the integration owner confirmed this baseline. This design task owns frontend presentation and import recovery only; no backend, API contract, renderer, AutomationPanel, README or version-control delivery changes.

## Summary
Compose the existing upload, production and exact-output review flows into a clear three-stage journey: Add footage → Produce edits → Review. Show pending work honestly, confirm separate saved-source and campaign-attachment receipts, and offer a deliberate next action. Use contextual Podcast N source labels while retaining original filenames and IDs.

## Reuse and package structure
Reuse workspaceApi upload/campaigns/save, useCampaignWorkspace.run/load, useFactory.refresh/data/errors, productionState.jobInScope/object, activeJob, existing Studio readiness/review/playback/critique gates and native form controls. Add JourneyProgress.tsx and journey-progress.css for one shared status surface; sourcePresentation.tsx for campaign-order aliases/provenance. Root owns FactoryHome and shared components. A design delegate owns Library/Studio visual-only wiring and journey CSS; a test delegate owns focused regressions; an independent reviewer owns the review note. Preserve fixed desktop-shell behavior and existing onboarding.

## Components and flow
- Source aliases derive only from campaign.video_ids order. Original Video.name, file bytes, IDs, API payloads and saved provenance remain unchanged. Library search includes both friendly label and original filename. Unattached sources have no invented campaign index.
- Upload is a synchronous Fetch POST whose receipt arrives after storage and media probing. No byte progress exists; show an indeterminate pending state with accurate copy. Do not invent transfer percentage, ETA or a separate media-preparation-complete event before the response.
- Confirm the returned Video identity before recording metadata-only pending import. Fetch the latest campaign and merge allowed fields. Validate attachment identity/profile/source membership, or adopt an already-confirmed attachment from GET. Keep the receipt if PUT/refresh fails and retry attachment without another upload.
- A response-unknown upload retains only metadata (original filename and preexisting IDs), blocks resubmission, and asks the creator to refresh local footage and explicitly identify a saved candidate. Never infer identity from filename alone or unlock retries merely because an unknown request has not appeared yet. Known rejections remain correctable. No new endpoint is introduced.
- Production statuses and percentages come only from scoped Job/TeamRun records. Pending/unknown states remain indeterminate. Failures and unavailable ledgers stay explicit; detailed tasks remain progressively disclosed. Completed jobs without matching existing clips do not enable review.
- Review actions open actual current-campaign/profile/attached-source Clip records through existing exact-identity callbacks. No automatic model, render, publish, approval or export action is added.
- Motion is finite on deliberate entry/confirmed completion, static under reduced motion; pending indicators represent real pending work. Controls remain keyboard accessible in the existing bounded content area.

## Steps
1. Inspect and plan while baseline delivery is in progress; hold product edits until confirmed.
2. Add shared progress and source presentation components/CSS.
3. Refine Factory import stages and recovery receipts; protect unknown writes and validate attachment responses.
4. Wire Library/Studio labels and factual worker/review status without altering render or review business logic.
5. Add delayed-request, duplicate-prevention, recovery, scope, filename/alias and status accessibility regressions.
6. Run affected suites, TypeScript/build and whitespace checks. Inspect desktop/compact states and sample fixture import/review UI, preserving the live Mac preview and actual engine separation. Obtain independent review and record evidence; no commit or push from this chat.

## Verification
Use delayed upload, attachment and reload promises to prove no false ready state. Confirm no duplicate uploads after attach failure, idempotent attachment adoption, invalid receipt handling, unknown upload lock across remounts, and explicit candidate adoption. Assert finite determinate progress only when real finite values exist; no ETA/fake percentage. Verify aliases follow campaign order, original filenames remain searchable and visible in details, and IDs/payloads/review destinations remain exact. Keep Studio’s existing readiness/playback/critique/export tests green. Use CUA against fixture Vite5179 only; do not invoke actual model/render/provider/publish workflows.

## Review inspector steering
The user explicitly requests cleaner Technical check details and Version history on the right of Production & review, plus removal of the right-side Back to Factory button. Give the inspector a dedicated compact evidence-row layout, visible review priority and quiet progressively disclosed technical/version/processing/context sections. Preserve all unknown/fail states, exact-version facts and approval/playback/critique/export gates. Remove only the Production page heading Back to Factory action; existing Factory navigation remains. Add focused presentation regressions where they protect preserved evidence and navigation.

## Final verification
Independent review is APPROVED; safety findings around fresh receipt acknowledgement, invalid attachment response, unknown write recovery,507 capacity rejection and concurrent detach were resolved. Final shared frontend312/312, affected51/51 and independent40/40 checks passed; TypeScript/Vite and whitespace checks passed. Browser fixture import/attachment, sourcealias/provenance, exactclipreview, expandedinspector and390px layout were inspected. NewstatusCSS was renamed gf-production-journey to avoid legacycampaignstyles. Compactsidebarlogo was bounded to itsrail. Latest user explicitly requested UI commit/push; include only design-owned frontend and these execution artifacts on kartik/backend-integration. Integration/backend/AutomationPanel and docs remain owned separately.
