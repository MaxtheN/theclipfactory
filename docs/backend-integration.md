# Growth Factory — merged engine to UI map

Current delivery: integrated master4966544, UI/model workflow verified, draftPR5 on `kartik/backend-integration`. Both a fixture live-design Mac window and an authenticated real-engine Mac window are running. Local models and a substantive captioned draft passed; see running-the-mac-app.md for review and launch instructions. The following source/control inventory retains its original700c907 audit provenance.

Source snapshot: team default branch `master`, commit `700c907` (merged PR #4), fetched November 14, 2026. Mainline is the implementation authority; no unmerged teammate feature branch was used. Code inspection occurs in `/Users/kartikbihani/WIN/growth-factory-integration`, branch `kartik/backend-integration`. The design agent's dirty checkout and native preview in `/Users/kartikbihani/WIN/theclipfactory` are untouched.

## Mainline delta

Since the interface's original backend baseline `bfa9589`, main adds local Ollama discovery/inference (`c360816`) and verified clip processing/versions/revisions/imports/retries/exports (PR #4). Existing campaign/profile/strategy/learning/team-agent services predate these changes. They are usable code, not newly merged independent research or evaluation services.

## Verification

- Full backend/launcher suite against isolated main checkout: **547 passed, 15 skipped**, one dependency deprecation warning. Tests isolate Ollama from any running local server.
- OpenAPI captured directly from a temporary app without starting its workers, model runtime or scheduler: `main-700c907-openapi.json`, **67 paths / 30 schemas**. OpenAPI covers request contracts; many untyped endpoint responses still require source-derived shapes.
- No user media, existing app data, model weights, cloud provider, social publication or spending was touched. Skipped media/hardware cases are not evidence of a successful target-Mac render.

## Primary UI controls

| View / control | Real operation | Inputs and gates | Visible result / recovery |
| --- | --- | --- | --- |
| Setup: add footage | POST `/api/videos`, multipart `file` | Supported local video, real probe, storage availability | Actual source ID/duration/audio; import errors retain brief |
| Setup: attach source | POST/PUT `/api/campaigns[/id]` | Name, brief, profile_ids, video_ids; historical memberships retained | Saved campaign; do not confuse an imported but unattached source with campaign membership |
| Setup: profile goal | POST `/api/profiles`; PUT `/api/profiles/:id` | Explicit objective; non-discovery requires primary_metric; send only permitted fields | Selected profile controls frozen production objective; brief measurement_intent is only text |
| Source: transcribe | POST `/api/videos/:id/transcribe` | Local Whisper installed/runtime ready; source idle | Real job, transcript and generated origin; expose missing prerequisite |
| Source: import captions | PUT `/api/videos/:id/transcript` | `format:srt|vtt|json`, content, optional language; valid source-timed cues, no active source task | Saved transcript/imported origin; validation failures preserve input |
| Research: save / approve direction | campaign `/strategies`, `/:version/approve` | Creator-provided direction, exact parent/base and profile scope; explicit decision | Proposed vs approved version; stale version conflicts refresh without losing draft |
| Studio: manual edit | POST campaign `/render` | Approved strategy/version, selected campaign source/profile, valid main range, transcript if captions+audio | Job response; no clip presumed until completed |
| Studio: source cold open | Same render route | opening_treatment=cold_open, cold_open_start/end, 0.5–10 seconds within source | Actual ordered source segments, not just a different label |
| Studio: text opening | Same render route | opening_treatment=text_overlay, overlay/hook text | Actual overlay treatment; preserve actual speech and transcript |
| Studio: frame / compare | Same render route | focus_x 0..1 for fill, changed_variable label; crop comes from approved direction | Actual framing and declared difference retained in edit plan |
| Studio: run local agent team | POST campaign `/produce` | expected_strategy_version_id, source/profile, installed vision-capable model_id, revision_budget≤2; model/Whisper readiness | **{job,run}**, not Job alone; bounded production ledger and unapproved outputs |
| Studio: request revision | Same campaign render route | parent_clip_id, nonblank change_reason, changed actual edit decision, same source/campaign/profile | New unapproved version with root, parent, revision number and field diff; retain old output |
| Queue: cancel | POST `/api/jobs/:id/cancel`; team run `/cancel` | Queued/running real job, current state | Requested vs terminal cancellation distinguished |
| Queue: retry render | Same campaign render route with retry_of_job_id | Failed/cancelled render, same scoped source/campaign/profile in UI; reuse prior plan, at most 3 attempts and one successor | Linear attempt history; changed active strategy requires review rather than calling it identical retry |
| Review: checks | Fields on real Clip | technical_checks.playback_format, captions, caption_issues; critic state separate | Actual pass/warn/fail/not_applicable labels; caption warnings are nonblocking but visible |
| Review: accept exact output | PUT `/api/clips/:id` `{approved:true}` | Real fresh clip/job state; unresolved team critique blocks approval | approved_at and exact version; edits withdraw approval |
| Export reviewed version | POST `/api/clips/:id/export` | Approved file; rendered checksum must still match | Persisted export record + saved MP4/SRT/manifest folder; tamper conflict is a failure, not success |
| Download / inspect export | GET `/api/exports/:id/download`, `/manifest`; list `/api/exports?clip_id=` | Use the created export ID for selected revision | Download is **MP4**, not ZIP. Manifest and local export-folder path are separate; don't label a ZIP download |
| Results: import observation | campaign `/observations` | Approved scoped clip, publication reference, metric/unit/nullable value, valid timezone-bearing positive window | Real manual-import provenance; unknown remains null; no arbitrary profile/clip relinking |
| Results: next test | campaign `/learning`, then strategy approve | Known-value selected-profile observations, hypothesis/rule, current base; separate approval | Version changes one account's direction; second-source production uses it; no causal winner claimed |

## Model and readiness rules

- Discover model IDs from GET `/api/models`; do not hardcode Qwen-only choices.
- Ollama models use `ollama:<tag>`, are local-only and managed through Ollama, not the app's model-download/delete controls.
- Text-only LLMs can run text inference but cannot analyze video frames. Use the existing installedLlms({needsVision:true}), usableModel and runtimeSatisfied helpers from current mainline.
- Ollama with an existing transcript does not require MLX. Whisper work still requires its installed model and runtime. Rendering still needs FFmpeg/ffprobe independently of the LLM.
- Readiness belongs beside the action: explain missing footage, direction, caption transcript, model, runtime, media tools, busy source or stale data. A disabled button without a reason is not adequate.

## Integrations and honest gaps

- Native same-origin bootstrap cookie and loopback-only service stay intact. The hosted browser cannot become the local engine by tunneling it.
- The current native live viewer is fixture-backed. A normal built/native UI must call real authenticated endpoints with no automatic fixture fallback. Real app integration needs a normal bundle or an explicit authenticated dev arrangement; do not relabel the existing fixture window as a real production session.
- Existing operations include Instagram connect/status, publishing, scheduling/reconciliation, insights sync and paid insights/preflight, but a route's existence is not a configured account or successful external action. Publishing/spend remain outside this integration verification; never use them as smoke tests.
- No campaign-aware precedent/EvidenceBrief/reference-inspection endpoint exists. `/produce` is post-approval production, not research; legacy `/videos/:id/analyze` uses global settings, not scoped campaign research.
- No statistical evaluation service exists. Imported observations motivate the next test; no virality, causal growth or ROAS result should be invented.
- Processing receipts report a local direct cost basis of zero with explicit exclusions, not a fully loaded unit cost or proved agency savings.

## Integration order after design finishes

1. Coordinate on the designer's final committed feature-branch SHA, preserve dirty work/drafts, and consolidate it with this exact mainline backend in a feature branch. No push/merge to master/main.
2. Carry forward current main's Ollama/preflight/type changes alongside the new design. Prepare typed version/transcript/export/agent service contracts without rewriting the engine.
3. Wire source transcripts, explicit manual/agent production, real progress/cancel/retry, linked revisions, actual checks and verified exports into the finished components.
4. Keep research/learning labels aligned to actual available endpoints and selected-profile objectives.
5. Exercise a real local synthetic-media campaign (two treatments, revision, review, export and next source), plus conflict/stale/error cases. Keep provider/model and live social calls out unless explicitly needed and authorized.
6. Independently review, run frontend/typecheck/backend checks appropriate to changes, and report verified behavior versus remaining Mac/runtime gaps. Update the shared review build as fixtures only; keep the native design window running unless transitioning it deliberately after coordination.

## Current upstream integration

After the initial700c907 audit, upstream master advanced to4966544 (PR2 local workflow fixes). It was independently reviewed, then merged into this feature branch with the designer's99476a2 UI. The delta adds bounded structured-output/range repair, retention of validated drafts, grounded source-timing fallback, caption geometry improvements and native download enablement. It preserves unapproved critic states and release gates. The earlier audit references remain historical; current integration includes these fixes. Actual model execution and fresh combined-suite evidence are recorded separately.
