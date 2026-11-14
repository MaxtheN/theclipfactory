# Growth Factory interface implementation

## Summary
Build the four-step desktop workspace on the existing React/Vite + FastAPI + pywebview stack. Build interface first against an explicit fixture transport, keep a typed adapter for later wiring, and produce a hosted review build from the same components.

## Code Reuse And Package Structure
Reuse api.ts, useFactory.ts, campaign/domain types, authenticated endpoints, production preflight checks and operational pages. Retain App.tsx as the operational workspace. Add growth/ for the shell, steps, typed service and fixture transport; scoped growth.css; docs/interface-architecture.md. Change the entrypoint and document title. Leave README files, backend, authentication and teammates' workflow code unchanged.

## Components And Flow
GrowthApp composes useFactory and useCampaignWorkspace. workspaceApi maps user operations to existing endpoints. Native build calls same-origin authenticated API; an explicit compile-time flag selects the browser-local fixture transport for hosted review. API failure never triggers a sample-data fallback. Setup saves campaign and sources; Research explicitly approves creator-provided direction; Studio queues work and reviews exact versions; Results proposes account-scoped direction from observations. Existing operational pages remain available for recovery.

## Steps
1. Record user journey, interaction hierarchy and architecture before code.
2. Build typed API adapter and isolated preview transport.
3. Implement four-step shell and screens with draft preservation and honest state transitions.
4. Add integration tests for preview journey, failed saves, approval/export gates and profile scope.
5. Verify tests/build, browser layout and workflow, then native window where available.
6. Review separately, publish hosted preview and push dedicated review branch/fork.

## Testing
Run npm test and npm run build. Verify new journey, reload persistence, failure recovery, explicit approval, no export of pending clips, narrow viewport, reduced motion. Verify normal production build contains no preview seed. Browser test four stages, then native pywebview smoke without models, inference or live social actions. Hosted review is not render-quality evidence.
