# Growth Factory interface architecture

Kartik owns interface and user flow. Nur owns orchestration and saved state. James owns agent/media logic. Build the complete interface first with matching fixtures; integrate the existing backend through one typed service boundary.

## Journey and hierarchy

| Stage | Decision | Primary action | Result |
| --- | --- | --- | --- |
| Setup | Audience, footage and account context | Save & find direction | Saved campaign and distinct source/profile IDs |
| Research | One creative idea worth testing | Approve direction | Explicit approved strategy version |
| Studio | Is this exact output usable? | Approve this clip | Human approval unlocks file export |
| Results | What should change in the next edit? | Approve next test | Scoped version; return to second source in Studio |

Persistent campaign/profile context → four numbered stages → one editorial heading → work surface and related decision inspector → one primary action → progressive details/history. Preserve drafts and context when moving back. Show missing inputs, real progress, stale state and recoverable failures next to affected actions. Direct moment selection belongs inside Studio, not a separate product mode.

## Visual and interaction system

The user's desktop reference governs the current material: smoked slate above, warm copper/umber below, translucent dark panels, ivory typography, fine white borders and warm-white primary actions. `desktop-glass.css` supplies the campaign/modal skin, `operational-glass.css` gives Tools the same palette, and `interactions.css` pins readable hover/focus states against legacy global styles. Inputs use translucent surfaces and a small amber focus cue. Unsupported blur and reduced transparency use dark opaque fallbacks. The current live window renders web-surface glass; desktop-through native vibrancy is not enabled. Native pywebview applies vibrancy only at creation, and relaunching the current private-mode viewer could clear WebKit storage, so preserve its process and drafts.

Setup follows brief → footage → shared primary action. Optional brand/profile administration, reference inspection detail, output settings, technical checks and receipts sit in accordions; required revision feedback, errors and approval blockers remain visible. The campaign sidebar is a compact labeled icon list; optional Workspace items are grouped. Its arrow control lives inside the sidebar and rotates when collapsing to a retained 64px rail. Operational Tools uses Create, Review and Workspace groups with the same collapse behavior. A compact topbar ⌘K trigger opens a native HTML dialog with searchable commands, keyboard selection, disabled-command guards, focus isolation and restoration. Commands navigate or refresh; they never approve, render or publish automatically. Mounted stage drafts survive navigation, collapses and quick actions. The global preview banner is removed at the user's request; source/media/evidence sample labels remain.

Short stage transitions and the decorative primary-button plane respect reduced motion. Enabled primary buttons swap to celebratory copy on hover/focus; accessible names include both visible labels. Local profiles remain planning context, not connected social accounts. Native inference, rendering quality, analytics and public distribution each require their own integration evidence.

## Architecture

`main.tsx → GrowthApp → Setup / Research / Studio / Results`

`useCampaignWorkspace → workspaceApi → same-origin FastAPI endpoints`

`useFactory → sources / clips / jobs / runtime`

Keep pywebview, SQLite, loopback bootstrap authentication and Vite's single-file bundle. Retain existing operational pages for model/runtime recovery and advanced controls. No backend rewrite, Electron/Tauri migration or local-service tunnel. No README changes.

## Small API boundary

- Setup: `/api/profiles`, multipart `/api/videos`, `/api/campaigns`.
- Direction: campaign `/strategies`; separate `/:version/approve`.
- Production: campaign `/render` and `/produce`; `/api/jobs`, `/api/clips`.
- Review: clip `PUT {approved:true}`; exact approved file `/download`. A requested revision creates another render, preserving the old file.
- Learning: campaign `/observations`, `/learning`, then separate strategy approval.

The hosted build explicitly selects a localStorage-backed fixture transport with `VITE_REVIEW_PREVIEW=true`. The native production build excludes fixture code. API errors never silently switch transports. Hosted preview cannot inspect footage, render, run models, publish or prove audience lift. This separation lets teammates wire existing operations without redesigning screens.

## Integration limits to expose

- No precedent/EvidenceBrief endpoint exists. Keep supplied reference/rationale distinct from inspected model evidence. `Direction.evidence_refs` accepts real observation IDs, not URLs.
- No statistical evaluation endpoint exists; show insufficient evidence rather than inventing a winner.
- Results blueprint is currently a template; repository contracts govern initial integration.
- Team critique is separate from human approval. Failed/unknown critique prevents team output approval. No automatic publishing or spending in this journey.
- Native window, target-machine inference, real render quality and live integrations each need separate evidence. A hosted frontend is UI review only.

## Review delivery

For live Mac interface development, run `npm run dev:review` in frontend, then `npm run desktop:review` in a second terminal. The latter opens a real native WKWebView window on the local Vite UI. Saving React/CSS files updates that window through Vite. The viewer uses explicit sample data and does not expose or replace the authenticated backend. The packaged app uses its bundled UI and local FastAPI service; rebuild/reopen it to pick up a new release bundle.

- Hosted interface: https://growth-factory-review-8090.vercel.app (sample data only).
- Frontend: `npm ci`, `npm run dev`; explicit review: `VITE_REVIEW_PREVIEW=true npm run dev`. The normal native build is `npm run build` and contains no fixture seed.
- Mac artifact built locally as `dist/Growth Factory.app`, preserving the existing desktop packaging boundaries; ad-hoc signed, not notarized. No model weights or FFmpeg are bundled.
- Native window/authentication/reopen smoke passed. This verifies the desktop shell, not target-machine model performance or render quality.
