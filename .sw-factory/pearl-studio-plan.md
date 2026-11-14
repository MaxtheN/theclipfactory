# Pearl Studio — approved visual direction

User explicitly approved Pearl Studio on 2026-11-14 after comparing three concrete designs. Baseline: 4886390. Scope is the current desktop app: warm paper foundation, graphite text, restrained bronze, native system font, smaller typography hierarchy, selective translucent chrome, focused profile rail/detail layout. Keep one navigation and existing operational/approval/readback semantics. Do not touch concurrent landing-page work, Supabase scratch or backend/engine code. No real model/render/publish/account actions during QA.

Root owns shared material tokens and the last-loaded pearl-studio.css, command/dialog/forms/onboarding/brand mark contrast. Profile agent owns approved rail/summary layout in Setup, persistent dialogs and interaction tests. Factory agent owns map/Results/Insights/upgrades light surfaces and self-contained portalled picker. Review agent owns review/Library/post surfaces, preserving dark actual-media/phone areas. Work is disjoint; targeted tests one or two files per command sequentially. Verify populated fixture desktop/compact states, Command-K, profile editors, Engine/modal, source actions, review/post/quality states, Results and onboarding. Keep reduced motion/transparency and keyboard focus support.

After implementation: independent source/color review, exact token contrast calculation, affected behavior tests, tsc/Vite build, diff check, CUA screenshots and feature-branch commit/push. The live review server on port 5179 stays updated. Open a native window on the latest build without overwriting active user state.

## Verification completed

- Profile + Engine interaction tests: 33 passed. Workspace + onboarding tests: 25 passed. Rail selection previews a section without writing or opening a modal; editing remains explicit.
- `npm run build` passed after final CSS edits (TypeScript and Vite).
- Independent source review caught and corrected single-line input focus styling, selected-profile text contrast, Command-K label opacity and the current-brand chevron. Rendered review caught profile link/Advanced spacing and nested editor borders; those cascade conflicts are corrected.
- CUA checked the rendered 1280 × 720 shell, profile overview/editor/dirty save, Command-K, Engine sheet, Factory map, Library, clip review, posting phone/sheet, Results and all four onboarding question screens. No production, posting, account or model actions were triggered. Browser viewport override was reset; the attempted minimum-window override did not change the reported viewport, so smaller sizes are not certified by this pass.
- Measured static pairs: secondary text on canvas 4.86:1; bronze on paper 4.82:1; ivory primary-button text on bronze 4.91:1. Selected profile text uses graphite. Real media/phone surfaces keep their dark presentation and white overlay text.
- Local evidence: `/Users/kartikbihani/WIN/research/growth-factory/integration/pearl-studio-profile.png` and `pearl-studio-command.png` in the same directory.
- Opened `Growth Factory — Pearl Studio` with `scripts/preview-interface.py --url http://127.0.0.1:5179/ --onboarding`. Native loaded event confirmed; Vite live updates remain active. This is the explicit sample-data UI preview, not a production account or rendered-clip quality test. Existing real-app windows/data were preserved.
