<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-3

**Work Order Number:** WO-3
**Work Order Title:** Kartik: Build interface and user flow
**Initialized At (UTC):** 2026-11-14T10:12:16Z

## Phase 1: Context Gathering

### Required Steps

- [x] Review work order description provided by MCP tool output
- [x] Identify linked requirements and blueprints
- [x] Review every connected requirements document
- [x] Review every connected blueprint document
- [x] Follow `@…` mentions **and links** to other blueprints in linked documents and read each referenced blueprint via MCP
- [x] Review every referenced blueprint discovered that way; add them to **Referenced Blueprints** in `context.md`
- [x] Extract acceptance criteria from requirements
- [x] Identify architecture path from blueprints (components, contracts, composition)
- [x] `context.md` is filled or updated with `execution/scripts/update-context-index.sh` for Work Order, connected requirements, connected blueprints, referenced blueprints, and known delivery links

- [x] **Certification: Phase 1 complete. Proceeding to Phase 2.**

## Phase 2: Planning And Implementation

### Implementation Plan

(see `execution/writing-implementation-plans.md`)

- [x] Implementation plan documented in `implementation-plan.md`
- [x] Testing section documented in `implementation-plan.md`

### Implementation

- [x] Implemented changes are scoped to the Work Order
- [x] Tests added or updated for changed behavior
- [x] Documentation, generated files, fixtures, migrations, or config updated where relevant

- [x] **Certification: Phase 2 complete. Proceeding to Phase 3.**

## Phase 3: Review And Verification

### Review

- [x] Review subagent spawned per `execution/review.md` and returned a verdict
- [SKIP] Full production acceptance across linked requirements
  Skip reason: User explicitly directed interface-first delivery. UI journey, adapter and sample preview are verified; real research, renders, evidence evaluation and live integrations remain teammates' integration work. This is not full product acceptance.
- [x] Architecture is aligned with linked blueprints, or documented drift is accepted
- [x] Exploratory pass on user-visible or external behavior — not only automated tests; for browser apps, use browser-based testing if available. Brief notes in `review-log.md` or evidence.
- [x] Latest `review-log.md` verdict is `APPROVED`

- [x] **Certification: Phase 3 complete. Proceeding to Final Completion.**

## Final Completion Check

- [x] All phase certifications above are complete
- [x] Checklist is fully filled out with evidence
- [x] Review log is complete (`review-log.md`)
- [x] Implementation plan was followed (`implementation-plan.md`)
- [x] All intended files are present in the working tree
- [x] Work order status updated to `in_review`

## November 14 design refinement

- [x] Reread current WO-3, all four linked requirements and all four blueprints (including cross-links); no additional concrete referenced blueprints found. Results blueprint is still a template; existing contracts continue to govern.
- [x] Wrote bounded visual refinement plan before implementation; leave README files and storage untouched.
- [x] Refined shared presentation and concise shell/Setup copy; no API or workflow changes.
- [x] Existing 148 frontend tests and TypeScript/Vite production build passed.
- [x] Reviewed all four stages at desktop width and compact Research/Studio/Results layouts; 390px and 900px page overflow checks passed. Saved visual evidence at `/Users/kartikbihani/WIN/design/growth-factory/interface-refined-setup.jpg`; browser console had no errors.
- [x] Independent review Round 4 APPROVED; responsive real-video sizing and architecture-copy advisories resolved. No new unresolved findings in this pass.
- [x] Existing Vite server and native viewer processes preserved. No storage reset or competing native window opened; fresh native visual automation was unavailable, so no new native smoke is claimed.
- [x] Work order returned to In Review. Latest user instruction keeps the entire change set on `kartik/growth-factory-interface`; no main/master push or merge occurred.

## Hierarchy, glass and primary-action delight

- [x] Bounded implementation plan recorded before product edits; existing requirements/blueprint and approval boundaries retained.
- [x] Related campaign, profile, hypothesis, experiment, source/range and edit-treatment controls grouped semantically; no persistence/API changes.
- [x] Frosted web surfaces with readable fields, unsupported-blur fallback and reduced-transparency preference; native wallpaper transparency is not claimed.
- [x] Primary CTA visual text swaps on enabled hover/focus and decorative plane loops. Accessible name covers both visual labels; disabled action remains unchanged. Reduced motion disables the loop.
- [x] All 148 frontend tests and TypeScript/Vite build passed after final accessibility fix; no redundant cosmetic tests added.
- [x] Desktop screens and 390px Setup/Studio/Results layouts inspected; no page overflow. Button dimensions stayed 225.39×48px before/after focus; invalid range disabled production and removed flight animation. No console errors.
- [x] Independent review Round 5 APPROVED; label-in-name advisory resolved. Screenshot: `/Users/kartikbihani/WIN/design/growth-factory/interface-frosted-hierarchy.jpg`.
- [x] Existing native viewer and Vite processes preserved; no user draft reset, README change or default-branch push.
- [x] Team WRITE permission verified after invitation acceptance; existing delivery pushed to `MaxtheN/theclipfactory:kartik/growth-factory-interface`, which is now upstream. Work order returned to In Review for this pass.

