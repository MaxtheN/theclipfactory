# One channel settings surface

User intent: simplify direction/workspace/onboarding without removing teammates' model, scout, clipping, review or export controls. Keep implementation on kartik/backend-integration. Root owns Setup.tsx; design chat owns GrowthApp navigation and keeps the current upload/review delivery isolated. Backend delegate owns reversible campaign archive. No inference or public effects.

## Summary
Use one basic Channel settings surface for name, audience, outcome and editing preferences. Save the selected profile's actual production goal and its campaign brief deliberately; retain existing strict payload projections and immutable earlier production snapshots. Keep source/profile linkage and versioned editing rules reachable as advanced controls.

## Reuse and structure
Reuse workspaceApi.profiles/updateProfile/save/campaigns, profileGoalBody, Field/Disclosure/AutoTextarea, useCampaignWorkspace.run. Do not add a second profile system, database or onboarding form. Factory remains the only primary upload flow; settings offers existing footage attachment without a duplicate file-upload path. Linked profiles are retained; new-profile creation and clipping engine/model controls remain available in advanced context.

## Flow and failure behavior
Read back the latest campaign before write, preserve all source/profile IDs, validate current selected profile. Save an exact writable selected-profile body, then campaign metadata with membership union. Keep input drafts after errors. Retrying absolute PUTs by exact ID is safe; unknown responses require readback before continuing and must never create duplicate profiles. Do not change or approve strategy automatically from a metadata save. Editing rules remain an explicit separate action within settings.

## Verification
Tests assert one goal control, strict profile body, selected-profile isolation, latest source membership preservation, retained drafts on failure, no implicit strategy approval/model/publication and explicit editing-rules navigation. Existing engine production tests remain unchanged. Independent review before commit; root delivers integration files separately from design-owned files.
