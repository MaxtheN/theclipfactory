# Independent production/review UI review

Reviewed Studio.tsx, PostToInstagram.tsx, PostPreview.tsx, review-panel.css and post-preview.css presentation changes against HEAD 643ef75. Read-only product review; no tests or product edits performed. The implementing agent reports 38 focused Studio/posting tests passing.

## Findings sent to root and review_library

**P2 — A held clip's required reason is outside the posting modal.** Compact posting keeps the quality gate inline, including the required override reason, while moving the posting form/submit into a native modal. Opening Prepare your post without first entering a reason leaves submit disabled and the required field behind the modal's inert backdrop. Preserve the inline gate but surface the controlled reason and hold explanation inside the compact composer, or provide an explicit close-and-review path. Keep the existing held-clip reason length and approval guards.

**P2 — Gate Studio's native dialogs to the active app surface.** GrowthApp keeps Studio mounted under a hidden stage. The new Production log, Checks & version details and compact posting dialogs do not receive an active-surface signal. Command-K can open its own native modal above them; navigating elsewhere can leave Studio's original modal open over the destination or hidden while retaining modal state. Apply the same active-surface gating already used by Setup/Results, close/gate modal presentation when Studio becomes inactive, and retain underlying draft/async state. Coordinate the new prop with GrowthApp; Studio already uses `active` locally for approved rules.

## Preserved behavior observed in the diff

- Quality verdict, rubric, reasons and hold gate remain inline rather than being silently removed.
- Approval still records and checks the exact revision; posting still requires an actual file hash and passes it to post/schedule APIs. Preview mode remains disabled for real publishing.
- Targets, per-account captions, copy regeneration, cover selection, feed sharing, timezone, schedule constraints and overdue decisions remain present.
- Unknown/inactive-container attempts remain blocked from blind retry. The compact launcher surfaces recovery status, overdue schedules, schedule timing constraints, errors and notices; exact Check status/Continue controls remain in the composer.
- The composer stays mounted when its modal closes, retaining chosen accounts, captions, overrides, cover and timing. Only the visual PostPreview unmounts on close, avoiding hidden preview playback. Closing the modal does not submit or cancel a post.
- Studio retains all job messages, real progress, cancellation confirmation, saved-render retry guards, agent tasks/output, technical evidence, recheck action, export history refresh, uncertainty warning and MP4/manifest links. Log entries are grouped into disclosures rather than deleted.
- The decorative Reels rail has no click handlers or invented engagement counts; actual account/caption preview remains intact.
- Native dialogs provide labelled headings, bounded content, Escape/backdrop dismissal and opener focus restoration; reduced-motion handling remains present.

No backend/engine behavior was changed or evaluated by this review. Existing async request guards and publication lifecycle code were not broadened by the presentation diff. Parent CUA verification is still necessary for modal navigation, held-clip correction and compact geometry.

## Fix verification addendum

Both P2 findings are resolved in the reread source. Studio receives `activeSurface` from GrowthApp's route/tools/onboarding expression, closes log/details state when inactive, gates both native dialogs, and passes the flag to PostToInstagram. Posting gates/closes only its editor presentation while retaining the underlying composer draft. The held verdict and controlled required override reason now appear inside the compact composer before submit; non-compact posting retains its original inline reason. Existing ready/approval/hash/recovery guards are unchanged. Implementing agent reports 40/40 focused posting and Studio tests passing. Independent final verdict: no remaining actionable findings in this reviewed presentation diff; root retains native visual QA responsibility.
