# Growth Factory — design chat handoff

## What we are building

An installable, local-first Mac creative workspace for EVOLVE / 8090. A small marketing team should coordinate research, editing, review and iteration through one repeatable campaign. The eventual vision is an autonomous growth department; the immediate proof is a real, human-reviewed production and learning loop, not a clipping-volume or guaranteed-growth claim.

Measure elapsed time, active human minutes, accepted outputs, revisions and known processing cost against a matched manual baseline. Audience improvement and ROAS require actual subsequent measurement; model scores do not prove business growth.

## Current team split

- Kartik: interface, interaction hierarchy, full user flow, visual polish and hosted review.
- Nur (also called Noor in older material): orchestration, saved state, approvals and service handoffs.
- James: agent and media logic, planning, critique, analysis, captions and actual renders.
- All three: agree on contracts, integrate and rehearse the complete campaign.

## Repo and working state

- Team repo: https://github.com/MaxtheN/theclipfactory ; default branch is `master`.
- Local checkout: `/Users/kartikbihani/WIN/theclipfactory`.
- UI branch: `kartik/growth-factory-interface`; draft team PR: https://github.com/MaxtheN/theclipfactory/pull/3 .
- Fork: https://github.com/kartikeybihani/theclipfactory . Current CLI user lacks push permission on the team repo, so the UI handoff uses the fork branch. Do not merge or overwrite teammates' work.
- README files are explicitly out of editing scope. Architecture/journey are in `docs/interface-architecture.md`. Execution/review evidence is in `.sw-factory/WO-3/`.

## What exists now

React/Vite + FastAPI + SQLite + pywebview/WKWebView. The native single-file UI bundle loads through the existing authenticated loopback service. Keep that stack and security boundary.

The new entrypoint is `frontend/src/growth/GrowthApp.tsx`. Main components are Setup, Research, Studio and Results; common presentation is in parts.tsx, Icon.tsx and growth.css. `useCampaignWorkspace.ts` owns the frontend saved-resource boundary; `workspaceApi.ts` maps to existing APIs. Existing App.tsx remains the secondary operational workspace for runtime/models/integrations.

One campaign remains visible throughout. Setup saves brief/sources/profiles; Research reviews and explicitly approves a direction; Studio selects a moment, queues a cut, reviews the exact version and gates export; Results imports scoped observations, proposes and approves a next test, then opens fresh production on the second source. Back navigation and operational tools preserve mounted drafts. Profile scope, output version and approval remain distinct. Unsaved new campaigns cannot operate on a prior campaign.

This is an interface-first build. Native requests use the existing real API adapter. The hosted preview compiles `VITE_REVIEW_PREVIEW=true` to use isolated, browser-local fixtures. Normal native builds exclude the fixture seed and never fall back to sample data after failure. Do not tunnel the Mac backend to make the preview work.

## See and run it

- Hosted UI review: https://growth-factory-review-8090.vercel.app — sample data, no rendering/live analytics.
- Local Vite preview currently runs at http://127.0.0.1:5178/ . It must remain available while the native live viewer is open.
- A native window titled **Growth Factory — Live Interface** is already open on Kartik's Mac. It points to the local Vite review server and receives hot updates. The user is interacting with it; do not reset their drafts.
- To restart: in frontend run `npm run dev:review`; in another terminal run `npm run desktop:review`. These assume the local `.venv` already installed in this checkout. `scripts/preview-interface.py` opens the native development viewer.
- Installable bundle: `dist/Growth Factory.app`; archive `dist/growth-factory-mac-arm64.zip`. It is ad-hoc signed, not notarized. This native production bundle uses the local backend and bundled UI, so rebuild/reopen to pick up release UI changes. It does not bundle model weights or FFmpeg.
- Hosted review uses Kartik's selected `kartikey-bihanis-projects` Vercel team, project `growth-factory-review-8090`. James's account may host it later; do not transfer or change billing without a new request.

## Design direction and sources

The user now wants substantial taste-driven design feedback and refinement. Current direction: cloud-blue canvas, legible frosted panels, ink typography, restrained mint, clear grouping, one primary decision per step, progressive disclosures and short reduced-motion-aware transitions. These are starting points, not a reason to resist the user's new design choices.

