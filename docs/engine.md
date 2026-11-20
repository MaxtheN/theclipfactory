# What the engine actually does

The engine turns source-backed moments into captioned 9:16 drafts using a defined
set of rendering operations. It supports measured jump cuts, optional face-follow
framing, brand styling and loudness normalization; it is not a general-purpose
nonlinear editor. Transcription is local; agent roles may use local models or
explicitly configured OpenRouter cloud routing.

Refreshed 2026-11-14 against published master `5e6c6a0`. Code references below are
`file:function` under `clip_factory/` unless otherwise stated. Historical execution
numbers do not replace fresh human editorial review. New creative-score/re-cut/demo
work in an uncommitted checkout is not included until reviewed and merged.

## 1. Ingest

Upload accepts MP4/MOV/MKV/WebM/M4V/AVI up to 20 GB and stores the original file
locally, with **no proxy** (`app.py:upload_video`). ffprobe then reads duration,
rotation, audio and HDR (`media.py:probe`, `is_hdr`). In `auto` autonomy, production
starts on import (`app.py:submit_production`).

## 2. Understanding

| Layer | Detail | Code |
| --- | --- | --- |
| Transcription | MLX Whisper large-v3-turbo, **with word timestamps** (`word_timestamps=True`). Loops, impossible timing and low-confidence text are removed. Each source is classified as speech *throughout* or background-only. | `inference_worker.py` (transcribe), `media.py:clean_transcript`, `classify_speech` |
| Transcript import | SRT, VTT or JSON can replace Whisper output. | `app.py:import_transcript`, `media.py:parse_transcript` |
| Signals | FFmpeg measures picture change (scene score) and RMS loudness across the whole source. No model is involved. | `media.py:signals` |
| Storyboard | Splits the source into roughly 48 scenes (max 96, 8–90 s each) at cuts. It samples 3–8 frames per scene, and the vision model returns `visual`, `action`, `on_screen_text`, `usable`, `said`, `highlight 0–10` and a reason. It is built once and reused. | `storyboard.py:plan_scenes`, `frame_times`, `observation_prompt`, `Storyboards` |
| Scene score | Without a model reading: `0.7·motion + 0.3·loudness`. With one: `0.6·highlight/10 + 0.4·measured`. | `storyboard.py:score` |
| Speakers | **No diarization.** On-device face detection (`faces.py`: Apple Vision on macOS, OpenCV YuNet with MediaPipe face landmarks on Windows and Linux) can drive the optional face-follow crop; it does not identify speakers. `speaker_role` is a strategist belief dimension. | `strategist.py` |

Models: the LLM/VLM is chosen per run. The default for 16 GB machines is `qwen3-vl:4b`
through Ollama (`docs/local-model-setup.md`). The catalog also lists Qwen3.5 9B and
35B-A3B (MLX) and Kokoro TTS (`models.py:CATALOG`).

## 3. Moment finding

Three modes are available: `production_strategy` = swarm (the default), team or baseline
(`app.py:Settings`). Campaign production (`AgentProduction.strategy`), Studio's agent mode and the
Factory screen all default to swarm; team stays selectable in Studio → Fine-tune as "Deep edit
(fewer clips, more review)".

