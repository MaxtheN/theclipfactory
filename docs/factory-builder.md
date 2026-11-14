# Factory builder: the factory that improves itself

The content factory notices editing craft it cannot render, writes a coding work order, and — only
when a person clicks — a builder agent produces a tested code change on its own branch for review.
This is Growth Factory's "Software Factory" bridge: ticket → code → tests → sample render → review.

Source: `clip_factory/capabilities.py`, `clip_factory/factory_builder.py`,
`clip_factory/factory_builder_api.py`, `clip_factory/extensions/` (contract + registry),
`frontend/src/growth/FactoryUpgrades.tsx`, `factoryBuilderApi.ts`, the "Factory builder" station in
`flowEvents.ts`. Tests: `tests/test_capabilities.py`, `tests/test_factory_builder.py`,
`frontend/src/growth/factoryUpgrades.test.tsx`.

## 1. Catalog and gap detection

- **Supported** = every `Literal` field of `craft.CraftOptions` plus merged renderer extensions.
- **Known unsupported**: `progress_bar`, `emoji_reactions_in_captions`, `speaker_name_lower_third`,
  `zoom_transition_on_cut`, `background_music_bed`, `sound_effect_on_hook`,
  `split_screen_two_speakers`, `animated_subtitle_box`. Audio (music bed, SFX) and multi-input
  layouts (split screen) are tracked but **not buildable**: the extension contract is a linear video
  chain/ASS overlay, and the builder refuses them with that reason.
- **Signals** (read-only scan of saved records): reference observations and patterns, critic
  findings (`clips.team_findings`), "Request a change" reasons, feedback notes, Strategist belief
  statements/rationales. Deterministic keyword map with a negation guard ("no progress bar" is not a
  request). Optional model classification (`POST /api/factory-builder/scan {"use_model": true}`, needs an
  OpenRouter key) may only choose from the closed list and its quote must appear in the text.
- `GET /api/factory-builder` re-scans at most every 30 s. Each capability is one durable
  `capability_requests` record (`cap_<capability>`): evidence `{source, id, quote}`, `demand_count` =
  distinct evidence, status `detected → work_order → building → ready_for_review → merged`
  (or `rejected`). A request turns `merged` when its capability is a loaded extension.
- **Demo trigger**: "Try with a demo request" creates `progress_bar` with evidence source `demo`,
  flagged `demo: true` everywhere until real evidence arrives.

## 2. Work order

Structured ticket (title, user story, evidence, exact interface, acceptance tests including an
FFmpeg render assertion, constraints: no network, no new deps, FFmpeg 4.4 filters only, optional and
off by default, provenance tag). Exported as Markdown. "File as GitHub issue" runs
`gh issue create --repo <origin>` only with `confirm: true` from the click and only when `gh` is
signed in; otherwise it returns the Markdown to copy. Never automatic.

## 3. Builder agent

On "Build it" (`confirm: true`): `git worktree add` under `<data>/work/factory/` on
`factory/upgrade-<capability>-<id>` from the current HEAD, then one queued `factory_build` job on the
serial heavy worker:

1. Model: OpenRouter through the app's `LlmGateway` (Keychain key, ledger + cost), role
   `factory_builder`, Sonnet-class slug discovered from OpenRouter `/models` and constrained to slugs
   the gateway can price (`anthropic/claude-sonnet-5.5`); local Ollama model as a fallback. The
   adapter uses the gateway's Keychain key, HTTP client and ledger but sends its own request
   (explicit model, `reasoning: {effort: "low"}`): `complete_json` routes by the creator's model
   setting and sends `reasoning: {enabled: false}`, which OpenRouter rejects for Sonnet 5.5
   ("Reasoning is mandatory", HTTP 400, checked 2026-11-14).
2. Static checks before anything runs: AST allowlist (imports only `math`, `re`, `dataclasses`,
   `typing`, `clip_factory.extensions.base`; no `exec/eval/open/getattr/__import__`, no
   `os/sys/subprocess/socket`, no dunder attributes, no `while`), size/line limits.
3. In the worktree, each in a subprocess with a timeout, stripped environment and
   `sandbox-exec (deny network*)` on macOS: `ruff check`, the generated tests
   (`--noconftest`), and a sample render harness: a 2 s 1080×1920 `testsrc2` render with the fragment
   applied must succeed and its frame at 1.5 s must differ from the plain render.
4. Up to 2 repair rounds feed the failure log back. Success commits the two files on the branch
   (trailer `Factory-Builder-Request: <id>`) and stores the diff, test log, sample path and
   per-build model usage/cost: `ready_for_review`. Failure removes the generated files.

## 4. Review and merge

The UI shows checks, diff, test log and the sample render. "Push & open draft PR" (`confirm: true`)
runs `git push <upstream remote> <branch>` and `gh pr create --draft --base <branch the build started
from>`; it is blocked when that base is `main`, `master` or a detached HEAD. The exact commands are
shown first. "Discard" removes the worktree and branch.

After a human merges the branch into the working branch and restarts, `extensions.registry()` loads
the module — **only** files committed and unmodified in the running checkout's
`clip_factory/extensions/`, re-checked by the same allowlist and a smoke render — and exposes it as a
Fine-tune toggle (`CraftOptions.extensions`, off by default) and a Strategist craft variable
`ext_<capability>` (`on`/`off` from the edit plan). The running app never imports builder worktree
or branch code.

## Verified

2026-11-14, one live build in a temporary clone (not the working tree), demo request
`progress_bar`: Sonnet 5.5 via OpenRouter, 1 call, 6,050 prompt + 4,135 completion tokens,
$0.0535 (OpenRouter-reported), 29 s; passed the AST allowlist, ruff, 12 generated tests and the
sample render (bar fills along the top edge; frame at 1.5 s differs from the plain render) on the
first attempt. Nothing was pushed or merged.
