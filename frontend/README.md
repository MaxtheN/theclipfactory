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

## Test coverage

Vitest / Testing Library cover API cookie behavior, multipart uploads, real error messages, invalid/HTML responses, resource retry and polling, nullable metrics, manual provenance, license consent, render ranges/payloads, approval/caption editing, publish gating, token clearing, read-only capabilities, and the rendering error boundary. Tests stub requests only inside test files; production has no mock API or fixtures.

Real media/model execution and Meta end-to-end verification require the backend and are intentionally not simulated here.
