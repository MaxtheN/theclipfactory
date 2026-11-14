# Guided onboarding independent review

Current verdict: **APPROVED — SLOWER LAUNCH AND SMOOTH FACTORY HANDOFF**. Round 5 covers the latest timings and coordinated exit/entry. Round 4 remains evidence for the fixed window/internal scrolling and confirmed-save behavior. Earlier rounds remain historical evidence; the inset glass window, vertical step rail and orbital rocket remain superseded.

Prior verdict: **APPROVED**. No remaining blocking findings in the previously reviewed onboarding change.

Work order: WO-5, “Turn onboarding into a guided animated launch” (`11297e92-bd2c-4dcb-b662-ebd0d1ea9099`). Review baseline: `fb1e656` in the isolated growth-factory-integration worktree. The latest standalone onboarding direction supersedes the earlier embedded wizard screenshots.

## Scope and findings

Reviewed the four-step state and request flow in `frontend/src/growth/Onboarding.tsx`, the standalone shell integration in `frontend/src/growth/GrowthApp.tsx`, dedicated onboarding rules in `frontend/src/growth/factory-flow.css`, and relevant onboarding, Factory and workspace regressions. No product files were changed by this reviewer.

The draft is retained between steps and only the active pane is exposed. Step navigation, progress links and final launch validate the appropriate inputs, including earlier fields changed from review. Outcome/metric mappings, Discovery/null, creative preference and optional boundaries reach the existing validated request builder. Final launch is the first write. Confirmed IDs, known-validation correction, ambiguous-write reconciliation and refresh-only recovery remain explicit; no duplicate-create path was found in the reviewed flow.

The standalone shell hides app navigation, outer headings, app notices and Command-K while onboarding, without unmounting existing advanced-stage drafts. The current onboarding h1 receives focus on activation and step changes. A review finding concerning logically open QuickActions/tools after hiding the shell was resolved by closing their state on entry to onboarding. Regression coverage now includes this entry/exit behavior and unsaved Setup draft retention. A stale workspace test expecting inaccessible onboarding navigation was corrected to assert absence.

Glass surfaces, cream selection marks, warm focus treatment and typography are coherent across the reviewed panes. CTA labels remain stable. Hover/focus orbit and actual-click flight are finite, decorative and impose no write delay. Busy launch permits its one-shot cue; ordinary disabled/error states reset it. Reduced motion suppresses decorative motion. The native black logo is preserved.

## Verification evidence

- Reviewer independently ran the focused onboarding/Factory command: 25/25 tests passed. Reviewer independently ran a successful TypeScript/Vite production build and scoped whitespace checks.
- The tests delegate subsequently reported the final full frontend suite: **261/261 tests across 21 files passed**, followed by TypeScript and whitespace checks. This includes standalone-shell preview-transport tests, activation focus, reduced-motion continuation, progress validation, retained drafts and recovery paths.
- Reviewer independently inspected saved desktop voice/review, 390px compact review, and post-launch Factory images under `/Users/kartikbihani/WIN/research/growth-factory/integration/`: `onboarding-standalone-voice.jpg`, `onboarding-standalone-review.jpg`, `onboarding-standalone-compact.jpg`, and `onboarding-after-launch-factory.jpg`. They show readable hierarchy, consistent surfaces, explicit review/edit/launch controls, no onboarding app chrome, and restored normal Factory chrome afterward. Compact content scrolls vertically without a visible horizontal layout problem.
- Parent browser evidence reports 390px page width at a 390px viewport, one visible h1, hidden sidebar/topbar, no Command-K modal, retained edited audience and direct return to summary. Explicit fixture launch created one Profile/Campaign and restored focused Factory/navigation/search/campaign selection with zero footage; no model, render or publish action was invoked. Viewport was restored and the native viewer kept open.

The only reported console errors were an earlier unrelated AutomationPanel HMR state-shape incident. A fresh isolated-tab reload and final fixture flow produced no additional errors. This review does not claim real-backend production execution or a native-app smoke test; browser verification used the explicit preview fixture transport. Parent owns final work-order evidence/status, root build and delivery.


## Round 2 — open viewport revision

**Verdict: APPROVED.** The earlier inset-window approval is superseded; this verdict applies to the user-directed open viewport revision. No blocking or advisory findings remain in this round.

### Direction and source review

Reviewed updated Onboarding.tsx markup and dedicated factory-flow.css rules. The enclosing card, intro column, vertical connectors, rocket and orbital trail are removed. The natural black brand sits at the top left. Four equal-column horizontal progress markers share one continuous track, and the centered form has a narrow readable measure. Current/completed/future states remain distinguishable; selected radios use a warm border/fill consistently, including Other, and unselected hover cannot override selected treatment. Root corrected global paragraph-reset specificity so descriptions and following controls retain intentional spacing. Scope remains frontend onboarding; the previously reviewed shell hiding, active h1 focus, draft retention, validation, no-early-write and receipt recovery logic are preserved.

