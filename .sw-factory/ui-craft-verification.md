# Desktop UI verification — 2026-11-14

Baseline requested:8c13958. Teammate engine/handoff commits advanced HEAD to7c539f8 during this work. Product changes are frontend presentation/navigation; no backend, engine, credentials, landing-page or Supabase scratch changes are included.

## Result
Brand profile uses four focused editor cards with shared persistent native dialogs, internal scrolling and conditional saves. Account/Goals use wider dialogs. New kit edits made during earlier saves remain dirty and validated. Context-scoped Goals requests and active surface gating prevent old/hidden dialogs taking over another route. Advanced tools is in bottom-left navigation. Style rule saving/approval stays on the page; returning to Factory is explicit. The content landmark's browser focus outline no longer creates full-height side lines; controls retain their own focus styling.

Factory uses numbered phases, restrained status colors, bolder measured connectors and fluid columns that fit a1280px desktop window. Its run listbox escapes ancestor clipping and supports bounded placement and keyboard selection. Phone previews share a decorative right rail without invented counts. Review keeps quality and approval inline; posting, technical/version/export evidence and production logs open on demand. Posting status/recovery warnings and held-clip reasons remain accessible. Closing/navigation preserves posting drafts. The posting submit button stays in normal form flow, clear of held reasons.

Results separates Posted clips and Insights. Accounts, manual results and upgrade tools open in persistent dialogs. Real measurements, unknown values, demo/source labels, hash entry points, scoped polling and existing actions remain intact.

## Automated checks
All commands ran in groups of one or two Vitest files, sequentially:
- PanelDialog + channelSettings:24 tests passed (includes deferred kit edits/readback and draft retention).
- workspace + websiteBrief:32 tests passed (includes no automatic Studio navigation, notes-only drafts, context-scoped Goals requests).
- factoryMap + flowEvents:18 tests passed.
- postToInstagram + studioProduction:40 tests passed (includes held reasons, inactive-surface close and caption/schedule draft retention).
- resultsStory + resultsLearning:13 tests passed (includes account deep links and persistent manual draft).
- factoryLine:14 tests passed; onboardingShell:6 tests passed after explicit focused-editor interactions were updated.
- npm run build: TypeScript and Vite production build passed.
- git diff --check passed.

## Browser verification
CUA on the review-only Vite5179 transport, including clearly labelled sample flow fixtures. Verified populated Factory/Results, all five map phases fitting, menu bounds and End/Enter run selection, profile editor Escape/retention and save/readback hiding the clean Save control, wide Account/Goals, Cmd-K opening Goals, approval staying in Style rules, phone rail/handle, technical/history details and grouped production log. Verified Cmd-K navigation from posting closes its native dialog and reopening retains unsaved caption. Checked held textarea and submit bounding boxes: no overlap. Verified focused #growth-main has no rendered outline/borders. Desktop1280×720 and1440×960/1000; compact390×844 has no document overflow and bounded modal geometry.

Screenshots outside repo:
- /Users/kartikbihani/WIN/research/growth-factory/integration/ui-craft-final-profile.png
- /Users/kartikbihani/WIN/research/growth-factory/integration/ui-craft-factory-map.png
- /Users/kartikbihani/WIN/research/growth-factory/integration/ui-craft-results.png
- /Users/kartikbihani/WIN/research/growth-factory/integration/ui-craft-run-picker.png
- /Users/kartikbihani/WIN/research/growth-factory/integration/ui-craft-posting-sheet.png

This verifies UI behavior with review fixtures, not new inference, real video playback, account creation or real publishing. The actual engine quality work is a separate landed change. No real provider/model/render/post action was invoked by this UI pass; the preview's simulated clip is explicitly illustrative and does no media processing.

Independent reviews are recorded in the adjacent profile, map/phone, Results and production review documents. Their actionable findings were fixed and covered by targeted regressions. The user's latest request for three broad visual directions is approval-gated; its comparison is outside the repo and no proposed palette was applied.
