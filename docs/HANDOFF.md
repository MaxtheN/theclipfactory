# Growth Factory — engineering handoff

Snapshot: 2026-11-14, ~10:30 America/Los_Angeles. Supersedes the earlier pasted
handoff for current state. Read this first, then `docs/engine.md`.

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
- **Submission docs**: `docs/submission/` (devpost, demo script, judge Q&A,
  video storyboard). They pre-date most of the above — refresh them.
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

## 6. In flight at handoff (four background agents; check `git log`/`git status`)

Uncommitted edits in the working tree belong to these agents. If they did not
finish, review their diffs before committing.

1. **Never run speechless** — ASR missing/damaged blocker with one-click setup +
   progress, integrity probe (runtime metallib, whisper files), storyboard
   rebuilt once speech exists, "Made without speech" chip; also FactoryHome
   "Episode added" card shows the real job state, Library 2-per-row grid.
   Files: app.py, models.py, storyboard.py, team.py gating, FactoryHome,
   Library, Models page, types.
2. **Engine quality** — honour style duration (±25%, sentence-snapped),
   speech-first selection (claims, humor/punchlines, stories, quotables),
   punchline-as-teaser hook-first, hooks ≤8 words from speech, captions
   required; iterates with REAL Haiku runs in scratch data dirs, writes
   `docs/engine-eval.md`. Files: team.py, ranking.py, storyboard, craft.
3. **Review screen** — clean right column, Instagram-Reels-style phone preview,
   no truncated pills; title card placed off faces using reframe data, inside IG
   safe areas. Files: Studio, PostToInstagram, PostPreview, craft.py.
4. **Factory map redesign** — phased, calm, fixed status palette, no truncation,
   proper run selector. Files: FactoryMap, factory-map.css.

## 7. Next steps (priority)

1. Land/verify §6 work; run `tsc`, affected vitest files, affected pytest files;
   push branch + master.
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
6. Refresh `docs/submission/*` to match §4 (Strategist, editing craft, posting,
   website brief, OpenRouter, self-improving factory). Keep claims honest: no
   growth/causality claims, posting not yet exercised live.
