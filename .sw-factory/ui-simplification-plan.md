# UI simplification pass (Mac app, frontend/src/growth)

Goal: get down to the engine. Add episode -> agents find clips -> review/approve -> results -> learning.
Hide, don't destroy: pipeline controls stay functional, behind one disclosure.
Out of scope (other agent): Results*.tsx, AutomationPanel.tsx, all backend Python.

## Shell (GrowthApp.tsx)
- Sidebar: Factory, Library, Results + Channel settings at the bottom. REMOVE the sidebar "Advanced" menu.
- MOVE "New workspace" + "Advanced tools" into one "Advanced" disclosure at the bottom of Channel settings
  (same aria-label "Advanced controls"), and keep both as ⌘K quick actions.
- REMOVE "How the factory works" quick action and its help banner.
- REMOVE page eyebrows ("YOUR VIDEO PRODUCTION WORKSPACE" etc.); keep title + one short line.
- RENAME "Editing rules" -> "Style rules"; "Production & review" -> "Studio"; topbar "Campaign" -> "Channel".
- REMOVE "Sources and outputs marked illustrative..." footer paragraph (rows/cards already label illustrative).
- Shorten error banner copy.

## Factory (FactoryHome.tsx)
- REMOVE FactoryWorkflow explainer (component + its test deleted).
- Upload card -> compact "Add episode" bar (the one primary button). Drop still works. REMOVE helper note.
- REMOVE "Ready for your review" cut grid (duplicate of per-episode "Review N clips").
- REMOVE "Open Library" button, empty-state paragraph, "How the factory loop works" disclosure,
  "One direction to review" banner.
- Episode row = ONE action: Working… (progress + quiet Cancel) | Review N clips | Find clips.
  "Make clips" (swarm) and "Find clips" (open studio) MERGED: with the local production line,
  Find clips runs the swarm; without it, Find clips opens the studio. A quiet "Open" opens the studio.
- Unapproved style rules -> one quiet inline line on the row with a "Approve style rules" link.
- Stage tracker shown only while working. REMOVE per-row "Source details" (still in Library).
- Import success card: only "Find clips" (REMOVE "Choose a moment", "Add another video" — Add episode stays visible).

## Studio (Studio.tsx)
- Default mode = agents. Default view: source player + "Let agents find clips".
- COLLAPSE into one closed "Fine-tune" disclosure: production mode, source range, transcript,
  model, correction budget, opening/hook, crop, captions, format. Opens automatically for a revision.
- REMOVE media-context spec panel (SOURCE / STRATEGY / PROFILE), overlines, helper paragraphs.
- Production queue/ledger -> closed "Production log" disclosure (cancel/retry stay inside).
- Review: big player; Approve / Request a change / Export as the only primary actions.
  "Recheck technical critique", ClipEvidence and export history -> one closed "Details".
- REMOVE "Review the results" duplicate button. "Review and approve direction" -> "Approve style rules".

## Style rules (Research.tsx)
- One plain card: four labelled rule fields, then save -> approve (guard logic unchanged).
- REMOVE poster/reference art, overlines, "A/B" decoration, "One variable" box, research note paragraphs.
- Reference + reason -> one closed "Notes & reference" disclosure.
- Buttons: "Save draft" / "Approve style rules".

## Channel settings (Setup.tsx)
- REMOVE three Advanced sub-disclosures; ONE "Advanced" disclosure holds footage attach, linked
  profiles, New workspace, Advanced tools. Shorter hints. "Editing rules" button -> "Style rules".

## Library (Library.tsx)
- Tabs: Clips / Review wall / Episodes. REMOVE per-tab scope paragraph; shorten empty states.

## Tests
- Update only label/layout assertions. Approval, exact-revision, no implicit publication,
  profile isolation assertions keep their strength.

## Phase 2: Workspace -> Campaigns (UI only)
- Workspace = backend profile; campaign = goal-scoped push linked to it (profile_ids).
- Top bar: "Workspace" select (profiles linked to any campaign, plus "New workspace…" -> onboarding),
  then "▸ campaign" picker only when the workspace has 2+ campaigns (with "New campaign…").
  The old "Active account profile" select is gone (merged into the workspace switcher).
- "Channel settings" -> "Workspace settings": Workspace section (name, audience, voice, preferences,
  account row) and Campaign section (campaign name, goal, metric, New campaign). Same strict save:
  selected-profile only, membership union, readback.
- New campaign form (NewCampaign.tsx): name, goal, metric, attach this workspace's episodes.
  Creates one campaign linked only to the current workspace via the existing POST /api/campaigns.
- Backend gaps (not built, reported): style rules (strategy versions) are per campaign, so a new
  campaign starts unapproved; goal/metric are stored on the profile, so they are shared by a
  workspace's campaigns (each campaign also records its own measurement_intent).
