# Single-interface migration verification

## Removed

- The obsolete `App.tsx` shell, `navigation.ts`, and App navigation tests.
- Every old `pages/` screen: Home, Clips, Footage, Campaigns, Results, Instagram, Studio, Models, Settings.
- Tests whose only subject was a removed screen. Mixed test files were narrowed and moved to `components/localSupport.test.tsx` and `components/supportWorkflows.test.tsx`; shared approval, safe download, narration, paid-read/preflight, ledger, cancellation, comparison, and URL-safety coverage remains.

No compatibility shell or second navigation remains. `main.tsx` already renders GrowthApp directly, and the root owner removed GrowthApp's old App import/surface.

## Preserved capabilities

- Models/runtime/local inference/narration/jobs migrated independently by the Brand agent into `growth/EngineSetup.tsx`; its preserved defaults use a narrow PATCH without obsolete publishing or paid-budget settings.
- Factory source-stage presentation moved unchanged to `growth/SourceStages.tsx`.
- Library's newest-first sort moved unchanged to `growth/clipOrder.ts`.
- Source maintenance lives inside Library episode details: rebuild uses the existing `POST /api/videos/{id}/storyboard` with `{}`; delete uses the existing DELETE route after the original explicit irreversible-action confirmation. Preview, loading, stale source/job data, busy state, and source-bound jobs disable both actions. These operations are not called automatically.
- Shared support components remain intact, including Jobs, Narration, ClipReview, ClipCard, TeamLedger, TeamComparisons, PaidSetup, and PaidInsights. No replacement ads interface was invented.
- The model-blocker hint now directs people to Brand profile → Advanced → Engine & models.

## Verification

Sequential focused runs, never more than two files per command:

- ClipCard + reviewSecurity: 29 passed.
- localSupport + supportWorkflows: 33 passed.
- team: 11 passed in its paired run.
- FactoryLine + FactoryFlow: 44 passed after updating the obsolete model-hint expectation.

Total final passing coverage: **117 tests across 7 files**. Source-maintenance tests use mocks only and cover exact API shapes, cancelled/accepted delete confirmation, preview/busy/loading/stale states, and source-bound active jobs. No model/provider/runtime installation, rebuild, deletion, or publication was performed.

Search found no imports of the removed pages, App, or navigation modules. `git diff --check` is clean. Final TypeScript/build verification and shell navigation checks belong to the root/Brand agents.
