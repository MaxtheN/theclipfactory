# Upload, production and review journey — independent review

**Verdict: APPROVED.** No blocking findings remain in the reviewed journey/inspector change. One minor existing compact-brand observation is recorded below.

Baseline: `57421d7`, branch `kartik/backend-integration`, isolated `growth-factory-integration` worktree. Product work was held until the integration owner confirmed that baseline. Reviewed against `.sw-factory/journey-design-plan.md` and latest user steering to clean the Studio inspector and remove its top-right Back to Factory control.

## Reviewed scope

Reviewed `FactoryHome.tsx`, shared `JourneyProgress.tsx`, `sourcePresentation.tsx`, `Library.tsx`, `Studio.tsx`, `ClipEvidence.tsx`, `journey-progress.css`, the Studio-specific heading condition in `GrowthApp.tsx`, and relevant import/production/evidence tests. Read the owning `workspaceApi`, `useCampaignWorkspace`, `useFactory`, production scope/approval helpers and backend upload implementation to verify existing contracts. No product files were edited by this reviewer.

## Correctness and data safety

Upload progress is indeterminate while the synchronous Fetch upload awaits its source receipt; no transfer percentage or ETA is invented. Confirmed upload and campaign attachment are represented as separate facts. The existing backend can start production under its autonomy settings, so upload copy now accurately says those settings still apply rather than promising that import can never start work.

Confirmed imports retain metadata-only campaign-keyed receipts across profile/route remounts. Upload identity is checked before attachment. Attachment merges the latest campaign source list using an allowlisted body, validates returned campaign/profile/source membership, and adopts an already-attached source from a checked GET without another PUT. Unknown upload outcomes block further uploads, retain only filename/prior IDs, and require refresh plus explicit candidate choice; filename matching never adopts a source automatically or unlocks a blind retry. Known validation/capacity rejections remain correctable.

The reviewed change resolves these concrete findings:

- `useFactory.refresh` records errors without rejecting. Consequently a successful `w.run` result alone cannot prove source visibility. The acknowledgement effect now waits for settled loading, current campaign membership, a matching local video row and no workspace/video read error before clearing the receipt or exposing the new-source production CTA.
- A confirmed attachment survives a failed reload and offers recovery despite existing read errors. If a teammate detached the source, the first refresh detects that condition without PUT, changes to an explicit Attach action and requires that deliberate action before reattaching.
- Invalid attachment responses retain the confirmed import rather than reporting success or uploading again.
- Backend upload status 507 is a definite capacity rejection before storage; it no longer creates an indefinite unknown-write lock.

Podcast aliases derive from `campaign.video_ids` order. Original `Video.name`, IDs, request bodies and saved provenance remain unchanged. Original filename/source ID remain available through native disclosures; Library searches aliases and original names in both views.

Production status comes from scoped Job/TeamRun records, including nested run campaign snapshots. Finite server progress is clamped for presentation; missing/non-finite progress stays indeterminate. Missing ledgers, failures and completed work without the exact existing output remain explicit. Historical failures do not supersede a newer completed attempt. Review actions receive actual current-campaign/profile/attached-source clip identities. Studio's exact submitted-job result selection, readiness, playback, critique, approval, retry and export guards remain intact. This change adds no automatic production, approval, publish or export call.

## Hierarchy, accessibility and craft

The shared status surface has a unique `gf-production-journey` namespace, avoiding legacy campaign-progress layout rules. It communicates Add footage → Produce edits → Review without implying measured transfer progress. Status text is announced; native progress and disclosures retain semantics. Pending activity cues run only for actual pending work and become static under reduced motion.

The review decision and blockers now lead the Studio inspector. Technical checks, version history and remaining receipts use aligned compact disclosures and semantic definition lists, with wrapping IDs/values and explicit unknowns. No evidence facts or qualifying text were removed. The top-right Back to Factory control is removed only from Studio; its other contexts remain unchanged. Fixed viewport/internal scrolling is preserved.

## Verification evidence

- Reviewer independently reran FactoryFlow, StudioProduction and ClipEvidence: **40/40 passed**. An earlier run found one test query assuming a unique Find clips control; it was scoped to the Import region, then the complete affected run passed. This was an expected duplicate-label test query, not a duplicate-write product defect.
- Reviewer independently ran the TypeScript/Vite production build: **passed**, single-file output 632.23kB, gzip 202.65kB. Scoped whitespace checks passed.
- Tests delegate reported **303/303 across 23 frontend files**, focused **51/51 across five files**, plus TypeScript/format/whitespace checks. Coverage includes delayed upload/attachment/reload, invalid receipts, swallowed read errors/missing records/membership, recovery and deliberate reattachment, known versus unknown outcomes, remount locks/manual adoption, exact review identity, alias/name search, fixture provenance and determinate versus indeterminate progress. Parent owns the final post-presentation root rerun.
- Reviewer independently viewed `journey-source-ready.jpg`, `production-review-clean.jpg`, `production-review-details.jpg` and `production-review-compact.jpg` under `/Users/kartikbihani/WIN/research/growth-factory/integration/`. They show a clear saved/attached receipt, deliberate next actions, orderly inspector actions/facts/details, explicit illustrative provenance, and a readable compact inspector without the removed top-right control.
- Parent actual-browser evidence reports a harmless fixture placeholder import through the file chooser, confirmed source/attachment/refreshed Podcast 3, a sample-only manual handoff, and Factory Review clips opening the exact fixture identity. No real backend/provider/model/render/publish action or human approval was used. Compact page/viewport remain 390×844, window scroll stays zero, inspector width is 302px and visible Back to Factory controls are zero. This reviewer inspected saved browser images/source rather than operating the native window.

## Nonblocking observation and ownership

The compact screenshot also shows the existing enlarged white brand cropped at the edge of the collapsed sidebar. A collapsed-only mark size adjustment would improve that chrome, but it is outside the journey/inspector delta and does not affect the reviewed flow or content reachability.

Only this review note was added by the reviewer. No commits, pushes or other-chat messages were made. Parent owns final root verification, work-order status and delivery. Approval is scoped to the reviewed implementation and evidence, not production media/backend qualification.

## Final verification and advisory resolution

The reviewer independently viewed the updated `production-review-compact.jpg`: the white mark now fits inside the compact sidebar. Parent browser measurements report a 28×20px mark spanning x15.5–43.5 inside the 60px rail, with page width remaining 390px. The compact-brand advisory is resolved; **APPROVED with zero outstanding blockers or advisories**.

Parent final checks passed: **312/312 frontend tests across 23 files**, including integration-owner tests, plus TypeScript/Vite build (632.25kB, gzip202.66kB). Parent subsequently reports selective journey commit `0c08dd2` pushed to the team feature branch. This reviewer made no Git/index changes.

## Final parent verification and compact chrome fix
The final shared frontend suite passed312/312 across23files, and TypeScript/Vite build passed632.25kB/gzip202.66kB before the compact-only logo adjustment. The logo now measures28×20px within the60px rail (x15.5–43.5 at390px); pagewidth stays390px. This resolves the nonblocking crop above. The Mac fixture preview remains separate from the actual engine, with live Vite5179 updates. The user's latest explicit instruction authorizes selective commit and push of these design-owned files. No backend/AutomationPanel/docs changes are included.
