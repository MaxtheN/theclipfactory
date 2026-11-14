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

## Integration expectations

- The root `API_CONTRACT.md` defines exact routes and payload fields. GET lists return arrays; DELETE can return JSON or HTTP 204.
- Initial load requests system, settings, models, jobs, videos, clips, Instagram status, and analytics independently. Failure of one resource does not hide all the others.
- Jobs, videos, clips, models, Instagram status, and analytics refresh every four seconds while visible. System/settings refresh at boot, on explicit refresh, and after mutations, so background polling does not erase settings edits.
- Source `analysis` supports a candidates array or `{ candidates: [...] }`; serialized JSON is also supported. Persist analysis on the source so it remains associated with the correct video. A completed analyze job with `result.video_id` and candidates is also supported. Inference output is read from `result.output`.
- Uploads use multipart `file`. Manual render payload is `{ start, end, hook, caption, objective, subtitles: true, format: "vertical" }`. Transcribe before rendering to provide spoken subtitle text.
- Publishing needs a strictly approved clip, explicit `publishing_enabled`, `connected: true`, and `publishing_available: true`, plus a public HTTPS URL. Backend must revalidate approval, permissions, account, asset hosting/security, and actual Meta success. Queuing is not reported as publishing success. Hosting is not provided by this UI.
- Tokens exist only in Instagram component state, are cleared at submission/navigation, and never reach local/session storage. Backend handles OS keychain storage; API responses must not expose credentials.
- Missing/null/nonnumeric metrics display **Unknown**, while an observed `0` stays `0`. Manual events always carry `source: "manual"`, omit blank optional numeric fields, and never claim causal attribution. Custom events use the settings-defined `custom_event` convention.
- Autonomy values are passed to the backend for validation. Review is the default; automatic local production never overrides clip approval or publishing gates. Ads settings do not create campaigns.
- The only browser persistence is `clip-factory-tab`, a navigation preference. All product data lives in backend state.

## Follow-up workflow integration

- **Produce variants** submits `POST /api/videos/{id}/produce { model_id }` for the selected source. It is enabled only for a known ready runtime and installed selected model. Backend serially transcribes audio (Whisper required when needed), analyzes, and renders up to three variants; output still needs review.
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
- Factory loads `/api/team/runs` and polls every four seconds while mounted, independently of other resources. Source/run selectors expose plan, role/tool tasks, evidence references, validated artifacts, critic checks/findings, revision history, stop reason, timing and resource snapshots. Outputs are bounded React text/data, not executable HTML or hidden reasoning.
- `/api/team/runs/{id}/cancel` is a request, not a promise of instant cancellation. Duplicate clicks are locked while requesting and after acceptance. Returned state is displayed, then reloaded and polled; completed local outputs remain available. Last successful ledger data is visibly stale after failure; cancellation stays disabled until a fresh read.
- Comparisons load only on explicit request from `/api/team/comparisons?video_id=...`. Each run’s `/api/team/runs/{id}` supplies its source/config context snapshot (not included in the comparison summary contract). Missing snapshots are explicitly unavailable; backend comparability flags are not invented or overridden. Timings, model/memory/resource observations, outcomes, feedback and notes remain observations, not evidence of causal performance lift. Refresh failure retains clearly stale data; switching source clears the comparison.
- Clips with `team_run_id` cannot gain approval unless `team_review_status` is exactly `pass`; missing/unknown/fail status remains blocked. Existing approval can always be removed. Critic pass still needs human approval. Backend must enforce review status, evidence and external authorization gates independently of these controls.
- Older services missing team routes show actionable unavailable states without disabling manual editing or fabricating records. Native Mac inference, worker serialization, durable cancellation/restart semantics, source snapshot matching and release gating still require parent-backend integration and target-Mac acceptance.