| Mode | Agents and flow | Output |
| --- | --- | --- |
| **Swarm** | **Talks** (a transcript with speech): usable scenes are merged into stretches of at least 60 s (or two target lengths) so each scout reads whole thoughts, with ±25 s of marked context. Each stretch proposes up to 3 `Idea`s, best first, and must name a *hypothesis*, a range, a **verbatim `payoff_quote`** (the line that lands it), `why` it is funny/sharp, an honest `strength` 0–10, a hook of ≤8 words and a caption; `keep_short` only when a moment is complete under the target. The prompt asks for strong/contrarian claims, banter with a punchline, a story with a payoff, a surprising fact or a quotable line, and to drop filler, crosstalk, setup without payoff and visual-only moments (speech is the evidence). Code then: drops strength ≤3, locates the quote in the measured words (`moments.locate_quote`), shapes the range on **whole sentences** to the approved `duration_seconds` ±25% measured *after* jump cuts plus the teaser, extending across neighbouring scenes and keeping ≥4 s of setup before the payoff (`moments.shape_range`; a shorter clip records why), tees up the end of the payoff line as the hook-first teaser (`moments.punch_span`), keeps the scout's hook only when it is ≤8 words, grounded in the speech and not a picture description (else one cut from the quote, `moments.tidy_hook`), drops clips without speech and duplicates (>50% overlap or the same teaser), strongest first. Every talk clip gets word-by-word captions. **Footage without speech**: per scene, rotating visual hypotheses, ranges fitted inside the scene (`fit_range`, `snap_to_speech`). Renders run in parallel. | ~1.2 clips per usable minute for silent footage; talks over-propose (3 per stretch) and the ranking keeps the best (`team.py:_swarm`, `swarm_stretches`, `moments.py`, `rank_clips`). Each clip stores `swarm = {payoff_quote, payoff_verified, teaser_span, why, strength, hook_source, spoken, duration}` |
| **Team** | **Producer** (`Plan`) → **Footage analyst** (`Footage`: moments that cite scene IDs; code computes the times) → **Close-up** (frames around each peak: `happens`, `peak_frame`, `strength`) → **Performance analyst** (cites past feedback or experiments) → **Creative strategist** (`Angle`: hook + rationale) → **Editor** (`Candidate`: range, hook, caption, refs) → **Critic**. | 1–6 clips, default 3 (`team.py:TeamEngine.execute`, `_moments`, `_closeups`) |
| **Scouts** (long talks over 20 min, inside team or baseline) | One scout per 10-minute window reads the full transcript and 4 frames, and proposes up to 2 scored candidates. A diversity-first shortlist of 8 follows, then a selector model picks N. | `scouts.py:scout`, `shortlist`, `CRITERIA` |
| **Baseline** | One analysis pass, then a render. | `app.py:pipeline_task`, `analyze_task` |

**Ranking, dedupe and quality floor (swarm)** (`ranking.py`, `team.py:rank_clips`). After the
renders, every clip gets a deterministic 0–100 score: 25% the scout's strength rating, 15% payoff (a
quoted line found in the words and teased first; an unfound quote on a talk scores 0), 15% completeness
(ends on a sentence; finished length inside the target band, partial credit for a reasoned short clip),
15% brief fit (serves an `M#`/`T#`; serving nothing is 0 with a brief and neutral without one), 10%
storyboard interest of its scenes (`storyboard.score`), 10% technical (a cached `quality_reports` rubric
for the exact file when one exists, else playback checks and burned captions), 5% critic
(`team_review_status`), 5% hook (≤8 words). On a speech source two hard rules apply whatever the
score: a clip **without burned captions** is below the bar ("No captions on a speech source"), and a clip
**without speech** loses 60% of its score and is below the bar. Near-duplicates (overlap above half of
the shorter clip, or the same payoff sentence) are merged by keeping the better clip. Duplicates, rule
failures and clips under the floor (50) are marked `rank.below_bar` and kept, never deleted. Each clip stores `rank = {score, position,
top_pick, why, below_bar, reason, duplicate_of, signals}` and the run stores a `ranking` summary.
The brief's `clip_count` only sets how many clips are marked `top_pick` (default 5): it is a soft
review target, not a generation cap. Must-avoid ideas are rejected before rendering, as before.
Renders keep the existing worker limit; progress reads "Finding clips: part X of Y · N clips ready",
then "Ranking N clips best first". Review screens list above-the-bar clips best first with the score
and a one-line why; "Below the bar (K)" is collapsed. Approval stays per clip.

**What goes into prompts** (`team.py:TeamEngine.create`, `_agent`, `_swarm`):

