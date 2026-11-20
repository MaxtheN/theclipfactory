# Growth Factory handoff packet (2026-11-20)

Snapshot of `master` at `df50d43` (the merge of PR #37, WO-23), 2026-11-20.

| File | What it covers |
| --- | --- |
| This page | What the app is, what works today, where the code lives, how to run and verify it |
| [outstanding-work.md](outstanding-work.md) | Everything not yet built, merged, proven or closed, in priority order |

This packet replaces the status sections of [../HANDOFF.md](../HANDOFF.md), which was written on
2026-11-14 for Kartik's Mac. That file still has useful local detail: Keychain service names (§3),
test-data folders (§2) and the 2026-11-14 live test results (§5).

## Health at this snapshot

- CI (`Test local MVP`, `.github/workflows/ci.yml`, on Windows, Linux and macOS) is green on `df50d43`.
- The Windows and Linux desktop build (`desktop-apps.yml`) last passed on 2026-11-20. The Mac
  artifact build (`mac-app.yml`) last ran on 2026-11-14.
- Tests: pytest under `tests/` and `scripts/tests/`; 52 Vitest files under `frontend/src/`.
- Open code: PR #34 and one branch without a PR. See
  [outstanding-work.md §2](outstanding-work.md#2-unmerged-code).
- **No real post has been made through the app yet.** This is the biggest open gate.

## What the product does

Brand brief and footage in → ranked, on-brand, captioned 9:16 clips → human approval → post →
measure → learn → better next clips. A second loop, the factory builder, turns a missing editing
capability into a work order, a generated renderer extension with tests, and a change for human
review.

## What works today

| Area | State on `master` | Main code |
| --- | --- | --- |
| App shell | Sidebar: Factory, Library, Results, Brand profile, Settings. Studio for clip review. Activity Center for jobs, posts and failures (WO-17). ⌘K / Ctrl+K quick actions. Library filters and unsaved drafts survive navigation (WO-18). Platform-correct wording from `/api/system` (WO-32). Dark graphite and violet theme. | `frontend/src/growth/GrowthApp.tsx`, `ActivityCenter.tsx` |
| Onboarding and brand | Website-assisted brand brief (OpenRouter Haiku; fields quote the site, inferred suggestions are opt-in), goals, clip style (approves the first Style rules), Supabase email and password sign-in or offline use. Campaigns are hidden by default (one "<Brand> — main"); archive and restore exist. | `brand_research.py`, `campaigns.py`, `campaign_api.py`, `cloud.py`, `frontend/src/growth/Setup.tsx` |
| Settings | Device, models and accounts moved out of Brand profile (WO-16). Engine reports its installed version (WO-21). | `frontend/src/growth/SettingsScreen.tsx`, `EngineSetup.tsx`, `AgentSetup.tsx`, `SpeechSetup.tsx` |
| Speech | MLX Whisper large-v3-turbo on macOS; faster-whisper on Windows and Linux x64 (WO-25); opt-in Groq Whisper cloud speech. Production is blocked when speech assets are missing or damaged, with one-click setup. | `speech.py`, `speech_backend.py`, `cloud_speech.py` |
| Agents and models | Per-role routing between local Ollama (qwen3-vl:4b) and OpenRouter. Ollama on Windows and Linux with a hardware check (WO-26). | `llm_provider.py`, `ollama.py`, `local_agents.py` |
| Clip engine | Storyboard (scene detection and vision descriptions), scout swarm by default with an optional team "Deep edit", sentence-aware moments, best-first ranking with "Below the bar", critic and quality gate. See [engine.md](../engine.md). | `storyboard.py`, `scouts.py`, `team.py`, `moments.py`, `ranking.py`, `quality.py` |
| Craft and render | Hook-first payoff teaser, title card placed off faces, keyword-emphasis captions, jump cuts, −14 LUFS, smart cover, CTA end card, brand kit, A/B variants, face-follow 9:16 crop (Apple Vision on macOS; OpenCV YuNet and MediaPipe on Windows and Linux, WO-27). | `craft.py`, `media.py`, `reframe.py`, `faces.py` |
| Review and Library | Exact-version playback, quality evidence, revisions and approval. Approve, export and post are separate actions (WO-20). Bulk delete only reaches shown, counted clips (WO-15). | `frontend/src/growth/Studio.tsx`, `PostPreview.tsx` |
| Posting (engine) | Posts through the posting server to Instagram, TikTok, YouTube, Facebook, LinkedIn, X and Threads (WO-23). Durable attempts with a fixed idempotency key; uncertain outcomes are reconciled by external id, never blind-retried. Cover picker, per-platform caption limits, TikTok consent and creator options, scheduling (the app must be open), multi-account, per-account posting permission and a global "publishing enabled" switch. Metrics come from the server's analytics; unreported metrics are unavailable, never zero. **The UI is still the Instagram-only Composio flow (WO-24).** | `posting_server.py`, `posting_accounts.py`, `publisher.py`, `post_package.py`, `post_schedule.py`, `publish_api.py` |
| Posting server | Supabase Edge Function `posting` on project `spdtisizhcepmsogjvnr`. Holds the Zernio key, maps each workspace to one Zernio profile, enforces ownership on the server (WO-22). See [posting-server.md](../posting-server.md). | `supabase/functions/posting/`, `supabase/migrations/` |
| Results and learning | Real observations by default; Demo Mode is opt-in and labelled (WO-14). Learning loop with 3- and 6-day windows, memory digest and proposed rules. Review-taste preferences, one-variable re-cuts and an opt-in auto A/B policy for the top 3 picks. Strategist with deterministic confidence, explore/exploit and Simulation mode. Loop panel and a one-button learning-loop demo. See [learning-loop.md](../learning-loop.md), [strategist.md](../strategist.md), [closed-loop-demo.md](../closed-loop-demo.md). | `learning.py`, `growth_loop.py`, `strategist.py`, `frontend/src/growth/GrowthLoopPanel.tsx` |
| Factory builder | Capability gap → work order → builder agent writes a sandboxed renderer extension and tests in a temporary worktree → human review → draft PR. Sandboxed on Linux; reduced isolation is labelled on Windows (WO-29). See [factory-builder.md](../factory-builder.md). | `capabilities.py`, `factory_builder.py` |
| Platforms and packaging | macOS (Apple Silicon), Windows 10/11 x64, Linux x64. Jobs, FFmpeg, caption fonts, key storage and startup errors work on all three (WO-28). Unsigned Windows installer and Linux AppImage (WO-31); ad-hoc-signed, unnotarized Mac artifact. | `packaging/`, `scripts/build-desktop-app.py`, `scripts/build-mac-app.sh` |
| Cloud | Supabase project `spdtisizhcepmsogjvnr` (moved on 2026-11-19): Auth, migrations and the posting server. Operational records stay in local SQLite; nothing syncs. See [cloud-state.md](../cloud-state.md). | `cloud.py`, `cloud_api.py`, `supabase/` |
| Landing page | Static marketing site deployed on Vercel. | `landing-page/` |

## Architecture

```text
pywebview desktop shell (clip_factory/app.py, main.py)
  └─ React + TypeScript UI (frontend/, single-file Vite bundle)
      └─ loopback FastAPI with bootstrap auth (clip_factory/*_api.py, app.py)
          ├─ SQLite + local media (store.py, files.py)
          ├─ durable jobs (jobs.py, inference_worker.py) → speech, agents, FFmpeg render
          ├─ posting server (Supabase Edge Function) → Zernio → social platforms
          └─ builder worktree (factory_builder.py) → checks, sample render, human review
```

The API is described in [API_CONTRACT.md](../../API_CONTRACT.md) and the UI structure in
[interface-architecture.md](../interface-architecture.md).

## Code map

| Path | Contents |
| --- | --- |
| `clip_factory/` | Python engine, API and desktop shell |
| `frontend/src/growth/` | React screens, styles and Vitest suites |
| `supabase/` | Migrations, the `posting` Edge Function and RLS probes |
| `tests/`, `scripts/tests/` | pytest suites |
| `scripts/` | Setup per OS, desktop builds, smoke tests, FFmpeg fetch |
| `packaging/` | PyInstaller spec, icons, Windows and Linux packaging |
| `landing-page/` | Marketing site |
| `docs/` | Topic docs (engine, publishing, learning, cloud, setup) and `docs/submission/` |
| `.sw-factory/` | Execution notes from earlier work orders |

## Run it

```sh
bash scripts/setup-mac.sh        # or: bash scripts/setup-linux.sh
.venv/bin/clip-factory
```

On Windows: `powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1`, then
`.venv\Scripts\clip-factory.exe`. On first launch, the in-app engine setup installs the speech
runtime and models. Full setup: [development.md](../development.md) and
[local-model-setup.md](../local-model-setup.md).

To run the UI with sample data and no engine:

```sh
cd frontend && VITE_REVIEW_PREVIEW=true npx vite --host 127.0.0.1 --port 5179 --strictPort
```

Add `?fixtures=flow` to the URL for Factory-map sample data.

## Verify

```sh
python -m pytest tests scripts/tests -q
python -m ruff check clip_factory scripts
cd frontend && npx tsc --noEmit -p . && npx vitest run && npm run build
```

Passing checks don't replace watching a real render, verifying an account or making a real post.

## Secrets and accounts

- Desktop credentials are in the OS key store: macOS Keychain, Windows Credential Manager, or
  Secret Service on Linux. Service names are in [HANDOFF.md](../HANDOFF.md) §3. Never print them.
- The Zernio key exists only in the `posting` function's Supabase secrets. The app bundles only
  the publishable Supabase key (`clip_factory/cloud_config.json`). Never ship a service key.

## Working conventions

- Branches: `8090/<wo-N or chat>-<slug>-<6 characters>`. Commit titles: `Area: description`.
- Project rule (the "Merge to Master" skill in the Software Factory project, added 2026-11-20):
  once checks pass, finished work is reconciled with `master` and merged straight in. No pull
  requests. Earlier work went through PRs.
- Requirements, blueprints and work orders are in the
  [Growth Factory Software Factory project](https://factory.8090.ai/project/2791013e-0f01-4b6b-a530-854ffd4e0319).