The track is a semantic progressbar separate from the interactive step list, with current step text and values 1–4. Progress buttons retain native keyboard behavior and aria-current. Simple ArrowRight decoration replaces the rocket. Its 280ms click cue is finite, does not delay writes, resets for errors/ordinary disabled states, and becomes static under reduced motion. No hidden extra step pane or new app chrome was introduced.

### Verification

Reviewer independently reran `npm test -- --reporter=dot src/growth/onboardingWizard.test.tsx src/growth/factoryFlow.test.tsx`: **28/28 passed**. Reviewer independently ran `npm run build`: TypeScript and Vite passed (587.97kB single-file output, gzip 193.16kB). Tests delegate reported four focused files 40/40 plus TypeScript; parent reported the final full frontend suite **266/266 across 22 files passed**. The final screenshot-spacing adjustments are CSS-only.

Reviewer independently viewed `/Users/kartikbihani/WIN/research/growth-factory/integration/onboarding-open-outcome.jpg`, `onboarding-open-voice.jpg`, `onboarding-open-review.jpg`, and `onboarding-open-compact.jpg`. Desktop and 390px full-page screenshots match the revised direction: open background, aligned horizontal progress, calm centered headings, readable selections, clearly separated descriptions, review/edit controls and simple arrow CTA. Compact review has normal vertical flow and a full-width CTA without an enclosing inset window or horizontal overflow visible.

Parent actual-browser measurements report all desktop marker tops 103px with centers 465/635/805/975, compact marker tops 83px, viewport/page width 390px, one visible h1 and hidden app sidebar/topbar. Parent captured the actual Continue cue as `gf-onboarding-advance` with 0.28s duration and the intentional step enter transition. Browser geometry supports the visual alignment assessment. Earlier fixture-transport post-launch restoration remains applicable; this revision changes layout/decoration, not request or shell completion behavior. This review does not claim production backend/model/render/publish execution or a native-app smoke test.

### Data safety and ownership

No product edits, commits, pushes or cross-chat messages by this reviewer. Final request remains the first write; existing confirmed-ID, validation and ambiguous-write recovery protections remain in the reviewed source and passing regression coverage. Parent owns final work-order status, final root verification and delivery.


Final round follow-up: reviewer also independently viewed `onboarding-open-after-launch.jpg`. The restored Factory shows normal navigation/search/profile/campaign controls and zero footage. Parent reports the final revised fixture launch was clicked once, the Factory h1 received focus, viewport was restored, and the native preview remained open with HMR. No production backend/provider/render/publish action was used.


## Round 3 — white brand, direct Mac onboarding preview and workspace polish

**Verdict: APPROVED.** Zero blocking findings or unresolved advisories. This round follows the latest user request for a white, visibly larger logo; earlier preservation of black display color is superseded by that explicit direction. The original PNG artwork remains unchanged.

### Source and behavior review

Reviewed the shared `frontend/src/growth/BrandMark.tsx` and `brand-mark.css`, use in `Onboarding.tsx`, `GrowthApp.tsx` and the advanced-tools `frontend/src/App.tsx`, the preview entry change in GrowthApp, `scripts/preview-interface.py`, and daily-app refinements in `factory-flow.css` and `workspace-motion.css`.

BrandMark frames the supplied PNG inside a decorative, non-focusable SVG using its visible artwork bounds. The white appearance is applied with a CSS filter. No duplicate accessible image label is introduced beside the existing brand text. The corrected main-app selector ensures the wordmark retains its intended size. Desktop and compact mark dimensions track the adjacent two-line company name without overlap.

The direct preview entry is a lazy initial-state condition requiring both the explicit `reviewPreview` build flag and exact `#onboarding` fragment. It adds no hash listener or reentry effect, no automatic POST, no storage clearing, and no campaign/profile reset. Cancel and completion clear the existing creating state and cannot loop back into onboarding simply because the fragment remains. The normal build ignores the fragment. The Mac helper retains its existing local HTTP URL validation and appends the fragment only through the explicit `--onboarding` option; default helper behavior remains unchanged.

Daily-workspace changes are scoped visual refinements. Stage entrance and active marker animations are finite; polling does not change stage visibility or remount draft state. Hover/focus icon movement is small and does not alter command timing. Reduced-motion rules suppress the added stage/marker animation, transforms and transitions. Existing native dialog/details behavior and keyboard semantics remain intact.

### Tests and visual evidence

