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

## Progressive hierarchy and quick actions — November 14

Arrange each stage in operation order and collapse supporting content: Setup starts with brief, then sources, then optional brand/profile administration; Research presents the editable direction and opening experiment before reference detail; Studio starts with source/range and keeps optional treatment/technical details folded; Results retains observations before next-test decisions and folds receipts. Preserve required profile context, warnings, exact-version approval and all mounted draft state.

Simplify sidebar to a compact icon-led campaign group and a collapsed workspace/help group; remove descriptive sidebar marketing and repeated stage subtitles. Keep current campaign/profile in the topbar. Add a small search-style Quick actions button with ⌘K; a new QuickActions component supplies a real native HTML dialog, searchable navigation commands, arrow/Enter navigation, Escape dismissal, modal focus isolation and focus restoration. Commands reuse existing handlers, preserve disabled/busy/new-campaign rules, and do not approve/render/export automatically. Keyboard shortcut works from workspace and tools, without allowing background page actions. No backend, dependencies or README changes.

Verify existing journey suite plus meaningful dialog integration tests for keyboard opening, filtering/action execution, Escape/focus restoration and blocked commands. Browser-check operation order, collapsed details retaining drafts, compact navigation and dialog at desktop/narrow widths. Keep the native viewer and Vite processes running; independent review and checks precede feature-branch commit/push to MaxtheN/theclipfactory.

## Reference material and sidebar control — November 14

The user's supplied desktop screenshot supersedes the earlier light palette: match smoked slate/charcoal glass, warm copper/amber undertones, ivory type, thin translucent borders and warm-white primary actions. A scoped desktop skin and matching operational stylesheet retain the current operation order, accordions, shortcuts and action gates. Focus/hover overrides adapt to the dark material. Sidebar collapse becomes an arrow control inside the sidebar/brand area; a narrow retained rail lets users expand it. Both main workspace and operational Tools retain their mounted content/drafts.

Read-only native feasibility inspection confirmed installed pywebview only applies transparent/vibrancy flags at window creation, with no current live-update hook. The existing private-mode window must stay running because relaunch can clear WebKit storage. Deliver the reference material through CSS in the current live viewer, without claiming desktop-through native vibrancy. Keep all changes on the team feature branch. Validate the supplied reference visually, real command keyboard behavior, hover/focus contrast, collapse/expand, representative Tools pages, responsive overflow, existing 154 tests/build and independent final review.

## North Star restraint and growing fields — November 14

The user explicitly adopted the attached Product Design North Star. Preserve the approved slate/amber family while subtracting decorative gradients, repeated bordered surfaces, excess blur, marketing-like copy and perpetual motion. A dedicated read-only palette audit will provide exact shared colors and measured contrast assumptions. Apply a small coherent token set across campaign, Tools and command dialog; simplify the sidebar toggle with a standard prebuilt icon. Preserve all command/approval/render gates and the live native session.

Add a shared controlled AutoTextarea for semantically free-form text across campaign and operational forms, including campaign/profile names, audience, brief, direction, instructions, notes and prompts. Measure through a hidden mirror so visible controls do not collapse, preserve caret and refs, resize when width/visibility changes, shrink on deletion, cap at 240px by default and then scroll. Numeric/date/enum/search/URL/identifier/secret controls retain their appropriate existing behavior. Animate height briefly with reduced-motion support. Use meaningful component tests plus existing journey regressions and real browser wrapping/deletion/disclosure/navigation checks.

Primary actions retain explicit action wording and use distinct, short per-stage motion cues instead of a perpetual hover loop. Keep dimensions and accessible names stable, disabled behavior intact and reduced motion respected. Verify exact palette contrasts and CmdK legibility; run tests/typecheck/build, inspect desktop and compact layouts, and obtain independent review before committing/pushing to the existing team feature branch. README, backend/native launchers and storage stay unchanged.

User's in-progress screenshot correction supersedes the overly flat first token pass: retain the reference's visible blue-grey upper light and copper/umber lower light behind low-opacity glass, rather than opaque charcoal panels. Keep the simplified geometry and typography. Use a coherent spatial canvas with a translucent shell/panel/modal material, reassess contrast over the brighter range, and normalize native WebKit select appearance/height without changing values or handlers. Verify the restored material visually before delivery.

Final craft steering: unify native checkboxes/check marks and typography across campaign, modal and Tools; remove the decorative folder beside the campaign selector. Restore a more expressive but bounded flight/re-entry cue for Setup and Research actions, keeping labels, accessible names, footprint, disabled states and reduced motion intact. Animate the full disclosure content, especially campaign progress, and modal scale/fade entry/exit through progressive CSS enhancement without delaying command execution or focus restoration. Preserve native details/dialog semantics and original drafts; inspect supported CSS, verify browser motion/states and no overflow, run existing checks and obtain a fresh final review before pushing.

## Delivered additions and handoff

The user additionally requested a native live development window. `scripts/preview-interface.py` and `npm run dev:review` / `desktop:review` supply this on loopback without changing the packaged API boundary. The viewer is open and receiving Vite updates. The installable bundle and ZIP were built and passed packaged assets plus native authenticated window/reopen verification. Shared Vercel preview bytes match the review bundle. Draft PR: https://github.com/MaxtheN/theclipfactory/pull/3 . Full design continuation context is in docs/design-handoff.md.
