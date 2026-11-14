# Independent Brand profile review

Verdict: one medium-priority usability issue to address; no save, scope, or readback regression found in the reviewed changes.

## Issue

**P2 — Explain a hidden section's validation when it blocks Save brand.** `Setup.tsx` derives the brand `valid` flag from the shared identity and kit draft. Entering an invalid logo path/font in Brand kit, closing it, then opening Brand, audience & voice leaves Save brand disabled. The relevant `kitError` appears only inside the closed kit dialog and its overview row behind the inert modal backdrop. Surface that error in the shared save action/status area (and ideally offer an action to open Brand kit). Preserve the shared draft and existing profile-wide save contract.

## Reviewed and preserved

- Setup keeps identity/kit field state in the same parent; PanelDialog keeps children mounted. Close, backdrop and Escape do not call save or discard drafts.
- Native `showModal()` provides modal focus containment/inert background; labelled headings, descriptions, close buttons and opener focus restoration are present. Backdrop clicks are distinguished from blank interior clicks.
- Profile membership checks, exact IDs, writable payloads, latest-record reads, save confirmation, unknown-outcome recovery and retry guards remain unchanged.
- Website proposal review, brand kit, model/account settings, creative notes, connected accounts, style rules, campaign creation and advanced tools remain accessible.
- GrowthApp's openGoals now opens the enclosing disclosure before scrolling. Goals and brand editors remain keyed by the existing profile/campaign context.
- AutoTextarea already observes width/reveal changes, so fields mounted inside initially closed dialogs can remeasure when revealed.
- CSS gives the dialog a bounded internally scrolling body, sticky actions, readable hierarchy and a reduced-motion fallback.

Verification: read-only source/diff review of Setup.tsx, brand-profile.css, PanelDialog.tsx, panel-dialog.css, GrowthApp openGoals integration, AutoTextarea reveal handling and focused test coverage. Relied on the agent's reported 20 focused tests and TypeScript check; did not start a concurrent test suite. Native browser focus trapping still requires the parent's CUA verification. No protected engine or production files inspected or changed.

## Addendum — latest revision reviewed against HEAD 643ef75

Re-reviewed the 2×2 Brand profile overview, focused Goals modal, wide Account & AI model modal, dirty-only Save brand controls/4-second confirmation, active-surface gating, goalsRequest navigation and bottom-nav Advanced tools. The original cross-editor validation issue is **resolved**: shared save controls now explain invalid kit/name drafts and link to their editor. No autosave was added; save/readback payload scoping remains explicit and native dialogs retain children/drafts.

Two P2 edge cases remain:

1. **Do not replay a stale Goals request after a brand/campaign remount.** GrowthApp retains a global positive `goalsRequest`, while each context-keyed Setup mount initializes `handledGoalsRequest` to 0. After opening Goals once, changing the brand/campaign (or creating a new brand) remounts Setup. Its next active Brand profile visit consumes the old request and opens Goals without a new request for that context. Scope the request to the profile/campaign or retain/initialize its consumed identity across remounts. Ordinary active/inactive toggling within one mount is already handled correctly.
2. **Preserve newer kit edits made while an earlier save is pending.** Fields remain editable during Save brand. `confirmBrandDraft()` correctly records the sent snapshot, so edits made after the request remain dirty. However, completion unconditionally clears `kitEdited`. The next visible Save brand can therefore omit the newer kit because `profileBody()` sends it only when `kitEdited` is true. Guard that reset against newer edits or derive kit inclusion/validation from the current kit versus its confirmed baseline. Repro: change font → Save brand with delayed write/readback → change font again before completion → save again; the second font should be sent and confirmed, rather than requiring another field edit to re-arm the flag.

Native modal Escape/backdrop/close remain non-saving; active=false closes the modal without unmounting drafts. Goals retains its campaign-owned save flow and CampaignBriefEditor, model/account settings remain available, and Advanced tools was moved rather than removed. Reported parent CUA checks confirm Goals quick-action opening and Save brand disappearing after confirmed readback at desktop sizes. This addendum is source-only; no test suite was started concurrently and no product files were edited by the reviewer.

## Owner resolution and verification
The two final P2 cases were fixed after the addendum: Goals requests are context-scoped/reset in GrowthApp; Setup derives kitDirty from the latest draft versus the exact confirmed snapshot for payload inclusion and validation. Focused regressions cover both, including delayed write/readback followed by newer invalid and valid kit edits. Final profile/dialog24 tests and workspace/website32 tests passed. Parent CUA also verified native modal dismissal/draft retention, scoped Goals navigation, and Save brand disappearing only after confirmed readback. This section records implementation-owner verification; the earlier independent findings remain above for traceability.
