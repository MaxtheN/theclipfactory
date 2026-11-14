# What the engine actually does

Short answer: **more than clipping and subtitles, less than a full editor.** The engine
watches and listens to a whole episode, uses local-model agents to choose moments and
write hooks, and then makes a 9:16 clip with a fixed set of FFmpeg edits. Its strength
is choosing and grounding moments. Its weakness is editing craft: no jump cuts, no
face tracking, no brand kit and no audio polish.

Code references are `file:function` under `clip_factory/` unless a path says otherwise.
Read on branch `kartik/backend-integration`. Some files had uncommitted changes from
other work at the time, and those are labelled *in flight*.

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
| Speakers | ❌ **No diarization or face detection.** `speaker_role` exists only as a strategist belief dimension. | `strategist.py` |

Models: the LLM/VLM is chosen per run. The default for 16 GB machines is `qwen3-vl:4b`
through Ollama (`docs/local-model-setup.md`). The catalog also lists Qwen3.5 9B and
35B-A3B (MLX) and Kokoro TTS (`models.py:CATALOG`).

## 3. Moment finding

Three modes are available: `production_strategy` = swarm (the default), team or baseline
(`app.py:Settings`).

| Mode | Agents and flow | Output |
| --- | --- | --- |
| **Swarm** | Each scene gets one short prompt and proposes up to 3 `Idea`s. Each idea has a *hypothesis* (bold_claim, question, story, lesson, contrast, emotion, humor or spectacle), a 15–40 s range, a hook of 10 words or fewer, and a caption. Hypotheses rotate per scene so the set stays varied. Ranges are fitted and snapped to sentence edges, and overlaps of more than 70% are dropped. Renders run in parallel. | ~1.2 clips per usable minute, max 150 (`team.py:_swarm`, `swarm_quotas`, `fit_range`, `snap_to_speech`) |
| **Team** | **Producer** (`Plan`) → **Footage analyst** (`Footage`: moments that cite scene IDs; code computes the times) → **Close-up** (frames around each peak: `happens`, `peak_frame`, `strength`) → **Performance analyst** (cites past feedback or experiments) → **Creative strategist** (`Angle`: hook + rationale) → **Editor** (`Candidate`: range, hook, caption, refs) → **Critic**. | 1–6 clips, default 3 (`team.py:TeamEngine.execute`, `_moments`, `_closeups`) |
| **Scouts** (long talks over 20 min, inside team or baseline) | One scout per 10-minute window reads the full transcript and 4 frames, and proposes up to 2 scored candidates. A diversity-first shortlist of 8 follows, then a selector model picks N. | `scouts.py:scout`, `shortlist`, `CRITERIA` |
| **Baseline** | One analysis pass, then a render. | `app.py:pipeline_task`, `analyze_task` |

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
`format_correction`. Citations must point to known evidence (`_refs`). The model never
supplies timestamps. If moment selection fails, the engine falls back to the
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
| Crop position | ⚠️ | Fixed horizontal `focus_x`, set manually or chosen automatically from **motion energy** (`media.py:action_window`, `app.py:frame_action`). It applies only to landscape sources, does not follow the subject over time, and has no face or speaker detection. |
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
| Progress bar | ❌ | |

## 5. Review and critic

| Element | Detail | Code |
| --- | --- | --- |
| Creative critic | Checks `context`, `claims`, `captions` and `duplicates` against the transcript and frames from inside each clip. Returns pass, revise or unknown. A "pass" that contains failures is downgraded. | `team.py:Critique`, `_agent("critic")` |
| Revision loop | Critic → producer `Revision` (revise or stop) → editor. The budget is 0–2 rounds. The Factory screen defaults to 0, while Studio and campaigns opt in. Non-progressing edits stop the loop. | `team.py:execute`, `app.py:submit_production` |
| Technical checks | Codec, dimensions, frame rate, source timing, audio stream and level, A/V length, caption timing, display time and length. A failed check means no clip is saved. | `media.py:verify` |
| Pre-post gate (*in flight*) | Decodes, 9:16, 7–90 s, audio, captions, ≤50 MB, hash, black or frozen frames. | `quality.py:evaluate` |
| Recheck | Re-runs the critic on edited metadata. | `team.py:review_clip` |
| Request change | Makes a new immutable version with `parent_clip_id`, a required `change_reason` and a `plan_changes` diff. A hook that is burned into the video cannot be edited in place. | `app.py:revision_fields`, `edit_clip` |

## 6. Inputs a user can give today

