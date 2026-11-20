# Outstanding work (2026-11-20)

What isn't yet built, merged, proven or closed as of `master` `327ec43`. Each section is in
priority order. Work order links go to the
[Growth Factory Software Factory project](https://factory.8090.ai/project/2791013e-0f01-4b6b-a530-854ffd4e0319).

## 1. Open work orders

### [WO-24](https://factory.8090.ai/project/2791013e-0f01-4b6b-a530-854ffd4e0319/work-orders/24): Connect accounts and post to several platforms from the app (In Progress, high)

The engine and the posting server are done (WO-22, WO-23). **None of the WO-24 frontend is on
`master` yet.** The app still shows the Instagram-only Composio connect flow
(`ConnectInstagram.tsx`, `FirstRunInstagram.tsx`) and the manual "Track a post" path in
`Results.tsx`.

To build:

- **Settings, connected accounts:** list the supported platforms with Connect (opens the hosted
  connect page), connection status and Disconnect. This replaces the Composio flow.
- **Post dialog on an approved clip:**
  - target accounts;
  - a caption per platform, within that platform's limit;
  - Post now or Schedule;
  - an optional YouTube title.
- **TikTok step:** show the clip preview, the privacy levels this creator may use and the consent
  statement. Posting stays blocked until the creator confirms.
- **Outcomes:** per-platform results in the clip view and the Activity Center, with links to the
  live post and Check status for uncertain attempts.
- **Permission:** posting stays off until publishing permission is on for that account.
- **Tests:** Vitest coverage and review-preview fixtures for the new endpoints.

Engine routes to use (`clip_factory/publish_api.py`):

- `GET /api/posting/accounts`, `POST /api/posting/accounts/sync`
- `POST /api/posting/connect`, `GET /api/posting/connect/{request_id}`
- `PUT /api/posting/accounts/{id}/binding`, `PUT /api/posting/accounts/{id}/permission`,
  `DELETE /api/posting/accounts/{id}`
- `GET /api/posting/accounts/{id}/tiktok-creator-info`
- `/api/publish-attempts`: list, read, `reconcile`, `resume`

Contracts: [instagram-publishing.md](../instagram-publishing.md) and
[posting-server.md](../posting-server.md).

### [WO-19](https://factory.8090.ai/project/2791013e-0f01-4b6b-a530-854ffd4e0319/work-orders/19): Consolidate design tokens and retire CSS override layers (In Progress, medium)

PR #19 created the single token source; `material-tokens.css` and `operational-glass.css` are gone.
Still to do:

- Fold in or retire `desktop-glass`, `polish`, `pearl-studio`, `shell-polish`, `website-alignment`,
  `identity`, `interactions` and `workspace-motion`. All eight are still in `frontend/src/growth/`
  (43 CSS files in total).
- Remove the two decorative `infinite` animations left in `factory-map.css`. Keep status motion,
  with reduced-motion handling.
- Work in small, reviewable steps. Add no new override sheet, and keep every Vitest suite passing.

### [WO-33](https://factory.8090.ai/project/2791013e-0f01-4b6b-a530-854ffd4e0319/work-orders/33): User guide and first-run tutorial (Backlog, medium)

Not started. Scope:

- A user guide in `docs/guide/` with one page per area.
- Restore the explanations trimmed from the UI: the team ledger, what is sent to AI providers,
  clip evidence, the limits of Results and the Strategist, references, factory upgrades,
  transcripts, privacy and posting recovery.
- A first-run tutorial outline of 5–7 steps.
- A Help entry in ⌘K and in the sidebar footer.

No requirements document covers user documentation yet.

### [WO-2](https://factory.8090.ai/project/2791013e-0f01-4b6b-a530-854ffd4e0319/work-orders/2): Workflow orchestration and saved state (Backlog, high, Nur)

The hackathon-era orchestration lane from 2026-11-14. Much of its scope has since landed through
other work: saved campaigns, strategy versions, durable jobs, observations and approvals. Re-scope it
against the current code, or close it.

## 2. Unmerged code

| Branch | State | What it does | Next step |
| --- | --- | --- | --- |
| `8090/chat-faster-transcribe-scout-k7m2q9` | No PR, 3 commits (2026-11-20), 13 files, +816/−160 | Batched faster-whisper with sentence lines on Windows and Linux; one model load per scout run with a prompt Ollama can reuse; `scripts/bench-speech.py` | Review, reconcile, run pytest, merge |
| `8090/chat-polish-landing-page-e03414` | PR #10 closed | Landing-page polish from 2026-11-14 | Keep anything still wanted, then delete |
| `feature/code-cut-off-desing-improvements` | PR #11 closed | UI copy cuts and Factory-map selection changes from 2026-11-14, probably superseded by later redesigns | Confirm it's superseded, then delete |

These branches are already merged and can be deleted from origin:
`8090/chat-switch-supabase-project-k2w9f4`, `8090/chat-ui-render-performance-p3f9k2` (PR #34),
`8090/wo-22-zernio-posting-server-t5j8n2` and `8090/wo-23-zernio-engine-adapter-p6w3c8`.

## 3. Built but not yet proven live

1. **First real post through the app.** This has never been done. Approve one clip, post it through
   the posting server and watch the attempt states. If the outcome is uncertain, reconcile with
   Check status instead of retrying. This needs the WO-24 UI or a direct call to the engine API.
2. **A fresh clip that passes editorial review**, made by the current engine with speech intact.
   Watch and listen for meaning, captions, hook, framing and audio. A high rank is not acceptance;
   see [engine-eval.md](../engine-eval.md).
3. **A real measure → learn → re-cut cycle** on real observations, end to end. Only the labelled
   demo and the simulation have run so far.
4. **Clean-machine installs** of the Windows installer, the Linux AppImage and the Mac artifact.
   Also run `desktop-apps.yml` and `mac-app.yml` on current `master`; the Mac artifact was last
   built on 2026-11-14.

## 4. Not started

- **Strategist timing:** posting windows use the UTC hour of a post (`strategist.py`). They should
  use the creator's time zone.
- **Strategist variables:** cover source, caption length, hashtag count and CTA were listed as
  follow-ups on 2026-11-14. None of them appears in `strategist.py`, which varies hook style and
  posting window.
- **Always-on hosted workers:** schedules and metric collection only run while the app is open.
- **State sync and team access:** operational records exist only in local SQLite. There is no
  owner-scoped sync and no team membership.
- **Signed releases:** Windows code signing, Mac notarization and single-instance coordination.
- **Wider scope:** more channels, controlled paid experiments and ROAS. No ad spending is
  authorized.
- **Clip quality (score 70 → 90):** a head-editor second pass, laughter and crosstalk signals,
  diarization, filler trimming, punch-ins on punchlines and a 30-moment human benchmark.
- **Optional:** Groq as a provider for text agents. Today it is wired only for opt-in speech.

## 5. Software Factory bookkeeping

- **Close or verify work orders whose code has merged:**
  - WO-9 and WO-10 have been In Progress since 2026-11-14, but both are implemented on `master`:
    `channelSettings.test.tsx`, and the archive and restore endpoints in `campaign_api.py` with
    `tests/test_campaign_archive.py`. Their `.sw-factory/WO-9` and `WO-10` checklists mark
    implementation complete.
  - WO-1 and WO-3 to WO-8 are hackathon builds from 2026-11-14; PRs #1–#9 merged that day. They
    are still In Review.
  - WO-11, WO-12 and WO-13 are the Phase 1–2 artifacts (navigation map, App Shell blueprint,
    design system and prototype). They are still In Review.
- **Blueprints:** Results and Strategy Learning has 13 pending suggested edits from 2026-11-14 and
  a drift note against an old `master` (`632f890`). Accept or reject them, then re-run code
  analysis. Campaign Workspace and Strategy and Precedent Research have two pending suggestions
  each.
- **Requirements:**
  - the Requirements overview has five open threads;
  - Success Metrics has six open review comments;
  - Product Description, Campaign Workspace and Strategy, and Results and Strategy Learning each
    have one pending suggestion.

## 6. Out-of-date docs

- `README.md`:
  - The Publication row still describes the Composio Instagram flow; posting now goes through
    Zernio.
  - The sidebar line still says Factory, Library, Results and Brand profile, with Engine & models
    under Brand profile. Settings and the Activity Center now exist.
- `docs/finish-line.md` and `docs/product-roadmap.md` date from 2026-11-14.
- `docs/HANDOFF.md`: §1–2 and §5–8 describe Kartik's Mac and the 2026-11-14 wave.
- `docs/interface-architecture.md`: the visual-system section still describes the earlier
  copper glass palette and `operational-glass.css`.
