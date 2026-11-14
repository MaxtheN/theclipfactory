# Pearl Studio merge into master

User explicitly authorized pushing the completed UI branch and merging it into the default branch on 2026-11-14. The repository default is `master`; there is no `main` branch. Candidate combines Pearl Studio `8437186` and upstream master `85c3547` without modifying the shared checkout's in-progress landing-page/backend/demo work.

## Conflict resolution

- Keep the single GrowthApp entry point and Engine & models inside Brand profile Advanced; do not restore the legacy App/navigation or Models/Settings screens.
- Preserve upstream autopilot activation when footage was attached before style approval, Library discards/episode deletion and campaign source cleanup.
- Use upstream shared Stages and productionState helpers; remove duplicate SourceStages/clipOrder modules.
- Both Library source-deletion entry points use the same confirmed batch deletion and local-service lineage guards. Busy, stale and active-source states lock deletion. Maintenance actions also lock while clearing, preventing storyboard rebuild during deletion.
- Retain Narration, StructuredData/TeamLedger, pure preflight and modern Engine/Studio/posting coverage. Remove tests and imports solely for upstream-deleted legacy components. Correct README and historical UI-map note for current settings placement.
- Apply Pearl status colors to the retained stage tracker; active labels no longer inherit white text.

## Verification

145 unique targeted frontend tests passed: FactoryLine 30, EngineSetup 9, localSupport/team 13, productionPreflight/channelSettings 26, StudioProduction/PostToInstagram 40, ResultsStory/workspace 27. These include upstream deletion/autopilot cases, declined confirmation, exported/revision retention, preview/stale/active-job guards and a new pending-deletion maintenance-lock regression.

Backend `tests/test_app.py -k deleting_a_source`: 1 passed. Final `npm run build` (TypeScript + Vite), conflict-marker scan and diff checks passed. Independent review findings above were corrected. No actual clip files were deleted, no model or render jobs were started and no external posts were made. Hosted CI is separate from these local checks and will run on push.
