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

The user's desktop reference governs the current material: smoked slate above, warm copper/umber below, translucent dark panels, ivory typography, fine white borders and warm-white primary actions. `material-tokens.css` is the shared palette contract; `desktop-glass.css` supplies the campaign/modal skin, `operational-glass.css` gives Tools the same palette, and `interactions.css` pins readable hover/focus states against legacy global styles. Nested options use flat surfaces rather than additional glass. Inputs use translucent surfaces and a small amber focus cue. Unsupported blur and reduced transparency use dark opaque fallbacks. The current live window renders web-surface glass; desktop-through native vibrancy is not enabled. Native pywebview applies vibrancy only at creation, and relaunching the current private-mode viewer could clear WebKit storage, so preserve its process and drafts.

Setup follows brief → footage → shared primary action. Optional brand/profile administration, reference inspection detail, output settings, technical checks and receipts sit in accordions; required revision feedback, errors and approval blockers remain visible. The campaign sidebar is a compact labeled icon list; optional Workspace items are grouped. Its standard Lucide PanelLeft control lives inside the sidebar and collapses to a retained 64px rail. Operational Tools uses Create, Review and Workspace groups with the same collapse behavior. A compact topbar ⌘K trigger opens a native HTML dialog with searchable commands, keyboard selection, disabled-command guards, focus isolation and restoration. Commands navigate or refresh; they never approve, render or publish automatically. Mounted stage drafts survive navigation, collapses and quick actions. The global preview banner is removed at the user's request; source/media/evidence sample labels remain.

Primary buttons keep their visible action wording stable. Setup uses a 680ms plane flight/re-entry; Research drafts use a 640ms arrow sweep/re-entry; approval traces and settles its check in 520ms. Produce and iterate retain brief play/refresh cues. These play once on deliberate hover or keyboard focus, return home, and respect disabled/reduced-motion states. `workspace-motion.css` progressively animates native disclosure height/opacity in 260ms and dialog scale/fade in 220ms, including discrete top-layer exit. Commands and focus restoration remain immediate; CSS never delays actions. Native behavior remains the fallback. Checkboxes/radios share a 16px warm edge/translucent fill, ivory checked fill/dark tick, visible disabled states, keyboard outlines and forced-colors fallback. Campaign, Tools and modal use one system font contract and matching title scale; decorative artwork/code keep their appropriate fonts. The decorative campaign-folder icon is removed.

Free-form fields share `AutoTextarea`, measured through an inert hidden mirror to preserve caret/focus and avoid collapsing the visible control. Rows define the minimum; fields grow and shrink with wrapping up to 240px, then scroll internally. Width changes, font readiness and disclosure reveal trigger remeasurement. A 140ms height transition respects reduced motion. URLs, searches, secrets, pipeline identifiers, numbers, dates and enumerations retain their appropriate controls. Local profiles remain planning context, not connected social accounts. Native inference, rendering quality, analytics and public distribution each require their own integration evidence.

Account chrome uses a standard 20px profile icon beside the existing top-right campaign profile selector (13px text, 36px control). Navigation icons are 18px and utility icons 16px; compact profile icon is 18px with a bounded selector. Bottom-left preview/version decoration is removed; Workspace utilities remain at the bottom. Tools retains its own operational profile controls; the campaign selector must not imply a global scope for Tools actions. Sample/evidence labels remain in the actual work surfaces.

The final palette restores transmitted light after the first restraint pass became too charcoal in the user's native screenshot. Canvas stops: `#40515F` → `#495664` → `#665347` → `#724A34` → `#594137` at 160 degrees. Panel tint: `rgba(118,128,136,.22)` with 24px blur; shell: `rgba(35,43,49,.18)`. Primary text: `#F3F1EC`; secondary: `#E8E4DC`; metadata: `#DEDBD3`. Primary action: `#F0ECE4` with `#292D2E` ink. Focus: `#E2C49D`; warning: `#F9E1BF`. Outer edges: white at .23; fields: white at .035 with .24 edges. Command panel: `rgba(71,79,87,.35)` with 28px blur, above a .14 dark/18px blur backdrop. These are web material tokens, not native desktop transparency. Native selects receive explicit appearance, height and chevrons to avoid WebKit's compact default rendering.

Contrast audit estimates standard sRGB compositing over the five declared canvas stops, including applicable nested white fills: panel text 5.62–6.89:1, secondary 5.00–6.13, metadata 4.59–5.62; field text 5.15–6.27, placeholder 4.59–5.58; selected-and-hovered source text 4.57–5.48; focus edge 3.49–4.25; warning 4.77–5.66. Command text is estimated at 6.84–8.52 and selected text 5.44–6.65 over modeled canvas/panel underlays; primary action is 11.81. Blur and media underlays vary, so these are token-composite estimates rather than pixel certification. Primary hover/selected source metadata uses full ink to avoid a nested-fill contrast dip.

## Architecture

`main.tsx → GrowthApp → Setup / Research / Studio / Results`

`useCampaignWorkspace → workspaceApi → same-origin FastAPI endpoints`

`useFactory → sources / clips / jobs / runtime`

Platform wording comes from `src/platform.ts`. `/api/system`'s `os` (`macos`, `windows`, `linux`) sets it, and a browser guess stands in until that loads. It names the computer ("this Mac" or "this computer"), the key store (macOS Keychain, Windows Credential Manager, the system keyring), the command-palette shortcut (⌘K or Ctrl+K) and the FFmpeg install step. Components read `platformWords()` while rendering; `GrowthApp` subscribes with `usePlatform()`, so a reported OS re-renders the tree. Review-preview copy says "the desktop app", because a preview has no host OS. Off the Mac, `AgentSetup` shows the engine's `agents` blocker (`agents_hardware`, `ollama_missing`, `ollama_stopped`, `agent_model_missing`) in Factory, Studio and Settings → Models, with the alternatives and Check again (`/api/agents/check`), and the licensed model download (`/api/agents/ollama/pull`).

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
