<!--lint disable strong-marker-->

# Review Log: WO-9

**Work Order:** WO-9 — Unify channel settings and retain production controls
**Initialized At (UTC):** 2026-11-14T14:38:07Z

This file records review and verification rounds. Append new rounds; do not overwrite prior rounds.

---

## Round 1

Implementer self-check (2026-11-14), not an independent review.

### Requirements Alignment

**Blocking:**

- None found by the implementer. Independent review not yet performed.

**Advisory:**

- Basic form: Channel name, Who are we speaking to?, What are we working toward? (existing `objectives` enum with readable labels), Primary metric (disabled/null for discovery, required otherwise), Voice and boundaries, Creative preferences. One goal control; the old "Campaign brief intent" select, the separate "Production goal" editor/"Save profile goal" button and "Save & find direction" are removed. `measurement_intent` is now derived from the single objective+metric ("Discovery" or "<label>: <metric>"), matching onboarding's convention.
- Channel name maps to the campaign name only; the selected profile's `name` is preserved (not renamed). Audience is written to both the campaign brief and the selected profile; voice to `brand_context` + brief `constraints` (one per line); `requested_outputs` is preserved from the latest campaign.

### Blueprint Alignment

**Blocking:**

- None found by the implementer.

**Advisory:**

- Strict save in `Setup.tsx`: read latest campaigns+profiles; reject if the campaign is gone or the selected profile is not linked to it (no fallback); build writable profile body via `profileGoalBody` (no `production_history`); PUT that profile by ID; PUT campaign with `profile_ids`/`video_ids` unioned with the latest saved record; read back and compare; success only after the readback matches and `w.run` refresh succeeds.
- Failure classification: read/validation failure or definite 4xx on the profile PUT -> "nothing saved", drafts kept, retry allowed. Definite 4xx on the campaign PUT -> "Partially saved". Status 0, 5xx, unreadable 2xx body, or readback mismatch -> unknown. Partial/unknown disable Save until "Check saved state" reads back and reports which parts are saved.
- Saving never calls create-profile, propose/approve strategy, render, learn or upload. "Create profile" remains an explicit Advanced action (queues the new profile for linking on the next save).
- Advanced disclosures: existing-footage attachment (no upload box; Factory remains the upload path), linked-profile linking + creation, an explanation of versioned editing rules and Advanced tools. The "Editing rules" button sits beside the save action and is the only caller of `next()`.
- `GrowthApp.tsx`: Setup is now keyed by `contextKey` (campaign + profile) so switching profiles in the top-bar switcher re-initialises drafts from that profile instead of saving one profile's draft into another. Profile switcher already hidden for single-profile channels (design-owned change, kept).

### Architecture And Conventions

**Blocking:**

- None found by the implementer.

**Advisory:**

- `navigation.css` gained a single-column `.gf-channel-settings-grid` and `.gf-channel-actions` layout; not visually verified.
- The existing workspace test for single-profile scope tried to narrow a campaign's membership by PUT, which the preview service (and backend) reject; it now creates a separate single-profile campaign instead.

### Tests And Build

**Commands run (from `frontend/`, one file at a time):**

- `npx vitest run src/growth/channelSettings.test.tsx` — 10 passed
- `npx vitest run src/growth/workspace.test.tsx` — 13 passed (after one fix to the single-profile test fixture; the first run had 1 failure from that fixture)
- `npx vitest run src/growth/onboardingShell.test.tsx` — 5 passed
- `npx vitest run src/growth/resultsLearning.test.tsx` — 5 passed
- `npm run build` — tsc + vite build succeeded; `npx tsc --noEmit` re-run after a final small edit — passed
- Full vitest suite not run (machine memory constraint); other test files do not render `GrowthApp` or `Setup`.

**Blocking:**

- None.

**Advisory:**

- Coverage: one goal control; strict selected-profile payload; other profile unchanged; latest source membership preserved; definite failure keeps draft and allows retry; partial save requires readback; lost response treated as unknown and blocks repeat until readback; no create/strategy/render/learn/upload on save; Editing rules only via explicit button; single-profile switcher hidden / multi preserved (workspace.test); onboarding isolated (workspace.test); `#connections` opens Results (channelSettings.test).

### User-Facing Verification

**Skipped:** yes - no browser or desktop exploratory pass was run in this round.

**Evidence:** jsdom tests only.

**Blocking:**

- Exploratory pass still required before approval.

**Advisory:**

### Security, Privacy, And Data Safety

**Skipped:** no

**Blocking:**

- None found.

**Advisory:**

- No new endpoints, no external calls; writes are absolute PUTs by exact ID with append-only membership.

### Round 1 Verdict

- Total blocking: 1 (exploratory pass and independent review outstanding)
- Total advisory: see above
- Files reviewed: frontend/src/growth/Setup.tsx, GrowthApp.tsx, navigation.css, channelSettings.test.tsx, workspace.test.tsx, resultsLearning.test.tsx, onboardingShell.test.tsx
- **Verdict:** CHANGES_REQUESTED

---

<!-- Subsequent rounds: copy the structure above and increment the round number. -->
