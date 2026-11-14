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

## Design refinement — November 14

User requested a best-practices visual refinement of the existing interface. Reuse all four mounted screens, API adapters and state boundaries. Refine `growth.css`, shell presentation in `GrowthApp.tsx`, and concise Setup labels only; no workflow, storage, backend, framework or README changes. Use neutral solid surfaces, restrained forest-green selection, a readable type scale, consistent spacing and clear control states. Remove decorative chrome that competes with campaign work. Preserve preview labels, errors, scope, versions, approval gates, keyboard focus and reduced motion.

Steps: inspect current requirements/blueprints and current CSS; refine shared tokens and screen layouts; inspect every stage at desktop and narrow widths in an isolated review browser; run the existing frontend suite and TypeScript/Vite build; obtain an independent review and append evidence. Keep the user's live Vite/native viewer running and never reset their storage. No new tests for cosmetic-only changes; existing journey tests cover persistence and approvals.

## Hierarchy, glass and primary-action delight — November 14

Group campaign essentials separately from profile/guardrail context in Setup; group the creative idea separately from the paired opening experiment in Research. Retain Studio media/inspector and Results evidence/next-test relationships. Use shared semantic field groups and primary actions without changing handlers, approval gates, component identity or stored drafts. Update parts.tsx, Icon.tsx, the four stage components and scoped growth.css, plus architecture/execution notes.

Introduce a layered in-app backdrop, translucent shell/panels with blur, legible form surfaces, reduced-transparency and unsupported-blur fallbacks. This is web-surface frosting; native desktop-through transparency must not be claimed. Shared primary CTA retains a stable accessible action name, swaps celebratory visual text on hover/focus, and loops an aria-hidden paper plane only while enabled and hovered/focused. Reserve both label widths to prevent layout shifts and stop motion under reduced-motion preferences. Export remains an ordinary gated download link.

Verify existing frontend journey tests and TypeScript/Vite build, plus focused component checks for stable accessible names and disabled behavior. Visually inspect grouping, hover/focus, compact layouts, glass contrast and motion/transparency fallbacks. Keep native viewer/Vite running; all code stays on the feature branch. Independent review precedes commit/push.

## Delivered additions and handoff

The user additionally requested a native live development window. `scripts/preview-interface.py` and `npm run dev:review` / `desktop:review` supply this on loopback without changing the packaged API boundary. The viewer is open and receiving Vite updates. The installable bundle and ZIP were built and passed packaged assets plus native authenticated window/reopen verification. Shared Vercel preview bytes match the review bundle. Draft PR: https://github.com/MaxtheN/theclipfactory/pull/3 . Full design continuation context is in docs/design-handoff.md.
