# Growth Factory handoff packet

Snapshot of `master` at `9a0d4ae` (the merge of PR #48), 2026-11-20. Start at [AGENTS.md](../../AGENTS.md) for setup,
checks and conventions.

| File | What it covers |
| --- | --- |
| This page | What the product is, what works, how it is built, where the code is, live state |
| [outstanding-work.md](outstanding-work.md) | Everything not yet built, merged, proven or closed, in priority order |
| [launch-checklist.md](launch-checklist.md) | Owner-only steps to start selling: accounts, secrets, deploys, legal, first post |
| [../architecture.md](../architecture.md) | System context, containers, posting, learning loop and billing diagrams |

[../HANDOFF.md](../HANDOFF.md) is the 2026-11-14 hackathon handoff for Kartik's Mac. Its status is out of date, but
it still has Keychain service names (§3), test-data folders (§2) and the 2026-11-14 live test results (§5).

## The business

A self-serve desktop subscription. The app is free to start; paid plans are bought in the app through Stripe Checkout.

| Plan | Price | Limits |
|---|---|---|
| Free | $0 | 1 brand, 20 clips a month, export only (no posting) |
| Pro | $24 a month, or $19 a month billed yearly | 3 brands, unlimited clips, posting, 3 connected accounts |
| Business | $200 a month, or $160 a month billed yearly | 15 brands, unlimited clips, posting, 30 connected accounts, factory builder |

The catalog is `supabase/functions/_shared/plans.ts`, mirrored in `clip_factory/billing.py` and
`landing-page/plans.json`; see [billing.md](../billing.md). The repo is public under the MIT license.

## Health at this snapshot

- **CI** (`ci.yml`: test on Ubuntu, macOS and Windows, plus posting-server and website) passed on `9a0d4ae`. The full
  local pytest run passed: 1874 passed, 3 skipped, with `test_faces.py` deselected.
- **Desktop builds:**
  - `desktop-apps.yml` (Windows installer, Linux AppImage; unsigned) last passed on 2026-11-20 on a WO-39 branch.
  - `mac-app.yml` last ran on 2026-11-14.
  - The only GitHub release is `v0.1.0-preview` (Mac, 2026-11-14). It predates billing and multi-platform posting
    and is not linked from the website.
- **Live:**
  - The Supabase project `spdtisizhcepmsogjvnr` has Auth, the Growth Factory tables and the `posting` function. Its
    deployed version predates billing.
  - The billing migration and the `billing` function are **not deployed**, and Stripe is not set up. See
    [launch-checklist.md](launch-checklist.md).
- **No real post has been made through the app yet.**
- **Not deployed:** the website rebuild (PR #48) is merged but not yet on Vercel.

## What the product does

Brand brief and footage in → ranked, on-brand, captioned 9:16 clips → human approval → post → measure → learn →
better next clips. A second loop, the factory builder, turns a missing editing capability into a work order, a
generated renderer extension with tests, and a change for human review.

## What works on `master`

| Area | State | Main code |
| --- | --- | --- |
| App shell | Sidebar: Factory, Library, Results, Brand profile, Settings. Studio for clip review. The Activity Center lists jobs, posts and failures. ⌘K / Ctrl+K quick actions. Help opens the user guide. Wording is correct for each platform. Idle screens stay dormant. | `frontend/src/growth/GrowthApp.tsx`, `ActivityCenter.tsx`, `Help.tsx` |
| Onboarding and brand | Website-assisted brand brief (fields quote the site; inferred suggestions are opt-in), goals, clip style (approves the first Style rules), and email-and-password sign-in or offline use. One campaign per brand by default; archive and restore. | `brand_research.py`, `campaigns.py`, `cloud.py`, `frontend/src/growth/Setup.tsx` |
| Settings | Device, models, speech, accounts, and plan and billing. | `SettingsScreen.tsx`, `EngineSetup.tsx`, `AgentSetup.tsx`, `SpeechSetup.tsx`, `PlanBilling.tsx` |
| Speech | MLX Whisper on Apple Silicon. faster-whisper on Windows and Linux x64, one window at a time. Opt-in Groq cloud speech. Production is blocked, with one-click setup, when speech assets are missing. | `speech.py`, `speech_backend.py`, `cloud_speech.py` |
| Agents and models | Each role routes to local Ollama (qwen3-vl:4b) or OpenRouter. A hardware check runs on Windows and Linux. | `llm_provider.py`, `ollama.py`, `local_agents.py` |
| Clip engine | Storyboard, a scout swarm (or an optional team "Deep edit"), sentence-aware moments, best-first ranking with "Below the bar", critic and quality gate. See [engine.md](../engine.md). | `storyboard.py`, `scouts.py`, `team.py`, `moments.py`, `ranking.py`, `quality.py` |
| Craft and render | Hook-first teaser, title card, keyword-emphasis captions, jump cuts, −14 LUFS, cover, CTA end card, brand kit, A/B variants. Face-follow 9:16 crop: Apple Vision on macOS; YuNet or MediaPipe on Windows and Linux. | `craft.py`, `media.py`, `reframe.py`, `faces.py` |
| Review and Library | Exact-version playback, quality evidence, revisions and approval. Approve, export and post are separate actions. Bulk delete only reaches clips that are shown and counted. | `Studio.tsx`, `PostPreview.tsx` |
| Posting | Connected accounts in Settings, and a post dialog on approved clips with per-platform captions, now or scheduled. Covers TikTok (consent and creator options), Instagram, YouTube, Facebook, LinkedIn, X and Threads, through the posting server and Zernio. Durable attempts with idempotency keys; uncertain outcomes are reconciled by external id. Scheduling needs the app open. Unreported metrics are "unavailable", never 0. | `ConnectedAccounts.tsx`, `PostClip.tsx`; `posting_server.py`, `posting_accounts.py`, `publisher.py`, `post_schedule.py`, `publish_api.py` |
| Posting server | Supabase Edge Function `posting`. It holds the Zernio key, maps each workspace to one Zernio profile, enforces ownership and (in the new version) the plan. See [posting-server.md](../posting-server.md). | `supabase/functions/posting/` |
| Plans and billing | The `billing` Edge Function handles Checkout, the customer portal, signed webhooks and entitlements. The engine caches the plan for up to 7 days offline and applies limits (brands, clips per month, posting, accounts, builder). The app shows the plan, usage, upgrade prompts and Manage billing, and re-checks on focus after Checkout. See [billing.md](../billing.md). | `supabase/functions/billing/`, `clip_factory/billing.py`, `PlanBilling.tsx`, `billingApi.ts` |
| Results and learning | Real observations by default; Demo Mode is opt-in and labelled. 3- and 6-day windows, proposed rules, review-taste preferences, one-variable re-cuts, and a Strategist (posting windows in the creator's time zone) with a Simulation mode. See [learning-loop.md](../learning-loop.md) and [strategist.md](../strategist.md). | `learning.py`, `growth_loop.py`, `strategist.py`, `GrowthLoopPanel.tsx` |
| Factory builder | Capability gap → work order → sandboxed extension and tests in a temporary worktree → human review → draft PR. Sandboxed on Linux; reduced isolation is labelled on Windows. See [factory-builder.md](../factory-builder.md). | `capabilities.py`, `factory_builder.py` |
| User guide | 15 pages in `docs/guide/`, opened from Help in the app (an allowlisted local route) and published on the website. | `docs/guide/`, `help_api.py`, `guideLinks.ts` |
| Website | Static site: home, product, learning, pricing (generated from `plans.json`), download and setup, docs (generated from `docs/guide/`), architecture diagrams, privacy, terms, the Stripe return pages, 404 and sitemap. See [landing-page/README.md](../../landing-page/README.md). | `landing-page/` |
| Platforms and packaging | macOS on Apple Silicon (Intel uses cloud speech), Windows 10/11 x64, Linux x64. Unsigned Windows installer and Linux AppImage; an ad-hoc-signed Mac artifact. | `packaging/`, `scripts/build-desktop-app.py`, `scripts/build-mac-app.sh` |

## How it is built

```text
pywebview window (clip_factory/app.py, main.py)
  └─ React + TypeScript UI (frontend/, one bundled page)
      └─ FastAPI on 127.0.0.1 with a per-launch session (clip_factory/*_api.py)
          ├─ SQLite + local media (store.py, files.py); keys in the OS key store
          ├─ durable job queue (jobs.py, inference_worker.py) → speech, agents, FFmpeg
          ├─ Growth Factory cloud (Supabase): Auth, `posting` → Zernio → 7 platforms, `billing` ↔ Stripe
          └─ builder worktree (factory_builder.py) → checks, sample render, human review
```

- **Local state:** operational records stay in local SQLite and nothing syncs. The cloud stores only accounts,
  workspace-to-Zernio mappings, post ids and statuses, webhook events and subscriptions. See
  [cloud-state.md](../cloud-state.md).
- **Cloud location:** the app reads it from `clip_factory/cloud_config.json`. Override it with `CLIP_SUPABASE_URL` and
  `CLIP_SUPABASE_PUBLISHABLE_KEY`.
- **More detail:** the API is in [API_CONTRACT.md](../../API_CONTRACT.md) and the UI structure in
  [interface-architecture.md](../interface-architecture.md). Diagrams are in [architecture.md](../architecture.md).

## Code map

| Path | Contents |
| --- | --- |
| `clip_factory/` | Python engine, API and desktop shell |
| `frontend/src/growth/` | React screens, styles (47 CSS files) and Vitest suites |
| `supabase/migrations/` | `202611140001_growth_factory`, `…0002_publish_bucket`, `…0003_publish_bucket_covers`, `202611200001_posting_server`, `202611210001_billing` |
| `supabase/functions/` | `posting/`, `billing/` and `_shared/` (plans, auth) Edge Functions, with Deno tests |
| `supabase/tests/` | Row-level security probes: `growth_factory_rls.sql`, `posting_server_rls.sql`, `billing_rls.sql` |
| `tests/`, `scripts/tests/` | pytest suites |
| `scripts/` | Per-OS setup, desktop builds, smoke tests, speech benchmark |
| `packaging/` | PyInstaller spec, icons, Windows and Linux packaging |
| `landing-page/` | Website: hand pages, `site/` sources, `build.mjs`, generated output, tests |
| `docs/` | Topic docs; `docs/guide/` is the user guide; `docs/submission/` is from the hackathon |
| `.sw-factory/` | Execution notes from earlier work orders |
| `.github/workflows/` | `ci.yml` (every push), `desktop-apps.yml` (tags and packaging changes), `mac-app.yml` (manual) |

## Specs

The [Software Factory project](https://factory.8090.ai/project/2791013e-0f01-4b6b-a530-854ffd4e0319) holds:
- the requirements: App Shell and Navigation, Clip Production and Review, Campaign Workspace and Strategy, Results and
  Strategy Learning, Plans and Billing, Precedent Research;
- their blueprints, plus Posting Server;
- 39 work orders.

Work orders WO-14 to WO-37 and WO-39 are Completed. What remains is in
[outstanding-work.md](outstanding-work.md).

## Secrets and accounts

- **Desktop credentials** are in the OS key store: macOS Keychain, Windows Credential Manager, or Secret Service on
  Linux. Service names are in [HANDOFF.md](../HANDOFF.md) §3. Never print them.
- **Function secrets:**
  - `posting`: `ZERNIO_API_KEY` and `ZERNIO_WEBHOOK_SECRET`;
  - `billing`: `STRIPE_*` and `BILLING_RETURN_URL`.
  
  They are set in Supabase and never in the repo.
- **The app** bundles only the publishable Supabase key.
