# Growth Factory — engineering handoff

Current documentation refresh: 2026-11-14, after published master **`5e6c6a0`**.
The operational snapshot below began at `e869666`; this update supersedes its old
UI/status and submission instructions. Read [submission/README.md](submission/README.md)
for the actual Devpost fields/deadlines, [submission/evidence.md](submission/evidence.md)
for claim boundaries, and `docs/engine.md` for implementation details.

- **Pearl Studio is merged:** single navigation; Brand profile section rail and
  focused editors; Engine & models in Brand profile → Advanced (also ⌘K).
  Old Make/Grow/Advanced tools screens are removed. Upstream Library deletion,
  source cleanup and autopilot-after-style changes are preserved.
- **Docs and licensing:** founder authorized README refresh and MIT publication;
  founder declared no pre-event project code/prototype/design/templates.
- **Verification:** merge had 145 targeted frontend checks + one backend regression
  and a build. Full hosted CI then exposed five-second integration-test timeouts;
  a two-worker cap passed 421 tests locally, but hosted CI still needed more time
  for two full-app journey files. Those two integration files now have a bounded
  15-second budget; unit files retain five seconds. All 421 tests pass locally
  with no retries/assertion changes. Hosted CI must be checked separately.
- **Active work is not published proof:** the shared checkout has ongoing creative
  scoring, preference/re-cut, richer demo-loop, onboarding, landing and semantic-hook
  fixes. Preserve it; do not absorb dirty files into a docs/UI commit. The draft
  engine evaluation is now present there but is not part of published `5e6c6a0`.
- **Still pending:** fresh editorially accepted clip, first real app publication,
  verified post mapping and current full live measurement/learning rehearsal.
- **Devpost:** inspected read-only, 2/5 steps done. Leave video blank per founder;
  do not accept terms or submit. Deadline Nov 14 3:15 PM PT; code freeze 3:30 PM PT.

## 1. Where the code is

- Repo checkout: `/Users/kartikbihani/WIN/growth-factory-integration`
- Working branch: `kartik/backend-integration` (origin `MaxtheN/theclipfactory`).
- The founder authorised pushing this branch **and `master`**. Push with plain
  fast-forward (`git push origin HEAD:master`), never `--force`. Teammates push
  landing-page commits to master often: `git fetch && git merge origin/master`
  first. Old PR8 is merged; there is no open PR for this branch.
- Python: `/Users/kartikbihani/WIN/theclipfactory/.venv/bin/python` with
  `PYTHONPATH=<repo>`. Media tools: `PATH=/Users/kartikbihani/WIN/.growth-factory-tools/bin:$PATH`
  (npm FFmpeg 4.4 with libass/drawtext/loudnorm; no Homebrew on this Mac).
- 16 GB Mac: run pytest one file per command and vitest 1–2 files per command.

## 2. How to open the real app

```
/Users/kartikbihani/WIN/research/growth-factory/integration/open-growth-factory.sh [data-dir]
```
Builds `frontend/dist`, then launches the pywebview app. Default data dir is
`.../integration/fresh-test-2`. Launch from the founder's Terminal (not a
sandboxed shell) so MLX can reach the GPU and the app can reach the network.
Backend changes need an app restart; frontend changes need a rebuild (the
script does it).

Data folders under `/Users/kartikbihani/WIN/research/growth-factory/integration/`:
- `fresh-test-2` — current test brand ("All-In", onboarding done, one 10-min
  episode, 13 clips from a run that had **no transcript** — ignore them).
  AI-model settings preset: cloud agents + still frames ON (Claude Haiku 5.5).
- `fresh-test-1` — earlier clean test, partial local run; can be discarded.
- `allin-smoke` — original All-In data (backup; 3 old campaigns archived,
  stray test workspaces deleted, both Instagram accounts bound). Backups of the
  DB are in `campaign-cleanup/`.
