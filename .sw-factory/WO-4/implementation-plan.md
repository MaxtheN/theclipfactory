# WO-4 — connect the merged engine

## Summary

Integrate the finished UI with the actual engine at team master 700c907, preserving the designer's feature branch and running native design viewer. Begin with isolated typed API contracts and tests; do not touch the active designer checkout. Once its design pass finishes, coordinate and bring its committed UI into this integration branch before wiring controls. Never push or merge to main/master.

## Code Reuse And Package Structure

Reuse the existing authenticated api.ts transport, useFactory polling/actions, current main's installedLlms/runtimeSatisfied helpers, saved campaign APIs, TeamLedger and TeamComparisons. Reuse the designer's four-stage components and visual classes rather than replacing the interface. New frontend/growth modules will hold production contracts, response validation, service operations and pure readiness/lineage helpers, with targeted tests. Planned visual wiring touches Studio, Setup, workspaceApi and previewApi only after design coordination; transcript and technical-check sections can be small separate components. README files, native authentication and the media engine stay unchanged. Record contracts in docs/backend-integration.md.

## Components And Flow

- Source readiness: source audio/transcript provenance → import/transcribe or captions-off → validated render readiness.
- Manual render: approved campaign/profile/version + explicit main/opening plan → Job → terminal result.clip_id → exact new unapproved Clip.
- Agent production: approved context + dynamically selected ready local vision model → {job,run} → real ledger/tasks/results, with critique separate from human approval.
- Revision: clone the selected clip plan → concrete changed edit fields + parent_clip_id + change_reason → new immutable linked output, fresh review.
- Review/export: actual playback/caption/critic statuses → explicit human approval → POST verified export once → saved ExportRecord with MP4/manifest/history links.
- Learning handoff: keep profile.objective/primary_metric distinct from brief text; preserve real scoped observations, explicit proposal/approval and next-source version identity. No missing research/evaluation service is simulated as real.

Define request and response types from current API_CONTRACT.md, Pydantic/OpenAPI input schemas, app.py/media.py response construction and the three independent audit reports. Optional new fields on legacy records remain unknown. Validate malformed output rather than inventing checks or files. Reuse known export records after ambiguous submission; never automatically retry observation/export writes.

## Steps

1. Complete source audit and baseline tests; source snapshot and every route are recorded outside the design checkout. Done: 547 backend/launcher tests passed, 15 skipped; main frontend 141 passed and build passed.
2. Add contract/adapter/readiness modules with API-shape, scope, revision, retry and export tests in the isolated worktree. This is independent of visual work.
3. Wait until Refine UI design is idle before messaging it. Coordinate the final committed SHA, ownership and live preview continuity, then consolidate that UI with current master in the integration feature branch. Preserve any new dirty work.
4. Wire supported actions into the finished UI, retaining progressive disclosure and the design system. Keep fixture transport aligned but explicitly labeled; real backend errors never fall back.
5. Verify real authenticated API operation with temporary app data, frontend interaction/contract tests, current backend suite and browser/native checks. Actual media/MLX tests remain an explicit gap if required tools/models are absent; do not download weights or make social/provider calls.
6. Independent review; resolve blockers; push the integration feature branch only and update the work order/delivery record. Keep the user's native live window running; transition to an integrated view deliberately after coordination.

## Testing

Use frontend Vitest for exact request bodies, runtime response guards, Job versus {job,run} responses, stale/wrong scope, malformed checks, revisions and duplicate/unknown-write behavior. Add interaction tests for prerequisite explanations, actual source opening treatment, linked revision reason/delta, critique versus human acceptance and verified export receipt. Run npm test and npm run build in the isolated integration checkout after changes. Backend baseline already passed from current main; rerun affected checks after merge/wiring only as needed. No external provider or live publishing/spend call is a smoke test. Inspect the native UI with authenticated temporary state before claiming real integration.

## Approved journey change

Kartik's paper sketch replaces the daily four-stage navigation with Factory / Library / Results. The design chat owns GrowthApp and new Onboarding/FactoryHome/Library components and CSS/tests in this same isolated worktree. Root owns Studio and contracts; existing Setup becomes editable workspace settings. Brief, audience and actual objective are captured once when no usable workspace exists. Upload attaches a real local source; choosing agent production remains an explicit action with visible model/runtime prerequisites and approved direction. Library opens an exact clip identity. Preserve drafts and scoped campaigns under the simpler shell. Three-day analytics is a target workflow, not a running service: no invented winner, background sync or paid execution. The logo is a generated transparent cutout of the supplied image.

## Authorized local execution setup

The user explicitly requested needed local model downloads and full-product verification after the initial UI-only scope. Hardware verified Apple M5/16GiB/360GiB free. Install official local-only Ollama with Qwen3-VL4B-Instruct and the app's existing MLX/Whisper runtime in isolated diagnostic state; keep binaries/weights/logs outside git, no paid/cloud inference. First realAll-In deterministic smoke passed2hooks+1linkedrevision+3checksum-verifiedexports. Technical-test approvals were then withdrawn so the native app awaits editorial review. Full backend suite with actual media tools:556passed6skipped; remaining mocked Whisper/Kokoro paths require NumPy in the testvenv. Installation and actual model-execution gates remain distinct until verified.

## Upstream refresh

Origin/master advanced from700c907 to4966544 (PR2) during verification. Media reviewer approved the coherent backenddelta with146 targeted tests passing (one NumPy skip), including real caption geometry. Committed the prior design merge (2d9ed46), then merged currentmaster cleanly (d55f613). No main/master write. Re-run the combined affected checks after actual inference is finished so the16GiB Mac is not overloaded.
