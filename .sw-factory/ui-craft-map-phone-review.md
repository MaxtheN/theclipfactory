# Independent review: Factory map, run picker and phone preview

Reviewed the working diff against HEAD (`8c13958`) on 2026-11-14. Scope: `FactoryMap.tsx`, `factory-map.css`, `factoryMap.test.tsx`, `ClipPreview.tsx`, `PostPreview.tsx`, and `post-preview.css`. Read surrounding QuickLook sizing CSS and existing phone-preview assertions to assess integration. No protected backend, Studio or CraftControls files were inspected or changed. No tests or browser sessions were started during this independent pass; root owns visual verification and coordinated test runs.

## Verdict

**No blocking regression found in this source review.** Native Mac rendering remains a visual verification gate, rather than something established by source inspection.

- **Run picker clipping:** the listbox is portalled to `document.body`, uses fixed viewport coordinates, computes available space above/below, constrains width and internal height, and repositions on captured scroll and resize. The portal receives its own theme-variable declarations, so it does not depend on `.gf-app` ancestry. Long IDs wrap. The new test proves a low/right trigger opens upward outside the overflow-clipped container.
- **Keyboard and focus:** the run picker retains Arrow/Home/End navigation, Enter/Space selection, Escape dismissal and opener restoration. Portal-aware outside-click detection includes the menu. Unique `useId` option IDs avoid collisions between ledger instances. Tab restores the trigger before allowing native traversal to continue. Factory view tabs now have roving tab stops and Arrow/Home/End activation, with a draft-retention test proving episode children remain mounted.
- **Operational accuracy:** map derivation and run/status source logic are unchanged. Muted family colors were replaced by sequence numbers; real working/completed/held states retain explicit labels and distinct state colors. There is no new synthetic progress or success claim. New panel/segment/menu motion has reduced-motion overrides.
- **Phone and QuickLook:** the five decorative Reels glyphs are shared, `aria-hidden`, and `pointer-events: none`; they add no dead keyboard controls or simulated engagement counts. Existing posting/media callbacks and caption/account content are unchanged. QuickLook keeps its original viewport-derived width constraint, so the added 9:16 wrapper preserves the prior media height budget. Its rail sits above native playback controls. The existing tests now assert the five decorative glyphs in both previews.

## Visual checks for root

Confirm the portalled run menu at the bottom of the Mac window; confirm native video controls are clear of the QuickLook rail; confirm the small 216px post phone has legible account/caption text and all five rail glyphs. These are geometry and rendering checks rather than unresolved source defects.
