# Clip Factory desktop frontend

React + TypeScript, organized by screen, with a Vite single-file build. No remote fonts, images, scripts, sample content, invented insights, or credential persistence.

## Verify and build

Requires Node **20.19+ or 22.12+** (Node 22 recommended).

```sh
cd frontend
npm ci
npm test
npm run build
```

`dist/index.html` is the only production artifact. Serve it from the **same origin as the FastAPI backend** / desktop launcher; do not open it as a `file://` page. The app uses absolute `/api/...` paths and `credentials: "same-origin"`; media and downloads use cookie-authenticated same-origin URLs. It never sets `X-Clip-Token` or bypasses authentication. Auth boot and secure token storage belong to the backend.

## Development

```sh
npm run dev
```

Vite binds to `127.0.0.1` and proxies `/api` to `http://127.0.0.1:8765` without rewriting the origin or adding auth headers. Bootstrap the backend's local session using its launcher on the **same hostname** before using the dev UI. Cookie sessions are not shared between `localhost` and `127.0.0.1`. Missing authentication is surfaced as an actionable error. There is no development-only auth bypass.

## Screens

The app shell is `growth/GrowthApp.tsx`. The sidebar has five destinations: **Factory** (the default: add footage, approve a clip style and press **Find clips** on an episode), **Library** (episodes, clips and the review wall), **Results** (how posted clips did, and Strategist rules waiting for approval), **Brand profile** (brand and voice, goals and brief, brand kit, Style rules and connected accounts) and **Settings** (Device and runtime, Models, Accounts and connections, Privacy and storage, Background jobs, About). **Studio** (one episode's production) and **Style rules** open from those screens; **⌘K** opens Quick actions.

- `GET /api/factory` drives the Factory page. The service computes each source's `state`, `stages`, `headline`, `progress`, `can_produce` and `blocked_reason`; the UI renders them as given and never derives pipeline state itself. Stage labels come from the service. `blockers[].tab` is honoured only when it names an existing tab.
- **Find clips** sends `POST /api/campaigns/{id}/produce` with the approved direction (`growth/productionApi.ts`). Factory and Studio say beside the button why it cannot start: no approved clip style, no local model, or the review preview. **Cancel** sends `POST /api/jobs/{job_id}/cancel`. **Settings → Models → Production defaults → When footage arrives** sets `autonomy` (`"auto"` or `"review"`).
- A clip waits for review until the creator approves it (`approved: false`). Clips are reviewed in Library's review wall and in Studio.
- `components/Storyboard.tsx` renders `GET /api/videos/{id}/storyboard` (404 = not watched yet): motion and sound as two stacked traces on a shared time axis, a row of scene segments, a hover/focus readout, and the scene list, which doubles as the table view of the same values. Frame and thumbnail URLs are loaded only when they are same-origin `/api/...` paths. `POST /api/videos/{id}/storyboard {}` (**Watch footage / Watch again**) rebuilds it.
- Video list items may carry a slim `transcript` (`{language, text, segment_count}`), `has_transcript` and a `storyboard` summary. `sourceHasTranscript()` prefers `has_transcript` when it is a boolean.
- Settings gain `default_model` (`""` = automatic) and `clip_count` (1–6); both are part of every `PUT /api/settings`.

## Integration expectations

- The root `API_CONTRACT.md` defines exact routes and payload fields. GET lists return arrays; DELETE can return JSON or HTTP 204.
- Initial load requests system, settings, models, jobs, videos, clips, Instagram status, analytics, and the factory line independently. Failure of one resource does not hide all the others.
- The factory line, jobs, videos, clips, models, Instagram status, and analytics refresh every four seconds while visible. System/settings refresh at boot, on explicit refresh, and after mutations, so background polling does not erase settings edits.
- Source `analysis` supports a candidates array or `{ candidates: [...] }`; serialized JSON is also supported. Persist analysis on the source so it remains associated with the correct video. A completed analyze job with `result.video_id` and candidates is also supported. Inference output is read from `result.output`.
- Uploads use multipart `file`. Manual render payload is `{ start, end, hook, caption, objective, subtitles: true, format: "vertical" }`. Transcribe before rendering to provide spoken subtitle text.
- Publishing needs a strictly approved clip, explicit `publishing_enabled`, `connected: true`, and `publishing_available: true`, plus a public HTTPS URL. Backend must revalidate approval, permissions, account, asset hosting/security, and actual Meta success. Queuing is not reported as publishing success. Hosting is not provided by this UI.
- Tokens exist only in Instagram component state, are cleared at submission/navigation, and never reach local/session storage. Backend handles OS keychain storage; API responses must not expose credentials.
- Missing/null/nonnumeric metrics display **Unknown**, while an observed `0` stays `0`. Manual events always carry `source: "manual"`, omit blank optional numeric fields, and never claim causal attribution. Custom events use the settings-defined `custom_event` convention.
- Autonomy values are passed to the backend for validation. Autopilot (`auto`) starts local production for new footage; it never approves or publishes a clip. Ads settings do not create campaigns.
- The only browser persistence is the navigation preference: `clip-factory-tab` and `clip-factory-nav` (a layout marker so a tab saved by the old navigation is translated once: Dashboard → Factory, Library → Footage, old Factory → Studio). All product data lives in backend state.

## Follow-up workflow integration

- In Studio, **Produce variants** submits `POST /api/videos/{id}/produce { model_id }` for the selected source. It is enabled only for a known ready runtime and installed selected model. Backend serially transcribes audio (Whisper required when needed), analyzes, and renders up to three variants; output still needs review.
- **Kokoro narration** submits `POST /api/narrations { text }`. Completed `narration` jobs expose audio/download only when `result.download_url` matches a root-relative `/api/narrations/{id}/download` URL; external origins and path traversal are rejected. Audio is not automatically mixed into clips.
- Clip review shows backend `warning` and `subtitles_burned` honestly (missing subtitle status is Unknown). Cover images and downloads use `/api/clips/{id}/cover` and `/api/clips/{id}/cover/download`, with no synthesized overlays.
- Existing `publish_attempt`, `instagram_media_id`, `published_at`, publishing/published/reconciliation statuses block another publish action. The backend must reconcile uncertain external writes; the UI never retries them automatically.
- Meta media metrics are labeled **Media insights**, not Organic: counts may include boosts. `paid` remains separate and unknown when not reported.
- Paid setup requires actual **ads_read** permission and account access. `/api/ads/accounts` is fetched only on user request; `/api/ads/sync { ad_account_id }` queues a real read. Stored `/api/ads/insights` rows refresh only with an explicit button and retain returned source/attribution and raw account/ad identifiers. Stored rows may span accounts; the selected account controls sync only. Rows are never guessed to match clips. None of these endpoints are included in polling.
- Validation-only `/api/ads/preflight` sends `{ clip_id, ad_account_id, destination_url, lifetime_budget_minor, duration_days, name }`. It requires an explicitly enabled ads opt-in, positive total settings budget, an accessible USD account, and a published Reel with `instagram_account_id` matching the connected account's `account.id`. Missing ownership is not assumed. Lifetime budget is whole **USD cents** (100 = $1.00), while settings budgets are **USD**, and preflight cannot exceed the configured total.
- Preflight returns a job with a validation result (`can_create: false`). This UI has no ad creation or activation flow and performs no spend. Campaigns must be managed in Meta Ads Manager. Additional endpoints not yet present in a backend produce visible errors rather than simulated success.

## Test coverage

Vitest / Testing Library cover API cookie behavior, multipart uploads, real error messages, invalid/HTML responses, resource retry and polling, nullable metrics, manual provenance, license consent, render ranges/payloads, approval/caption editing, publish gating, token clearing, read-only capabilities, and the rendering error boundary. Tests stub requests only inside test files; production has no mock API or fixtures.

Real media/model execution and Meta end-to-end verification require the backend and are intentionally not simulated here.

## Native team mode integration

The exact team contract is `docs/team-mode.md`; this frontend adds no team engine.

- Settings accept `production_strategy: "team" | "baseline"`. The field is optional in TypeScript for old fixtures/responses; the UI and backend default to team. Saving settings includes the deliberate strategy choice. **Produce variants (strategy)** retains `/produce {model_id}` and its Job response.
- **Start team run** calls `/api/videos/{id}/team {model_id, revision_budget}` (default 2; selectable 0–2), returning `{job, run}`. **Run comparative baseline** always calls `/api/videos/{id}/baseline {model_id}` and returns Job. Backend must reject conflicting active source work.
- Studio loads `/api/team/runs` and polls every four seconds while mounted, independently of other resources. Source/run selectors expose plan, role/tool tasks, evidence references, validated artifacts, critic checks/findings, revision history, stop reason, timing and resource snapshots. Outputs are bounded React text/data, not executable HTML or hidden reasoning.
- `/api/team/runs/{id}/cancel` is a request, not a promise of instant cancellation. Duplicate clicks are locked while requesting and after acceptance. Returned state is displayed, then reloaded and polled; completed local outputs remain available. Last successful ledger data is visibly stale after failure; cancellation stays disabled until a fresh read.
- Comparisons load only on explicit request from `/api/team/comparisons?video_id=...`. Each run’s `/api/team/runs/{id}` supplies its source/config context snapshot (not included in the comparison summary contract). Missing snapshots are explicitly unavailable; backend comparability flags are not invented or overridden. Timings, model/memory/resource observations, outcomes, feedback and notes remain observations, not evidence of causal performance lift. Refresh failure retains clearly stale data; switching source clears the comparison.
- In the Studio card, clips with `team_run_id` require `team_review_status: "pass"` before team approval; missing/unknown/fail status remains blocked there (the Clips page offers the explicit **Approve anyway** override). The explicit baseline marker `not_applicable` allows human approval without team critique. Edited hook/caption drafts on actual team clips must be saved and rechecked before approval; approval is sent separately from content. Existing approval can be removed without submitting unsaved content. Backend must enforce review status, content invalidation, evidence and external authorization gates independently of these controls.
- Older services missing team routes show actionable unavailable states without disabling manual editing or fabricating records. Native Mac inference, worker serialization, durable cancellation/restart semantics, source snapshot matching and release gating still require parent-backend integration and target-Mac acceptance.

### Review-security follow-up

- **Recheck team critique** sends `POST /api/clips/{id}/team-review {}` only on explicit action for saved team content. The backend resolves the persisted run model and validates model installation, eligible finished/cancelled/interrupted ledger state, and source/clip locks. The UI requires a known ready runtime and fresh source/model/clip/queue data, blocks dirty drafts and known active tasks, prevents duplicate clicks, shows returned job progress/errors, and never invents a verdict or auto-approves. Creator feedback drafts remain untouched.
- Changing team hook/caption metadata must set `team_review_status: "unknown"` and `approved: false` server-side. A combined changed-content/approval request must be rejected. The UI sends team approval alone (`{approved:true}`) only for unchanged, freshly reviewed content; baseline/legacy caption-plus-approval remains compatible.
- Public Video responses should expose `has_audio` (boolean). Known audio sources without a stored transcript need installed `whisper-turbo` before production. Silent or already-transcribed sources do not. An omitted/null audio flag shows **Audio prerequisites checked by backend**, not a fabricated blocked/ready audio verdict. Empty transcript objects/arrays are treated as absent, matching backend truthiness.
- Analyze requires fresh source/model/system/queue data, `model_runtime:true`, an installed selected analysis model and no active source-bound job. Production adds strategy freshness and the Whisper preflight. `Job.context` is optional/untrusted; source locks read only a string `context.video_id` from an object for queued/running jobs, never from result payloads. All source-bound kinds match the backend lock, while model-only downloads and jobs for other sources do not block this source.