Shared Google Doc: https://docs.google.com/document/d/1z4zDtS_dWYrqE_WLMYj71QUsTgEuI9U_ImV6mCc5n6o/edit?tab=t.4nefn0b39miw . Tabs: MVP & Visuals (six-page current plan), Build Notes, Archive · Early notes (historical; preserve).

Four generated All-In design concepts live in `/Users/kartikbihani/WIN/design/growth-factory/`:

- `01-campaign-setup-allin.png`
- `02-precedent-research-allin.png`
- `03-clip-studio-allin.png`
- `04-results-learning-allin.png`

These are concepts, not real All-In account data, footage or endorsement. Prompt manifest is visual-prompts.md. Actual native viewer screenshot is interface-native-live.png in the same directory. All-In is an example campaign, not proof of agency savings or business impact.

## Software Factory

Connected MCP namespace: `mcp__software_factory_nurislombek_mah`. Project Growth Factory: `2791013e-0f01-4b6b-a530-854ffd4e0319`. Repo association: `github:maxthen/theclipfactory`. Read `/Users/kartikbihani/WIN/.agents/skills/software-factory/SKILL.md` and the required record-writing skills before governed edits. MCP has project records, comments and agent history; this session exposed no direct agent-launch action. The implementation was executed against WO-3 through MCP, not claimed as an unseen Factory agent run.

- WO-3: Kartik: Build interface and user flow (`3ba06f09-ec88-4bd1-8cc6-581e4140fd31`).
- WO-2: Nur: Build workflow orchestration and saved state.
- WO-1: James: Build agent and media logic.
- Requirements: overview `7bf11492-e35e-442a-995e-d9fb01dfa64a`; Business Problem `cf27db0a-20a8-4fa7-b003-e97b84e9125d`; Product Description `a9efad7d-7da2-4261-950d-e9ce3192abe6`; Success Metrics `9adee6c9-b2c0-430e-8d9f-3f38f78174f4`.
- Features: Campaign `e87420e8-2531-4146-b26e-dd2305b2d5b5`; Production `41c13942-f8fa-412c-af1a-c628186d0852`; Precedent `22e671bd-26d2-4ef0-b3e8-ec602f07ade4`; Results `237379a7-3cb3-44c3-bd47-f342d3b41e07`.
- Blueprints: Campaign `f59a8629-1f87-4d7c-a3b9-ccbee2d7afb4`; Production `8538463e-e131-4066-b65a-8292c24e11ba`; Precedent `6b0fbedc-c726-4ecf-a075-16be1d617f6a`; Results `b567b57e-e184-4a37-94d5-fca2cd728187`.

Read current records before relying on them; teammates are actively editing. Document edits are pending suggestions, not self-approved changes. Use plain headings and Done when bullets; no opaque requirement codes. Do not change Google Doc or Factory product scope merely to match a visual tweak.

## Demo contract and remaining work

Required end-to-end product proof: two sources, two local profiles, one inspected reference/pattern/hypothesis, two hook variants differing one variable, one requested revision, one second-source clip changed by approved strategy (four rendered versions), actual accepted exports, real scoped observations, saved update surviving restart, other profile unchanged. Human review is separate from model critique. No live publishing or paid ads required. Later: broader clip volume, integrations, scheduling and paid optimization.

Current gaps: no stored precedent/EvidenceBrief API (creator rationale is labeled as such); evidence_refs accepts observation IDs, not URLs; no statistical-evaluation endpoint; real model/render quality, target hardware and live integrations need separate testing. Full product acceptance is not claimed.

Verification: 148 frontend tests passed; TS/Vite build passed; 509 backend/launcher tests passed with 12 skips. Packaged worker/UI asset verification and actual Cocoa window/authentication/close/reopen smoke passed. Independent review approved after fixing exact-draft approvals, next-source handoff and new-campaign scope. One advisory remains: add fuller API shape validation beyond IDs. Native development viewer was reviewed and opened. Keep changes scoped, run relevant checks and preserve explicit sample labels.

## Next chat

The user will provide design feedback there. Receive this context, inspect the actual interface/mockups as needed, and iterate on the same UI branch. Do not start a new framework, create a second app, merge to master, transfer hosting, or claim real render/growth results from fixtures. The previous chat finishes the handoff and stops product edits so this design chat can own the next pass.