## Progressive desktop workspace and supplied reference

- [x] Recorded evolving hierarchy, accordion, command-modal, interaction and reference scope before implementation. Final supplied reference supersedes the earlier light palette.
- [x] Brief → footage → shared primary action; optional settings/references/checks/receipts folded; mandatory feedback, errors and approval blockers visible. Stage drafts remain mounted.
- [x] Compact labeled SVG navigation in campaign and Tools. Arrow control lives inside both sidebars, rotates and retains a 64px expand rail; static Campaign label cannot accidentally hide primary stages.
- [x] Compact ⌘K trigger opens real searchable native HTML dialog; keyboard/filter/Enter/Escape, focus isolation/restoration and disabled/new-campaign guards verified. No approval/render/publish commands added.
- [x] Smoked slate/copper glass, ivory type, warm-white primary actions and dark fallbacks applied across main screens, Tools and modal; readable summary hover/focus and subtle input focus verified. Preview banner removed by request; individual sample labels retained.
- [x] 154 frontend tests passed, including dialog/integration and sidebar-draft regressions. TypeScript/Vite build passed; diff checks clean. No redundant cosmetic tests added.
- [x] Browser reviewed all four campaign stages, modal, Tools/Settings and compact 390px rails without horizontal overflow; checked readable summary hover, no oversized input outline, command navigation/focus and retained draft. Console errors absent.
- [x] Independent review rounds 6, 7 and final reference Round 8 APPROVED; compact advisory resolved. Current screenshots: `/Users/kartikbihani/WIN/design/growth-factory/interface-smoked-desktop.jpg` and `quick-actions-smoked.jpg`.
- [x] Native feasibility read-only: no live vibrancy setter; private-mode relaunch risks WebKit data. Existing viewer/Vite/WebKit connection preserved without restart or storage reset. No desktop-through vibrancy or rebuilt packaged-app claim.
- [x] Documentation reflects final reference and team-feature-branch delivery; no README/default-branch/backend/native-launcher changes. Work order returned to In Review.

## North Star, material correction and final craft

- [x] Recorded restraint/growing-field plan and evolving user material/motion corrections before implementation; adopted attached North Star without changing workflow boundaries.
- [x] Final luminous slate/copper canvas transmits through 22% panel tint; shared token contract across campaign, Tools and CmdK. Removed opaque-charcoal regression, ambient ornaments and nested glass; exact palette and compositing assumptions documented.
- [x] Shared controlled AutoTextarea migrated 37 free-form controls; hidden mirror preserves focus/caret/handlers. Rows minimum, 240px cap/internal scroll, grow/shrink, width/font/disclosure remeasurement; appropriate structured controls retained.
- [x] Standard Lucide PanelLeft inside sidebar; decorative topbar folder removed. Shared type/title contract and ivory native checkbox/radio states with visible unchecked/disabled, indeterminate, focus and forced-color fallback.
- [x] Stable action labels with distinct bounded flight/sweep/check/produce/iterate cues; reduced motion respected. Full native disclosure height/opacity and CmdK scale/fade/exit animations preserve immediate commands/focus.
- [x] 158 tests across 11 files passed, including four meaningful AutoTextarea regressions; final TypeScript/Vite build passed. Diff checks clean; independent Rounds 9 and 10 APPROVED, final hover advisories resolved.
- [x] Browser verified grow83px/cap240/shrink41, hidden reveal188, compact cap/no390px overflow; animated disclosure collapse/reopen retains long draft. Original text restored and no save/render/approval performed in visual checks.
- [x] Dialog filter/Enter navigation, Escape exit settles display:none and destination focus; compact modal356px wide/bottom678<844; checkbox checked/unchecked/disabled and matching Tools typography visually inspected; no console errors.
- [x] Current screenshots: `/Users/kartikbihani/WIN/design/growth-factory/interface-luminous-glass.jpg` and `quick-actions-luminous-glass.jpg`. Temporary browser viewport reset; existing native viewer/Vite processes retained without storage reset or restart. No desktop-through-vibrancy or packaged-app update claim.
- [x] Updated architecture/context and returned work order to In Review; delivery remains exclusively on the team feature branch.