| Where | Fields |
| --- | --- |
| Onboarding / workspace (`campaigns.py:Profile`) | name, audience, brand_context, creative_preferences (UI: "Your creative direction", "What should every edit respect?") |
| Campaign (`campaigns.py:Campaign`) | objective, primary_metric, notes (≤2,000), **brief** (`brief.py:Brief`): target audience (refines the workspace's), key_messages (≤5 × 160), cta (≤80, also the end card) + cta_link, must_include / must_avoid (≤8 × 120), tone (≤300), references (≤5 URLs + note; display-only, untrusted, never fetched), deliverables (clip_count 1–50, max_duration_seconds 5–180, platforms: Instagram Reels), context (≤1,500); legacy constraints[], requested_outputs[], measurement_intent kept. Old briefs read complete (`normalize_brief`); a PUT that omits the brief keeps it. UI: `CampaignBrief.tsx` in New campaign and Workspace settings → Campaign (Save brief), summary line on Find clips |
| Style rules (`campaigns.py:Direction`) | angles[], moment_selection, hooks[], pacing, duration_seconds (1–180), framing (`fit`/`fill`), caption_style (`standard`/`high_contrast`), editing_preferences, measurement_questions[], next_experiments[], evidence_refs, limitations, confidence |
| Fine-tune (`frontend/src/growth/Studio.tsx`) | mode (agents or manual start/end), model, correction budget, opening (text overlay or cold open + times), hook text, crop focus, captions on/off |
| Per-run direction | "What should the agents look for?" (≤500, `AgentProduction.direction`). Reaches every agent inside the brief block's section [4] as untrusted data, a preference only |
| Direct render (`campaigns.py:Production`) | `instructions` (≤4,000). Stored as `creator_instructions` but **not** fed to any model. |

Only duration, framing and caption style are *enforced* in the render
(`app.py:render_team`, `pipeline_task`). Pacing and editing_preferences reach the agents
only as text.

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
- **Deliverables**: `clip_count` sets the team run's clip count (capped at 6);
  `max_duration_seconds` caps editor and swarm ranges below the Style-rules duration.
- **CTA**: `Brief.cta` turns on the CTA end card (`app.py:render_team`).


## 7. Learning and strategist hooks

Measured experiments feed `learning_memory` into the next run's prompts and propose
rule changes for a person to approve (`learning.py:memory_digest`). The strategist adds a
`selection_guidance` block to the approved Style rules. Nothing is approved
automatically. Details are in `docs/learning-loop.md` and `docs/strategist.md`.

## 8. Performance evidence

| Fact | Source |
| --- | --- |
| 60 s of audio transcribed in 6.2 s, with 174 word timestamps | `docs/local-model-setup.md` |
| 90 s source → one critic-checked 15.1 s clip in **119.2 s** (team mode, qwen3-vl:4b) | `docs/local-model-setup.md`, `docs/submission/devpost.md` |
| 3.4 h stream: a single pass gave 72–158 s ranges, while scouts kept every clip ≤60 s and spread across the source | `scouts.py` header, `scripts/experiments/long_video_ab.py` |
| Swarm at ~1.2 clips per usable minute | A design **target** (`team.py:SWARM_CLIPS_PER_MINUTE`), not measured |
| A full 85-minute episode end to end, and audience lift | **Untested** (`docs/local-model-setup.md`) |

## Gap vs vision

Vision: *a campaign brief plus podcast footage goes in; the factory edits, clips, posts,
experiments and re-edits around the goal and the brand.* Moment choice and grounding are
already strong. The largest gaps are in turning the brief into output and in editing
craft. Effort uses S/M/L. Every upgrade assumes a 16 GB M5, local models only, FFmpeg 4.4
with libass and drawtext, and no Homebrew.

| # | Upgrade | Impact | Effort | Extends | 16 GB / local risk |
| --- | --- | --- | --- | --- | --- |
| 1 | ✅ **Brief-driven agents** (shipped: `brief.py`, see §6) | High | S | — | Block bounded at 2,600 / 1,400 characters. Selection by message fit is the model's judgement; only must-avoid is enforced |
| 2 | ✅ **Per-run direction note** (shipped, inside the brief block as untrusted data) | High | S | — | — |
| 3 | **A/B variants per moment**: 2–3 hooks or openings for one range, tagged `changed_variable` | High | M | `_swarm` treatments, `Render.changed_variable`, `parent_clip_id` | Each variant is another render (about 2× disk and time). Render variants serially. |
| 4 | **Silence / filler jump cuts** using word timestamps | High | M | Generalize `render` segments beyond cold_open and main, `caption_entries` offsets | Many-segment concat graphs in FFmpeg 4.4. Caption re-timing must stay verified by `verify`. |
| 5 | **Hook craft**: rewrite hooks into a designed title card for the first 2 s | High | S–M | `.hook.ass` style, critic `claims` check | Rewritten hooks may overclaim, so the critic must still ground them. |
| 6 | **Speaker / face reframing for 9:16** that follows the subject over time | High | L | `media.py:action_window` → per-segment `focus_x` keyframes | No face model is shipped. Options are Apple Vision via Swift or a small detector. CPU cost on long sources. Avoid jitter by holding the frame between cuts. |
| 7 | **Loudness normalization** (`loudnorm` to −14 LUFS) | Medium | S | `render` audio chain, `verify` audio_level | Two-pass loudnorm doubles audio decode time. One pass is fine for clips. |
| 8 | **Emphasis captions**: highlight keywords, configurable font and position | Medium | S–M | `pop_captions`, `Direction.caption_style` (add `pop`) | Keyword picks need an LLM call per clip, or a cheap TF-IDF fallback. |
| 9 | **Brand kit + CTA end card** (logo, colors, font, closing slate) | Medium | M | `Profile` assets, `render` overlay and concat tail | Font files must be bundled because libass falls back to Arial. Logo upload validation. |
| 10 | **Cover frame selection + punch-in on emphasis** | Medium | M | `render_task` cover step and the close-up `peak_frame`, `push` expression | Zoom expressions per keyframe are slow on CPU. Cap them at 2–3 per clip. |

Upgrades 1–2 and 7 are cheap and bring the engine closer to "edits around the brief."
Upgrades 3–6 are what make output look edited rather than just trimmed.
