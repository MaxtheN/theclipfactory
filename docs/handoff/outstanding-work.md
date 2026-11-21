# Outstanding work

What isn't yet built, merged, proven or closed as of `master` `9a0d4ae` (2026-11-20). Sections are in priority
order. Work order links go to the
[Growth Factory Software Factory project](https://factory.8090.ai/project/2791013e-0f01-4b6b-a530-854ffd4e0319).

## 1. To start selling

The product is built; these are what stand between `master` and paying customers.

1. **Owner setup.** Stripe, the billing migration, function deploys, Zernio, Vercel, certificates and legal review are
   the owner's. [launch-checklist.md](launch-checklist.md) lists them in order.
2. **Signed installers:**
   [WO-38](https://factory.8090.ai/project/2791013e-0f01-4b6b-a530-854ffd4e0319/work-orders/38) (Backlog, high,
   next). Scope:
   - sign and notarize the Mac app and sign the Windows installer in CI, behind secrets, so builds without
     certificates still produce unsigned artifacts;
   - publish a tagged release;
   - then add download links to `landing-page/site/pages/download.html`. The site tests block installer links today,
     so update `tests/pages.test.mjs` to allow exactly the signed release assets.
3. **First release.** Tag `v0.2.0` (or similar) from `master` after WO-38. Install the result on clean Mac, Windows
   and Linux machines, then remove or mark as superseded the `v0.1.0-preview` release, which predates billing and
   multi-platform posting.
4. **End-to-end proof in Stripe test mode,** then live: free → Pro in the app, the webhook, the plan showing without
   a restart, cancelling in the portal, and the limits enforced. See [billing.md](../billing.md#deploy).
5. **The first real post** through the app on a paid plan. Approve one clip, post it and watch the attempt states. If
   the outcome is uncertain, use Check status; never retry blindly.

## 2. Open work orders

- **[WO-38](https://factory.8090.ai/project/2791013e-0f01-4b6b-a530-854ffd4e0319/work-orders/38): Sign and notarize
  desktop releases in CI** (Backlog, high). See §1.
- **[WO-19](https://factory.8090.ai/project/2791013e-0f01-4b6b-a530-854ffd4e0319/work-orders/19): Consolidate design
  tokens and retire CSS override layers** (In Progress, medium). **Paused until after launch** by the owner.
  - The token source exists.
  - Still to fold in or retire, all in `frontend/src/growth/`: `desktop-glass`, `polish`, `pearl-studio`,
    `shell-polish`, `website-alignment`, `identity`, `interactions` and `workspace-motion`.
  - Also remove the two decorative `infinite` animations in `factory-map.css`.
  - Work in small steps, add no new override sheet, and keep Vitest green.
- **[WO-2](https://factory.8090.ai/project/2791013e-0f01-4b6b-a530-854ffd4e0319/work-orders/2): Workflow orchestration
  and saved state** (Backlog, assigned to Nur). This is hackathon scope that later work has mostly delivered (saved
  campaigns, strategy versions, durable jobs, approvals). Re-scope it against the code or close it.
- **Stale statuses to close** (the code is on `master`):
  - WO-9 and WO-10: In Progress, but implemented. See `channelSettings.test.tsx`, the archive and restore routes in
    `campaign_api.py`, and `tests/test_campaign_archive.py`.
  - WO-1 and WO-3 to WO-8: In Review hackathon builds; PRs #1 to #9 merged on 2026-11-14.
  - WO-11, WO-12 and WO-13: In Review Phase 1 and 2 artifacts (navigation map, App Shell blueprint, design system).
  - Several of these are assigned to teammates (James, Nur, Kartik); confirm before closing.

## 3. Open pull requests and branches

| Item | State | Next step |
|---|---|---|
| PR #42 `8090/chat-pro-polish-loop-q7r4m1` | Teammate (jduhking): clearer errors and next steps from a UX review | Theirs to finish; do not push to it |
| PR #47 `8090/chat-results-account-map-r7k2m9` | Teammate (jduhking): Results account map of posted clips | Theirs to finish; do not push to it |
| `8090/chat-batched-transcribe-trial-k7m2q9` | No PR on purpose: batched faster-whisper was 22% faster on CPU but gave 30% fewer sentence ends | Bench with `--batch` on an NVIDIA PC; merge only if sentence ends hold ([local-model-setup.md](../local-model-setup.md#batched-faster-whisper-measured-not-used)) |
| `8090/chat-polish-landing-page-e03414` | PR #10 closed; landing polish from 2026-11-14, superseded by PR #48 | Delete |
| `feature/code-cut-off-desing-improvements` | PR #11 closed; superseded UI copy cuts | Confirm with Kartik, then delete |

Already merged and safe to delete from origin:
- `8090/chat-settings-models-wording-x8c2v5`
- `8090/chat-switch-supabase-project-k2w9f4`
- `8090/wo-22-zernio-posting-server-t5j8n2`
- `8090/wo-23-zernio-engine-adapter-p6w3c8`
- `8090/wo-24-multi-platform-posting-ui-c4x9m2`
- `8090/wo-33-user-guide-g2k7p4`
- `8090/wo-34-stripe-billing-cloud-b7q2x5`
- `8090/wo-35-engine-plan-limits-f3h8k1`
- `8090/wo-36-plan-billing-ui-j5r9t2`
- `8090/wo-37-website-s8v3n6`
- `8090/wo-39-strategist-local-time-w4n7d3`

## 4. Built but not yet proven live

1. **Billing:** the Stripe flow end to end (§1.4). Only the Deno and pytest suites have run.
2. **Posting:** a real post on each platform. The posting server was smoke-tested live on 2026-11-20 without posting.
3. **Clip quality:** a fresh clip that passes editorial review, made by the current engine with speech intact. A high
   rank is not acceptance; see [engine-eval.md](../engine-eval.md).
4. **Learning:** a real measure → learn → re-cut cycle on real observations. Only the labelled demo and the simulation
   have run.
5. **Installs:** clean-machine installs on all three systems, and a run of `mac-app.yml` on current `master`.
6. **Website:** after the Vercel deploy, check clean URLs, the 404 page, the `/billing/*` pages from a real Checkout,
   and the sitemap.

## 5. Not started

- **Cleanup: retire the Composio code.** The app posts through the posting server. The old Composio Instagram routes
  and key handling are still in `clip_factory/autonomy_runtime.py` and `clip_factory/composio.py`, and
  `publisher.py` closes legacy attempts. So do `docs/composio-setup.md`, `docs/meta-setup.md`,
  `docs/instagram-connect.md` and parts of `docs/instagram-publishing.md`. Remove them once no saved data depends on
  them.
- **Always-on hosted workers:** schedules and metric collection run only while the app is open.
- **State sync and team access:** records exist only in local SQLite. There is no owner-scoped sync and no team
  members, even on Business.
- **Single-instance coordination** for the desktop app.
- **Strategist variables:** cover source, caption length, hashtag count and CTA. Today it varies hook style and posting
  window.
- **Clip quality (70 → 90):**
  - a head-editor second pass;
  - laughter and crosstalk signals, and diarization;
  - filler trimming and punch-ins;
  - a 30-moment human benchmark.
- **Local speech on Intel Macs and ARM Windows or Linux:** today these use cloud speech or an imported transcript.
- **Optional:** Groq as a provider for text agents; today it handles speech only. Stripe Tax (see
  [billing.md](../billing.md#set-up-stripe-owner-once)).
- **Out of scope until decided:** more channel types, paid ads and ROAS. No ad spending is authorized.

## 6. Specs and decisions waiting on the owner

- **Pending suggested edits** in the Software Factory, for the owner to accept or reject:
  - Plans and Billing requirements and blueprint;
  - Posting Server blueprint (`e0ac770e`);
  - App Shell and Navigation blueprint (`062e2dcb`): seven Help suggestions;
  - Requirements overview (`7bf11492`) and Clip Production and Review blueprint (`8538463e`);
  - Results and Strategy Learning blueprint: older suggestions and a drift note from 2026-11-14.
  
  After accepting, re-run code analysis.
- **Legal:** `privacy.html` and `terms.html` (sources in `landing-page/site/pages/`) are drafts. The refund wording is
  an assumption.
- **Small product questions left open:**
  - whether to delete the GTA sample clip in the Knowledge Base;
  - how clicks on the Factory-map strip should behave;
  - whether Studio should confirm before resetting edited captions.

## 7. Out-of-date docs

- `docs/finish-line.md` and `docs/product-roadmap.md` are from 2026-11-14. Treat them as history.
- `docs/HANDOFF.md` §1–2 and §5–8 describe Kartik's Mac and the hackathon wave.
- `docs/interface-architecture.md`: the visual-system section describes the earlier copper glass palette.
- `docs/submission/` is the hackathon submission, kept as a record.
