<!--lint disable no-undefined-references strong-marker-->

# Work Order Execution Checklist: WO-5

**Work Order Number:** WO-5
**Work Order Title:** Turn onboarding into a guided animated launch
**Initialized At (UTC):** 2026-11-14T13:29:39Z

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
- [x] All acceptance criteria from the Work Order and linked requirements are satisfied
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

## Context evidence
Linked Campaign requirement/blueprint and transitive Production, Research and Results blueprints were read through Software Factory in this ongoing design execution. Existing Profile/Campaign identities, workspaceApi, AutoTextarea, Disclosure and shell contracts are reused. Open-canvas user correction supersedes the former inset/orbit presentation. Final verification passed; independent Round 2 review is APPROVED. The latest direct user instruction replaces the originally requested rocket with a forward arrow and open viewport layout.

## Final verification evidence

- Full frontend: `npm test` — 266/266 tests across 22 files, exit 0 (2026-11-14).
- `npm run build` — TypeScript and Vite succeeded; single file 588.05 kB, gzip 193.17 kB. Scoped `git diff --check` is clean.
- Browser at 1440×960: all four markers share y=103, with centers at 465, 635, 805 and 975. Description margin is 12px 60px 28px; choices start 28px below it. The outer wizard has no border and a transparent background. App chrome is hidden.
- Browser at 390×844: all markers share y=83; page and viewport widths both equal 390px. Exactly one h1 is visible; sidebar and topbar are hidden.
- Actual Continue click captured the 280ms arrow advance and step entry. Semantic progress values 1–4 follow the current stage. Drafts and keyboard focus are retained. Reduced-motion component coverage and static CSS were checked; the actual OS preference was not changed or emulated.
- Final fixture launch restored focused Factory with normal chrome and an empty campaign. No real backend, model, render, provider or publish action was invoked. Native viewer PID 1002 and fixture Vite PID 93298 remain running with live updates.
- Screenshots are under `/Users/kartikbihani/WIN/research/growth-factory/integration/`, named `onboarding-open-outcome.jpg`, `onboarding-open-voice.jpg`, `onboarding-open-review.jpg`, `onboarding-open-compact.jpg` and `onboarding-open-after-launch.jpg`. Temporary browser viewport was reset.
- Independent review: Round 2 APPROVED; no blockers or advisories. Work order status is In Review.
- No commits, pushes, merges or default branch changes by this design chat. Backend and AutomationPanel edits were preserved. No other chat was contacted; integration delivery remains owned by its existing chat.

## White brand and direct-entry follow-up

- [x] Latest white logo instruction supersedes the previous black presentation; original PNG is unchanged. Shared BrandMark frames its visible art without changing the source image. Desktop onboarding mark/wordmark heights are 43px/43.19px; main sidebar 40px/40.78px.
- [x] Explicit fixture-only #onboarding entry opens Audience with no application chrome and preserves saved records. Integration tests cover Cancel, final Launch, retained data and ordinary-build hash isolation.
- [x] Native window “Growth Factory — Onboarding” launched directly with --onboarding (PID 1799); Vite live updates remain active. Existing preview and authenticated engine were not restarted or closed. Native loaded callback succeeded; browser screenshots verify the matching entry. This is not a claimed native visual smoke test.
- [x] Inside-app polish restores empty-state spacing, removes one duplicate divider, and adds finite view/navigation/row motion with reduced-motion overrides.
- [x] Full frontend suite 269/269 across 22 files; focused 43/43; TypeScript and global diff checks pass. Preview helper compiles. Final build evidence and independent Round 3 review are in review-log.md.
- [x] Browser checked onboarding, Factory, Library, Tools and Quick Actions. Compact page width equals 390px viewport, and brand remains readable. Temporary viewport reset; native left on its first step for the user.

## Fixed viewport and launch follow-up

