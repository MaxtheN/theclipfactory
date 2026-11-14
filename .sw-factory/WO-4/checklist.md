# WO-4 execution checklist

## Context

- [x] Read work order, connected requirements and blueprints, including referenced Precedent Research and Results blueprints.
- [x] Audit current team default branch, source/API schemas, actual types, reused components and tests.
- [x] Preserve active design checkout and live app; create isolated feature worktree from 700c907.
- [x] Record source-to-control map and independent media/workflow/runtime audit reports.
- [x] Phase 1 context certification.

## Plan and implementation

- [x] Write implementation plan and concrete test strategy before product edits.
- [x] Implement typed production contracts, adapters and pure readiness helpers.
- [x] Wait for design pass to finish; coordinate before visual integration.
- [x] Preserve final design and wire supported engine operations into UI.
- [x] Add meaningful contract/interaction tests and update integration documentation.
- [x] Phase 2 implementation certification.

## Review and verification

- [x] Establish backend baseline: 547 passed / 15 skipped and frontend baseline: 141 passed + TS/Vite build.
- [x] Verify changed UI/API behavior and malformed, stale, revision/export/error cases.
- [x] Run independent review and resolve blocking findings.
- [x] Verify browser/native behavior and distinguish actual media/model proof from fixtures/skips.
- [x] Final review log APPROVED.
- [x] Phase 3 verification certification.

## Handoff

- [x] Execution context/plan/review reflect final implementation and all criteria are complete or explicitly skipped with a reason.
- [x] Feature branch contains exact intended work; no main/master push or merge.
- [x] Update Software Factory work order to in_review after verified handoff.

## Explicit follow-up boundaries

- [SKIP] Public notarization/release installer and one-instance hardening: current delivery is a local development bundle and native review instance.
- [SKIP] External precedent research, automatic three-day evaluation, live publishing and paid activation: new backend/integration work, documented in finish-line and running-the-mac-app.
- [SKIP] Audience lift and matched human-effort benchmark: require actual publication/measurement and human review; no fabricated results.
- [SKIP] Six NumPy-dependent mocked-worker tests in base testvenv:585otherbackendtests passed; actual installed-runtime Whisper passed separately.