| Input | Bound | Reaches |
| --- | --- | --- |
| Brand text and objective | Brand ≤4,000 characters (swarm uses 600) | All modes |
| **Campaign brief block** (`brief.py:brief_block`): workspace voice/boundaries and audience, approved Style rules, goal, `campaign_notes`, `brief_snapshot`, per-run direction and references | Deterministic, ≤2,600 characters (compact ≤1,400 for swarm, scouts and the learning analyst); lowest-precedence lines are dropped first, must-avoid items never | Every team role, swarm, scouts and selector, baseline, learning analyst. Replaces the raw snapshot JSON (see §6) |
| Learning memory (experiments and comparisons, citable as `experiment:` and `comparison:` IDs) | 2,000 characters (swarm: 1,200) | Team and swarm |
| Strategist `selection_guidance` (a tagged block inside the approved `moment_selection`) | `strategist.py:selection_guidance` | Team and swarm |
| Previous observations: the 8 most recent clips' feedback, insights and events | ≤6 of each | Team (`create`) |

**Guardrails:** every agent output must match a Pydantic schema, and the decoder is
grammar-constrained with `narrowed`. A failed output gets one retry with
`format_correction`. Citations must point to known evidence (`_refs`). Scene-ID moment selection derives timestamps in code. Swarm/editor range
proposals are validated against source limits and measured speech before use. If moment selection fails, the engine falls back to the
measured-signal shortlist (`_shortlist`). Prompts are capped at 96,000 characters
(`inference_worker.MAX_PROMPT`).

## 4. Edit operations the renderer can apply today

Output is 1080×1920, 30 fps, H.264 CRF 22 with AAC 128k and faststart
(`media.py:ENCODER`, `render`). Craft options are `craft.CraftOptions` fields on every render
request; each resolved decision is stored in the clip's `craft` record and render receipt, and
`structure`, `hook_format` and `jump_cuts` are Strategist craft tags.

| Operation | Status | Detail / code |
| --- | --- | --- |
| Trim to one source range | ✅ | `media.py:render` (`-ss`/`-t`) |
| Cold open (a 0.5–10 s source segment before the main range) | ✅ | `render` concat graph; `app.py:validate_opening` |
| Framing `fit` (whole picture on black) / `blur` (whole picture over a blurred copy) / `fill` (9:16 crop) | ✅ | `render.layout_for` |
| Crop position | ✅ | `crop_focus=auto_face` (default for `fill` on sources wider than 9:16): `reframe.py` samples each source window at 2.5 fps (640 px), finds faces on-device through `faces.py` (Apple Vision via pyobjc on macOS, no model file; on Windows and Linux OpenCV YuNet finds faces and MediaPipe Face Landmarker measures the inner lips on each face crop, both models bundled and checksum-checked; people rectangles, or OpenCV HOG people, when no face), prefers the talking face (inner-lip movement) with switch hysteresis, frames two close faces together, then builds a held, median-filtered, dead-zoned, speed-limited path that snaps at measured scene cuts (plus storyboard scene starts). The path is a flat piecewise-linear `crop` x expression of `t` (FFmpeg 4.4). Skipped for windows over 180 s; without a face detector (the reason is recorded) or with faces in under 25% of samples the fixed `focus_x` (manual or motion-picked by `media.py:action_window`) is kept. The craft record's `reframe` holds status, samples, face share, cuts, keyframes and fallback; Strategist tag `crop_focus`. `crop_focus=fixed` keeps the old behaviour. |
| Static zoom (`crop_width` 0.2–1) | ✅ | `render` `zoom` |
| Slow push-in (+7% over the clip) | ✅ | `motion="push_in"` |
| Punch-in zooms on emphasised words (1.0→1.08 over 0.3 s, ≤3 per clip) | ✅ | `punch_in=emphasis` (default off); `craft.punch_times`, `zoom_expression` |
| Burned captions: `standard`, `high_contrast` | ✅ | SRT + `force_style`, Arial 52/60 |
| Word-by-word `pop` captions (the spoken word turns yellow at 112% size) | ✅ | `media.py:pop_captions` → `.pop.ass` |
| Captions only where real speech happens | ✅ | `media.py:foreground`, `caption_entries` |
| Keyword-emphasis captions (accent colour, 115%) | ✅ | `caption_emphasis=keywords` (default): planner `emphasis_words`, else numbers, names and long key-phrase words, one per cue; `craft.choose_emphasis`, `caption_ass` |
| Hook text overlay (top, first 3 s) | ✅ | `hook_format=overlay` |
| Hook title card (big boxed text, first 2 s, 9:16 safe area, brand colours) | ✅ | `hook_format=title_card` (default); `craft.overlay_ass`; hook grounding recorded |
| Hook-first structure (≤3 s word-aligned payoff teaser → setup → full payoff) | ✅ | `structure=auto` (default; hook_first when a payoff sentence exists) / `linear` / `hook_first`; planner `payoff_start/end` or deterministic pick from storyboard loudness/highlight + emphasis; `transition` cut/zoom/flash; `craft.plan_structure` |
| HDR → SDR tone mapping | ✅ | `media.py:TONEMAP` |
| Cover image | ✅ | `cover=best_frame` (default): sharpest, stillest well-lit frame at 2 fps, avoiding end card and teaser cut; `media.write_cover` |
| Silence / filler removal (jump cuts) | ✅ | `jump_cuts=silences` (default) / `silences_and_fillers` / `off`; cuts only between measured words, ≥0.8 s pieces, ≤35% removed, skipped on sparse speech; captions re-timed; `craft.plan_jump_cuts`, `media.render_crafted` |
| Loudness normalization | ✅ | `loudness=normalize` (default): two-pass EBU R128 loudnorm to −14 LUFS / −1.5 dBTP, verified by an ebur128 check |
| Music, SFX, voice-over mix | ❌ | Kokoro TTS exists only as a standalone `/api/narrations` WAV. |
| B-roll, split screen, graphics | ❌ | The strategist prompt explicitly forbids them. |
| Brand kit, CTA end card | ✅ | `Profile.brand_kit` (font family/file, colours, PNG logo), `Brief.cta` or `end_card=cta` + `cta_text`; last 1.6 s dimmed with CTA and logo |
| A/B variants of one moment | ✅ | `variants={variable, values}` (2–3; hook, opening_treatment, caption_style, hook_format or structure): separate versions sharing `variant_group` |
| Progress bar | ❌ | Tracked as a Factory builder capability request (see below). |
| Renderer extensions (merged, reviewed modules) | ✅ | `CraftOptions.extensions` (empty = off); `media.render_crafted` draws them last and records `craft.extensions` with provenance; only modules committed in this checkout load (`clip_factory/extensions`). See `docs/factory-builder.md`. |