- [x] Root/document/window stay fixed to the viewport. Daily app and Tools retain pinned navigation/header/footer while long content scrolls internally. Onboarding pins brand/progress/actions around its focusable question region.
- [x] Four-step overview is retained with clearer audience-purpose copy, following NN/g guidance on form cognitive load: https://www.nngroup.com/articles/4-principles-reduce-cognitive-load/ . GOV.UK question-page guidance informed the focused question, Back/Continue and optional-detail structure: https://design-system.service.gov.uk/patterns/question-pages/ . These are design choices, not a measured conversion claim.
- [x] Selected Outcome/Voice options use muted blue, amber and sage accents, visible checkmarks and native radio semantics; color is an additional cue. Forced-color and reduced-motion behavior remain supported.
- [x] LaunchTransition follows actual confirmed profile, campaign and reload phases. Ready is gated by successful reload, lock is held through the finite 650ms arrow/check cue, and a 720ms fallback prevents a stuck handoff. Reduced motion completes directly after the real requests. Errors return to focused review recovery without losing drafts or saved IDs.
- [x] Natural first-run coverage proves a newly usable campaign does not dismiss the ready screen before the final handoff. No early writes, duplicate saves or automatic model/render/publish actions are introduced.
- [x] Tests: full frontend suite 272/272 before the final first-run regression; final affected suite 47/47 (including that additional regression), TypeScript and scoped whitespace checks pass. Reviewer independently reran all 26 wizard tests successfully. An earlier loaded-host timeout was non-reproducible on exact-case and full-file reruns.
- [x] Final production build passes: 601.49 kB single file, gzip 195.59 kB.
- [x] Browser: document/body height equals viewport at 1440×900, 900×640 and 390×640; window scroll stays zero. Custom metric and expanded boundaries remain reachable through internal scrolling; actions stay pinned at bottom624 in 640px windows. Keyboard PageDown moves only the question region. Tools inner main scrolled834px while its topbar and footer remained at61/640px.
- [x] Captured actual fast-fixture ready cue with 650ms gf-launch-arrive starting at left0, then focused Factory restoration. Screenshots under research/growth-factory/integration are fixed-onboarding-audience.jpg, fixed-onboarding-outcome.jpg, fixed-onboarding-short.jpg, fixed-onboarding-expanded-compact.jpg, fixed-onboarding-review.jpg, fixed-onboarding-launch.jpg, fixed-after-launch-factory.jpg and fixed-tools-short.jpg. Browser viewport was reset.
- [x] Native design preview reopened directly at Audience via --onboarding, PID3478; fixture Vite5179 remains active. Existing authenticated engine was not operated by this chat. Native loaded callback succeeded; saved screenshots are browser verification, not a claimed independent native smoke test. No other chat was contacted, no commit/push/merge performed.

## Slower launch continuation

- [x] Confirmed-ready sweep/check now lasts 1500ms, followed by a 280ms launch fade and 420ms whole-window Factory arrival. JS and CSS share timing constants. Requests are not delayed; reduced motion completes immediately after actual reload.
- [x] Submission lock holds through both sweep and fade. Named arrival starts exit; only departure or the cleaned finite two-stage fallback completes. Unmount/readiness-loss cleanup and duplicate protection are covered.
- [x] Full frontend suite: 274/274 across 22 files. Focused tests: 48/48. TypeScript and scoped whitespace checks pass. Reviewer independently ran 32 wizard/shell tests.
- [x] Actual fixture browser sequence captured 1.5s gf-launch-arrive, then 0.28s gf-launch-depart with onboarding still active, then 0.42s gf-factory-arrival and focused Factory. Page height stayed 900px at a 900px viewport. Screenshots: launch-slower-sweep.jpg, launch-slower-exit.jpg and launch-slower-factory.jpg under research/growth-factory/integration. No actual backend/provider/render/publish actions were invoked.
- [x] Final TypeScript/Vite production build passed: 604.45 kB single file, gzip 196.43 kB.
- [x] Native fixture preview PID 3478 and Vite5179 remain active with live updates. Test browser returned to Audience and viewport was reset. Existing native user session was not restarted or cleared.