Reviewer independently ran `npm test -- --reporter=dot src/growth/onboardingShell.test.tsx src/growth/workspace.test.tsx`: **15/15 passed**, including preview-hash entry/exit and ordinary-build hash isolation. Reviewer scoped whitespace checks passed. Tests delegate reported focused tests **43/43**, full frontend suite **269/269 across 22 files**, and TypeScript passed. Parent reports helper Python compilation and final whitespace checks passed; final root build remains parent-owned.

Reviewer independently viewed `white-brand-onboarding.jpg`, `white-brand-onboarding-compact.jpg`, `white-brand-factory.jpg`, `white-brand-library.jpg`, `white-brand-tools.jpg`, and `white-brand-quick-actions.jpg` under `/Users/kartikbihani/WIN/research/growth-factory/integration/`. All show consistent white artwork and readable glass controls; the main sidebar toggle remains separate from the brand, tools branding fits, and compact onboarding has no horizontal overflow visible. Parent browser measurements report onboarding mark 43px versus wordmark 43.1875px, main mark 40px versus wordmark 40.78125px, compact mark 61×34px versus wordmark 60.97×36.72px, and compact page/viewport width 390px. Parent captured the actual daily stage entrance as the finite 220ms `gf-workspace-enter` animation.

Parent reports the new native viewer opened directly at first-step onboarding through the explicit helper option, with Vite HMR active, while preserving the older design viewer and actual engine. This reviewer inspected saved browser evidence and source rather than independently operating the native Mac window. No production backend/provider/render/publish action was used for this review. Parent owns final build/status and delivery. Reviewer changed only review notes; no commits, pushes or other-chat contact.


Round 3 final verification follow-up: parent reports final root TypeScript/Vite build passed (590.47kB single-file output, gzip193.37kB). No further product changes were planned at that round. That round's approval applied to the then-current implementation.


## Round 4 — fixed window, thematic choices and confirmed-save launch

**Verdict: APPROVED.** No remaining blocking findings or unresolved advisories in this round.

### Reviewed scope and resolved findings

Reviewed `frontend/src/growth/Onboarding.tsx`, new `LaunchTransition.tsx`, `GrowthApp.tsx`, new `desktop-shell.css`, dedicated selection/launch rules in `factory-flow.css`, and relevant wizard/shell regressions. The window/root/body are bounded to the viewport. Daily app and advanced-tools content have bounded internal scrollers with a complete `min-height: 0` chain. Onboarding pins its brand, quiet progress overview and actions around a scrollable question region. Long custom inputs, disclosures, review text and error/reconciliation controls remain inside that region. The region is keyboard focusable and named; the daily main is focusable through the skip link. Current/completed step semantics, focus indication and native radio behavior remain intact.

Outcome/voice selections use coherent blue, amber and sage accents with borders, inset marks and checked controls, so color is not the only selected indicator. Other retains the same selected treatment. Checked styling remains usable with keyboard focus, while native forced-color behavior is preserved.

Launch phase text and pointer positions follow confirmed Profile, Campaign and refresh receipts. Decorative track positions are not exposed as a measured percentage. No ready state appears before successful reload. The submit ref lock and parent busy gate hold through the final visual handoff, including natural first-run onboarding after the campaign becomes usable. The final cue is a finite 650ms animation with a 720ms fallback; reduced motion completes immediately after the real saves/reload. Animation completion and fallback share a once-only guard. Callback updates are retained through a ref, timers are cleaned on unmount, and failures return to intact review/error recovery with confirmed IDs preserved. No network call waits for decorative motion.

Review findings resolved before approval: launch content now uses safe centering so long names/short windows cannot place its start outside the scrollable origin; `aria-busy` was moved off the launch status scope so truthful phase updates are announced; the inner question region/main are focusable for keyboard scrolling. Existing validation, 400/422 correction, ambiguous-write reconciliation and refresh-only retry protections are preserved.

### Verification

Reviewer independently ran a clean full `onboardingWizard.test.tsx` rerun: **26/26 passed** in 7s. A prior paired run hit one reconciliation test timeout during an unusually 136s host run; the exact case then passed independently, and the complete wizard file subsequently passed. The tests delegate additionally removed the irrelevant decorative timing dependence from general recovery tests while retaining explicit motion/fallback tests. Delegate final focused result: **47/47 across 4 files**, plus TypeScript and whitespace checks. The final natural-first-run regression verifies the saved campaign may become usable while ready remains visible for 719ms, named animation completion restores Factory once, and no duplicate records appear after 2s. Parent previously reported the full frontend suite 272/272 before that additional regression; final root suite/build remain parent-owned. Reviewer scoped whitespace checks passed.