## 5. Review and critic

| Element | Detail | Code |
| --- | --- | --- |
| Creative critic | Checks `context`, `claims`, `captions` and `duplicates` against the transcript and frames from inside each clip. Returns pass, revise or unknown. A "pass" that contains failures is downgraded. | `team.py:Critique`, `_agent("critic")` |
| Revision loop | Critic → producer `Revision` (revise or stop) → editor. The budget is 0–2 rounds. The Factory screen defaults to 0, while Studio and campaigns opt in. Non-progressing edits stop the loop. | `team.py:execute`, `app.py:submit_production` |
| Technical checks | Codec, dimensions, frame rate, source timing, audio stream and level, A/V length, caption timing, display time and length. A failed check means no clip is saved. | `media.py:verify` |
| Pre-post gate | Decodes, 9:16, 7–90 s, audio, captions, ≤50 MB, hash, black or frozen frames. | `quality.py:evaluate` |
| Recheck | Re-runs the critic on edited metadata. | `team.py:review_clip` |
| Request change | Makes a new immutable version with `parent_clip_id`, a required `change_reason` and a `plan_changes` diff. A hook that is burned into the video cannot be edited in place. | `app.py:revision_fields`, `edit_clip` |

## 6. Inputs a user can give today

| Where | Fields |
| --- | --- |
| Onboarding / Brand profile (`campaigns.py:Profile`) | name, audience, brand_context, creative_preferences, brand_kit (UI: "Name your brand / podcast", "Your creative direction", "What should every edit respect?"; Brand profile: Brand name, Who it's for, Voice & boundaries, Brand kit, Advanced → Extra creative notes) |
| Campaign (`campaigns.py:Campaign`) | objective, primary_metric, notes (≤2,000), **brief** (`brief.py:Brief`): target audience (refines the workspace's), key_messages (≤5 × 160), cta (≤80, also the end card) + cta_link, must_include / must_avoid (≤8 × 120), tone (≤300), references (≤5 URLs + note; display-only, untrusted, never fetched), deliverables (clip_count 1–50, max_duration_seconds 5–180, platforms: Instagram Reels), context (≤1,500); legacy constraints[], requested_outputs[], measurement_intent kept. Old briefs read complete (`normalize_brief`); a PUT that omits the brief keeps it. UI: `CampaignBrief.tsx` in New campaign and Brand profile → Goals & brief (Save brief), summary line on Find clips |
| Style rules (`campaigns.py:Direction`) | angles[], moment_selection, hooks[], pacing, duration_seconds (1–180), framing (`fit`/`fill`), caption_style (`standard`/`high_contrast`), editing_preferences, measurement_questions[], next_experiments[], evidence_refs, limitations, confidence |
| Fine-tune (`frontend/src/growth/Studio.tsx`) | mode (agents or manual start/end), how to find clips (whole episode best first = swarm, or Deep edit = team), model, correction budget (Deep edit only), opening (text overlay or cold open + times), hook text, crop focus, captions on/off |
| Per-run direction | "What should the agents look for?" (≤500, `AgentProduction.direction`). Reaches every agent inside the brief block's section [4] as untrusted data, a preference only |
| Direct render (`campaigns.py:Production`) | `instructions` (≤4,000). Stored as `creator_instructions` but **not** fed to any model. |

Only duration, framing and caption style are *enforced* in the render
(`app.py:render_team`, `pipeline_task`). Pacing and editing_preferences reach the agents
only as text. Duration: team and baseline cuts are trimmed to `duration_seconds`; a swarm clip
from a talk was already sized on whole sentences to `duration_seconds` ±25% of finished length
(after jump cuts, plus the teaser), so it is not trimmed again (that cut mid-sentence) and its
render limit is the top of the band plus the teaser. Speech in a swarm clip is always captioned
word by word, a recorded departure from a saved `standard`/`high_contrast` style.

**How the brief is used.** One block (`brief.py:brief_block`) sits after each role's
instruction with an explicit precedence: [1] hard limits (workspace voice and boundaries,
must-avoid items `A#`) > [2] approved Style rules > [3] campaign brief (goal, key messages
`M#`, include topics `T#`, CTA, audience, tone, deliverables, notes, context) > [4] run
direction and references (untrusted data). Each role gets a one-line "YOUR USE".
Enforced in code, not only by text:

- **Must-avoid**: a moment (footage analyst, scouts, shortlist), swarm idea, baseline
  candidate or editor cut is rejected when every content word of an avoid item appears
  in its transcript span (plus hook and caption for cuts), or when the model flags the
  `A#` itself. Rejections are recorded on the run as `brief_rejections`. The critic gets
  deterministic `brief` error findings for hooks/captions that hit the list (also on
  recheck after a manual edit), and the learning analyst cannot propose such a hook.
- **Serves**: moments, angles and swarm ideas must name the `M#`/`T#` they serve or
  `none` (grammar-required with a brief); clips record it as `brief_serves`.
- **Deliverables**: `clip_count` sets the team run's clip count (capped at 6) and, for the swarm,
  how many ranked clips are marked as top picks (a soft target, never a cap);
  `max_duration_seconds` caps editor and swarm ranges below the Style-rules duration.
- **CTA**: `Brief.cta` turns on the CTA end card (`app.py:render_team`).


### Reference research and post copy

**Research what works** (`references.py`, `references_api.py`, UI `ReferenceResearch.tsx`, reached from
Style rules → "Learn from examples" and Studio → "Test a pattern from examples"). Separate from the brief's
display-only reference links:

- Input: 1–3 references per campaign. An upload (≤3 min, ≤200 MB) is stored under
  `<data>/references/<research id>/` with `media_kind: "reference"`; it is never a `videos` source, never
  rendered or posted. A link is recorded as **not inspected** unless it is a direct public `.mp4` (no
  platform pages, no login, no redirects, public addresses only); an unreachable link is **missing
  material**, never analyzed footage.
- Analysis (one `reference_research` job on the serial heavy worker): Whisper with word timestamps, frames at
  0, 0.5, 1, 1.5, 2, 3 s then every 3 s described through the storyboard observation prompt, and FFmpeg
  measurements: time to first word, words per second, cuts (scene score ≥0.3), integrated LUFS (ebur128),
  caption presence (vision text matching speech; size is not measured), on-screen text in the first 2 s,
  hook-first guess (opening words recur later). Each observation is a fact plus exact evidence
  (time range, quote or frame) and is validated against the reference.
- ONE pattern from qwen3-vl:4b (admission guard before every call, one repair, abstain): it must cite
  existing observation IDs and pick one craft variable (`hook` only when a target clip's own transcript
  grounds the B hook; `opening_treatment` text_overlay/none; `caption_style`; `hook_format`; `structure`).
  `value_a` is the control from the approved Style rules / chosen clip; limits (n, other creator/audience,
  no performance data) are added by code. Evidence and inference are stored and shown apart.
- **Use this direction** queues `variants={variable, [value_a, value_b]}` on the chosen campaign clip's range
  through `campaign_render` (each clip records `reference_research_id` and `reference_pattern`) and saves a
  **proposed** Style-rules version (next experiment + limits, `reference_research_id`); nothing is approved.

**Post copy** (`post_copy.py`, `GET/POST /api/clips/{id}/post-copy`): a caption ≤2,200 characters from the
clip's hook, its transcript span and the brief (served key message, CTA with "link in bio" when a link
exists), ≤5 relevant hashtags (blocklist, none when the brief says no hashtags), must-avoid and unspoken
numbers refused. The local model writes it as a `post_copy` job; otherwise a labelled template is saved.
Post to Instagram prefills the caption from it and offers "Regenerate caption".

## 7. Learning and strategist hooks

Measured experiments feed `learning_memory` into the next run's prompts and propose
rule changes for a person to approve (`learning.py:memory_digest`). The strategist adds a
`selection_guidance` block to the approved Style rules. Nothing is approved
automatically. Details are in `docs/learning-loop.md` and `docs/strategist.md`.

## 8. Performance evidence

| Fact | Source |
| --- | --- |
| 60 s of audio transcribed in 6.2 s, with 174 word timestamps | `docs/local-model-setup.md` |
| 551 s of narration transcribed on an 8-vCPU CPU in 150.7 s end to end (3.7× realtime), with 4.0% word error rate | `docs/local-model-setup.md`, `scripts/bench-speech.py` |
| Batched faster-whisper is 22% faster on that CPU but gives 30% fewer sentence ends, so it is not used | `docs/local-model-setup.md` |
| 90 s source → one critic-checked 15.1 s clip in **119.2 s** (team mode, qwen3-vl:4b) | `docs/local-model-setup.md`, `docs/demo-acceptance.md` |
| 3.4 h stream: a single pass gave 72–158 s ranges, while scouts kept every clip ≤60 s and spread across the source | `scouts.py` header, `scripts/experiments/long_video_ab.py` |
| Swarm at ~1.2 clips per usable minute | A design **target** (`team.py:SWARM_CLIPS_PER_MINUTE`), not measured |
| A full 85-minute episode end to end, and audience lift | **Untested** (`docs/local-model-setup.md`) |

## Current gaps and next evaluations

The operations table above is the implementation inventory. A/B variants, title
cards, jump cuts, emphasis captions, loudness normalization, covers and brand
styling are implemented; they are not future backlog items. Local and configured
cloud agents are both supported, with different data/cost/resource trade-offs.

Remaining work is primarily verification and editorial quality: fresh semantic
review, a human-labeled multi-episode benchmark, measured acceptance/cost against a
matched manual baseline, and the first verified live publication/feedback cycle.
Optional auto-variants for top picks, diarization, more sophisticated audio/story
signals, general B-roll/music mixing and a broader reviewed extension library are
separate proposals. The builder's documented progress-bar code passed in a
rehearsal but is not a merged built-in operation.

Use [submission evidence](submission/evidence.md) for the current proof boundaries
and [product roadmap](product-roadmap.md) for expansion plans. A higher proxy rank,
more model calls or a new filter does not by itself establish a better clip.