- Test footage: `test-media/All-In 10-min test (07m00-17m00).mp4` (also in
  `~/Downloads`), reference moments for judging picks:
  `test-media/allin-reference-moments.md` (from the founder's full transcript).

**Files deleted outside the app today** (cause unknown): the speech runtime's
`mlx/lib/mlx.metallib` and Whisper `weights.safetensors`. Both were restored
(mlx-metal 0.32.4 reinstalled; weights APFS-cloned from
`~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo`). If
transcription crashes with SIGTRAP (exit 133) or Whisper shows "not installed",
check those two files first.

## 3. Secrets (never print; all in macOS Keychain)

| Service | Account | What |
|---|---|---|
| `growth-factory-composio` | `api-key` | Composio key (read connected accounts + execute tools; **no** connected-account write, so in-app "Connect Instagram" falls back to dashboard + Import) |
| `growth-factory-openrouter` | `api-key` | OpenRouter key (Claude Haiku 5.5 `anthropic/claude-haiku-5.5`, Sonnet 5.5 `anthropic/claude-sonnet-5.5`) |
| `growth-factory-groq` | `api-key` | Groq free key (GPT-OSS 120B/20B, Qwen 3.8 27B; 8k tokens/min; no vision). Saved but **not wired** into the app |
| `growth-factory-supabase` | `refresh-token` | Signed-in user session (created by the app) |

Supabase project `nywbjxmratokyplwjjhu` (CLI installed at `~/.local/bin/supabase`,
logged in + linked). Applied: `202611140001_growth_factory.sql`,
`202611140002_publish_bucket.sql` (public bucket `gf-publish`, MP4),
`202611140003_publish_bucket_covers.sql` (JPEG covers). Email confirmation is
OFF (email+password sign-up works instantly). Publishable key is bundled in
`clip_factory/cloud_config.json`; never ship a secret/service key.

## 4. What is built (all on master unless §6 says otherwise)

Product: brand brief + footage in → ranked, on-brand, captioned 9:16 clips →
human approve → post to Instagram → measure → learn → better next clips.

- **Onboarding**: typed welcome intro → website step (OpenRouter Haiku drafts a
  brand brief; fields must quote the site verbatim; "Suggested" group for
  inferred must-avoids/CTA/goal, off until ticked) → goals & brief → clip style
  (the click approves the first Style rules) → account (Supabase email+password,
  or continue offline).
- **IA**: Brand (backend "profile") → campaigns hidden by default (one
  "<Brand> — main"). Sidebar: Factory, Library, Results, Brand profile. ⌘K palette.
- **Engine** (`docs/engine.md`): MLX Whisper large-v3-turbo transcription;
  storyboard (scene detection + vision descriptions); swarm scouts (default;
  team "Deep edit" optional); campaign brief block with precedence (hard limits
  > style rules > brief > run note) and code-enforced must-avoid; ranking
  (`ranking.py`, best-first, "Below the bar"); critic + quality gate
  (`quality.py`).
- **Craft** (`craft.py`, `media.py`, `reframe.py`): hook-first payoff teaser,
  title card, keyword-emphasis captions, jump cuts, −14 LUFS loudness, smart
  cover, CTA end card + brand kit, A/B variants (one variable), face-following
  9:16 crop (Apple Vision via pyobjc-framework-Vision 13.0).
- **AI model routing** (`llm_provider.py`): Local (Ollama qwen3-vl:4b) or
  OpenRouter per role. With a key: brand research, post copy, reference
  patterns, strategist ideas use cloud; clip agents + scene descriptions only
  when "Use cloud model for clip agents too" (+ "still frames") is on. Haiku
  runs with reasoning off; Sonnet needs `reasoning.effort: low` (fixed).
- **Posting** (`publisher.py`, `post_package.py`, `post_schedule.py`):
  Approve & post via Composio (`INSTAGRAM_POST_IG_USER_MEDIA` +
  `..._PUBLISH`), video+cover hosted in Supabase Storage, durable attempt state
  machine (never blind-retries an unknown outcome), cover picker, caption
  limits, schedule (app must be open; overdue needs a click), multi-account.
  **No real post has been made yet.** Composio has no collaborators field.
- **Learning**: durable loop (`learning.py`, 3/6-day windows, memory digest,
  proposed rules), Strategist three layers (`strategist.py`, deterministic
  confidence, explore/exploit, Simulation mode), "Measure now (demo)" labelled.
- **Self-improving factory** (`capabilities.py`, `factory_builder.py`,
  `docs/factory-builder.md`): gap → work order → builder agent (Sonnet) writes a
  sandboxed renderer extension + tests in a temp worktree → human review → PR.
  Live demo built `progress_bar` (29 s, $0.05).
- **Reference research** ("Learn from examples"), post copy, website brief,
  Factory map + run ledger, Results (Post → Measure → Learn).
- **Submission docs**: `docs/submission/` now contains refreshed project story,
  exact field copy, evidence ledger, readiness checklist, demo script, judge Q&A
  and storyboard. Builder code/tests/render evidence leads the software-factory story.
- CI (`.github/workflows/ci.yml`) now installs FFmpeg.

## 5. Live test results (founder, 2026-11-14)

- Website brief on allin.com/about via Haiku: 7.8 s, ~$0.001, good brand/voice;
  weak must-avoid/CTA (now handled by the "Suggested" group).
- Fully local 10-min run: works but slow on 16 GB (vision model 5.6 GB, swap
  8–9 GB, ~2 min per 8 scenes).
- Cloud (Haiku) 10-min run: 4.5 min, 63 calls, $0.028, 13 clips — but **no
  transcript** (Whisper weights were missing; the engine silently continued).
  Clips were visual-only, 11–17 s (style said 30 s), hooks described visuals,
  title card over faces. All of this is being fixed (§6).

## 6. Status of the last wave (updated after master `e869666`)

Landed and pushed to master:
- **Learning-loop demo + minimal UI** (2026-11-14, `a34536d`…`f54017a`): one
  "Run the learning loop" button (Factory + Results) animates the full station map with
  real clips, simulated results, real belief math and a real unapproved length re-cut
  (see closed-loop-demo.md). Root causes of the founder's test: Run strategist completed
  in ms with 0 measured posts and showed nothing (now explains + offers the demo);
  Rehearse the loop needed a supported hook-shortening rubric edit, which ~30 s hook-first
  clips rarely have, so it abstained silently; Demo replay was a small replay of
  timestamps. Results is now Posted/Measuring/Learned + learnings + one Instagram chip,
  the rest under "Strategist and tools"; the Factory map is a 5-phase strip with "Open full
  map"; Library Clips tab is the 2-up 9:16 grid.
- **Never run speechless** (`5db5fcf`, `ad385ac`): `clip_factory/speech.py`;
  `asr_missing`/`asr_damaged` blockers (409) before any work; one-click
  `POST /api/speech/setup` (runtime + Whisper, single progress bar);
  integrity probe in `/api/system`; storyboards record `speech_available` and
  rebuild; "Made without speech" chip, forced below the bar; "Setting up your
  engine" card; Episode card follows real job state; Library 2-up grid.
- **Factory map redesign** (`b6c3135`, `0f48c2c`): five calm phases, fixed
  status palette (Idle/Working/Done/Needs you/Held), run-picker dropdown.
- **Review screen** (`99ed875`, `1920b0a`, `564c99f`, `e869666`): fixed
  380–420px inspector column; status → quality pills → post panel; Reels-style
  phone preview (`PostPreview.tsx`, `review-panel.css`, `post-preview.css`);
  title card placed off the face (Apple Vision face box in `craft.py`, IG safe
  areas, receipt `hook.placement`). Verified on a real render.

- **Engine quality** (`1f40636`, stopped by the coordinator after 6 real runs):
  new `clip_factory/moments.py`; swarm clips are complete ~30 s thoughts with a
  quoted, teased payoff; ranking rewards verified payoff, completeness and brief
  fit; a speech source clip without captions/speech is below the bar. Run 6 on
  the 10-min All-In test (cloud Haiku, $0.03, 57 calls): 13 clips, top 8 all
  31–36 s, all `hook_first`, 16–30 caption cues each, scores 69–72, ~7 of 8
  reference moments hit (pillow talk, Blackwell/wafer, Swalwell, low-level
  leakers, useful idiot, "why now", leak-is-a-crime). The original stop handoff had no written
  evaluation. A later draft `docs/engine-eval.md` exists in the active checkout,
  including a semantic-hook issue; it remains uncommitted and is not a quality
  acceptance certificate. Scratch run DBs/clips:
  `/private/tmp/claude-501/-Users-kartikbihani--claude-spares-spare-rlRLTC/6f48ede3-19e1-4f92-8c6d-324c91c091c6/scratchpad/engine-runs/{1..6}/`
  (temporary). All backend/engine files are free for other agents now.

### Why the founder's first clips showed none of the craft
All craft is applied at **render time, before review/posting** (not after
analytics): hook-first teaser (`structure=auto` → `hook_first` when a payoff
sentence exists), title card, emphasis word captions, jump cuts on silences,
−14 LUFS, smart cover, face-follow crop, CTA end card when the brief has a CTA.
The founder's test run had **no transcript**, so: no payoff → no hook-first; no
word timestamps → no jump cuts and no captions. Punch-in zooms are off by
default. **A/B variants are opt-in** (Fine-tune "A/B", Reference research "Use
this direction", Strategist/learning experiments) — not produced by default.
Possible next step: render 2 hook variants automatically for the top picks.

### For a UI-only agent
Frontend: `frontend/src/growth/` (React/TS/Vite). Shared tokens in
`material-tokens.css`, with final overrides in `pearl-studio.css`. Review preview with sample data:
`cd frontend && VITE_REVIEW_PREVIEW=true npx vite --host 127.0.0.1 --port 5179 --strictPort`
(`?fixtures=flow` adds Factory-map sample data). Tests: `npx vitest run <file>`
(1–2 files at a time), `npx tsc --noEmit`, `npm run build`. Coordinate with the
engine agent on `Studio.tsx`/`CraftControls.tsx` only if it is still running;
everything else in the UI is free.

## 7. Next steps (priority)

1. Preserve the completed UI/master integration. Review and land the active
   backend/demo wave separately, with affected tests and exact evidence. Check CI.
2. Re-run the 10-min clip in `fresh-test-2` (Find clips) with cloud agents:
   confirm transcript, captions, ~30 s, hook-first punchline, title card off
   face; compare against `allin-reference-moments.md`.
3. First real post: sign in → Results → Instagram accounts → Advanced → import
   `ca_dYkCuj6H5XDa` (@kartik._builds), auth config `ac_02lrmG08C1Iz` → Approve &
   post one clip → watch attempt states; if "unknown", use Check status.
4. Strategist follow-ups (not done): posting-package variables (cover source,
   caption length, hashtag count, CTA, timing) and posting-time timezone (uses
   UTC hour now). Optional: Groq as a free text-only provider.
5. Package the Mac app (`scripts/build-mac-app.sh`, then the smoke scripts),
   upload zip to GitHub Releases for the landing page download; note right-click
   → Open (unsigned). Fresh Macs must run the in-app engine setup (runtime +
   Whisper download).
6. Review the refreshed `docs/submission/*`, record the actual builder and media
   demo, add its video URL when ready, and have the team complete finalization.
   Do not claim audience growth or live publishing before verifying it.

## 8. Founder-approved next focus: the visible closed loop (over raising the score)

Goal: show strategy → agents produce → review/score → post → measure → learn →
re-cut → post again, live in the product.
1. **First real post** (blocker): sign in → Results → Instagram accounts →
   Advanced → import `ca_dYkCuj6H5XDa` (@kartik._builds) → Approve & post one
   clip; verify attempt states and the auto publication mapping.
2. **Auto A/B**: after ranking, render 2 hook variants (one variable) for the
   top 3 clips via the existing variants path (`craft.expand_variants`).
3. **Taste labels**: every approve / reject / request-change becomes a label;
   re-weight `ranking.py` per brand; show "matches your taste: N%".
4. **"Apply learning → re-cut"**: when a Style-rules proposal (Strategist or
   learning loop) is approved, one button re-renders the top clips under the new
   rule, ready to post.
5. **Loop view** on the Factory map / Results: Loop #1 → Loop #2 with what
   changed, why (cited evidence) and outcomes; real data where available,
   `demo_override` labels where the window has not elapsed.
Ideas to raise clip quality later (70→90): Sonnet "head editor" second pass,
laughter/crosstalk audio signals, diarization, question-creating teaser,
breath/filler trimming, punch-ins on punchlines, self-critique re-render, a
30-moment human benchmark across 3 episodes.