Reviewer independently viewed `fixed-onboarding-outcome.jpg`, `fixed-onboarding-review.jpg`, `fixed-onboarding-short.jpg`, `fixed-onboarding-expanded-compact.jpg`, `fixed-onboarding-launch.jpg`, `fixed-after-launch-factory.jpg`, and `fixed-tools-short.jpg` under `/Users/kartikbihani/WIN/research/growth-factory/integration/`. These show the strengthened selected state, readable review, pinned short-window actions, internally scrolled expanded compact fields, clean launch state and restored Factory. Advanced tools retain navigation/return/header/footer while its long content scrolls internally.

Parent browser measurements report 1440×900 window/body/root heights 900px, 900×640 page/body heights 640px, and blank-space wheel input leaving windowY 0. Focusing custom metric scrolled only the inner region to 279px with footerTop 576px. At 390×640, expanded boundaries remained reachable with innerTop 278px, footerBottom 624px and page/viewport width 390px. Keyboard PageDown on Setup questions moved inner scroll 0→65px while body stayed 0. Tools main scrolled 834px while topbar/footer remained fixed and rootY stayed 0. The actual fixture launch showed the 650ms named arrival animation and then focused Factory with normal chrome. These measurements support the fixed-window and keyboard-reachability conclusions; this reviewer independently inspected screenshots/source rather than operating that browser session.

No production backend/provider/render/publish action was added or exercised for this review. Browser launch evidence uses the explicit preview fixture transport. Only review notes were changed by this reviewer; no commits, pushes or other-chat contact. Parent owns final root verification, work-order status and delivery.


## Round 5 — slower launch and smooth Factory handoff

**Verdict: APPROVED.** No blocking findings or unresolved advisories. This round supersedes the shorter launch timings in Round 4 while retaining its validated save, recovery and fixed-window behavior.

Reviewed `LaunchTransition.tsx`, its ready/exit rules in `factory-flow.css`, the complete-window arrival rules in `workspace-motion.css`, and updated wizard/shell tests. Shared JavaScript constants feed the CSS timing variables: 1,500ms sweep/check hold followed by a 280ms exit fade. The arrow travels across the full track, the check appears and holds, then the interstitial fades before the normal shell arrives over 420ms. The entrance selector becomes applicable after onboarding exits and does not change from polling alone. It fades the existing window without remounting campaign stages or changing drafts.

The ready state still requires confirmed Profile/Campaign receipts and successful refresh. Network calls are unchanged and are not delayed by the visual sequence. The submission lock remains held until the final exit completes. Arrival starts the exit stage; departure invokes completion. Bounded fallbacks are 1,580ms for arrival then 360ms for departure when animation events are absent. A shared once-only completion guard prevents duplicate callbacks, latest callbacks use a ref, and both timers clean up on unmount/readiness loss. Reduced-motion users bypass the visual wait after actual save/reload success and receive static arrival styling. Validation, ambiguous writes, refresh failure and correction still restore or retain the established recovery flow.

Reviewer independently ran `npm test -- --reporter=dot src/growth/onboardingWizard.test.tsx src/growth/onboardingShell.test.tsx`: **32/32 passed**. Scoped whitespace checks passed. Tests delegate reported full frontend suite **274/274 across 22 files**, focused **48/48**, and TypeScript/whitespace checks passed. Dedicated tests cover both fallback boundaries, locks during both stages, exactly-once completion, cancellation while exiting, reduced motion, errors, and natural first-run Factory restoration. Final root build remains parent-owned.

Reviewer independently viewed `/Users/kartikbihani/WIN/research/growth-factory/integration/launch-slower-sweep.jpg`, `launch-slower-exit.jpg`, and `launch-slower-factory.jpg`. These show a readable clean sweep, completed check, and coordinated shell fade on the same background. The Factory frame is intentionally captured during its arrival animation. Parent actual-browser evidence reports computed 1.5s `gf-launch-arrive`, then 0.28s `gf-launch-depart` while the app remained in onboarding, then focused Factory with 0.42s `gf-factory-arrival`. Page and viewport height remain 900px. These source, timing, test and frame checks support the slower handoff without claiming a video review or native animation capture.

No backend/provider/render/publish action was added or exercised for this review; browser execution used the explicit preview fixture. This reviewer changed only review notes, with no commits, pushes or other-chat contact. Parent owns final build/status and delivery.



Round 4 parent verification follow-up: final TypeScript/Vite production build passed (601.49 kB, gzip195.59 kB); scoped whitespace checks are clean. Native fixture preview reopened directly at Audience with HMR active (PID3478, Vite5179). No subsequent product changes were made.

Round 5 parent final check: TypeScript/Vite build passed (604.45 kB; gzip 196.43 kB), scoped whitespace checks clean, and native preview PID3478 remains active with live updates. No subsequent product changes.
